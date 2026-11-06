import test from "node:test";
import assert from "node:assert/strict";
import type { ComputeTextureHandle, MaterialTextureInput, Vec4 } from "../packages/sdk/src/index.ts";
import type { ComputeExecutionInput } from "../packages/runtime/src/compute-contract.ts";
import type { RenderTextureProvider } from "../packages/runtime/src/render-texture-contract.ts";
import { createRenderTextureOwner, type RenderTextureSnapshot, type RenderTexturePeerSnapshots } from "../packages/runtime/src/render-textures.ts";
import { createComputeDriver } from "../packages/runtime/src/compute-service.ts";
import type { RuntimePluginContext } from "../packages/runtime/src/plugins.ts";

const pixels = (count = 2): Vec4[] => Array.from({ length: count }, (_, i) => [i + 0.25, -i, 2, 1]);
function fixture() {
  let owner = 1, next = 0, reads = 0, descriptions = 0, rejections = 0;
  let pinned: string[] = [];
  const pinCalls: string[][] = [];
  const entries = new Map<string, { handle: ComputeTextureHandle; resource: ComputeExecutionInput }>();
  const provider: RenderTextureProvider = {
    describe(handle) {
      descriptions++;
      const found = [...entries].find(([, e]) => handle.kind === "texture" && e.handle.owner === handle.owner &&
        e.handle.index === handle.index && e.handle.generation === handle.generation);
      if (!found) throw new Error("stale or foreign texture handle");
      const [id, { resource }] = found;
      return { id, ...resource.texture!, format: "rgba32float", revision: resource.revision };
    },
    resource(id) {
      reads++;
      const entry = entries.get(id);
      if (!entry) throw new Error(`Missing texture ${id}`);
      return entry.resource;
    },
    setPins(ids) {
      pinCalls.push([...ids]); pinned = [...ids];
      if (rejections > 0) { rejections--; throw new Error("pin publication failed"); }
    },
  };
  const add = (id: string, width = 2, height = 1) => {
    const handle: ComputeTextureHandle = { owner, index: next++, generation: 1, kind: "texture" };
    entries.set(id, { handle, resource: { key: `${owner}:${handle.index}`, type: "vec4", revision: 0,
      texture: { width, height }, values: pixels(width * height) } });
    return handle;
  };
  return {
    provider, add, entries, pinCalls,
    pins: () => [...pinned], reads: () => reads, descriptions: () => descriptions,
    rejectNextPins: () => { rejections = 1; },
    reset: () => { entries.clear(); owner++; next = 0; },
    peers: (): RenderTexturePeerSnapshots => ({ "$engine.compute": { version: "1", payload: {
      version: 1, kernels: [], buffers: [...entries].map(([id, { resource }]) => ({ id, type: resource.type,
        count: resource.values.length, data: structuredClone(resource.values), texture: { ...resource.texture! } })),
    } } }),
  };
}
const declarations = (texture?: string): { id: string; textures: MaterialTextureInput[] }[] => [
  { id: "mat", textures: [{ name: "image", width: 2, height: 1, ...(texture === undefined ? {} : { texture }) }] },
];
const saved = (owner: ReturnType<typeof createRenderTextureOwner>): RenderTextureSnapshot => {
  const value = owner.snapshot(); assert.ok(value); return value;
};
const error = (suffix: string, at?: string) => (value: unknown): boolean => {
  assert.ok(value instanceof Error);
  assert.equal((value as Error & { code: string }).code, `TC_RENDER_TEXTURE_${suffix}`);
  assert.ok(value.message.includes("Repair:"));
  assert.ok((value as Error & { remediation: string }).remediation.length > 0);
  if (at) assert.ok(value.message.includes(at), value.message);
  return true;
};
const getter = (value: object, key: string) => Object.defineProperty(value, key, {
  enumerable: true, configurable: true, get() { throw new Error("Accessor must not execute"); },
});

