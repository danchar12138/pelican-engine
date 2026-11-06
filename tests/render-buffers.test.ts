import test from "node:test";
import assert from "node:assert/strict";
import type { ComputeBufferHandle, GraphType, GraphValue, MaterialBufferInput, RenderBufferReference } from "../packages/sdk/src/index.ts";
import type { ComputeExecutionInput } from "../packages/runtime/src/compute-contract.ts";
import type { RenderBufferProvider } from "../packages/runtime/src/render-buffer-contract.ts";
import { createRenderBufferOwner, type RenderBufferSnapshot, type RenderBufferPeerSnapshots } from "../packages/runtime/src/render-buffers.ts";
import { createRenderSettingsDriver, DEFAULT_RENDER_SETTINGS } from "../packages/runtime/src/render-settings.ts";
import type { PostProcessIR } from "../packages/compiler/src/types.ts";

function fixture() {
  let owner = 1, next = 0, resourceCalls = 0, rejectPins = false;
  let pinned: string[] = [];
  const pinCalls: string[][] = [];
  const entries = new Map<string, { handle: ComputeBufferHandle; resource: ComputeExecutionInput }>();
  const provider: RenderBufferProvider = {
    describe(handle) {
      const entry = [...entries].find(([, e]) => e.handle.owner === handle?.owner && e.handle.index === handle?.index && e.handle.generation === handle?.generation);
      if (!entry) throw new Error("TC_COMPUTE_HANDLE: stale or foreign handle");
      const [id, { resource }] = entry;
      return { id, type: resource.type, count: resource.values.length, revision: resource.revision } as RenderBufferReference;
    },
    resource(id) {
      resourceCalls++;
      const entry = entries.get(id);
      if (!entry) throw new Error(`Missing resource ${id}`);
      return entry.resource;
    },
    setPins(ids) {
      pinCalls.push([...ids]);
      // Names only: restore may pin IDs that do not currently exist.
      pinned = [...ids];
      if (rejectPins) { rejectPins = false; throw new Error("Pin publication failed"); }
    },
  };
  const add = (id: string, type: GraphType = "vec3", values: readonly GraphValue[] = [[1, 2, 3], [4, 5, 6]]) => {
    const handle = { owner, index: next++, generation: 1 };
    entries.set(id, { handle, resource: { key: `${owner}:${handle.index}`, type, revision: 0, values: structuredClone(values) } });
    return handle;
  };
  return {
    provider, add, entries, pinCalls,
    pins: () => [...pinned], reads: () => resourceCalls,
    rejectNextPins: () => { rejectPins = true; },
    reset: () => { entries.clear(); owner++; next = 0; },
    peers: (): RenderBufferPeerSnapshots => ({ "$engine.compute": { version: "1", payload: { version: 1, buffers: [...entries].map(([id, e]) => ({ id, type: e.resource.type, count: e.resource.values.length, data: structuredClone(e.resource.values) })) } } }),
  };
}
const declarations = (buffer?: string): { id: string; buffers: MaterialBufferInput[] }[] => [
  { id: "mat", buffers: [{ name: "positions", type: "vec3", count: 2, ...(buffer === undefined ? {} : { buffer }) }] },
];
const saved = (owner: ReturnType<typeof createRenderBufferOwner>): RenderBufferSnapshot => {
  const value = owner.snapshot(); assert.ok(value); return value;
};
const error = (code: string, at?: string) => (value: unknown): boolean => {
  assert.ok(value instanceof Error);
  assert.equal((value as Error & { code: string }).code, code);
  assert.ok(value.message.includes("Repair:"));
  if (at) assert.ok(value.message.includes(at), value.message);
  return true;
};

test("initial bindings support every SDK graph type and publish deduplicated sorted pins", () => {
  const f = fixture();
  const values: [GraphType, GraphValue][] = [["float", 1], ["bool", true], ["vec2", [1, 2]], ["vec3", [1, 2, 3]], ["vec4", [1, 2, 3, 4]]];
  const buffers = values.map(([type, value]) => { f.add(type, type, [value]); return { name: type, type, count: 1, buffer: type }; });
  const owner = createRenderBufferOwner([{ id: "mat", buffers: [...buffers, { name: "shared", type: "vec3", buffer: "vec3" }] }], f.provider);
  assert.deepEqual(f.pins(), ["bool", "float", "vec2", "vec3", "vec4"]);
  assert.equal(f.pinCalls.length, 1);
  assert.equal(owner.inspect().bound, 6);
  assert.equal(owner.inspect().revision, 0);
  assert.deepEqual(owner.resources("mat").vec3!.values, [[1, 2, 3]]);
  assert.deepEqual(owner.service.state("mat").shared, { id: "vec3", type: "vec3", count: 1 });
});

