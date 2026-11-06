import test from "node:test";
import assert from "node:assert/strict";
import type { PostProcessIR } from "../packages/compiler/src/types.ts";
import type { GraphParameter, GraphValue } from "../packages/sdk/src/index.ts";
import { createPostProcessOwner, type PostProcessSnapshot } from "../packages/runtime/src/postprocess.ts";
import { createRenderSettingsDriver, DEFAULT_RENDER_SETTINGS } from "../packages/runtime/src/render-settings.ts";

const declarations = (): GraphParameter[] => [
  { name: "gain", type: "float", default: 0.5 },
  { name: "offset", type: "vec2", default: [0, 1] },
  { name: "tint", type: "vec3", default: [1, 0.5, 0.25] },
  { name: "rgba", type: "vec4", default: [1, 2, 3, 4] },
  { name: "feedback", type: "bool", default: true },
];
const definition = (id = "feedback", enabled = true): PostProcessIR => ({
  id, enabled,
  graph: {
    nodes: [{ id: "color", op: "vec4", value: [1, 0.5, 0.25, 1] }],
    output: "color", outputType: "vec4", nodeTypes: { color: "vec4" },
    parameters: declarations(),
  },
  source: { file: "game.ts", line: 1, column: 1, length: 10 },
});
const definitions = () => [definition("first"), definition("second", false)];
const create = () => createPostProcessOwner(definitions());
type Owner = ReturnType<typeof createPostProcessOwner>;
const snapshot = (owner: Owner): PostProcessSnapshot => {
  const result = owner.snapshot();
  assert.ok(result);
  return result;
};
const diagnostic = (code: string, at?: string) => (value: unknown): boolean => {
  assert.ok(value instanceof Error);
  assert.ok(value.message.startsWith(code + ":"), value.message);
  if (at) assert.ok(value.message.includes(at), value.message);
  assert.match(value.message, /Repair:/);
  return true;
};

test("postprocess owner accepts all five parameter types and preserves pass order", () => {
  const owner = create();
  assert.deepEqual(owner.states().map(s => [s.id, s.enabled]), [["first", true], ["second", false]]);
  assert.deepEqual(owner.service.state("first").parameters, Object.fromEntries(declarations().map(p => [p.name, p.default])));
  const updates: Record<string, GraphValue> = { gain: 2, offset: [3, 4], tint: [5, 6, 7], rgba: [8, 9, 10, 11], feedback: false };
  for (const [name, value] of Object.entries(updates)) owner.service.setParameter("first", name, value);
  assert.deepEqual(owner.service.state("first").parameters, updates);
  assert.deepEqual(owner.historyRevisions(), { first: 0, second: 0 });
  assert.deepEqual(owner.inspect(), { passes: 2, enabled: 1, parameters: 10, revision: 5 });
  for (const [name, value] of Object.entries(updates)) owner.service.setParameter("first", name, value);
  assert.equal(owner.inspect().revision, 5);
});

test("definitions, states, snapshots and vector inputs are detached", () => {
  const input = definitions(), owner = createPostProcessOwner(input), initial = snapshot(owner);
  input[0]!.id = "renamed";
  input[0]!.enabled = false;
  input[0]!.graph.nodes = [];
  (input[0]!.graph.parameters![1]!.default as unknown as number[])[0] = 99;
  assert.deepEqual(snapshot(owner), initial);
  const vector: [number, number] = [2, 3];
  owner.service.setParameter("first", "offset", vector);
  vector[0] = 99;
  const states = owner.states(), state = owner.service.state("first");
  assert.ok(Object.isFrozen(states));
  assert.ok(Object.isFrozen(state));
  assert.ok(Object.isFrozen(state.parameters));
  assert.ok(Object.isFrozen(state.parameters.offset));
  assert.notEqual(state, owner.service.state("first"));
  assert.notEqual(state.parameters.offset, owner.service.state("first").parameters.offset);
  assert.throws(() => { (state as any).enabled = false; }, TypeError);
  assert.throws(() => { (state.parameters.offset as unknown as number[])[0] = 99; }, TypeError);
  const saved = snapshot(owner);
  saved.definitions[0]!.graph.nodes = [];
  saved.states[0]!.enabled = false;
  (saved.states[0]!.parameters.offset as unknown as number[])[0] = 99;
  assert.equal(owner.service.state("first").enabled, true);
  assert.deepEqual(owner.service.state("first").parameters.offset, [2, 3]);
  assert.equal(snapshot(owner).definitions[0]!.graph.nodes.length, 1);
  const counters = owner.inspect();
  counters.revision = 99;
  assert.equal(owner.inspect().revision, 1);
});

