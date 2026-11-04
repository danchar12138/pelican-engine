import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  inspectAsset,
  AssetInspectionError,
  type AssetType,
} from "../../assets/src/index.ts";
import { SDK_VERSION } from "../../sdk/src/index.ts";
import type {
  ComponentSchema,
  Geometry,
  GraphType,
  Transform,
  Vec3,
} from "../../sdk/src/index.ts";
import type {
  Diagnostic,
  EntityIR,
  GraphIR,
  SceneIR,
  SourceLocation,
} from "./types.ts";
import type { Extractor, ObjectValue } from "./extract.ts";
import { SYSTEM_PHASES, type SystemPhase } from "./types.ts";
type Obj = Record<string, unknown>;
export const hash = (data: string | Uint8Array) =>
  createHash("sha256").update(data).digest("hex");
export interface AssetCopy {
  source: string;
  output: string;
  expectedHash: string;
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
    if (!["texture", "binary", "model", "audio"].includes(String(def.type))) {
      error("TC_ASSET_TYPE", "Unsupported asset type.", def, "type");
      continue;
    }
    try {
      const content = await fs.readFile(absolute);
      const metadata = await inspectAsset(absolute, def.type as AssetType);
      if (metadata.sha256 !== hash(content)) {
        error(
          "TC_ASSET_CHANGED",
          "Asset changed during inspection: " + sourcePath,
          def,
          "path",
          "Wait for the asset producer to finish writing and rebuild.",
        );
        continue;
      }
      const output = "assets/" + name + "-" + path.basename(absolute);
      assets.push({
        id: name,
        type: def.type as "texture" | "binary" | "model" | "audio",
        path: output,
        sourcePath: rel.replaceAll("\\", "/"),
        hash: hash(content),
        metadata,
        sourceInfo: {
          ...(typeof def.source === "string" ? { source: def.source } : {}),
          ...(typeof def.license === "string" ? { license: def.license } : {}),
          ...(typeof def.attribution === "string"
            ? { attribution: def.attribution }
            : {}),
        },
        source: located(def),
      });
      for (const field of ["source", "license", "attribution"] as const)
        if (def[field] !== undefined && typeof def[field] !== "string")
          error(
            "TC_ASSET_PROVENANCE",
            "Asset " + field + " must be a string.",
            def,
            field,
          );
      if (typeof def.license !== "string" || !def.license.trim())
        diagnostics.push({
          code: "TC_ASSET_LICENSE_UNDECLARED",
          severity: "warning",
          message:
            "No asset license was declared for " +
            name +
            "; ownership and usage rights were not inferred.",
          suggestion:
            "Declare the actual license and required attribution in defineAsset metadata after checking the asset's terms.",
          source: source(def, "license") ?? located(def),
        });
      assetCopies.push({
        source: absolute,
        output,
        expectedHash: hash(content),
      });
    } catch (cause) {
      if (cause instanceof AssetInspectionError) {
        error(
          cause.code,
          cause.message.replaceAll(absolute, sourcePath),
          def,
          "path",
          cause.suggestion,
        );
        continue;
      }
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
        ...(l.target !== undefined
          ? { target: vector(l.target, l, "target", [0, 0, 0]) }
          : {}),
      };
      if (l.shadow !== undefined) {
        const shadow = obj(l.shadow, l, "shadow");
        const mapSize = num(shadow.mapSize, shadow, "mapSize", 2048, 128, 8192);
        if (!Number.isInteger(mapSize) || !Number.isInteger(Math.log2(mapSize)))
          error(
            "TC_LIGHT_SHADOW",
            "Shadow mapSize must be a power of two.",
            shadow,
            "mapSize",
          );
        const near = num(shadow.near, shadow, "near", 0.1, Number.EPSILON);
        result.light.shadow = {
          mapSize,
          extent: num(shadow.extent, shadow, "extent", 20, Number.EPSILON),
          bias: num(shadow.bias, shadow, "bias", -0.0001),
          normalBias: num(shadow.normalBias, shadow, "normalBias", 0.04, 0),
          near,
          far: num(shadow.far, shadow, "far", 100, near + Number.EPSILON),
        };
      }
    }
    if (def.model !== undefined) {
      const model = obj(def.model, def, "model");
      const asset = ref(model.asset, model, "asset");
      requireRef("asset", asset, model, "asset");
      if (registry("asset").get(asset)?.type !== "model")
        error(
          "TC_ASSET_TYPE",
          "Entity models must reference model assets.",
          model,
          "asset",
        );
      for (const field of ["castShadow", "receiveShadow"] as const)
        if (model[field] !== undefined && typeof model[field] !== "boolean")
          error("TC_MODEL_VALUE", field + " must be a boolean.", model, field);
      result.model = {
        castShadow: model.castShadow !== false,
        receiveShadow: model.receiveShadow !== false,
        asset,
        scale: num(model.scale, model, "scale", 1, Number.EPSILON),
        ...(model.offset !== undefined
          ? { offset: vector(model.offset, model, "offset", [0, 0, 0]) }
          : {}),
        ...(model.rotation !== undefined
          ? { rotation: vector(model.rotation, model, "rotation", [0, 0, 0]) }
          : {}),
      };
      if (model.animation !== undefined) {
        const animation = obj(model.animation, model, "animation");
        if (animation.loop !== undefined && typeof animation.loop !== "boolean")
          error(
            "TC_MODEL_ANIMATION",
            "Animation loop must be a boolean.",
            animation,
            "loop",
          );
        const clips = assets.find((entry) => entry.id === asset)?.metadata
          ?.animations as { name: string }[] | undefined;
        if (clips && !clips.some((clip) => clip.name === animation.clip))
          error(
            "TC_MODEL_CLIP",
            "Model " +
              asset +
              " has no animation clip " +
              String(animation.clip) +
              ". Available: " +
              clips.map((clip) => clip.name).join(", "),
            animation,
            "clip",
            "Choose a clip from the asset metadata or re-export the animation.",
          );
        result.model.animation = {
          clip: text(animation.clip, animation, "clip"),
          speed: num(animation.speed, animation, "speed", 1, Number.EPSILON),
          loop: animation.loop === undefined ? true : animation.loop === true,
        };
      }
    }
    if (def.rigidBody !== undefined) {
      const body = obj(def.rigidBody, def, "rigidBody");
      const collider = obj(body.collider, body, "collider");
      const shape = collider.shape;
      if (!["box", "sphere", "capsule"].includes(String(shape)))
        error(
          "TC_PHYSICS_COLLIDER",
          "Collider shape must be box, sphere, or capsule.",
          collider,
          "shape",
        );
      const resolved: EntityIR["rigidBody"] = {
        type: (body.type ?? "fixed") as "fixed" | "dynamic" | "kinematic",
        collider: {
          shape: (shape ?? "box") as "box" | "sphere" | "capsule",
          ...(shape === "box"
            ? { size: vector(collider.size, collider, "size", [1, 1, 1]) }
            : {}),
          ...(shape === "sphere"
            ? {
                radius: num(
                  collider.radius,
                  collider,
                  "radius",
                  0.5,
                  Number.EPSILON,
                ),
              }
            : {}),
          ...(shape === "capsule"
            ? {
                radius: num(
                  collider.radius,
                  collider,
                  "radius",
                  0.5,
                  Number.EPSILON,
                ),
                halfHeight: num(
                  collider.halfHeight,
                  collider,
                  "halfHeight",
                  0.5,
                  Number.EPSILON,
                ),
              }
            : {}),
          ...(collider.offset !== undefined
            ? { offset: vector(collider.offset, collider, "offset", [0, 0, 0]) }
            : {}),
        },
        mass: num(body.mass, body, "mass", 1, Number.EPSILON),
        friction: num(body.friction, body, "friction", 0.5, 0, 1),
        restitution: num(body.restitution, body, "restitution", 0, 0, 1),
        trigger: body.trigger === true,
      };
      if (
        !["fixed", "dynamic", "kinematic"].includes(
          String(body.type ?? "fixed"),
        )
      )
        error(
          "TC_PHYSICS_BODY",
          "Rigid body type must be fixed, dynamic, or kinematic.",
          body,
          "type",
        );
      if (body.trigger !== undefined && typeof body.trigger !== "boolean")
        error(
          "TC_PHYSICS_BODY",
          "Rigid body trigger must be a boolean.",
          body,
          "trigger",
        );
      if (
        resolved.collider.shape === "box" &&
        resolved.collider.size?.some((x) => x <= 0)
      )
        error(
          "TC_PHYSICS_COLLIDER",
          "Box collider dimensions must be positive.",
          collider,
          "size",
        );
      result.rigidBody = resolved;
    }
    if (def.character !== undefined) {
      const character = obj(def.character, def, "character");
      result.character = {
        radius: num(
          character.radius,
          character,
          "radius",
          0.35,
          Number.EPSILON,
        ),
        height: num(character.height, character, "height", 1.8, Number.EPSILON),
        speed: num(character.speed, character, "speed", 4, 0),
        jumpSpeed: num(character.jumpSpeed, character, "jumpSpeed", 5, 0),
        gravity: num(character.gravity, character, "gravity", 9.81, 0),
      };
      if (result.character.height < result.character.radius * 2)
        error(
          "TC_CHARACTER_CAPSULE",
          "Character height must be at least its capsule diameter (2 * radius).",
          character,
          "height",
        );
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
  const resolveScene = (rawScene: unknown, owner: object, key: string) => {
    const scene = obj(rawScene, owner, key);
    if (scene.kind !== "scene")
      error(
        "TC_SCENE_KIND",
        "Game scenes must reference defineScene.",
        owner,
        key,
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
        error(
          "TC_DUPLICATE_ID",
          "Duplicate entity ID: " + result.id,
          def,
          "id",
        );
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
        const parent = entityLookup.get(e.parent);
        if (!parent)
          error(
            "TC_RESOURCE_MISSING",
            "Missing parent entity: " + e.parent,
            scene,
            "entities",
          );
        else checkParent(parent);
      }
      activeParents.delete(e.id);
      visited.add(e.id);
    };
    for (const e of entities) checkParent(e);
    const camera =
      scene.camera === undefined ? {} : obj(scene.camera, scene, "camera");
    const environment =
      scene.environment === undefined
        ? {}
        : obj(scene.environment, scene, "environment");
    if (
      environment.lighting !== undefined &&
      !["none", "studio"].includes(String(environment.lighting))
    )
      error(
        "TC_ENVIRONMENT_LIGHTING",
        "Supported environment lighting presets are none and studio.",
        environment,
        "lighting",
      );
    const near = num(camera.near, camera, "near", 0.1, Number.EPSILON);
    const far = num(camera.far, camera, "far", 1000, near + Number.EPSILON);
    let follow: SceneIR["scene"]["follow"];
    if (scene.follow !== undefined) {
      const f = obj(scene.follow, scene, "follow");
      const target = text(f.entity, f, "entity");
      if (!entityLookup.has(target))
        error(
          "TC_CAMERA_FOLLOW_ENTITY",
          "Camera follow target must exist in the same scene: " + target,
          f,
          "entity",
        );
      follow = {
        entity: target,
        distance: num(f.distance, f, "distance", 5, Number.EPSILON),
        height: num(f.height, f, "height", 2, 0),
        lookHeight: num(f.lookHeight, f, "lookHeight", 1, 0),
        yaw: num(f.yaw, f, "yaw", 0),
        smoothing: num(f.smoothing, f, "smoothing", 0.1, 0, 1),
      };
    }
    return {
      id: id(scene),
      camera: {
        position: vector(camera.position, camera, "position", [5, 4, 7]),
        target: vector(camera.target, camera, "target", [0, 0, 0]),
        fov: num(camera.fov, camera, "fov", 50, 1, 179),
        near,
        far,
      },
      environment: {
        ...(environment.lighting !== undefined
          ? { lighting: environment.lighting as "none" | "studio" }
          : {}),
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
      ...(follow ? { follow } : {}),
      gravity: vector(scene.gravity, scene, "gravity", [0, -9.81, 0]),
      entities,
    };
  };
  const primaryScene = resolveScene(game.scene, game, "scene");
  const additionalScenes = list(game.scenes, game, "scenes").map((value) =>
    resolveScene(value, game, "scenes"),
  );
  const allScenes = [primaryScene, ...additionalScenes];
  const sceneIds = new Set<string>();
  for (const scene of allScenes) {
    if (sceneIds.has(scene.id))
      error(
        "TC_DUPLICATE_ID",
        "Duplicate scene ID: " + scene.id,
        game,
        "scenes",
      );
    sceneIds.add(scene.id);
  }
  const systems: SceneIR["systems"] = [];
  const systemOwners: Obj[] = [];
  const systemIds = new Set<string>();
  for (const raw of list(game.systems, game, "systems")) {
    const s = obj(raw, game, "systems");
    systemOwners.push(s);
    const name = id(s);
    for (const key of Object.keys(s))
      if (
        ![
          "kind",
          "id",
          "phase",
          "before",
          "after",
          "reads",
          "writes",
          "structural",
          "run",
        ].includes(key)
      )
        error("TC_SYSTEM_METADATA", "Unknown system property: " + key, s, key);
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
    if (
      s.phase !== undefined &&
      !SYSTEM_PHASES.includes(s.phase as SystemPhase)
    )
      error(
        "TC_SYSTEM_PHASE",
        "Unknown system phase; expected " + SYSTEM_PHASES.join(", ") + ".",
        s,
        "phase",
      );
    if (systemIds.has(name))
      error("TC_DUPLICATE_ID", "Duplicate system ID: " + name, s, "id");
    systemIds.add(name);
    const metadata: SceneIR["systems"][number] = {
      id: name,
      phase: (s.phase ?? "update") as SystemPhase,
      source: located(s),
    };
    for (const key of ["before", "after", "reads", "writes"] as const) {
      if (s[key] === undefined) continue;
      const values = list(s[key], s, key);
      const names: string[] = [];
      for (const value of values) {
        if (typeof value !== "string" || !value.trim()) {
          error(
            "TC_SYSTEM_METADATA",
            key + " must contain non-empty IDs.",
            s,
            key,
          );
          continue;
        }
        if (names.includes(value))
          error(
            "TC_SYSTEM_METADATA",
            "Duplicate " + key + " ID: " + value,
            s,
            key,
          );
        if (
          (key === "reads" || key === "writes") &&
          value !== "Transform" &&
          !registry("component").has(value)
        )
          error(
            "TC_SYSTEM_ACCESS",
            "Unknown component access: " + value,
            s,
            key,
          );
        names.push(value);
      }
      metadata[key] = names;
    }
    if (s.structural !== undefined) {
      if (typeof s.structural !== "boolean")
        error(
          "TC_SYSTEM_METADATA",
          "structural must be a boolean.",
          s,
          "structural",
        );
      else metadata.structural = s.structural;
    }
    systems.push(metadata);
  }
  // Keep declaration order in IR; dependencies describe the runtime scheduler's order.
  const bySystemId = new Map(
    systems.map((s, i) => [s.id, { system: s, owner: systemOwners[i]! }]),
  );
  const edges = new Map(systems.map((s) => [s.id, new Set<string>()]));
  for (let i = 0; i < systems.length; i++) {
    const s = systems[i]!,
      owner = systemOwners[i]!;
    for (const key of ["before", "after"] as const) {
      for (const target of s[key] ?? []) {
        const other = bySystemId.get(target)?.system;
        if (!other) {
          error(
            "TC_SYSTEM_DEPENDENCY",
            "Unknown system dependency: " + target,
            owner,
            key,
          );
          continue;
        }
        const from = key === "before" ? s : other;
        const to = key === "before" ? other : s;
        if (SYSTEM_PHASES.indexOf(from.phase) > SYSTEM_PHASES.indexOf(to.phase))
          error(
            "TC_SYSTEM_PHASE_ORDER",
            "Dependency reverses phase order: " + from.id + " -> " + to.id,
            owner,
            key,
          );
        edges.get(from.id)!.add(to.id);
      }
    }
  }
  const done = new Set<string>(),
    visiting = new Set<string>();
  const visitSystem = (name: string) => {
    if (visiting.has(name)) {
      const owner = bySystemId.get(name)!.owner;
      error(
        "TC_SYSTEM_CYCLE",
        "System dependency cycle at " + name,
        owner,
        owner.after !== undefined
          ? "after"
          : owner.before !== undefined
            ? "before"
            : "id",
      );
      return;
    }
    if (done.has(name)) return;
    visiting.add(name);
    for (const next of edges.get(name) ?? []) visitSystem(next);
    visiting.delete(name);
    done.add(name);
  };
  for (const s of systems) visitSystem(s.id);
  const input: Record<string, string[]> = {};
  if (game.input !== undefined) {
    const bindings = obj(game.input, game, "input");
    for (const [action, raw] of Object.entries(bindings)) {
      if (
        !action.trim() ||
        action.length > 64 ||
        /[\x00-\x1f\x7f]/.test(action)
      )
        error(
          "TC_INPUT_ACTION",
          "Input action names must be 1-64 printable characters.",
          bindings,
          action,
        );
      const values = list(raw, bindings, action);
      if (!values.length || values.length > 16)
        error(
          "TC_INPUT_BINDINGS",
          "Each action must have between 1 and 16 key bindings.",
          bindings,
          action,
        );
      const keys: string[] = [];
      for (const key of values) {
        if (
          typeof key !== "string" ||
          !key.length ||
          key.length > 64 ||
          /[\x00-\x1f\x7f]/.test(key)
        ) {
          error(
            "TC_INPUT_BINDINGS",
            "Key names must be 1-64 printable characters.",
            bindings,
            action,
          );
          continue;
        }
        if (keys.includes(key))
          error(
            "TC_INPUT_BINDINGS",
            "Duplicate key binding: " + key,
            bindings,
            action,
          );
        keys.push(key);
      }
      input[action] = keys;
    }
  }
  const ui: NonNullable<SceneIR["ui"]> = [];
  const uiIds = new Set<string>();
  for (const raw of list(game.ui, game, "ui")) {
    const element = obj(raw, game, "ui");
    const name = id(element);
    if (uiIds.has(name))
      error(
        "TC_DUPLICATE_ID",
        "Duplicate UI element ID: " + name,
        element,
        "id",
      );
    uiIds.add(name);
    const kind = element.kind;
    if (!["text", "bar", "button", "input"].includes(String(kind)))
      error(
        "TC_UI_KIND",
        "UI kind must be text, bar, button or input.",
        element,
        "kind",
      );
    const color = text(element.color, element, "color", "#ffffff");
    const namedColors = new Set([
      "black",
      "white",
      "red",
      "green",
      "blue",
      "yellow",
      "orange",
      "purple",
      "pink",
      "gray",
      "grey",
      "cyan",
      "magenta",
      "lime",
      "navy",
      "teal",
      "silver",
      "maroon",
      "olive",
      "aqua",
      "fuchsia",
      "rebeccapurple",
      "transparent",
    ]);
    if (
      !/^(#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})|(?:rgb|rgba|hsl|hsla)\([\d.% ,+-]+\))$/i.test(
        color,
      ) &&
      !namedColors.has(color.toLowerCase())
    )
      error(
        "TC_UI_COLOR",
        "UI color must be a CSS hex color or named color.",
        element,
        "color",
      );
    const anchor = element.anchor ?? "top-left";
    if (
      ![
        "top-left",
        "top-right",
        "bottom-left",
        "bottom-right",
        "center",
      ].includes(String(anchor))
    )
      error("TC_UI_ANCHOR", "Unknown UI anchor.", element, "anchor");
    if (element.visible !== undefined && typeof element.visible !== "boolean")
      error("TC_UI_VALUE", "UI visible must be a boolean.", element, "visible");
    ui.push({
      id: name,
      kind: (kind ?? "text") as "text" | "bar" | "button" | "input",
      text: text(element.text, element, "text", ""),
      value: num(element.value, element, "value", 0, 0, 1),
      visible: element.visible !== false,
      anchor: anchor as NonNullable<SceneIR["ui"]>[number]["anchor"],
      x: num(element.x, element, "x", 0),
      y: num(element.y, element, "y", 0),
      width: num(element.width, element, "width", 160, Number.EPSILON),
      color,
      ...(element.world !== undefined
        ? {
            world: (() => {
              const world = obj(element.world, element, "world"),
                entity = text(world.entity, world, "entity");
              if (
                !allScenes.some((scene) =>
                  scene.entities.some((item) => item.id === entity),
                )
              )
                error(
                  "TC_UI_WORLD_ENTITY",
                  "World UI entity must be declared in at least one scene.",
                  world,
                  "entity",
                );
              if (
                world.occlude !== undefined &&
                typeof world.occlude !== "boolean"
              )
                error(
                  "TC_UI_WORLD_VALUE",
                  "occlude must be a boolean.",
                  world,
                  "occlude",
                );
              return {
                entity,
                offset: vector(world.offset, world, "offset", [0, 0, 0]),
                occlude: world.occlude !== false,
              };
            })(),
          }
        : {}),
    });
  }
  const sounds: NonNullable<SceneIR["sounds"]> = [];
  const soundIds = new Set<string>();
  for (const raw of list(game.sounds, game, "sounds")) {
    const sound = obj(raw, game, "sounds");
    const name = id(sound);
    if (soundIds.has(name))
      error("TC_DUPLICATE_ID", "Duplicate sound ID: " + name, sound, "id");
    soundIds.add(name);
    const asset = ref(sound.asset, sound, "asset");
    requireRef("asset", asset, sound, "asset");
    if (registry("asset").get(asset)?.type !== "audio")
      error(
        "TC_ASSET_TYPE",
        "Sound definitions must reference audio assets.",
        sound,
        "asset",
      );
    if (sound.loop !== undefined && typeof sound.loop !== "boolean")
      error("TC_SOUND_VALUE", "Sound loop must be a boolean.", sound, "loop");
    sounds.push({
      id: name,
      asset,
      volume: num(sound.volume, sound, "volume", 1, 0, 1),
      loop: sound.loop === true,
    });
  }
  const ir: SceneIR = {
    format: "threecat.scene",
    version: 1,
    engineVersion: SDK_VERSION,
    gameId: id(game),
    scene: primaryScene,
    ...(additionalScenes.length ? { scenes: additionalScenes } : {}),
    ...(game.input !== undefined ? { input } : {}),
    ...(game.ui !== undefined ? { ui } : {}),
    ...(game.sounds !== undefined ? { sounds } : {}),
    components,
    prefabs: [...resolvedPrefabs.values()],
    materials,
    computes,
    systems,
    assets,
    assetNotices: assets.map((asset) => ({
      id: asset.id,
      path: asset.path,
      license: asset.sourceInfo?.license ?? null,
      ...(asset.sourceInfo?.attribution
        ? { attribution: asset.sourceInfo.attribution }
        : {}),
      ...(asset.sourceInfo?.source ? { source: asset.sourceInfo.source } : {}),
    })),
  };
  return {
    ir: diagnostics.some((diagnostic) => diagnostic.severity === "error")
      ? undefined
      : ir,
    diagnostics,
    assetCopies,
  };
}