test("no slots retain legacy snapshots and unbound slots need no provider until used", () => {
  const empty = createRenderBufferOwner([{ id: "mat" }]);
  assert.equal(empty.snapshot(), undefined);
  empty.validateSnapshot(undefined); empty.validatePeerSnapshot(undefined, {}); empty.restore(undefined);
  assert.deepEqual(empty.resources("mat"), {});
  assert.deepEqual(empty.service.state("mat"), {});
  const owner = createRenderBufferOwner(declarations());
  assert.deepEqual(owner.service.state("mat"), {});
  owner.validateSnapshot(saved(owner)); owner.validatePeerSnapshot(saved(owner), {});
  owner.service.unbind("mat", "positions");
  assert.throws(() => owner.resources("mat"), error("TC_RENDER_BUFFER_UNBOUND", "mat:positions"));
  assert.throws(() => owner.service.bind("mat", "positions", {} as never), error("TC_RENDER_BUFFER_PROVIDER"));
  assert.throws(() => createRenderBufferOwner(declarations("initial")), error("TC_RENDER_BUFFER_PROVIDER", "mat:positions"));
});

test("invalid definitions reject duplicates, sparse arrays, accessors and invalid counts/types", () => {
  const valid = { name: "positions", type: "vec3" };
  let reads = 0;
  const accessor = Object.defineProperty({ type: "vec3" }, "name", { get() { reads++; return "positions"; }, enumerable: true });
  const cases: unknown[] = [null, new Array(1), [{ id: "mat" }, { id: "mat" }], [{ id: "" }], [{ id: "mat", buffers: new Array(1) }],
    ...[null, accessor, { ...valid, type: "matrix" }, { ...valid, buffer: "" }, { ...valid, name: "" }, { ...valid, extra: true },
      ...[0, -1, 1.1, NaN, Infinity, 0x100000000].map(count => ({ ...valid, count }))].map(slot => [{ id: "mat", buffers: [slot] }]),
    [{ id: "mat", buffers: [valid, valid] }]];
  for (const input of cases) assert.throws(() => createRenderBufferOwner(input as never), error("TC_RENDER_BUFFER_DEFINITION"));
  assert.equal(reads, 0);
});

test("all initial bindings preflight before the first pin mutation", () => {
  for (const bad of ["missing", "type", "count"]) {
    const f = fixture(); f.add("ok");
    if (bad === "type") f.add("bad", "float", [1, 2]);
    if (bad === "count") f.add("bad", "vec3", [[1, 2, 3]]);
    const buffers = [{ name: "first", type: "vec3", buffer: "ok", count: 2 }, { name: "last", type: "vec3", buffer: "bad", count: 2 }] as MaterialBufferInput[];
    assert.throws(() => createRenderBufferOwner([{ id: "mat", buffers }], f.provider), /TC_RENDER_BUFFER_/);
    assert.deepEqual(f.pinCalls, []);
    assert.deepEqual(f.pins(), []);
  }
});

test("bind verifies material, slot, live handle, type and exact count without changing old pins/state", () => {
  const f = fixture(), old = f.add("old"), replacement = f.add("replacement"), wrongType = f.add("scalar", "float", [1, 2]), wrongCount = f.add("short", "vec3", [[1, 2, 3]]);
  const owner = createRenderBufferOwner(declarations("old"), f.provider), before = saved(owner), counts = owner.inspect();
  for (const [action, code] of [
    [() => owner.service.bind("missing", "positions", replacement), "MATERIAL"],
    [() => owner.service.bind("mat", "missing", replacement), "SLOT"],
    [() => owner.service.bind("mat", "positions", { ...replacement, owner: 99 }), "PROVIDER"],
    [() => owner.service.bind("mat", "positions", { ...replacement, generation: 2 }), "PROVIDER"],
    [() => owner.service.bind("mat", "positions", wrongType), "TYPE"],
    [() => owner.service.bind("mat", "positions", wrongCount), "COUNT"],
  ] as const) {
    assert.throws(action, error(`TC_RENDER_BUFFER_${code}`));
    assert.deepEqual(saved(owner), before); assert.deepEqual(f.pins(), ["old"]); assert.deepEqual(owner.inspect(), counts);
  }
  owner.service.bind("mat", "positions", old);
  assert.equal(f.pinCalls.length, 1);
  f.rejectNextPins();
  assert.throws(() => owner.service.bind("mat", "positions", replacement), error("TC_RENDER_BUFFER_PROVIDER"));
  assert.deepEqual(f.pins(), ["old"]); assert.deepEqual(saved(owner), before);
  owner.service.bind("mat", "positions", replacement);
  assert.deepEqual(f.pins(), ["replacement"]);
  assert.equal(owner.inspect().revision, 1);
});