test("initial bindings canonicalize samplers, omit initial IDs, and publish sorted unique logical pins once", () => {
  const f = fixture(); f.add("beta"); f.add("alpha");
  const defs = [
    { id: "z", textures: [{ name: "z", texture: "beta", filter: "nearest" as const, wrapU: "repeat" as const, wrapV: "mirror" as const, width: 2 },
      { name: "a", texture: "alpha" }] },
    { id: "empty" },
    { id: "a", textures: [{ name: "shared", texture: "alpha", height: 1 }] },
  ];
  const owner = createRenderTextureOwner(defs, f.provider);
  assert.deepEqual(f.pinCalls, [["alpha", "beta"]]);
  assert.deepEqual(owner.inspect(), { materials: 3, slots: 3, bound: 3, pins: 2, revision: 0 });
  const snapshot = saved(owner);
  assert.deepEqual(snapshot.definitions, [
    { id: "a", textures: [{ name: "shared", filter: "linear", wrapU: "clamp", wrapV: "clamp", height: 1 }] },
    { id: "z", textures: [{ name: "a", filter: "linear", wrapU: "clamp", wrapV: "clamp" },
      { name: "z", filter: "nearest", wrapU: "repeat", wrapV: "mirror", width: 2 }] },
  ]);
  assert.equal(snapshot.version, 1);
  assert.deepEqual(snapshot.bindings.z!.z, { id: "beta", width: 2, height: 1, format: "rgba32float" });
  assert.equal(JSON.stringify(snapshot.definitions).includes('"texture":'), false);
  assert.deepEqual(owner.resources("empty"), {});
  defs[0]!.textures![0]!.name = "mutated";
  snapshot.definitions[1]!.textures[0]!.filter = "nearest";
  snapshot.bindings.z!.z!.id = "mutated";
  assert.equal(saved(owner).definitions[1]!.textures[0]!.name, "a");
  assert.equal(saved(owner).definitions[1]!.textures[0]!.filter, "linear");
  assert.equal(owner.service.state("z").z!.id, "beta");
});

test("empty owners and unbound declarations need no provider; resource use preflights every missing slot", () => {
  const empty = createRenderTextureOwner([{ id: "mat" }]);
  assert.equal(empty.snapshot(), undefined);
  empty.validateSnapshot(undefined); empty.validatePeerSnapshot(undefined, {}); empty.restore(undefined);
  assert.deepEqual(empty.resources("mat"), {}); assert.deepEqual(empty.service.state("mat"), {});
  const owner = createRenderTextureOwner(declarations());
  owner.validateSnapshot(saved(owner)); owner.validatePeerSnapshot(saved(owner), {}); owner.restore(saved(owner));
  owner.service.unbind("mat", "image");
  assert.equal(owner.inspect().revision, 0);
  assert.throws(() => owner.resources("mat"), error("UNBOUND", "mat:image"));
  assert.throws(() => owner.service.bind("mat", "image", { owner: 1, index: 0, generation: 1, kind: "texture" }), error("PROVIDER"));
  const f = fixture(), handle = f.add("data");
  const partial = createRenderTextureOwner([{ id: "mat", textures: [{ name: "a" }, { name: "z" }] }], f.provider);
  partial.service.bind("mat", "a", handle); f.entries.clear();
  const reads = f.reads();
  assert.throws(() => partial.resources("mat"), error("UNBOUND", "mat:z"));
  assert.equal(f.reads(), reads);
});

test("definitions reject sparse, accessor, inherited, extra and invalid sampler/dimension declarations before any pin publication", () => {
  const f = fixture(); f.add("data");
  const cases: unknown[] = [
    null, new Array(1), [{ id: "bad id" }], [{ id: "mat" }, { id: "mat" }],
    [{ id: "mat", textures: new Array(1) }], [{ id: "mat", textures: [{ name: " " }] }],
    [{ id: "mat", textures: [{ name: "a" }, { name: "a" }] }],
    ...[{ filter: "cubic" }, { wrapU: "border" }, { wrapV: null }, { texture: "" }, { width: 0 }, { height: 1.5 },
      { width: 2 ** 24 + 1 }, { width: 2 ** 24, height: 2 }, { extra: true }, { type: "vec4" }, { buffer: "data" }]
      .map(fields => [{ id: "mat", textures: [{ name: "a", ...fields }] }]),
    [getter({ id: "mat" }, "textures")], [{ id: "mat", textures: [getter({ name: "a" }, "width")] }],
    [{ id: "mat", textures: [Object.assign(Object.create({}), { name: "a" })] }],
    [{ id: "mat", textures: [Object.assign({ name: "a" }, { [Symbol("extra")]: true })] }],
    [{ id: "mat", textures: [Object.defineProperty({ name: "a" }, "filter", { value: "linear" })] }],
  ];
  for (const input of cases) assert.throws(() => createRenderTextureOwner(input as Parameters<typeof createRenderTextureOwner>[0], f.provider), error("DEFINITION"));
  const late = [{ id: "mat", textures: [{ name: "a", texture: "data" }] }, { id: "bad id" }];
  assert.throws(() => createRenderTextureOwner(late, f.provider), error("DEFINITION"));
  assert.equal(f.reads(), 0); assert.deepEqual(f.pinCalls, []);
});

