import type { PackedGeometry } from "./geometry.ts";

const shader = /* wgsl */ `
struct Triangle { a: vec4f, b: vec4f, c: vec4f, color: vec4f, pad: vec4f }
struct Node { lo: vec4f, hi: vec4f }
struct Params { origin: vec4f, forward: vec4f, right: vec4f, up: vec4f, screen: vec4f, settings: vec4f, lightPosition:vec4f, lightColor:vec4f, environment:vec4f }
@group(0) @binding(0) var<storage,read> triangles: array<Triangle>;
@group(0) @binding(1) var<storage,read> nodes: array<Node>;
@group(0) @binding(2) var<uniform> params: Params;
@group(0) @binding(3) var image: texture_storage_2d<rgba8unorm,write>;
@group(0) @binding(4) var<storage,read_write> history: array<vec4f>;
@group(0) @binding(5) var<storage,read_write> queryResult: array<vec4f>;
struct Hit { t: f32, index: i32, normal: vec3f }
fn random(seed: ptr<function,u32>) -> f32 { *seed = *seed * 1664525u + 1013904223u; var x = *seed; x = ((x >> 16u) ^ x) * 2246822519u; return f32(x >> 8u) / 16777216.0; }
fn boxHit(o: vec3f, d: vec3f, node: Node, maxT: f32) -> bool {
 let inverse = 1.0 / (d + vec3f(1e-12));
 let a = (node.lo.xyz - o) * inverse; let b = (node.hi.xyz - o) * inverse;
 let low = min(a,b); let high = max(a,b);
 return max(max(low.x,low.y),max(low.z,0.0)) <= min(min(high.x,high.y),min(high.z,maxT));
}
fn trace(o: vec3f,d: vec3f,maxT: f32) -> Hit {
 var result = Hit(maxT,-1,vec3f(0));
 var stack: array<u32,64>; stack[0] = 0u; var size = 1u;
 loop {
  if size == 0u { break; } size -= 1u; let node = nodes[stack[size]];
  if !boxHit(o,d,node,result.t) { continue; }
  if node.hi.w > 0.0 {
   let start = u32(node.lo.w); let count = u32(node.hi.w);
   for(var j=0u;j<count;j++) {
    let id = start+j; let t = triangles[id]; let edge1 = t.b.xyz-t.a.xyz; let edge2 = t.c.xyz-t.a.xyz;
    let p = cross(d,edge2); let det = dot(edge1,p); if abs(det)<1e-7 { continue; }
    let inv = 1.0/det; let s = o-t.a.xyz; let u = dot(s,p)*inv; if u<0.0 || u>1.0 { continue; }
    let q = cross(s,edge1); let v = dot(d,q)*inv; if v<0.0 || u+v>1.0 { continue; }
    let distance = dot(edge2,q)*inv;
    if distance>0.001 && distance<result.t { var n = normalize(cross(edge1,edge2)); if dot(n,d)>0.0 { n = -n; } result = Hit(distance,i32(id),n); }
   }
  } else if size < 62u { stack[size] = u32(node.lo.w); stack[size+1u] = u32(-node.hi.w); size += 2u; }
 }
 return result;
}
fn hemisphere(n: vec3f, seed: ptr<function,u32>) -> vec3f {
 let u = random(seed); let phi = 6.2831853*random(seed); let r = sqrt(u);
 let tangent = normalize(cross(n,select(vec3f(0,1,0),vec3f(1,0,0),abs(n.y)>0.9)));
 return normalize(tangent*(r*cos(phi))+cross(n,tangent)*(r*sin(phi))+n*sqrt(1.0-u));
}
@compute @workgroup_size(1)
fn queryRay() { let hit=trace(params.origin.xyz,normalize(params.forward.xyz),1e20);queryResult[0]=vec4f(hit.t,f32(hit.index),0,0);queryResult[1]=vec4f(hit.normal,0); }
@compute @workgroup_size(8,8)
fn main(@builtin(global_invocation_id) id: vec3u) {
 let width = u32(params.screen.x); let height = u32(params.screen.y); if id.x>=width || id.y>=height { return; }
 let index = id.y*width+id.x; var seed = index*1973u+u32(params.screen.z)*9277u+89173u;
 let jitter = vec2f(random(&seed),random(&seed));
 let pixel = ((vec2f(id.xy)+jitter)/vec2f(f32(width),f32(height))*2.0-1.0);
 var origin = params.origin.xyz;
 var direction = normalize(params.forward.xyz+params.right.xyz*pixel.x-params.up.xyz*pixel.y);
 origin += direction*params.settings.z;
 var throughput = vec3f(1); var radiance = vec3f(0);
 for(var bounce=0u;bounce<u32(params.settings.x);bounce++) {
  let hit = trace(origin,direction,params.screen.w);
  if hit.index<0 { radiance += throughput*params.environment.rgb*(0.2+max(direction.y,0.0))*params.environment.w; break; }
  let triangle = triangles[u32(hit.index)]; let position = origin+direction*hit.t;
  radiance += throughput*triangle.color.rgb*triangle.a.w;
  let light = params.lightPosition.xyz+vec3f(random(&seed)-0.5,0,random(&seed)-0.5)*select(1.2,0.0,params.lightColor.w>0.5);
  let toLight = select(light-position,light,params.lightColor.w>0.5); let distance = select(length(toLight),1e10,params.lightColor.w>0.5); let l = normalize(toLight);
  if trace(position+hit.normal*0.003,l,distance-0.02).index<0 { radiance += throughput*triangle.color.rgb*params.lightColor.rgb*max(dot(hit.normal,l),0.0)*params.lightPosition.w/select(distance*distance,1.0,params.lightColor.w>0.5); }
  let diffuse = hemisphere(hit.normal,&seed); let reflected = reflect(direction,hit.normal);
  direction = normalize(mix(reflected,diffuse,triangle.b.w));
  throughput *= triangle.color.rgb; origin = position+hit.normal*0.003;
  if bounce>2u { let survival = min(max(max(throughput.r,throughput.g),throughput.b),0.95); if random(&seed)>survival { break; } throughput /= survival; }
 }
 let old = select(vec4f(0),history[index],params.settings.y>0.5); let accumulated = vec4f(old.rgb+radiance,old.a+1.0); history[index] = accumulated;
 let linear = accumulated.rgb/accumulated.a; let mapped = pow(linear/(linear+vec3f(1)),vec3f(1.0/2.2));
 textureStore(image,vec2i(id.xy),vec4f(mapped,1));
}
`;
const present = /* wgsl */ `
@group(0) @binding(0) var image: texture_2d<f32>;
@vertex fn vs(@builtin(vertex_index) i:u32)->@builtin(position) vec4f { let p=array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3)); return vec4f(p[i],0,1); }
@fragment fn fs(@builtin(position) p:vec4f)->@location(0) vec4f { return textureLoad(image,vec2i(p.xy),0); }
`;

