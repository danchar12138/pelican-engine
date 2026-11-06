import type { ComputeBufferHandle, ComputeService, ComputeTaskHandle, ComputeTaskState, ComputeTextureHandle, ComputeTextureSize, GraphType, GraphValue, Vec4 } from "../../sdk/src/index.ts";
import { graphValue, isGraphType } from "../../sdk/src/graph-values.ts";
import type { ComputeDriverOptions, ComputeExecutionInput, ComputeExecutionRequest, ComputeExecutor } from "./compute-contract.ts";
import type { RuntimePluginFactory } from "./plugins.ts";

type Kernel = ComputeExecutionRequest["kernel"];
type Code = `TC_COMPUTE_${string}`;
type Failure = NonNullable<ComputeTaskState["error"]>;
type Buffer = {
  handle: ComputeBufferHandle;
  key: string;
  id: string;
  type: GraphType;
  count: number;
  texture?: Readonly<ComputeTextureSize>;
  revision: number;
  values: readonly GraphValue[];
  busy: number;
};
type Task = {
  handle: ComputeTaskHandle;
  state: ComputeTaskState;
  request?: ComputeExecutionRequest;
  buffers: Set<Buffer>;
  output?: Buffer;
  source?: Buffer;
  result?: Readonly<{ source: Buffer; input: ComputeExecutionInput }>;
  dependencies: Set<Task>;
  taskBindings: Map<string, Task>;
  textureBindings: Map<string, Task>;
  consumers: number;
  controller: AbortController;
  epoch: number;
};
let nextOwner = 1;
const remediation = "Use live handles from this owner, declared kernels/bindings, matching finite f32 values, and an available WebGPU executor; flush or cancel pending work before changing buffers.";
const fail = (code: Code, at: string, detail: string): never => {
  throw Object.assign(new Error(`${code}: ${at}: ${detail} Repair: ${remediation}`), { code, remediation });
};
const plain = (value: unknown): value is Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return (proto === Object.prototype || proto === null) && Reflect.ownKeys(value).every(key => {
    const d = Object.getOwnPropertyDescriptor(value, key)!;
    return typeof key === "string" && d.enumerable && "value" in d;
  });
};
const exact = (value: unknown, keys: readonly string[]): value is Record<string, unknown> =>
  plain(value) && Reflect.ownKeys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const dense = (value: unknown): value is unknown[] => {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || Reflect.ownKeys(value).length !== value.length + 1) return false;
  for (let i = 0; i < value.length; i++) {
    const d = Object.getOwnPropertyDescriptor(value, String(i));
    if (!d || !d.enumerable || !("value" in d)) return false;
  }
  return true;
};
const countOK = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0 && (value as number) <= 0xffffffff;
const textureSize = (value: unknown, code: Code, at: string): Readonly<ComputeTextureSize> => {
  if (!exact(value, ["width", "height"]) || !countOK(value.width) || !countOK(value.height) || value.width * value.height > 2 ** 24)
    return fail(code, at, "Expected positive integer texture dimensions with at most 2^24 texels.");
  return Object.freeze({ width: value.width, height: value.height });
};
const checked = (type: GraphType, value: unknown, code: Code, at: string): GraphValue => {
  if (Array.isArray(value) && !dense(value)) return fail(code, at, "Expected a dense plain vector.");
  return graphValue(type, value) ?? fail(code, at, `Expected ${type} with finite f32 components.`);
};
const values = (type: GraphType, data: unknown, code: Code, at: string): readonly GraphValue[] => {
  if (!dense(data)) return fail(code, at, "Expected a dense plain values array.");
  return Object.freeze(data.map((value, i) => checked(type, value, code, `${at}[${i}]`)));
};
// Canonical plain data prevents key-order differences and snapshot aliases from affecting identity.
const canonical = (value: unknown, code: Code, seen = new Set<object>()): unknown => {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "object" || !value || seen.has(value)) return fail(code, "definitions", "Expected acyclic finite plain data.");
  seen.add(value);
  let result: unknown;
  if (dense(value)) result = value.map(v => canonical(v, code, seen));
  else if (plain(value)) result = Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k], code, seen)]));
  else return fail(code, "definitions", "Expected plain data without accessors or sparse arrays.");
  seen.delete(value);
  return result;
};
const freeze = <T>(value: T): T => {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
};
const failure = (error: unknown, at: string): Failure => {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "Executor failed.";
  const code = /\bTC_COMPUTE_[A-Z0-9_]+\b/.exec(message)?.[0] ?? "TC_COMPUTE_EXECUTION";
  return { code, message: `${code}: ${at}: ${message}`, remediation };
};