test("constructor preflights all initial resources and constraints before publishing pins", () => {
  const f = fixture(); f.add("data"); f.add("wrong", 1, 2);
  const defs = [{ id: "mat", textures: [{ name: "a", texture: "data" }, { name: "z", texture: "wrong", width: 2 }] }];
  assert.throws(() => createRenderTextureOwner(defs, f.provider), error("SIZE", "mat:z"));
  assert.deepEqual(f.pinCalls, []);
  defs[0]!.textures[1]!.texture = "missing";
  assert.throws(() => createRenderTextureOwner(defs, f.provider), error("PROVIDER", "mat:z"));
  assert.deepEqual(f.pinCalls, []);
  defs[0]!.textures[1]!.texture = "data";
  f.entries.get("data")!.resource.values = [[1, 2, 3]];
  assert.throws(() => createRenderTextureOwner(defs, f.provider), error("RESOURCE"));
  assert.deepEqual(f.pinCalls, []);
});

test("binding validates target, slot, texture kind, handle identity and dimensions without changing state", () => {
  const f = fixture(), old = f.add("old"), replacement = f.add("next"), wrong = f.add("wrong", 1, 2);
  const owner = createRenderTextureOwner(declarations("old"), f.provider), before = saved(owner), stats = owner.inspect();
  const malformed = [null, { ...old, kind: "buffer" }, { owner: old.owner, index: old.index, generation: old.generation },
    { ...old, index: -1 }, { ...old, owner: 0 }, { ...old, generation: 0 }, { ...old, native: {} }, getter({ ...old }, "kind")];
  const described = f.descriptions();
  for (const handle of malformed) assert.throws(() => owner.service.bind("mat", "image", handle as ComputeTextureHandle), error("HANDLE"));
  assert.equal(f.descriptions(), described);
  for (const [action, suffix] of [
    [() => owner.service.bind("missing", "image", replacement), "MATERIAL"],
    [() => owner.service.bind("mat", "missing", replacement), "SLOT"],
    [() => owner.service.bind("mat", "image", { ...replacement, owner: 99 }), "PROVIDER"],
    [() => owner.service.bind("mat", "image", { ...replacement, generation: 2 }), "PROVIDER"],
    [() => owner.service.bind("mat", "image", wrong), "SIZE"],
  ] as const) {
    assert.throws(action, error(suffix)); assert.deepEqual(saved(owner), before); assert.deepEqual(owner.inspect(), stats);
  }
  const describe = f.provider.describe;
  for (const descriptor of [null, { id: "old", width: 2, height: 1, format: "rgba8unorm" },
    { id: "old", width: 2, height: 1, format: "rgba32float", texture: {} },
    getter({ id: "old", width: 2, height: 1, format: "rgba32float" }, "width")]) {
    f.provider.describe = () => descriptor as ReturnType<RenderTextureProvider["describe"]>;
    assert.throws(() => owner.service.bind("mat", "image", replacement), error("REFERENCE"));
  }
  f.provider.describe = describe;
  owner.service.bind("mat", "image", old);
  assert.equal(f.pinCalls.length, 1);
  owner.service.bind("mat", "image", replacement);
  assert.equal(owner.inspect().revision, 1); assert.deepEqual(f.pins(), ["next"]);
});

