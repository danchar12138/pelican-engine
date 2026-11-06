/** Private renderer API: spatial filtering only, not temporal reconstruction. */
export interface SurfaceDenoiserOptions {
  iterations?: number;
  enabled?: boolean;
}

export interface SurfaceDenoiserInspection {
  entries: number;
  bytes: number;
  passes: number;
  lastPasses: number;
  dimension: { width: number; height: number };
  disposed: boolean;
  lost: boolean;
}

export interface SurfaceDenoiser {
  encode(
    encoder: GPUCommandEncoder,
    input: GPUBuffer,
    normalDepth: GPUBuffer,
    albedoRoughness: GPUBuffer,
    width: number,
    height: number,
    options?: SurfaceDenoiserOptions,
  ): GPUBuffer;
  inspect(): SurfaceDenoiserInspection;
  dispose(): void;
}

// Dammertz et al., HPG 2010, DOI 10.2312/EGGH/HPG10/067-075.
// B3-spline a-trous, with conservative distance/material/original-luma guides.
const SHADER = /* wgsl */ `
struct Parameters { width:u32, height:u32, step:u32, padding:u32 }
@group(0) @binding(0) var<storage, read> source:array<vec4f>;
@group(0) @binding(1) var<storage, read> normals:array<vec4f>;
@group(0) @binding(2) var<storage, read> albedo:array<vec4f>;
@group(0) @binding(3) var<storage, read> original:array<vec4f>;
@group(0) @binding(4) var<storage, read_write> destination:array<vec4f>;
@group(0) @binding(5) var<uniform> parameters:Parameters;

fn finite4(v:vec4f)->bool {
  return all((bitcast<vec4u>(v) & vec4u(0x7f800000u)) != vec4u(0x7f800000u));
}
fn validSample(v:vec4f)->bool {
  return finite4(v) && v.w > 0.0 && all(abs(v.rgb) <= vec3f(1e20));
}
fn clean(v:vec4f)->vec4f {
  var rgb=vec3f(0.0);
  var count=0.0;
  if (finite4(vec4f(v.rgb,0.0)) && all(abs(v.rgb)<=vec3f(1e20))) {
    rgb=max(v.rgb,vec3f(0.0));
  }
  if (finite4(vec4f(v.w)) && v.w>=0.0) { count=v.w; }
  if (count==0.0) { rgb=vec3f(0.0); }
  return vec4f(rgb,count);
}
fn validGuide(n:vec4f,a:vec4f)->bool {
  return finite4(n) && finite4(a) && n.w>=0.0 && n.w<=1e20
    && dot(n.xyz,n.xyz)>1e-12 && dot(n.xyz,n.xyz)<1e12
    && all(a.rgb>=vec3f(0.0)) && all(a.rgb<=vec3f(1.0))
    && a.w>=0.0 && a.w<=1.0;
}
fn luma(v:vec3f)->f32 { return dot(v,vec3f(0.2126,0.7152,0.0722)); }
fn spline(i:i32)->f32 {
  if (i==0) { return 0.375; }
  if (abs(i)==1) { return 0.25; }
  return 0.0625;
}
@compute @workgroup_size(8,8)
fn main(@builtin(global_invocation_id) id:vec3u) {
  if (id.x>=parameters.width || id.y>=parameters.height) { return; }
  let index=id.y*parameters.width+id.x;
  let raw=original[index];
  let center=clean(source[index]);
  let n=normals[index];
  let a=albedo[index];
  // Invalid originals never become contributors in subsequent iterations.
  // Misses and invalid guides are isolated, not blended into surface hits.
  if (!validSample(raw) || !validGuide(n,a)) {
    destination[index]=clean(raw);
    return;
  }
  let cn=normalize(n.xyz);
  let cl=luma(max(raw.rgb,vec3f(0.0)));
  var total=vec3f(0.0);
  var weights=0.0;
  for (var y=-2; y<=2; y++) {
    for (var x=-2; x<=2; x++) {
      let q=vec2i(id.xy)+vec2i(x,y)*i32(parameters.step);
      if (any(q<vec2i(0)) || q.x>=i32(parameters.width) || q.y>=i32(parameters.height)) { continue; }
      let qi=u32(q.y)*parameters.width+u32(q.x);
      let r=original[qi];
      let nn=normals[qi];
      let aa=albedo[qi];
      if (!validSample(r) || !validGuide(nn,aa)) { continue; }
      let cosine=clamp(dot(cn,normalize(nn.xyz)),-1.0,1.0);
      let depth=abs(n.w-nn.w);
      let depthLimit=0.002+0.03*max(min(n.w,nn.w),0.01);
      let rough=abs(a.w-aa.w);
      if (cosine<0.85 || depth>depthLimit || rough>0.2) { continue; }
      let ad=a.rgb-aa.rgb;
      let al=luma(a.rgb)-luma(aa.rgb);
      let ql=luma(max(r.rgb,vec3f(0.0)));
      // Original, not progressively blurred, luma protects same-material lighting.
      let sigma=0.03+(0.12+0.4*min(a.w,aa.w))*max(cl,ql)
        /sqrt(clamp(min(raw.w,r.w),1.0,16.0));
      let dl=(cl-ql)/sigma;
      let w=spline(x)*spline(y)*exp(-64.0*(1.0-cosine)
        -4.0*(depth/depthLimit)*(depth/depthLimit)
        -50.0*dot(ad,ad)-50.0*al*al-64.0*rough*rough-0.5*dl*dl);
      total+=clean(source[qi]).rgb*w;
      weights+=w;
    }
  }
  var rgb=center.rgb;
  if (weights>1e-8) { rgb=total/weights; }
  destination[index]=vec4f(rgb,raw.w);
}
`;

