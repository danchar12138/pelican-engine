import type { MaterialSurfacePatch } from "../../sdk/src/index.ts";
import { cloneSerializable } from "./random.ts";

type Definition = { id: string; graph?: unknown; graphs?: Partial<Record<string, unknown>> };
type Entry = { id: string; patch: MaterialSurfacePatch };
const fail = (code: string, message: string): never => { throw new Error(`${code}: ${message}`); };

/** Declared, non-graph channels only. Values are staged before replacing state. */
export function createMaterialSurfaceOwner(definitions: readonly Definition[]) {
  const known = new Map(definitions.map(item => [item.id, item]));
  let values = new Map<string, MaterialSurfacePatch>(), disposed = false;
  const active = () => { if (disposed) fail("TC_RENDER_DISPOSED", "Material surface state was disposed."); };
  const material = (id: string) => known.get(id) ?? fail("TC_RENDER_MATERIAL", `Unknown material '${String(id)}'.`);
  const validate = (id: string, input: unknown, code: string): MaterialSurfacePatch => {
    const definition = material(id), patch = cloneSerializable(input) as MaterialSurfacePatch;
    if (!patch || typeof patch !== "object" || Array.isArray(patch) || !Object.keys(patch).length ||
        Object.keys(patch).some(key => !["color", "emissive", "roughness", "metalness", "emissiveIntensity"].includes(key)))
      return fail(code, `Material '${id}' needs a nonempty surface patch with known fields.`);
    for (const key of ["color", "emissive"] as const) if (Object.hasOwn(patch, key)) {
      const color = patch[key];
      if (!Array.isArray(color) || color.length !== 3 || color.some(n => typeof n !== "number" || !Number.isFinite(n) || n < 0 || n > 1))
        return fail(code, `${id}.${key} requires linear RGB components in [0,1].`);
    }
    for (const key of ["roughness", "metalness", "emissiveIntensity"] as const) if (Object.hasOwn(patch, key)) {
      const value = patch[key], max = key === "emissiveIntensity" ? 65536 : 1;
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > max)
        return fail(code, `${id}.${key} requires a finite value in [0,${max}].`);
    }
    const graphs = definition.graphs ?? {};
    for (const key of Object.keys(patch)) {
      const channel = key === "color" ? "baseColor" : key === "emissiveIntensity" ? "emissive" : key;
      if (graphs[channel] !== undefined || (channel === "baseColor" && definition.graph !== undefined))
        return fail(code, `${id}.${key} is controlled by a material graph; update its graph parameters instead.`);
    }
    return patch;
  };
  const parse = (input: unknown): Map<string, MaterialSurfacePatch> => {
    if (input === undefined) return new Map();
    const records = cloneSerializable(input);
    if (!Array.isArray(records) || records.length > known.size) return fail("TC_RENDER_SURFACE_SNAPSHOT", "Invalid surface overrides.");
    const result = new Map<string, MaterialSurfacePatch>();
    for (const record of records) {
      if (!record || typeof record !== "object" || Array.isArray(record) || Object.keys(record).sort().join(",") !== "id,patch" ||
          typeof record.id !== "string" || result.has(record.id)) return fail("TC_RENDER_SURFACE_SNAPSHOT", "Invalid or duplicate material override.");
      result.set(record.id, validate(record.id, record.patch, "TC_RENDER_SURFACE_SNAPSHOT"));
    }
    return result;
  };
  return {
    set(id: string, input: MaterialSurfacePatch) { active(); const patch = validate(id, input, "TC_RENDER_SURFACE"); values.set(id, { ...values.get(id), ...patch }); },
    get(id: string): Readonly<MaterialSurfacePatch> { active(); material(id); return cloneSerializable(values.get(id) ?? {}); },
    reset(id: string) { active(); material(id); values.delete(id); },
    snapshot(): Entry[] { active(); return cloneSerializable([...values].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([id, patch]) => ({ id, patch }))); },
    validateSnapshot(input: unknown) { active(); parse(input); },
    restore(input: unknown) { active(); values = parse(input); },
    dispose() { disposed = true; values.clear(); },
  };
}
