import type {
  ComputeExecutionInput,
  ComputeExecutionRequest,
  ComputeExecutor,
} from "../../runtime/src/compute-contract.ts";
import type {
  ComputeTextureBinding,
  GraphType,
  GraphValue,
} from "../../sdk/src/index.ts";
import { graphValue, isGraphType } from "../../sdk/src/graph-values.ts";
import type {
  ComputeGpuView,
  ComputeResidentSource,
  ComputeTextureResidentSource,
} from "./compute-view-contract.ts";
import { lowerGraphWGSL } from "./graph-expressions.ts";

const DEADLINE_MS = 10_000;
// Every exposed index and array length must be represented exactly by f32.
const MAX_COUNT = 2 ** 24;
const own = (value: object, name: string) => Object.hasOwn(value, name);
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const error = (code: string, detail: string) =>
  Error("TC_COMPUTE_" + code + ": " + detail);
function requireThat(
  value: unknown,
  code: string,
  detail: string,
): asserts value {
  if (!value) throw error(code, detail);
}
const width = (type: GraphType) =>
  type.startsWith("vec") ? Number(type[3]) : 1;
const unpack = (symbol: string, type: GraphType) =>
  type === "bool"
    ? "(" + symbol + ".x != 0.0)"
    : symbol + "." + "xyzw".slice(0, width(type));
const packedResult = (symbol: string, type: GraphType) =>
  type === "bool"
    ? "vec4f(select(0.0, 1.0, " + symbol + "), 0.0, 0.0, 0.0)"
    : type === "float"
      ? "vec4f(" + symbol + ", 0.0, 0.0, 0.0)"
      : type === "vec2"
        ? "vec4f(" + symbol + ", 0.0, 0.0)"
        : type === "vec3"
          ? "vec4f(" + symbol + ", 0.0)"
          : symbol;

function put(
  data: Float32Array,
  offset: number,
  type: GraphType,
  value: unknown,
  code: string,
): void {
  const checked = graphValue(type, value);
  requireThat(checked !== null, code, "Expected a finite " + type + " value.");
  if (typeof checked === "number" || typeof checked === "boolean")
    data[offset] = Number(checked);
  else data.set(checked, offset);
}
function same(a: Float32Array, b: Float32Array): boolean {
  const aa = new Uint32Array(a.buffer, a.byteOffset, a.length);
  const bb = new Uint32Array(b.buffer, b.byteOffset, b.length);
  return aa.length === bb.length && aa.every((n, i) => n === bb[i]);
}
// rgba32float is deliberately unfilterable: filtering and addressing use textureLoad.
function textureHelper(
  i: number,
  binding: number,
  declaration: ComputeTextureBinding,
): string {
  const normalize = (value: string, wrap = "clamp") =>
    wrap === "repeat"
      ? `(${value} - floor(${value}))`
      : wrap === "mirror"
        ? `(1.0 - abs((${value} - 2.0 * floor(${value} * 0.5)) - 1.0))`
        : `clamp(${value}, 0.0, 1.0)`;
  const address = (axis: string, wrap = "clamp") => {
    const index = `index.${axis}`,
      size = `size.${axis}`;
    if (wrap === "clamp") return `clamp(${index}, 0, ${size} - 1)`;
    const period = wrap === "mirror" ? `(2 * ${size})` : size;
    const mod = `((${index} % ${period} + ${period}) % ${period})`;
    return wrap === "mirror" ? `min(${mod}, 2 * ${size} - 1 - ${mod})` : mod;
  };
  return [
    `@group(0) @binding(${binding}) var tc_texture_${i}: texture_2d<f32>;`,
    `fn tc_load_${i}(index: vec2i, size: vec2i) -> vec4f {`,
    `  let coord = vec2i(${address("x", declaration.wrapU)}, ${address("y", declaration.wrapV)});`,
    `  return textureLoad(tc_texture_${i}, coord, 0);`,
    `}`,
    `fn tc_sample_${i}(uv: vec2f) -> vec4f {`,
    `  if (any((bitcast<vec2u>(uv) & vec2u(0x7f800000u)) == vec2u(0x7f800000u))) {`,
    `    atomicOr(&tc_fault, 4u);`,
    `    return vec4f(0.0);`,
    `  }`,
    // Normalize finite UVs before multiplying or converting to i32, including huge f32 values.
    `  let addressed = vec2f(${normalize("uv.x", declaration.wrapU)}, ${normalize("uv.y", declaration.wrapV)});`,
    `  let size = vec2i(textureDimensions(tc_texture_${i}, 0));`,
    ...(declaration.filter === "nearest"
      ? [`  return tc_load_${i}(vec2i(floor(addressed * vec2f(size))), size);`]
      : [
          `  let pixel = addressed * vec2f(size) - vec2f(0.5);`,
          `  let base = vec2i(floor(pixel));`,
          `  let weight = fract(pixel);`,
          `  let top = mix(tc_load_${i}(base, size), tc_load_${i}(base + vec2i(1, 0), size), weight.x);`,
          `  let bottom = mix(tc_load_${i}(base + vec2i(0, 1), size), tc_load_${i}(base + vec2i(1, 1), size), weight.x);`,
          `  return mix(top, bottom, weight.y);`,
        ]),
    `}`,
  ].join("\n");
}

interface TextureShape {
  width: number;
  height: number;
}
const sameShape = (a?: TextureShape, b?: TextureShape) =>
  a?.width === b?.width && a?.height === b?.height;

interface InputSnapshot {
  name: string;
  key: string;
  type: GraphType;
  revision: number;
  data: Float32Array;
  texture?: Readonly<TextureShape>;
  captured?: true;
}
interface CachedInput extends Omit<InputSnapshot, "name"> {
  buffer: GPUBuffer;
  gpuTexture?: GPUTexture;
}

interface PendingOutput extends Omit<CachedInput, "revision"> {
  signal: AbortSignal;
  abort(): void;
  minimumRevision: number;
}

