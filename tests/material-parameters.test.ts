import test from "node:test";
import assert from "node:assert/strict";
import type { GraphParameter, GraphType, GraphValue } from "../packages/sdk/src/index.ts";
import { createMaterialParameters, type MaterialParameterSnapshot } from "../packages/runtime/src/material-parameters.ts";

const declarations = (): GraphParameter[] => [
  { name: "scalar", type: "float", default: 0.5 },
  { name: "uv", type: "vec2", default: [1, 2] },
  { name: "color", type: "vec3", default: [0.1, 0.2, 0.3] },
  { name: "rgba", type: "vec4", default: [1, 2, 3, 4] },
  { name: "enabled", type: "bool", default: true },
];
const create = () => createMaterialParameters([{ id: "mat", parameters: declarations() }]);
type Owner = ReturnType<typeof createMaterialParameters>;
const snapshot = (owner: Owner): MaterialParameterSnapshot => {
  const value = owner.snapshot();
  assert.ok(value);
  return value;
};
const error = (code: string, at: string) => (value: unknown): boolean => {
  assert.ok(value instanceof Error);
  assert.ok(value.message.startsWith(code + ":"), value.message);
  assert.ok(value.message.includes(at), value.message);
  assert.match(value.message, /Repair:/);
  return true;
};

test("all five SDK types initialize defaults and accept matching updates", () => {
  const owner = create();
  assert.deepEqual(owner.get("mat"), Object.fromEntries(declarations().map(p => [p.name, p.default])));
  const updates: Record<string, GraphValue> = { scalar: 2, uv: [3, 4], color: [5, 6, 7], rgba: [8, 9, 10, 11], enabled: false };
  for (const [name, value] of Object.entries(updates)) owner.set("mat", name, value);
  assert.deepEqual(owner.get("mat"), updates);
  assert.deepEqual(owner.inspect(), { materials: 1, parameters: 5, revision: 5 });
});

test("definitions, set inputs and get results never share mutable vectors", () => {
  const parameters = declarations(), definitions = [{ id: "mat", parameters }];
  const owner = createMaterialParameters(definitions), saved = snapshot(owner);
  (parameters[1]!.default as unknown as number[])[0] = 99;
  parameters[0]!.name = "renamed";
  parameters[0]!.type = "bool";
  parameters.push({ name: "late", type: "float", default: 10 });
  definitions[0]!.id = "other";
  definitions.length = 0;
  assert.deepEqual(snapshot(owner), saved);
  const vector: [number, number, number] = [2, 3, 4];
  owner.set("mat", "color", vector);
  vector[0] = 99;
  const result = owner.get("mat"), other = owner.get("mat");
  assert.deepEqual(result.color, [2, 3, 4]);
  assert.notEqual(result, other);
  assert.notEqual(result.color, other.color);
  assert.ok(Object.isFrozen(result));
  for (const value of Object.values(result)) if (Array.isArray(value)) assert.ok(Object.isFrozen(value));
  assert.throws(() => { (result as Record<string, GraphValue>).scalar = 9; }, TypeError);
  assert.throws(() => { (result.color as unknown as number[])[0] = 9; }, TypeError);
  assert.equal(owner.get("mat").scalar, 0.5);
});

test("parameterless materials stay known and preserve undefined legacy snapshots", () => {
  for (const definitions of [[], [{ id: "empty" }], [{ id: "empty", parameters: [] }]]) {
    const owner = createMaterialParameters(definitions);
    assert.equal(owner.snapshot(), undefined);
    owner.validateSnapshot(undefined);
    owner.restore(undefined);
    if (definitions.length) {
      assert.deepEqual(owner.get("empty"), {});
      assert.ok(Object.isFrozen(owner.get("empty")));
      assert.throws(() => owner.set("empty", "missing", 1), error("TC_RENDER_PARAMETER", "empty:missing"));
    }
    for (const invalid of [null, {}, { version: 1, definitions: [], values: {} }]) {
      assert.throws(() => owner.validateSnapshot(invalid), error("TC_RENDER_PARAMETERS_SNAPSHOT", "*:*"));
      assert.throws(() => owner.restore(invalid), /TC_RENDER_PARAMETERS_SNAPSHOT/);
    }
    assert.equal(owner.inspect().revision, 0);
  }
});

