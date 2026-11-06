import assert from "node:assert/strict";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { sourceFingerprint } from "./source-fingerprint.ts";
import { verifyM3MaterialGraphEvidence } from "./m3-material-graph-semantic-verifier.ts";
import * as THREE from "three";
import { chromium } from "playwright";
import { compileGraphDeclaration } from "../packages/compiler/src/graph.ts";
import { compileSurfaceGraphs, DEFAULT_SURFACE_GRAPHS } from "../packages/renderer/src/material-graphs.ts";
import { extractSurfaceScene } from "../packages/renderer/src/surface.ts";
import { packSurfaceGeometry, packSurfaceResources } from "../packages/renderer/src/surface-gpu.ts";
import { SURFACE_SHADER } from "../packages/renderer/src/surface-shader.ts";
import { surfaceGpuProbeBufferSizes } from "./surface-gpu-probe.ts";
import { automationLaunchOptions, withAutomationDeadline } from "./browser-session.ts";

const clamp = (v: number) => Math.max(0, Math.min(1, v));
export function makeMaterialGraphFixture(times: readonly [number, number]) {
  const scene = new THREE.Scene();
  const materials = [0, 1].map(() => new THREE.MeshStandardMaterial({
    color: 0xffffff, opacity: 0.8, alphaTest: 0.3, side: THREE.DoubleSide,
  }));
  const geometry = new THREE.PlaneGeometry();
  for (const material of materials) scene.add(new THREE.Mesh(geometry, material));
  const timeGraph = compileGraphDeclaration({ nodes: [{ id: "t", op: "time" }], output: "t" }, "float");
  assert.deepEqual(timeGraph.issues, []);
  const emissive = [[1, 2, 3], [4, 5, 6]].map((value) => {
    const result = compileGraphDeclaration({ nodes: [{ id: "v", op: "vec3", value }], output: "v" }, "vec3");
    assert.deepEqual(result.issues, []);
    return result.graph;
  });
  const bindings = new Map(materials.map((material, i) => [material, {
    id: `material-${i}`, graphs: { opacity: timeGraph.graph, roughness: timeGraph.graph, emissive: emissive[i] },
    time: times[i], parameters: {}, textures: new Map(),
  }]));
  const snapshot = extractSurfaceScene(scene);
  const program = compileSurfaceGraphs(snapshot, bindings);
  const packed = packSurfaceResources(snapshot);
  const table = new Float32Array(packed.materials.length + program.rows.length);
  table.set(packed.materials); table.set(program.rows, packed.materials.length);
  const expected = snapshot.triangles.flatMap((triangle) => {
    const i = materials.findIndex((material) => material.uuid === triangle.materialUuid);
    assert.notEqual(i, -1);
    const alpha = 0.8 * clamp(times[i]);
    return [alpha, clamp(times[i]), alpha, alpha < 0.3 ? 1 : 0, ...[1, 2, 3].map((n) => n + i * 3), alpha < 0.3 ? 1 : 0];
  });
  const result = { shader: SURFACE_SHADER.replace(DEFAULT_SURFACE_GRAPHS, program.source), table,
    triangles: packSurfaceGeometry(snapshot), textures: new Uint32Array(packed.textures.buffer),
    texels: packed.texels, expected, count: snapshot.triangles.length };
  geometry.dispose(); materials.forEach((material) => material.dispose());
  return result;
}

export function assertMaterialGraphValues(actual: readonly number[], expected: readonly number[]) {
  assert.equal(actual.length, expected.length);
  for (let i = 0; i < expected.length; i++) {
    assert.ok(Number.isFinite(actual[i]) && Math.abs(actual[i] - expected[i]) < 5e-5,
      `sample ${Math.floor(i / 8)} field ${i % 8}: actual ${actual[i]}, expected ${expected[i]}`);
  }
}

