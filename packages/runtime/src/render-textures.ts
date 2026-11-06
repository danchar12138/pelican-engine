import type { MaterialTextureInput, RenderTextureBindings, RenderTextureReference } from "../../sdk/src/index.ts";
import { isGraphType } from "../../sdk/src/graph-values.ts";
import type { ComputeExecutionInput } from "./compute-contract.ts";
import type { RenderTextureProvider } from "./render-texture-contract.ts";

type Slot = Required<Pick<MaterialTextureInput, "name" | "filter" | "wrapU" | "wrapV">> & Pick<MaterialTextureInput, "width" | "height">;
type Definition = { id: string; textures: Slot[] };
type Bindings = Record<string, Record<string, RenderTextureReference>>;
export interface RenderTextureSnapshot {
  version: 1;
  definitions: Definition[];
  bindings: Bindings;
}
export type RenderTexturePeerSnapshots = Readonly<Record<string, { version?: string; payload: unknown }>>;
type Code = `TC_RENDER_TEXTURE_${string}`;
const remediation = "Use declared material/pass and texture slot names, live managed rgba32float texture handles with matching dimensions, and matching render/compute snapshots; bind required slots before rendering and create a new owner after disposal.";
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
const nameOK = (value: unknown): value is string => typeof value === "string" && !!value.trim();
const countOK = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0 && (value as number) <= 0xffffffff;
// Match the compute owner's texture extent limit, including constraints on a single axis.
const dimensionOK = (value: unknown): value is number => countOK(value) && value <= 2 ** 24;
const sizeOK = (value: unknown): value is { width: number; height: number } =>
  exact(value, ["width", "height"]) && dimensionOK(value.width) && dimensionOK(value.height) && value.width * value.height <= 2 ** 24;
const texelsOK = (value: unknown, count: number): value is ComputeExecutionInput["values"] =>
  dense(value) && value.length === count && value.every(texel => dense(texel) && texel.length === 4 &&
    texel.every(component => typeof component === "number" && Number.isFinite(component) && Number.isFinite(Math.fround(component))));
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const copyReferences = (entries: Record<string, RenderTextureReference>) =>
  Object.fromEntries(Object.entries(entries).sort(([a], [b]) => compare(a, b)).map(([name, ref]) => [name, { ...ref }]));
const pins = (bindings: Bindings): string[] => [...new Set(Object.values(bindings).flatMap(slots => Object.values(slots).map(ref => ref.id)))].sort(compare);
const same = (a: Bindings, b: Bindings): boolean => Object.keys(a).every(id => {
  const left = a[id]!, right = b[id]!;
  return Object.keys(left).length === Object.keys(right).length && Object.entries(left).every(([name, ref]) =>
    Object.hasOwn(right, name) && ref.id === right[name]!.id && ref.width === right[name]!.width && ref.height === right[name]!.height && ref.format === right[name]!.format);
});

