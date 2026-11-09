import type { SceneIR } from "../packages/compiler/src/types.ts";

/** Compact discovery from freshly validated compiler metadata, never guessed GLB slots. */
export function queryAssets(ir: SceneIR, id?: string, limit = 20, offset = 0) {
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    offset > 100000
  )
    throw Error("TC_ASSET_QUERY: Use --limit 1..100 and --offset 0..100000.");
  const page = <T>(items: readonly T[]) => ({
    total: items.length,
    offset,
    limit,
    truncated: offset + limit < items.length,
    nextOffset: offset + limit < items.length ? offset + limit : null,
    entries: items.slice(offset, offset + limit),
  });
  const compact = (asset: SceneIR["assets"][number]) => ({
    id: asset.id,
    type: asset.type,
    bytes: asset.metadata?.bytes ?? null,
    hash: asset.hash,
    source: asset.source,
    sourcePath: asset.sourcePath,
    triangleCount: asset.metadata?.triangleCount ?? null,
    materialCount: asset.metadata?.materialCount ?? null,
  });
  if (!id)
    return {
      format: "pelican.assets",
      ...page(ir.assets.map(compact)),
      query: "pelican assets --id <id> --limit 20 --offset 0",
    };
  const asset = ir.assets.find((asset) => asset.id === id);
  if (!asset)
    throw Error(
      `TC_ASSET_QUERY_UNKNOWN: No asset ${JSON.stringify(id)}. Run pelican assets to list declared IDs.`,
    );
  const materials = Array.isArray(asset.metadata?.materials)
    ? (asset.metadata.materials as { index: number; name?: string }[])
    : [];
  const meshes = Array.isArray(asset.metadata?.meshes) ? asset.metadata.meshes as { primitives?: { material?: number }[] }[] : undefined;
  const referenced = new Set(meshes?.flatMap(mesh => mesh.primitives?.flatMap(primitive => primitive.material === undefined ? [] : [primitive.material]) ?? []) ?? []);
  return {
    format: "pelican.asset",
    asset: compact(asset),
    materialSlots: page(
      materials.map((material) => ({
        index: material.index,
        name: material.name ?? null,
        named: !!material.name,
        referencedByMesh: meshes ? referenced.has(material.index) : null,
      })),
    ),
    query: "pelican api --symbol ModelDefinition.materialSlots",
    limits:
      "Names are actual asset material definitions, not guessed runtime bindings. Mesh references do not prove reachability from the selected scene. Same-named engine materials are not auto-bound. Unnamed/duplicate slots may need re-export or a whole-model override.",
  };
}
