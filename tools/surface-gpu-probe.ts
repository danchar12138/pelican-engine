import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import * as THREE from "three";
import { chromium } from "playwright";
import {
  extractSurfaceScene,
  sampleSurfaceMaterial,
} from "../packages/renderer/src/surface.ts";
import {
  packSurfaceGeometry,
  packSurfaceResources,
  SURFACE_TRIANGLE_FLOATS,
  SURFACE_MATERIAL_FLOATS,
  SURFACE_TEXTURE_FLOATS,
} from "../packages/renderer/src/surface-gpu.ts";
import { SURFACE_SHADER } from "../packages/renderer/src/surface-shader.ts";
import {
  automationLaunchOptions,
  withAutomationDeadline,
} from "./browser-session.ts";

const RESULT_FLOATS = 28;

/** Binding-order sizes, including one WGSL array element for empty inputs. */
export function surfaceGpuProbeBufferSizes(
  lengths: readonly [
    triangleFloats: number,
    materialFloats: number,
    textureFloats: number,
    texelWords: number,
    queryFloats: number,
  ],
) {
  const minimum = [
    SURFACE_TRIANGLE_FLOATS * 4,
    SURFACE_MATERIAL_FLOATS * 4,
    SURFACE_TEXTURE_FLOATS * 4,
    4,
    16,
  ];
  return [
    ...lengths.map((length, binding) => Math.max(minimum[binding], length * 4)),
    Math.max(16, (lengths[4] / 4) * RESULT_FLOATS * 4),
  ];
}

