import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { SDK_VERSION } from "../../packages/sdk/src/index.ts";
import type {
  ComponentSchema,
  Geometry,
  GraphType,
  Transform,
  Vec3,
} from "../../packages/sdk/src/index.ts";
import type {
  Diagnostic,
  EntityIR,
  GraphIR,
  SceneIR,
  SourceLocation,
} from "./types.ts";
import type { Extractor, ObjectValue } from "./extract.ts";
type Obj = Record<string, unknown>;
export const hash = (data: string | Uint8Array) =>
  createHash("sha256").update(data).digest("hex");
export interface AssetCopy {
  source: string;
  output: string;
}
export async function normalize(
  game: ObjectValue,
  extractor: Extractor,
  projectRoot: string,
): Promise<{
  ir?: SceneIR;
  diagnostics: Diagnostic[];
  assetCopies: AssetCopy[];
}> {
  const diagnostics: Diagnostic[] = [];
  const assetCopies: AssetCopy[] = [];
  const source = (o: object, key?: string) => extractor.source(o, key);
  const error = (
    code: string,
    message: string,
    owner: object,
    key?: string,
    suggestion = "Correct the declaration and rebuild.",
  ) =>
    diagnostics.push({
      code,
      severity: "error",
      message,
      suggestion,
      source: source(owner, key),
    });
  const obj = (value: unknown, owner: object, name: string): Obj => {
    if (value && typeof value === "object" && !Array.isArray(value))
      return value as Obj;
    error("TC_SCHEMA_TYPE", name + " must be an object.", owner, name);
    return {};
  };
  const list = (value: unknown, owner: object, name: string): unknown[] => {
    if (value === undefined) return [];
    if (Array.isArray(value)) return value;
    error("TC_SCHEMA_TYPE", name + " must be an array.", owner, name);
    return [];
  };
  const text = (
    value: unknown,
    owner: object,
    key: string,
    fallback = "",
  ): string => {
    if (value === undefined) return fallback;
    if (typeof value === "string") return value;
    error("TC_SCHEMA_TYPE", key + " must be a string.", owner, key);
    return fallback;
  };
  const num = (
    value: unknown,
    owner: object,
    key: string,
    fallback: number,
    min = -Infinity,
    max = Infinity,
  ): number => {
    if (value === undefined) return fallback;
    if (
      typeof value === "number" &&
      Number.isFinite(value) &&
      value >= min &&
      value <= max
    )
      return value;
    error(
      "TC_SCHEMA_RANGE",
      key + " must be finite in [" + min + ", " + max + "].",
      owner,
      key,
    );
    return fallback;
  };
  const vector = (
    value: unknown,
    owner: object,
    key: string,
    fallback: Vec3,
  ): Vec3 => {
    if (value === undefined) return fallback;
    if (
      Array.isArray(value) &&
      value.length === 3 &&
      value.every((x) => typeof x === "number" && Number.isFinite(x))
    )
      return value as unknown as Vec3;
    error(
      "TC_SCHEMA_TYPE",
      key + " must be a finite three-component vector.",
      owner,
      key,
    );
    return fallback;
  };
  const id = (o: Obj) => {
    const value = text(o.id, o, "id");
    if (!/^[a-zA-Z][a-zA-Z0-9_.-]*$/.test(value))
      error(
        "TC_SCHEMA_ID",
        "IDs must begin with a letter and contain only letters, digits, dot, dash or underscore.",
        o,
        "id",
      );
    return value;
  };
  const ref = (value: unknown, owner: object, key: string) =>
    typeof value === "string"
      ? value
      : text(obj(value, owner, key).id, owner, key);
  const located = (o: object): SourceLocation => source(o) ?? source(game)!;
  const defs = new Map<string, Map<string, Obj>>();
  for (const def of extractor.definitions) {
    if (def.kind === "game") continue;
    const kind = String(def.kind);
    const key = id(def);
    const registry = defs.get(kind) ?? new Map<string, Obj>();
    if (registry.has(key))
      error("TC_DUPLICATE_ID", "Duplicate " + kind + " ID: " + key, def, "id");
    registry.set(key, def);
    defs.set(kind, registry);
  }
  const registry = (kind: string) => defs.get(kind) ?? new Map<string, Obj>();
  const requireRef = (
    kind: string,
    name: string,
    owner: object,
    key: string,
  ) => {
    if (!registry(kind).has(name))
      error(
        "TC_RESOURCE_MISSING",
        "Missing " + kind + " reference: " + name,
        owner,
        key,
        "Declare and reference a matching define" +
          kind[0]!.toUpperCase() +
          kind.slice(1) +
          " definition.",
      );
  };
  const components: SceneIR["components"] = [];
  for (const [name, def] of registry("component")) {
    const schema = obj(def.schema, def, "schema");
    const clean: Record<string, unknown> = {};
    for (const [field, raw] of Object.entries(schema)) {
      const f = obj(raw, schema, field);
      const t = f.type;
      const valid =
        t === "number"
          ? typeof f.default === "number" && Number.isFinite(f.default)
          : t === "string"
            ? typeof f.default === "string"
            : t === "boolean"
              ? typeof f.default === "boolean"
              : t === "vec3"
                ? Array.isArray(f.default) &&
                  f.default.length === 3 &&
                  f.default.every(
                    (v) => typeof v === "number" && Number.isFinite(v),
                  )
                : false;
      if (!valid)
        error(
          "TC_COMPONENT_FIELD",
          "Invalid component field type/default: " + field,
          f,
          "default",
        );
      clean[field] = { type: t, default: f.default };
    }
    components.push({
      id: name,
      schema: clean as ComponentSchema,
      source: located(def),
    });
  }
  const componentLookup = new Map(components.map((c) => [c.id, c]));
  const graph = (raw: unknown, owner: Obj, expected: GraphType): GraphIR => {
    const g = obj(raw, owner, "graph");
    const nodes = list(g.nodes, g, "nodes").map((n) => obj(n, g, "node"));
    const lookup = new Map<string, Obj>();
    for (const n of nodes) {
      const name = id(n);
      if (lookup.has(name))
        error("TC_GRAPH_DUPLICATE", "Duplicate graph node: " + name, n, "id");
      lookup.set(name, n);
    }
    const types: Record<string, GraphType> = Object.create(null);
    const active = new Set<string>();
    const infer = (name: string, parent: Obj): GraphType => {
      if (types[name]) return types[name]!;
      const n = lookup.get(name);
      if (!n) {
        error(
          "TC_GRAPH_REFERENCE",
          "Graph references missing node: " + name,
          parent,
          "inputs",
        );
        return "float";
      }
      if (active.has(name)) {
        error(
          "TC_GRAPH_CYCLE",
          "Graph cycle at node: " + name,
          n,
          "inputs",
          "Graphs must be acyclic.",
        );
        return "float";
      }
      active.add(name);
      let result: GraphType = "float";
      if (n.op === "float") {
        if (n.value === undefined)
          error("TC_GRAPH_VALUE", "float node requires a value.", n, "op");
        else {
          num(n.value, n, "value", 0);
          if (
            typeof n.value === "number" &&
            !Number.isFinite(Math.fround(n.value))
          )
            error(
              "TC_GRAPH_VALUE",
              "Graph constants must fit a finite f32 value.",
              n,
              "value",
            );
        }
      } else if (n.op === "time") {
        /* runtime uniform */
      } else if (n.op === "vec3") {
        if (n.value === undefined)
          error("TC_GRAPH_VALUE", "vec3 node requires a value.", n, "op");
        const v = vector(n.value, n, "value", [0, 0, 0]);
        if (v.some((x) => !Number.isFinite(Math.fround(x))))
          error(
            "TC_GRAPH_VALUE",
            "Graph constants must fit finite f32 values.",
            n,
            "value",
          );
        result = "vec3";
      } else if (n.op === "add" || n.op === "multiply" || n.op === "sin") {
        const inputs = list(n.inputs, n, "inputs");
        const arity = n.op === "sin" ? 1 : 2;
        if (
          inputs.length !== arity ||
          inputs.some((x) => typeof x !== "string")
        )
          error(
            "TC_GRAPH_ARITY",
            "Node " + name + " requires " + arity + " node IDs.",
            n,
            "inputs",
          );
        const a = infer(typeof inputs[0] === "string" ? inputs[0] : "", n);
        const b =
          arity === 2
            ? infer(typeof inputs[1] === "string" ? inputs[1] : "", n)
            : a;
        if (a !== b && !(n.op === "multiply" && [a, b].includes("float")))
          error(
            "TC_GRAPH_TYPE",
            "Incompatible " + n.op + " inputs: " + a + " and " + b + ".",
            n,
            "inputs",
            "add requires equal types; multiply also supports scalar-vector multiplication.",
          );
        result = a === "vec3" || b === "vec3" ? "vec3" : "float";
      } else
        error(
          "TC_GRAPH_OP",
          "Unsupported graph operation: " + String(n.op),
          n,
          "op",
        );
      active.delete(name);
      types[name] = result;
      return result;
    };
    for (const name of lookup.keys()) infer(name, lookup.get(name)!);
    const output = text(g.output, g, "output");
    const resultType = infer(output, g);
    if (resultType !== expected)
      error(
        "TC_GRAPH_TYPE",
        "Expected " + expected + " graph output, received " + resultType + ".",
        g,
        "output",
      );
    return {
      nodes: nodes as unknown as GraphIR["nodes"],
      output,
      nodeTypes: types,
      outputType: resultType,
    };
  };
  const assets: SceneIR["assets"] = [];
  for (const [name, def] of registry("asset")) {
    const sourcePath = text(def.path, def, "path");
    const absolute = path.resolve(projectRoot, sourcePath);
    const rel = path.relative(projectRoot, absolute);
    if (!sourcePath || rel.startsWith("..") || path.isAbsolute(rel)) {
      error(
        "TC_ASSET_PATH",
        "Asset path must point to a file inside the project.",
        def,
        "path",
      );
      continue;
    }
    if (!["texture", "binary"].includes(String(def.type)))
      error("TC_ASSET_TYPE", "Unsupported asset type.", def, "type");
    try {
      const content = await fs.readFile(absolute);
      const output = "assets/" + name + "-" + path.basename(absolute);
      assets.push({
        id: name,
        type: def.type as "texture" | "binary",
        path: output,
        sourcePath: rel.replaceAll("\\", "/"),
        hash: hash(content),
        source: located(def),
      });
      assetCopies.push({ source: absolute, output });
    } catch {
      error(
        "TC_ASSET_MISSING",
        "Asset file not found or unreadable: " + sourcePath,
        def,
        "path",
        "Supply the file at the declared project-relative path.",
      );
    }
  }
  const materials: SceneIR["materials"] = [];
  for (const [name, def] of registry("material")) {
    const material: SceneIR["materials"][number] = {
      id: name,
      color: text(def.color, def, "color", "#ffffff"),
      roughness: num(def.roughness, def, "roughness", 0.5, 0, 1),
      metalness: num(def.metalness, def, "metalness", 0, 0, 1),
      source: located(def),
    };
    if (def.texture !== undefined) {
      material.texture = ref(def.texture, def, "texture");
      requireRef("asset", material.texture, def, "texture");
      if (registry("asset").get(material.texture)?.type !== "texture")
        error(
          "TC_ASSET_TYPE",
          "Material textures must reference texture assets.",
          def,
          "texture",
        );
    }
    if (def.graph !== undefined) material.graph = graph(def.graph, def, "vec3");
    materials.push(material);
  }
  const computes: SceneIR["computes"] = [];
  for (const [name, def] of registry("compute")) {
    const outputType = def.outputType as GraphType;
    if (!["float", "vec3"].includes(outputType))
      error(
        "TC_GRAPH_TYPE",
        "Compute outputType must be float or vec3.",
        def,
        "outputType",
      );
    const count = num(def.count, def, "count", 1, 1);
    const workgroupSize = num(
      def.workgroupSize,
      def,
      "workgroupSize",
      64,
      1,
      256,
    );
    if (!Number.isInteger(count) || !Number.isInteger(workgroupSize))
      error(
        "TC_SCHEMA_RANGE",
        "Compute count and workgroupSize must be integers.",
        def,
        "count",
      );
    computes.push({
      id: name,
      count,
      workgroupSize,
      outputType,
      graph: graph(def.graph, def, outputType),
      source: located(def),
    });
  }
  const resolvedPrefabs = new Map<string, EntityIR>();
  const activePrefabs = new Set<string>();
  const transform = (raw: unknown, owner: Obj, base?: Transform): Transform => {
    const t = raw === undefined ? {} : obj(raw, owner, "transform");
    return {
      position: vector(t.position, t, "position", base?.position ?? [0, 0, 0]),
      rotation: vector(t.rotation, t, "rotation", base?.rotation ?? [0, 0, 0]),
      scale: vector(t.scale, t, "scale", base?.scale ?? [1, 1, 1]),
    };
  };
  const entity = (def: Obj, base?: EntityIR): EntityIR => {
    const result: EntityIR = {
      ...(base ? structuredClone(base) : {}),
      id: id(def),
      transform: transform(def.transform, def, base?.transform),
      components: structuredClone(base?.components ?? {}),
    };
    delete result.prefab;
    delete result.parent;
    if (def.parent !== undefined)
      result.parent = text(def.parent, def, "parent");
    if (def.prefab !== undefined)
      result.prefab = ref(def.prefab, def, "prefab");
    if (def.mesh !== undefined) {
      const m = obj(def.mesh, def, "mesh");
      const geometry = obj(m.geometry, m, "geometry");
      const material = ref(m.material, m, "material");
      requireRef("material", material, m, "material");
      if (!["box", "sphere", "plane"].includes(String(geometry.kind)))
        error(
          "TC_GEOMETRY_KIND",
          "M0 geometry must be box, sphere, or plane.",
          geometry,
          "kind",
        );
      if (geometry.kind === "box") {
        const size = vector(geometry.size, geometry, "size", [1, 1, 1]);
        if (size.some((x) => x <= 0))
          error(
            "TC_SCHEMA_RANGE",
            "Box sizes must be positive.",
            geometry,
            "size",
          );
      }
      if (geometry.kind === "sphere") {
        num(geometry.radius, geometry, "radius", 1, Number.EPSILON);
        num(geometry.segments, geometry, "segments", 32, 3, 256);
      }
      if (
        geometry.kind === "plane" &&
        geometry.size !== undefined &&
        (!Array.isArray(geometry.size) ||
          geometry.size.length !== 2 ||
          geometry.size.some(
            (v) => typeof v !== "number" || !Number.isFinite(v) || v <= 0,
          ))
      )
        error(
          "TC_SCHEMA_RANGE",
          "Plane size requires two positive numbers.",
          geometry,
          "size",
        );
      result.mesh = {
        geometry: geometry as Geometry,
        material,
        castShadow: m.castShadow !== false,
        receiveShadow: m.receiveShadow !== false,
      };
    }
    if (def.light !== undefined) {
      const l = obj(def.light, def, "light");
      if (!["directional", "point"].includes(String(l.kind)))
        error(
          "TC_LIGHT_KIND",
          "M0 light must be directional or point.",
          l,
          "kind",
        );
      result.light = {
        kind: l.kind as "directional" | "point",
        color: text(l.color, l, "color", "#ffffff"),
        intensity: num(l.intensity, l, "intensity", 1, 0),
        castShadow: l.castShadow !== false,
      };
    }
    for (const raw of list(def.components, def, "components")) {
      const c = obj(raw, def, "components");
      const name = ref(c.component, c, "component");
      requireRef("component", name, c, "component");
      const schema = componentLookup.get(name)?.schema;
      const supplied = c.value === undefined ? {} : obj(c.value, c, "value");
      const data: Record<string, unknown> = { ...result.components[name] };
      if (schema) {
        for (const [field, fieldDef] of Object.entries(schema)) {
          const value = Object.hasOwn(supplied, field)
            ? supplied[field]
            : Object.hasOwn(data, field)
              ? data[field]
              : structuredClone(fieldDef.default);
          const valid =
            fieldDef.type === "vec3"
              ? Array.isArray(value) &&
                value.length === 3 &&
                value.every((x) => typeof x === "number" && Number.isFinite(x))
              : typeof value === fieldDef.type &&
                (fieldDef.type !== "number" || Number.isFinite(value));
          if (!valid)
            error(
              "TC_COMPONENT_VALUE",
              "Invalid value for " + name + "." + field,
              supplied,
              field,
            );
          data[field] = value;
        }
        for (const field of Object.keys(supplied))
          if (!(field in schema))
            error(
              "TC_COMPONENT_VALUE",
              "Unknown component field: " + name + "." + field,
              supplied,
              field,
            );
      }
      result.components[name] = data;
    }
    return result;
  };
  const prefab = (name: string, owner: Obj): EntityIR | undefined => {
    if (resolvedPrefabs.has(name)) return resolvedPrefabs.get(name)!;
    const def = registry("prefab").get(name);
    if (!def) {
      requireRef("prefab", name, owner, "prefab");
      return;
    }
    if (activePrefabs.has(name)) {
      error(
        "TC_PREFAB_CYCLE",
        "Prefab inheritance cycle: " + name,
        def,
        "extends",
      );
      return;
    }
    activePrefabs.add(name);
    const base =
      def.extends !== undefined
        ? prefab(ref(def.extends, def, "extends"), def)
        : undefined;
    const result = entity(def, base);
    activePrefabs.delete(name);
    resolvedPrefabs.set(name, result);
    return result;
  };
  for (const [name, def] of registry("prefab")) prefab(name, def);
  const scene = obj(game.scene, game, "scene");
  if (scene.kind !== "scene")
    error(
      "TC_SCENE_KIND",
      "Game scene must reference defineScene.",
      game,
      "scene",
    );
  const entities: EntityIR[] = [];
  const entityLookup = new Map<string, EntityIR>();
  for (const raw of list(scene.entities, scene, "entities")) {
    const def = obj(raw, scene, "entities");
    const base =
      def.prefab !== undefined
        ? prefab(ref(def.prefab, def, "prefab"), def)
        : undefined;
    const result = entity(def, base);
    if (entityLookup.has(result.id))
      error("TC_DUPLICATE_ID", "Duplicate entity ID: " + result.id, def, "id");
    entityLookup.set(result.id, result);
    entities.push(result);
  }
  const visited = new Set<string>();
  const activeParents = new Set<string>();
  const checkParent = (e: EntityIR) => {
    if (visited.has(e.id)) return;
    if (activeParents.has(e.id)) {
      error(
        "TC_SCENE_CYCLE",
        "Entity parent cycle: " + e.id,
        scene,
        "entities",
      );
      return;
    }
    activeParents.add(e.id);
    if (e.parent) {
      const p = entityLookup.get(e.parent);
      if (!p)
        error(
          "TC_RESOURCE_MISSING",
          "Missing parent entity: " + e.parent,
          scene,
          "entities",
        );
      else checkParent(p);
    }
    activeParents.delete(e.id);
    visited.add(e.id);
  };
  for (const e of entities) checkParent(e);
  const systems: SceneIR["systems"] = [];
  const systemIds = new Set<string>();
  for (const raw of list(game.systems, game, "systems")) {
    const s = obj(raw, game, "systems");
    const name = id(s);
    if (
      s.kind !== "system" ||
      !s.run ||
      typeof s.run !== "object" ||
      !(s.run as Obj).__runtime
    )
      error(
        "TC_SYSTEM_RUN",
        "Systems must use defineSystem with a run function.",
        s,
        "run",
      );
    if (s.phase !== undefined && s.phase !== "update")
      error(
        "TC_SYSTEM_PHASE",
        "Only the update phase is implemented in M0.",
        s,
        "phase",
      );
    if (systemIds.has(name))
      error("TC_DUPLICATE_ID", "Duplicate system ID: " + name, s, "id");
    systemIds.add(name);
    systems.push({ id: name, phase: "update", source: located(s) });
  }
  const camera =
    scene.camera === undefined ? {} : obj(scene.camera, scene, "camera");
  const environment =
    scene.environment === undefined
      ? {}
      : obj(scene.environment, scene, "environment");
  const near = num(camera.near, camera, "near", 0.1, Number.EPSILON);
  const far = num(camera.far, camera, "far", 1000, near + Number.EPSILON);
  const ir: SceneIR = {
    format: "threecat.scene",
    version: 1,
    engineVersion: SDK_VERSION,
    gameId: id(game),
    scene: {
      id: id(scene),
      camera: {
        position: vector(camera.position, camera, "position", [5, 4, 7]),
        target: vector(camera.target, camera, "target", [0, 0, 0]),
        fov: num(camera.fov, camera, "fov", 50, 1, 179),
        near,
        far,
      },
      environment: {
        background: text(
          environment.background,
          environment,
          "background",
          "#151c2b",
        ),
        ambientIntensity: num(
          environment.ambientIntensity,
          environment,
          "ambientIntensity",
          0.4,
          0,
        ),
      },
      entities,
    },
    components,
    prefabs: [...resolvedPrefabs.values()],
    materials,
    computes,
    systems,
    assets,
  };
  return { ir: diagnostics.length ? undefined : ir, diagnostics, assetCopies };
}
