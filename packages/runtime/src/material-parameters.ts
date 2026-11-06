import type { GraphParameter, GraphType, GraphValue } from "../../sdk/src/index.ts";
import { graphValue, isGraphType } from "../../sdk/src/graph-values.ts";

type Values = Record<string, GraphValue>;
type Definition = { id: string; parameters: GraphParameter[] };
export interface MaterialParameterSnapshot {
  version: 1;
  definitions: Definition[];
  values: Record<string, Values>;
}
type Code = "TC_RENDER_MATERIAL" | "TC_RENDER_PARAMETER" | "TC_RENDER_PARAMETER_VALUE" | "TC_RENDER_PARAMETERS_SNAPSHOT";
const snapshotCode = "TC_RENDER_PARAMETERS_SNAPSHOT";
const fail = (code: Code, at: string, detail: string): never => {
  throw new Error(`${code}: ${at}: ${detail} Repair: Use declared material IDs/names, matching finite f32 values, and snapshots from identical definitions.`);
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
const checked = (type: GraphType, value: unknown, code: Code, at: string): GraphValue => {
  if (Array.isArray(value) && !dense(value)) return fail(code, at, "Expected a dense plain vector.");
  return graphValue(type, value) ?? fail(code, at, `Expected ${type} with finite f32 components.`);
};
const clone = (value: GraphValue, frozen = false): GraphValue => {
  if (!Array.isArray(value)) return value;
  const result = [...value];
  return (frozen ? Object.freeze(result) : result) as unknown as GraphValue;
};
const same = (a: GraphValue, b: GraphValue): boolean =>
  Array.isArray(a) ? Array.isArray(b) && a.length === b.length && a.every((v, i) => v === b[i]) : a === b;
const copyValues = (values: Values, frozen = false): Values =>
  Object.fromEntries(Object.entries(values).map(([name, value]) => [name, clone(value, frozen)]));

/** CPU-only owner. Snapshots stage all values before any live state is changed. */
export function createMaterialParameters(definitions: readonly { id: string; parameters?: readonly GraphParameter[] }[]) {
  const materials = new Map<string, { parameters: GraphParameter[]; values: Values }>();
  if (!dense(definitions)) fail("TC_RENDER_MATERIAL", "*:*", "Expected a dense definitions array.");
  for (const definition of definitions) {
    if (!plain(definition) || typeof definition.id !== "string" || !/^[a-zA-Z][a-zA-Z0-9_.-]*$/.test(definition.id))
      fail("TC_RENDER_MATERIAL", "*:*", "Expected a valid material ID.");
    const id = definition.id;
    if (materials.has(id)) fail("TC_RENDER_MATERIAL", `${id}:*`, "Duplicate material ID.");
    const source = definition.parameters === undefined ? [] : definition.parameters;
    if (!dense(source)) fail("TC_RENDER_PARAMETER", `${id}:*`, "Expected a dense parameters array.");
    const names = new Set<string>(), parameters: GraphParameter[] = [];
    for (const parameter of source) {
      if (!exact(parameter, ["name", "type", "default"]) || typeof parameter.name !== "string" || !parameter.name.trim())
        fail("TC_RENDER_PARAMETER", `${id}:*`, "Expected a nonempty parameter name, type and default.");
      const at = `${id}:${parameter.name}`;
      if (names.has(parameter.name)) fail("TC_RENDER_PARAMETER", at, "Duplicate parameter name.");
      if (!isGraphType(parameter.type)) fail("TC_RENDER_PARAMETER", at, "Unknown graph type.");
      names.add(parameter.name);
      parameters.push({ name: parameter.name, type: parameter.type, default: checked(parameter.type, parameter.default, "TC_RENDER_PARAMETER_VALUE", at) });
    }
    parameters.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    materials.set(id, { parameters, values: Object.fromEntries(parameters.map(p => [p.name, clone(p.default, true)])) });
  }
  const canonical: Definition[] = [...materials].filter(([, m]) => m.parameters.length)
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([id, m]) => ({ id, parameters: m.parameters }));
  let disposed = false, revision = 0;
  const active = () => {
    if (disposed) throw new Error("TC_RENDER_DISPOSED: *:*: Material parameters owner is disposed. Repair: Create a new owner.");
  };
  const material = (id: string) => materials.get(id) ?? fail("TC_RENDER_MATERIAL", `${id}:*`, "Unknown material.");
  const validate = (value: unknown): Map<string, Values> => {
    active();
    const staged = new Map<string, Values>();
    if (!canonical.length && value === undefined) return staged;
    const bad = (at = "*:*"): never => fail(snapshotCode, at, "Incompatible material parameters snapshot.");
    if (!canonical.length || !exact(value, ["version", "definitions", "values"]) || value.version !== 1 || !dense(value.definitions) || value.definitions.length !== canonical.length)
      return bad();
    if (!exact(value.values, canonical.map(d => d.id))) return bad();
    for (let i = 0; i < canonical.length; i++) {
      const expected = canonical[i]!, actual = value.definitions[i];
      if (!exact(actual, ["id", "parameters"]) || actual.id !== expected.id || !dense(actual.parameters) || actual.parameters.length !== expected.parameters.length) return bad(`${expected.id}:*`);
      const entries: [string, GraphValue][] = [], values = value.values[expected.id];
      if (!exact(values, expected.parameters.map(p => p.name))) return bad(`${expected.id}:*`);
      for (let j = 0; j < expected.parameters.length; j++) {
        const p = expected.parameters[j]!, descriptor = actual.parameters[j], at = `${expected.id}:${p.name}`;
        if (!exact(descriptor, ["name", "type", "default"]) || descriptor.name !== p.name || descriptor.type !== p.type || !same(checked(p.type, descriptor.default, snapshotCode, at), p.default)) return bad(at);
        entries.push([p.name, checked(p.type, values[p.name], snapshotCode, at)]);
      }
      staged.set(expected.id, Object.fromEntries(entries));
    }
    return staged;
  };
  return {
    set(id: string, name: string, value: GraphValue): void {
      active();
      const m = material(id), parameter = m.parameters.find(p => p.name === name);
      if (!parameter) return fail("TC_RENDER_PARAMETER", `${id}:${name}`, "Unknown parameter.");
      const next = checked(parameter.type, value, "TC_RENDER_PARAMETER_VALUE", `${id}:${name}`);
      if (!same(m.values[name]!, next)) { m.values[name] = next; revision++; }
    },
    get(id: string): Readonly<Values> {
      active();
      return Object.freeze(copyValues(material(id).values, true));
    },
    snapshot(): MaterialParameterSnapshot | undefined {
      active();
      if (!canonical.length) return undefined;
      return {
        version: 1,
        definitions: canonical.map(d => ({ id: d.id, parameters: d.parameters.map(p => ({ ...p, default: clone(p.default) })) })),
        values: Object.fromEntries(canonical.map(d => [d.id, copyValues(material(d.id).values)])),
      };
    },
    validateSnapshot(value: unknown): void { validate(value); },
    restore(value: unknown): void {
      const staged = validate(value);
      const changed = [...staged].some(([id, values]) => Object.keys(values).some(name => !same(material(id).values[name]!, values[name]!)));
      if (changed) { for (const [id, values] of staged) material(id).values = values; revision++; }
    },
    dispose(): void { disposed = true; },
    inspect(): { materials: number; parameters: number; revision: number } {
      active();
      return { materials: materials.size, parameters: canonical.reduce((n, d) => n + d.parameters.length, 0), revision };
    },
  };
}
