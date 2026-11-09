/** Private renderer temporal API. */
export interface TemporalFilterOptions {
  enabled?: boolean;
  reset?: boolean;
  progressive?: boolean;
  /** Bound old lighting influence while retaining clipped, reprojected detail. */
  reactive?: boolean;
}

export interface TemporalFilterInspection {
  entries: number;
  bytes: number;
  passes: number;
  lastPasses: number;
  dimension: { width: number; height: number };
  historyValid: boolean;
  disposed: boolean;
  lost: boolean;
}

export interface TemporalFilter {
  encode(
    encoder: GPUCommandEncoder,
    inputRadiance: GPUBuffer,
    normalDepth: GPUBuffer,
    albedoRoughness: GPUBuffer,
    reprojection: GPUBuffer,
    width: number,
    height: number,
    options?: TemporalFilterOptions,
  ): GPUBuffer;
  reset(): void;
  inspect(): TemporalFilterInspection;
  dispose(): void;
}

export interface TemporalReferenceInput extends TemporalFilterOptions {
  width: number;
  height: number;
  inputRadiance: ArrayLike<number>;
  normalDepth: ArrayLike<number>;
  albedoRoughness: ArrayLike<number>;
  reprojection: ArrayLike<number>;
  previousRadiance?: ArrayLike<number>;
  previousNormalDepth?: ArrayLike<number>;
  previousAlbedoRoughness?: ArrayLike<number>;
}

const SHADER = /* wgsl */ `
struct Parameters { width:u32, height:u32, history:u32, padding:u32 }
@group(0) @binding(0) var<storage, read> current:array<vec4f>;
@group(0) @binding(1) var<storage, read> normals:array<vec4f>;
@group(0) @binding(2) var<storage, read> albedo:array<vec4f>;
@group(0) @binding(3) var<storage, read> motion:array<vec4f>;
@group(0) @binding(4) var<storage, read> previous:array<vec4f>;
@group(0) @binding(5) var<storage, read> previousNormals:array<vec4f>;
@group(0) @binding(6) var<storage, read> previousAlbedo:array<vec4f>;
@group(0) @binding(7) var<storage, read_write> destination:array<vec4f>;
@group(0) @binding(8) var<uniform> parameters:Parameters;

fn finite4(v:vec4f)->bool {
  return all((bitcast<vec4u>(v) & vec4u(0x7f800000u)) != vec4u(0x7f800000u));
}
fn validSample(r:vec4f)->bool { return finite4(r) && r.w>0.0; }
fn validGuide(n:vec4f,a:vec4f)->bool {
  return finite4(n) && finite4(a) && n.w>=0.0
    && dot(n.xyz,n.xyz)>1e-12 && dot(n.xyz,n.xyz)<1e12
    && all(a.rgb>=vec3f(0.0)) && all(a.rgb<=vec3f(1.0))
    && a.w>=0.0 && a.w<=1.0;
}
fn compatible(n:vec4f,a:vec4f,pn:vec4f,pa:vec4f,expected:f32)->bool {
  return validGuide(pn,pa)
    && abs(pn.w-expected)<=0.002+0.02*expected
    && dot(normalize(n.xyz),normalize(pn.xyz))>=0.9
    && all(abs(a.rgb-pa.rgb)<=vec3f(0.1)) && abs(a.w-pa.w)<=0.1;
}
fn toYCoCg(v:vec3f)->vec3f {
  return vec3f(0.25*v.r+0.5*v.g+0.25*v.b,0.5*v.r-0.5*v.b,
    -0.25*v.r+0.5*v.g-0.25*v.b);
}
fn fromYCoCg(v:vec3f)->vec3f { return vec3f(v.x+v.y-v.z,v.x+v.z,v.x-v.y-v.z); }

@compute @workgroup_size(8,8)
fn main(@builtin(global_invocation_id) id:vec3u) {
  if (id.x>=parameters.width || id.y>=parameters.height) { return; }
  let index=id.y*parameters.width+id.x;
  let raw=current[index];
  // Exact copy paths preserve invalid data for the caller to diagnose.
  destination[index]=raw;
  if (parameters.history==0u || !validSample(raw)) { return; }
  let n=normals[index];
  let a=albedo[index];
  let m=motion[index];
  if (!validGuide(n,a) || !finite4(m) || m.w<=0.0 || m.z<0.0
    || any(m.xy<vec2f(0.0)) || any(m.xy>=vec2f(1.0))) { return; }
  // UVs refer to texel centers: (pixel + 0.5) / dimensions.
  let p=m.xy*vec2f(f32(parameters.width),f32(parameters.height))-vec2f(0.5);
  let base=vec2i(floor(p));
  let f=fract(p);
  var history=vec3f(0.0);
  var count=0.0;
  var support=0.0;
  for (var y=0; y<2; y++) {
    for (var x=0; x<2; x++) {
      let q=base+vec2i(x,y);
      if (any(q<vec2i(0)) || q.x>=i32(parameters.width) || q.y>=i32(parameters.height)) { continue; }
      let qi=u32(q.y)*parameters.width+u32(q.x);
      let r=previous[qi];
      if (!validSample(r) || !compatible(n,a,previousNormals[qi],previousAlbedo[qi],m.z)) { continue; }
      let w=select(1.0-f.x,f.x,x==1)*select(1.0-f.y,f.y,y==1);
      history+=r.rgb*w;
      count+=min(r.w,select(32.0,8.0,parameters.history==2u))*w;
      support+=w;
    }
  }
  if (support<0.01) { return; }
  history/=support;
  count/=support;
  if (!finite4(vec4f(history,count))) { return; }
  var lo=toYCoCg(raw.rgb);
  var hi=lo;
  for (var y=-1; y<=1; y++) {
    for (var x=-1; x<=1; x++) {
      let q=vec2i(id.xy)+vec2i(x,y);
      if (any(q<vec2i(0)) || q.x>=i32(parameters.width) || q.y>=i32(parameters.height)) { continue; }
      let qi=u32(q.y)*parameters.width+u32(q.x);
      let r=current[qi];
      if (!validSample(r) || !compatible(n,a,normals[qi],albedo[qi],n.w)) { continue; }
      let c=toYCoCg(r.rgb);
      lo=min(lo,c);
      hi=max(hi,c);
    }
  }
  let clipped=fromYCoCg(clamp(toYCoCg(history),lo,hi));
  let weight=count/(raw.w+count);
  let result=raw.rgb*(1.0-weight)+clipped*weight;
  // Invalid history must not contaminate a valid current sample.
  if (finite4(vec4f(result,count))) { destination[index]=vec4f(result,raw.w+count); }
}
`;

