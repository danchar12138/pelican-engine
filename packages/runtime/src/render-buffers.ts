import type { MaterialBufferInput, RenderBufferBindings, RenderBufferReference } from "../../sdk/src/index.ts";
import { isGraphType } from "../../sdk/src/graph-values.ts";
import type { ComputeExecutionInput } from "./compute-contract.ts";
import type { RenderBufferProvider } from "./render-buffer-contract.ts";

type Slot = Omit<MaterialBufferInput, "buffer">;
type Definition = { id: string; buffers: Slot[] };
type Bindings = Record<string, Record<string, RenderBufferReference>>;
export interface RenderBufferSnapshot {
  version: 1;
  definitions: Definition[];
  bindings: Bindings;
}
export type RenderBufferPeerSnapshots = Readonly<Record<string, { version?: string; payload: unknown }>>;
type Code = `TC_RENDER_BUFFER_${string}`;
const remediation = "Use declared material/pass and slot names, live compute handles with matching types/counts, and matching render/compute snapshots; bind required slots before rendering and create a new owner after disposal.";
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
const nameOK = (value: unknown): value is string => typeof value === "string" && !!value.trim();
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const copyReferences = (entries: Record<string, RenderBufferReference>) =>
  Object.fromEntries(Object.entries(entries).sort(([a], [b]) => compare(a, b)).map(([name, ref]) => [name, { ...ref }]));
const pins = (bindings: Bindings): string[] => [...new Set(Object.values(bindings).flatMap(slots => Object.values(slots).map(ref => ref.id)))].sort(compare);
const same = (a: Bindings, b: Bindings): boolean => Object.keys(a).every(id => {
  const left = a[id]!, right = b[id]!;
  return Object.keys(left).length === Object.keys(right).length && Object.entries(left).every(([name, ref]) =>
    Object.hasOwn(right, name) && ref.id === right[name]!.id && ref.type === right[name]!.type && ref.count === right[name]!.count);
});