test("unknown IDs and parameter names have stable errors without prototype collisions", () => {
  const owner = create();
  for (const id of ["missing", "constructor", "toString", "__proto__"]) {
    assert.throws(() => owner.get(id), error("TC_RENDER_MATERIAL", `${id}:*`));
    assert.throws(() => owner.set(id, "scalar", 1), error("TC_RENDER_MATERIAL", `${id}:*`));
  }
  for (const name of ["missing", "constructor", "toString", "__proto__", ""]) {
    assert.throws(() => owner.set("mat", name, 1), error("TC_RENDER_PARAMETER", `mat:${name}`));
  }
  const special = createMaterialParameters([{ id: "constructor", parameters: ["constructor", "toString", "__proto__"].map(name => ({ name, type: "float", default: 1 })) }]);
  for (const name of ["constructor", "toString", "__proto__"]) special.set("constructor", name, 2);
  const saved = snapshot(special);
  assert.deepEqual(special.get("constructor"), JSON.parse('{"constructor":2,"toString":2,"__proto__":2}'));
  special.validateSnapshot(JSON.parse(JSON.stringify(saved)));
  special.set("constructor", "__proto__", 3);
  special.restore(saved);
  assert.equal(special.get("constructor")["__proto__"], 2);
  assert.equal(Object.getPrototypeOf(special.get("constructor")), Object.prototype);
});

test("creation rejects invalid or duplicate IDs, malformed declarations, types and defaults", () => {
  const cases: [unknown, string, string][] = [
    [null, "TC_RENDER_MATERIAL", "*:*"],
    [[{ id: "bad id" }], "TC_RENDER_MATERIAL", "*:*"],
    [[{ id: "1bad" }], "TC_RENDER_MATERIAL", "*:*"],
    [[{ id: "" }], "TC_RENDER_MATERIAL", "*:*"],
    [[{ id: "mat" }, { id: "mat" }], "TC_RENDER_MATERIAL", "mat:*"],
    [[{ id: "mat", parameters: null }], "TC_RENDER_PARAMETER", "mat:*"],
    [[{ id: "mat", parameters: new Array(1) }], "TC_RENDER_PARAMETER", "mat:*"],
    [[{ id: "mat", parameters: [{ name: "", type: "float", default: 0 }] }], "TC_RENDER_PARAMETER", "mat:*"],
    [[{ id: "mat", parameters: [{ name: "  ", type: "float", default: 0 }] }], "TC_RENDER_PARAMETER", "mat:*"],
    [[{ id: "mat", parameters: [{ name: "x", type: "int", default: 0 }] }], "TC_RENDER_PARAMETER", "mat:x"],
    [[{ id: "mat", parameters: [{ name: "x", type: "float" }] }], "TC_RENDER_PARAMETER", "mat:*"],
    [[{ id: "mat", parameters: [{ name: "x", type: "float", default: 0 }, { name: "x", type: "bool", default: true }] }], "TC_RENDER_PARAMETER", "mat:x"],
  ];
  for (const [input, code, at] of cases) assert.throws(() => createMaterialParameters(input as never), error(code, at));
  const badDefaults: [GraphType, unknown][] = [
    ["float", NaN], ["float", Infinity], ["float", 1e40], ["float", "1"],
    ["bool", 1], ["vec2", [1]], ["vec2", [1, 2, 3]], ["vec3", [1, NaN, 3]],
    ["vec4", [1, 2, 3, 1e40]], ["vec2", new Array(2)],
  ];
  for (const [type, value] of badDefaults) {
    assert.throws(() => createMaterialParameters([{ id: "mat", parameters: [{ name: "x", type, default: value as GraphValue }] }]), error("TC_RENDER_PARAMETER_VALUE", "mat:x"));
  }
  assert.doesNotThrow(() => createMaterialParameters([{ id: "A.valid-id_2", parameters: [] }]));
});

