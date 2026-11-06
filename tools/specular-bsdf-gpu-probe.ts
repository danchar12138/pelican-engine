import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { BSDF_SHADER, bsdfPdf, evaluateBsdf, sampleBsdf, type BsdfVec3 } from '../packages/renderer/src/bsdf.ts';
import { automationLaunchOptions, withAutomationDeadline } from './browser-session.ts';

export async function runSpecularBsdfGpuProbe() {
  const normal: BsdfVec3 = [0, 0, 1], base: BsdfVec3 = [0.2, 0.4, 0.6];
  const cases = [0, 0.4, 1].flatMap(intensity =>
    ([ [1, 1, 1], [1, 0.3, 0.1] ] as BsdfVec3[]).flatMap(color =>
      [0, 0.5, 1].flatMap(metal => [1, 0.05].flatMap(cosine =>
        [0.01, 0.99].map(branch => ({ intensity, color, metal, cosine, branch }))))));
  const expected = cases.flatMap(({ intensity, color, metal, cosine, branch }) => {
    const view: BsdfVec3 = [Math.sqrt(1 - cosine * cosine), 0, cosine];
    const random: BsdfVec3 = [branch, 0.3, 0.4];
    const f = evaluateBsdf(normal, view, view, base, 0.35, metal, 1.5, intensity, color);
    const pdf = bsdfPdf(normal, view, view, base, 0.35, metal, 1.5, intensity, color);
    const sample = sampleBsdf(normal, view, base, 0.35, metal, random, 1.5, intensity, color);
    return [...f, pdf, ...sample.direction, sample.pdf, ...sample.weight, 0];
  });
  const f32 = (n: number) => Number.isInteger(n) ? `${n}.0` : String(n);
  const rows = cases.map(({ intensity, color, metal, cosine, branch }, index) => `
  if(id.x==${index}u){intensity=${f32(intensity)}; color=vec3f(${color.map(f32).join(',')}); metal=${f32(metal)}; cosine=${f32(cosine)}; branch=${f32(branch)};}`).join('');
  const shader = BSDF_SHADER + /* wgsl */ String.raw`
@group(0) @binding(0) var<storage,read_write> output:array<vec4f>;
@compute @workgroup_size(1) fn main(@builtin(global_invocation_id) id:vec3u){
 if(id.x>=${cases.length}u){return;}
 var intensity=1.0;var color=vec3f(1);var metal=0.0;var cosine=1.0;var branch=0.01;
 ${rows}
 let n=vec3f(0,0,1);let base=vec3f(0.2,0.4,0.6);let v=vec3f(sqrt(1.0-cosine*cosine),0,cosine);
 let s=bsdfSampleSpecular(n,v,base,0.35,metal,vec3f(branch,0.3,0.4),1.5,intensity,color);
 output[id.x*3u]=vec4f(bsdfEvaluateSpecular(n,v,v,base,0.35,metal,1.5,intensity,color),bsdfPdfSpecular(n,v,v,base,0.35,metal,1.5,intensity,color));
 output[id.x*3u+1u]=vec4f(s.direction,s.pdf);output[id.x*3u+2u]=vec4f(s.weight,0);
}`;
  const server = createServer((_req, res) => res.end('<!doctype html>'));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    browser = await chromium.launch(automationLaunchOptions());
    return await withAutomationDeadline(async () => {
      const page = await browser!.newPage(); await page.goto(`http://127.0.0.1:${address.port}`);
      const execute = new Function('return (' + String.raw`async ({shader,count})=>{
 const adapter=await navigator.gpu.requestAdapter({powerPreference:'high-performance',forceFallbackAdapter:false});
 if(!adapter)throw Error('TC_GPU_HARDWARE_REQUIRED: no adapter');
 const info=adapter.info,description=[info.vendor,info.architecture,info.device,info.description].join(' ');
 if(info.isFallbackAdapter!==false||/swiftshader|llvmpipe|software|lavapipe|microsoft basic|\bwarp\b/i.test(description))throw Error('TC_GPU_HARDWARE_REQUIRED: '+description);
 const device=await adapter.requestDevice(),buffers=[];
 try{
 device.pushErrorScope('validation');const module=device.createShaderModule({code:shader});
 const errors=(await module.getCompilationInfo()).messages.filter(m=>m.type==='error');if(errors.length)throw Error(errors.map(m=>m.message).join('; '));
 const pipeline=await device.createComputePipelineAsync({layout:'auto',compute:{module,entryPoint:'main'}});
 const size=count*48,out=device.createBuffer({size,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC});buffers.push(out);
 const read=device.createBuffer({size,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});buffers.push(read);
 const group=device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:out}}]});
 const encoder=device.createCommandEncoder(),pass=encoder.beginComputePass();pass.setPipeline(pipeline);pass.setBindGroup(0,group);pass.dispatchWorkgroups(count);pass.end();encoder.copyBufferToBuffer(out,0,read,0,size);device.queue.submit([encoder.finish()]);
 await read.mapAsync(GPUMapMode.READ);const actual=Array.from(new Float32Array(read.getMappedRange().slice(0)));read.unmap();
 const error=await device.popErrorScope();if(error)throw Error(error.message);return {actual,adapter:{vendor:info.vendor,architecture:info.architecture,device:info.device,isFallbackAdapter:info.isFallbackAdapter}};
 }finally{buffers.forEach(b=>b.destroy());device.destroy();}
 }` + ')')();
      const result = await page.evaluate(execute, { shader, count: cases.length }) as { actual: number[]; adapter: unknown };
      assert.equal(result.actual.length, expected.length);
      let maxScaledError = 0;
      expected.forEach((value, i) => { const difference = Math.abs(result.actual[i] - value) / Math.max(1, Math.abs(value)); maxScaledError = Math.max(maxScaledError, difference); assert.ok(Number.isFinite(result.actual[i]) && difference <= 2e-3, `case ${JSON.stringify(cases[Math.floor(i / 12)])} field ${i % 12}: GPU ${result.actual[i]}, CPU ${value}`); });
      return { passed: true, backend: 'hardware-webgpu', cases, expected, ...result, maxScaledError, tolerance: 2e-3, limitations: ['BSDF compute numeric parity only; no raster, path or hybrid image parity claim.'] };
    }, 60000, 'specular BSDF GPU numeric validation');
  } finally { await browser?.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.argv.includes('--exclusive-gpu')) throw new Error('TC_GPU_HARDWARE_REQUIRED: reserve the GPU and pass --exclusive-gpu');
  console.log(JSON.stringify(await runSpecularBsdfGpuProbe(), null, 2));
}