test("configure changes clear ALL histories; parameter updates retain feedback", () => {
  const owner = create(), semantic = snapshot(owner);
  owner.service.resetHistory("second");
  assert.deepEqual(owner.historyRevisions(), { first: 0, second: 1 });
  assert.deepEqual(snapshot(owner), semantic);
  owner.service.configure("first", { enabled: true });
  assert.deepEqual(owner.historyRevisions(), { first: 0, second: 1 });
  owner.service.configure("first", { enabled: false });
  assert.deepEqual(owner.historyRevisions(), { first: 1, second: 2 });
  owner.service.setParameter("second", "gain", 5);
  assert.deepEqual(owner.historyRevisions(), { first: 1, second: 2 });
  owner.service.configure("second", { enabled: true });
  assert.deepEqual(owner.historyRevisions(), { first: 2, second: 3 });
  const before = snapshot(owner), counts = owner.inspect();
  owner.service.resetHistory();
  assert.deepEqual(owner.historyRevisions(), { first: 3, second: 4 });
  assert.deepEqual(snapshot(owner), before);
  assert.deepEqual(owner.inspect(), counts);
  const detached = owner.historyRevisions();
  assert.throws(() => { (detached as Record<string, number>).first = 99; }, TypeError);
});

test("unknown IDs, invalid configure fields, types and non-f32 values fail atomically", () => {
  const owner = create(), before = snapshot(owner), counts = owner.inspect(), history = owner.historyRevisions();
  for (const id of ["missing", "constructor", "toString", "__proto__", "", 1, null, Symbol("id")]) {
    for (const operation of [
      () => owner.service.state(id as string),
      () => owner.service.configure(id as string, { enabled: false }),
      () => owner.service.setParameter(id as string, "gain", 2),
      () => owner.service.resetHistory(id as string),
    ]) assert.throws(operation, diagnostic("TC_POSTPROCESS_ID"));
  }
  for (const settings of [null, [], {}, { enabled: "yes" }, { enabled: 1 }, { enabled: false, graph: {} }, { enabled: false, extra: 1 }])
    assert.throws(() => owner.service.configure("first", settings as never), diagnostic("TC_POSTPROCESS_CONFIGURE", "first:*"));
  for (const [name, value] of [
    ["gain", NaN], ["gain", Infinity], ["gain", 1e40], ["gain", "2"], ["gain", true],
    ["offset", [1]], ["offset", [1, 2, 3]], ["offset", [1, Infinity]], ["tint", [1, 2, 1e40]],
    ["rgba", [1, 2, 3, false]], ["feedback", 1], ["feedback", "false"],
  ] as const) assert.throws(() => owner.service.setParameter("first", name, value as GraphValue), diagnostic("TC_POSTPROCESS_PARAMETER_VALUE", `first:${name}`));
  for (const name of ["missing", "constructor", "__proto__", "", 1, null])
    assert.throws(() => owner.service.setParameter("first", name as string, 1), diagnostic("TC_POSTPROCESS_PARAMETER"));
  assert.deepEqual(snapshot(owner), before);
  assert.deepEqual(owner.inspect(), counts);
  assert.deepEqual(owner.historyRevisions(), history);
});

test("snapshot identity binds ordered kernels and defaults, excluding source locations and key ordering", () => {
  const owner = create(), saved = snapshot(owner), relocated = definitions();
  for (const d of relocated) d.source = { file: "moved/game.ts", line: 99, column: 8, length: 2 };
  relocated[0]!.graph.parameters = [...relocated[0]!.graph.parameters!].reverse();
  const compatible = createPostProcessOwner(relocated);
  compatible.restore(saved);
  assert.deepEqual(snapshot(compatible), saved);
  assert.deepEqual(compatible.historyRevisions(), { first: 1, second: 1 });
  const reordered = JSON.parse(JSON.stringify(saved), (_key, value) => value && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).reverse()) : value);
  compatible.validateSnapshot(reordered);
  assert.ok(saved.definitions.every(d => !Object.hasOwn(d, "source")));
  for (const mutate of [
    (s: any) => { s.definitions.reverse(); },
    (s: any) => { s.definitions[0].graph.nodes[0].value[0] = 9; },
    (s: any) => { s.definitions[0].enabled = false; },
    (s: any) => { s.definitions[0].graph.parameters[0].default = false; },
    (s: any) => { s.definitions[0].graph.historyChannels = ["second"]; },
    (s: any) => { s.definitions[0].source = {}; },
  ]) {
    const invalid = structuredClone(saved);
    mutate(invalid);
    assert.throws(() => owner.restore(invalid), diagnostic("TC_POSTPROCESS_SNAPSHOT"));
  }
  assert.deepEqual(snapshot(owner), saved);
  assert.deepEqual(owner.historyRevisions(), { first: 0, second: 0 });
});

