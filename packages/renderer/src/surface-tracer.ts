import * as THREE from "three/webgpu";
import type { RenderSettings } from "../../sdk/src/index.ts";
import { createSurfaceCapture } from "./surface-capture.ts";
import {
  createSurfaceAcceleration,
  type AccelerationFrame,
} from "./acceleration.ts";
import {
  packSurfaceGeometry,
  validateSurfaceTextureCoordinates,
  packSurfaceResources,
  packSurfaceMaterialTable,
} from "./surface-gpu.ts";
import { SURFACE_SHADER } from "./surface-shader.ts";
import { SURFACE_RAY_SHADER } from "./surface-ray-shader.ts";
import { BSDF_SHADER } from "./bsdf.ts";
import { DIELECTRIC_SHADER } from "./dielectric.ts";
import { VOLUME_SHADER } from "./volume-shader.ts";
import {
  PATH_SHADER,
  PRIMARY_SHADER,
  TRACE_PRESENT_SHADER,
  TRACE_LINEAR_PRESENT_SHADER,
  TRACE_PARAMETER_FLOATS,
  TRACE_PARAMETER_BYTES,
} from "./path-shader.ts";
import { createSurfaceDenoiser, type SurfaceDenoiser } from "./denoiser.ts";
import {
  createSurfaceTextureCache,
  type SurfaceTexture,
  type SurfaceScene,
  type SurfaceTriangle,
} from "./surface.ts";
import { createMediumCatalog, type MediumCatalog } from "./medium.ts";
import { createEnvironmentCapture, describeEnvironment, sameEnvironmentRevision, type EnvironmentRevision } from "./environment.ts";
import { appendEmissiveLights } from "./emissive-lights.ts";
import { buildEnvironmentImportance } from "./environment-importance.ts";
import { packTraversalData } from "./traversal-nodes.ts";
import { packPreviousSurfacePositions } from "./surface-motion.ts";
import { MOTION_SHADER } from "./motion-shader.ts";
import {
  compileSurfaceGraphs,
  DEFAULT_SURFACE_GRAPHS,
  graphEmissiveProposal,
  type MaterialGraphBindings,
  type SurfaceGraphBufferCopy,
} from "./material-graphs.ts";
import type {
  ComputeResidentSource,
  ComputeGpuView,
} from "./compute-view-contract.ts";
import { withGraphGPUDeadline } from "./graph.ts";
import type { TracePresentationTargets } from "./postprocess-contract.ts";
import {
  createTemporalFilter,
  type TemporalFilter,
} from "./temporal-filter.ts";

type BufferKey =
  | "triangles"
  | "materials"
  | "textures"
  | "texels"
  | "nodes"
  | "lights"
  | "pixels"
  | "environmentImportance"
  | "average"
  | "normalDepth"
  | "motion"
  | "albedo";
type Entry = { buffer: GPUBuffer; bytes: number };
type FragmentBufferState = SurfaceGraphBufferCopy & {
  key: string;
  revision: number;
  source: GPUBuffer;
  destination: GPUBuffer;
  generation: number;
};
type PreparedFragmentBuffer = SurfaceGraphBufferCopy & { view: ComputeGpuView };
const contextOwners = new WeakMap<HTMLCanvasElement, SurfaceTracer>();
const storageMin: Record<BufferKey, number> = {
  triangles: 288,
  materials: 128,
  textures: 96,
  texels: 16,
  nodes: 32,
  lights: 48,
  environmentImportance: 16,
  pixels: 16,
  average: 16,
  normalDepth: 16,
  motion: 16,
  albedo: 16,
};
const FAULT_DEBUG_BYTES = (13 + 8 * 8) * 16;
function bytes(data: ArrayBufferView) {
  const copy = new Uint8Array(data.byteLength);
  copy.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
  return copy;
}
function equal(a: Float32Array | undefined, b: Float32Array) {
  return (
    !!a &&
    a.length === b.length &&
    a.every((value, index) => value === b[index])
  );
}
function halton(index: number, base: number) {
  let value = 0,
    fraction = 1;
  while (index > 0) {
    fraction /= base;
    value += fraction * (index % base);
    index = Math.floor(index / base);
  }
  return value - 0.5;
}
async function shader(device: GPUDevice, code: string, label: string) {
  const module = device.createShaderModule({ code, label });
  const info = await module.getCompilationInfo();
  const errors = info.messages.filter((message) => message.type === "error");
  if (errors.length)
    throw new Error(
      "TC_TRACE_SHADER: " +
        label +
        ": " +
        errors.map((message) => message.message).join("\n"),
    );
  return module;
}