/** Internal M0 software triangle-BVH tracer. No hardware RT/production quality claim. */
export class GPUTracer {
  readonly device: GPUDevice;
  private context: GPUCanvasContext;
  private compute: GPUComputePipeline;
  private render: GPURenderPipeline;
  private query: GPUComputePipeline;
  private uniform: GPUBuffer;
  private history: GPUBuffer;
  private output: GPUTexture;
  private triangleBuffer!: GPUBuffer;
  private nodeBuffer!: GPUBuffer;
  private computeGroup!: GPUBindGroup;
  private presentGroup: GPUBindGroup;
  private timestamps?: GPUQuerySet;
  private timestampResult?: GPUBuffer;
  frame = 0;
  width: number;
  height: number;
  constructor(
    device: GPUDevice,
    canvas: HTMLCanvasElement,
    width: number,
    height: number,
  ) {
    this.device = device;
    this.width = width;
    this.height = height;
    if (device.features.has("timestamp-query")) {
      this.timestamps = device.createQuerySet({ type: "timestamp", count: 2 });
      this.timestampResult = device.createBuffer({
        size: 256,
        usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
      });
    }
    canvas.width = width;
    canvas.height = height;
    this.context = canvas.getContext("webgpu")!;
    const format = navigator.gpu.getPreferredCanvasFormat();
    this.context.configure({ device, format, alphaMode: "opaque" });
    const tracerModule = device.createShaderModule({ code: shader });
    this.compute = device.createComputePipeline({
      layout: "auto",
      compute: { module: tracerModule, entryPoint: "main" },
    });
    this.query = device.createComputePipeline({
      layout: "auto",
      compute: { module: tracerModule, entryPoint: "queryRay" },
    });
    const module = device.createShaderModule({ code: present });
    this.render = device.createRenderPipeline({
      layout: "auto",
      vertex: { module, entryPoint: "vs" },
      fragment: { module, entryPoint: "fs", targets: [{ format }] },
      primitive: { topology: "triangle-list" },
    });
    this.uniform = device.createBuffer({
      size: 144,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.history = device.createBuffer({
      size: width * height * 16,
      usage: GPUBufferUsage.STORAGE,
    });
    this.output = device.createTexture({
      size: [width, height],
      format: "rgba8unorm",
      usage:
        GPUTextureUsage.STORAGE_BINDING |
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_SRC,
    });
    this.presentGroup = device.createBindGroup({
      layout: this.render.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: this.output.createView() }],
    });
  }
  upload(geometry: PackedGeometry) {
    this.triangleBuffer?.destroy();
    this.nodeBuffer?.destroy();
    const upload = (data: Float32Array) => {
      const buffer = this.device.createBuffer({
        size: data.byteLength,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
      this.device.queue.writeBuffer(
        buffer,
        0,
        data.buffer as ArrayBuffer,
        data.byteOffset,
        data.byteLength,
      );
      return buffer;
    };
    this.triangleBuffer = upload(geometry.triangles);
    this.nodeBuffer = upload(geometry.nodes);
    this.computeGroup = this.device.createBindGroup({
      layout: this.compute.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.triangleBuffer } },
        { binding: 1, resource: { buffer: this.nodeBuffer } },
        { binding: 2, resource: { buffer: this.uniform } },
        { binding: 3, resource: this.output.createView() },
        { binding: 4, resource: { buffer: this.history } },
      ],
    });
  }
  renderFrame(
    camera: {
      origin: number[];
      forward: number[];
      right: number[];
      up: number[];
      near: number;
      far: number;
      light: {
        position: number[];
        color: number[];
        intensity: number;
        directional: boolean;
      };
      environment: number[];
      ambient: number;
    },
    mode: "hybrid" | "path",
    accumulate: boolean,
  ) {
    const start = performance.now();
    const vec = (v: number[]) => [...v, 0];
    const data = new Float32Array([
      ...vec(camera.origin),
      ...vec(camera.forward),
      ...vec(camera.right),
      ...vec(camera.up),
      this.width,
      this.height,
      this.frame++,
      camera.far,
      mode === "path" ? 5 : 2,
      accumulate ? 1 : 0,
      camera.near,
      0,
      ...camera.light.position,
      camera.light.intensity,
      ...camera.light.color,
      camera.light.directional ? 1 : 0,
      ...camera.environment,
      camera.ambient,
    ]);
    this.device.queue.writeBuffer(this.uniform, 0, data);
    const encoder = this.device.createCommandEncoder();
    const compute = encoder.beginComputePass(
      this.timestamps
        ? {
            timestampWrites: {
              querySet: this.timestamps,
              beginningOfPassWriteIndex: 0,
              endOfPassWriteIndex: 1,
            },
          }
        : {},
    );
    compute.setPipeline(this.compute);
    compute.setBindGroup(0, this.computeGroup);
    compute.dispatchWorkgroups(
      Math.ceil(this.width / 8),
      Math.ceil(this.height / 8),
    );
    compute.end();
    if (this.timestamps)
      encoder.resolveQuerySet(this.timestamps, 0, 2, this.timestampResult!, 0);
    const render = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: this.context.getCurrentTexture().createView(),
          loadOp: "clear",
          storeOp: "store",
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
        },
      ],
    });
    render.setPipeline(this.render);
    render.setBindGroup(0, this.presentGroup);
    render.draw(3);
    render.end();
    this.device.queue.submit([encoder.finish()]);
    return performance.now() - start;
  }
  async queryRay(origin: number[], direction: number[]) {
    const output = this.device.createBuffer({
      size: 32,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });
    const read = this.device.createBuffer({
      size: 32,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    const values = new Float32Array(36);
    values.set(origin, 0);
    values.set(direction, 4);
    this.device.queue.writeBuffer(this.uniform, 0, values);
    const group = this.device.createBindGroup({
      layout: this.query.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.triangleBuffer } },
        { binding: 1, resource: { buffer: this.nodeBuffer } },
        { binding: 2, resource: { buffer: this.uniform } },
        { binding: 5, resource: { buffer: output } },
      ],
    });
    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(this.query);
    pass.setBindGroup(0, group);
    pass.dispatchWorkgroups(1);
    pass.end();
    encoder.copyBufferToBuffer(output, 0, read, 0, 32);
    this.device.queue.submit([encoder.finish()]);
    await read.mapAsync(GPUMapMode.READ);
    const result = Array.from(new Float32Array(read.getMappedRange()));
    read.unmap();
    output.destroy();
    read.destroy();
    return {
      distance: result[0],
      triangle: result[1],
      normal: result.slice(4, 7),
    };
  }
  async gpuTimeMs() {
    if (!this.timestampResult) return null;
    const buffer = this.device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    const encoder = this.device.createCommandEncoder();
    encoder.copyBufferToBuffer(this.timestampResult, 0, buffer, 0, 16);
    this.device.queue.submit([encoder.finish()]);
    await buffer.mapAsync(GPUMapMode.READ);
    const values = new BigUint64Array(buffer.getMappedRange());
    const ms = Number(values[1] - values[0]) / 1e6;
    buffer.unmap();
    buffer.destroy();
    return ms;
  }
  async pixelStats() {
    const bytesPerRow = Math.ceil((this.width * 4) / 256) * 256;
    const buffer = this.device.createBuffer({
      size: bytesPerRow * this.height,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    const encoder = this.device.createCommandEncoder();
    encoder.copyTextureToBuffer(
      { texture: this.output },
      { buffer, bytesPerRow },
      { width: this.width, height: this.height },
    );
    this.device.queue.submit([encoder.finish()]);
    await buffer.mapAsync(GPUMapMode.READ);
    const bytes = new Uint8Array(buffer.getMappedRange());
    let sum = 0,
      nonBlack = 0,
      hash = 2166136261;
    for (let y = 0; y < this.height; y += 4)
      for (let x = 0; x < this.width; x += 4) {
        const i = y * bytesPerRow + x * 4;
        const value = bytes[i] + bytes[i + 1] + bytes[i + 2];
        sum += value;
        if (value > 15) nonBlack++;
        hash = Math.imul(hash ^ value, 16777619);
      }
    buffer.unmap();
    buffer.destroy();
    return { sum, nonBlack, hash: hash >>> 0 };
  }
  dispose() {
    this.triangleBuffer?.destroy();
    this.nodeBuffer?.destroy();
    this.uniform.destroy();
    this.history.destroy();
    this.output.destroy();
    this.context.unconfigure();
    this.timestamps?.destroy();
    this.timestampResult?.destroy();
  }
}
