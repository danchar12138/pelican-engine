import type { PostProcessIR } from "../../compiler/src/types.ts";
import type { PostProcessService, PostProcessState } from "../../sdk/src/index.ts";
import { createMaterialParameters } from "./material-parameters.ts";
import type { PostProcessOwnerView } from "./postprocess-contract.ts";

export interface PostProcessSnapshot {
  version: 1;
  definitions: Omit<PostProcessIR, "source">[];
  states: PostProcessState[];
}
type Code = `TC_POSTPROCESS_${string}`;
const remediation = "Use declared pass IDs and parameters, boolean enabled flags, matching finite f32 values, and snapshots from identical ordered graphs; create a new owner after disposal.";
const error = (code: Code, detail: string): never => {
  throw Object.assign(new Error(`${code}: ${detail} Repair: ${remediation}`), { code, remediation });
};
const fail = (code: Code, at: string, detail: string): never => error(code, `${at}: ${detail}`);
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
// Stable plain-data copies bind snapshots to kernels without retaining input aliases.
const canonical = (value: unknown, code: Code, seen = new Set<object>()): unknown => {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value) && Number.isFinite(Math.fround(value))) return value;
  if (!value || typeof value !== "object" || seen.has(value)) return fail(code, "definitions", "Expected acyclic finite f32 plain data.");
  seen.add(value);
  let result: unknown;
  if (dense(value)) result = value.map(v => canonical(v, code, seen));
  else if (plain(value)) result = Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k], code, seen)]));
  else return fail(code, "definitions", "Expected plain records and dense arrays without accessors.");
  seen.delete(value);
  return result;
};
// Keep one implementation of parameter typing, finite-f32 checks and vector isolation.
const parameterCall = <T>(action: () => T, snapshot = false): T => {
  try { return action(); }
  catch (cause) {
    const match = cause instanceof Error && /^TC_RENDER_([A-Z_]+): ([\s\S]*?) Repair:/.exec(cause.message);
    if (!match) throw cause;
    const codes: Record<string, Code> = {
      MATERIAL: "TC_POSTPROCESS_ID", PARAMETER: "TC_POSTPROCESS_PARAMETER",
      PARAMETER_VALUE: "TC_POSTPROCESS_PARAMETER_VALUE", PARAMETERS_SNAPSHOT: "TC_POSTPROCESS_SNAPSHOT",
    };
    return error(snapshot ? "TC_POSTPROCESS_SNAPSHOT" : codes[match[1]!] ?? "TC_POSTPROCESS_DEFINITION", match[2]!);
  }
};