test("shared references remain pinned until the last slot unbinds", () => {
  const f = fixture(); const h = f.add("shared");
  const owner = createRenderBufferOwner([{ id: "mat", buffers: [{ name: "a", type: "vec3" }, { name: "b", type: "vec3" }] }], f.provider);
  owner.service.bind("mat", "a", h); owner.service.bind("mat", "b", h);
  owner.service.unbind("mat", "a"); assert.deepEqual(f.pins(), ["shared"]);
  owner.service.unbind("mat", "b"); assert.deepEqual(f.pins(), []);
  const revision = owner.inspect().revision; owner.service.unbind("mat", "b"); assert.equal(owner.inspect().revision, revision);
  assert.throws(() => owner.service.unbind("mat", "unknown"), error("TC_RENDER_BUFFER_SLOT"));
});

test("resources refresh keys/revisions and return detached descriptors and nested values each frame", () => {
  const f = fixture(); f.add("data");
  const owner = createRenderBufferOwner(declarations("data"), f.provider), first = owner.resources("mat");
  const source = f.entries.get("data")!.resource;
  assert.notEqual(first.positions, source); assert.notEqual(first.positions!.values, source.values);
  assert.notEqual(first.positions!.values[0], source.values[0]);
  (source.values[0] as unknown as number[])[0] = 77; source.revision = 5; source.key = "rebuilt";
  assert.deepEqual(first.positions!.values[0], [1, 2, 3]);
  const second = owner.resources("mat");
  assert.equal(second.positions!.key, "rebuilt"); assert.equal(second.positions!.revision, 5);
  assert.deepEqual(second.positions!.values[0], [77, 2, 3]);
  const state = owner.service.state("mat");
  assert.deepEqual(Object.keys(state.positions!).sort(), ["count", "id", "type"]);
  assert.throws(() => { (state.positions as any).id = "other"; }, TypeError);
  source.type = "float";
  assert.throws(() => owner.resources("mat"), error("TC_RENDER_BUFFER_TYPE"));
});

test("snapshots sort declared materials/slots, omit initial sources and detach all input/output state", () => {
  const f = fixture(); f.add("old"); f.add("new");
  const defs: { id: string; source?: { file: string }; buffers?: MaterialBufferInput[] }[] = [{ id: "z", source: { file: "old.ts" }, buffers: [{ name: "z", type: "vec3" as const }, { name: "a", type: "vec3" as const, buffer: "old", count: 2 }] }, { id: "a", buffers: [{ name: "a", type: "vec3" as const }] }, { id: "empty" }];
  const owner = createRenderBufferOwner(defs, f.provider), before = saved(owner);
  assert.deepEqual(before.definitions.map(d => d.id), ["a", "z"]);
  assert.deepEqual(before.definitions[1]!.buffers.map(s => s.name), ["a", "z"]);
  assert.ok(!JSON.stringify(before).includes("old.ts"));
  assert.ok(!JSON.stringify(before.definitions).includes('"buffer":'));
  defs[0]!.buffers![1]!.buffer = "new"; defs[0]!.buffers![1]!.name = "changed";
  assert.deepEqual(saved(owner), before);
  before.bindings.z!.a!.id = "new"; before.definitions[1]!.buffers[0]!.name = "changed";
  assert.equal(owner.service.state("z").a!.id, "old");
  const other = createRenderBufferOwner([{ id: "z", buffers: [{ name: "a", type: "vec3", count: 2, buffer: "new" }, { name: "z", type: "vec3" }] }, { id: "a", buffers: [{ name: "a", type: "vec3" }] }], f.provider);
  other.validateSnapshot(saved(owner));
});