function fail(code: string, message: string): never {
  throw new Error(`TC_DENOISER_${code}: ${message}`);
}

async function creationDeadline<T>(
  work: Promise<T>,
  device: GPUDevice,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      device.lost.then((info) =>
        fail("DEVICE_LOST", `Device lost during creation: ${info.message}`),
      ),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error("TC_DENOISER_TIMEOUT: Creation exceeded 10000 ms."),
            ),
          10_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

interface Allocation {
  width: number;
  height: number;
  size: number;
  stride: number;
  buffers: [GPUBuffer, GPUBuffer, GPUBuffer];
}

class SpatialDenoiser implements SurfaceDenoiser {
  private allocation?: Allocation;
  private disposed = false;
  private lost = false;
  private passes = 0;
  private lastPasses = 0;

  constructor(
    private readonly device: GPUDevice,
    private readonly pipeline: GPUComputePipeline,
    private readonly layout: GPUBindGroupLayout,
  ) {
    const reference = new WeakRef(this);
    void device.lost.then(() => {
      const self = reference.deref();
      if (!self) return;
      self.lost = true;
      self.release();
    });
  }

  private release() {
    this.allocation?.buffers.forEach((buffer) => buffer.destroy());
    this.allocation = undefined;
  }

  private allocate(width: number, height: number, size: number): Allocation {
    const buffers: GPUBuffer[] = [];
    const stride =
      Math.ceil(16 / this.device.limits.minUniformBufferOffsetAlignment) *
      this.device.limits.minUniformBufferOffsetAlignment;
    try {
      for (let index = 0; index < 3; index++) {
        const buffer = this.device.createBuffer({
          label: `pelican spatial denoiser ${index}`,
          size: index === 2 ? stride * 5 : size,
          usage:
            index === 2
              ? GPUBufferUsage.UNIFORM
              : GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
          mappedAtCreation: true,
        });
        buffers.push(buffer);
        // Mapping also makes synchronous allocation failure transactional.
        const mapped = buffer.getMappedRange();
        if (index === 2) {
          for (let iteration = 0; iteration < 5; iteration++)
            new Uint32Array(mapped, iteration * stride, 4).set([
              width,
              height,
              1 << iteration,
              0,
            ]);
        }
        buffer.unmap();
      }
      return {
        width,
        height,
        size,
        stride,
        buffers: buffers as Allocation["buffers"],
      };
    } catch (error) {
      buffers.forEach((buffer) => buffer.destroy());
      throw error;
    }
  }