/** Private, real WebGPU image renderer; opaque material path currently. */
export class SurfaceTracer {
  private capture = createSurfaceCapture();
  private acceleration = createSurfaceAcceleration();
  private buffers = new Map<BufferKey, Entry>();
  private frame?: AccelerationFrame;
  private textures: readonly SurfaceTexture[] = [];
  private materialData?: Float32Array;
  private surfaceShader = SURFACE_SHADER;
  private graphRows = new Float32Array();
  private graphMaterials = 0;
  private graphParameterRows = 0;
  private fragmentBuffers = new Map<number, FragmentBufferState>();
  private fragmentGpuCopies = 0;
  private fragmentGpuCopyBytes = 0;
  private textureGpuCopies = 0;
  private textureGpuCopyBytes = 0;
  private materialGeneration = 0;
  private lightData?: Float32Array;
  private lightingSignature = "";
  private uniform: GPUBuffer;
  private presentUniform: GPUBuffer;
  private primary: GPUTexture;
  private depth: GPUTexture;
  private context: GPUCanvasContext;
  private compute!: GPUComputePipeline;
  private opaqueCompute!: GPUComputePipeline;
  private volumeCompute: GPUComputePipeline | undefined;
  private computeModule!: GPUShaderModule;
  private motionCompute: GPUComputePipeline | undefined;
  private motionGroup: GPUBindGroup | undefined;
  private motionActive = false;
  private geometryData: Float32Array | undefined;
  private capturedSurface: SurfaceScene | undefined;
  private previousSurface: SurfaceScene | undefined;
  private previousViewProjection = new THREE.Matrix4();
  private previousCameraOrigin = new THREE.Vector3();
  private previousCameraValid = false;
  private motionPasses = 0;
  private lastMotionComputed = false;
  private motionMatches = { matched: 0, missing: 0 };
  private temporal: TemporalFilter | undefined;
  private temporalOutput: GPUBuffer | undefined;
  private temporalHistoryReset = true;
  private temporalResetReasons = new Set<string>(["initial"]);
  private lastTemporalReset = true;
  private lastTemporalProgressive = false;
  private lastTemporalReasons: string[] = [];
  private temporalResets = 0;
  private mediumCatalog: MediumCatalog | undefined;
  private mediumIds = new Map<string, number>();
  private unsupportedOrthographicMedia: readonly string[] = [];
  private mediumFaces: readonly SurfaceTriangle[] = [];
  private mediumSignature = "";
  private mediumRevision = 0;
  /** Medium IDs currently committed to the captured triangle buffer. */
  private geometryMediumRevision = -1;
  private initialMedia: readonly number[] = [];
  private initialMediaKey = "";
  private lightBufferDirty = true;
  private mediumParams = [0, 0, 0, 0];
  private raster!: GPURenderPipeline;
  private present!: GPURenderPipeline;
  private linearPresent?: GPURenderPipeline;
  private linearPresentPending?: Promise<void>;
  private denoiser!: SurfaceDenoiser;
  private computeGroup?: GPUBindGroup;
  private rasterGroup?: GPUBindGroup;
  private disposed = false;
  private lost = false;
  private reset = true;
  private serial = 0;
  private samples = 0;
  private resets = 0;
  private cameraKey = "";
  private settingsKey = "";
  private environment = [0, 0, 0];
  private uploadBytes = 0;
  private lastCaptureMs = 0;
  private lastUploadMs = 0;
  private lastSubmitMs = 0;
  private output?: GPUBuffer;
  private contentGeneration = 0;
  private environmentTexture: string | null = null;
  private timestamps: GPUQuerySet | undefined;
  private timingResolve: GPUBuffer | undefined;
  private timingStart = 2;
  private environmentCapture:
    | ReturnType<typeof createEnvironmentCapture>
    | undefined;
  private environmentCache = createSurfaceTextureCache();
  private environmentSource: THREE.Texture | null = null;
  private environmentRevision: EnvironmentRevision | undefined;
  private environmentImage: THREE.DataTexture | undefined;
  private environmentIndex = -1;
  private backgroundIndex = -1;
  private backgroundIntensity = 1;
  private backgroundRotation = 0;
  private environmentProposal:
    | ReturnType<typeof buildEnvironmentImportance>
    | undefined;
  private environmentIntensity = 1;
  private environmentRotation = new THREE.Matrix4();
  private environmentState = "";
  private emissiveCount = 0;
  private lightTechniques = 0;
  private mediumFaultCheck: Promise<void> = Promise.resolve();
  private mediumFaultBusy = false;
  private mediumFault: Error | undefined;
  private mediumFaults = 0;
  private mediumDebug: unknown;
  private faultTarget = -1;
  private faultSample = 0;
  private constructor(
    private device: GPUDevice,
    private canvas: HTMLCanvasElement,
    readonly width: number,
    readonly height: number,
    private rasterRenderer?: THREE.Renderer,
    private onFault?: (error: Error) => void,
    private captureFaults = false,
  ) {
    if (
      !Number.isSafeInteger(width) ||
      !Number.isSafeInteger(height) ||
      width < 1 ||
      height < 1 ||
      width > device.limits.maxTextureDimension2D ||
      height > device.limits.maxTextureDimension2D
    )
      throw new Error("TC_TRACE_SIZE: Invalid device output dimensions.");
    if (
      width * height * 64 + 16 + (captureFaults ? FAULT_DEBUG_BYTES : 0) >
      device.limits.maxStorageBufferBindingSize
    )
      throw new Error(
        "TC_TRACE_PIXEL_BUDGET: Output storage exceeds the active adapter limit.",
      );
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("webgpu");
    if (!context) throw new Error("TC_GPU_CONTEXT");
    this.context = context;
    context.configure({
      device,
      format: navigator.gpu.getPreferredCanvasFormat(),
      alphaMode: "opaque",
    });
    contextOwners.set(canvas, this);
    this.uniform = device.createBuffer({
      size: TRACE_PARAMETER_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.presentUniform = device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.primary = device.createTexture({
      size: [width, height],
      format: "rgba32float",
      usage:
        GPUTextureUsage.RENDER_ATTACHMENT |
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_SRC,
    });
    this.depth = device.createTexture({
      size: [width, height],
      format: "depth24plus",
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
    if (device.features.has("timestamp-query")) {
      this.timestamps = device.createQuerySet({ type: "timestamp", count: 6 });
      this.timingResolve = device.createBuffer({
        size: 256,
        usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
      });
    }
    if (rasterRenderer)
      this.environmentCapture = createEnvironmentCapture(rasterRenderer);
    this.ensure(
      "pixels",
      width * height * 64 + 16 + (captureFaults ? FAULT_DEBUG_BYTES : 0),
    );
    for (const key of ["average", "normalDepth", "albedo"] as const)
      this.ensure(key, width * height * 16);
    void device.lost.then(() => {
      this.lost = true;
    });
  }
  static async create(
    device: GPUDevice,
    canvas: HTMLCanvasElement,
    width: number,
    height: number,
    rasterRenderer?: THREE.Renderer,
    onFault?: (error: Error) => void,
    captureFaults = false,
    signal?: AbortSignal,
  ) {
    if (signal?.aborted)
      throw new Error(
        "TC_TRACE_CANCELLED: Surface initialization was cancelled.",
      );
    const result = new SurfaceTracer(
      device,
      canvas,
      width,
      height,
      rasterRenderer,
      onFault,
      captureFaults,
    );
    const cancel = () => result.dispose();
    signal?.addEventListener("abort", cancel, { once: true });
    try {
      await result.initialize();
      result.active();
      return result;
    } catch (error) {
      result.dispose();
      throw error;
    } finally {
      signal?.removeEventListener("abort", cancel);
    }
  }
  private async initialize() {
    await this.createSurfacePipelines(SURFACE_SHADER);
    const presentModule = await shader(
      this.device,
      TRACE_PRESENT_SHADER,
      "surface radiance display",
    );
    this.active();
    this.present = await this.device.createRenderPipelineAsync({
      layout: "auto",
      vertex: { module: presentModule, entryPoint: "vertex" },
      fragment: {
        module: presentModule,
        entryPoint: "fragment",
        targets: [{ format: navigator.gpu.getPreferredCanvasFormat() }],
      },
      primitive: { topology: "triangle-list" },
    });
    this.active();
    const denoiser = await createSurfaceDenoiser(this.device);
    if (this.disposed || this.lost) {
      denoiser.dispose();
      this.active();
    }
    this.denoiser = denoiser;
  }
  private async createSurfacePipelines(surfaceShader: string) {
    const generation = this.contentGeneration;
    const pipelines = await withGraphGPUDeadline(
      this.device,
      "TC_TRACE_GRAPH",
      async (active) => {
        active();
        this.active();
        const computeModule = await shader(
          this.device,
          surfaceShader +
            SURFACE_RAY_SHADER +
            BSDF_SHADER +
            DIELECTRIC_SHADER +
            VOLUME_SHADER +
            PATH_SHADER,
          "surface path integrator",
        );
        active();
        this.active();
        const compute = await this.device.createComputePipelineAsync({
          layout: "auto",
          compute: {
            module: computeModule,
            entryPoint: "pathMain",
            constants: {
              traceVolumeEnabled: 0,
              surfacePhysicalEnabled: 0,
              surfaceOrderedTraversal: 0,
              traceCaptureFault: this.captureFaults ? 1 : 0,
            },
          },
        });
        active();
        this.active();
        const primaryModule = await shader(
          this.device,
          surfaceShader + PRIMARY_SHADER,
          "raster surface visibility",
        );
        active();
        this.active();
        const raster = await this.device.createRenderPipelineAsync({
          layout: "auto",
          vertex: { module: primaryModule, entryPoint: "primaryVertex" },
          fragment: {
            module: primaryModule,
            entryPoint: "primaryFragment",
            targets: [{ format: "rgba32float" }],
          },
          primitive: { topology: "triangle-list", cullMode: "none" },
          depthStencil: {
            format: "depth24plus",
            depthWriteEnabled: true,
            depthCompare: "less",
          },
        });
        active();
        this.active();
        return { compute, computeModule, raster };
      },
    );
    this.active();
    if (generation !== this.contentGeneration)
      throw Error(
        "TC_TRACE_CAPTURE_STALE: Content changed during graph pipeline setup.",
      );
    const { compute, computeModule, raster } = pipelines;
    this.compute = compute;
    this.opaqueCompute = compute;
    this.computeModule = computeModule;
    this.raster = raster;
    this.volumeCompute = undefined;
    this.motionCompute = undefined;
    this.computeGroup = undefined;
    this.rasterGroup = undefined;
    this.motionGroup = undefined;
    this.surfaceShader = surfaceShader;
  }
  private active() {
    if (this.disposed) throw new Error("TC_TRACE_DISPOSED");
    if (this.lost)
      throw new Error(
        "TC_GPU_DEVICE_LOST: Recreate renderer resources on a new device.",
      );
    if (this.mediumFault) throw this.mediumFault;
  }
  private ensure(key: BufferKey, required: number) {
    const size = Math.max(storageMin[key], Math.ceil(required / 256) * 256);
    if (
      size >
      Math.min(
        this.device.limits.maxStorageBufferBindingSize,
        this.device.limits.maxBufferSize,
      )
    )
      throw new Error(
        "TC_TRACE_BUFFER_BUDGET: " +
          key +
          " exceeds actual adapter storage binding limit.",
      );
    const previous = this.buffers.get(key);
    if (previous && previous.bytes >= size) return previous.buffer;
    const buffer = this.device.createBuffer({
      label: "pelican " + key,
      size,
      usage:
        GPUBufferUsage.STORAGE |
        GPUBufferUsage.COPY_DST |
        GPUBufferUsage.COPY_SRC,
    });
    this.buffers.set(key, { buffer, bytes: size });
    if (key === "materials") this.materialGeneration++;
    previous?.buffer.destroy();
    this.computeGroup = undefined;
    this.rasterGroup = undefined;
    this.motionGroup = undefined;
    return buffer;
  }
  private put(key: BufferKey, data: ArrayBufferView) {
    const buffer = this.ensure(key, data.byteLength);
    if (data.byteLength) {
      this.device.queue.writeBuffer(buffer, 0, bytes(data));
      if (key === "materials") this.materialGeneration++;
      this.uploadBytes += data.byteLength;
    }
    return buffer;
  }
  private prepareFragmentBuffers(
    plan: readonly SurfaceGraphBufferCopy[],
    source: ComputeResidentSource | undefined,
    materialBytes: number,
  ): PreparedFragmentBuffer[] {
    if (!plan.length) return [];
    if (!source)
      throw Error(
        (plan.some((copy) => copy.texture)
          ? "TC_RENDER_TEXTURE_CAPABILITY"
          : "TC_RENDER_BUFFER_CAPABILITY") +
          ": Native fragment slots require a managed compute GPU source.",
      );
    const limit = Math.min(
      this.device.limits.maxStorageBufferBindingSize,
      this.device.limits.maxBufferSize,
    );
    if (
      !Number.isSafeInteger(materialBytes) ||
      Math.ceil(materialBytes / 256) * 256 > limit
    )
      throw Error(
        "TC_RENDER_BUFFER_LIMIT: Material table exceeds the device buffer limits.",
      );
    let end = 0;
    // Resolve and validate every slot before encoding any copies or overwriting the table.
    return plan.map((copy) => {
      const { descriptor, count, byteOffset, type } = copy;
      if (
        !Number.isSafeInteger(count) ||
        count < 1 ||
        count > 0xffffffff ||
        descriptor.values.length !== count ||
        descriptor.type !== type ||
        (copy.texture &&
          (type !== "vec4" ||
            !Number.isSafeInteger(copy.texture.width) ||
            !Number.isSafeInteger(copy.texture.height) ||
            copy.texture.width < 1 ||
            copy.texture.height < 1 ||
            copy.texture.width * copy.texture.height !== count ||
            descriptor.texture?.width !== copy.texture.width ||
            descriptor.texture?.height !== copy.texture.height)) ||
        !descriptor.key ||
        !Number.isSafeInteger(descriptor.revision) ||
        descriptor.revision < 0 ||
        !Number.isSafeInteger(byteOffset) ||
        byteOffset % 128 !== 0 ||
        byteOffset < end ||
        byteOffset + Math.ceil(count / 8) * 128 > materialBytes
      )
        throw Error(
          (copy.texture
            ? "TC_RENDER_TEXTURE_RESOURCE"
            : "TC_RENDER_BUFFER_RESOURCE") +
            ": Invalid native fragment copy plan for " +
            copy.material +
            ":" +
            copy.name,
        );
      end = byteOffset + Math.ceil(count / 8) * 128;
      const view = source.resident(descriptor);
      if (
        view.type !== type ||
        view.count !== count ||
        view.revision !== descriptor.revision ||
        !(view.buffer.usage & GPUBufferUsage.COPY_SRC) ||
        view.buffer.size < count * 16 ||
        view.buffer.mapState === "mapped" ||
        view.buffer.mapState === "pending" ||
        view.buffer === this.buffers.get("materials")?.buffer
      )
        throw Error(
          (copy.texture
            ? "TC_RENDER_TEXTURE_RESOURCE"
            : "TC_RENDER_BUFFER_RESOURCE") +
            ": Mismatched resident fragment slot " +
            copy.material +
            ":" +
            copy.name,
        );
      return { ...copy, view };
    });
  }
  private copyFragmentBuffers(plan: readonly PreparedFragmentBuffer[]) {
    const destination = this.buffers.get("materials");
    if (
      plan.length &&
      (!destination || !(destination.buffer.usage & GPUBufferUsage.COPY_DST))
    )
      throw Error(
        "TC_RENDER_BUFFER_RESOURCE: Missing native fragment material destination.",
      );
    const next = new Map<number, FragmentBufferState>();
    const copies: FragmentBufferState[] = [];
    let changed = this.fragmentBuffers.size !== plan.length;
    for (const { view, ...copy } of plan) {
      if (
        view.buffer === destination!.buffer ||
        copy.byteOffset + copy.count * 16 > destination!.bytes
      )
        throw Error(
          "TC_RENDER_BUFFER_RESOURCE: Invalid native fragment copy destination.",
        );
      const previous = this.fragmentBuffers.get(copy.byteOffset);
      const contentChanged =
        !previous ||
        previous.key !== copy.descriptor.key ||
        previous.revision !== copy.descriptor.revision ||
        previous.source !== view.buffer ||
        previous.count !== copy.count ||
        previous.type !== copy.type ||
        previous.material !== copy.material ||
        previous.name !== copy.name ||
        previous.texture?.width !== copy.texture?.width ||
        previous.texture?.height !== copy.texture?.height;
      changed ||= contentChanged;
      const state: FragmentBufferState = {
        ...copy,
        key: copy.descriptor.key,
        revision: copy.descriptor.revision,
        source: view.buffer,
        destination: destination!.buffer,
        generation: this.materialGeneration,
      };
      next.set(copy.byteOffset, state);
      if (
        contentChanged ||
        previous!.destination !== state.destination ||
        previous!.generation !== state.generation
      )
        copies.push(state);
    }
    if (copies.length) {
      const encoder = this.device.createCommandEncoder({
        label: "Pelican native fragment buffer copies",
      });
      for (const copy of copies)
        encoder.copyBufferToBuffer(
          copy.source,
          0,
          copy.destination,
          copy.byteOffset,
          copy.count * 16,
        );
      this.device.queue.submit([encoder.finish()]);
      const buffers = copies.filter((copy) => !copy.texture),
        textures = copies.filter((copy) => copy.texture);
      this.fragmentGpuCopies += buffers.length;
      this.fragmentGpuCopyBytes += buffers.reduce(
        (sum, copy) => sum + copy.count * 16,
        0,
      );
      this.textureGpuCopies += textures.length;
      this.textureGpuCopyBytes += textures.reduce(
        (sum, copy) => sum + copy.count * 16,
        0,
      );
    }
    const hasTextures = [
      ...this.fragmentBuffers.values(),
      ...next.values(),
    ].some((copy) => copy.texture);
    this.fragmentBuffers = next;
    if (changed) {
      this.invalidateHistory(
        hasTextures ? "fragment-textures" : "fragment-buffers",
      );
      this.reset = true;
    }
  }
  private clearFragmentBuffers() {
    this.fragmentBuffers.clear();
    this.graphRows = new Float32Array();
    this.graphMaterials = 0;
    this.graphParameterRows = 0;
    this.fragmentGpuCopies = 0;
    this.fragmentGpuCopyBytes = 0;
    this.textureGpuCopies = 0;
    this.textureGpuCopyBytes = 0;
    this.materialGeneration = 0;
  }
  private get(key: BufferKey) {
    return this.buffers.get(key)?.buffer ?? this.ensure(key, storageMin[key]);
  }
  private invalidateHistory(reason: string) {
    this.temporalHistoryReset = true;
    this.temporalResetReasons.add(reason);
  }
  invalidateTemporal(reason = "mode") {
    this.invalidateHistory(reason);
    this.temporal?.reset();
    this.temporalOutput = undefined;
    this.lastMotionComputed = false;
    this.previousCameraValid = false;
    this.reset = true;
  }
  setFaultTarget(pixel: number, sample = 0) {
    if (
      !this.captureFaults ||
      !Number.isSafeInteger(pixel) ||
      pixel < -1 ||
      pixel >= this.width * this.height ||
      !Number.isSafeInteger(sample) ||
      sample < 0 ||
      sample >= 64
    )
      throw new Error(
        "TC_TRACE_FAULT_TARGET: Select a valid pixel/sample in the development renderer.",
      );
    this.faultTarget = pixel;
    this.faultSample = sample;
  }
  clearContent() {
    this.mediumFault = undefined;
    this.active();
    this.capture.clear();
    this.acceleration.dispose();
    this.acceleration = createSurfaceAcceleration();
    this.frame = undefined;
    this.samples = 0;
    this.mediumFault = undefined;
    this.mediumFaults = 0;
    this.mediumDebug = undefined;
    this.device.queue.writeBuffer(this.get("pixels"), 0, new Uint32Array(4));
    if (this.captureFaults)
      this.device.queue.writeBuffer(
        this.get("pixels"),
        this.width * this.height * 64 + 16,
        new Uint32Array(FAULT_DEBUG_BYTES / 4),
      );
    this.textures = [];
    this.materialData = undefined;
    this.clearFragmentBuffers();
    this.invalidateHistory("content");
    this.temporal?.reset();
    this.temporalOutput = undefined;
    this.geometryData = undefined;
    this.capturedSurface = undefined;
    this.previousSurface = undefined;
    this.previousCameraValid = false;
    this.motionActive = false;
    this.lastMotionComputed = false;
    this.motionMatches = { matched: 0, missing: 0 };
    this.motionGroup = undefined;
    this.lightData = undefined;
    this.lightingSignature = "";
    this.mediumCatalog?.dispose();
    this.mediumCatalog = undefined;
    this.mediumIds.clear();
    this.unsupportedOrthographicMedia = [];
    this.mediumFaces = [];
    this.mediumSignature = "";
    this.mediumRevision++;
    this.geometryMediumRevision = -1;
    this.initialMedia = [];
    this.initialMediaKey = "";
    this.mediumParams = [0, 0, 0, 0];
    this.lightBufferDirty = true;
    this.environmentCapture?.clear();
    this.environmentCache.clear();
    this.environmentImage?.dispose();
    this.environmentImage = undefined;
    this.environmentSource = null;
    this.environmentRevision = undefined;
    this.environmentIndex = -1;
    this.backgroundIndex = -1;
    this.environmentProposal = undefined;
    this.buffers.get("environmentImportance")?.buffer.destroy();
    this.buffers.delete("environmentImportance");
    this.environmentState = "";
    for (const key of [
      "triangles",
      "materials",
      "textures",
      "texels",
      "nodes",
      "lights",
    ] as const) {
      this.buffers.get(key)?.buffer.destroy();
      this.buffers.delete(key);
    }
    this.computeGroup = undefined;
    this.rasterGroup = undefined;
    this.output = undefined;
    this.contentGeneration++;
    this.reset = true;
  }
  async update(
    scene: THREE.Scene,
    knownGraphs: ReadonlySet<THREE.Material> = new Set(),
    motionEnabled = false,
    graphs: MaterialGraphBindings = new Map(),
    computeSource?: ComputeResidentSource,
  ) {
    this.active();
    const generation = this.contentGeneration;
    if (scene.fog)
      throw new Error(
        "TC_TRACE_FOG_STAGE: Fog transport is not integrated yet.",
      );
    if (scene.background && !(scene.background instanceof THREE.Color) &&
        (!(scene.background instanceof THREE.Texture) || scene.background.mapping !== THREE.EquirectangularReflectionMapping ||
          scene.backgroundBlurriness !== 0 || !Number.isFinite(scene.backgroundIntensity) || scene.backgroundIntensity < 0 ||
          scene.backgroundRotation.x !== 0 || !Number.isFinite(scene.backgroundRotation.y) || scene.backgroundRotation.z !== 0))
      throw new Error(
        "TC_TRACE_BACKGROUND_STAGE: Use an equirectangular background with finite nonnegative intensity, vertical-axis rotation and no blur.",
      );
    const source = scene.environment,
      revision = source ? describeEnvironment(source) : undefined;
    if (
      source !== this.environmentSource ||
      (revision !== undefined && (!this.environmentRevision || !sameEnvironmentRevision(revision, this.environmentRevision)))
    ) {
      if (source && !this.environmentCapture)
        throw new Error(
          "TC_TRACE_ENVIRONMENT_RENDERER: An initialized raster renderer is required for environment capture.",
        );
      const radiance = source
        ? await this.environmentCapture!.capture(source)
        : null;
      if (this.disposed || generation !== this.contentGeneration)
        throw new Error(
          "TC_TRACE_CAPTURE_STALE: Surface content owner changed during environment capture.",
        );
      if (source !== scene.environment ||
          (source && revision && !sameEnvironmentRevision(revision, describeEnvironment(source))))
        throw new Error(
          "TC_TRACE_ENVIRONMENT_STALE: Content environment changed during capture.",
        );
      let nextImage: THREE.DataTexture | undefined;
      if (radiance) {
        const proposal = buildEnvironmentImportance(
          radiance.data,
          radiance.width,
          radiance.height,
        );
        const texture = new THREE.DataTexture(
          radiance.data,
          radiance.width,
          radiance.height,
          THREE.RGBAFormat,
          THREE.FloatType,
        );
        texture.colorSpace = THREE.LinearSRGBColorSpace;
        texture.flipY = false;
        texture.wrapS = THREE.RepeatWrapping;
        texture.wrapT = THREE.ClampToEdgeWrapping;
        texture.magFilter = THREE.LinearFilter;
        texture.minFilter = THREE.LinearFilter;
        texture.generateMipmaps = false;
        try {
          this.put("environmentImportance", proposal.table);
        } catch (error) {
          texture.dispose();
          // The GPU buffer may already have been replaced; force recapture even
          // if the scene switches back to the previous environment.
          this.environmentRevision = undefined;
          this.reset = true;
          throw error;
        }
        nextImage = texture;
        this.environmentProposal = proposal;
      }
      this.environmentImage?.dispose();
      this.environmentCache.clear();
      this.environmentImage = nextImage;
      this.environmentSource = source;
      this.environmentRevision = revision;
      this.reset = true;
    }
    const start = performance.now(),
      captured = this.capture.capture(scene, knownGraphs, graphs);
    this.backgroundIndex = -1;
    if (scene.background instanceof THREE.Texture) {
      const background = this.capture.captureTexture(scene.background);
      const existing = captured.surface.textures.findIndex(texture => texture.uuid === background.uuid);
      this.backgroundIndex = existing >= 0 ? existing : captured.surface.textures.length;
      if (existing < 0) captured.surface = Object.freeze({
        ...captured.surface,
        textures: Object.freeze([...captured.surface.textures, background]),
      });
    }
    this.environmentIndex = -1;
    if (this.environmentImage) {
      const diagnostics = [] as (typeof captured.surface.diagnostics)[number][];
      const environment = this.environmentCache.getSnapshot(
        this.environmentImage,
        undefined,
        diagnostics,
      );
      this.environmentIndex = captured.surface.textures.length;
      captured.surface = Object.freeze({
        ...captured.surface,
        textures: Object.freeze([...captured.surface.textures, environment]),
        diagnostics: Object.freeze([
          ...captured.surface.diagnostics.filter(
            (d) => d.code !== "SURFACE_SCENE_EFFECTS_NOT_CAPTURED",
          ),
          ...diagnostics,
        ]),
      });
    }
    this.environmentIntensity = scene.environmentIntensity;
    this.backgroundIntensity = scene.backgroundIntensity;
    this.backgroundRotation = scene.backgroundRotation.y;
    this.environmentRotation
      .makeRotationFromEuler(scene.environmentRotation)
      .transpose();
    const environmentState = JSON.stringify([
      this.environmentIndex,
      this.backgroundIndex,
      this.backgroundIntensity,
      this.backgroundRotation,
      this.environmentIntensity,
      ...this.environmentRotation.elements,
    ]);
    if (environmentState !== this.environmentState) {
      this.reset = true;
      this.invalidateHistory("environment");
    }
    this.environmentState = environmentState;
    this.lastCaptureMs = performance.now() - start;
    const materialLimit =
      Math.floor(
        Math.min(
          this.device.limits.maxStorageBufferBindingSize,
          this.device.limits.maxBufferSize,
        ) / 256,
      ) * 256;
    const graphProgram = compileSurfaceGraphs(
      captured.surface,
      graphs,
      materialLimit,
    );
    if (graphProgram.bufferCopies.length && !computeSource)
      throw Error(
        (graphProgram.bufferCopies.some((copy) => copy.texture)
          ? "TC_RENDER_TEXTURE_CAPABILITY"
          : "TC_RENDER_BUFFER_CAPABILITY") +
          ": Native fragment slots require a managed compute GPU source.",
      );
    const graphSource = SURFACE_SHADER.replace(
      DEFAULT_SURFACE_GRAPHS,
      graphProgram.source,
    );
    if (graphSource !== this.surfaceShader) {
      await this.createSurfacePipelines(graphSource);
      this.invalidateHistory("material-graphs");
      this.reset = true;
    }
    if (!equal(this.graphRows, graphProgram.rows)) {
      this.invalidateHistory("graph-parameters");
      this.reset = true;
    }
    this.graphRows = graphProgram.rows;
    this.graphMaterials = graphProgram.materials;
    this.graphParameterRows =
      graphProgram.rows.length / 32 -
      graphProgram.bufferCopies.reduce(
        (sum, copy) => sum + Math.ceil(copy.count / 8),
        0,
      );
    await this.updateMedium(captured.surface);
    if (motionEnabled && !this.motionCompute) {
      const pipeline = await withGraphGPUDeadline(
        this.device,
        "TC_TRACE_GRAPH",
        async (active) => {
          active();
          const module = await shader(
            this.device,
            this.surfaceShader + SURFACE_RAY_SHADER + MOTION_SHADER,
            "primary motion reprojection",
          );
          active();
          const pipeline = await this.device.createComputePipelineAsync({
            label: "primary motion reprojection",
            layout: "auto",
            compute: {
              module,
              entryPoint: "motionMain",
              constants: {
                surfacePhysicalEnabled: 1,
                surfaceOrderedTraversal: 0,
              },
            },
          });
          active();
          return pipeline;
        },
      );
      this.active();
      if (generation !== this.contentGeneration)
        throw Error(
          "TC_TRACE_CAPTURE_STALE: Content changed during graph motion pipeline setup.",
        );
      this.motionCompute = pipeline;
    }
    if (motionEnabled && !this.temporal)
      this.temporal = await createTemporalFilter(this.device);
    if (this.disposed || generation !== this.contentGeneration)
      throw new Error(
        "TC_TRACE_CAPTURE_STALE: Content changed during volume pipeline setup.",
      );
    const fragmentPlan = this.prepareFragmentBuffers(
      graphProgram.bufferCopies,
      computeSource,
      captured.surface.materials.length * 128 + graphProgram.rows.byteLength,
    );
    const uploadStart = performance.now();
    this.motionActive = motionEnabled;
    if (motionEnabled) this.ensure("motion", this.width * this.height * 16);
    this.uploadBytes = 0;
    const frame = this.acceleration.update(captured.surface),
      textureChanged =
        this.textures.length !== captured.surface.textures.length ||
        this.textures.some(
          (texture, index) => texture !== captured.surface.textures[index],
        );
    // A failed upload can advance the acceleration without committing this.frame.
    const accelerationOutOfSync = !!this.frame &&
      frame.revision !== this.frame.revision + (frame.changes.kind === "none" ? 0 : 1);
    if (textureChanged || !this.materialData) {
      const resources = packSurfaceResources(captured.surface);
      if (this.frame && frame.changes.kind === "none")
        validateSurfaceTextureCoordinates(captured.surface, frame.orderedTriangles);
      const combined = new Float32Array(
        resources.materials.length + this.graphRows.length,
      );
      combined.set(resources.materials);
      combined.set(this.graphRows, resources.materials.length);
      this.put("materials", combined);
      this.put("textures", resources.textures);
      this.put("texels", resources.texels);
      this.materialData = combined;
      this.textures = captured.surface.textures;
      this.invalidateHistory("textures");
      this.reset = true;
    } else {
      const packedMaterials = packSurfaceMaterialTable(captured.surface);
      const materials = new Float32Array(
        packedMaterials.length + this.graphRows.length,
      );
      materials.set(packedMaterials);
      materials.set(this.graphRows, packedMaterials.length);
      if (!equal(this.materialData, materials)) {
        if (this.frame && frame.changes.kind === "none")
          validateSurfaceTextureCoordinates(captured.surface, frame.orderedTriangles);
        this.put("materials", materials);
        this.materialData = materials;
        this.invalidateHistory("materials");
        this.reset = true;
      }
    }
    this.copyFragmentBuffers(fragmentPlan);
    // A material can become transmissive or opaque without moving triangles.
    // IDs live in the geometry buffer, not the material table.
    if (!this.frame || accelerationOutOfSync || frame.changes.kind !== "none" || this.geometryMediumRevision !== this.mediumRevision) {
      const geometry = packSurfaceGeometry(
          captured.surface,
          frame.orderedTriangles,
          this.mediumIds,
        ),
        traversalNodes = packTraversalData(frame.nodes, geometry);
      this.geometryData = geometry;
      if (!motionEnabled) this.put("triangles", geometry);
      const old = this.buffers.get("nodes"),
        buffer = this.ensure("nodes", traversalNodes.byteLength);
      if (!this.frame || accelerationOutOfSync || !old || old.buffer !== buffer || frame.changes.kind === "rebuild")
        this.put("nodes", traversalNodes);
      else
        for (const range of frame.changes.nodeRanges) {
          this.device.queue.writeBuffer(
            buffer,
            range.offset * 4,
            bytes(
              traversalNodes.subarray(range.offset, range.offset + range.count),
            ),
          );
          this.uploadBytes += range.count * 4;
        }
      if (old?.buffer === buffer && frame.changes.kind !== "rebuild") {
        const tail = traversalNodes.subarray(frame.nodes.length);
        this.device.queue.writeBuffer(
          buffer,
          frame.nodes.byteLength,
          bytes(tail),
        );
        this.uploadBytes += tail.byteLength;
      }
      this.reset = true;
    }
    if (motionEnabled) {
      const motion = packPreviousSurfacePositions(
        this.previousSurface,
        captured.surface,
        frame.orderedTriangles,
      );
      this.motionMatches = { matched: motion.matched, missing: motion.missing };
      const geometry = this.geometryData!;
      const combined = new Float32Array(geometry.length + motion.data.length);
      combined.set(geometry);
      combined.set(motion.data, geometry.length);
      this.put("triangles", combined);
    }
    const lighting = appendEmissiveLights(
      graphEmissiveProposal(captured.surface, graphs),
      frame.orderedTriangles,
      captured.lights,
    );
    this.emissiveCount = lighting.emitters;
    let explicit = 0;
    for (let index = 3; index < captured.lights.length; index += 12)
      if (captured.lights[index] < 2 || captured.lights[index] === 5) explicit++;
    this.lightTechniques =
      explicit +
      (this.emissiveCount ? 1 : 0) +
      (this.environmentIndex >= 0 ? 1 : 0);
    if (!equal(this.lightData, lighting.data)) {
      this.lightData = lighting.data;
      this.lightBufferDirty = true;
      this.reset = true;
    }
    if (lighting.signature !== this.lightingSignature) {
      this.lightingSignature = lighting.signature;
      this.invalidateHistory("lights");
    }
    if (
      this.environment.some(
        (value, index) => value !== captured.environment[index],
      )
    ) {
      this.reset = true;
      this.invalidateHistory("background");
    }
    this.environment = captured.environment;
    this.environmentTexture = captured.environmentTexture;
    // Commit only after all capture uploads have completed; a failed update must retry.
    this.geometryMediumRevision = this.mediumRevision;
    this.frame = frame;
    this.capturedSurface = captured.surface;
    this.lastUploadMs = performance.now() - uploadStart;
    return this.inspect();
  }
  private async updateMedium(surface: SurfaceScene) {
    const generation = this.contentGeneration;
    const materials = new Map(
      surface.materials.map((material) => [material.uuid, material]),
    );
    const keys = new Set(
      surface.triangles
        .filter(
          (triangle) =>
            (materials.get(triangle.materialUuid)?.transmission ?? 0) > 0,
        )
        .map((triangle) =>
          JSON.stringify([triangle.objectUuid, triangle.instanceId]),
        ),
    );
    const faces = surface.triangles.filter((triangle) =>
      keys.has(JSON.stringify([triangle.objectUuid, triangle.instanceId])),
    );
    const signature = JSON.stringify(
      [...new Set(faces.map((face) => face.materialUuid))].map((id) => {
        const material = materials.get(id)!;
        return [
          id,
          material.transmission,
          material.ior,
          material.attenuationColor,
          material.attenuationDistance,
          material.alphaMode,
          material.alphaTest,
        ];
      }),
    );
    if (
      signature !== this.mediumSignature ||
      faces.length !== this.mediumFaces.length ||
      faces.some((triangle, index) => triangle !== this.mediumFaces[index])
    ) {
      const candidate = faces.length ? createMediumCatalog(surface) : undefined;
      this.mediumCatalog?.dispose();
      this.mediumCatalog = candidate;
      this.mediumIds = new Map(
        candidate?.volumes.map((volume) => [volume.key, volume.id]) ?? [],
      );
      this.unsupportedOrthographicMedia = candidate?.volumes.flatMap(volume => {
        const triangles = volume.triangleIndices.map(index => surface.triangles[index]);
        const n = triangles[0].normalMatrix;
        const determinant = n[0] * (n[4] * n[8] - n[5] * n[7]) - n[3] * (n[1] * n[8] - n[2] * n[7]) + n[6] * (n[1] * n[5] - n[2] * n[4]);
        // Existing transport interprets front/back using the authored winding and
        // cannot yet normalize globally inverted shells or alpha-cutout volumes.
        const inverted = volume.worldWinding !== (determinant > 0 ? 1 : -1);
        const filtered = triangles.some(triangle => {
          const material = materials.get(triangle.materialUuid)!;
          return material.alphaMode !== "opaque" || material.alphaTest > 0;
        });
        return inverted || filtered ? [volume.key] : [];
      }) ?? [];
      this.mediumFaces = faces;
      this.mediumSignature = signature;
      this.mediumRevision++;
      this.initialMediaKey = "";
      this.invalidateHistory("medium");
      this.lightBufferDirty = true;
      this.reset = true;
    }
    if (this.mediumIds.size && !this.volumeCompute) {
      const pipeline = await withGraphGPUDeadline(
        this.device,
        "TC_TRACE_GRAPH",
        async (active) => {
          active();
          const pipeline = await this.device.createComputePipelineAsync({
            label: "closed dielectric volume transport",
            layout: "auto",
            compute: {
              module: this.computeModule,
              entryPoint: "pathMain",
              constants: {
                traceVolumeEnabled: 1,
                surfacePhysicalEnabled: 1,
                surfaceOrderedTraversal: 0,
                traceCaptureFault: this.captureFaults ? 1 : 0,
              },
            },
          });
          active();
          return pipeline;
        },
      );
      this.active();
      if (generation !== this.contentGeneration)
        throw Error(
          "TC_TRACE_CAPTURE_STALE: Content changed during graph volume pipeline setup.",
        );
      this.volumeCompute = pipeline;
    }
    const pipeline = this.mediumIds.size
      ? this.volumeCompute!
      : this.opaqueCompute;
    if (pipeline !== this.compute) {
      this.compute = pipeline;
      this.computeGroup = undefined;
    }
  }
  private uploadMedium(camera: THREE.PerspectiveCamera | THREE.OrthographicCamera) {
    const position = camera.getWorldPosition(new THREE.Vector3()).toArray() as [
        number,
        number,
        number,
      ],
      key = JSON.stringify([this.mediumRevision, camera instanceof THREE.OrthographicCamera, ...position]);
    if (key !== this.initialMediaKey) {
      // Orthographic primary rays have distinct origins and are classified on the GPU.
      this.initialMedia = camera instanceof THREE.OrthographicCamera ? [] : (this.mediumCatalog?.initial(position) ?? []);
      if (this.initialMedia.length > 64)
        throw new Error(
          "TC_TRACE_MEDIUM_CAPACITY: Camera starts in more than 64 nested media supported by this pipeline.",
        );
      this.initialMediaKey = key;
      this.lightBufferDirty = true;
    }
    const volumes = this.mediumCatalog?.volumes ?? [],
      base = (this.lightData?.length ?? 0) / 12,
      initialBase = base + volumes.length;
    this.mediumParams = [
      base,
      this.initialMedia.length,
      initialBase,
      volumes.length,
    ];
    if (this.lightBufferDirty) {
      const data = new Float32Array(
        (initialBase + this.initialMedia.length) * 12,
      );
      if (this.lightData) data.set(this.lightData);
      const mediumInfo = this.mediumCatalog?.inspect();
      const parents = new Map(mediumInfo?.nesting.map(item => [item.id, item.parentId]) ?? []);
      const tolerances = new Map(mediumInfo?.tolerance.map(item => [item.id, item.weld]) ?? []);
      for (const volume of volumes)
        data.set([volume.ior, ...volume.sigma, parents.get(volume.id) ?? 0, tolerances.get(volume.id) ?? 0], (base + volume.id - 1) * 12);
      this.initialMedia.forEach((id, index) => {
        data[(initialBase + index) * 12] = id;
      });
      this.put("lights", data);
      this.lightBufferDirty = false;
    }
  }
  private groups() {
    if (!this.computeGroup) {
      this.computeGroup = this.device.createBindGroup({
        layout: this.compute.getBindGroupLayout(0),
        entries: [
          ...(
            [
              "triangles",
              "materials",
              "textures",
              "texels",
              "nodes",
              "lights",
              "pixels",
            ] as const
          ).map((key, binding) => ({
            binding,
            resource: { buffer: this.get(key) },
          })),
          { binding: 7, resource: { buffer: this.uniform } },
          { binding: 8, resource: this.primary.createView() },
          {
            binding: 9,
            resource: { buffer: this.get("environmentImportance") },
          },
        ],
      });
    }
    if (!this.rasterGroup) {
      this.rasterGroup = this.device.createBindGroup({
        layout: this.raster.getBindGroupLayout(0),
        entries: [
          ...(["triangles", "materials", "textures", "texels"] as const).map(
            (key, binding) => ({
              binding,
              resource: { buffer: this.get(key) },
            }),
          ),
          { binding: 7, resource: { buffer: this.uniform } },
        ],
      });
    }
    if (this.motionActive && this.motionCompute && !this.motionGroup) {
      this.motionGroup = this.device.createBindGroup({
        layout: this.motionCompute.getBindGroupLayout(0),
        entries: [
          ...(
            ["triangles", "materials", "textures", "texels", "nodes"] as const
          ).map((key, binding) => ({
            binding,
            resource: { buffer: this.get(key) },
          })),
          { binding: 6, resource: { buffer: this.get("motion") } },
          { binding: 7, resource: { buffer: this.uniform } },
          { binding: 8, resource: this.primary.createView() },
        ],
      });
    }
  }
  async prepareLinearPresentation() {
    this.active();
    if (this.linearPresent) return;
    if (this.linearPresentPending) return this.linearPresentPending;
    this.linearPresentPending = withGraphGPUDeadline(
      this.device,
      "TC_POSTPROCESS",
      async (active) => {
        const module = await shader(
          this.device,
          TRACE_LINEAR_PRESENT_SHADER,
          "linear HDR postprocess handoff",
        );
        active();
        this.active();
        const pipeline = await this.device.createRenderPipelineAsync({
          layout: "auto",
          vertex: { module, entryPoint: "vertex" },
          fragment: {
            module,
            entryPoint: "fragment",
            targets: [
              { format: "rgba16float" },
              { format: "rgba16float" },
              { format: "rgba16float" },
            ],
          },
          primitive: { topology: "triangle-list" },
        });
        active();
        this.active();
        return pipeline;
      },
    ).then((pipeline) => {
      this.active();
      this.linearPresent = pipeline;
    }).finally(() => {
      this.linearPresentPending = undefined;
    });
    return this.linearPresentPending;
  }
  render(
    camera: THREE.PerspectiveCamera | THREE.OrthographicCamera,
    settings: Readonly<RenderSettings>,
    targets?: TracePresentationTargets,
  ) {
    this.active();
    if (targets) {
      if (!this.linearPresent)
        throw new Error(
          "TC_POSTPROCESS_NOT_READY: Prepare the linear HDR presentation pipeline before rendering.",
        );
      for (const texture of [targets.color, targets.normal, targets.depth])
        if (
          texture.width !== this.width ||
          texture.height !== this.height ||
          texture.format !== "rgba16float" ||
          !(texture.usage & GPUTextureUsage.RENDER_ATTACHMENT)
        )
          throw new Error(
            "TC_POSTPROCESS_TARGET: Linear HDR targets must match the frame size and rgba16float render-attachment format.",
          );
    }
    if (!this.frame)
      throw new Error(
        "TC_TRACE_SCENE: Capture the current scene before rendering.",
      );
    const orthographic = camera instanceof THREE.OrthographicCamera;
    if (orthographic && this.unsupportedOrthographicMedia.length)
      throw new Error(`TC_TRACE_ORTHOGRAPHIC_MEDIA_UNSUPPORTED: Orthographic volume transport requires outward-authored closed shells without alpha filtering; unsupported object(s): ${this.unsupportedOrthographicMedia.join(", ")}.`);
    const started = performance.now();
    camera.updateWorldMatrix(true, false);
    this.uploadMedium(camera);
    const forward = new THREE.Vector3();
    camera.getWorldDirection(forward);
    const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0),
      up = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1),
      cameraOrigin = camera.getWorldPosition(new THREE.Vector3());
    if (camera instanceof THREE.OrthographicCamera) {
      cameraOrigin.addScaledVector(right, (camera.left + camera.right) / 2)
        .addScaledVector(up, (camera.top + camera.bottom) / 2);
      right.multiplyScalar((camera.right - camera.left) / (2 * camera.zoom));
      up.multiplyScalar((camera.top - camera.bottom) / (2 * camera.zoom));
    } else {
      const spread = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
      right.multiplyScalar(spread * camera.aspect);
      up.multiplyScalar(spread);
    }
    const viewProjection = camera.projectionMatrix
        .clone()
        .multiply(camera.matrixWorldInverse),
      cameraKey = JSON.stringify([
        ...camera.matrixWorld.elements,
        ...camera.projectionMatrix.elements,
      ]),
      settingsKey = JSON.stringify(settings);
    if (cameraKey !== this.cameraKey) this.reset = true;
    if (settingsKey !== this.settingsKey) {
      this.reset = true;
      this.invalidateHistory("settings");
    }
    this.cameraKey = cameraKey;
    this.settingsKey = settingsKey;
    const jitterX = settings.mode === "hybrid" ? halton(this.serial + 1, 2) : 0,
      jitterY = settings.mode === "hybrid" ? halton(this.serial + 1, 3) : 0;
    if (settings.mode === "hybrid") {
      const projection = camera.projectionMatrix.clone();
      if (orthographic) {
        projection.elements[12] -= (2 * jitterX) / this.width;
        projection.elements[13] += (2 * jitterY) / this.height;
      } else {
        projection.elements[8] += (2 * jitterX) / this.width;
        projection.elements[9] -= (2 * jitterY) / this.height;
      }
      viewProjection.copy(projection.multiply(camera.matrixWorldInverse));
    }
    if (this.reset) {
      this.samples = 0;
      this.resets++;
    }
    const params = new Float32Array(TRACE_PARAMETER_FLOATS);
    params.set([
      ...cameraOrigin.toArray(),
      this.lightTechniques,
      ...forward.toArray(),
      jitterX,
      ...right.toArray(),
      jitterY,
      ...up.toArray(),
      this.emissiveCount ? 1 : 0,
      ...this.environment,
      this.backgroundIndex + 1,
      this.width,
      this.height,
      this.serial++,
      camera.near,
      this.frame.metrics.nodes,
      this.frame.metrics.triangles,
      (this.lightData?.length ?? 0) / 12,
      this.reset ? 1 : 0,
      settings.exposure,
      settings.samplesPerFrame,
      settings.maxBounces,
      camera.far,
      settings.mode === "hybrid" ? 1 : 0,
      ["beauty", "albedo", "normal", "depth", "samples"].indexOf(
        settings.debug,
      ),
      settings.directLighting ? 1 : 0,
      settings.indirectLighting ? 1 : 0,
      ...viewProjection.elements,
      this.environmentIndex,
      this.environmentIntensity,
      this.environmentProposal?.width ?? 0,
      this.environmentProposal?.height ?? 0,
      this.environmentRotation.elements[0],
      this.environmentRotation.elements[1],
      this.environmentRotation.elements[2],
      this.captureFaults ? this.faultTarget : -1,
      this.environmentRotation.elements[4],
      this.environmentRotation.elements[5],
      this.environmentRotation.elements[6],
      this.captureFaults ? this.faultSample : 0,
      this.environmentRotation.elements[8],
      this.environmentRotation.elements[9],
      this.environmentRotation.elements[10],
      this.mediumCatalog?.inspect().tolerance.reduce((maximum, item) => Math.max(maximum, item.weld), 0) ?? 0,
      ...this.mediumParams,
      ...this.previousViewProjection.elements,
      ...this.previousCameraOrigin.toArray(),
      this.previousCameraValid ? 1 : 0,
      this.backgroundIntensity,
      Math.cos(this.backgroundRotation),
      Math.sin(this.backgroundRotation),
      orthographic ? 1 : 0,
    ]);
    this.device.queue.writeBuffer(this.uniform, 0, params);
    this.groups();
    const encoder = this.device.createCommandEncoder({
      label: "pelican surface frame",
    });
    if (settings.mode === "hybrid") {
      const pass = encoder.beginRenderPass({
        label: "raster primary visibility",
        ...(this.timestamps
          ? {
              timestampWrites: {
                querySet: this.timestamps,
                beginningOfPassWriteIndex: 0,
                endOfPassWriteIndex: 1,
              },
            }
          : {}),
        colorAttachments: [
          {
            view: this.primary.createView(),
            loadOp: "clear",
            storeOp: "store",
            clearValue: { r: -1, g: -1, b: 0, a: 0 },
          },
        ],
        depthStencilAttachment: {
          view: this.depth.createView(),
          depthLoadOp: "clear",
          depthStoreOp: "store",
          depthClearValue: 1,
        },
      });
      pass.setPipeline(this.raster);
      pass.setBindGroup(0, this.rasterGroup!);
      pass.draw(this.frame.metrics.triangles * 3);
      pass.end();
    }
    const pass = encoder.beginComputePass({
      label: "surface light transport",
      ...(this.timestamps
        ? {
            timestampWrites: {
              querySet: this.timestamps,
              beginningOfPassWriteIndex: 2,
              endOfPassWriteIndex: 3,
            },
          }
        : {}),
    });
    pass.setPipeline(this.compute);
    pass.setBindGroup(0, this.computeGroup!);
    pass.dispatchWorkgroups(
      Math.ceil(this.width / 8),
      Math.ceil(this.height / 8),
    );
    pass.end();
    this.lastMotionComputed = this.motionActive && this.reset;
    if (this.lastMotionComputed) {
      const motion = encoder.beginComputePass({
        label: "primary motion reprojection",
      });
      motion.setPipeline(this.motionCompute!);
      motion.setBindGroup(0, this.motionGroup!);
      motion.dispatchWorkgroups(
        Math.ceil(this.width / 8),
        Math.ceil(this.height / 8),
      );
      motion.end();
      this.motionPasses++;
    }
    const planeBytes = this.width * this.height * 16;
    encoder.copyBufferToBuffer(
      this.get("pixels"),
      planeBytes + 16,
      this.get("average"),
      0,
      planeBytes,
    );
    encoder.copyBufferToBuffer(
      this.get("pixels"),
      planeBytes * 2 + 16,
      this.get("normalDepth"),
      0,
      planeBytes,
    );
    encoder.copyBufferToBuffer(
      this.get("pixels"),
      planeBytes * 3 + 16,
      this.get("albedo"),
      0,
      planeBytes,
    );
    this.lastTemporalReset = this.temporalHistoryReset;
    this.lastTemporalProgressive = !this.reset;
    this.lastTemporalReasons = [...this.temporalResetReasons];
    const temporalOutput =
      this.temporal?.encode(
        encoder,
        this.get("average"),
        this.get("normalDepth"),
        this.get("albedo"),
        this.get("motion"),
        this.width,
        this.height,
        {
          enabled: this.motionActive,
          reset: this.temporalHistoryReset,
          progressive: !this.reset,
        },
      ) ?? this.get("average");
    this.temporalOutput = this.motionActive ? temporalOutput : undefined;
    if (this.motionActive && this.temporalHistoryReset) this.temporalResets++;
    const output = this.denoiser.encode(
      encoder,
      temporalOutput,
      this.get("normalDepth"),
      this.get("albedo"),
      this.width,
      this.height,
      {
        enabled: settings.denoise && settings.debug === "beauty",
        iterations: settings.denoiseIterations,
      },
    );
    this.device.queue.writeBuffer(
      this.presentUniform,
      0,
      new Float32Array([
        this.width,
        this.height,
        settings.exposure,
        settings.debug === "beauty" ? 0 : 1,
      ]),
    );
    const presentationPipeline = targets ? this.linearPresent! : this.present;
    const display = this.device.createBindGroup({
      layout: presentationPipeline.getBindGroupLayout(0),
      entries: targets
        ? [
            { binding: 0, resource: { buffer: output } },
            { binding: 1, resource: { buffer: this.get("normalDepth") } },
            { binding: 2, resource: { buffer: this.presentUniform } },
          ]
        : [
            { binding: 0, resource: { buffer: output } },
            { binding: 1, resource: { buffer: this.presentUniform } },
          ],
    });
    const present = encoder.beginRenderPass({
      label: "surface image output",
      ...(this.timestamps
        ? {
            timestampWrites: {
              querySet: this.timestamps,
              beginningOfPassWriteIndex: 4,
              endOfPassWriteIndex: 5,
            },
          }
        : {}),
      colorAttachments: targets
        ? [targets.color, targets.normal, targets.depth].map((texture) => ({
            view: texture.createView(),
            loadOp: "clear" as const,
            storeOp: "store" as const,
            clearValue: { r: 0, g: 0, b: 0, a: 0 },
          }))
        : [
            {
              view: this.context.getCurrentTexture().createView(),
              loadOp: "clear",
              storeOp: "store",
              clearValue: { r: 0, g: 0, b: 0, a: 1 },
            },
          ],
    });
    present.setPipeline(presentationPipeline);
    present.setBindGroup(0, display);
    present.draw(3);
    present.end();
    if (this.timestamps && this.timingResolve)
      encoder.resolveQuerySet(this.timestamps, 0, 6, this.timingResolve, 0);
    this.device.queue.submit([encoder.finish()]);
    this.previousViewProjection.copy(viewProjection);
    this.previousCameraOrigin.copy(cameraOrigin);
    this.previousCameraValid = true;
    this.previousSurface = this.capturedSurface;
    this.temporalHistoryReset = false;
    this.temporalResetReasons.clear();
    this.timingStart = settings.mode === "hybrid" ? 0 : 2;
    this.output = output;
    this.scheduleMediumCheck();
    this.samples += settings.samplesPerFrame;
    this.reset = false;
    this.lastSubmitMs = performance.now() - started;
    return this.lastSubmitMs;
  }
  private async readPlane(source: GPUBuffer) {
    const size = this.width * this.height * 16;
    const read = this.device.createBuffer({
      size,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    try {
      const encoder = this.device.createCommandEncoder();
      encoder.copyBufferToBuffer(source, 0, read, 0, size);
      this.device.queue.submit([encoder.finish()]);
      await read.mapAsync(GPUMapMode.READ);
      const result = new Float32Array(read.getMappedRange().slice(0));
      read.unmap();
      return result;
    } finally {
      read.destroy();
    }
  }
  async readPrimaryStats() {
    this.active();
    if (!this.frame) throw new Error("TC_TRACE_PRIMARY_NOT_READY");
    const serial = this.serial - 1,
      generation = this.contentGeneration;
    const rowBytes = Math.ceil((this.width * 16) / 256) * 256;
    const read = this.device.createBuffer({
      size: rowBytes * this.height,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    try {
      const encoder = this.device.createCommandEncoder();
      encoder.copyTextureToBuffer(
        { texture: this.primary },
        { buffer: read, bytesPerRow: rowBytes },
        [this.width, this.height],
      );
      this.device.queue.submit([encoder.finish()]);
      await read.mapAsync(GPUMapMode.READ);
      if (generation !== this.contentGeneration || serial !== this.serial - 1)
        throw new Error(
          "TC_TRACE_READBACK_STALE: Pause before inspecting primary refinement counts.",
        );
      const mapped = read.getMappedRange();
      let hits = 0,
        misses = 0,
        refinements = 0;
      for (let y = 0; y < this.height; y++) {
        const row = new Float32Array(mapped, y * rowBytes, this.width * 4);
        for (let x = 0; x < this.width; x++) {
          const id = row[x * 4 + 1];
          if (!Number.isInteger(id) || id < -2)
            throw new Error(
              "TC_TRACE_PRIMARY_DATA: Invalid visibility identifier.",
            );
          if (id === -2) refinements++;
          else if (id === -1) misses++;
          else hits++;
        }
      }
      read.unmap();
      return {
        pixels: this.width * this.height,
        hits,
        misses,
        refinements,
        frameSerial: serial,
      };
    } finally {
      read.destroy();
    }
  }
  async readGuides() {
    this.active();
    const [normalDepth, albedoRoughness] = await Promise.all([
      this.readPlane(this.get("normalDepth")),
      this.readPlane(this.get("albedo")),
    ]);
    return { normalDepth, albedoRoughness };
  }
  async readTemporal() {
    this.active();
    if (!this.temporalOutput)
      throw new Error(
        "TC_TEMPORAL_NOT_ACTIVE: Enable denoising and render a frame first.",
      );
    return this.readPlane(this.temporalOutput);
  }
  /** Development readback; progressive static frames deliberately do not recompute motion. */
  async readMotion() {
    this.active();
    if (!this.motionActive || !this.lastMotionComputed)
      throw new Error(
        "TC_MOTION_NOT_CURRENT: Motion is available only after an independent denoised frame, not a progressive accumulation frame.",
      );
    return this.readPlane(this.get("motion"));
  }
  async pixels() {
    await this.mediumFaultCheck;
    await this.scheduleMediumCheck();
    if (this.mediumFault) throw this.mediumFault;
    const data = await this.readRadiance();
    let nonBlack = 0,
      finite = true,
      sum = 0,
      maximum = 0;
    for (let index = 0; index < data.length; index += 4) {
      const rgb = data.subarray(index, index + 3);
      if (rgb.some((value) => !Number.isFinite(value))) finite = false;
      const luminance = rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
      sum += luminance;
      if (luminance > 1e-5) nonBlack++;
      maximum = Math.max(maximum, ...rgb);
    }
    return {
      backend: "webgpu",
      nonBlack,
      finite,
      meanLuminance: sum / (this.width * this.height),
      maximum,
      samples: this.samples,
      frameSerial: this.serial - 1,
    };
  }
  private scheduleMediumCheck() {
    if (this.mediumFaultBusy || this.disposed || this.lost)
      return this.mediumFaultCheck;
    this.mediumFaultBusy = true;
    const generation = this.contentGeneration;
    this.mediumFaultCheck = (async () => {
      const read = this.device.createBuffer({
        size: this.captureFaults ? 16 + FAULT_DEBUG_BYTES : 16,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      });
      try {
        const encoder = this.device.createCommandEncoder();
        encoder.copyBufferToBuffer(this.get("pixels"), 0, read, 0, 16);
        if (this.captureFaults)
          encoder.copyBufferToBuffer(
            this.get("pixels"),
            this.width * this.height * 64 + 16,
            read,
            16,
            FAULT_DEBUG_BYTES,
          );
        this.device.queue.submit([encoder.finish()]);
        await read.mapAsync(GPUMapMode.READ);
        const mapped = read.getMappedRange();
        const values = new Uint32Array(mapped);
        const faults = values[0],
          mask = values[1],
          detail = values[2],
          pixel = values[3];
        const debug = this.captureFaults
          ? Array.from(new Float32Array(mapped).slice(4))
          : [];
        read.unmap();
        if (this.disposed || this.lost || generation !== this.contentGeneration)
          return;
        if (faults) {
          this.mediumFaults = faults;
          if (debug[23] === 1) {
            const origin = debug.slice(0, 3) as [number, number, number],
              direction = debug.slice(4, 7) as [number, number, number];
            let cpuHit: unknown;
            try {
              cpuHit = this.acceleration.intersect(origin, direction);
            } catch (error) {
              cpuHit = { error: String(error) };
            }
            const history =
              debug[48] === debug[19] &&
              debug[49] === debug[21] &&
              debug[51] === debug[22]
                ? Array.from({ length: Math.min(debug[50], 8) }, (_, index) => {
                    const at = 52 + index * 32;
                    return {
                      bounce: index,
                      origin: debug.slice(at, at + 3),
                      triangle: debug[at + 3],
                      direction: debug.slice(at + 4, at + 7),
                      distance: debug[at + 7],
                      mediumDepth: debug[at + 8],
                      medium: debug[at + 9],
                      front: debug[at + 10],
                      boundary: debug[at + 11],
                      position: debug.slice(at + 12, at + 15),
                      roughness: debug[at + 15],
                      scattered: debug.slice(at + 16, at + 19),
                      event: debug[at + 19],
                      geometric: debug.slice(at + 20, at + 23),
                      pdf: debug[at + 23],
                      barycentric: debug.slice(at + 24, at + 27),
                      iorInside: debug[at + 27],
                      normal: debug.slice(at + 28, at + 31),
                      iorOutside: debug[at + 31],
                    };
                  })
                : null;
            const source =
              debug[21] === this.serial - 1
                ? this.frame?.orderedTriangles[debug[11]]
                : undefined;
            const material =
              source &&
              this.capturedSurface?.materials.find(
                (material) => material.uuid === source.materialUuid,
              );
            this.mediumDebug = {
              origin,
              direction,
              bounce: debug[3],
              medium: debug[7],
              previousPosition: debug.slice(8, 11),
              previousHit: debug[11],
              previousGeometric: debug.slice(12, 15),
              previousEvent: debug[15],
              previousBary: debug.slice(16, 19),
              pixel: debug[19],
              previousFront: debug[20],
              frame: debug[21],
              sample: debug[22],
              gpuTriangle: [
                debug.slice(24, 28),
                debug.slice(28, 32),
                debug.slice(32, 36),
              ],
              physical: debug.slice(36, 40),
              normalMatrixRecords: debug.slice(40, 48),
              cpuHit,
              cpuFrame: this.serial - 1,
              source: source && {
                objectUuid: source.objectUuid,
                geometryUuid: source.geometryUuid,
                instanceId: source.instanceId,
                materialUuid: source.materialUuid,
                materialName: material?.name,
              },
              history,
              historyTruncated: debug[3] >= 8,
            };
          }
          throw new Error(
            "TC_TRACE_MEDIUM_STATE: GPU recorded " +
              faults +
              " invalid boundary/order/capacity transitions (mask=" +
              mask +
              "; detail=" +
              detail +
              ",pixel=" +
              pixel +
              "; 1=missing volume, 2=boundary order/duplicate entry, 4=miss inside, 8=capacity, 16=origin near boundary, 32=ambiguous initial classification)." +
              (this.mediumDebug
                ? " debug=" + JSON.stringify(this.mediumDebug)
                : ""),
          );
        }
      } finally {
        read.destroy();
      }
    })()
      .catch((cause) => {
        if (this.disposed || this.lost || generation !== this.contentGeneration)
          return;
        this.mediumFault =
          cause instanceof Error ? cause : new Error(String(cause));
        this.onFault?.(this.mediumFault);
      })
      .finally(() => {
        this.mediumFaultBusy = false;
      });
    return this.mediumFaultCheck;
  }
  /** Private validation readback. Pixel radiance is not exposed to game code. */
  async readRadiance(filtered = true) {
    this.active();
    const size = this.width * this.height * 16,
      read = this.device.createBuffer({
        size,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      });
    try {
      const encoder = this.device.createCommandEncoder();
      encoder.copyBufferToBuffer(
        filtered ? (this.output ?? this.get("average")) : this.get("average"),
        0,
        read,
        0,
        size,
      );
      this.device.queue.submit([encoder.finish()]);
      await read.mapAsync(GPUMapMode.READ);
      const data = new Float32Array(read.getMappedRange().slice(0));
      read.unmap();
      return data;
    } finally {
      read.destroy();
    }
  }
  async gpuTimeMs() {
    this.active();
    if (!this.timingResolve) return null;
    const read = this.device.createBuffer({
      size: 48,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    try {
      const encoder = this.device.createCommandEncoder();
      encoder.copyBufferToBuffer(this.timingResolve, 0, read, 0, 48);
      this.device.queue.submit([encoder.finish()]);
      await read.mapAsync(GPUMapMode.READ);
      const values = new BigUint64Array(read.getMappedRange().slice(0));
      read.unmap();
      return {
        frameMs: Number(values[5] - values[this.timingStart]) / 1e6,
        transportMs: Number(values[3] - values[2]) / 1e6,
        presentMs: Number(values[5] - values[4]) / 1e6,
        primaryMs:
          this.timingStart === 0 ? Number(values[1] - values[0]) / 1e6 : null,
        source: "timestamp-query",
      };
    } finally {
      read.destroy();
    }
  }
  queryRay(origin: number[], direction: number[]) {
    this.active();
    const hit = this.acceleration.intersect(
      origin as [number, number, number],
      direction as [number, number, number],
    );
    return {
      backend: "cpu-surface-query",
      distance: hit?.distance ?? -1,
      index: hit?.triangleIndex ?? -1,
      normal: hit?.normal ?? [0, 0, 0],
    };
  }
  inspect() {
    return {
      disposed: this.disposed,
      lost: this.lost,
      backend: "webgpu",
      width: this.width,
      height: this.height,
      triangleCount: this.frame?.metrics.triangles ?? 0,
      nodeCount: this.frame?.metrics.nodes ?? 0,
      samples: this.samples,
      frameSerial: this.serial - 1,
      mediumFaults: this.mediumFaults,
      historyResets: this.resets,
      contentGeneration: this.contentGeneration,
      volumeTransport: {
        volumes: this.mediumIds.size,
        initialMedia: [...this.initialMedia],
        catalog: this.mediumCatalog?.inspect(),
        faults: this.mediumFaults,
        debug: this.mediumDebug,
      },
      acceleration: this.frame && {
        revision: this.frame.revision,
        topologyRevision: this.frame.topologyRevision,
        changes: this.frame.changes,
        metrics: this.frame.metrics,
      },
      capture: this.capture.inspect(),
      uploadBytes: this.uploadBytes,
      captureMs: this.lastCaptureMs,
      uploadMs: this.lastUploadMs,
      submitMs: this.lastSubmitMs,
      ownedBytes: [...this.buffers.values()].reduce(
        (sum, entry) => sum + entry.bytes,
        0,
      ),
      denoiser: this.denoiser?.inspect(),
      materialGraphs: {
        materials: this.graphMaterials,
        parameterRows: this.graphParameterRows,
        bufferSlots: {
          slots: [...this.fragmentBuffers.values()].filter(
            (slot) => !slot.texture,
          ).length,
          gpuCopies: this.fragmentGpuCopies,
          gpuCopyBytes: this.fragmentGpuCopyBytes,
          cpuResultUploads: 0,
          bindings: [...this.fragmentBuffers.values()]
            .filter((slot) => !slot.texture)
            .map((slot) => ({
              material: slot.material,
              name: slot.name,
              type: slot.type,
              count: slot.count,
              key: slot.key,
              revision: slot.revision,
              byteOffset: slot.byteOffset,
            })),
        },
        textureSlots: {
          slots: [...this.fragmentBuffers.values()].filter(
            (slot) => slot.texture,
          ).length,
          gpuCopies: this.textureGpuCopies,
          gpuCopyBytes: this.textureGpuCopyBytes,
          cpuResultUploads: 0,
          bindings: [...this.fragmentBuffers.values()]
            .filter((slot) => slot.texture)
            .map((slot) => ({
              material: slot.material,
              name: slot.name,
              type: slot.type,
              count: slot.count,
              key: slot.key,
              revision: slot.revision,
              byteOffset: slot.byteOffset,
              width: slot.texture!.width,
              height: slot.texture!.height,
            })),
        },
      },
      motion: {
        enabled: this.motionActive,
        lastComputed: this.lastMotionComputed,
        passes: this.motionPasses,
        ...this.motionMatches,
      },
      temporal: this.temporal && {
        ...this.temporal.inspect(),
        lastReset: this.lastTemporalReset,
        lastProgressive: this.lastTemporalProgressive,
        resetReasons: [...this.lastTemporalReasons],
        historyResets: this.temporalResets,
      },
      gpuTiming: this.timestamps
        ? "timestamp-query; call gpuTimeMs for readback"
        : "unavailable: adapter timestamp-query not enabled",
      environment: {
        index: this.environmentIndex,
        intensity: this.environmentIntensity,
        source: this.environmentSource?.uuid ?? null,
        capture: this.environmentCapture?.inspect(),
      },
      limitations: [
        "Opaque GGX, supported lights/environment MIS and closed dielectric transport are integrated; full physical/lighting quality matrix remains unaccepted.",
        "CPU surface extraction and BVH refit feed WebGPU traversal. This is not GPU refit or hardware ray tracing.",
        "Motion reprojection and temporal history filtering are development integrations; complete dynamic/ghosting/physical quality matrices remain unaccepted.",
      ],
      memoryScope:
        "ownedBytes covers tracer storage buffers only. temporal.bytes and denoiser.bytes are additional owned buffers; tracer uniforms, targets, Three resources and CPU caches are separate.",
    };
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.clearFragmentBuffers();
    this.capture.dispose();
    this.mediumCatalog?.dispose();
    this.mediumCatalog = undefined;
    this.mediumFaces = [];
    this.mediumIds.clear();
    this.environmentCapture?.dispose();
    this.environmentCache.dispose();
    this.environmentImage?.dispose();
    this.acceleration.dispose();
    this.denoiser?.dispose();
    this.temporal?.dispose();
    this.temporalOutput = undefined;
    this.previousSurface = undefined;
    this.capturedSurface = undefined;
    this.geometryData = undefined;
    for (const entry of this.buffers.values()) entry.buffer.destroy();
    this.buffers.clear();
    this.uniform?.destroy();
    this.presentUniform?.destroy();
    this.primary?.destroy();
    this.depth?.destroy();
    this.timestamps?.destroy();
    this.timingResolve?.destroy();
    if (contextOwners.get(this.canvas) === this) {
      this.context?.unconfigure();
      contextOwners.delete(this.canvas);
    }
  }
}