test("snapshot validation rejects malformed/canonical mismatches atomically without resource reads", () => {
  const f = fixture(); f.add("old");
  const owner = createRenderBufferOwner(declarations("old"), f.provider), before = saved(owner), reads = f.reads(), calls = f.pinCalls.length;
  const mutations: ((s: any) => void)[] = [
    s => { s.version = 2; }, s => { s.extra = true; }, s => { s.definitions = []; }, s => { s.definitions[0].id = "other"; },
    s => { s.definitions[0].buffers[0].count = 1; }, s => { s.definitions[0].buffers[0].buffer = "old"; },
    s => { s.bindings.other = {}; }, s => { delete s.bindings.mat; }, s => { s.bindings.mat.extra = s.bindings.mat.positions; },
    s => { s.bindings.mat.positions.type = "float"; }, s => { s.bindings.mat.positions.count = 1; },
    s => { s.bindings.mat.positions.count = Infinity; }, s => { s.bindings.mat.positions.id = ""; },
    s => { s.bindings.mat.positions.key = "native"; }, s => { s.definitions = new Array(1); },
    s => { Object.defineProperty(s.bindings.mat, "positions", { get() { throw new Error("must not execute"); }, enumerable: true }); },
    s => { s.bindings.mat = new Date(); }, s => { s.bindings.mat.positions = null; },
  ];
  for (const mutate of mutations) {
    const value = structuredClone(before); mutate(value);
    assert.throws(() => owner.validateSnapshot(value), error("TC_RENDER_BUFFER_SNAPSHOT"));
    assert.throws(() => owner.restore(value), error("TC_RENDER_BUFFER_SNAPSHOT"));
    assert.deepEqual(saved(owner), before);
  }
  assert.throws(() => owner.validateSnapshot(undefined), error("TC_RENDER_BUFFER_SNAPSHOT"));
  assert.equal(f.reads(), reads); assert.equal(f.pinCalls.length, calls);
});

test("canonical declaration ordering is enforced and unbound snapshot slots are valid", () => {
  const owner = createRenderBufferOwner([{ id: "z", buffers: [{ name: "b", type: "float" }, { name: "a", type: "float" }] }, { id: "a", buffers: [{ name: "a", type: "float" }] }]);
  const value = saved(owner); owner.validatePeerSnapshot(value, {}); owner.restore(value);
  const reversed = structuredClone(value); reversed.definitions.reverse();
  assert.throws(() => owner.validateSnapshot(reversed), error("TC_RENDER_BUFFER_SNAPSHOT"));
  const slots = structuredClone(value); slots.definitions[1]!.buffers.reverse();
  assert.throws(() => owner.validateSnapshot(slots), error("TC_RENDER_BUFFER_SNAPSHOT"));
});

test("peer validation checks every bound ref against checkpoint IDs/types/counts without mutation", () => {
  const f = fixture(); f.add("first"); f.add("last");
  const owner = createRenderBufferOwner([{ id: "mat", buffers: [{ name: "a", type: "vec3", buffer: "first" }, { name: "b", type: "vec3", buffer: "last" }, { name: "unbound", type: "bool" }] }], f.provider);
  const value = saved(owner), peers = f.peers(), beforePins = f.pinCalls.length, reads = f.reads(), stats = owner.inspect();
  owner.validatePeerSnapshot(value, peers);
  for (const kind of ["missing", "id", "type", "count", "duplicate", "malformed", "texture"]) {
    const bad = structuredClone(peers) as any;
    const entries = bad["$engine.compute"].payload.buffers;
    if (kind === "missing") delete bad["$engine.compute"];
    if (kind === "id") entries[1].id = "other";
    if (kind === "type") entries[1].type = "float";
    if (kind === "count") entries[1].count = 1;
    if (kind === "duplicate") entries.push(entries[0]);
    if (kind === "malformed") bad["$engine.compute"].payload.buffers = {};
    if (kind === "texture") entries[1].texture = { width: 2, height: 1 };
    assert.throws(() => owner.validatePeerSnapshot(value, bad), error("TC_RENDER_BUFFER_PEER_SNAPSHOT"));
  }
  assert.equal(f.pinCalls.length, beforePins); assert.equal(f.reads(), reads); assert.deepEqual(owner.inspect(), stats);
  assert.deepEqual(saved(owner), value);
});

