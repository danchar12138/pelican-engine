import type { InspectField } from "../../protocol/src/index.ts";
import { SDK_VERSION } from "../../sdk/src/index.ts";
import type { HostSnapshot } from "../../runtime/src/host.ts";
import type { ResourceSnapshot } from "../../runtime/src/resources.ts";
import type { SimulationSnapshot } from "../../../experiments/simulation/types.ts";
import type { WorldSnapshot } from "../../../experiments/world/types.ts";
import { createSimulation } from "../../../experiments/simulation/index.ts";
import { createWorldProbe } from "../../../experiments/world/index.ts";

export interface BrowserCheckpoint {
  format: "pelican.browser";
  version: 1;
  engineVersion: string;
  tick: number;
  cameraPhase: number;
  frameAccumulator: number;
  inputLog: { tick: number; key: string }[];
  runtime: HostSnapshot;
  resources: ResourceSnapshot;
  simulation?: SimulationSnapshot;
  world?: WorldSnapshot;
  topology: [number, number, number][];
}

/** Only the display envelope is checked here; real owners validate their state before commit. */
export function validateBrowserCheckpoint(
  value: unknown,
  resources: ResourceSnapshot,
): BrowserCheckpoint {
  const saved = structuredClone(value) as BrowserCheckpoint;
  if (
    !saved ||
    saved.format !== "pelican.browser" ||
    saved.version !== 1 ||
    saved.engineVersion !== SDK_VERSION ||
    !Number.isSafeInteger(saved.tick) ||
    saved.tick < 0 ||
    !saved.runtime ||
    saved.runtime.scheduler?.tick !== saved.tick ||
    !Number.isFinite(saved.cameraPhase) ||
    !Number.isFinite(saved.frameAccumulator) ||
    saved.frameAccumulator < 0
  )
    throw new Error(
      "TC_BROWSER_SNAPSHOT: Invalid or incompatible runtime/display checkpoint.",
    );
  if (JSON.stringify(saved.resources) !== JSON.stringify(resources))
    throw new Error(
      "TC_BROWSER_RESOURCE_VERSION: Reloaded content requires a matching checkpoint.",
    );
  if (
    !Array.isArray(saved.inputLog) ||
    saved.inputLog.some(
      (input) =>
        !input ||
        !Number.isSafeInteger(input.tick) ||
        input.tick < 0 ||
        input.tick > saved.tick ||
        typeof input.key !== "string" ||
        !input.key.length ||
        input.key.length > 64,
    )
  )
    throw new Error("TC_BROWSER_SNAPSHOT_INPUT: Invalid input trace.");
  if (
    !Array.isArray(saved.topology) ||
    saved.topology.some(
      (position) =>
        !Array.isArray(position) ||
        position.length !== 3 ||
        position.some(
          (value) => typeof value !== "number" || !Number.isFinite(value),
        ),
    )
  )
    throw new Error("TC_BROWSER_SNAPSHOT_GEOMETRY: Invalid probe positions.");
  return saved;
}

export interface InspectPage {
  summary?: boolean;
  fields?: readonly InspectField[];
  entity?: string;
  offset?: number;
  limit?: number;
}

/** M0 CPU probes only, not M1 production physics/world modules. Never mutate live owners here. */
export async function prepareCheckpointProbes(
  saved: Pick<BrowserCheckpoint, "simulation" | "world">,
) {
  let simulation: ReturnType<typeof createSimulation> | undefined;
  let world: ReturnType<typeof createWorldProbe> | undefined;
  try {
    if (saved.simulation !== undefined) {
      if (
        !saved.simulation ||
        !["rope", "cloth", "softbody", "fluid"].includes(saved.simulation.kind)
      )
        throw new Error(
          "TC_BROWSER_SNAPSHOT_SIMULATION: Invalid simulation probe.",
        );
      simulation = createSimulation(saved.simulation.kind);
      simulation.restore(saved.simulation);
    }
    if (saved.world !== undefined) {
      if (!saved.world || typeof saved.world.config !== "object")
        throw new Error("TC_BROWSER_SNAPSHOT_WORLD: Invalid world probe.");
      world = createWorldProbe(saved.world.config);
      await world.restore(saved.world);
    }
    return {
      simulation,
      world,
      dispose() {
        simulation?.dispose();
        world?.dispose();
      },
    };
  } catch (error) {
    simulation?.dispose();
    world?.dispose();
    throw error;
  }
}

/** M1 uses World.records(); indexed/paged world queries are a later optimization. */
export function selectInspectRecords<T extends { id: string }>(
  records: T[],
  options: InspectPage,
) {
  const filtered =
    options.entity === undefined
      ? records
      : records.filter((record) => record.id === options.entity);
  if (options.entity !== undefined && !filtered.length)
    throw new Error(
      `TC_BROWSER_ENTITY_MISSING: Entity ${options.entity} does not exist.`,
    );
  const offset = options.offset ?? 0;
  const limit = options.limit ?? 100;
  return {
    records: filtered.slice(offset, offset + limit),
    paging: {
      total: filtered.length,
      offset,
      limit,
      returned: Math.min(limit, Math.max(0, filtered.length - offset)),
    },
  };
}

/** Projection distinguishes unavailable data from a paginated list. No total VRAM claim. */
export function projectInspection(full: Record<string, any>, options?: InspectPage) {
  const summary = {
    ready: full.ready, playback: full.playback, backend: full.backend, mode: full.mode, tick: full.tick, frame: full.frame,
    viewport: full.viewport,
    camera: full.objects?.cameraPose ?? null,
    faults: { count: full.errors?.length ?? 0, recent: (full.errors ?? []).slice(-3), truncated:(full.errors?.length??0)>3, query:"pelican inspect --fields errors" },
    statistics: { triangles: full.triangleCount, nodes: full.nodeCount, entities: full.paging?.total ?? full.runtime?.records?.length ?? null,
      samples: full.rendering?.surface?.samples ?? null },
    memory: { totalGpuBytes: {status:"unavailable", reason:"No portable browser total VRAM measurement"},
      managed: full.resources?.bytes ?? {status:"unavailable"},
      tracing: full.rendering?.surface?.ownedBytes !== undefined ? {status:"known",bytes:full.rendering.surface.ownedBytes,scope:"Tracing owner allocations only; not total VRAM"} : {status:"unavailable"} },
  };
  if (!options?.summary && !options?.fields) return full;
  const fields = options.fields ?? ["summary"];
  const selected: Record<string, unknown> = {}, availability: Record<string, string> = {};
  for (const field of fields) {
    const value = field === "summary" ? summary : field === "assets" ? full.compiledIR?.assets?.map((asset: {id:string;hash?:string})=>({id:asset.id,hash:asset.hash})) : full[field];
    availability[field] = value == null ? "unavailable" : "available";
    selected[field] = value ?? null;
  }
  return { backend: full.backend, mode: full.mode, tick: full.tick, ...selected, selection: { fields, availability, truncated: !!full.paging && full.paging.offset + full.paging.returned < full.paging.total,
    ...(full.paging ? {paging:full.paging, next: full.paging.offset + full.paging.returned < full.paging.total ? "pelican inspect --fields " + fields.join(",") + " --limit " + full.paging.limit + " --offset " + (full.paging.offset + full.paging.returned) : null} : {}) } };
}