/** CPU state only. History revisions request GPU image clears, not image restoration. */
export function createPostProcessOwner(definitions: readonly PostProcessIR[] = []) {
  if (!dense(definitions)) fail("TC_POSTPROCESS_DEFINITION", "*:*", "Expected a dense definitions array.");
  const kernels: Omit<PostProcessIR, "source">[] = [], passes = new Map<string, { enabled: boolean; history: number }>();
  for (const definition of definitions) {
    if (!exact(definition, ["id", "enabled", "graph", "source", ...(definition && typeof definition === "object" && Object.hasOwn(definition, "buffers") ? ["buffers"] : []), ...(definition && typeof definition === "object" && Object.hasOwn(definition, "textures") ? ["textures"] : [])]) || typeof definition.id !== "string" || !/^[a-zA-Z][a-zA-Z0-9_.-]*$/.test(definition.id) || definition.id.startsWith("scene."))
      fail("TC_POSTPROCESS_DEFINITION", "*:*", "Expected a nonreserved pass ID, enabled flag, compiled graph and source.");
    const id = definition.id;
    if (passes.has(id)) fail("TC_POSTPROCESS_ID", `${id}:*`, "Duplicate pass ID.");
    if (typeof definition.enabled !== "boolean") fail("TC_POSTPROCESS_CONFIGURE", `${id}:*`, "Enabled must be boolean.");
    const graph = canonical(definition.graph, "TC_POSTPROCESS_DEFINITION") as PostProcessIR["graph"];
    if (!plain(graph) || !dense(graph.nodes) || typeof graph.output !== "string" || !graph.output || graph.outputType !== "vec4" || !plain(graph.nodeTypes))
      fail("TC_POSTPROCESS_DEFINITION", `${id}:*`, "Expected a compiled vec4 output graph.");
    kernels.push({ id, enabled: definition.enabled, graph, ...(definition.buffers ? { buffers: canonical(definition.buffers, "TC_POSTPROCESS_DEFINITION") as PostProcessIR["buffers"] } : {}), ...(definition.textures ? { textures: canonical(definition.textures, "TC_POSTPROCESS_DEFINITION") as PostProcessIR["textures"] } : {}) });
    passes.set(id, { enabled: definition.enabled, history: 0 });
  }
  const parameters = parameterCall(() => createMaterialParameters(kernels.map(k => ({ id: k.id, parameters: k.graph.parameters }))));
  for (const kernel of kernels) {
    if (kernel.graph.parameters) kernel.graph.parameters = [...kernel.graph.parameters].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  }
  const definitionText = JSON.stringify(canonical(kernels, "TC_POSTPROCESS_DEFINITION"));
  let disposed = false, revision = 0;
  const active = () => { if (disposed) fail("TC_POSTPROCESS_DISPOSED", "*:*", "Postprocess owner is disposed."); };
  const pass = (id: string) => {
    active();
    if (typeof id !== "string" || !passes.has(id)) return fail("TC_POSTPROCESS_ID", `${typeof id === "string" ? id : "<invalid>"}:*`, "Unknown pass ID.");
    return passes.get(id)!;
  };
  const state = (id: string): Readonly<PostProcessState> => {
    const p = pass(id);
    return Object.freeze({ id, enabled: p.enabled, parameters: parameterCall(() => parameters.get(id)) });
  };
  const states: PostProcessOwnerView["states"] = () => {
    active();
    return Object.freeze([...passes.keys()].map(state));
  };
  const historyRevisions: PostProcessOwnerView["historyRevisions"] = () => {
    active();
    return Object.freeze(Object.fromEntries([...passes].map(([id, p]) => [id, p.history])));
  };
  const resetAll = () => { for (const p of passes.values()) p.history++; };
  const validate = (value: unknown) => {
    active();
    if (!kernels.length && value === undefined) return { states: [], parameters: undefined };
    const bad = (at = "*:*", detail = "Incompatible postprocess snapshot."): never => fail("TC_POSTPROCESS_SNAPSHOT", at, detail);
    if (!kernels.length || !exact(value, ["version", "definitions", "states"]) || value.version !== 1) return bad();
    const copy = canonical(value, "TC_POSTPROCESS_SNAPSHOT") as PostProcessSnapshot;
    if (JSON.stringify(copy.definitions) !== definitionText || !dense(copy.states) || copy.states.length !== kernels.length) return bad();
    const stagedParameters = parameters.snapshot();
    for (let i = 0; i < kernels.length; i++) {
      const kernel = kernels[i]!, s = copy.states[i];
      if (!exact(s, ["id", "enabled", "parameters"]) || s.id !== kernel.id || typeof s.enabled !== "boolean" || !exact(s.parameters, Object.keys(parameters.get(kernel.id)))) return bad(`${kernel.id}:*`);
    }
    if (stagedParameters) {
      stagedParameters.values = Object.fromEntries(copy.states.filter(s => Object.keys(s.parameters).length).map(s => [s.id, s.parameters]));
      parameterCall(() => parameters.validateSnapshot(stagedParameters), true);
    }
    return { states: copy.states, parameters: stagedParameters };
  };
  const service: Omit<PostProcessService, "buffers" | "textures"> = {
    configure(id, settings) {
      const p = pass(id);
      if (!exact(settings, ["enabled"]) || typeof settings.enabled !== "boolean") fail("TC_POSTPROCESS_CONFIGURE", `${id}:*`, "Expected only a boolean enabled flag.");
      if (p.enabled !== settings.enabled) { p.enabled = settings.enabled; revision++; resetAll(); }
    },
    state,
    setParameter(id, name, value) {
      pass(id);
      if (typeof name !== "string") fail("TC_POSTPROCESS_PARAMETER", `${id}:<invalid>`, "Expected a declared parameter name.");
      const before = parameters.inspect().revision;
      parameterCall(() => parameters.set(id, name, value));
      if (parameters.inspect().revision !== before) revision++;
    },
    resetHistory(id) {
      active();
      if (id === undefined) resetAll();
      else pass(id).history++;
    },
  };
  return {
    service, states, historyRevisions,
    snapshot(): PostProcessSnapshot | undefined {
      active();
      if (!kernels.length) return undefined;
      return { version: 1, definitions: structuredClone(kernels), states: structuredClone(states()) as PostProcessState[] };
    },
    validateSnapshot(value: unknown): void { validate(value); },
    restore(value: unknown): void {
      const staged = validate(value), before = parameters.inspect().revision;
      const changed = staged.states.some(s => passes.get(s.id)!.enabled !== s.enabled);
      parameterCall(() => parameters.restore(staged.parameters), true);
      for (const s of staged.states) passes.get(s.id)!.enabled = s.enabled;
      if (changed || before !== parameters.inspect().revision) revision++;
      resetAll();
    },
    dispose(): void { if (!disposed) { disposed = true; parameters.dispose(); } },
    inspect(): { passes: number; enabled: number; parameters: number; revision: number } {
      active();
      return { passes: passes.size, enabled: [...passes.values()].filter(p => p.enabled).length, parameters: parameters.inspect().parameters, revision };
    },
  };
}