test("restore accepts old logical names before compute restore, then resolves fresh identities", () => {
  const f = fixture(), oldHandle = f.add("old");
  const original = createRenderBufferOwner(declarations("old"), f.provider), value = saved(original), peers = f.peers();
  original.dispose(); f.reset(); f.add("new");
  const restored = createRenderBufferOwner(declarations("new"), f.provider), reads = f.reads();
  restored.validateSnapshot(value); restored.validatePeerSnapshot(value, peers); restored.restore(value);
  assert.equal(f.reads(), reads); assert.deepEqual(f.pins(), ["old"]);
  f.reset(); f.add("old");
  assert.equal(restored.resources("mat").positions!.key, "3:0");
  assert.throws(() => restored.service.bind("mat", "positions", oldHandle), error("TC_RENDER_BUFFER_PROVIDER"));
  assert.deepEqual(restored.service.state("mat").positions, { id: "old", type: "vec3", count: 2 });
  (value.bindings.mat!.positions as any).id = "mutated";
  assert.equal(restored.service.state("mat").positions!.id, "old");
});

const effect: PostProcessIR = {
  id: "fx", enabled: true,
  graph: { nodes: [{ id: "color", op: "vec4", value: [1, 1, 1, 1] }], output: "color", outputType: "vec4", nodeTypes: { color: "vec4" }, parameters: [] },
  source: { file: "game.ts", line: 1, column: 1, length: 1 },
};

test("render driver exposes the owner and preserves exact legacy no-buffer/effect shapes", () => {
  const driver = createRenderSettingsDriver(), plugin = driver.factory({} as never);
  assert.equal(driver.service.buffers, driver.buffers.service);
  assert.deepEqual(plugin.snapshot(), { version: 1, defaults: { ...DEFAULT_RENDER_SETTINGS }, settings: { ...DEFAULT_RENDER_SETTINGS } });
  plugin.validatePeers(plugin.snapshot(), {}); plugin.restore(plugin.snapshot());
  const effects = createRenderSettingsDriver({}, [], undefined, [effect]);
  assert.deepEqual(Object.keys(effects.factory({} as never).snapshot()).sort(), ["defaults", "postProcesses", "settings", "version"]);
});

test("driver preflights all owners before settings/parameter/effect/pin writes", () => {
  const f = fixture(); f.add("old"); const next = f.add("new");
  const driver = createRenderSettingsDriver({}, [{ ...declarations("old")[0]!, parameters: [{ name: "gain", type: "float", default: 1 }] }], undefined, [effect], f.provider);
  const plugin = driver.factory({} as never), checkpoint = plugin.snapshot();
  driver.service.configure({ exposure: 2 }); driver.service.setMaterialParameter("mat", "gain", 3);
  driver.service.effects.configure("fx", { enabled: false }); driver.service.buffers.bind("mat", "positions", next);
  const before = plugin.snapshot(), pins = f.pinCalls.length;
  for (const part of ["settings", "parameters", "postProcesses", "bufferBindings"]) {
    const bad = structuredClone(checkpoint) as any;
    if (part === "settings") bad.settings.exposure = 0;
    if (part === "parameters") bad.parameters.values.mat.gain = false;
    if (part === "postProcesses") bad.postProcesses.states[0].enabled = "yes";
    if (part === "bufferBindings") bad.bufferBindings.bindings.mat.positions.count = 1;
    assert.throws(() => plugin.restore(bad)); assert.deepEqual(plugin.snapshot(), before); assert.equal(f.pinCalls.length, pins);
  }
  const incompatible = f.peers() as any; incompatible["$engine.compute"].payload.buffers = [];
  assert.throws(() => plugin.validatePeers(checkpoint, incompatible), error("TC_RENDER_BUFFER_PEER_SNAPSHOT"));
  assert.deepEqual(plugin.snapshot(), before); assert.equal(f.pinCalls.length, pins);
  f.rejectNextPins(); assert.throws(() => plugin.restore(checkpoint), error("TC_RENDER_BUFFER_PROVIDER"));
  assert.deepEqual(plugin.snapshot(), before); assert.deepEqual(f.pins(), ["new"]);
  plugin.validatePeers(checkpoint, f.peers()); plugin.restore(checkpoint);
  assert.deepEqual(plugin.snapshot(), checkpoint); assert.deepEqual(f.pins(), ["old"]);
});

