import assert from "node:assert/strict";
import { packTraversalData } from "../packages/renderer/src/traversal-nodes.ts";
import * as THREE from "three";
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { extractSurfaceScene } from "../packages/renderer/src/surface.ts";
import { createSurfaceAcceleration } from "../packages/renderer/src/acceleration.ts";
import {
  packSurfaceGeometry,
  packSurfaceResources,
  SURFACE_TRIANGLE_FLOATS,
  SURFACE_MATERIAL_FLOATS,
  SURFACE_TEXTURE_FLOATS,
} from "../packages/renderer/src/surface-gpu.ts";
import { SURFACE_SHADER } from "../packages/renderer/src/surface-shader.ts";
import { SURFACE_RAY_SHADER } from "../packages/renderer/src/surface-ray-shader.ts";
import { packParentLinkedTraversalData } from "../packages/renderer/src/ordered-traversal-nodes.ts";
import {
  automationLaunchOptions,
  withAutomationDeadline,
} from "./browser-session.ts";

/** Bindings 0..7: surfaces, traversal vec4s, RayQuery, result, counts. */
export function surfaceRayGpuProbeBufferSizes(
  lengths: readonly [
    triangleFloats: number,
    materialFloats: number,
    textureFloats: number,
    texelWords: number,
    traversalFloats: number,
    rayFloats: number,
  ],
) {
  const minimum = [
    SURFACE_TRIANGLE_FLOATS * 4,
    SURFACE_MATERIAL_FLOATS * 4,
    SURFACE_TEXTURE_FLOATS * 4,
    4,
    16,
    32,
  ];
  return [
    ...lengths.map((length, binding) => Math.max(minimum[binding], length * 4)),
    Math.max(16, (lengths[5] / 8) * 16),
    16,
  ];
}