test("provider pin failures roll back binding, restore, unbind and disposal before publishing owner state", () => {
  const f = fixture(), old = f.add("old"), next = f.add("next");
  const owner = createRenderTextureOwner(declarations("old"), f.provider);
  const restore = saved(owner); restore.bindings.mat!.image!.id = "next";
  const before = saved(owner), stats = owner.inspect();
  for (const action of [() => owner.service.bind("mat", "image", next), () => owner.restore(restore),
    () => owner.service.unbind("mat", "image"), () => owner.dispose()]) {
    f.rejectNextPins(); assert.throws(action, error("PROVIDER", "pins"));
    assert.deepEqual(f.pins(), ["old"]); assert.deepEqual(saved(owner), before); assert.deepEqual(owner.inspect(), stats);
  }
  owner.service.bind("mat", "image", old); assert.deepEqual(owner.inspect(), stats);
  const init = fixture(); init.add("data"); init.rejectNextPins();
  assert.throws(() => createRenderTextureOwner(declarations("data"), init.provider), error("PROVIDER"));
  assert.deepEqual(init.pinCalls, [["data"], []]); assert.deepEqual(init.pins(), []);
});

test("shared texture IDs stay pinned until the final slot unbinds and no-op mutations preserve revision", () => {
  const f = fixture(), handle = f.add("shared");
  const owner = createRenderTextureOwner([{ id: "mat", textures: [{ name: "a" }, { name: "b" }] }], f.provider);
  owner.service.bind("mat", "b", handle); owner.service.bind("mat", "a", handle);
  assert.deepEqual(f.pins(), ["shared"]);
  owner.service.unbind("mat", "a"); assert.deepEqual(f.pins(), ["shared"]);
  owner.service.unbind("mat", "b"); assert.deepEqual(f.pins(), []);
  const revision = owner.inspect().revision, calls = f.pinCalls.length;
  owner.service.unbind("mat", "b"); owner.restore(saved(owner));
  assert.equal(owner.inspect().revision, revision); assert.equal(f.pinCalls.length, calls);
});

test("resource views are deeply detached and frozen, refresh key/revision, and preserve texture shape", () => {
  const f = fixture(); f.add("data");
  const owner = createRenderTextureOwner(declarations("data"), f.provider), first = owner.resources("mat");
  const source = f.entries.get("data")!.resource;
  assert.notEqual(first.image, source); assert.notEqual(first.image!.texture, source.texture);
  assert.notEqual(first.image!.values, source.values); assert.notEqual(first.image!.values[0], source.values[0]);
  for (const object of [first, first.image, first.image!.texture, first.image!.values, first.image!.values[0]]) assert.ok(Object.isFrozen(object));
  assert.deepEqual(Object.keys(first.image!).sort(), ["key", "revision", "texture", "type", "values"]);
  assert.deepEqual(first.image!.texture, { width: 2, height: 1 }); assert.equal(first.image!.type, "vec4");
  (source.values[0] as unknown as number[])[0] = 42; source.key = "rebuilt"; source.revision = 5;
  assert.equal((first.image!.values[0] as readonly number[])[0], 0.25);
  const current = owner.resources("mat").image!;
  assert.equal(current.key, "rebuilt"); assert.equal(current.revision, 5); assert.equal((current.values[0] as readonly number[])[0], 42);
  const state = owner.service.state("mat"); assert.ok(Object.isFrozen(state)); assert.ok(Object.isFrozen(state.image));
  assert.deepEqual(state.image, { id: "data", width: 2, height: 1, format: "rgba32float" });
});

test("resource use rejects buffers, invalid values, arrays, shapes and native objects at the private boundary", () => {
  const f = fixture(); f.add("data");
  const owner = createRenderTextureOwner(declarations("data"), f.provider), original = f.entries.get("data")!.resource;
  const mutations: ((r: any) => void)[] = [
    r => { delete r.texture; }, r => { r.type = "float"; }, r => { r.texture = { width: 1, height: 1 }; },
    r => { r.texture.width = 0; }, r => { r.texture.height = Infinity; }, r => { r.texture.native = {}; },
    r => { r.texture = new Date(); }, r => { r.revision = -1; }, r => { r.revision = 0.5; }, r => { r.key = " "; },
    r => { r.native = {}; }, r => { r.captured = true; }, r => { r.values = new Float32Array(8); },
    r => { r.values = new Array(2); }, r => { r.values[0] = [1, 2, 3]; }, r => { r.values[0][0] = NaN; },
    r => { r.values[0][0] = Infinity; }, r => { r.values[0][0] = Number.MAX_VALUE; }, r => { r.values[0][0] = true; },
    r => { r.values[0] = new Float32Array(4); }, r => { getter(r, "texture"); }, r => { getter(r.values, "0"); },
    r => { getter(r.values[0], "0"); }, r => { Object.setPrototypeOf(r.values[0], {}); },
    r => { Object.defineProperty(r.values[0], "extra", { value: 1 }); }, r => { Object.setPrototypeOf(r, {}); },
  ];
  const before = saved(owner), stats = owner.inspect();
  for (const mutate of mutations) {
    const value = structuredClone(original); mutate(value); f.entries.get("data")!.resource = value;
    assert.throws(() => owner.resources("mat"), error("RESOURCE", "mat:image"));
    assert.deepEqual(saved(owner), before); assert.deepEqual(owner.inspect(), stats);
  }
  f.entries.get("data")!.resource = original;
});