/** Private renderer driver. Only the runtime owner commits the returned values. */
export function createComputeExecutor(device: GPUDevice): ComputeExecutor &
  ComputeResidentSource &
  ComputeTextureResidentSource &
  Required<Pick<ComputeExecutor, "commit" | "discard" | "collect">> & {
    inspect(): Readonly<{
      cachedInputs: number;
      pendingCandidates: number;
      committedVersions: number;
      residentBytes: number;
      retentions: number;
      commits: number;
      residentHits: number;
      inputCacheHits: number;
      inputUploads: number;
      checkpointUploads: number;
      cachedPipelines: number;
      cachedBytes: number;
      liveBuffers: number;
      liveTextures: number;
      textureUploads: number;
      textureResidentHits: number;
      storageTextureDispatches: number;
      allocations: number;
      uploads: number;
      dispatches: number;
      active: boolean;
      disposed: boolean;
      deviceLost: boolean;
    }>;
  } {
  const cache = new Map<string, CachedInput>();
  const pending = new Map<string, PendingOutput>();
  const committed = new Map<string, Map<number, CachedInput>>();
  // Keep the highest CPU checkpoint/commit metadata when a captured older input replaces the upload cache.
  const highWater = new Map<
    string,
    Omit<InputSnapshot, "name"> & { computed?: true }
  >();
  const remember = (snapshot: Omit<InputSnapshot, "name">, computed?: true) => {
    if (snapshot.revision > (highWater.get(snapshot.key)?.revision ?? -1))
      highWater.set(snapshot.key, {
        key: snapshot.key,
        type: snapshot.type,
        revision: snapshot.revision,
        data: snapshot.data,
        texture: snapshot.texture,
        computed,
      });
  };
  const pipelines = new Map<string, GPUComputePipeline>();
  const owned = new Set<GPUBuffer>();
  const ownedTextures = new Set<GPUTexture>();
  let disposed = false,
    lost = false,
    allocations = 0,
    uploads = 0,
    dispatches = 0,
    retentions = 0,
    commits = 0,
    residentHits = 0,
    inputCacheHits = 0,
    inputUploads = 0,
    checkpointUploads = 0,
    textureUploads = 0,
    textureResidentHits = 0,
    storageTextureDispatches = 0;
  let running: { keys: Set<string>; stop(reason: Error): void } | undefined;
  const destroy = (resource: GPUBuffer | GPUTexture) => {
    if (
      owned.delete(resource as GPUBuffer) ||
      ownedTextures.delete(resource as GPUTexture)
    )
      resource.destroy();
  };
  const destroyEntry = (entry: CachedInput | PendingOutput) => {
    destroy(entry.buffer);
    if (entry.gpuTexture) destroy(entry.gpuTexture);
  };
  const evict = (key: string) => {
    const entry = cache.get(key);
    if (entry) {
      cache.delete(key);
      destroyEntry(entry);
    }
  };
  const discard = (key: string) => {
    const candidate = pending.get(key);
    if (candidate) {
      pending.delete(key);
      candidate.signal.removeEventListener("abort", candidate.abort);
      destroyEntry(candidate);
    }
  };
  const releaseVersions = (key: string) => {
    const versions = committed.get(key);
    committed.delete(key);
    if (versions) for (const entry of versions.values()) destroyEntry(entry);
  };
  const clear = () => {
    for (const key of pending.keys()) discard(key);
    for (const key of committed.keys()) releaseVersions(key);
    for (const key of cache.keys()) evict(key);
    pipelines.clear();
    highWater.clear();
    for (const buffer of owned) destroy(buffer);
    for (const texture of ownedTextures) destroy(texture);
  };
  const available = () => {
    requireThat(
      !disposed,
      "DISPOSED",
      "The compute executor has been disposed.",
    );
    requireThat(!lost, "DEVICE_LOST", "The compute device was lost.");
  };
  const latest = (key: string) => {
    let entry: Omit<InputSnapshot, "name"> | undefined = highWater.get(key);
    const cached = cache.get(key);
    if (cached && (!entry || cached.revision > entry.revision)) entry = cached;
    for (const version of committed.get(key)?.values() ?? [])
      if (!entry || version.revision > entry.revision) entry = version;
    return entry;
  };
  const checkSnapshot = (snapshot: Omit<InputSnapshot, "name">) => {
    const previous = latest(snapshot.key);
    const exact =
      committed.get(snapshot.key)?.get(snapshot.revision) ??
      (cache.get(snapshot.key)?.revision === snapshot.revision
        ? cache.get(snapshot.key)
        : undefined);
    const watermark = highWater.get(snapshot.key);
    const known =
      exact ??
      (watermark?.revision === snapshot.revision ? watermark : undefined);
    if (previous) {
      requireThat(
        previous.type === snapshot.type &&
          previous.data.length === snapshot.data.length &&
          sameShape(previous.texture, snapshot.texture),
        "BINDING",
        "A logical input key cannot change type, size or texture shape before release.",
      );
      requireThat(
        (!known || same(known.data, snapshot.data)) &&
          (!!exact ||
            snapshot.revision > previous.revision ||
            snapshot.captured === true ||
            (watermark?.revision === snapshot.revision && !watermark.computed)),
        "REVISION",
        "Input revisions must increase when packed content changes.",
      );
    }
  };
  const textureShape = (
    value: unknown,
    type: GraphType,
    count: number,
  ): Readonly<TextureShape> | undefined => {
    if (value === undefined) return undefined;
    requireThat(
      record(value) &&
        Number.isSafeInteger(value.width) &&
        Number.isSafeInteger(value.height) &&
        (value.width as number) > 0 &&
        (value.height as number) > 0 &&
        type === "vec4" &&
        (value.width as number) * (value.height as number) === count &&
        count <= MAX_COUNT,
      "TEXTURE",
      "Textures require vec4 values and positive dimensions matching the texel count.",
    );
    const maximum = device.limits.maxTextureDimension2D;
    requireThat(
      Number.isFinite(maximum) &&
        (value.width as number) <= maximum &&
        (value.height as number) <= maximum,
      "LIMIT",
      "Texture dimensions exceed maxTextureDimension2D.",
    );
    return Object.freeze({
      width: value.width as number,
      height: value.height as number,
    });
  };
  const snapshotInput = (
    input: ComputeExecutionInput,
  ): Omit<InputSnapshot, "name"> => {
    requireThat(
      record(input) &&
        typeof input.key === "string" &&
        input.key.length &&
        isGraphType(input.type) &&
        Number.isSafeInteger(input.revision) &&
        input.revision >= 0 &&
        Array.isArray(input.values) &&
        input.values.length >= 1 &&
        input.values.length <= MAX_COUNT,
      "BINDING",
      "Invalid input identity, revision, type or count.",
    );
    const texture = textureShape(
      input.texture,
      input.type,
      input.values.length,
    );
    const bytes = input.values.length * 16;
    requireThat(
      bytes <= device.limits.maxBufferSize &&
        bytes <= device.limits.maxStorageBufferBindingSize,
      "LIMIT",
      "The input does not fit device storage limits.",
    );
    const data = new Float32Array(input.values.length * 4);
    for (let i = 0; i < input.values.length; i++)
      put(data, i * 4, input.type, input.values[i], "VALUE");
    const snapshot = {
      key: input.key,
      type: input.type,
      revision: input.revision,
      data,
      texture,
      captured: (input as ComputeExecutionInput & { captured?: true }).captured,
    };
    checkSnapshot(snapshot);
    return snapshot;
  };
  // All data sources can also be copied into renderer-owned Three storage.
  const storageUsage = () =>
    GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST;
  const exactBuffer = (snapshot: Omit<InputSnapshot, "name">) => {
    const version = committed.get(snapshot.key)?.get(snapshot.revision);
    if (version) {
      residentHits++;
      return version.buffer;
    }
    const input = cache.get(snapshot.key);
    if (input?.revision === snapshot.revision) {
      inputCacheHits++;
      return input.buffer;
    }
  };
  const makeTexture = (shape: TextureShape, output: boolean) => {
    const texture = device.createTexture({
      label: "pelican managed compute texture",
      size: { width: shape.width, height: shape.height, depthOrArrayLayers: 1 },
      dimension: "2d",
      format: "rgba32float",
      usage:
        GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC |
        (output
          ? GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC
          : GPUTextureUsage.COPY_DST),
    });
    ownedTextures.add(texture);
    allocations++;
    return texture;
  };
  const uploadTexture = (entry: CachedInput) => {
    if (entry.texture && entry.gpuTexture) {
      device.queue.writeTexture(
        { texture: entry.gpuTexture },
        entry.data,
        {
          bytesPerRow: entry.texture.width * 16,
          rowsPerImage: entry.texture.height,
        },
        {
          width: entry.texture.width,
          height: entry.texture.height,
          depthOrArrayLayers: 1,
        },
      );
      textureUploads++;
    }
  };
  const exactEntry = (snapshot: Omit<InputSnapshot, "name">) =>
    committed.get(snapshot.key)?.get(snapshot.revision) ??
    (cache.get(snapshot.key)?.revision === snapshot.revision
      ? cache.get(snapshot.key)
      : undefined);
  const checkpoint = (
    snapshot: Omit<InputSnapshot, "name">,
    kind: "input" | "checkpoint",
  ) => {
    checkSnapshot(snapshot);
    const exact = exactEntry(snapshot);
    if (exact) {
      // Preserve the existing buffer hit counters; sampling has its own counter too.
      exactBuffer(snapshot);
      return exact;
    }
    const previous = cache.get(snapshot.key);
    let entry = previous;
    let created = false;
    try {
      if (
        !entry ||
        kind === "checkpoint" ||
        snapshot.revision < entry.revision
      ) {
        const buffer = device.createBuffer({
          label: "pelican compute " + kind,
          size: snapshot.data.byteLength,
          usage: storageUsage(),
        });
        owned.add(buffer);
        allocations++;
        entry = { ...snapshot, buffer };
        created = true;
        if (snapshot.texture)
          entry.gpuTexture = makeTexture(snapshot.texture, false);
      }
      device.queue.writeBuffer(entry.buffer, 0, snapshot.data);
      entry.data = snapshot.data;
      uploadTexture(entry);
      entry.revision = snapshot.revision;
      if (created) {
        cache.set(snapshot.key, entry);
        if (previous) destroyEntry(previous);
      }
      remember(snapshot);
      uploads++;
      if (kind === "input") inputUploads++;
      else checkpointUploads++;
      return entry;
    } catch (failure) {
      if (created && entry) destroyEntry(entry);
      else evict(snapshot.key);
      throw failure;
    }
  };
  // One device-loss subscription per executor, not one retained closure per dispatch.
  void device.lost.then(() => {
    lost = true;
    running?.stop(error("DEVICE_LOST", "The compute device was lost."));
    clear();
  });

  function prepare(request: ComputeExecutionRequest) {
    requireThat(
      record(request) &&
        record(request.kernel) &&
        record(request.output) &&
        record(request.inputs) &&
        record(request.parameters) &&
        (request.textures === undefined || record(request.textures)) &&
        request.signal &&
        typeof request.signal.addEventListener === "function" &&
        typeof request.signal.removeEventListener === "function" &&
        typeof request.signal.aborted === "boolean",
      "REQUEST",
      "Expected a complete managed compute request and AbortSignal.",
    );
    const { kernel, output, inputs, parameters, time } = request;
    requireThat(
      typeof kernel.id === "string" &&
        kernel.id.length &&
        typeof output.key === "string" &&
        output.key.length,
      "REQUEST",
      "Kernel and output must have identities.",
    );
    requireThat(
      output.retain === undefined || typeof output.retain === "boolean",
      "REQUEST",
      "Output retain must be a boolean when supplied.",
    );
    const count = kernel.count,
      workgroup = kernel.workgroupSize;
    const limit = (name: keyof GPUSupportedLimits, amount: number) => {
      const maximum = device.limits[name];
      requireThat(
        typeof maximum === "number" &&
          Number.isFinite(maximum) &&
          amount <= maximum,
        "LIMIT",
        String(name) + " does not accommodate " + amount + ".",
      );
    };
    requireThat(
      Number.isSafeInteger(count) &&
        count >= 1 &&
        count <= MAX_COUNT &&
        output.count === count,
      "COUNT",
      "Kernel/output counts must agree and fit exact f32 indices.",
    );
    requireThat(
      Number.isSafeInteger(workgroup) && workgroup >= 1,
      "WORKGROUP",
      "Workgroup size must be a positive integer.",
    );
    limit("maxComputeWorkgroupSizeX", workgroup);
    limit("maxComputeInvocationsPerWorkgroup", workgroup);
    limit("maxComputeWorkgroupsPerDimension", Math.ceil(count / workgroup));
    limit("maxBufferSize", count * 16 + 4);
    limit("maxStorageBufferBindingSize", count * 16);
    requireThat(
      isGraphType(kernel.outputType) &&
        output.type === kernel.outputType &&
        record(kernel.graph) &&
        kernel.graph.outputType === kernel.outputType &&
        Array.isArray(kernel.graph.nodes),
      "TYPE",
      "Kernel, graph and output types must agree.",
    );
    const graph = kernel.graph;
    for (const node of graph.nodes) {
      requireThat(record(node), "GRAPH", "Malformed graph node.");
      requireThat(
        node.op !== "input" ||
          ["index", "pixelCoord", "outputSize", "uv"].includes(node.name!),
        "DOMAIN",
        "Unsupported compute graph input.",
      );
    }
    const outputTexture = textureShape(output.texture, output.type, count);
    const previousOutput = latest(output.key) ?? pending.get(output.key);
    if (previousOutput)
      requireThat(
        previousOutput.type === output.type &&
          previousOutput.data.length === count * 4 &&
          sameShape(previousOutput.texture, outputTexture),
        "TYPE",
        "Output must preserve the resource type, count and texture shape.",
      );
    requireThat(
      typeof time === "number" &&
        Number.isFinite(time) &&
        Number.isFinite(Math.fround(time)),
      "PARAMETER",
      "Time must be finite f32.",
    );
    requireThat(
      kernel.buffers === undefined || Array.isArray(kernel.buffers),
      "BINDING",
      "Invalid buffer declarations.",
    );
    const declarations = kernel.buffers ?? [];
    const names = new Set<string>();
    for (const binding of declarations) {
      requireThat(
        record(binding) &&
          typeof binding.name === "string" &&
          /^[a-zA-Z][a-zA-Z0-9_.-]*$/.test(binding.name) &&
          isGraphType(binding.type) &&
          !names.has(binding.name),
        "BINDING",
        "Buffer declarations must be unique and typed.",
      );
      names.add(binding.name);
    }
    requireThat(
      Object.keys(inputs).length === names.size &&
        Object.keys(inputs).every((n) => names.has(n)),
      "BINDING",
      "Supply exactly the kernel named input bindings.",
    );
    requireThat(
      graph.bufferTypes === undefined || record(graph.bufferTypes),
      "BINDING",
      "Invalid graph buffer metadata.",
    );
    for (const [name, type] of Object.entries(graph.bufferTypes ?? {}))
      requireThat(
        declarations.some((d) => d.name === name && d.type === type),
        "TYPE",
        "Graph binding metadata disagrees with the kernel.",
      );
    requireThat(
      kernel.textures === undefined || Array.isArray(kernel.textures),
      "TEXTURE",
      "Invalid texture declarations.",
    );
    const textureDeclarations = kernel.textures ?? [];
    const textureNames = new Set<string>();
    for (const binding of textureDeclarations) {
      requireThat(
        record(binding) &&
          typeof binding.name === "string" &&
          /^[a-zA-Z][a-zA-Z0-9_.-]*$/.test(binding.name) &&
          !textureNames.has(binding.name) &&
          (binding.filter === undefined ||
            ["nearest", "linear"].includes(binding.filter)) &&
          [binding.wrapU, binding.wrapV].every(
            (wrap) =>
              wrap === undefined ||
              ["clamp", "repeat", "mirror"].includes(wrap),
          ),
        "TEXTURE",
        "Texture declarations require unique names and supported filtering/addressing.",
      );
      textureNames.add(binding.name);
    }
    const textures = request.textures ?? {};
    requireThat(
      Object.keys(textures).length === textureNames.size &&
        Object.keys(textures).every((name) => textureNames.has(name)),
      "TEXTURE",
      "Supply exactly the kernel named texture bindings.",
    );
    for (const node of graph.nodes)
      if (node.op === "sampleTexture") {
        const name =
          typeof node.texture === "string" ? node.texture : node.texture?.id;
        requireThat(
          typeof name === "string" && textureNames.has(name),
          "TEXTURE",
          "Unknown sampleTexture binding.",
        );
      }
    limit("maxBindGroups", 1);
    limit(
      "maxBindingsPerBindGroup",
      declarations.length +
        textureDeclarations.length +
        (outputTexture ? 1 : 0) +
        3,
    );
    if (textureDeclarations.length)
      limit("maxSampledTexturesPerShaderStage", textureDeclarations.length);
    if (outputTexture) limit("maxStorageTexturesPerShaderStage", 1);
    limit("maxStorageBuffersPerShaderStage", declarations.length + 2);
    limit("maxUniformBuffersPerShaderStage", 1);
    const snapshots: InputSnapshot[] = [],
      byKey = new Map<string, InputSnapshot>();
    const textureSnapshots: InputSnapshot[] = [];
    const capture = (
      name: string,
      input: ComputeExecutionInput,
      sampled: boolean,
      type: GraphType,
    ) => {
      requireThat(
        record(input) &&
          input.type === type &&
          (sampled ? input.texture !== undefined : input.texture === undefined),
        "BINDING",
        "Buffers and texture bindings must match their declarations.",
      );
      const snapshot = { name, ...snapshotInput(input) };
      const previous = byKey.get(input.key);
      if (previous)
        requireThat(
          input.type === previous.type &&
            snapshot.revision === previous.revision &&
            sameShape(snapshot.texture, previous.texture) &&
            same(snapshot.data, previous.data),
          "REVISION",
          "Aliased input bindings must describe the same snapshot.",
        );
      if (input.key === output.key)
        requireThat(
          input.type === output.type &&
            input.values.length === count &&
            sameShape(snapshot.texture, outputTexture),
          "TYPE",
          "Feedback must match the output type, count and shape.",
        );
      byKey.set(input.key, snapshot);
      return snapshot;
    };
    for (const declaration of declarations) {
      requireThat(
        own(inputs, declaration.name),
        "BINDING",
        "Missing input binding.",
      );
      snapshots.push(
        capture(
          declaration.name,
          inputs[declaration.name],
          false,
          declaration.type,
        ),
      );
    }
    for (const declaration of textureDeclarations) {
      requireThat(
        own(textures, declaration.name),
        "TEXTURE",
        "Missing texture binding.",
      );
      textureSnapshots.push(
        capture(declaration.name, textures[declaration.name], true, "vec4"),
      );
    }
    requireThat(
      graph.parameters === undefined || Array.isArray(graph.parameters),
      "PARAMETER",
      "Invalid parameter declarations.",
    );
    const params = graph.parameters ?? [];
    const uniformBytes = (params.length + 1) * 16;
    limit("maxUniformBufferBindingSize", uniformBytes);
    limit("maxBufferSize", uniformBytes);
    const uniform = new Float32Array((params.length + 1) * 4);
    uniform[0] = time;
    const parameterIndices = new Map<string, number>();
    params.forEach((p, i) => {
      requireThat(
        record(p) &&
          typeof p.name === "string" &&
          p.name.length &&
          isGraphType(p.type) &&
          !parameterIndices.has(p.name),
        "PARAMETER",
        "Parameters must have unique names and valid types.",
      );
      requireThat(
        graphValue(p.type, p.default) !== null,
        "PARAMETER",
        "Invalid parameter default.",
      );
      put(
        uniform,
        (i + 1) * 4,
        p.type,
        own(parameters, p.name) ? parameters[p.name] : p.default,
        "PARAMETER",
      );
      parameterIndices.set(p.name, i + 1);
    });
    requireThat(
      Object.keys(parameters).every((name) => parameterIndices.has(name)),
      "PARAMETER",
      "Unknown parameter override.",
    );
    const outputWidth = outputTexture?.width ?? count;
    const outputHeight = outputTexture?.height ?? 1;
    const textureBinding = snapshots.length + 3;
    const storageBinding = textureBinding + textureSnapshots.length;
    const lowered = lowerGraphWGSL(graph, {
      prefix: "tc",
      input: (name) => {
        if (name === "time") return "tc_params[0].x";
        if (name === "index") return "f32(tc_id.x)";
        if (name === "pixelCoord") return "vec2f(tc_pixel)";
        if (name === "outputSize")
          return `vec2f(${outputWidth}.0, ${outputHeight}.0)`;
        if (name === "uv")
          return `(vec2f(tc_pixel) + vec2f(0.5)) / vec2f(${outputWidth}.0, ${outputHeight}.0)`;
        throw error("DOMAIN", "Unsupported input " + name + ".");
      },
      parameter: (name, type) => {
        const i = parameterIndices.get(name);
        requireThat(
          i !== undefined && params[i - 1].type === type,
          "PARAMETER",
          "Unknown or mistyped parameter.",
        );
        return unpack("tc_params[" + i + "]", type);
      },
      readBuffer: (name, index, type) => {
        const i = snapshots.findIndex((input) => input.name === name);
        requireThat(
          i >= 0 && snapshots[i].type === type,
          "BINDING",
          "Unknown or mistyped readBuffer binding.",
        );
        return unpack("tc_read_" + i + "(" + index + ")", type);
      },
      sampleTexture: (name, uv) => {
        const i = textureSnapshots.findIndex((input) => input.name === name);
        requireThat(i >= 0, "TEXTURE", "Unknown sampleTexture binding.");
        return "tc_sample_" + i + "(" + uv + ")";
      },
    });
    const source = [
      "@group(0) @binding(0) var<storage, read_write> tc_output: array<vec4f>;",
      "@group(0) @binding(1) var<uniform> tc_params: array<vec4f, " +
        (params.length + 1) +
        ">;",
      "@group(0) @binding(2) var<storage, read_write> tc_fault: atomic<u32>;",
      ...snapshots.map((_, i) =>
        [
          "@group(0) @binding(" +
            (i + 3) +
            ") var<storage, read> tc_input_" +
            i +
            ": array<vec4f>;",
          "fn tc_read_" + i + "(index: f32) -> vec4f {",
          "  if ((bitcast<u32>(index) & 0x7f800000u) == 0x7f800000u ||",
          "      index < 0.0 || index != floor(index) || index >= f32(arrayLength(&tc_input_" +
            i +
            "))) {",
          "    atomicOr(&tc_fault, 1u);",
          "    return vec4f(0.0);",
          "  }",
          "  return tc_input_" + i + "[u32(index)];",
          "}",
        ].join("\n"),
      ),
      ...textureSnapshots.map((_, i) =>
        textureHelper(i, textureBinding + i, textureDeclarations[i]),
      ),
      ...(outputTexture
        ? [
            `@group(0) @binding(${storageBinding}) var tc_output_texture: texture_storage_2d<rgba32float, write>;`,
          ]
        : []),
      lowered.helpers,
      "@compute @workgroup_size(" + workgroup + ")",
      "fn main(@builtin(global_invocation_id) tc_id: vec3u) {",
      "  if (tc_id.x >= " + count + "u) { return; }",
      `  let tc_pixel = vec2u(tc_id.x % ${outputWidth}u, tc_id.x / ${outputWidth}u);`,
      lowered.code,
      "  let tc_value = " +
        packedResult(lowered.result, kernel.outputType) +
        ";",
      "  if (any((bitcast<vec4u>(tc_value) & vec4u(0x7f800000u)) == vec4u(0x7f800000u))) {",
      "    atomicOr(&tc_fault, 2u);",
      "  }",
      "  tc_output[tc_id.x] = tc_value;",
      ...(outputTexture
        ? ["  textureStore(tc_output_texture, vec2i(tc_pixel), tc_value);"]
        : []),
      "}",
    ].join("\n");
    return {
      source,
      snapshots,
      textureSnapshots,
      outputTexture,
      textureBinding,
      storageBinding,
      uniform,
      count,
      workgroup,
      outputType: kernel.outputType,
      outputKey: output.key,
      retain: output.retain === true,
      minimumRevision: Math.max(
        latest(output.key)?.revision ?? -1,
        ...[...snapshots, ...textureSnapshots]
          .filter((input) => input.key === output.key)
          .map((input) => input.revision),
      ),
    };
  }

  return {
    inspect: () =>
      Object.freeze({
        cachedInputs: cache.size,
        pendingCandidates: pending.size,
        committedVersions: [...committed.values()].reduce(
          (n, versions) => n + versions.size,
          0,
        ),
        residentBytes: [...committed.values()].reduce(
          (n, versions) =>
            n +
            [...versions.values()].reduce(
              (bytes, entry) =>
                bytes + entry.data.byteLength * (entry.gpuTexture ? 2 : 1),
              0,
            ),
          0,
        ),
        retentions,
        commits,
        residentHits,
        inputCacheHits,
        inputUploads,
        checkpointUploads,
        cachedPipelines: pipelines.size,
        cachedBytes: [...cache.values()].reduce(
          (n, input) => n + input.data.byteLength,
          0,
        ),
        liveBuffers: owned.size,
        liveTextures: ownedTextures.size,
        textureUploads,
        textureResidentHits,
        storageTextureDispatches,
        allocations,
        uploads,
        dispatches,
        active: !!running,
        disposed,
        deviceLost: lost,
      }),
    resident(input): ComputeGpuView {
      available();
      const snapshot = snapshotInput(input);
      let entry: CachedInput;
      try {
        entry = checkpoint(snapshot, "checkpoint");
      } catch (failure) {
        throw error(
          "GPU",
          failure instanceof Error ? failure.message : String(failure),
        );
      }
      const buffer = entry.buffer;
      return Object.freeze({
        buffer,
        type: snapshot.type,
        count: snapshot.data.length / 4,
        revision: snapshot.revision,
      });
    },
    textureResident(input) {
      available();
      const snapshot = snapshotInput(input);
      requireThat(
        snapshot.texture,
        "TEXTURE",
        "textureResident requires a texture descriptor.",
      );
      const hit = exactEntry(snapshot);
      let entry: CachedInput;
      try {
        entry = checkpoint(snapshot, "checkpoint");
      } catch (failure) {
        throw error(
          "GPU",
          failure instanceof Error ? failure.message : String(failure),
        );
      }
      if (hit) textureResidentHits++;
      return Object.freeze({
        texture: entry.gpuTexture!,
        width: snapshot.texture.width,
        height: snapshot.texture.height,
        revision: snapshot.revision,
      });
    },
    commit(key, revision) {
      available();
      requireThat(
        typeof key === "string" && key.length,
        "REQUEST",
        "Commit needs a resource key.",
      );
      requireThat(
        !running?.keys.has(key),
        "BUSY",
        "Cannot commit a resource during its dispatch.",
      );
      const candidate = pending.get(key);
      requireThat(
        candidate &&
          candidate.key === key &&
          owned.has(candidate.buffer) &&
          (!candidate.texture ||
            (candidate.gpuTexture && ownedTextures.has(candidate.gpuTexture))),
        "CANDIDATE",
        "No validated pending output exists for this key.",
      );
      requireThat(
        !candidate.signal.aborted,
        "CANCELLED",
        "The candidate was aborted.",
      );
      const previous = latest(key);
      requireThat(
        isGraphType(candidate.type) &&
          candidate.data.length >= 4 &&
          candidate.data.length % 4 === 0 &&
          candidate.data.length / 4 <= MAX_COUNT &&
          (!previous ||
            (previous.type === candidate.type &&
              previous.data.length === candidate.data.length &&
              sameShape(previous.texture, candidate.texture))),
        "TYPE",
        "The candidate must preserve the resource type and count.",
      );
      requireThat(
        Number.isSafeInteger(revision) &&
          revision >= 0 &&
          revision >
            Math.max(candidate.minimumRevision, previous?.revision ?? -1),
        "REVISION",
        "A commit must advance the resource revision.",
      );
      // Stage everything before changing visible metadata. No GPU calls publish a result.
      const entry: CachedInput = {
        key,
        revision,
        type: candidate.type,
        data: candidate.data,
        buffer: candidate.buffer,
        texture: candidate.texture,
        gpuTexture: candidate.gpuTexture,
      };
      const versions = new Map(committed.get(key));
      versions.set(revision, entry);
      committed.set(key, versions);
      remember(entry, true);
      pending.delete(key);
      candidate.signal.removeEventListener("abort", candidate.abort);
      commits++;
    },
    discard(key) {
      if (running?.keys.has(key))
        running.stop(
          error("CANCELLED", "The compute candidate was discarded."),
        );
      discard(key);
    },
    collect(live) {
      available();
      requireThat(
        !running,
        "BUSY",
        "Collect only after the compute flush finishes.",
      );
      requireThat(
        Array.isArray(live),
        "REQUEST",
        "Collect needs live resource revisions.",
      );
      const current = new Map<string, Set<number>>();
      for (const input of live) {
        requireThat(
          record(input) &&
            typeof input.key === "string" &&
            input.key.length &&
            typeof input.revision === "number" &&
            Number.isSafeInteger(input.revision) &&
            input.revision >= 0 &&
            !current.get(input.key)?.has(input.revision),
          "REVISION",
          "Live resources need unique key/revision pairs and valid revisions.",
        );
        let revisions = current.get(input.key);
        if (!revisions) current.set(input.key, (revisions = new Set()));
        revisions.add(input.revision);
      }
      for (const [key, versions] of committed) {
        for (const [revision, entry] of versions) {
          if (!current.get(key)?.has(revision)) {
            versions.delete(revision);
            destroyEntry(entry);
          }
        }
        if (!versions.size) committed.delete(key);
      }
      for (const [key, entry] of cache)
        if (
          !current.get(key)?.has(entry.revision) ||
          committed.get(key)?.has(entry.revision)
        )
          evict(key);
    },
    release(key) {
      if (running?.keys.has(key))
        running.stop(
          error("CANCELLED", "An in-flight compute resource was released."),
        );
      discard(key);
      releaseVersions(key);
      evict(key);
      highWater.delete(key);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      running?.stop(error("CANCELLED", "The compute executor was disposed."));
      clear();
    },
    async run(request) {
      requireThat(
        !disposed,
        "DISPOSED",
        "The compute executor has been disposed.",
      );
      requireThat(!lost, "DEVICE_LOST", "The compute device was lost.");
      requireThat(
        !running,
        "BUSY",
        "This executor accepts one dispatch at a time.",
      );
      const prepared = prepare(request);
      const signal = request.signal;
      requireThat(
        !signal.aborted,
        "CANCELLED",
        "The compute request was aborted.",
      );
      discard(prepared.outputKey);
      const { count, workgroup, uniform, snapshots, textureSnapshots } =
        prepared;
      const allSnapshots = [...snapshots, ...textureSnapshots];
      const ephemeral = new Set<GPUBuffer | GPUTexture>(),
        usedKeys = new Set<string>();
      const validations: Promise<GPUError | null>[] = [];
      let stopped: Error | undefined, rejectStop!: (reason: Error) => void;
      const stopPromise = new Promise<never>((_, reject) => {
        rejectStop = reject;
      });
      const cleanup = () => {
        for (const buffer of ephemeral) destroy(buffer);
        ephemeral.clear();
      };
      const stop = (reason: Error) => {
        if (stopped) return;
        stopped = reason;
        cleanup();
        rejectStop(reason);
      };
      const active = () => {
        if (stopped) throw stopped;
      };
      running = {
        keys: new Set([
          prepared.outputKey,
          ...allSnapshots.map((input) => input.key),
        ]),
        stop,
      };
      const abort = () =>
        stop(error("CANCELLED", "The compute request was aborted."));
      signal.addEventListener("abort", abort, { once: true });
      const timer = setTimeout(
        () =>
          stop(error("TIMEOUT", "Compute exceeded " + DEADLINE_MS + " ms.")),
        DEADLINE_MS,
      );
      // Scope push/pop stay synchronous; no other device user can interleave the stack.
      const scoped = <T>(work: () => T): T => {
        device.pushErrorScope("out-of-memory");
        device.pushErrorScope("internal");
        device.pushErrorScope("validation");
        try {
          return work();
        } finally {
          for (let i = 0; i < 3; i++) {
            const pending = device.popErrorScope();
            void pending.catch(() => undefined);
            validations.push(pending);
          }
        }
      };
      const make = (size: number, usage: number, temporary: boolean) => {
        active();
        const buffer = device.createBuffer({
          label: "pelican managed compute",
          size,
          usage,
        });
        owned.add(buffer);
        if (temporary) ephemeral.add(buffer);
        allocations++;
        return buffer;
      };
      const validate = async () => {
        const failures = await Promise.all(validations);
        active();
        requireThat(
          !failures.some(Boolean),
          "GPU",
          failures
            .filter(Boolean)
            .map((failure) => failure!.message)
            .join("; "),
        );
      };
      let outputBuffer: GPUBuffer | undefined;
      let outputGpuTexture: GPUTexture | undefined;
      const work = async (): Promise<readonly GraphValue[]> => {
        active();
        let pipeline = pipelines.get(prepared.source);
        if (!pipeline) {
          const module = scoped(() =>
            device.createShaderModule({
              label: "pelican managed compute",
              code: prepared.source,
            }),
          );
          const info = await module.getCompilationInfo();
          active();
          const errors = info.messages.filter(
            (message) => message.type === "error",
          );
          requireThat(
            !errors.length,
            "SHADER",
            errors.map((message) => message.message).join("; "),
          );
          pipeline = await scoped(() => {
            const layout = device.createBindGroupLayout({
              entries: [
                {
                  binding: 0,
                  visibility: GPUShaderStage.COMPUTE,
                  buffer: { type: "storage" },
                },
                {
                  binding: 1,
                  visibility: GPUShaderStage.COMPUTE,
                  buffer: { type: "uniform" },
                },
                {
                  binding: 2,
                  visibility: GPUShaderStage.COMPUTE,
                  buffer: { type: "storage" },
                },
                ...snapshots.map((_, i) => ({
                  binding: i + 3,
                  visibility: GPUShaderStage.COMPUTE,
                  buffer: { type: "read-only-storage" as const },
                })),
                ...textureSnapshots.map((_, i) => ({
                  binding: prepared.textureBinding + i,
                  visibility: GPUShaderStage.COMPUTE,
                  texture: {
                    sampleType: "unfilterable-float" as const,
                    viewDimension: "2d" as const,
                    multisampled: false,
                  },
                })),
                ...(prepared.outputTexture
                  ? [
                      {
                        binding: prepared.storageBinding,
                        visibility: GPUShaderStage.COMPUTE,
                        storageTexture: {
                          access: "write-only" as const,
                          format: "rgba32float" as const,
                          viewDimension: "2d" as const,
                        },
                      },
                    ]
                  : []),
              ],
            });
            return device.createComputePipelineAsync({
              layout: device.createPipelineLayout({
                bindGroupLayouts: [layout],
              }),
              compute: { module, entryPoint: "main" },
            });
          });
          // Publish only fully validated creation, never a cancelled late completion.
          await validate();
          active();
          pipelines.set(prepared.source, pipeline);
        }
        active();
        const readyPipeline = pipeline;
        const readback = scoped(() => {
          const inputEntries = allSnapshots.map((snapshot) => {
            usedKeys.add(snapshot.key);
            const hit = exactEntry(snapshot);
            const entry = checkpoint(snapshot, "input");
            if (snapshot.texture && hit) textureResidentHits++;
            return entry;
          });
          if (prepared.outputTexture) {
            outputGpuTexture = makeTexture(prepared.outputTexture, true);
            ephemeral.add(outputGpuTexture);
          }
          const output = (outputBuffer = make(
            count * 16,
            GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
            true,
          ));
          const params = make(
            uniform.byteLength,
            GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
            true,
          );
          const fault = make(
            4,
            GPUBufferUsage.STORAGE |
              GPUBufferUsage.COPY_SRC |
              GPUBufferUsage.COPY_DST,
            true,
          );
          const read = make(
            count * 16 + 4,
            GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
            true,
          );
          device.queue.writeBuffer(params, 0, uniform);
          device.queue.writeBuffer(fault, 0, new Uint32Array(1));
          const group = device.createBindGroup({
            layout: readyPipeline.getBindGroupLayout(0),
            entries: [
              { binding: 0, resource: { buffer: output } },
              { binding: 1, resource: { buffer: params } },
              { binding: 2, resource: { buffer: fault } },
              ...inputEntries.slice(0, snapshots.length).map((entry, i) => ({
                binding: i + 3,
                resource: { buffer: entry.buffer },
              })),
              ...inputEntries.slice(snapshots.length).map((entry, i) => ({
                binding: prepared.textureBinding + i,
                resource: entry.gpuTexture!.createView(),
              })),
              ...(outputGpuTexture
                ? [
                    {
                      binding: prepared.storageBinding,
                      resource: outputGpuTexture.createView(),
                    },
                  ]
                : []),
            ],
          });
          const encoder = device.createCommandEncoder();
          const pass = encoder.beginComputePass();
          pass.setPipeline(readyPipeline);
          pass.setBindGroup(0, group);
          pass.dispatchWorkgroups(Math.ceil(count / workgroup));
          pass.end();
          encoder.copyBufferToBuffer(output, 0, read, 0, count * 16);
          encoder.copyBufferToBuffer(fault, 0, read, count * 16, 4);
          device.queue.submit([encoder.finish()]);
          dispatches++;
          if (outputGpuTexture) storageTextureDispatches++;
          return read;
        });
        await readback.mapAsync(GPUMapMode.READ);
        active();
        const bytes = readback.getMappedRange().slice(0);
        readback.unmap();
        const faults = new Uint32Array(bytes, count * 16, 1)[0];
        requireThat(
          !(faults & 1),
          "BOUNDS",
          "A readBuffer index was nonfinite, fractional or out of range.",
        );
        requireThat(
          !(faults & 2),
          "NONFINITE",
          "The compute result was nonfinite.",
        );
        requireThat(
          !textureSnapshots.length || !(faults & 4),
          "TEXTURE_COORD",
          "A sampleTexture UV coordinate was nonfinite.",
        );
        requireThat(faults === 0, "GPU", "Unknown compute fault flags.");
        const data = new Float32Array(bytes, 0, count * 4);
        requireThat(
          data.every(Number.isFinite),
          "NONFINITE",
          "The decoded compute result was nonfinite.",
        );
        const values: GraphValue[] = [];
        for (let i = 0; i < count; i++) {
          const offset = i * 4;
          if (prepared.outputType === "bool") {
            requireThat(
              data[offset] === 0 || data[offset] === 1,
              "GPU",
              "Invalid bool result encoding.",
            );
            values.push(data[offset] === 1);
          } else if (prepared.outputType === "float") values.push(data[offset]);
          else
            values.push(
              Array.from(
                data.subarray(offset, offset + width(prepared.outputType)),
              ) as unknown as GraphValue,
            );
        }
        await validate();
        active();
        if (prepared.retain) {
          // The CPU descriptor must describe exactly the retained vec4 bytes,
          // including bool encoding and the unused lanes of narrower values.
          const packed = new Float32Array(count * 4);
          values.forEach((value, i) =>
            put(packed, i * 4, prepared.outputType, value, "GPU"),
          );
          requireThat(
            same(packed, data),
            "GPU",
            "Invalid packed result encoding.",
          );
          const buffer = outputBuffer!;
          const candidate: PendingOutput = {
            key: prepared.outputKey,
            type: prepared.outputType,
            data: packed,
            buffer,
            texture: prepared.outputTexture,
            gpuTexture: outputGpuTexture,
            signal,
            minimumRevision: prepared.minimumRevision,
            abort: () => discard(prepared.outputKey),
          };
          pending.set(prepared.outputKey, candidate);
          signal.addEventListener("abort", candidate.abort, { once: true });
          ephemeral.delete(buffer);
          if (outputGpuTexture) ephemeral.delete(outputGpuTexture);
          retentions++;
        }
        return values;
      };
      try {
        return await Promise.race([work(), stopPromise]);
      } catch (failure) {
        // A rejected upload/validation must not leave a seemingly current cache entry.
        for (const key of usedKeys) evict(key);
        if (
          failure instanceof Error &&
          /^TC_(COMPUTE|GRAPH)_/.test(failure.message)
        )
          throw failure;
        throw error(
          "GPU",
          failure instanceof Error ? failure.message : String(failure),
        );
      } finally {
        stopped ??= error(
          "CANCELLED",
          "The compute request is no longer active.",
        );
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        cleanup();
        running = undefined;
      }
    },
  };
}