function fail(code: string, message: string): never {
  throw new Error(`TC_TEMPORAL_${code}: ${message}`);
}

function validateOptions(options: TemporalFilterOptions): void {
  if (!options || typeof options !== "object" || Array.isArray(options))
    fail("OPTIONS", "Expected an options object.");
  for (const key of ["enabled", "reset", "progressive", "reactive"] as const)
    if (options[key] !== undefined && typeof options[key] !== "boolean")
      fail("OPTIONS", `${key} must be boolean.`);
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
              new Error("TC_TEMPORAL_TIMEOUT: Creation exceeded 10000 ms."),
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
  buffers: [GPUBuffer, GPUBuffer, GPUBuffer, GPUBuffer, GPUBuffer];
  previous: number;
}

const OWNED_BUDGET = 512 * 1024 * 1024;

class GpuTemporalFilter implements TemporalFilter {
  private allocation?: Allocation;
  private historyValid = false;
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

  private release(): void {
    this.allocation?.buffers.forEach((buffer) => buffer.destroy());
    this.allocation = undefined;
    this.historyValid = false;
  }

  private allocate(
    width: number,
    height: number,
    size: number,
    stride: number,
  ): Allocation {
    const buffers: GPUBuffer[] = [];
    try {
      for (let index = 0; index < 5; index++) {
        const buffer = this.device.createBuffer({
          label: `pelican temporal filter ${index}`,
          size: index === 4 ? stride * 3 : size,
          usage:
            index === 4
              ? GPUBufferUsage.UNIFORM
              : GPUBufferUsage.STORAGE |
                (index < 2 ? GPUBufferUsage.COPY_SRC : GPUBufferUsage.COPY_DST),
          mappedAtCreation: true,
        });
        buffers.push(buffer);
        const mapped = buffer.getMappedRange();
        if (index === 4) {
          for (let history = 0; history < 3; history++)
            new Uint32Array(mapped, history * stride, 4).set([
              width,
              height,
              history,
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
        previous: 1,
      };
    } catch (error) {
      buffers.forEach((buffer) => buffer.destroy());
      throw error;
    }
  }

  encode(
    encoder: GPUCommandEncoder,
    inputRadiance: GPUBuffer,
    normalDepth: GPUBuffer,
    albedoRoughness: GPUBuffer,
    reprojection: GPUBuffer,
    width: number,
    height: number,
    options: TemporalFilterOptions = {},
  ): GPUBuffer {
    if (this.disposed)
      fail("DISPOSED", "Create a new temporal filter after dispose().");
    if (this.lost)
      fail("DEVICE_LOST", "Create a temporal filter on a new device.");
    validateOptions(options);
    const size = width * height * 16;
    const limits = this.device.limits;
    const alignment = limits.minUniformBufferOffsetAlignment;
    const stride = Math.ceil(16 / alignment) * alignment;
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
    if (
      !Number.isSafeInteger(stride) ||
      stride < 16 ||
      stride * 3 > limits.maxBufferSize ||
      size * 4 + stride * 3 > OWNED_BUDGET
    )
      fail(
        "BUDGET",
        "Owned buffers must fit device limits and the 512 MiB temporal budget.",
      );
    for (const [label, buffer, copy] of [
      ["inputRadiance", inputRadiance, false],
      ["normalDepth", normalDepth, true],
      ["albedoRoughness", albedoRoughness, true],
      ["reprojection", reprojection, false],
    ] as const) {
      if (
        !buffer ||
        !Number.isSafeInteger(buffer.size) ||
        buffer.size < size ||
        buffer.size % 16 !== 0 ||
        !(buffer.usage & GPUBufferUsage.STORAGE) ||
        (copy &&
          options.enabled !== false &&
          !(buffer.usage & GPUBufferUsage.COPY_SRC)) ||
        buffer.mapState !== "unmapped"
      )
        fail(
          "BUFFER",
          `${label} needs unmapped STORAGE vec4f capacity >= ${size} bytes; enabled guides also need COPY_SRC.`,
        );
      if (
        options.enabled !== false &&
        this.allocation?.buffers.includes(buffer)
      )
        fail(
          "ALIAS",
          `${label} cannot alias temporal-owned buffers; copy it first.`,
        );
    }
    if (
      !encoder ||
      typeof encoder.beginComputePass !== "function" ||
      (options.enabled !== false &&
        typeof encoder.copyBufferToBuffer !== "function")
    )
      fail(
        "ENCODER",
        "Provide an open command encoder on the same device with copy support.",
      );
    if (options.enabled === false) {
      this.historyValid = false;
      this.lastPasses = 0;
      return inputRadiance;
    }

    const old = this.allocation;
    const next =
      old?.width === width && old.height === height
        ? old
        : this.allocate(width, height, size, stride);
    const useHistory =
      next === old &&
      this.historyValid &&
      !options.reset &&
      !options.progressive;
    const dest = 1 - next.previous;
    try {
      const buffers = [
        inputRadiance,
        normalDepth,
        albedoRoughness,
        reprojection,
        next.buffers[next.previous],
        next.buffers[2],
        next.buffers[3],
        next.buffers[dest],
      ];
      const group = this.device.createBindGroup({
        label: "pelican temporal filter",
        layout: this.layout,
        entries: [
          ...buffers.map((buffer, binding) => ({
            binding,
            resource: { buffer, offset: 0, size },
          })),
          {
            binding: 8,
            resource: {
              buffer: next.buffers[4],
              offset: useHistory ? stride * (options.reactive ? 2 : 1) : 0,
              size: 16,
            },
          },
        ],
      });
      // No async error scopes in synchronous encode. Caller owns submission validation.
      const pass = encoder.beginComputePass({
        label: "pelican temporal filter",
      });
      pass.setPipeline(this.pipeline);
      pass.setBindGroup(0, group);
      pass.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(height / 8));
      pass.end();
      encoder.copyBufferToBuffer(normalDepth, 0, next.buffers[2], 0, size);
      encoder.copyBufferToBuffer(albedoRoughness, 0, next.buffers[3], 0, size);
    } catch (error) {
      if (next !== old) next.buffers.forEach((buffer) => buffer.destroy());
      throw error;
    }
    if (next !== old) {
      this.allocation = next;
      old?.buffers.forEach((buffer) => buffer.destroy());
    }
    next.previous = dest;
    this.historyValid = true;
    this.passes++;
    this.lastPasses = 1;
    return next.buffers[dest];
  }

  reset(): void {
    this.historyValid = false;
  }

  inspect(): TemporalFilterInspection {
    const a = this.allocation;
    return {
      entries: a ? 5 : 0,
      bytes: a ? a.size * 4 + a.stride * 3 : 0,
      passes: this.passes,
      lastPasses: this.lastPasses,
      dimension: { width: a?.width ?? 0, height: a?.height ?? 0 },
      historyValid: this.historyValid,
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

export async function createTemporalFilter(
  device: GPUDevice,
): Promise<TemporalFilter> {
  let pending: Promise<GPUComputePipeline>;
  let layout: GPUBindGroupLayout;
  device.pushErrorScope("validation");
  try {
    layout = device.createBindGroupLayout({
      label: "pelican temporal readonly ABI",
      entries: Array.from({ length: 9 }, (_, binding) => ({
        binding,
        visibility: GPUShaderStage.COMPUTE,
        buffer: {
          type:
            binding === 8
              ? "uniform"
              : binding === 7
                ? "storage"
                : "read-only-storage",
          minBindingSize: 16,
        },
      })),
    });
    pending = device.createComputePipelineAsync({
      label: "pelican temporal reprojection filter",
      layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
      compute: {
        module: device.createShaderModule({ code: SHADER }),
        entryPoint: "main",
      },
    });
  } catch (error) {
    void device.popErrorScope().catch(() => {});
    throw new Error("TC_TEMPORAL_PIPELINE: Pipeline setup failed.", {
      cause: error,
    });
  }
  const scope = device.popErrorScope();
  try {
    const [pipeline, validation] = await creationDeadline(
      Promise.all([pending, scope]),
      device,
    );
    if (validation) fail("VALIDATION", validation.message);
    return new GpuTemporalFilter(device, pipeline, layout!);
  } catch (error) {
    throw new Error("TC_TEMPORAL_PIPELINE: Cannot create temporal filter.", {
      cause: error,
    });
  }
}

type Pixel = [number, number, number, number];
type Color = [number, number, number];
const pixel = (data: ArrayLike<number>, i: number): Pixel => [
  data[i * 4],
  data[i * 4 + 1],
  data[i * 4 + 2],
  data[i * 4 + 3],
];
const finite = (v: readonly number[]) =>
  v.every((x) => Number.isFinite(x) && Math.abs(x) <= 3.4028234663852886e38);
const sample = (r: Pixel) => finite(r) && r[3] > 0;
const length2 = (n: Pixel) => n[0] * n[0] + n[1] * n[1] + n[2] * n[2];
const guide = (n: Pixel, a: Pixel) =>
  finite(n) &&
  finite(a) &&
  n[3] >= 0 &&
  length2(n) > 1e-12 &&
  length2(n) < 1e12 &&
  a.every((v) => v >= 0 && v <= 1);
function compatible(
  n: Pixel,
  a: Pixel,
  pn: Pixel,
  pa: Pixel,
  expected: number,
): boolean {
  return (
    guide(pn, pa) &&
    Math.abs(pn[3] - expected) <= 0.002 + 0.02 * expected &&
    (n[0] * pn[0] + n[1] * pn[1] + n[2] * pn[2]) /
      Math.sqrt(length2(n) * length2(pn)) >=
      0.9 &&
    a.every((v, i) => Math.abs(v - pa[i]) <= 0.1)
  );
}
function toYCoCg(v: readonly number[]): Color {
  return [
    0.25 * v[0] + 0.5 * v[1] + 0.25 * v[2],
    0.5 * v[0] - 0.5 * v[2],
    -0.25 * v[0] + 0.5 * v[1] - 0.25 * v[2],
  ];
}
function fromYCoCg(v: Color): Color {
  return [v[0] + v[1] - v[2], v[0] + v[2], v[0] - v[1] - v[2]];
}

/** Stateless CPU oracle; double intermediates, f32 output, not bit-exact GPU arithmetic. */
export function temporalFilterReference(
  input: TemporalReferenceInput,
): Float32Array {
  validateOptions(input);
  const {
    width,
    height,
    inputRadiance,
    normalDepth,
    albedoRoughness,
    reprojection,
    previousRadiance,
    previousNormalDepth,
    previousAlbedoRoughness,
  } = input;
  const size = width * height * 4;
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 1 ||
    height < 1 ||
    !Number.isSafeInteger(size) ||
    size > 0xffffffff
  )
    fail(
      "DIMENSION",
      "CPU reference needs positive bounded integer dimensions.",
    );
  for (const data of [
    inputRadiance,
    normalDepth,
    albedoRoughness,
    reprojection,
  ])
    if (!data || data.length < size)
      fail("BUFFER", "CPU input arrays need four floats per pixel.");
  for (const data of [
    previousRadiance,
    previousNormalDepth,
    previousAlbedoRoughness,
  ])
    if (data && data.length < size)
      fail("BUFFER", "CPU history arrays need four floats per pixel.");
  const output = new Float32Array(size);
  for (let i = 0; i < size; i++) output[i] = inputRadiance[i];
  if (
    input.enabled === false ||
    input.reset ||
    input.progressive ||
    !previousRadiance ||
    !previousNormalDepth ||
    !previousAlbedoRoughness
  )
    return output;
  for (let i = 0; i < width * height; i++) {
    const r = pixel(inputRadiance, i),
      n = pixel(normalDepth, i),
      a = pixel(albedoRoughness, i),
      m = pixel(reprojection, i);
    if (
      !sample(r) ||
      !guide(n, a) ||
      !finite(m) ||
      m[3] <= 0 ||
      m[2] < 0 ||
      m[0] < 0 ||
      m[1] < 0 ||
      m[0] >= 1 ||
      m[1] >= 1
    )
      continue;
    const px = m[0] * width - 0.5,
      py = m[1] * height - 0.5;
    const bx = Math.floor(px),
      by = Math.floor(py),
      fx = px - bx,
      fy = py - by;
    const history: Color = [0, 0, 0];
    let support = 0,
      count = 0;
    for (let y = 0; y < 2; y++)
      for (let x = 0; x < 2; x++) {
        const qx = bx + x,
          qy = by + y;
        if (qx < 0 || qy < 0 || qx >= width || qy >= height) continue;
        const qi = qy * width + qx,
          pr = pixel(previousRadiance, qi);
        if (
          !sample(pr) ||
          !compatible(
            n,
            a,
            pixel(previousNormalDepth, qi),
            pixel(previousAlbedoRoughness, qi),
            m[2],
          )
        )
          continue;
        const w = (x === 1 ? fx : 1 - fx) * (y === 1 ? fy : 1 - fy);
        for (let k = 0; k < 3; k++) history[k] += pr[k] * w;
        count += Math.min(pr[3], input.reactive ? 8 : 32) * w;
        support += w;
      }
    if (support < 0.01) continue;
    for (let k = 0; k < 3; k++) history[k] /= support;
    count /= support;
    if (!finite([...history, count])) continue;
    const lo = toYCoCg(r),
      hi = [...lo];
    for (let y = -1; y <= 1; y++)
      for (let x = -1; x <= 1; x++) {
        const qx = (i % width) + x,
          qy = Math.floor(i / width) + y;
        if (qx < 0 || qy < 0 || qx >= width || qy >= height) continue;
        const qi = qy * width + qx,
          nr = pixel(inputRadiance, qi);
        if (
          !sample(nr) ||
          !compatible(
            n,
            a,
            pixel(normalDepth, qi),
            pixel(albedoRoughness, qi),
            n[3],
          )
        )
          continue;
        const c = toYCoCg(nr);
        for (let k = 0; k < 3; k++) {
          lo[k] = Math.min(lo[k], c[k]);
          hi[k] = Math.max(hi[k], c[k]);
        }
      }
    const h = toYCoCg(history);
    const clipped = fromYCoCg(
      h.map((v, k) => Math.max(lo[k], Math.min(hi[k], v))) as Color,
    );
    const w = count / (r[3] + count);
    const result = clipped.map((v, k) => r[k] * (1 - w) + v * w);
    if (finite([...result, count]))
      output.set([...result, r[3] + count], i * 4);
  }
  return output;
}