test("driver publishes restore pins before other owners and unpins before disposing them", () => {
  const f = fixture(); f.add("old"); const h = f.add("new");
  const driver = createRenderSettingsDriver({}, declarations("old"), undefined, [effect], f.provider), plugin = driver.factory({} as never), checkpoint = plugin.snapshot();
  driver.service.configure({ exposure: 2 }); driver.service.effects.configure("fx", { enabled: false }); driver.service.buffers.bind("mat", "positions", h);
  const real = f.provider.setPins;
  f.provider.setPins = ids => {
    assert.equal(driver.service.state().exposure, ids.length ? 2 : 1);
    assert.equal(driver.service.effects.state("fx").enabled, ids.length ? false : true);
    real(ids);
  };
  plugin.restore(checkpoint);
  plugin.dispose(); driver.dispose(); assert.deepEqual(f.pins(), []);
  assert.throws(() => driver.service.state(), /TC_RENDER_DISPOSED/);
  assert.throws(() => driver.service.buffers.state("mat"), error("TC_RENDER_BUFFER_DISPOSED"));
});

test("dispose is idempotent, releases pins first, and rejects all other owner operations", () => {
  const f = fixture(), h = f.add("old"), owner = createRenderBufferOwner(declarations("old"), f.provider), value = saved(owner);
  f.rejectNextPins(); assert.throws(() => owner.dispose(), error("TC_RENDER_BUFFER_PROVIDER"));
  // A failing provider preserves both pins and a live owner; a retry can finish cleanup.
  assert.deepEqual(f.pins(), ["old"]);
  owner.service.state("mat"); owner.dispose(); const calls = f.pinCalls.length; owner.dispose();
  assert.equal(f.pinCalls.length, calls); assert.deepEqual(f.pins(), []);
  for (const action of [() => owner.service.bind("mat", "positions", h), () => owner.service.unbind("mat", "positions"), () => owner.service.state("mat"),
    () => owner.resources("mat"), () => owner.snapshot(), () => owner.validateSnapshot(value), () => owner.validatePeerSnapshot(value, f.peers()), () => owner.restore(value), () => owner.inspect()])
    assert.throws(action, error("TC_RENDER_BUFFER_DISPOSED"));
});


test("special slot/material record keys stay isolated from prototypes", () => {
  const f = fixture(), handle = f.add("data");
  const owner = createRenderBufferOwner([{ id: "constructor", buffers: [{ name: "__proto__", type: "vec3" }, { name: "constructor", type: "vec3" }] }], f.provider);
  owner.service.bind("constructor", "constructor", handle); owner.service.bind("constructor", "__proto__", handle);
  const checkpoint = saved(owner);
  assert.deepEqual(Object.keys(checkpoint.bindings.constructor!), ["__proto__", "constructor"]);
  assert.deepEqual(owner.resources("constructor").__proto__!.values, [[1, 2, 3], [4, 5, 6]]);
  owner.validatePeerSnapshot(checkpoint, f.peers());
  owner.service.unbind("constructor", "__proto__"); owner.restore(checkpoint);
  assert.equal(Object.getPrototypeOf(owner.service.state("constructor")), Object.prototype);
  assert.equal(owner.service.state("constructor").__proto__!.id, "data");
});

test("resource use enforces saved dynamic counts and preflights unbound slots before provider reads", () => {
  const f = fixture(), handle = f.add("data");
  const owner = createRenderBufferOwner([{ id: "mat", buffers: [{ name: "a", type: "vec3" }, { name: "z", type: "float" }] }], f.provider);
  owner.service.bind("mat", "a", handle);
  const reads = f.reads();
  assert.throws(() => owner.resources("mat"), error("TC_RENDER_BUFFER_UNBOUND", "mat:z"));
  assert.equal(f.reads(), reads);
  const scalar = f.add("scalar", "float", [1]); owner.service.bind("mat", "z", scalar);
  f.entries.get("data")!.resource.values = [[1, 2, 3]];
  assert.throws(() => owner.resources("mat"), error("TC_RENDER_BUFFER_COUNT", "mat:a"));
  // A slot without a declared count may explicitly rebind to the new count.
  owner.service.bind("mat", "a", handle);
  assert.equal(owner.resources("mat").a!.values.length, 1);
});

test("frozen and null-prototype snapshots validate without aliases or mutation", () => {
  const f = fixture(); f.add("data");
  const owner = createRenderBufferOwner(declarations("data"), f.provider);
  const freeze = (value: any): any => {
    if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
    return value;
  };
  const checkpoint = freeze(saved(owner));
  owner.validateSnapshot(checkpoint); owner.validatePeerSnapshot(checkpoint, freeze(f.peers())); owner.restore(checkpoint);
  const plain = saved(owner); Object.setPrototypeOf(plain.bindings, null); Object.setPrototypeOf(plain.bindings.mat, null);
  owner.validateSnapshot(plain); owner.restore(plain);
  assert.deepEqual(saved(owner), checkpoint);
});