test("invalid set values leave all values and revision untouched", () => {
  const owner = create(), before = snapshot(owner), counts = owner.inspect();
  const invalid: [string, unknown][] = [
    ["scalar", NaN], ["scalar", Infinity], ["scalar", -Infinity], ["scalar", 1e40],
    ["scalar", true], ["scalar", "1"], ["scalar", null], ["scalar", [1]],
    ["enabled", 0], ["enabled", "false"], ["uv", [1, 2, 3]], ["uv", [1]],
    ["uv", new Float32Array([1, 2])], ["uv", new Array(2)], ["uv", [undefined, 2]],
    ["color", [1, NaN, 3]], ["rgba", [1, 2, 3, 1e40]],
    ["uv", Object.assign([1, 2], { extra: 3 })],
    ["uv", Object.setPrototypeOf([1, 2], null)],
  ];
  for (const [name, value] of invalid) {
    assert.throws(() => owner.set("mat", name, value as GraphValue), error("TC_RENDER_PARAMETER_VALUE", `mat:${name}`));
    assert.deepEqual(snapshot(owner), before);
    assert.deepEqual(owner.inspect(), counts);
  }
  owner.set("mat", "scalar", 3.4028234663852886e38);
  assert.equal(owner.get("mat").scalar, 3.4028234663852886e38);
});

test("snapshots are canonical, deeply mutable JSON independent of definition order", () => {
  const owner = createMaterialParameters([{ id: "z", parameters: declarations() }, { id: "empty" }, { id: "a", parameters: declarations().reverse() }]);
  const other = createMaterialParameters([{ id: "a", parameters: declarations() }, { id: "z", parameters: declarations().reverse() }]);
  const saved = snapshot(owner);
  assert.deepEqual(saved, snapshot(other));
  assert.deepEqual(saved.definitions.map(d => d.id), ["a", "z"]);
  assert.deepEqual(saved.definitions[0]!.parameters.map(p => p.name), ["color", "enabled", "rgba", "scalar", "uv"]);
  assert.deepEqual(Object.keys(saved.values), ["a", "z"]);
  assert.deepEqual(saved, JSON.parse(JSON.stringify(saved)));
  const mutableJSON = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    assert.equal(Object.isFrozen(value), false);
    assert.equal(Object.getPrototypeOf(value), Array.isArray(value) ? Array.prototype : Object.prototype);
    for (const child of Object.values(value)) mutableJSON(child);
  };
  mutableJSON(saved);
  other.validateSnapshot(saved);
  (saved.definitions[0]!.parameters[0]!.default as unknown as number[])[0] = 99;
  (saved.values.a!.color as unknown as number[])[0] = 98;
  saved.definitions[0]!.parameters.length = 0;
  delete saved.values.z;
  assert.deepEqual(snapshot(owner), snapshot(other));
});