export async function runSurfaceGpuProbe(output: string) {
  await mkdir(output, { recursive: true });
  const scene = new THREE.Scene();
  const base = new THREE.DataTexture(
    new Uint8Array([
      32, 64, 128, 255, 255, 128, 32, 128, 128, 255, 64, 255, 64, 32, 255, 64,
    ]),
    2,
    2,
  );
  base.colorSpace = THREE.SRGBColorSpace;
  base.magFilter = THREE.LinearFilter;
  base.wrapS = THREE.RepeatWrapping;
  base.wrapT = THREE.MirroredRepeatWrapping;
  base.offset.set(0.15, -0.1);
  base.repeat.set(1.6, 0.8);
  base.rotation = 0.25;
  const orm = new THREE.DataTexture(new Uint8Array([128, 96, 192, 255]), 1, 1);
  orm.colorSpace = THREE.NoColorSpace;
  const normals = new THREE.DataTexture(
    new Uint8Array([160, 96, 240, 255]),
    1,
    1,
  );
  normals.colorSpace = THREE.NoColorSpace;
  const a = new THREE.MeshStandardMaterial({
    color: 0x92b4d8,
    map: base,
    roughness: 0.65,
    metalness: 0.8,
    roughnessMap: orm,
    metalnessMap: orm,
    aoMap: orm,
    aoMapIntensity: 0.7,
    emissive: 0x406020,
    emissiveIntensity: 2,
    emissiveMap: base,
    normalMap: normals,
    side: THREE.DoubleSide,
    transparent: true,
    opacity: 0.7,
    alphaTest: 0.9,
  });
  a.normalScale.set(0.4, 0.75);
  const b = new THREE.MeshStandardMaterial({
    color: 0xf0b080,
    map: base,
    alphaMap: orm,
    alphaTest: 0.4,
    opacity: 0.2,
    side: THREE.FrontSide,
  });
  const c = new THREE.MeshStandardMaterial({
    color: 0x5070a0,
    normalMap: normals,
    normalMapType: THREE.ObjectSpaceNormalMap,
    side: THREE.BackSide,
  });
  const d = new THREE.MeshPhysicalMaterial({
    color: 0x80c0ff,
    transmission: 0.8,
    ior: 1.45,
    roughness: 0.15,
    metalness: 0,
    attenuationColor: 0x4080c0,
    attenuationDistance: 2,
    side: THREE.FrontSide,
  });
  const e = new THREE.MeshPhysicalMaterial({
    transmission: 1,
    ior: 1.33,
    metalness: 0,
    attenuationDistance: Infinity,
    side: THREE.BackSide,
  });
  const specularIntensity = new THREE.DataTexture(new Uint8Array([16, 128, 240, 96]), 1, 1);
  const specularColor = new THREE.DataTexture(new Uint8Array([128, 64, 192, 32]), 1, 1);
  specularColor.colorSpace = THREE.SRGBColorSpace;
  const f = new THREE.MeshPhysicalMaterial({
    specularIntensity: 0.6, specularColor: 0x80ff80,
    specularIntensityMap: specularIntensity, specularColorMap: specularColor,
  });
  const g = new THREE.MeshStandardMaterial({
    transparent: true, opacity: 0.8, alphaTest: 0.2, side: THREE.DoubleSide,
  });
  const h = new THREE.MeshStandardMaterial({
    transparent: true, opacity: 0.5, alphaTest: 0.5, side: THREE.DoubleSide,
  });
  for (const [index, material] of [a, b, c, d, e, f, g, h].entries()) {
    const geometry = new THREE.PlaneGeometry(2, 2);
    geometry.setAttribute(
      "color",
      new THREE.Float32BufferAttribute(
        [0.5, 1, 0.75, 0.7, 1, 0.5, 0.5, 1, 0.7, 0.8, 0.9, 0.6, 1, 1, 1, 1],
        4,
      ),
    );
    if (index === 0) material.vertexColors = true;
    const mesh = new THREE.Mesh(geometry, material);
    mesh.rotation.set(0.1, 0.3, 0.2);
    mesh.scale.set(1.5, 0.8, 0.6);
    scene.add(mesh);
  }
  const snapshot = extractSurfaceScene(scene),
    resources = packSurfaceResources(snapshot),
    triangles = packSurfaceGeometry(snapshot),
    queries: number[] = [],
    expected: { index: number; front: boolean; values: number[] }[] = [];
  for (let index = 0; index < snapshot.triangles.length; index++)
    for (const front of [true, false]) {
      queries.push(index, 0.2, 0.3, front ? 1 : 0);
      const value = sampleSurfaceMaterial(snapshot, index, [0.2, 0.3, 0.5], {
        frontFacing: front,
      });
      const material = snapshot.materials.find(
        (material) => material.uuid === snapshot.triangles[index].materialUuid,
      );
      assert.ok(material);
      const materialIndex = snapshot.materials.indexOf(material);
      expected.push({
        index,
        front,
        values: [
          ...value.baseColor,
          value.alpha,
          ...value.normal,
          value.roughness,
          ...value.emissive,
          value.metalness,
          value.occlusion,
          value.discarded ? 1 : 0,
          material.alphaMode !== "opaque" && front ? value.alpha : 0,
          material.alphaMode !== "opaque" && front && value.discarded ? 1 : 0,
          material.transmission ?? 0,
          material.ior ?? 1.5,
          material.attenuationDistance ?? 0,
          1 - (material.specularIntensity ?? 1),
          ...resources.materials.slice(materialIndex * SURFACE_MATERIAL_FLOATS + 28, materialIndex * SURFACE_MATERIAL_FLOATS + 32),
          ...value.specularColor,
          value.specularIntensity,
        ],
      });
    }
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end(
      '<!doctype html><meta charset="utf-8"><title>pelican surface GPU numeric probe</title>',
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
        const packet = {
          shader:
            SURFACE_SHADER +
            String.raw`
 @group(0) @binding(4) var<storage,read> queries:array<vec4f>;
 @group(0) @binding(5) var<storage,read_write> results:array<vec4f>;
 @compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id:vec3u){if(id.x>=arrayLength(&queries)){return;}let q=queries[id.x];let bary=vec3f(q.y,q.z,1.0-q.y-q.z);let value=evaluateSurface(u32(q.x),bary,q.w>0.5);var coverage=vec2f(0);if(surfaceMaterials[u32(surfaceTriangle(u32(q.x)).a.w)].normal.w!=0.0&&q.w>0.5){coverage=surfaceCoverage(u32(q.x),bary,true);}let offset=id.x*7u;results[offset]=vec4f(value.base,value.alpha);results[offset+1u]=vec4f(value.normal,value.roughness);results[offset+2u]=vec4f(value.emissive,value.metalness);results[offset+3u]=vec4f(value.ao,f32(value.discarded),coverage);results[offset+4u]=value.medium;results[offset+5u]=surfaceMaterials[u32(surfaceTriangle(u32(q.x)).a.w)].attenuation;results[offset+6u]=value.specular;}
 `,
          triangles: Array.from(triangles),
          materials: Array.from(resources.materials),
          textures: Array.from(new Uint32Array(resources.textures.buffer)),
          texels: Array.from(resources.texels),
          queries,
          bufferSizes: surfaceGpuProbeBufferSizes([
            triangles.length,
            resources.materials.length,
            resources.textures.length,
            resources.texels.length,
            queries.length,
          ]),
          resultFloats: RESULT_FLOATS,
        };
        const execute = new Function(
          "return (" +
            String.raw`
 async(packet)=>{
 const adapter=await navigator.gpu.requestAdapter({powerPreference:'high-performance'});
 if(!adapter||adapter.info.isFallbackAdapter)throw Error('TC_GPU_HARDWARE_REQUIRED');
 const device=await adapter.requestDevice();const buffers=[];
 try{
 device.pushErrorScope('validation');
 function input(values,integer,binding){
 const buffer=device.createBuffer({size:packet.bufferSizes[binding],usage:GPUBufferUsage.STORAGE,mappedAtCreation:true});
 (integer?new Uint32Array(buffer.getMappedRange()):new Float32Array(buffer.getMappedRange())).set(values);
 buffer.unmap();buffers.push(buffer);return buffer;
 }
 const inputs=[input(packet.triangles,false,0),input(packet.materials,false,1),input(packet.textures,true,2),input(packet.texels,true,3),input(packet.queries,false,4)];
 const size=packet.bufferSizes[5];
 const result=device.createBuffer({size,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC});buffers.push(result);
 const read=device.createBuffer({size,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});buffers.push(read);
 const module=device.createShaderModule({code:packet.shader});const compilation=await module.getCompilationInfo();
 const errors=compilation.messages.filter(message=>message.type==='error').map(message=>message.message);
 if(errors.length)throw Error(errors.join('\n'));
 const pipeline=await device.createComputePipelineAsync({layout:'auto',compute:{module,entryPoint:'main'}});
 const group=device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[...inputs,result].map((buffer,binding)=>({binding,resource:{buffer}}))});
 const encoder=device.createCommandEncoder();const pass=encoder.beginComputePass();
 pass.setPipeline(pipeline);pass.setBindGroup(0,group);pass.dispatchWorkgroups(Math.ceil(packet.queries.length/4/64));pass.end();
 encoder.copyBufferToBuffer(result,0,read,0,size);device.queue.submit([encoder.finish()]);await read.mapAsync(GPUMapMode.READ);
 const values=Array.from(new Float32Array(read.getMappedRange().slice(0,packet.queries.length/4*packet.resultFloats*4)));read.unmap();
 const error=await device.popErrorScope();if(error)throw Error(error.message);
 return{values,adapter:{vendor:adapter.info.vendor,architecture:adapter.info.architecture,isFallbackAdapter:adapter.info.isFallbackAdapter},compilation:compilation.messages.map(message=>({type:message.type,message:message.message}))};
 }finally{for(const buffer of buffers)buffer.destroy();device.destroy();}
 }
 ` +
            ")",
        )() as (packet: unknown) => Promise<{
          values: number[];
          adapter: unknown;
          compilation: unknown[];
        }>;
        const result = await page.evaluate(execute, packet);
        assert.equal(result.values.length, expected.length * RESULT_FLOATS);
        let maxError = 0;
        for (let query = 0; query < expected.length; query++)
          for (let field = 0; field < RESULT_FLOATS; field++) {
            const actual = result.values[query * RESULT_FLOATS + field],
              reference = expected[query].values[field];
            assert.ok(Number.isFinite(actual), "Nonfinite GPU sample");
            const error = Math.abs(actual - reference);
            maxError = Math.max(maxError, error);
            assert.ok(
              error < 5e-5,
              JSON.stringify({ query, field, actual, reference, error }),
            );
          }
        const report = {
          passed: true,
          backend: "webgpu",
          adapter: result.adapter,
          abi: resources.abi,
          queries: expected.length,
          physicalQueries: expected.filter(({ index }) => {
            const triangle = snapshot.triangles[index];
            return snapshot.materials.some(
              (material) =>
                material.uuid === triangle.materialUuid &&
                (material.transmission ?? 0) > 0,
            );
          }).length,
          resultFloats: RESULT_FLOATS,
          expected,
          actual: result.values,
          maxError,
          compilation: result.compilation,
          limitations: [
            "Surface evaluation/readback only; no BSDF, light transport, dynamic BVH, denoiser or complete M3 rendering claim.",
            "This probe compares the implemented CPU surface reference and GPU ABI on the recorded adapter.",
          ],
        };
        await writeFile(
          path.join(output, "surface-gpu.json"),
          JSON.stringify(report, null, 2) + "\n",
        );
        return report;
      },
      60000,
      "M3 surface WGSL numeric validation",
    );
  } finally {
    await browser.close();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }
}