/** CPU mirror and lifecycle owner only. All computation is delegated to the private executor. */
export function createComputeDriver(options: ComputeDriverOptions): ReturnType<typeof createComputeOwner> {
  try { return createComputeOwner(options); }
  catch (error) {
    // Construction never starts executor work. Unreturned CPU state is unreachable;
    // release the transferred executor as well, without hiding the validation error.
    try { options.executor?.dispose(); } catch { /* Preserve the construction failure. */ }
    try { options.textureAssets?.dispose(); } catch { /* Preserve the construction failure. */ }
    throw error;
  }
}

function createComputeOwner(options: ComputeDriverOptions): {
  service: ComputeService;
  resource(id: string): ComputeExecutionInput;
  textureResource(id: string): ComputeExecutionInput;
  setRenderPins(ids: readonly string[]): void;
  factory: RuntimePluginFactory;
  flush(): Promise<void>;
  replaceExecutor(executor?: ComputeExecutor): void;
  dispose(): void;
  inspect(): unknown;
} {
  const kernels = new Map<string, Kernel>();
  if (!dense(options.kernels)) fail("TC_COMPUTE_KERNEL", "kernels", "Expected a dense kernel definitions array.");
  for (const source of options.kernels) {
    const k = canonical(source, "TC_COMPUTE_KERNEL") as Kernel;
    if (!plain(k) || typeof k.id !== "string" || !k.id.trim() || kernels.has(k.id) || !countOK(k.count) ||
      !Number.isSafeInteger(k.workgroupSize) || k.workgroupSize <= 0 || !isGraphType(k.outputType) || !plain(k.graph) || k.graph.outputType !== k.outputType)
      fail("TC_COMPUTE_KERNEL", "kernels", "Expected unique valid compiled kernel definitions.");
    const bindings = k.buffers === undefined ? [] : k.buffers, parameters = k.graph.parameters === undefined ? [] : k.graph.parameters;
    if (!dense(bindings) || !dense(parameters)) fail("TC_COMPUTE_KERNEL", k.id, "Invalid declarations.");
    const seen = new Set<string>();
    for (const binding of bindings) {
      if (!exact(binding, ["name", "type"]) || typeof binding.name !== "string" || !binding.name.trim() || !isGraphType(binding.type) || seen.has(binding.name))
        fail("TC_COMPUTE_KERNEL", k.id, "Invalid or duplicate buffer declaration.");
      seen.add(binding.name);
    }
    seen.clear();
    if (k.textures !== undefined) {
      if (!dense(k.textures)) fail("TC_COMPUTE_KERNEL", k.id, "Invalid texture declarations.");
      k.textures = k.textures.map(binding => {
        if (!plain(binding) || Object.keys(binding).some(key => !["name", "filter", "wrapU", "wrapV"].includes(key)) ||
          typeof binding.name !== "string" || !binding.name.trim() || seen.has(binding.name) ||
          (binding.filter !== undefined && !["nearest", "linear"].includes(binding.filter)) ||
          (binding.wrapU !== undefined && !["clamp", "repeat", "mirror"].includes(binding.wrapU)) ||
          (binding.wrapV !== undefined && !["clamp", "repeat", "mirror"].includes(binding.wrapV)))
          return fail("TC_COMPUTE_KERNEL", k.id, "Invalid or duplicate texture declaration.");
        seen.add(binding.name);
        return { name: binding.name, filter: binding.filter ?? "linear", wrapU: binding.wrapU ?? "clamp", wrapV: binding.wrapV ?? "clamp" };
      }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    }
    seen.clear();
    for (const parameter of parameters) {
      if (!exact(parameter, ["name", "type", "default"]) || typeof parameter.name !== "string" || !parameter.name.trim() || !isGraphType(parameter.type) || seen.has(parameter.name))
        fail("TC_COMPUTE_KERNEL", k.id, "Invalid or duplicate parameter declaration.");
      checked(parameter.type, parameter.default, "TC_COMPUTE_KERNEL", `${k.id}:${parameter.name}`);
      seen.add(parameter.name);
    }
    k.buffers = [...bindings].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    if (k.graph.parameters) k.graph.parameters = [...parameters].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    kernels.set(k.id, freeze(k));
  }
  const definitions = [...kernels.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0).map(({ source: _source, ...k }) => k);
  const definitionText = JSON.stringify(canonical(definitions, "TC_COMPUTE_KERNEL"));
  let owner = nextOwner++, epoch = 0, disposed = false, executor = options.executor;
  let nextTask = 1, flushing: Promise<void> | undefined, cleanupErrors = 0;
  const buffers = new Map<number, Buffer>(), names = new Map<string, Buffer>(), tasks = new Map<number, Task>();
  let renderPins = new Map<string, number>();
  const generations: number[] = [], free: number[] = [];
  let queue: Task[] = [];
  const active = () => { if (disposed) fail("TC_COMPUTE_DISPOSED", "owner", "Owner is disposed; create a new driver."); };
  const cleanup = (fn: () => void) => { try { fn(); } catch { cleanupErrors++; } };
  const resourceHandle = (handle: unknown, isTexture: boolean): Buffer => {
    active();
    const kind = isTexture ? "texture" : "buffer", code = isTexture ? "TC_COMPUTE_TEXTURE_HANDLE" : "TC_COMPUTE_BUFFER_HANDLE";
    if (!exact(handle, isTexture ? ["owner", "index", "generation", "kind"] : ["owner", "index", "generation"]) ||
      handle.owner !== owner || !Number.isSafeInteger(handle.index) || !Number.isSafeInteger(handle.generation) ||
      (isTexture && handle.kind !== "texture"))
      return fail(code, kind, "Invalid or foreign handle; resolve its name again after restore.");
    const b = buffers.get(handle.index as number);
    if (!b || b.handle.generation !== handle.generation || !!b.texture !== isTexture)
      return fail(code, kind, "Stale handle or incorrect resource kind.");
    return b;
  };
  const buffer = (handle: ComputeBufferHandle) => resourceHandle(handle, false);
  const texture = (handle: ComputeTextureHandle) => resourceHandle(handle, true);
  const textureHandle = (b: Buffer): ComputeTextureHandle => Object.freeze({ ...b.handle, kind: "texture" });
  const descriptor = (b: Buffer): ComputeExecutionInput => Object.freeze({ key: b.key, type: b.type, revision: b.revision, values: b.values, ...(b.texture ? { texture: b.texture } : {}) });
  const task = (handle: ComputeTaskHandle): Task => {
    active();
    if (!exact(handle, ["owner", "id"]) || handle.owner !== owner || !Number.isSafeInteger(handle.id) || !tasks.has(handle.id))
      return fail("TC_COMPUTE_TASK_HANDLE", "task", "Invalid, released or stale task handle.");
    return tasks.get(handle.id)!;
  };
  const unfinished = (t: Task) => t.state.status === "queued" || t.state.status === "running";
  const live = (b: Buffer) => buffers.get(b.handle.index) === b;
  const collect = () => {
    const retained = new Map<string, { key: string; revision: number }>();
    const keep = ({ key, revision }: { key: string; revision: number }) => retained.set(key + "/" + revision, { key, revision });
    for (const b of buffers.values()) keep(b);
    for (const t of tasks.values()) if (t.result && live(t.result.source)) keep(t.result.input);
    cleanup(() => executor?.collect?.([...retained.values()]));
  };
  const collectIfIdle = () => {
    if (!disposed && !flushing && ![...tasks.values()].some(t => t.state.status === "running")) collect();
  };
  const dependency = (handle: unknown, at: string): Task => {
    if (!exact(handle, ["owner", "id"]) || handle.owner !== owner || !Number.isSafeInteger(handle.id) ||
      (handle.id as number) <= 0 || (handle.id as number) >= nextTask)
      return fail("TC_COMPUTE_DEPENDENCY", at, "Expected an existing earlier task handle from this owner.");
    return tasks.get(handle.id as number) ?? fail("TC_COMPUTE_DEPENDENCY", at, "Dependency task was released or invalidated.");
  };
  const finish = (t: Task, state: ComputeTaskState) => {
    if (!unfinished(t)) return;
    t.state = state;
    for (const b of t.buffers) b.busy--;
    t.buffers.clear();
    for (const predecessor of t.dependencies) predecessor.consumers--;
    t.dependencies.clear();
    t.taskBindings.clear();
    t.textureBindings.clear();
    t.request = undefined;
    t.output = undefined;
  };
  const cancel = (t: Task) => {
    if (!unfinished(t)) return;
    finish(t, { status: "cancelled" });
    t.controller.abort();
  };
  const idle = () => {
    active();
    if ([...tasks.values()].some(unfinished)) fail("TC_COMPUTE_BUSY", "snapshot", "Flush or cancel unfinished tasks before taking or restoring a snapshot.");
  };
  const addBuffer = (id: string, type: GraphType, count: number, data: readonly GraphValue[], texture?: Readonly<ComputeTextureSize>): Buffer => {
    const index = free.pop() ?? generations.length;
    const generation = (generations[index] ?? 0) + 1;
    generations[index] = generation;
    const handle = Object.freeze({ owner, index, generation });
    const b: Buffer = { handle, key: `compute:${owner}:${index}:${generation}`, id, type, count, values: data, ...(texture ? { texture } : {}), revision: 0, busy: 0 };
    buffers.set(index, b);
    names.set(id, b);
    return b;
  };
  const release = (b: Buffer) => {
    if (renderPins.has(b.id)) fail("TC_COMPUTE_BUFFER_IN_USE", b.id, "Unbind all render references before releasing this resource.");
    if (b.busy) fail("TC_COMPUTE_BUSY", b.id, "Resource is used by unfinished tasks.");
    buffers.delete(b.handle.index);
    names.delete(b.id);
    free.push(b.handle.index);
    for (const t of tasks.values()) if (t.source === b) {
      t.source = undefined;
      t.result = undefined;
    }
    const current = executor;
    if (current) cleanup(() => current.release(b.key));
  };
  const service: ComputeService & { tasks(): readonly { handle: ComputeTaskHandle; state: ComputeTaskState }[] } = {
    createTexture(input) {
      active();
      if (plain(input) && Object.hasOwn(input, "asset")) {
        if (!exact(input, ["id", "asset"]) || typeof input.id !== "string" || !input.id.trim())
          return fail("TC_COMPUTE_TEXTURE_ASSET", "texture", "Asset import needs only a nonempty id and a declared texture asset.");
        const asset = typeof input.asset === "string" ? input.asset : plain(input.asset) && input.asset.kind === "asset" ? input.asset.id : undefined;
        if (typeof asset !== "string" || !asset.trim() || !options.textureAssets)
          return fail("TC_COMPUTE_TEXTURE_ASSET", input.id, "No declared loaded texture asset provider is available.");
        let resolved: unknown;
        try { resolved = options.textureAssets.resolve(asset); }
        catch (error) { return fail("TC_COMPUTE_TEXTURE_ASSET", input.id + ":" + asset, String(error)); }
        if (!exact(resolved, ["width", "height", "data"])) return fail("TC_COMPUTE_TEXTURE_ASSET", input.id, "Asset provider returned an invalid pixel descriptor.");
        const size = textureSize({ width: resolved.width, height: resolved.height }, "TC_COMPUTE_TEXTURE_ASSET", input.id);
        return service.createTexture({ id: input.id, ...size, data: resolved.data as readonly Vec4[] });
      }
      if (!plain(input) || Object.keys(input).some(k => !["id", "width", "height", "data"].includes(k)) || typeof input.id !== "string" || !input.id.trim())
        return fail("TC_COMPUTE_TEXTURE", "texture", "Expected a nonempty ID, positive dimensions and optional rgba32float data.");
      const size = textureSize({ width: input.width, height: input.height }, "TC_COMPUTE_TEXTURE", input.id);
      if (names.has(input.id)) return fail("TC_COMPUTE_TEXTURE_NAME", input.id, "Resource name already exists; release it or use a unique name.");
      const count = size.width * size.height;
      let data: readonly GraphValue[];
      if (input.data !== undefined) data = values("vec4", input.data, "TC_COMPUTE_VALUE", input.id);
      else {
        try { data = Object.freeze(Array(count).fill(Object.freeze([0, 0, 0, 0]))); }
        catch { return fail("TC_COMPUTE_TEXTURE", input.id, "Texture allocation failed; reduce dimensions."); }
      }
      if (data.length !== count) return fail("TC_COMPUTE_COUNT", input.id, "Initial data count does not match texture dimensions.");
      return textureHandle(addBuffer(input.id, "vec4", count, data, size));
    },
    resolveTexture(id) {
      active();
      const b = names.get(id);
      return b?.texture ? textureHandle(b) : fail("TC_COMPUTE_TEXTURE_NAME", String(id), "Unknown texture name.");
    },
    describeTexture(handle) {
      const b = texture(handle);
      return Object.freeze({ id: b.id, ...b.texture!, format: "rgba32float", revision: b.revision });
    },
    readTexture(handle) { return structuredClone(texture(handle).values) as readonly Vec4[]; },
    writeTexture(handle, data, region) {
      const b = texture(handle), size = b.texture!;
      if (b.busy) fail("TC_COMPUTE_BUSY", b.id, "Texture is used by unfinished tasks.");
      const rect = region === undefined ? { x: 0, y: 0, ...size } : region;
      if (!exact(rect, ["x", "y", "width", "height"]) || !Number.isSafeInteger(rect.x) || !Number.isSafeInteger(rect.y) || rect.x < 0 || rect.y < 0)
        return fail("TC_COMPUTE_RANGE", b.id, "Expected an explicit nonnegative integer rectangle.");
      const extent = textureSize({ width: rect.width, height: rect.height }, "TC_COMPUTE_RANGE", b.id);
      if (rect.x > size.width - extent.width || rect.y > size.height - extent.height)
        return fail("TC_COMPUTE_RANGE", b.id, "Write rectangle is outside the texture.");
      const next = values("vec4", data, "TC_COMPUTE_VALUE", b.id);
      if (next.length !== extent.width * extent.height)
        return fail("TC_COMPUTE_COUNT", b.id, "Write data count does not match the rectangle.");
      const staged = [...b.values];
      for (let y = 0; y < extent.height; y++) for (let x = 0; x < extent.width; x++)
        staged[(rect.y + y) * size.width + rect.x + x] = next[y * extent.width + x];
      b.values = Object.freeze(staged);
      b.revision++;
    },
    releaseTexture(handle) { release(texture(handle)); },
    createBuffer(input) {
      active();
      if (!plain(input) || Object.keys(input).some(k => !["id", "type", "count", "data"].includes(k)) || typeof input.id !== "string" || !input.id.trim() || !isGraphType(input.type) || !countOK(input.count))
        return fail("TC_COMPUTE_BUFFER", "buffer", "Expected a nonempty ID, graph type and positive array count.");
      if (names.has(input.id)) return fail("TC_COMPUTE_BUFFER_NAME", input.id, "Buffer name already exists; release it or use a unique name.");
      let data: readonly GraphValue[];
      if (input.data !== undefined) data = values(input.type, input.data, "TC_COMPUTE_VALUE", input.id);
      else {
        const zero: GraphValue = input.type === "bool" ? false : input.type === "float" ? 0 : Object.freeze(Array(Number(input.type.slice(3))).fill(0)) as GraphValue;
        try { data = Object.freeze(Array(input.count).fill(zero)); }
        catch { return fail("TC_COMPUTE_BUFFER", input.id, "Buffer allocation failed; reduce count."); }
      }
      if (data.length !== input.count) return fail("TC_COMPUTE_COUNT", input.id, "Initial data count does not match buffer count.");
      return addBuffer(input.id, input.type, input.count, data).handle;
    },
    resolve(id) {
      active();
      const b = names.get(id);
      return b && !b.texture ? b.handle : fail("TC_COMPUTE_BUFFER_NAME", String(id), "Unknown buffer name.");
    },
    describeBuffer(handle) {
      const b = buffer(handle);
      return Object.freeze({ id: b.id, type: b.type, count: b.count, revision: b.revision });
    },
    readBuffer(handle) { return structuredClone(buffer(handle).values); },
    writeBuffer(handle, data, offset = 0) {
      const b = buffer(handle);
      if (b.busy) fail("TC_COMPUTE_BUSY", b.id, "Buffer is used by unfinished tasks.");
      const next = values(b.type, data, "TC_COMPUTE_VALUE", b.id);
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > b.count || next.length > b.count - offset)
        fail("TC_COMPUTE_RANGE", b.id, "Write offset/count is outside the buffer.");
      if (!next.length) return;
      const staged = [...b.values];
      for (let i = 0; i < next.length; i++) staged[offset + i] = next[i];
      b.values = Object.freeze(staged);
      b.revision++;
    },
    releaseBuffer(handle) { release(buffer(handle)); },
    dispatch(reference, input) {
      active();
      const id = typeof reference === "string" ? reference : plain(reference) && reference.kind === "compute" ? reference.id : undefined;
      const kernel = typeof id === "string" ? kernels.get(id) : undefined;
      if (!kernel) return fail("TC_COMPUTE_KERNEL", String(id), "Kernel is not declared in this scene.");
      if (!plain(input) || Object.keys(input).some(k => !["output", "bindings", "textures", "parameters", "time", "after"].includes(k)))
        return fail("TC_COMPUTE_DISPATCH", kernel.id, "Expected dispatch options.");
      const output = resourceHandle(input.output, plain(input.output) && input.output.kind === "texture");
      if (output.type !== kernel.outputType) fail("TC_COMPUTE_TYPE", output.id, "Output type differs from the kernel output type.");
      if (output.count !== kernel.count) fail("TC_COMPUTE_COUNT", output.id, "Output count differs from kernel count.");
      const bindings = input.bindings === undefined ? {} : input.bindings;
      if (!exact(bindings, (kernel.buffers ?? []).map(b => b.name))) fail("TC_COMPUTE_BINDING", kernel.id, "Bindings must match all and only declared input names.");
      const textureBindingsInput = input.textures === undefined ? {} : input.textures;
      if (!exact(textureBindingsInput, (kernel.textures ?? []).map(b => b.name))) fail("TC_COMPUTE_BINDING", kernel.id, "Textures must match all and only declared sampled texture names.");
      const involved = new Set([output]);
      const dependencies = new Set<Task>(), taskBindings = new Map<string, Task>(), textureBindings = new Map<string, Task>();
      if (input.after !== undefined) {
        if (!dense(input.after)) fail("TC_COMPUTE_DEPENDENCY", kernel.id + ":after", "Expected a dense array of earlier task handles.");
        for (const [i, handle] of input.after.entries()) dependencies.add(dependency(handle, kernel.id + ":after[" + i + "]"));
      }
      const inputs: Record<string, ComputeExecutionInput> = {}, textures: Record<string, ComputeExecutionInput> = {};
      const bind = (name: string, value: unknown, isTexture: boolean, type: GraphType) => {
        const at = kernel.id + ":" + name;
        let b: Buffer;
        if (value && typeof value === "object" && (Object.hasOwn(value, "task") || Object.hasOwn(value, "id"))) {
          if (!exact(value, ["task"])) return fail("TC_COMPUTE_DEPENDENCY", at, "Expected only a task handle in a task-result binding.");
          const predecessor = dependency(value.task, at);
          b = predecessor.source ?? fail("TC_COMPUTE_DEPENDENCY_RESOURCE", at, "Task " + predecessor.handle.id + " output resource was released or invalidated.");
          if (!live(b)) fail("TC_COMPUTE_DEPENDENCY_RESOURCE", at, "Task " + predecessor.handle.id + " output resource is no longer live.");
          if (!!b.texture !== isTexture) fail("TC_COMPUTE_TYPE", at, "Task result resource kind differs from its declaration.");
          dependencies.add(predecessor);
          (isTexture ? textureBindings : taskBindings).set(name, predecessor);
        } else {
          b = resourceHandle(value, isTexture);
          (isTexture ? textures : inputs)[name] = Object.freeze({ ...descriptor(b), captured: true as const });
        }
        if (b.type !== type) fail("TC_COMPUTE_TYPE", at, "Input resource type differs from its declaration.");
        involved.add(b);
      };
      for (const binding of kernel.buffers ?? []) bind(binding.name, bindings[binding.name], false, binding.type);
      for (const binding of kernel.textures ?? []) bind(binding.name, textureBindingsInput[binding.name], true, "vec4");
      const supplied = input.parameters === undefined ? {} : input.parameters, declared = kernel.graph.parameters ?? [];
      if (!plain(supplied) || Object.keys(supplied).some(name => !declared.some(p => p.name === name)))
        fail("TC_COMPUTE_PARAMETER", kernel.id, "Unknown parameters or invalid parameter record.");
      const parameters = Object.fromEntries(declared.map(p => [p.name, checked(p.type, Object.hasOwn(supplied, p.name) ? supplied[p.name] : p.default, "TC_COMPUTE_PARAMETER", `${kernel.id}:${p.name}`)]));
      let time: unknown, capabilities;
      try { time = input.time === undefined ? options.time ? options.time() : 0 : input.time; }
      catch { return fail("TC_COMPUTE_TIME", kernel.id, "Simulation time provider failed."); }
      if (typeof time !== "number" || !Number.isFinite(time) || !Number.isFinite(Math.fround(time)))
        return fail("TC_COMPUTE_TIME", kernel.id, "Expected finite f32 simulation time.");
      try { capabilities = options.capabilities(); }
      catch { return fail("TC_COMPUTE_CAPABILITY", kernel.id, "Capability provider failed."); }
      if (capabilities?.backend !== "webgpu" || !capabilities.compute || !executor)
        fail("TC_COMPUTE_CAPABILITY", kernel.id, "Managed dispatch requires real WebGPU compute and an executor; no CPU fallback is available.");
      const controller = new AbortController(), handle = Object.freeze({ owner, id: nextTask++ });
      const request = Object.freeze({ kernel, inputs: Object.freeze(inputs), ...(kernel.textures !== undefined ? { textures: Object.freeze(textures) } : {}), output: Object.freeze({ key: output.key, type: output.type, count: output.count, ...(output.texture ? { texture: output.texture } : {}), ...(typeof executor?.commit === "function" ? { retain: true } : {}) }), parameters: Object.freeze(parameters), time, signal: controller.signal });
      const t: Task = { handle, state: { status: "queued" }, request, buffers: involved, output, source: output, dependencies, taskBindings, textureBindings, consumers: 0, controller, epoch };
      for (const b of involved) b.busy++;
      for (const predecessor of dependencies) predecessor.consumers++;
      tasks.set(handle.id, t);
      queue.push(t);
      return handle;
    },
    task(handle) { return structuredClone(task(handle).state); },
    tasks() {
      active();
      return [...tasks.values()].map(t => ({ handle: { ...t.handle }, state: structuredClone(t.state) }));
    },
    cancel(handle) { cancel(task(handle)); },
    releaseTask(handle) {
      const t = task(handle);
      if (t.consumers) fail("TC_COMPUTE_TASK_IN_USE", String(handle.id), "Unfinished consumers still reference this task.");
      if (unfinished(t)) fail("TC_COMPUTE_BUSY", String(handle.id), "Only terminal tasks can be released; flush or cancel first.");
      tasks.delete(handle.id);
      queue = queue.filter(entry => entry !== t);
      t.result = undefined;
      t.source = undefined;
      collectIfIdle();
    },
  };
  const run = async (t: Task) => {
    if (!unfinished(t) || t.epoch !== epoch || disposed) return;
    t.state = { status: "running" };
    const runner = executor!, pending = t.request!, output = t.output!;
    const current = () => !t.controller.signal.aborted && t.epoch === epoch && !disposed && unfinished(t);
    const aborted = Symbol("cancelled");
    let onAbort!: () => void;
    const cancellation = new Promise<typeof aborted>(resolve => { onAbort = () => resolve(aborted); });
    t.controller.signal.addEventListener("abort", onAbort, { once: true });
    let submitted = false;
    try {
      for (const predecessor of t.dependencies) if (predecessor.state.status !== "succeeded")
        fail("TC_COMPUTE_DEPENDENCY_FAILED", pending.kernel.id + ":task " + predecessor.handle.id, "Predecessor is " + predecessor.state.status + "; successful completion is required.");
      const inputs = { ...pending.inputs }, textures = { ...pending.textures };
      const resolveResults = (bindings: Map<string, Task>, target: Record<string, ComputeExecutionInput>) => {
        for (const [name, predecessor] of bindings) {
          const result = predecessor.result;
          if (!result || !live(result.source))
            return fail("TC_COMPUTE_DEPENDENCY_RESOURCE", pending.kernel.id + ":" + name + ":task " + predecessor.handle.id, "Predecessor output resource is no longer live.");
          target[name] = result.input;
        }
      };
      resolveResults(t.taskBindings, inputs);
      resolveResults(t.textureBindings, textures);
      const request = Object.freeze({ ...pending, inputs: Object.freeze(inputs), ...(pending.textures !== undefined ? { textures: Object.freeze(textures) } : {}) });
      submitted = true;
      // Racing cancellation also observes late rejections from executors that ignore abort.
      const result = await Promise.race([runner.run(request), cancellation]);
      if (result === aborted || !current()) return;
      const staged = values(output.type, result, "TC_COMPUTE_RESULT", output.id);
      if (staged.length !== output.count) fail("TC_COMPUTE_RESULT", output.id, "Executor returned the wrong output count.");
      if (!current()) return;
      if (typeof runner.commit === "function") runner.commit(output.key, output.revision + 1);
      if (!current()) return;
      output.values = staged;
      output.revision++;
      t.result = Object.freeze({ source: output, input: descriptor(output) });
      finish(t, { status: "succeeded" });
    } catch (error) {
      if (t.epoch === epoch && !disposed && unfinished(t)) finish(t, { status: "failed", error: failure(error, pending.kernel.id) });
    } finally {
      t.controller.signal.removeEventListener("abort", onAbort);
      if (submitted) cleanup(() => runner.discard?.(output.key));
    }
  };
  const flush = (): Promise<void> => {
    active();
    if (flushing) return flushing;
    flushing = (async () => {
      while (!disposed && queue.length) await run(queue.shift()!);
      if (!disposed) collect();
    })().finally(() => { flushing = undefined; });
    return flushing;
  };
  const validateSnapshot = (value: unknown) => {
    idle();
    const code = "TC_COMPUTE_SNAPSHOT";
    if (!exact(value, ["version", "kernels", "buffers"]) || value.version !== 1 || JSON.stringify(canonical(value.kernels, code)) !== definitionText || !dense(value.buffers))
      return fail(code, "snapshot", "Incompatible snapshot or kernel definitions.");
    const ids = new Set<string>();
    return value.buffers.map(entry => {
      if (!exact(entry, plain(entry) && Object.hasOwn(entry, "texture") ? ["id", "type", "count", "data", "texture"] : ["id", "type", "count", "data"]) || typeof entry.id !== "string" || !entry.id.trim() || ids.has(entry.id) || !isGraphType(entry.type) || !countOK(entry.count))
        return fail(code, "buffers", "Invalid buffer definition or duplicate name.");
      ids.add(entry.id);
      const texture = Object.hasOwn(entry, "texture") ? textureSize(entry.texture, code, entry.id) : undefined;
      if (texture && (entry.type !== "vec4" || entry.count !== texture.width * texture.height))
        return fail(code, entry.id, "Texture snapshots require vec4 data matching their dimensions.");
      const data = values(entry.type, entry.data, code, entry.id);
      if (data.length !== entry.count) return fail(code, entry.id, "Buffer data count mismatch.");
      return { id: entry.id, type: entry.type, count: entry.count, data, ...(texture ? { texture } : {}) };
    });
  };
  const invalidate = () => {
    epoch++;
    for (const t of tasks.values()) {
      cancel(t);
      // Executor history and restored generations cannot back old task results.
      t.result = undefined;
      t.source = undefined;
    }
    queue = [];
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    invalidate();
    buffers.clear(); names.clear(); tasks.clear(); renderPins.clear();
    free.length = generations.length = 0;
    const old = executor;
    executor = undefined;
    if (old) cleanup(() => old.dispose());
    cleanup(() => options.textureAssets?.dispose());
  };
  const inspect = () => ({
    owner, disposed, buffers: buffers.size, tasks: tasks.size,
    queued: [...tasks.values()].filter(t => t.state.status === "queued").length,
    running: [...tasks.values()].filter(t => t.state.status === "running").length,
    busyBuffers: [...buffers.values()].filter(b => b.busy > 0).length,
    executor: !!executor, cleanupErrors,
  });
  const factory: RuntimePluginFactory = () => ({
    id: "$engine.compute", version: "1", services: { compute: service }, settle: flush,
    snapshot() {
      idle();
      return { version: 1, kernels: JSON.parse(definitionText), buffers: [...names.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0).map(b => ({ id: b.id, type: b.type, count: b.count, data: structuredClone(b.values), ...(b.texture ? { texture: { ...b.texture } } : {}) })) };
    },
    validateSnapshot(value) { validateSnapshot(value); },
    restore(value) {
      const staged = validateSnapshot(value);
      invalidate();
      const old = [...buffers.values()], current = executor;
      buffers.clear(); names.clear(); tasks.clear();
      free.length = generations.length = 0;
      owner = nextOwner++;
      for (const b of staged) addBuffer(b.id, b.type, b.count, b.data, b.texture);
      if (current) for (const b of old) cleanup(() => current.release(b.key));
    },
    dispose, inspect,
  });
  if (options.buffers !== undefined) {
    if (!dense(options.buffers)) fail("TC_COMPUTE_BUFFER", "buffers", "Expected a dense initial buffer definitions array.");
    for (const input of options.buffers) service.createBuffer(input);
  }
  if (options.textures !== undefined) {
    if (!dense(options.textures)) fail("TC_COMPUTE_TEXTURE", "textures", "Expected a dense initial texture definitions array.");
    for (const input of options.textures) service.createTexture(input);
  }
  return {
    service, factory, flush, dispose, inspect,
    resource(id) {
      active();
      const b = names.get(id) ?? fail("TC_COMPUTE_BUFFER_NAME", String(id), "Unknown buffer name.");
      if (b.texture) return fail("TC_COMPUTE_BUFFER_NAME", String(id), "Expected a buffer; this name belongs to a texture.");
      return freeze({ ...descriptor(b), values: structuredClone(b.values) });
    },
    textureResource(id): ComputeExecutionInput {
      active();
      const b = names.get(id);
      if (!b?.texture) return fail("TC_COMPUTE_TEXTURE_NAME", String(id), "Unknown texture name.");
      return freeze({ ...descriptor(b), values: structuredClone(b.values) });
    },
    setRenderPins(ids) {
      if (!dense(ids) || ids.some(id => typeof id !== "string" || !id.trim()))
        fail("TC_COMPUTE_BUFFER_NAME", "render pins", "Expected a dense array of nonempty logical buffer IDs.");
      // Render restores first after Host preflight; the logical names may arrive later.
      if (ids.length) active();
      const next = new Map<string, number>();
      for (const id of ids) next.set(id, (next.get(id) ?? 0) + 1);
      renderPins = next;
    },
    replaceExecutor(next) {
      active();
      invalidate();
      const old = executor;
      executor = next;
      if (old && old !== next) cleanup(() => old.dispose());
      else if (old) for (const b of buffers.values()) cleanup(() => old.release(b.key));
    },
  };
}