test("snapshots reject schema, declaration, default and value mismatches transactionally", () => {
  const owner = create(), saved = snapshot(owner);
  const mutations: [string, (s: any) => void][] = [
    ["extra root field", s => { s.extra = 1; }],
    ["missing root field", s => { delete s.version; }],
    ["wrong version", s => { s.version = 2; }],
    ["coerced version", s => { s.version = "1"; }],
    ["missing definitions", s => { s.definitions = []; }],
    ["extra definitions", s => { s.definitions.push(s.definitions[0]); }],
    ["sparse definitions", s => { delete s.definitions[0]; }],
    ["wrong material", s => { s.definitions[0].id = "other"; }],
    ["extra descriptor field", s => { s.definitions[0].extra = 1; }],
    ["missing descriptor field", s => { delete s.definitions[0].id; }],
    ["missing parameters", s => { s.definitions[0].parameters.pop(); }],
    ["extra parameters", s => { s.definitions[0].parameters.push(s.definitions[0].parameters[0]); }],
    ["sparse parameters", s => { delete s.definitions[0].parameters[0]; }],
    ["reordered parameters", s => { s.definitions[0].parameters.reverse(); }],
    ["wrong parameter name", s => { s.definitions[0].parameters[0].name = "renamed"; }],
    ["wrong parameter type", s => { s.definitions[0].parameters[0].type = "vec4"; }],
    ["wrong parameter default", s => { s.definitions[0].parameters[0].default = [9, 9, 9]; }],
    ["extra parameter field", s => { s.definitions[0].parameters[0].extra = 1; }],
    ["missing default", s => { delete s.definitions[0].parameters[0].default; }],
    ["nonfinite default", s => { s.definitions[0].parameters[0].default = [NaN, 2, 3]; }],
    ["overflow default", s => { s.definitions[0].parameters[0].default = [1e40, 2, 3]; }],
    ["sparse default", s => { s.definitions[0].parameters[0].default = new Array(3); }],
    ["missing material values", s => { delete s.values.mat; }],
    ["extra material values", s => { s.values.other = {}; }],
    ["array values", s => { s.values = []; }],
    ["missing named value", s => { delete s.values.mat.scalar; }],
    ["extra named value", s => { s.values.mat.other = 1; }],
    ["null material values", s => { s.values.mat = null; }],
    ["wrong value type", s => { s.values.mat.enabled = 1; }],
    ["wrong vector size", s => { s.values.mat.uv = [1, 2, 3]; }],
    ["nonfinite value", s => { s.values.mat.scalar = NaN; }],
    ["overflow value", s => { s.values.mat.scalar = 1e40; }],
    ["sparse vector", s => { s.values.mat.uv = new Array(2); }],
  ];
  owner.set("mat", "scalar", 10);
  const before = snapshot(owner), counts = owner.inspect();
  for (const [label, mutate] of mutations) {
    const invalid = structuredClone(saved);
    mutate(invalid);
    assert.throws(() => owner.validateSnapshot(invalid), /TC_RENDER_PARAMETERS_SNAPSHOT/, label);
    assert.throws(() => owner.restore(invalid), /TC_RENDER_PARAMETERS_SNAPSHOT/, label);
    assert.deepEqual(snapshot(owner), before, label);
    assert.deepEqual(owner.inspect(), counts, label);
  }
  for (const invalid of [undefined, null, false, 1, [], {}]) {
    assert.throws(() => owner.restore(invalid), /TC_RENDER_PARAMETERS_SNAPSHOT/);
  }
});

test("unsafe prototypes, accessors, symbols and hidden properties are rejected without invoking getters", () => {
  const owner = create();
  let reads = 0;
  const getter = { enumerable: true, configurable: true, get() { reads++; return 1; } };
  const mutations: ((s: any) => void)[] = [
    s => { Object.setPrototypeOf(s, { injected: true }); },
    s => { Object.setPrototypeOf(s.definitions, null); },
    s => { Object.setPrototypeOf(s.definitions[0], { injected: true }); },
    s => { Object.setPrototypeOf(s.definitions[0].parameters[0], { injected: true }); },
    s => { Object.setPrototypeOf(s.values, { injected: true }); },
    s => { Object.setPrototypeOf(s.values.mat, { injected: true }); },
    s => { Object.setPrototypeOf(s.values.mat.uv, null); },
    s => { Object.defineProperty(s, "version", getter); },
    s => { Object.defineProperty(s.values.mat, "scalar", getter); },
    s => { Object.defineProperty(s.values.mat.uv, "0", getter); },
    s => { Object.defineProperty(s.definitions[0].parameters[0], "default", getter); },
    s => { s[Symbol("extra")] = 1; },
    s => { s.values.mat.uv[Symbol("extra")] = 1; },
    s => { Object.defineProperty(s, "extra", { value: 1 }); },
    s => { Object.defineProperty(s.values.mat, "scalar", { enumerable: false }); },
    s => { Object.defineProperty(s.values.mat.uv, "0", { enumerable: false }); },
  ];
  for (const mutate of mutations) {
    const invalid = snapshot(owner);
    mutate(invalid);
    assert.throws(() => owner.validateSnapshot(invalid), /TC_RENDER_PARAMETERS_SNAPSHOT/);
    assert.throws(() => owner.restore(invalid), /TC_RENDER_PARAMETERS_SNAPSHOT/);
  }
  assert.equal(reads, 0);
  const vector = [1, 2];
  Object.defineProperty(vector, "0", getter);
  assert.throws(() => owner.set("mat", "uv", vector as unknown as GraphValue), /TC_RENDER_PARAMETER_VALUE/);
  assert.equal(reads, 0);
});