test("restore preflights every state and parameter before mutations or history bumps", () => {
  const owner = create(), saved = snapshot(owner);
  owner.service.configure("first", { enabled: false });
  owner.service.setParameter("first", "gain", 9);
  owner.service.setParameter("second", "offset", [4, 5]);
  const before = snapshot(owner), counts = owner.inspect(), history = owner.historyRevisions();
  const mutations: ((s: any) => void)[] = [
    s => { s.version = 2; }, s => { s.extra = 1; }, s => { s.revision = 0; },
    s => { s.states.push(s.states[0]); }, s => { s.states.pop(); }, s => { s.states.reverse(); },
    s => { s.states[1].id = "missing"; }, s => { s.states[1].id = "first"; },
    s => { s.states[1].enabled = "false"; }, s => { delete s.states[1].enabled; },
    s => { s.states[1].history = 0; }, s => { s.states[1].parameters.extra = 1; },
    s => { delete s.states[1].parameters.gain; }, s => { s.states[1].parameters.offset = [1, 1e40]; },
    s => { s.states[1].parameters.feedback = 1; }, s => { s.states[1].parameters.offset = [1, 2, 3]; },
  ];
  for (const value of [null, undefined, {}, [], ...mutations.map(mutate => { const invalid = structuredClone(saved); mutate(invalid); return invalid; })]) {
    assert.throws(() => owner.validateSnapshot(value), diagnostic("TC_POSTPROCESS_SNAPSHOT"));
    assert.throws(() => owner.restore(value), diagnostic("TC_POSTPROCESS_SNAPSHOT"));
    assert.deepEqual(snapshot(owner), before);
    assert.deepEqual(owner.inspect(), counts);
    assert.deepEqual(owner.historyRevisions(), history);
  }
  owner.validateSnapshot(saved);
  assert.deepEqual(owner.historyRevisions(), history);
  owner.restore(saved);
  assert.deepEqual(snapshot(owner), saved);
  assert.equal(owner.inspect().revision, counts.revision + 1);
  assert.deepEqual(owner.historyRevisions(), { first: history.first! + 1, second: history.second! + 1 });
  const restoredRevision = owner.inspect().revision;
  owner.restore(saved);
  assert.equal(owner.inspect().revision, restoredRevision);
  assert.deepEqual(owner.historyRevisions(), { first: history.first! + 2, second: history.second! + 2 });
  (saved.states[1]!.parameters.offset as unknown as number[])[0] = 99;
  assert.deepEqual(owner.service.state("second").parameters.offset, [0, 1]);
});

test("accessors, sparse arrays, prototypes, symbols and cycles fail without invoking getters", () => {
  const owner = create(), before = snapshot(owner);
  let reads = 0;
  const getter = { enumerable: true, get() { reads++; return false; } };
  const mutations: ((s: any) => void)[] = [
    s => { Object.setPrototypeOf(s, { extra: true }); },
    s => { Object.defineProperty(s.states[1], "enabled", getter); },
    s => { Object.defineProperty(s.states[1].parameters, "gain", getter); },
    s => { Object.defineProperty(s.states[1].parameters.offset, "0", getter); },
    s => { Object.defineProperty(s.definitions[0].graph, "output", getter); },
    s => { Object.defineProperty(s, "version", getter); },
    s => { s.states[Symbol("extra")] = 1; },
    s => { delete s.states[1]; },
    s => { delete s.states[1].parameters.offset[0]; },
    s => { s.states[1].parameters.offset.extra = 1; },
    s => { Object.setPrototypeOf(s.states[1].parameters.offset, null); },
    s => { s.states[1].parameters.offset = new Float32Array([1, 2]); },
    s => { s.states[1].parameters.gain = s; },
  ];
  for (const mutate of mutations) {
    const invalid = snapshot(owner);
    mutate(invalid);
    assert.throws(() => owner.restore(invalid), diagnostic("TC_POSTPROCESS_SNAPSHOT"));
  }
  const vector = [1, 2];
  Object.defineProperty(vector, "0", getter);
  assert.throws(() => owner.service.setParameter("first", "offset", vector as unknown as GraphValue), diagnostic("TC_POSTPROCESS_PARAMETER_VALUE"));
  const settings = {};
  Object.defineProperty(settings, "enabled", getter);
  assert.throws(() => owner.service.configure("first", settings as never), diagnostic("TC_POSTPROCESS_CONFIGURE"));
  assert.equal(reads, 0);
  assert.deepEqual(snapshot(owner), before);
  assert.deepEqual(owner.historyRevisions(), { first: 0, second: 0 });
});