test("unconstrained slots retain bound dimensions until explicitly rebound after a resize", () => {
  const f = fixture(), handle = f.add("data");
  const owner = createRenderTextureOwner([{ id: "mat", textures: [{ name: "image", texture: "data" }] }], f.provider);
  f.entries.get("data")!.resource.texture = { width: 1, height: 2 };
  assert.throws(() => owner.resources("mat"), error("SIZE", "mat:image"));
  owner.service.bind("mat", "image", handle);
  assert.deepEqual(owner.resources("mat").image!.texture, { width: 1, height: 2 });
  assert.equal(owner.inspect().revision, 1);
});

test("snapshot validation rejects exact-shape, sampler, order and reference mismatches without provider reads or mutation", () => {
  const f = fixture(); f.add("data");
  const owner = createRenderTextureOwner(declarations("data"), f.provider), before = saved(owner), reads = f.reads(), calls = f.pinCalls.length;
  const mutations: ((s: any) => void)[] = [
    s => { s.version = 2; }, s => { s.extra = true; }, s => { s.definitions = []; }, s => { s.definitions = new Array(1); },
    s => { s.definitions[0].id = "other"; }, s => { s.definitions[0].textures[0].texture = "data"; },
    s => { delete s.definitions[0].textures[0].filter; }, s => { s.definitions[0].textures[0].filter = "nearest"; },
    s => { s.definitions[0].textures[0].wrapV = "repeat"; }, s => { s.definitions[0].textures[0].width = 1; },
    s => { s.bindings.other = {}; }, s => { delete s.bindings.mat; }, s => { s.bindings.mat.extra = s.bindings.mat.image; },
    s => { s.bindings.mat.image.width = 1; }, s => { s.bindings.mat.image.height = 0; }, s => { s.bindings.mat.image.id = ""; },
    s => { s.bindings.mat.image.format = "rgba8unorm"; }, s => { s.bindings.mat.image.revision = 0; },
    s => { s.bindings.mat.image = { id: "data", type: "vec4", count: 2 }; }, s => { getter(s.bindings.mat, "image"); },
    s => { Object.setPrototypeOf(s.bindings.mat.image, {}); }, s => { s.bindings.mat.image[Symbol("native")] = {}; },
    s => { Object.defineProperty(s.bindings.mat.image, "native", { value: {} }); },
    s => { getter(s.definitions[0].textures, "0"); }, s => { s.bindings.mat = new Date(); },
  ];
  for (const mutate of mutations) {
    const value = structuredClone(before); mutate(value);
    assert.throws(() => owner.validateSnapshot(value), error("SNAPSHOT"));
    assert.throws(() => owner.restore(value), error("SNAPSHOT"));
    assert.deepEqual(saved(owner), before);
  }
  assert.throws(() => owner.validateSnapshot(undefined), error("SNAPSHOT"));
  assert.equal(f.reads(), reads); assert.equal(f.pinCalls.length, calls);
  const ordered = createRenderTextureOwner([{ id: "z", textures: [{ name: "z" }, { name: "a" }] }, { id: "a", textures: [{ name: "a" }] }]);
  const wrongMaterials = saved(ordered); wrongMaterials.definitions.reverse();
  assert.throws(() => ordered.validateSnapshot(wrongMaterials), error("SNAPSHOT"));
  const wrongSlots = saved(ordered); wrongSlots.definitions[1]!.textures.reverse();
  assert.throws(() => ordered.validateSnapshot(wrongSlots), error("SNAPSHOT"));
});