test("validation is pure on deeply frozen snapshots and safe null-prototype records", () => {
  const owner = create(), saved = snapshot(owner);
  owner.set("mat", "scalar", 9);
  const before = snapshot(owner), counts = owner.inspect();
  const freeze = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  };
  freeze(saved);
  owner.validateSnapshot(saved);
  assert.deepEqual(snapshot(owner), before);
  assert.deepEqual(owner.inspect(), counts);
  const safe = snapshot(owner);
  Object.setPrototypeOf(safe, null);
  Object.setPrototypeOf(safe.values, null);
  Object.setPrototypeOf(safe.values.mat!, null);
  owner.validateSnapshot(safe);
  assert.equal(Object.getPrototypeOf(safe), null);
  assert.deepEqual(owner.inspect(), counts);
  owner.restore(saved);
  assert.equal(owner.get("mat").scalar, 0.5);
});

test("restore validates every material before applying any staged changes", () => {
  const owner = createMaterialParameters([{ id: "a", parameters: declarations() }, { id: "z", parameters: declarations() }, { id: "empty" }]);
  const saved = snapshot(owner);
  owner.set("a", "scalar", 8);
  owner.set("z", "uv", [9, 10]);
  const before = snapshot(owner), counts = owner.inspect();
  const invalid = structuredClone(saved);
  invalid.values.z!.uv = [1, Infinity];
  assert.throws(() => owner.restore(invalid), error("TC_RENDER_PARAMETERS_SNAPSHOT", "z:uv"));
  assert.deepEqual(snapshot(owner), before);
  assert.deepEqual(owner.inspect(), counts);
  owner.restore(saved);
  assert.deepEqual(snapshot(owner), saved);
  assert.equal(owner.inspect().revision, counts.revision + 1);
  (saved.values.a!.color as unknown as number[])[0] = 100;
  (saved.values.z!.uv as unknown as number[])[0] = 100;
  assert.deepEqual(owner.get("a").color, [0.1, 0.2, 0.3]);
  assert.deepEqual(owner.get("z").uv, [1, 2]);
  assert.deepEqual(owner.get("empty"), {});
});

test("equal set and restore are no-ops and inspection exposes detached counts only", () => {
  const owner = create(), saved = snapshot(owner);
  const counts = owner.inspect();
  counts.materials = 100;
  counts.parameters = 100;
  counts.revision = 100;
  assert.deepEqual(owner.inspect(), { materials: 1, parameters: 5, revision: 0 });
  for (const parameter of declarations()) owner.set("mat", parameter.name, parameter.default);
  owner.validateSnapshot(saved);
  owner.restore(saved);
  assert.equal(owner.inspect().revision, 0);
  owner.set("mat", "scalar", 9);
  assert.equal(owner.inspect().revision, 1);
  owner.restore(saved);
  assert.equal(owner.inspect().revision, 2);
  owner.restore(saved);
  assert.equal(owner.inspect().revision, 2);
});

test("dispose is idempotent and rejects every other operation", () => {
  for (const owner of [create(), createMaterialParameters([{ id: "empty" }])]) {
    const saved = owner.snapshot();
    owner.dispose();
    owner.dispose();
    for (const operation of [
      () => owner.set("mat", "scalar", 1),
      () => owner.get("mat"),
      () => owner.snapshot(),
      () => owner.validateSnapshot(saved),
      () => owner.restore(saved),
      () => owner.inspect(),
    ]) assert.throws(operation, error("TC_RENDER_DISPOSED", "*:*"));
  }
});