export async function runMaterialGraphGpuProbe(onReadback?: (readback: { backend: string; adapter: unknown; triangles: number; expected: number[][]; actual: number[][] }) => Promise<void>) {
  const first = makeMaterialGraphFixture([0.25, 0.75]);
  const second = makeMaterialGraphFixture([1.5, -0.25]);
  assert.equal(first.shader, second.shader);
  const queries = Array.from({ length: first.count }, (_, i) => [i, 0.2, 0.3, 1]).flat();
  const sizes = surfaceGpuProbeBufferSizes([first.triangles.length, first.table.length, first.textures.length, first.texels.length, queries.length]);
  sizes[5] = first.count * 8 * 4;
  const server = createServer((_request, response) => response.end("<!doctype html>"));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    const address = server.address(); assert.ok(address && typeof address !== "string");
    browser = await chromium.launch(automationLaunchOptions());
    return await withAutomationDeadline(async () => {
      const page = await browser!.newPage();
      await page.goto(`http://127.0.0.1:${address.port}`);
      const packet = { shader: first.shader + String.raw`
@group(0) @binding(4) var<storage,read> queries:array<vec4f>;
@group(0) @binding(5) var<storage,read_write> results:array<vec4f>;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id:vec3u){
 if(id.x>=arrayLength(&queries)){return;} let q=queries[id.x]; let bary=vec3f(q.y,q.z,1.0-q.y-q.z);
 let v=evaluateSurface(u32(q.x),bary,true);let c=surfaceCoverage(u32(q.x),bary,true);
 results[id.x*2u]=vec4f(v.alpha,v.roughness,c.x,c.y);
 results[id.x*2u+1u]=vec4f(v.emissive,f32(v.discarded));
}`, triangles: Array.from(first.triangles), tables: [Array.from(first.table), Array.from(second.table)],
        textures: Array.from(first.textures), texels: Array.from(first.texels), queries, sizes };
      const execute = new Function("return (" + String.raw`async p=>{
 const adapter=await navigator.gpu.requestAdapter({powerPreference:'high-performance'});
 if(!adapter||adapter.info.isFallbackAdapter)throw Error('TC_GPU_HARDWARE_REQUIRED');
 const device=await adapter.requestDevice(), buffers=[];
 try{
 device.pushErrorScope('validation');
 function input(values,integer,binding){const b=device.createBuffer({size:p.sizes[binding],usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST,mappedAtCreation:true});
 (integer?new Uint32Array(b.getMappedRange()):new Float32Array(b.getMappedRange())).set(values);b.unmap();buffers.push(b);return b;}
 const inputs=[input(p.triangles,false,0),input(p.tables[0],false,1),input(p.textures,true,2),input(p.texels,true,3),input(p.queries,false,4)];
 const output=device.createBuffer({size:p.sizes[5],usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC});buffers.push(output);
 const read=device.createBuffer({size:p.sizes[5],usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});buffers.push(read);
 const module=device.createShaderModule({code:p.shader});const info=await module.getCompilationInfo();
 const errors=info.messages.filter(m=>m.type==='error');if(errors.length)throw Error(errors.map(m=>m.message).join('; '));
 const pipeline=await device.createComputePipelineAsync({layout:'auto',compute:{module,entryPoint:'main'}});
 const group=device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[...inputs,output].map((buffer,binding)=>({binding,resource:{buffer}}))});
 const samples=[];for(const table of p.tables){device.queue.writeBuffer(inputs[1],0,new Float32Array(table));
 const encoder=device.createCommandEncoder(),pass=encoder.beginComputePass();pass.setPipeline(pipeline);pass.setBindGroup(0,group);pass.dispatchWorkgroups(Math.ceil(p.queries.length/4/64));pass.end();encoder.copyBufferToBuffer(output,0,read,0,p.sizes[5]);device.queue.submit([encoder.finish()]);
 await read.mapAsync(GPUMapMode.READ);samples.push(Array.from(new Float32Array(read.getMappedRange().slice(0))));read.unmap();}
 const error=await device.popErrorScope();if(error)throw Error(error.message);
 return {samples,adapter:{vendor:adapter.info.vendor,architecture:adapter.info.architecture,isFallbackAdapter:adapter.info.isFallbackAdapter}};
 }finally{for(const b of buffers)b.destroy();device.destroy();}
 }` + ")")();
      const result = await page.evaluate(execute, packet) as { samples: number[][]; adapter: unknown };
      // Persist the raw GPU readback before any assertion can discard it.
      await onReadback?.({ backend: "webgpu", adapter: result.adapter, triangles: first.count, expected: [first.expected, second.expected], actual: result.samples });
      assertMaterialGraphValues(result.samples[0], first.expected);
      assertMaterialGraphValues(result.samples[1], second.expected);
      return { passed: true, backend: "webgpu", adapter: result.adapter, triangles: first.count,
        expected: [first.expected, second.expected], actual: result.samples,
        limitations: ["Surface graph evaluation and buffer updates only; no textures, complete rendering, or M3 acceptance claim."] };
    }, 60000, "M3 material graph GPU numeric validation");
  } finally {
    await browser?.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.argv.includes("--exclusive-gpu")) throw new Error("TC_GRAPH_PROBE: Reserve the GPU and pass --exclusive-gpu.");
  const index = process.argv.indexOf("--output"), output = path.resolve(index >= 0 ? process.argv[index + 1] : ".pelican/m3-material-graph/" + Date.now());
  await mkdir(output, { recursive: true });
  const identity = await sourceFingerprint(process.cwd());
  let rawReportWritten = false;
  try {
    const report = await runMaterialGraphGpuProbe(async readback => {
      await writeFile(path.join(output, "material-graph-raw.json"), JSON.stringify({ sourceIdentity: identity.sha256, formalMilestoneAccepted: false, ...readback }, null, 2) + "\n");
    });
    await writeFile(path.join(output, "material-graph-gpu.json"), JSON.stringify({ sourceIdentity: identity.sha256, formalMilestoneAccepted: false, ...report }, null, 2) + "\n");
    rawReportWritten = true;
    const verified = await verifyM3MaterialGraphEvidence({ sourceRoot: process.cwd(), evidenceRoot: output });
    await writeFile(path.join(output, "material-graph-semantic-verification.json"), JSON.stringify(verified, null, 2) + "\n");
    console.log(JSON.stringify({ output, sourceIdentity: identity.sha256, passed: report.passed, semanticVerified: true }));
  } catch (error) {
    await writeFile(path.join(output, rawReportWritten ? "semantic-verification-failure.json" : "material-graph-gpu.json"), JSON.stringify({ sourceIdentity: identity.sha256, formalMilestoneAccepted: false, passed: false, error: String(error) }, null, 2) + "\n");
    console.error(error); process.exitCode = 1;
  }
}