  encode(
    encoder: GPUCommandEncoder,
    input: GPUBuffer,
    normalDepth: GPUBuffer,
    albedoRoughness: GPUBuffer,
    width: number,
    height: number,
    options: SurfaceDenoiserOptions = {},
  ): GPUBuffer {
    if (this.disposed)
      fail("DISPOSED", "Create a new denoiser after dispose().");
    if (this.lost) fail("DEVICE_LOST", "Create a denoiser on a new device.");
    if (!options || typeof options !== "object" || Array.isArray(options))
      fail("OPTIONS", "Expected an options object.");
    const iterations =
      options.iterations === undefined ? 3 : options.iterations;
    if (
      !Number.isInteger(iterations) ||
      iterations < 0 ||
      iterations > 5 ||
      (options.enabled !== undefined && typeof options.enabled !== "boolean")
    )
      fail(
        "OPTIONS",
        "iterations must be an integer in [0,5]; enabled must be boolean.",
      );
    const size = width * height * 16;
    const limits = this.device.limits;
    if (
      !Number.isSafeInteger(width) ||
      !Number.isSafeInteger(height) ||
      width < 1 ||
      height < 1 ||
      width > 0x7fffffff ||
      height > 0x7fffffff ||
      !Number.isSafeInteger(size) ||
      width * height > 0xffffffff ||
      size > limits.maxBufferSize ||
      size > limits.maxStorageBufferBindingSize ||
      Math.ceil(width / 8) > limits.maxComputeWorkgroupsPerDimension ||
      Math.ceil(height / 8) > limits.maxComputeWorkgroupsPerDimension
    )
      fail(
        "DIMENSION",
        "Positive integer dimensions must fit storage and dispatch limits.",
      );
    for (const [label, buffer] of [
      ["input", input],
      ["normalDepth", normalDepth],
      ["albedoRoughness", albedoRoughness],
    ] as const) {
      if (
        !buffer ||
        !Number.isSafeInteger(buffer.size) ||
        buffer.size < size ||
        buffer.size % 16 !== 0 ||
        !(buffer.usage & GPUBufferUsage.STORAGE) ||
        buffer.mapState !== "unmapped"
      )
        fail(
          "BUFFER",
          `${label} needs unmapped STORAGE vec4f capacity >= ${size} bytes.`,
        );
      if (
        options.enabled !== false &&
        iterations !== 0 &&
        this.allocation?.buffers.includes(buffer)
      )
        fail(
          "ALIAS",
          `${label} cannot alias denoiser-owned output; copy it first.`,
        );
    }
    if (!encoder || typeof encoder.beginComputePass !== "function")
      fail("ENCODER", "Provide an open command encoder on the same device.");
    if (options.enabled === false || iterations === 0) {
      this.lastPasses = 0;
      return input;
    }

    const old = this.allocation;
    const next =
      old?.width === width && old.height === height
        ? old
        : this.allocate(width, height, size);
    const groups: GPUBindGroup[] = [];
    try {
      for (let iteration = 0; iteration < iterations; iteration++) {
        const buffers = [
          iteration === 0 ? input : next.buffers[(iteration - 1) % 2],
          normalDepth,
          albedoRoughness,
          input,
          next.buffers[iteration % 2],
        ];
        groups.push(
          this.device.createBindGroup({
            label: `pelican spatial denoiser step ${1 << iteration}`,
            layout: this.layout,
            entries: [
              ...buffers.map((buffer, binding) => ({
                binding,
                resource: { buffer, offset: 0, size },
              })),
              {
                binding: 5,
                resource: {
                  buffer: next.buffers[2],
                  offset: iteration * next.stride,
                  size: 16,
                },
              },
            ],
          }),
        );
      }
    } catch (error) {
      if (next !== old) next.buffers.forEach((buffer) => buffer.destroy());
      throw error;
    }
    // No error scope here: synchronous encode cannot consume async GPU errors.
    // Caller must submit previous commands BEFORE a resize destroys old buffers.
    try {
      for (const group of groups) {
        const pass = encoder.beginComputePass({
          label: "pelican spatial denoiser",
        });
        pass.setPipeline(this.pipeline);
        pass.setBindGroup(0, group);
        pass.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(height / 8));
        pass.end();
      }
    } catch (error) {
      if (next !== old) next.buffers.forEach((buffer) => buffer.destroy());
      throw error;
    }
    if (next !== old) {
      this.allocation = next;
      old?.buffers.forEach((buffer) => buffer.destroy());
    }
    this.passes += iterations;
    this.lastPasses = iterations;
    return next.buffers[(iterations - 1) % 2];
  }

  inspect(): SurfaceDenoiserInspection {
    const a = this.allocation;
    return {
      entries: a ? 3 : 0,
      bytes: a ? a.size * 2 + a.stride * 5 : 0,
      passes: this.passes,
      lastPasses: this.lastPasses,
      dimension: { width: a?.width ?? 0, height: a?.height ?? 0 },
      disposed: this.disposed,
      lost: this.lost,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.release();
    this.disposed = true;
  }
}

export async function createSurfaceDenoiser(
  device: GPUDevice,
): Promise<SurfaceDenoiser> {
  let pending: Promise<GPUComputePipeline>;
  let scope: Promise<GPUError | null>;
  let layout: GPUBindGroupLayout;
  device.pushErrorScope("validation");
  try {
    layout = device.createBindGroupLayout({
      label: "pelican spatial denoiser readonly ABI",
      entries: [0, 1, 2, 3, 4, 5].map((binding) => ({
        binding,
        visibility: GPUShaderStage.COMPUTE,
        buffer: {
          type:
            binding === 5
              ? "uniform"
              : binding === 4
                ? "storage"
                : "read-only-storage",
          minBindingSize: 16,
        },
      })),
    });
    pending = device.createComputePipelineAsync({
      label: "pelican spatial a-trous denoiser",
      layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
      compute: {
        module: device.createShaderModule({ code: SHADER }),
        entryPoint: "main",
      },
    });
  } catch (error) {
    // Pop even when setup throws; consume a possibly rejected pop without hiding setup failure.
    void device.popErrorScope().catch(() => {});
    throw new Error("TC_DENOISER_PIPELINE: Pipeline setup failed.", {
      cause: error,
    });
  }
  scope = device.popErrorScope();
  try {
    const [pipeline, validation] = await creationDeadline(
      Promise.all([pending, scope]),
      device,
    );
    if (validation) fail("VALIDATION", validation.message);
    return new SpatialDenoiser(device, pipeline, layout!);
  } catch (error) {
    // No GPU buffers exist before successful creation; pipelines/layouts have no destroy API.
    throw new Error("TC_DENOISER_PIPELINE: Cannot create spatial denoiser.", {
      cause: error,
    });
  }
}