export async function runSurfaceRayGpuProbe(output: string, ordered = false) {
  const packNodes = ordered ? packParentLinkedTraversalData : packTraversalData;
  await mkdir(output, { recursive: true });
  const scene = new THREE.Scene(),
    material = new THREE.MeshStandardMaterial({
      color: 0xeb5368,
      side: THREE.DoubleSide,
    });
  const mesh: THREE.Mesh<THREE.BoxGeometry, THREE.MeshStandardMaterial> =
    new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), material);
  scene.add(mesh);
  const second = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1),
    new THREE.MeshStandardMaterial({ color: 0x33c7ab, side: THREE.FrontSide }),
  );
  second.position.set(1.5, 0, 0);
  second.scale.x = -1;
  scene.add(second);
  const acceleration = createSurfaceAcceleration();
  const rays: number[] = [];
  for (let y = -2; y <= 2; y++)
    for (let x = -3; x <= 3; x++) {
      rays.push(x * 0.4, y * 0.4, 3, 100, 0, 0, -1, 0.5);
    }
  rays.push(
    0,
    0,
    0,
    100,
    1,
    0,
    0,
    0.5,
    0,
    0,
    -3,
    100,
    0,
    0,
    1,
    0.5,
    -0.8,
    0,
    0,
    100,
    1,
    0,
    0,
    0.5,
  );
  let seed = 0x13572468;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  for (let index = 0; index < 1024; index++) {
    const origin = [random() * 6 - 3, random() * 6 - 3, random() * 6 - 3];
    const direction = [random() * 2 - 1, random() * 2 - 1, random() * 2 - 1],
      length = Math.hypot(...direction);
    rays.push(...origin, 100, ...direction.map((value) => value / length), 0.5);
  }
  const frames: {
    phase: string;
    kind: string;
    nodes: number[];
    triangles: number[];
    materials: number[];
    textures: number[];
    texels: number[];
    sourceIndices: number[];
    nodeCount: number;
    triangleCount: number;
    expected: ({ distance: number; triangleIndex: number } | null)[];
  }[] = [];
  for (const phase of ["initial", "refit", "rebuild", "physical", "empty"]) {
    if (phase === "refit") {
      mesh.position.x = -0.8;
      mesh.rotation.y = 0.4;
    }
    if (phase === "rebuild") {
      const added = new THREE.Mesh(
        new THREE.SphereGeometry(0.4, 8, 6),
        material,
      );
      added.position.set(0.2, 0.8, 0.2);
      scene.add(added);
    }
    if (phase === "physical") {
      mesh.material = new THREE.MeshPhysicalMaterial({
        transmission: 1,
        side: THREE.FrontSide,
      });
    }
    const surface = extractSurfaceScene(
        phase === "empty" ? new THREE.Scene() : scene,
      ),
      frame = acceleration.update(surface),
      resources = packSurfaceResources(surface),
      triangles = packSurfaceGeometry(surface, frame.orderedTriangles);
    assert.ok(Number.isSafeInteger(frame.metrics.depth));
    const expected = [];
    for (let index = 0; index < rays.length; index += 8) {
      const hit = acceleration.intersect(
        [rays[index], rays[index + 1], rays[index + 2]],
        [rays[index + 4], rays[index + 5], rays[index + 6]],
        rays[index + 3],
      );
      expected.push(
        hit
          ? { distance: hit.distance, triangleIndex: hit.triangleIndex }
          : null,
      );
    }
    frames.push({
      phase,
      kind: frame.changes.kind,
      nodes: Array.from(packNodes(frame.nodes, triangles)),
      triangles: Array.from(triangles),
      materials: Array.from(resources.materials),
      textures: Array.from(new Uint32Array(resources.textures.buffer)),
      texels: Array.from(resources.texels),
      sourceIndices: Array.from(frame.sourceIndices),
      nodeCount: frame.metrics.nodes,
      triangleCount: frame.metrics.triangles,
      expected,
    });
  }
  const deepGeometry = new THREE.BufferGeometry();
  deepGeometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3),
  );
  deepGeometry.computeVertexNormals();
  const deepMaterial = new THREE.MeshStandardMaterial({
      side: THREE.DoubleSide,
    }),
    deepScene = new THREE.Scene();
  deepScene.add(new THREE.Mesh(deepGeometry, deepMaterial));
  const base = extractSurfaceScene(deepScene),
    depth = 128,
    deepNodeCount = depth * 2 + 1;
  const deepSurface = {
    ...base,
    triangles: Array.from({ length: depth + 1 }, (_, index) => ({
      ...base.triangles[0],
      elementOffset: index * 3,
    })),
  };
  const deepNodes = new Float32Array(deepNodeCount * 8),
    deepAcceleration = createSurfaceAcceleration();
  try {
    deepAcceleration.update(deepSurface);
    for (let index = 0; index < deepNodeCount; index++) {
      deepNodes.set(
        [
          0,
          0,
          0,
          index < depth ? index + 1 : index - depth,
          1,
          1,
          0,
          index < depth ? -(deepNodeCount - index - 1) : 1,
        ],
        index * 8,
      );
    }
    const geometry = packSurfaceGeometry(deepSurface),
      resources = packSurfaceResources(deepSurface),
      expected = [];
    for (let index = 0; index < rays.length; index += 8) {
      const hit = deepAcceleration.intersect(
        [rays[index], rays[index + 1], rays[index + 2]],
        [rays[index + 4], rays[index + 5], rays[index + 6]],
        rays[index + 3],
      );
      expected.push(
        hit
          ? { distance: hit.distance, triangleIndex: hit.triangleIndex }
          : null,
      );
    }
    frames.push({
      phase: "deep-128",
      kind: "synthetic-valid-preorder",
      nodes: Array.from(packNodes(deepNodes, geometry)),
      triangles: Array.from(geometry),
      materials: Array.from(resources.materials),
      textures: Array.from(new Uint32Array(resources.textures.buffer)),
      texels: Array.from(resources.texels),
      sourceIndices: Array.from({ length: depth + 1 }, (_, index) => index),
      nodeCount: deepNodeCount,
      triangleCount: depth + 1,
      expected,
    });
  } finally {
    deepAcceleration.dispose();
    deepGeometry.dispose();
    deepMaterial.dispose();
  }
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(
      '<!doctype html><meta charset="utf-8"><title>M3 GPU ray regression</title>',
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const browser = await chromium.launch(automationLaunchOptions());
  try {
    return await withAutomationDeadline(
      async () => {
        const page = await browser.newPage();
        await page.goto("http://127.0.0.1:" + address.port);
        const shader =
          SURFACE_SHADER +
          SURFACE_RAY_SHADER +
          String.raw`
 struct RayQuery{origin:vec4f,direction:vec4f,}
 @group(0) @binding(5) var<storage,read> queries:array<RayQuery>;
 @group(0) @binding(6) var<storage,read_write> results:array<vec4f>;
 @group(0) @binding(7) var<uniform> counts:vec4u;
 @compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id:vec3u){if(id.x>=arrayLength(&queries)){return;}let query=queries[id.x];let hit=traceSurface(query.origin.xyz,normalize(query.direction.xyz),query.origin.w,counts.x,counts.y,query.direction.w);results[id.x]=vec4f(hit.distance,f32(hit.index),hit.bary.yz);}
 `;
        const execute = new Function(
          "return (" +
            String.raw`
 async(packet)=>{
 const adapter=await navigator.gpu.requestAdapter({powerPreference:'high-performance'});
 if(!adapter||adapter.info.isFallbackAdapter)throw Error('TC_GPU_HARDWARE_REQUIRED');
 const device=await adapter.requestDevice();const buffers=[];
 try{
 device.pushErrorScope('validation');const module=device.createShaderModule({code:packet.shader});
 const compilation=await module.getCompilationInfo();const errors=compilation.messages.filter(m=>m.type==='error');
 if(errors.length)throw Error(errors.map(m=>m.message).join('\n'));
 const pipeline=await device.createComputePipelineAsync({layout:'auto',compute:{module,entryPoint:'main',constants:{surfaceOrderedTraversal:Number(packet.ordered)}}});
 const outputs=[];
 for(const frame of packet.frames){
 function storage(values,binding,integer=false,uniform=false){
 const buffer=device.createBuffer({size:frame.bufferSizes[binding],usage:uniform?GPUBufferUsage.UNIFORM:GPUBufferUsage.STORAGE,mappedAtCreation:true});
 (integer?new Uint32Array(buffer.getMappedRange()):new Float32Array(buffer.getMappedRange())).set(values);
 buffer.unmap();buffers.push(buffer);return buffer;
 }
 const input=[storage(frame.triangles,0),storage(frame.materials,1),storage(frame.textures,2,true),storage(frame.texels,3,true),storage(frame.nodes,4),storage(packet.rays,5)];
 const size=frame.bufferSizes[6];
 const output=device.createBuffer({size,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC});
 const read=device.createBuffer({size,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});buffers.push(output,read);
 const counts=storage([frame.nodeCount,frame.triangleCount,0,0],7,true,true);
 const group=device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[...input,output,counts].map((buffer,binding)=>({binding,resource:{buffer}}))});
 const encoder=device.createCommandEncoder();const pass=encoder.beginComputePass();
 pass.setPipeline(pipeline);pass.setBindGroup(0,group);pass.dispatchWorkgroups(Math.ceil(packet.rays.length/8/64));pass.end();
 encoder.copyBufferToBuffer(output,0,read,0,size);device.queue.submit([encoder.finish()]);await read.mapAsync(GPUMapMode.READ);
 outputs.push(Array.from(new Float32Array(read.getMappedRange().slice(0,packet.rays.length/8*16))));read.unmap();
 }
 const error=await device.popErrorScope();if(error)throw Error(error.message);
 return{outputs,adapter:{vendor:adapter.info.vendor,architecture:adapter.info.architecture,isFallbackAdapter:adapter.info.isFallbackAdapter}};
 }finally{for(const buffer of buffers)buffer.destroy();device.destroy();}
 }
 ` +
            ")",
        )() as (
          packet: unknown,
        ) => Promise<{ outputs: number[][]; adapter: unknown }>;
        const gpu = await page.evaluate(execute, {
          shader,
          ordered,
          frames: frames.map((frame) => ({
            ...frame,
            bufferSizes: surfaceRayGpuProbeBufferSizes([
              frame.triangles.length,
              frame.materials.length,
              frame.textures.length,
              frame.texels.length,
              frame.nodes.length,
              rays.length,
            ]),
          })),
          rays,
        });
        let maxDistanceError = 0;
        for (let frame = 0; frame < frames.length; frame++)
          for (let query = 0; query < frames[frame].expected.length; query++) {
            const expected = frames[frame].expected[query],
              values = gpu.outputs[frame];
            if (!expected) {
              assert.equal(values[query * 4 + 1], -1);
              continue;
            }
            assert.ok(values[query * 4 + 1] >= 0);
            const actual = values[query * 4],
              error = Math.abs(actual - expected.distance);
            maxDistanceError = Math.max(maxDistanceError, error);
            assert.ok(
              error < 2e-5,
              JSON.stringify({ frame, query, actual, expected, error }),
            );
            const u = values[query * 4 + 2],
              v = values[query * 4 + 3];
            assert.ok(u >= -1e-5 && v >= -1e-5 && u + v <= 1.00001);
          }
        assert.equal(frames[1].kind, "refit");
        assert.equal(frames[2].kind, "rebuild");
        const alphaScene = new THREE.Scene(),
          alphaMaterial = new THREE.MeshStandardMaterial({
            transparent: true,
            opacity: 0.5,
            side: THREE.DoubleSide,
          });
        for (const z of [0, -1]) {
          const geometry = new THREE.BufferGeometry();
          geometry.setAttribute(
            "position",
            new THREE.Float32BufferAttribute([-2, -1, z, 2, -1, z, 0, 2, z], 3),
          );
          geometry.computeVertexNormals();
          alphaScene.add(new THREE.Mesh(geometry, alphaMaterial));
        }
        const alphaSurface = extractSurfaceScene(alphaScene),
          alphaAcceleration = createSurfaceAcceleration();
        let alphaCoverage: {
          samples: number;
          expected: number[];
          observed: number[];
        };
        try {
          const alphaFrame = alphaAcceleration.update(alphaSurface),
            alphaResources = packSurfaceResources(alphaSurface),
            alphaTriangles = packSurfaceGeometry(
              alphaSurface,
              alphaFrame.orderedTriangles,
            ),
            alphaNodes = packNodes(alphaFrame.nodes, alphaTriangles),
            alphaRays: number[] = [];
          const count = 16384;
          for (let index = 0; index < count; index++)
            alphaRays.push(0, 0, 2, 100, 0, 0, -1, (index + 0.5) / count);
          const alphaResult = await page.evaluate(execute, {
            shader,
            ordered,
            frames: [
              {
                triangles: Array.from(alphaTriangles),
                materials: Array.from(alphaResources.materials),
                textures: Array.from(
                  new Uint32Array(alphaResources.textures.buffer),
                ),
                texels: Array.from(alphaResources.texels),
                nodes: Array.from(alphaNodes),
                nodeCount: alphaFrame.metrics.nodes,
                triangleCount: alphaFrame.metrics.triangles,
                bufferSizes: surfaceRayGpuProbeBufferSizes([
                  alphaTriangles.length,
                  alphaResources.materials.length,
                  alphaResources.textures.length,
                  alphaResources.texels.length,
                  alphaNodes.length,
                  alphaRays.length,
                ]),
              },
            ],
            rays: alphaRays,
          });
          const bins = [0, 0, 0];
          for (let index = 0; index < count; index++) {
            const distance = alphaResult.outputs[0][index * 4],
              hit = alphaResult.outputs[0][index * 4 + 1];
            if (hit < 0) bins[2]++;
            else if (Math.abs(distance - 2) < 1e-5) bins[0]++;
            else if (Math.abs(distance - 3) < 1e-5) bins[1]++;
            else throw new Error("Unexpected alpha hit distance");
          }
          const observed = bins.map((value) => value / count),
            expected = [0.5, 0.25, 0.25];
          for (let bin = 0; bin < 3; bin++)
            assert.ok(
              Math.abs(observed[bin] - expected[bin]) < 0.02,
              JSON.stringify({ bins, observed, expected }),
            );
          alphaCoverage = { samples: count, observed, expected };
        } finally {
          alphaAcceleration.dispose();
          for (const object of alphaScene.children)
            (object as THREE.Mesh).geometry.dispose();
          alphaMaterial.dispose();
        }
        const report = {
          passed: true,
          orderedTraversal: ordered,
          backend: "webgpu",
          adapter: gpu.adapter,
          rays: rays.length / 8,
          frames: frames.map((frame, index) => ({
            phase: frame.phase,
            kind: frame.kind,
            triangles: frame.triangleCount,
            nodes: frame.nodeCount,
            expected: frame.expected,
            actual: gpu.outputs[index],
          })),
          maxDistanceError,
          alphaCoverage,
          limitations: [
            "Numeric dynamic BVH traversal validation; full path integration, light sampling, temporal denoising and graphics acceptance are separate work.",
            "The GPU currently uses the validated CPU refit tree. This is not GPU BVH refit or hardware ray tracing.",
          ],
        };
        await writeFile(
          path.join(output, "surface-ray-gpu.json"),
          JSON.stringify(report, null, 2) + "\n",
        );
        return report;
      },
      60000,
      "M3 GPU dynamic surface ray regression",
    );
  } finally {
    await browser.close();
    acceleration.dispose();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