test("canonical declarations match explicit default samplers independently of initial texture IDs", () => {
  const f = fixture(); f.add("old"); f.add("new");
  const first = createRenderTextureOwner(declarations("old"), f.provider);
  const other = createRenderTextureOwner([{ id: "mat", textures: [{ name: "image", texture: "new", width: 2, height: 1,
    filter: "linear", wrapU: "clamp", wrapV: "clamp" }] }], f.provider);
  other.validateSnapshot(saved(first));
  const unbound = saved(first); delete unbound.bindings.mat!.image;
  first.validatePeerSnapshot(unbound, {}); first.restore(unbound);
  assert.deepEqual(first.service.state("mat"), {}); assert.deepEqual(f.pins(), []);
});

test("peer validation checks texture kind, exact metadata, vec4 texels and width times height without live reads or pin publication", () => {
  const f = fixture(); f.add("data");
  const owner = createRenderTextureOwner(declarations("data"), f.provider), snapshot = saved(owner), peers = f.peers();
  owner.validatePeerSnapshot(snapshot, peers);
  const reads = f.reads(), calls = f.pinCalls.length, stats = owner.inspect();
  const mutations: ((p: any) => void)[] = [
    p => { delete p["$engine.compute"]; }, p => { p["$engine.compute"].payload.buffers = []; },
    p => { getter(p, "$engine.compute"); }, p => { getter(p["$engine.compute"].payload, "buffers"); },
    ...[(e: any) => { e.id = "missing"; }, (e: any) => { delete e.texture; },
      (e: any) => { e.type = "vec3"; }, (e: any) => { e.count = 1; },
      (e: any) => { e.texture = { width: 1, height: 2 }; }, (e: any) => { e.texture.width = 0; },
      (e: any) => { e.texture.format = "rgba32float"; }, (e: any) => { e.texture = null; },
      (e: any) => { e.data = new Array(2); }, (e: any) => { e.data[0] = [1, 2, 3]; },
      (e: any) => { e.data[0][0] = NaN; }, (e: any) => { e.data[0][0] = Number.MAX_VALUE; },
      (e: any) => { getter(e.texture, "width"); }, (e: any) => { getter(e.data[0], "0"); },
      (e: any) => { Object.setPrototypeOf(e.texture, {}); }, (e: any) => { e.data[0].extra = true; },
      (e: any) => { e.native = {}; }].map(mutate => (p: any) => mutate(p["$engine.compute"].payload.buffers[0])),
    p => { p["$engine.compute"].payload.buffers.push(structuredClone(p["$engine.compute"].payload.buffers[0])); },
    p => { p["$engine.compute"].payload.buffers = new Array(1); },
  ];
  for (const mutate of mutations) {
    const bad = structuredClone(peers); mutate(bad);
    assert.throws(() => owner.validatePeerSnapshot(snapshot, bad), error("PEER_SNAPSHOT"));
  }
  const mixed = structuredClone(peers) as any;
  mixed["$engine.compute"].payload.buffers.push({ id: "ordinary", type: "float", count: 1, data: [1] });
  owner.validatePeerSnapshot(snapshot, mixed);
  assert.equal(f.reads(), reads); assert.equal(f.pinCalls.length, calls); assert.deepEqual(owner.inspect(), stats);
  assert.deepEqual(saved(owner), snapshot);
});

test("restore pins logical IDs before compute restore, resolves fresh keys, and retains no snapshot aliases", () => {
  const f = fixture(), stale = f.add("old");
  const original = createRenderTextureOwner(declarations("old"), f.provider), snapshot = saved(original), peers = f.peers();
  original.dispose(); f.reset(); f.add("new");
  const restored = createRenderTextureOwner(declarations("new"), f.provider), reads = f.reads();
  restored.validateSnapshot(snapshot); restored.validatePeerSnapshot(snapshot, peers); restored.restore(snapshot);
  assert.equal(f.reads(), reads); assert.deepEqual(f.pins(), ["old"]);
  assert.throws(() => restored.resources("mat"), error("PROVIDER"));
  f.reset(); f.add("old");
  assert.equal(restored.resources("mat").image!.key, "3:0");
  assert.throws(() => restored.service.bind("mat", "image", stale), error("PROVIDER"));
  snapshot.bindings.mat!.image!.id = "mutated";
  assert.equal(restored.service.state("mat").image!.id, "old");
});