/** CPU slot owner. Only logical references survive snapshots and compute-owner restore. */
export function createRenderBufferOwner(
  materials: readonly { id: string; buffers?: readonly MaterialBufferInput[] }[] = [],
  provider?: RenderBufferProvider,
) {
  const definitions = new Map<string, Slot[]>();
  const initial: { material: string; name: string; id: string }[] = [];
  if (!dense(materials)) fail("TC_RENDER_BUFFER_DEFINITION", "*:*", "Expected a dense materials array.");
  for (const material of materials) {
    if (!plain(material) || typeof material.id !== "string" || !/^[a-zA-Z][a-zA-Z0-9_.-]*$/.test(material.id) || definitions.has(material.id))
      fail("TC_RENDER_BUFFER_DEFINITION", "*:*", "Expected a unique valid material ID.");
    const id = material.id, slots: Slot[] = [], names = new Set<string>();
    const source = material.buffers === undefined ? [] : material.buffers;
    if (!dense(source)) fail("TC_RENDER_BUFFER_DEFINITION", `${id}:*`, "Expected a dense slots array.");
    for (const entry of source) {
      const at = `${id}:*`;
      if (!plain(entry) || Object.keys(entry).some(key => !["name", "type", "buffer", "count"].includes(key)) ||
          !nameOK(entry.name) || names.has(entry.name) || !isGraphType(entry.type) ||
          (entry.count !== undefined && !countOK(entry.count)) || (entry.buffer !== undefined && !nameOK(entry.buffer)))
        fail("TC_RENDER_BUFFER_DEFINITION", at, "Expected unique slot names, graph types, optional logical IDs and positive uint32 counts.");
      names.add(entry.name);
      slots.push({ name: entry.name, type: entry.type, ...(entry.count === undefined ? {} : { count: entry.count }) });
      if (entry.buffer !== undefined) initial.push({ material: id, name: entry.name, id: entry.buffer });
    }
    definitions.set(id, slots.sort((a, b) => compare(a.name, b.name)));
  }
  const canonical: Definition[] = [...definitions].filter(([, slots]) => slots.length).sort(([a], [b]) => compare(a, b))
    .map(([id, buffers]) => ({ id, buffers }));
  let bindings: Bindings = Object.fromEntries(canonical.map(d => [d.id, {}]));
  let disposed = false, revision = 0;
  const active = () => {
    if (disposed) fail("TC_RENDER_BUFFER_DISPOSED", "*:*", "Render buffer owner is disposed.");
  };
  const material = (id: string): Slot[] => {
    active();
    return definitions.get(id) ?? fail("TC_RENDER_BUFFER_MATERIAL", `${id}:*`, "Unknown material.");
  };
  const slot = (id: string, name: string): Slot => material(id).find(s => s.name === name) ??
    fail("TC_RENDER_BUFFER_SLOT", `${id}:${name}`, "Unknown buffer slot.");
  const withProvider = <T>(at: string, action: (p: RenderBufferProvider) => T): T => {
    if (!provider) return fail("TC_RENDER_BUFFER_PROVIDER", at, "A compute buffer provider is required for binding resources.");
    try { return action(provider); }
    catch (error) { return fail("TC_RENDER_BUFFER_PROVIDER", at, error instanceof Error ? error.message : "Compute provider rejected the operation."); }
  };
  const reference = (value: unknown, expected: Slot, at: string, code?: Code): RenderBufferReference => {
    if (!plain(value) || (code !== undefined && !exact(value, ["id", "type", "count"])) || !nameOK(value.id) || !isGraphType(value.type) || !countOK(value.count))
      return fail(code ?? "TC_RENDER_BUFFER_REFERENCE", at, "Expected a logical buffer ID, graph type and positive uint32 count.");
    if (value.type !== expected.type) fail(code ?? "TC_RENDER_BUFFER_TYPE", at, `Expected ${expected.type}; received ${value.type} from ${value.id}.`);
    if (expected.count !== undefined && value.count !== expected.count) fail(code ?? "TC_RENDER_BUFFER_COUNT", at, `Expected exactly ${expected.count} elements; received ${value.count} from ${value.id}.`);
    return { id: value.id, type: value.type, count: value.count };
  };
  const resource = (id: string, expected: Slot, at: string): ComputeExecutionInput => {
    const result = withProvider(at, p => p.resource(id));
    if (!plain(result) || !nameOK(result.key) || !isGraphType(result.type) || !Number.isSafeInteger(result.revision) || result.revision < 0 || !Array.isArray(result.values))
      return fail("TC_RENDER_BUFFER_RESOURCE", at, `Invalid compute resource descriptor for ${id}.`);
    reference({ id, type: result.type, count: result.values.length }, expected, at);
    return result;
  };
  const publishPins = (next: readonly string[]) => {
    const previous = pins(bindings);
    if (provider) withProvider("pins", p => {
      try { p.setPins(next); }
      catch (error) {
        // Providers should reject atomically; also restore pins if a provider changed them before throwing.
        p.setPins(previous);
        throw error;
      }
    });
    else if (next.length) fail("TC_RENDER_BUFFER_PROVIDER", "pins", "A compute buffer provider is required for bound slots.");
  };
  const publish = (next: Bindings) => {
    if (same(bindings, next)) return;
    publishPins(pins(next));
    bindings = next;
    revision++;
  };
  // Resolve every initial resource before publishing any pins, so a late invalid slot leaves the provider untouched.
  const initialBindings: Bindings = Object.fromEntries(canonical.map(d => [d.id, {}]));
  for (const entry of initial) {
    const expected = slot(entry.material, entry.name), at = `${entry.material}:${entry.name}`;
    const found = resource(entry.id, expected, at);
    Object.defineProperty(initialBindings[entry.material]!, entry.name, { value: { id: entry.id, type: found.type, count: found.values.length }, enumerable: true, writable: true, configurable: true });
  }
  publish(initialBindings);
  revision = 0;

  const validate = (value: unknown): Bindings => {
    active();
    const code = "TC_RENDER_BUFFER_SNAPSHOT";
    const bad = (at = "*:*", detail = "Incompatible render buffer snapshot."): never => fail(code, at, detail);
    if (!canonical.length && value === undefined) return {};
    if (!canonical.length || !exact(value, ["version", "definitions", "bindings"]) || value.version !== 1 || !dense(value.definitions) || value.definitions.length !== canonical.length || !exact(value.bindings, canonical.map(d => d.id))) return bad();
    const staged: Bindings = {};
    for (let i = 0; i < canonical.length; i++) {
      const expected = canonical[i]!, actual = value.definitions[i], at = `${expected.id}:*`;
      if (!exact(actual, ["id", "buffers"]) || actual.id !== expected.id || !dense(actual.buffers) || actual.buffers.length !== expected.buffers.length) return bad(at);
      const entries = value.bindings[expected.id];
      if (!plain(entries) || Object.keys(entries).some(name => !expected.buffers.some(s => s.name === name))) return bad(at);
      const checked: [string, RenderBufferReference][] = [];
      for (let j = 0; j < expected.buffers.length; j++) {
        const s = expected.buffers[j]!, declaration = actual.buffers[j], location = `${expected.id}:${s.name}`;
        const keys = s.count === undefined ? ["name", "type"] : ["name", "type", "count"];
        if (!exact(declaration, keys) || declaration.name !== s.name || declaration.type !== s.type || declaration.count !== s.count) return bad(location);
        if (Object.hasOwn(entries, s.name)) checked.push([s.name, reference(entries[s.name], s, location, code)]);
      }
      Object.defineProperty(staged, expected.id, { value: Object.fromEntries(checked), enumerable: true, writable: true, configurable: true });
    }
    return staged;
  };
  const service: RenderBufferBindings = {
    bind(id, name, handle) {
      const expected = slot(id, name), at = `${id}:${name}`;
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
      // Check all slots first, even if an earlier bound resource is temporarily absent during restore.
      for (const s of slots) if (!Object.hasOwn(bindings[id]!, s.name)) fail("TC_RENDER_BUFFER_UNBOUND", `${id}:${s.name}`, "Bind this declared slot before rendering the material.");
      return Object.freeze(Object.fromEntries(slots.map(s => {
        const ref = bindings[id]![s.name]!, at = `${id}:${s.name}`;
        const current = resource(ref.id, s, at);
        reference({ id: ref.id, type: current.type, count: current.values.length }, { ...s, count: ref.count }, at);
        return [s.name, Object.freeze({ key: current.key, type: current.type, revision: current.revision,
          values: Object.freeze(current.values.map(value => Array.isArray(value) ? Object.freeze([...value]) : value)) as ComputeExecutionInput["values"] })];
      })));
    },
    snapshot(): RenderBufferSnapshot | undefined {
      active();
      if (!canonical.length) return undefined;
      return { version: 1, definitions: structuredClone(canonical), bindings: Object.fromEntries(canonical.map(d => [d.id, copyReferences(bindings[d.id]!)])) };
    },
    validateSnapshot(value: unknown): void { validate(value); },
    validatePeerSnapshot(value: unknown, peers: RenderBufferPeerSnapshots): void {
      const staged = validate(value), refs = Object.values(staged).flatMap(entries => Object.values(entries));
      if (!refs.length) return;
      const code = "TC_RENDER_BUFFER_PEER_SNAPSHOT";
      const bad = (at: string, detail: string): never => fail(code, at, detail);
      if (!plain(peers) || !Object.hasOwn(peers, "$engine.compute")) return bad("$engine.compute", "Missing compute snapshot for bound render slots.");
      const peer = peers["$engine.compute"];
      if (!plain(peer) || !plain(peer.payload) || !dense(peer.payload.buffers)) return bad("$engine.compute", "Expected compute snapshot buffers.");
      const available = new Map<string, RenderBufferReference>();
      const names = new Set<string>();
      for (const entry of peer.payload.buffers) {
        if (!plain(entry) || !nameOK(entry.id) || !isGraphType(entry.type) || !countOK(entry.count) || names.has(entry.id)) return bad("$engine.compute", "Invalid or duplicate compute buffer descriptor.");
        names.add(entry.id);
        if (!Object.hasOwn(entry, "texture")) available.set(entry.id, { id: entry.id, type: entry.type, count: entry.count });
      }
      for (const [id, entries] of Object.entries(staged)) for (const [name, ref] of Object.entries(entries)) {
        const peerRef = available.get(ref.id);
        if (!peerRef || peerRef.type !== ref.type || peerRef.count !== ref.count) return bad(`${id}:${name}`, `Compute snapshot must contain ${ref.id} with type ${ref.type} and count ${ref.count}.`);
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
      return { materials: definitions.size, slots: canonical.reduce((n, d) => n + d.buffers.length, 0),
        bound: Object.values(bindings).reduce((n, entries) => n + Object.keys(entries).length, 0), pins: pins(bindings).length, revision };
    },
  };
}