/** CPU slot owner. Snapshots and pins contain logical IDs, never native textures. */
export function createRenderTextureOwner(
  materials: readonly { id: string; textures?: readonly MaterialTextureInput[] }[] = [],
  provider?: RenderTextureProvider,
) {
  const definitions = new Map<string, Slot[]>();
  const initial: { material: string; name: string; id: string }[] = [];
  if (!dense(materials)) fail("TC_RENDER_TEXTURE_DEFINITION", "*:*", "Expected a dense materials/passes array.");
  for (const material of materials) {
    if (!plain(material) || typeof material.id !== "string" || !/^[a-zA-Z][a-zA-Z0-9_.-]*$/.test(material.id) || definitions.has(material.id))
      fail("TC_RENDER_TEXTURE_DEFINITION", "*:*", "Expected a unique valid material/pass ID.");
    const id = material.id, slots: Slot[] = [], names = new Set<string>();
    const source = material.textures === undefined ? [] : material.textures;
    if (!dense(source)) fail("TC_RENDER_TEXTURE_DEFINITION", `${id}:*`, "Expected a dense texture slots array.");
    for (const entry of source) {
      const at = `${id}:*`;
      if (!plain(entry) || Object.keys(entry).some(key => !["name", "filter", "wrapU", "wrapV", "texture", "width", "height"].includes(key)) ||
          !nameOK(entry.name) || names.has(entry.name) || (entry.texture !== undefined && !nameOK(entry.texture)) ||
          (entry.filter !== undefined && entry.filter !== "nearest" && entry.filter !== "linear") ||
          (entry.wrapU !== undefined && entry.wrapU !== "clamp" && entry.wrapU !== "repeat" && entry.wrapU !== "mirror") ||
          (entry.wrapV !== undefined && entry.wrapV !== "clamp" && entry.wrapV !== "repeat" && entry.wrapV !== "mirror") ||
          (entry.width !== undefined && !dimensionOK(entry.width)) || (entry.height !== undefined && !dimensionOK(entry.height)) ||
          (entry.width !== undefined && entry.height !== undefined && entry.width * entry.height > 2 ** 24))
        fail("TC_RENDER_TEXTURE_DEFINITION", at, "Expected unique texture slots, valid samplers, optional logical IDs and positive integer dimensions with at most 2^24 texels.");
      names.add(entry.name);
      slots.push({ name: entry.name, filter: entry.filter ?? "linear", wrapU: entry.wrapU ?? "clamp", wrapV: entry.wrapV ?? "clamp",
        ...(entry.width === undefined ? {} : { width: entry.width }), ...(entry.height === undefined ? {} : { height: entry.height }) });
      if (entry.texture !== undefined) initial.push({ material: id, name: entry.name, id: entry.texture });
    }
    definitions.set(id, slots.sort((a, b) => compare(a.name, b.name)));
  }
  const canonical: Definition[] = [...definitions].filter(([, slots]) => slots.length).sort(([a], [b]) => compare(a, b))
    .map(([id, textures]) => ({ id, textures }));
  let bindings: Bindings = Object.fromEntries(canonical.map(d => [d.id, {}]));
  let disposed = false, revision = 0;
  const active = () => {
    if (disposed) fail("TC_RENDER_TEXTURE_DISPOSED", "*:*", "Render texture owner is disposed.");
  };
  const material = (id: string): Slot[] => {
    active();
    return definitions.get(id) ?? fail("TC_RENDER_TEXTURE_MATERIAL", `${id}:*`, "Unknown material/pass.");
  };
  const slot = (id: string, name: string): Slot => material(id).find(s => s.name === name) ??
    fail("TC_RENDER_TEXTURE_SLOT", `${id}:${name}`, "Unknown texture slot.");
  const withProvider = <T>(at: string, action: (p: RenderTextureProvider) => T): T => {
    if (!provider) return fail("TC_RENDER_TEXTURE_PROVIDER", at, "A compute texture provider is required for binding resources.");
    try { return action(provider); }
    catch (error) { return fail("TC_RENDER_TEXTURE_PROVIDER", at, error instanceof Error ? error.message : "Compute provider rejected the operation."); }
  };
  const reference = (value: unknown, expected: Pick<Slot, "width" | "height">, at: string, code?: Code): RenderTextureReference => {
    const keys = ["id", "width", "height", "format"];
    // describeTexture may additionally report its revision; it is never part of a logical reference.
    if (!exact(value, code === undefined && plain(value) && Object.hasOwn(value, "revision") ? [...keys, "revision"] : keys) ||
        !nameOK(value.id) || value.format !== "rgba32float" || !sizeOK({ width: value.width, height: value.height }) ||
        (Object.hasOwn(value, "revision") && (!Number.isSafeInteger(value.revision) || (value.revision as number) < 0)))
      return fail(code ?? "TC_RENDER_TEXTURE_REFERENCE", at, "Expected a logical rgba32float texture ID and valid width/height.");
    if ((expected.width !== undefined && value.width !== expected.width) || (expected.height !== undefined && value.height !== expected.height))
      fail(code ?? "TC_RENDER_TEXTURE_SIZE", at, `Texture ${value.id} does not match the slot's required width/height.`);
    return { id: value.id, width: value.width as number, height: value.height as number, format: "rgba32float" };
  };
  const resource = (id: string, expected: Pick<Slot, "width" | "height">, at: string): ComputeExecutionInput => {
    const result = withProvider(at, p => p.resource(id));
    if (!exact(result, ["key", "type", "revision", "values", "texture"]) || !nameOK(result.key) || result.type !== "vec4" ||
        !Number.isSafeInteger(result.revision) || (result.revision as number) < 0 || !sizeOK(result.texture) ||
        !texelsOK(result.values, result.texture.width * result.texture.height))
      return fail("TC_RENDER_TEXTURE_RESOURCE", at, `Expected a managed vec4 texture descriptor with finite f32 texels matching its dimensions for ${id}.`);
    reference({ id, ...result.texture, format: "rgba32float" }, expected, at);
    return result as unknown as ComputeExecutionInput;
  };
  const publishPins = (next: readonly string[]) => {
    const previous = pins(bindings);
    if (provider) withProvider("pins", p => {
      try { p.setPins(next); }
      catch (error) {
        // Restore providers that changed their pin set before rejecting publication.
        try { p.setPins(previous); } catch { /* Preserve the original provider failure. */ }
        throw error;
      }
    });
    else if (next.length) fail("TC_RENDER_TEXTURE_PROVIDER", "pins", "A compute texture provider is required for bound slots.");
  };
  const publish = (next: Bindings) => {
    if (same(bindings, next)) return;
    publishPins(pins(next));
    bindings = next;
    revision++;
  };
  // Resolve every initial descriptor and its data before publishing even the first pin.
  const initialBindings: Bindings = Object.fromEntries(canonical.map(d => [d.id, {}]));
  for (const entry of initial) {
    const expected = slot(entry.material, entry.name), at = `${entry.material}:${entry.name}`;
    const found = resource(entry.id, expected, at);
    Object.defineProperty(initialBindings[entry.material]!, entry.name, {
      value: { id: entry.id, ...found.texture!, format: "rgba32float" }, enumerable: true, writable: true, configurable: true,
    });
  }
  publish(initialBindings);
  revision = 0;

  const validate = (value: unknown): Bindings => {
    active();
    const code = "TC_RENDER_TEXTURE_SNAPSHOT";
    const bad = (at = "*:*", detail = "Incompatible render texture snapshot."): never => fail(code, at, detail);
    if (!canonical.length && value === undefined) return {};
    if (!canonical.length || !exact(value, ["version", "definitions", "bindings"]) || value.version !== 1 || !dense(value.definitions) ||
        value.definitions.length !== canonical.length || !exact(value.bindings, canonical.map(d => d.id))) return bad();
    const staged: Bindings = {};
    for (let i = 0; i < canonical.length; i++) {
      const expected = canonical[i]!, actual = value.definitions[i], at = `${expected.id}:*`;
      if (!exact(actual, ["id", "textures"]) || actual.id !== expected.id || !dense(actual.textures) || actual.textures.length !== expected.textures.length) return bad(at);
      const entries = value.bindings[expected.id];
      if (!plain(entries) || Object.keys(entries).some(name => !expected.textures.some(s => s.name === name))) return bad(at);
      const checked: [string, RenderTextureReference][] = [];
      for (let j = 0; j < expected.textures.length; j++) {
        const s = expected.textures[j]!, declaration = actual.textures[j], location = `${expected.id}:${s.name}`;
        const keys = Object.keys(s);
        if (!exact(declaration, keys) || keys.some(key => declaration[key] !== s[key as keyof Slot])) return bad(location);
        if (Object.hasOwn(entries, s.name)) checked.push([s.name, reference(entries[s.name], s, location, code)]);
      }
      Object.defineProperty(staged, expected.id, { value: Object.fromEntries(checked), enumerable: true, writable: true, configurable: true });
    }
    return staged;
  };
  const service: RenderTextureBindings = {
    bind(id, name, handle) {
      const expected = slot(id, name), at = `${id}:${name}`;
      if (!exact(handle, ["owner", "index", "generation", "kind"]) || handle.kind !== "texture" ||
          !Number.isSafeInteger(handle.owner) || handle.owner <= 0 || !Number.isSafeInteger(handle.index) || handle.index < 0 ||
          !Number.isSafeInteger(handle.generation) || handle.generation <= 0)
        fail("TC_RENDER_TEXTURE_HANDLE", at, "Expected a managed texture handle; ordinary buffers cannot bind to texture slots.");
      const ref = reference(withProvider(at, p => p.describe(handle)), expected, at);
      publish({ ...bindings, [id]: { ...bindings[id], [name]: ref } });
    },
    unbind(id, name) {
      slot(id, name);
      const next = copyReferences(bindings[id]!);
      delete next[name];
      publish({ ...bindings, [id]: next });
    },
    state(id) {
      material(id);
      return Object.freeze(Object.fromEntries(Object.entries(bindings[id] ?? {}).map(([name, ref]) => [name, Object.freeze({ ...ref })])));
    },
  };
  return {
    service,
    resources(id: string): Readonly<Record<string, ComputeExecutionInput>> {
      const slots = material(id);
      // Missing slots take precedence over temporarily absent compute resources during restore.
      for (const s of slots) if (!Object.hasOwn(bindings[id]!, s.name)) fail("TC_RENDER_TEXTURE_UNBOUND", `${id}:${s.name}`, "Bind this declared slot before rendering the material/pass.");
      return Object.freeze(Object.fromEntries(slots.map(s => {
        const ref = bindings[id]![s.name]!, at = `${id}:${s.name}`;
        const current = resource(ref.id, ref, at);
        return [s.name, Object.freeze({ key: current.key, type: current.type, revision: current.revision,
          texture: Object.freeze({ ...current.texture! }),
          values: Object.freeze(current.values.map(value => Object.freeze([...(value as readonly number[])]))) as ComputeExecutionInput["values"] })];
      })));
    },
    snapshot(): RenderTextureSnapshot | undefined {
      active();
      if (!canonical.length) return undefined;
      return { version: 1, definitions: structuredClone(canonical), bindings: Object.fromEntries(canonical.map(d => [d.id, copyReferences(bindings[d.id]!)])) };
    },
    validateSnapshot(value: unknown): void { validate(value); },
    validatePeerSnapshot(value: unknown, peers: RenderTexturePeerSnapshots): void {
      const staged = validate(value);
      if (!Object.values(staged).some(entries => Object.keys(entries).length)) return;
      const code = "TC_RENDER_TEXTURE_PEER_SNAPSHOT";
      const bad = (at: string, detail: string): never => fail(code, at, detail);
      if (!plain(peers) || !Object.hasOwn(peers, "$engine.compute")) return bad("$engine.compute", "Missing compute snapshot for bound texture slots.");
      const peer = peers["$engine.compute"];
      if (!plain(peer) || !plain(peer.payload) || !dense(peer.payload.buffers)) return bad("$engine.compute", "Expected compute snapshot buffers with texture metadata.");
      const available = new Map<string, RenderTextureReference>(), names = new Set<string>();
      for (const entry of peer.payload.buffers) {
        const isTexture = plain(entry) && Object.hasOwn(entry, "texture");
        if (!exact(entry, isTexture ? ["id", "type", "count", "data", "texture"] : ["id", "type", "count", "data"]) ||
            !nameOK(entry.id) || !isGraphType(entry.type) || !countOK(entry.count) || names.has(entry.id) || !dense(entry.data) || entry.data.length !== entry.count)
          return bad("$engine.compute", "Invalid or duplicate compute resource descriptor.");
        names.add(entry.id);
        if (isTexture) {
          if (entry.type !== "vec4" || !sizeOK(entry.texture) || entry.count !== entry.texture.width * entry.texture.height || !texelsOK(entry.data, entry.count))
            return bad(entry.id, "Texture snapshots require vec4 finite f32 texels matching width, height and count.");
          available.set(entry.id, { id: entry.id, ...entry.texture, format: "rgba32float" });
        }
      }
      for (const [id, entries] of Object.entries(staged)) for (const [name, ref] of Object.entries(entries)) {
        const peerRef = available.get(ref.id);
        if (!peerRef || peerRef.width !== ref.width || peerRef.height !== ref.height || peerRef.format !== ref.format)
          return bad(`${id}:${name}`, `Compute snapshot must contain managed rgba32float texture ${ref.id} with dimensions ${ref.width}x${ref.height}.`);
      }
    },
    restore(value: unknown): void { publish(validate(value)); },
    dispose(): void {
      if (disposed) return;
      publishPins([]);
      bindings = {};
      disposed = true;
    },
    inspect(): { materials: number; slots: number; bound: number; pins: number; revision: number } {
      active();
      return { materials: definitions.size, slots: canonical.reduce((n, d) => n + d.textures.length, 0),
        bound: Object.values(bindings).reduce((n, entries) => n + Object.keys(entries).length, 0), pins: pins(bindings).length, revision };
    },
  };
}