test("empty and parameterless owners preserve optional snapshots and reject unexpected states", () => {
  const empty = createPostProcessOwner();
  assert.deepEqual(empty.states(), []);
  assert.deepEqual(empty.historyRevisions(), {});
  assert.equal(empty.snapshot(), undefined);
  empty.validateSnapshot(undefined);
  empty.restore(undefined);
  empty.service.resetHistory();
  for (const value of [null, {}, { version: 1, definitions: [], states: [] }, snapshot(create())])
    assert.throws(() => empty.restore(value), diagnostic("TC_POSTPROCESS_SNAPSHOT"));
  const d = definition();
  delete d.graph.parameters;
  const owner = createPostProcessOwner([d]), saved = snapshot(owner);
  assert.deepEqual(owner.service.state(d.id).parameters, {});
  owner.restore(saved);
  assert.deepEqual(owner.historyRevisions(), { feedback: 1 });
  (saved.states[0]!.parameters as Record<string, GraphValue>).unexpected = 1;
  assert.throws(() => owner.restore(saved), diagnostic("TC_POSTPROCESS_SNAPSHOT"));
});

test("special record keys cannot alias prototypes", () => {
  const d = definition("constructor");
  d.graph.parameters = ["constructor", "toString", "__proto__"].map(name => ({ name, type: "float", default: 1 }));
  const owner = createPostProcessOwner([d]);
  for (const p of d.graph.parameters) owner.service.setParameter(d.id, p.name, 2);
  const saved = snapshot(owner);
  owner.restore(JSON.parse(JSON.stringify(saved)));
  assert.deepEqual(owner.service.state(d.id).parameters, JSON.parse('{"constructor":2,"toString":2,"__proto__":2}'));
  assert.equal(Object.getPrototypeOf(owner.historyRevisions()), Object.prototype);
  assert.deepEqual(owner.historyRevisions(), { constructor: 1 });
});

test("frozen and null-prototype snapshots validate without mutation", () => {
  const owner = create(), saved = snapshot(owner);
  const freeze = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  };
  freeze(saved);
  owner.service.setParameter("first", "gain", 8);
  const before = snapshot(owner), counts = owner.inspect();
  owner.validateSnapshot(saved);
  assert.deepEqual(snapshot(owner), before);
  assert.deepEqual(owner.inspect(), counts);
  const safe = snapshot(owner);
  Object.setPrototypeOf(safe, null);
  Object.setPrototypeOf(safe.states[0]!.parameters, null);
  owner.validateSnapshot(safe);
  owner.restore(saved);
  assert.equal(owner.service.state("first").parameters.gain, 0.5);
});

test("malformed definitions and parameter declarations have postprocess diagnostics", () => {
  const mutations: ((d: any) => void)[] = [
    d => { d.id = "scene.color"; }, d => { d.id = "1bad"; }, d => { d.id = ""; },
    d => { d.enabled = 1; }, d => { d.graph = null; }, d => { d.graph.outputType = "float"; },
    d => { d.extra = 1; }, d => { d.graph.nodes[0].value[0] = Infinity; },
    d => { d.graph.parameters[0].type = "vec5"; }, d => { d.graph.parameters[0].default = "1"; },
    d => { d.graph.parameters.push(d.graph.parameters[0]); },
  ];
  for (const mutate of mutations) {
    const d = definition();
    mutate(d);
    assert.throws(() => createPostProcessOwner([d]), /TC_POSTPROCESS_[A-Z_]+:.*Repair:/);
  }
  assert.throws(() => createPostProcessOwner([definition(), definition()]), diagnostic("TC_POSTPROCESS_ID"));
  assert.throws(() => createPostProcessOwner(new Array(1)), diagnostic("TC_POSTPROCESS_DEFINITION"));
});

test("render driver exposes effects and retains exact legacy snapshots without passes", () => {
  const driver = createRenderSettingsDriver(), plugin = driver.factory({} as never);
  assert.equal(driver.service.effects, driver.postProcesses.service);
  assert.deepEqual(plugin.snapshot(), { version: 1, defaults: DEFAULT_RENDER_SETTINGS, settings: DEFAULT_RENDER_SETTINGS });
  assert.throws(() => plugin.restore({ ...(plugin.snapshot() as object), postProcesses: snapshot(create()) }), diagnostic("TC_POSTPROCESS_SNAPSHOT"));
  plugin.restore(plugin.snapshot());
  assert.deepEqual(driver.postProcesses.states(), []);
});

