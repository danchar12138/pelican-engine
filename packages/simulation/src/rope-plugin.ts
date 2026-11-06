import type { RopeDefinition, RopeService } from "../../sdk/src/index.ts";
import type { RuntimePluginFactory } from "../../runtime/src/plugins.ts";
import { cloneSerializable } from "../../runtime/src/random.ts";
import { createRope, type RopeOptions, type RopeSnapshot, type RopeSolver, type RopeCollider, type Vec3 } from "./rope.ts";

type Entry = { definition: RopeDefinition; solver: RopeSolver };
type Saved = { definition: RopeDefinition; state: RopeSnapshot };
const fail = (code: string, detail: string): never => { throw new Error(`TC_ROPE_${code}: ${detail}`); };
const validId = (id: unknown): id is string => typeof id === "string" && id.trim() === id && id.length > 0 && id.length <= 128;

function createEntry(input: RopeDefinition, fixedDt: number): Entry {
  const definition = cloneSerializable(input);
  if (!definition || !validId(definition.id)) return fail("ID", "Expected a nonempty id of at most 128 characters.");
  if (definition.fixedDt !== undefined && definition.fixedDt !== fixedDt) return fail("FIXED_DT", "Rope fixedDt must exactly match the host fixedDt.");
  if (fixedDt < 1 / 1000 || fixedDt > 1 / 30) return fail("FIXED_DT", "Host fixedDt must be within [1/1000, 1/30] seconds for ropes.");
  const solver = createRope({ ...definition, fixedDt } as unknown as RopeOptions);
  return { definition, solver };
}
function disposeEntries(entries: Map<string, Entry>): void {
  for (const { solver } of entries.values()) solver.dispose();
  entries.clear();
}
function parseSnapshot(value: unknown, fixedDt: number): Map<string, Entry> {
  if (!value || typeof value !== "object" || (value as { version?: unknown }).version !== 1 || !Array.isArray((value as { ropes?: unknown }).ropes) || (value as { ropes: unknown[] }).ropes.length > 256)
    return fail("SNAPSHOT", "Expected a version 1 rope snapshot with at most 256 ropes.");
  const entries = new Map<string, Entry>();
  try {
    for (const item of (value as { ropes: Saved[] }).ropes) {
      if (!item || typeof item !== "object") fail("SNAPSHOT", "Invalid rope entry.");
      const entry = createEntry(item.definition, fixedDt);
      if (entries.has(entry.definition.id)) { entry.solver.dispose(); fail("SNAPSHOT", "Duplicate rope id."); }
      entries.set(entry.definition.id, entry);
      entry.solver.restore(item.state);
    }
    return entries;
  } catch (error) { disposeEntries(entries); throw error; }
}

/** Explicitly stepped CPU rope ownership; independent from the Rapier physics plugin. */
export const createRopePlugin: RuntimePluginFactory = ({ fixedDt }) => {
  if (typeof fixedDt !== "number" || !Number.isFinite(fixedDt)) return fail("FIXED_DT", "RuntimeHost must provide a finite fixed interval.");
  const hostDt = fixedDt;
  let entries = new Map<string, Entry>();
  let disposed = false;
  const alive = () => { if (disposed) fail("DISPOSED", "Rope service is disposed."); };
  const get = (id: string): Entry => {
    alive();
    if (!validId(id)) return fail("ID", "Expected a nonempty rope id.");
    return entries.get(id) ?? fail("MISSING", `Rope '${id}' does not exist.`);
  };
  const service: RopeService = {
    create(definition) {
      alive();
      if (!definition || !validId(definition.id)) return fail("ID", "Expected a nonempty rope id.");
      if (entries.has(definition.id)) return fail("DUPLICATE", `Rope '${definition.id}' already exists.`);
      if (entries.size >= 256) return fail("CAPACITY", "At most 256 ropes per host.");
      const entry = createEntry(definition, hostDt);
      entries.set(entry.definition.id, entry);
    },
    step(id, ticks) { return get(id).solver.step(ticks); },
    inspect(id) { return get(id).solver.inspect(); },
    setColliders(id, colliders) { get(id).solver.setColliders(cloneSerializable(colliders) as RopeCollider[]); },
    setAnchor(id, index, position) { get(id).solver.setAnchor(index, cloneSerializable(position) as Vec3); },
    releaseAnchor(id, index) { get(id).solver.releaseAnchor(index); },
    applyForce(id, index, force) { get(id).solver.applyForce(index, cloneSerializable(force) as Vec3); },
    applyImpulse(id, index, impulse) { get(id).solver.applyImpulse(index, cloneSerializable(impulse) as Vec3); },
    destroy(id) { const entry = get(id); entry.solver.dispose(); entries.delete(id); },
  };
  return {
    id: "$engine.ropes", version: "1", services: { ropes: service },
    legacySnapshot: () => ({ version: 1, ropes: [] }),
    snapshot: () => ({ version: 1, ropes: [...entries.values()].sort((a, b) => a.definition.id < b.definition.id ? -1 : a.definition.id > b.definition.id ? 1 : 0).map(({ definition, solver }) => ({ definition: cloneSerializable(definition), state: solver.snapshot() })) }),
    validateSnapshot(value) { const staged = parseSnapshot(value, hostDt); disposeEntries(staged); },
    restore(value) { alive(); const staged = parseSnapshot(value, hostDt); disposeEntries(entries); entries = staged; },
    dispose() { if (disposed) return; disposed = true; disposeEntries(entries); },
  };
};
