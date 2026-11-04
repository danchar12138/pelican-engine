import type { EntityIR, SceneIR } from "../../compiler/src/types.ts";
import type { EntityRecord } from "./contracts.ts";

/** Resolve authored presentation/physics through immutable content identity in World. */
export function resolveEntityDefinition(
  ir: SceneIR,
  record: Pick<EntityRecord, "id" | "prefab">,
): EntityIR | undefined {
  const authored = ir.scene.entities.find((entity) => entity.id === record.id);
  if (
    authored &&
    (record.prefab === undefined || record.prefab === authored.prefab)
  )
    return authored;
  if (record.prefab === undefined) return undefined;
  const prefab = ir.prefabs.find((entity) => entity.id === record.prefab);
  if (!prefab) throw new Error("TC_PREFAB_MISSING: " + record.prefab);
  return { ...prefab, id: record.id, prefab: record.prefab };
}
