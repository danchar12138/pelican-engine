import type { ClothDefinition, ClothService, Vec2 } from "../../sdk/src/index.ts";
import type { RuntimePluginFactory } from "../../runtime/src/plugins.ts";
import { cloneSerializable } from "../../runtime/src/random.ts";
import { createCloth, type ClothCollider, type ClothOptions, type ClothSnapshot, type ClothSolver, type Vec3 } from "./cloth.ts";

type Entry = { definition: ClothDefinition; solver: ClothSolver; uvs: Vec2[] };
type Saved = { definition: ClothDefinition; state: ClothSnapshot };
const fail = (code: string, detail: string): never => { throw new Error(`TC_CLOTH_${code}: ${detail}`); };
const validId = (value: unknown): value is string => typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= 128;

function planarUvs(points: readonly (readonly [number, number, number])[]): Vec2[] {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const point of points) for (let axis = 0; axis < 3; axis++) { min[axis] = Math.min(min[axis], point[axis]); max[axis] = Math.max(max[axis], point[axis]); }
  const axes = [0, 1, 2].sort((a, b) => (max[b] - min[b]) - (max[a] - min[a]) || a - b), first = axes[0], second = axes[1];
  const width = max[first] - min[first], height = max[second] - min[second];
  if (!(width > 0) || !(height > 0)) return fail("VISUAL_UV", "Initial points need two nonzero projection axes or explicit UVs.");
  return points.map(point => [(point[first] - min[first]) / width, (point[second] - min[second]) / height]);
}
function createEntry(input: ClothDefinition, fixedDt: number, materials: ReadonlySet<string>): Entry {
  const definition = cloneSerializable(input);
  if (!definition || !validId(definition.id)) return fail("ID", "Expected a nonempty id of at most 128 characters.");
  if (definition.autoStep !== undefined && typeof definition.autoStep !== "boolean") return fail("AUTO_STEP", "autoStep must be boolean.");
  if (definition.fixedDt !== undefined && definition.fixedDt !== fixedDt) return fail("FIXED_DT", "Cloth fixedDt must match the host fixedDt.");
  if (fixedDt < 1 / 1000 || fixedDt > 1 / 30) return fail("FIXED_DT", "Host fixedDt must be in [1/1000,1/30].");
  if (definition.visual !== undefined) {
    const visual = definition.visual;
    if (!visual || typeof visual !== "object" || Array.isArray(visual) || !validId(visual.material) || !materials.has(visual.material))
      return fail("VISUAL_MATERIAL", "visual.material must name a declared engine material.");
    if ((visual.castShadow !== undefined && typeof visual.castShadow !== "boolean") || (visual.receiveShadow !== undefined && typeof visual.receiveShadow !== "boolean"))
      return fail("VISUAL_SHADOW", "Shadow options must be boolean.");
    if (visual.uvs !== undefined && (!Array.isArray(visual.uvs) || !Array.isArray(definition.points) || visual.uvs.length !== definition.points.length ||
      visual.uvs.some(uv => !Array.isArray(uv) || uv.length !== 2 || !uv.every(value => typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 1e6))))
      return fail("VISUAL_UV", "UVs must contain one finite 2D coordinate per particle.");
  }
  const solver = createCloth({ ...definition, fixedDt } as unknown as ClothOptions);
  try {
    const uvs: Vec2[] = definition.visual ? (definition.visual.uvs ? definition.visual.uvs.map(uv => [uv[0], uv[1]]) : planarUvs(definition.points)) : [];
    return { definition, solver, uvs };
  } catch (error) { solver.dispose(); throw error; }
}
function disposeEntries(entries: Map<string, Entry>): void { for (const entry of entries.values()) entry.solver.dispose(); entries.clear(); }
function parseSnapshot(value: unknown, fixedDt: number, materials: ReadonlySet<string>): Map<string, Entry> {
  if (!value || typeof value !== "object" || (value as { version?: unknown }).version !== 1 || !Array.isArray((value as { cloths?: unknown }).cloths) || (value as { cloths: unknown[] }).cloths.length > 256)
    return fail("SNAPSHOT", "Expected a version 1 snapshot containing at most 256 cloths.");
  const entries = new Map<string, Entry>();
  try {
    for (const item of (value as { cloths: Saved[] }).cloths) {
      if (!item || typeof item !== "object") fail("SNAPSHOT", "Invalid cloth entry.");
      const entry = createEntry(item.definition, fixedDt, materials);
      if (entries.has(entry.definition.id)) { entry.solver.dispose(); fail("SNAPSHOT", "Duplicate cloth id."); }
      entries.set(entry.definition.id, entry); entry.solver.restore(item.state);
    }
    return entries;
  } catch (error) { disposeEntries(entries); throw error; }
}
export const createClothPlugin: RuntimePluginFactory = context => {
  const { fixedDt } = context;
  if (typeof fixedDt !== "number" || !Number.isFinite(fixedDt)) return fail("FIXED_DT", "RuntimeHost must provide a finite fixed interval.");
  const hostDt = fixedDt, materials = new Set(context.scene.materials.map(material => material.id));
  let entries = new Map<string, Entry>(), disposed = false;
  const alive = () => { if (disposed) fail("DISPOSED", "Cloth service is disposed."); };
  const get = (id: string): Entry => { alive(); if (!validId(id)) return fail("ID", "Expected a nonempty cloth id."); return entries.get(id) ?? fail("MISSING", `Cloth '${id}' does not exist.`); };
  const service: ClothService = {
    create(definition) {
      alive(); if (!definition || !validId(definition.id)) return fail("ID", "Expected a nonempty cloth id.");
      if (entries.has(definition.id)) return fail("DUPLICATE", `Cloth '${definition.id}' already exists.`);
      if (entries.size >= 256) return fail("CAPACITY", "At most 256 cloths per host.");
      const entry = createEntry(definition, hostDt, materials); entries.set(entry.definition.id, entry);
    },
    step(id, ticks) { const entry = get(id); if (entry.definition.autoStep) return fail("AUTO_STEP", `Cloth '${id}' is automatically stepped.`); return entry.solver.step(ticks); },
    inspect(id) { return get(id).solver.inspect(); },
    visuals() {
      alive(); return [...entries.values()].filter(entry => entry.definition.visual !== undefined)
        .sort((a, b) => a.definition.id < b.definition.id ? -1 : a.definition.id > b.definition.id ? 1 : 0)
        .map(entry => { const state = entry.solver.inspect(), visual = entry.definition.visual!; return { id: entry.definition.id, material: visual.material,
          positions: state.positions, triangles: state.triangles, uvs: entry.uvs.map(uv => [uv[0], uv[1]] as Vec2),
          castShadow: visual.castShadow ?? true, receiveShadow: visual.receiveShadow ?? true }; });
    },
    setColliders(id, colliders) { get(id).solver.setColliders(cloneSerializable(colliders) as ClothCollider[]); },
    setAnchor(id, index, position) { get(id).solver.setAnchor(index, cloneSerializable(position) as Vec3); },
    releaseAnchor(id, index) { get(id).solver.releaseAnchor(index); },
    applyForce(id, index, force) { get(id).solver.applyForce(index, cloneSerializable(force) as Vec3); },
    applyImpulse(id, index, impulse) { get(id).solver.applyImpulse(index, cloneSerializable(impulse) as Vec3); },
    destroy(id) { const entry = get(id); entry.solver.dispose(); entries.delete(id); },
  };
  return {
    id: "$engine.cloth", version: "1", services: { cloth: service },
    afterPhysics() {
      alive(); const committed: { solver: ClothSolver; snapshot: ClothSnapshot }[] = [];
      try {
        const automatic = [...entries.values()].filter(entry => entry.definition.autoStep)
          .sort((a, b) => a.definition.id < b.definition.id ? -1 : a.definition.id > b.definition.id ? 1 : 0);
        for (const { solver } of automatic) { const snapshot = solver.snapshot(); committed.push({ solver, snapshot }); solver.step(); }
      } catch (error) {
        const failures: string[] = [];
        for (const { solver, snapshot } of committed.reverse()) try { solver.restore(snapshot); } catch (rollbackError) { failures.push(String(rollbackError)); }
        if (failures.length) throw new Error(`TC_CLOTH_ROLLBACK: ${String(error)}; partialState=true; rollback failures: ${failures.join("; ")}`);
        throw error;
      }
    },
    legacySnapshot: () => ({ version: 1, cloths: [] }),
    snapshot: () => ({ version: 1, cloths: [...entries.values()].sort((a, b) => a.definition.id < b.definition.id ? -1 : a.definition.id > b.definition.id ? 1 : 0)
      .map(({ definition, solver }) => ({ definition: cloneSerializable(definition), state: solver.snapshot() })) }),
    validateSnapshot(value) { const staged = parseSnapshot(value, hostDt, materials); disposeEntries(staged); },
    restore(value) { alive(); const staged = parseSnapshot(value, hostDt, materials); disposeEntries(entries); entries = staged; },
    dispose() { if (disposed) return; disposed = true; disposeEntries(entries); },
  };
};