test("special record keys and frozen/null-prototype snapshots remain safe and detached", () => {
  const f = fixture(), handle = f.add("data");
  const owner = createRenderTextureOwner([{ id: "constructor", textures: [{ name: "__proto__" }, { name: "constructor" }] }], f.provider);
  owner.service.bind("constructor", "constructor", handle); owner.service.bind("constructor", "__proto__", handle);
  const snapshot = saved(owner);
  const freeze = (value: any): any => {
    if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
    return value;
  };
  owner.validateSnapshot(freeze(snapshot)); owner.validatePeerSnapshot(snapshot, freeze(f.peers())); owner.restore(snapshot);
  const nullable = saved(owner); Object.setPrototypeOf(nullable.bindings, null); Object.setPrototypeOf(nullable.bindings.constructor, null);
  Object.setPrototypeOf((nullable.bindings.constructor! as unknown as Record<string, unknown>)["__proto__"] as object, null);
  owner.restore(nullable);
  assert.deepEqual(Object.keys(saved(owner).bindings.constructor!), ["__proto__", "constructor"]);
  assert.deepEqual(owner.resources("constructor").__proto__!.values, pixels());
  owner.service.unbind("constructor", "__proto__"); owner.restore(snapshot);
  assert.equal(Object.getPrototypeOf(owner.service.state("constructor")), Object.prototype);
  assert.equal(owner.service.state("constructor").__proto__!.id, "data");
});

test("dispose releases logical pins once, is retryable on provider failure, and rejects every later operation", () => {
  const f = fixture(), handle = f.add("data");
  const owner = createRenderTextureOwner(declarations("data"), f.provider), snapshot = saved(owner);
  owner.dispose(); const calls = f.pinCalls.length; owner.dispose();
  assert.equal(f.pinCalls.length, calls); assert.deepEqual(f.pins(), []);
  for (const action of [() => owner.service.bind("mat", "image", handle), () => owner.service.unbind("mat", "image"),
    () => owner.service.state("mat"), () => owner.resources("mat"), () => owner.snapshot(), () => owner.validateSnapshot(snapshot),
    () => owner.validatePeerSnapshot(snapshot, f.peers()), () => owner.restore(snapshot), () => owner.inspect()])
    assert.throws(action, error("DISPOSED"));
  assert.ok(f.entries.has("data"));
});

test("real compute provider supports texture pins, CPU writes and render-before-compute restoration without GPU objects", () => {
  const compute = createComputeDriver({ kernels: [], capabilities: () => ({ backend: "webgpu", compute: true, availableModes: ["raster"] }) });
  const plugin = compute.factory({} as RuntimePluginContext);
  const provider: RenderTextureProvider = { describe: h => compute.service.describeTexture(h),
    resource: id => compute.textureResource(id), setPins: ids => compute.setRenderPins(ids) };
  const handle = compute.service.createTexture({ id: "data", width: 2, height: 1, data: pixels() });
  const buffer = compute.service.createBuffer({ id: "ordinary", type: "vec4", count: 2, data: pixels() });
  const owner = createRenderTextureOwner(declarations("data"), provider), snapshot = saved(owner);
  const peer = { "$engine.compute": { version: "1", payload: plugin.snapshot() } };
  owner.validatePeerSnapshot(snapshot, peer);
  assert.throws(() => owner.service.bind("mat", "image", buffer as ComputeTextureHandle), error("HANDLE"));
  assert.throws(() => compute.service.releaseTexture(handle), /TC_COMPUTE_BUFFER_IN_USE/);
  compute.service.writeTexture(handle, [[9, 8, 7, 6], [5, 4, 3, 2]]);
  const current = owner.resources("mat").image!;
  assert.equal(current.revision, 1); assert.deepEqual(current.values[0], [9, 8, 7, 6]);
  owner.service.unbind("mat", "image"); compute.service.releaseTexture(handle);
  owner.restore(snapshot); plugin.restore(peer["$engine.compute"].payload);
  const restored = owner.resources("mat").image!;
  assert.notEqual(restored.key, current.key); assert.deepEqual(restored.values, pixels());
  assert.throws(() => owner.service.bind("mat", "image", handle), error("PROVIDER"));
  owner.dispose(); compute.service.releaseTexture(compute.service.resolveTexture("data")); compute.dispose();
});