test("render driver restores settings, material parameters and effects with atomic preflight", () => {
  const driver = createRenderSettingsDriver({}, [{ id: "material", parameters: [{ name: "gain", type: "float", default: 1 }] }], undefined, definitions());
  const plugin = driver.factory({} as never), saved = plugin.snapshot() as any;
  assert.equal(driver.service.effects, driver.postProcesses.service);
  assert.ok(Object.hasOwn(saved, "postProcesses"));
  driver.service.configure({ exposure: 2 });
  driver.service.setMaterialParameter("material", "gain", 3);
  driver.service.effects.configure("first", { enabled: false });
  driver.service.effects.setParameter("second", "gain", 4);
  const before = plugin.snapshot(), history = driver.postProcesses.historyRevisions(), counts = driver.postProcesses.inspect();
  for (const mutate of [
    (s: any) => { s.postProcesses.states[1].parameters.offset = [1, Infinity]; },
    (s: any) => { delete s.postProcesses; },
    (s: any) => { s.postProcesses.definitions[0].graph.output = "other"; },
    (s: any) => { s.parameters.values.material.gain = false; },
    (s: any) => { s.settings.exposure = -1; },
  ]) {
    const invalid = structuredClone(saved);
    mutate(invalid);
    assert.throws(() => plugin.restore(invalid), /TC_(POSTPROCESS_SNAPSHOT|RENDER_PARAMETER|RENDER_SETTINGS)/);
    assert.deepEqual(plugin.snapshot(), before);
    assert.deepEqual(driver.postProcesses.historyRevisions(), history);
    assert.deepEqual(driver.postProcesses.inspect(), counts);
  }
  plugin.validateSnapshot(saved);
  assert.deepEqual(plugin.snapshot(), before);
  plugin.restore(saved);
  assert.deepEqual(plugin.snapshot(), saved);
  assert.deepEqual(driver.postProcesses.historyRevisions(), { first: history.first! + 1, second: history.second! + 1 });
});

test("owner and render plugin disposal are idempotent and reject retained effects references", () => {
  const owner = create(), saved = snapshot(owner);
  owner.dispose();
  owner.dispose();
  for (const operation of [
    () => owner.states(), () => owner.historyRevisions(), () => owner.snapshot(), () => owner.inspect(),
    () => owner.validateSnapshot(saved), () => owner.restore(saved),
    () => owner.service.state("first"), () => owner.service.configure("first", { enabled: true }),
    () => owner.service.setParameter("first", "gain", 1), () => owner.service.resetHistory(),
  ]) assert.throws(operation, diagnostic("TC_POSTPROCESS_DISPOSED"));
  for (const pluginFirst of [true, false]) {
    const driver = createRenderSettingsDriver({}, [], undefined, definitions()), plugin = driver.factory({} as never), effects = driver.service.effects;
    if (pluginFirst) plugin.dispose();
    driver.dispose();
    plugin.dispose();
    driver.dispose();
    assert.throws(() => effects.state("first"), diagnostic("TC_POSTPROCESS_DISPOSED"));
    assert.throws(() => effects.resetHistory(), diagnostic("TC_POSTPROCESS_DISPOSED"));
    assert.throws(() => driver.service.state(), /TC_RENDER_DISPOSED/);
    assert.throws(() => plugin.snapshot(), /TC_RENDER_DISPOSED/);
  }
});

test("render restore rejects accessor snapshots before touching any owner", () => {
  const driver = createRenderSettingsDriver({}, [], undefined, definitions()), plugin = driver.factory({} as never);
  const before = plugin.snapshot(), history = driver.postProcesses.historyRevisions();
  let reads = 0;
  for (const mutate of [
    (s: any) => { Object.defineProperty(s, "postProcesses", { enumerable: true, get() { reads++; return before; } }); },
    (s: any) => { Object.defineProperty(s.settings, "exposure", { enumerable: true, get() { reads++; return 2; } }); },
    (s: any) => { Object.defineProperty(s.defaults, "mode", { enumerable: true, get() { reads++; return "raster"; } }); },
    (s: any) => { s.states = []; },
  ]) {
    const invalid = structuredClone(before);
    mutate(invalid);
    assert.throws(() => plugin.validateSnapshot(invalid), /TC_RENDER_SNAPSHOT/);
    assert.throws(() => plugin.restore(invalid), /TC_RENDER_SNAPSHOT/);
    assert.deepEqual(plugin.snapshot(), before);
    assert.deepEqual(driver.postProcesses.historyRevisions(), history);
  }
  assert.equal(reads, 0);
});
