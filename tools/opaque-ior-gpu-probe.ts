import assert from "node:assert/strict";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";
import { BSDF_SHADER, bsdfPdf, evaluateBsdf, sampleBsdf } from "../packages/renderer/src/bsdf.ts";
import { automationLaunchOptions, withAutomationDeadline } from "./browser-session.ts";

export async function runOpaqueIorGpuProbe() {
  const iors = [1.1, 1.5, 2], n = [0, 0, 1] as const, base = [0.2, 0.4, 0.6] as const;
  const expected = iors.flatMap((ior) => {
    const f = evaluateBsdf(n, n, n, base, 0.35, 0, ior);
    const pdf = bsdfPdf(n, n, n, base, 0.35, 0, ior);
    const sample = sampleBsdf(n, n, base, 0.35, 0, [0.02, 0.3, 0.4], ior);
    return [...f, pdf, ...sample.direction, sample.pdf, ...sample.weight, 0];
  });
  const shader = BSDF_SHADER + String.raw`
@group(0) @binding(0) var<storage,read_write> output:array<vec4f>;
@compute @workgroup_size(1) fn main(@builtin(global_invocation_id) id:vec3u){
 if(id.x>=3u){return;} let iors=array<f32,3>(1.1,1.5,2.0);let ior=iors[id.x];
 let n=vec3f(0,0,1);let base=vec3f(0.2,0.4,0.6);
 let s=bsdfSampleIor(n,n,base,0.35,0.0,vec3f(0.02,0.3,0.4),ior);
 output[id.x*3u]=vec4f(bsdfEvaluateIor(n,n,n,base,0.35,0.0,ior),bsdfPdfIor(n,n,n,base,0.35,0.0,ior));
 output[id.x*3u+1u]=vec4f(s.direction,s.pdf);output[id.x*3u+2u]=vec4f(s.weight,0);
}`;
  const server = createServer((_req, res) => res.end("<!doctype html>"));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    const address = server.address(); assert.ok(address && typeof address !== "string");
    browser = await chromium.launch(automationLaunchOptions());
    return await withAutomationDeadline(async () => {
      const page = await browser!.newPage(); await page.goto(`http://127.0.0.1:${address.port}`);
      const execute = new Function("return (" + String.raw`async shader=>{
 const adapter=await navigator.gpu.requestAdapter({powerPreference:'high-performance',forceFallbackAdapter:false});
 if(!adapter)throw Error('TC_GPU_HARDWARE_REQUIRED: no adapter');
 const info=adapter.info, description=[info.vendor,info.architecture,info.device,info.description].join(' ');
 if(info.isFallbackAdapter!==false||/swiftshader|llvmpipe|software|lavapipe|microsoft basic|\bwarp\b/i.test(description))throw Error('TC_GPU_HARDWARE_REQUIRED: '+description);
 const device=await adapter.requestDevice(),buffers=[];
 try{
 device.pushErrorScope('validation');const module=device.createShaderModule({code:shader});
 const errors=(await module.getCompilationInfo()).messages.filter(m=>m.type==='error');if(errors.length)throw Error(errors.map(m=>m.message).join('; '));
 const pipeline=await device.createComputePipelineAsync({layout:'auto',compute:{module,entryPoint:'main'}});
 const out=device.createBuffer({size:144,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC});buffers.push(out);
 const read=device.createBuffer({size:144,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});buffers.push(read);
 const group=device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:out}}]});
 const encoder=device.createCommandEncoder(),pass=encoder.beginComputePass();pass.setPipeline(pipeline);pass.setBindGroup(0,group);pass.dispatchWorkgroups(3);pass.end();encoder.copyBufferToBuffer(out,0,read,0,144);device.queue.submit([encoder.finish()]);
 await read.mapAsync(GPUMapMode.READ);const actual=Array.from(new Float32Array(read.getMappedRange().slice(0)));read.unmap();
 const error=await device.popErrorScope();if(error)throw Error(error.message);return {actual,adapter:{vendor:info.vendor,architecture:info.architecture,device:info.device,isFallbackAdapter:info.isFallbackAdapter}};
 }finally{buffers.forEach(b=>b.destroy());device.destroy();}
 }` + ")")();
      const result = await page.evaluate(execute, shader) as { actual: number[]; adapter: unknown };
      assert.equal(result.actual.length, expected.length);
      expected.forEach((value, i) => assert.ok(Number.isFinite(result.actual[i]) && Math.abs(result.actual[i] - value) <= 5e-5 * Math.max(1, Math.abs(value)), `field ${i}: GPU ${result.actual[i]}, CPU ${value}`));
      return { passed: true, backend: "hardware-webgpu", iors, expected, ...result, limitations: ["BSDF compute numeric probe only; no raster, path or hybrid image parity claim."] };
    }, 60000, "opaque IOR GPU numeric validation");
  } finally { await browser?.close(); await new Promise<void>((resolve) => server.close(() => resolve())); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.argv.includes("--exclusive-gpu")) throw new Error("TC_GPU_HARDWARE_REQUIRED: reserve the GPU and pass --exclusive-gpu");
  console.log(JSON.stringify(await runOpaqueIorGpuProbe(), null, 2));
}
