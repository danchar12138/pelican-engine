import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { Color } from "three";
import {
  inspectAsset,
  AssetInspectionError,
  type AssetType,
} from "../../assets/src/index.ts";
import { SDK_VERSION } from "../../sdk/src/index.ts";
import { resolveRenderSettings } from "../../runtime/src/render-settings.ts";
import { compileGraphDeclaration } from "./graph.ts";
import { isGraphType, graphValue } from "../../sdk/src/graph-values.ts";
import type {
  ComponentSchema,
  ComputeTextureBinding,
  MaterialTextureInput,
  Geometry,
  GraphType,
  Transform,
  Vec3,
  Vec4,
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
  const computeBuffers: NonNullable<SceneIR["computeBuffers"]> = [];
  const initialBuffers = new Map<string, NonNullable<SceneIR["computeBuffers"]>[number]>();
  for (const raw of list(game.computeBuffers, game, "computeBuffers")) {
    const definition = obj(raw, game, "computeBuffers");
    const name = id(definition);
    for (const key of Object.keys(definition)) if (!["id", "type", "count", "data"].includes(key)) error("TC_COMPUTE_BUFFER", "Unknown initial buffer field " + key, definition, key);
    if (initialBuffers.has(name)) error("TC_COMPUTE_BUFFER_NAME", "Duplicate initial buffer ID: " + name, definition, "id");
    if (!isGraphType(definition.type)) error("TC_GRAPH_TYPE", "Initial buffer type must be a graph value type.", definition, "type");
    const type = isGraphType(definition.type) ? definition.type : "float";
    const count = num(definition.count, definition, "count", 1, 1, 0xffffffff);
    if (!Number.isSafeInteger(count)) error("TC_COMPUTE_COUNT", "Initial buffer count must be a positive integer.", definition, "count");
    const buffer: NonNullable<SceneIR["computeBuffers"]>[number] = { id: name, type, count };
    if (definition.data !== undefined) {
      const data = list(definition.data, definition, "data");
      if (data.length !== count) error("TC_COMPUTE_COUNT", "Initial data length differs from buffer count.", definition, "data");
      buffer.data = data.map((value, index) => {
        const checked = graphValue(type, value);
        if (checked === null) error("TC_COMPUTE_VALUE", "Invalid initial buffer value at index " + index, definition, "data");
        return checked ?? (type === "bool" ? false : 0);
      });
    }
    computeBuffers.push(buffer); initialBuffers.set(name, buffer);
  }
  const computeTextures: NonNullable<SceneIR["computeTextures"]> = [];
  const initialTextures = new Map<string, NonNullable<SceneIR["computeTextures"]>[number]>();
  for (const raw of list(game.computeTextures, game, "computeTextures")) {
    const definition = obj(raw, game, "computeTextures"), name = id(definition);
    const assetInput = Object.hasOwn(definition, "asset");
    const fields = assetInput ? ["id", "asset"] : ["id", "width", "height", "data"];
    for (const key of Object.keys(definition)) if (!fields.includes(key)) error("TC_COMPUTE_TEXTURE", "Unknown or incompatible initial texture field " + key, definition, key);
    if (initialTextures.has(name) || initialBuffers.has(name)) error("TC_COMPUTE_TEXTURE_NAME", "Compute resource IDs must be unique across buffers and textures.", definition, "id");
    if (assetInput) {
      const asset = ref(definition.asset, definition, "asset");
      requireRef("asset", asset, definition, "asset");
      if (registry("asset").has(asset) && registry("asset").get(asset)?.type !== "texture")
        error("TC_ASSET_TYPE", "Initial compute textures must import declared texture assets.", definition, "asset");
      const texture = { id: name, asset };
      computeTextures.push(texture); initialTextures.set(name, texture);
      continue;
    }
    const width = num(definition.width, definition, "width", 1, 1, 2 ** 24), height = num(definition.height, definition, "height", 1, 1, 2 ** 24);
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width * height > 2 ** 24) error("TC_COMPUTE_TEXTURE_SIZE", "Texture dimensions must be positive integers with at most 2^24 texels.", definition, "width");
    const texture: NonNullable<SceneIR["computeTextures"]>[number] = { id: name, width, height };
    if (definition.data !== undefined) {
      const data = list(definition.data, definition, "data");
      if (data.length !== width * height) error("TC_COMPUTE_TEXTURE_SIZE", "Texture data must match width times height.", definition, "data");
      texture.data = data.map((value, index) => {
        const checked = graphValue("vec4", value);
        if (checked === null) error("TC_COMPUTE_VALUE", "Expected a finite f32 Vec4 texel at index " + index, definition, "data");
        return (checked ?? [0, 0, 0, 0]) as Vec4;
      });
    }
    computeTextures.push(texture); initialTextures.set(name, texture);
  }
  const graph = (raw: unknown, owner: Obj, expected: GraphType, domain: "material" | "compute" | "vertex" = "material", buffers?: Record<string, GraphType>, sampledTextures?: ReadonlySet<string>, textureSlots?: Readonly<Record<string, ComputeTextureBinding>>): GraphIR => {
    const g = obj(raw, owner, "graph");
    const result = compileGraphDeclaration(g, expected, {
      owner,
      domain,
      buffers,
      textureSlots,
      inputs: domain === "compute" ? ["index", "pixelCoord", "outputSize", "uv"] : domain === "vertex" ? ["positionLocal", "normalLocal", "vertexIndex", "instanceIndex", "uv", "uv1"] : ["uv", "uv1", "positionWorld", "normalWorld", "viewDirectionWorld", "vertexColor"],
      textures: sampledTextures ?? new Set(assets.filter(asset => asset.type === "texture").map(asset => asset.id)),
    });
    for (const issue of result.issues) error(issue.code, issue.message, issue.owner, issue.field, issue.suggestion);
    return result.graph;
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
        ...(def.type === "texture" && ["srgb", "linear"].includes(String(def.colorSpace)) ? { colorSpace: def.colorSpace as "srgb" | "linear" } : {}),
      });
      if (def.colorSpace !== undefined && (def.type !== "texture" || !["srgb", "linear"].includes(String(def.colorSpace))))
        error("TC_ASSET_COLOR_SPACE", "colorSpace is srgb or linear and applies only to texture assets.", def, "colorSpace");
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
  const renderBuffers = (def: Obj, label: "Material" | "Postprocess") => {
    const buffers: NonNullable<SceneIR["materials"][number]["buffers"]> = [];
    const bufferTypes: Record<string, GraphType> = Object.create(null);
    if (def.buffers !== undefined) {
      for (const raw of list(def.buffers, def, "buffers")) {
        const binding = obj(raw, def, "buffers"), name = text(binding.name, binding, "name");
        if (!/^[a-zA-Z][a-zA-Z0-9_.-]*$/.test(name) || Object.hasOwn(bufferTypes, name)) error("TC_RENDER_BUFFER_SLOT", label + " buffer slot names must be valid and unique.", binding, "name");
        for (const key of Object.keys(binding)) if (!["name", "type", "buffer", "count"].includes(key)) error("TC_RENDER_BUFFER_SLOT", "Unknown " + label.toLowerCase() + " buffer slot field " + key, binding, key);
        if (!isGraphType(binding.type)) error("TC_GRAPH_TYPE", label + " buffer slot type must be a graph value type.", binding, "type");
        const type = isGraphType(binding.type) ? binding.type : "float";
        bufferTypes[name] = type;
        const slot: (typeof buffers)[number] = { name, type };
        if (binding.count !== undefined) {
          slot.count = num(binding.count, binding, "count", 1, 1, 0xffffffff);
          if (!Number.isSafeInteger(slot.count)) error("TC_RENDER_BUFFER_COUNT", "Slot count must be an integer.", binding, "count");
        }
        if (binding.buffer !== undefined) {
          slot.buffer = text(binding.buffer, binding, "buffer");
          const initial = initialBuffers.get(slot.buffer);
          if (!initial) error("TC_RENDER_BUFFER_MISSING", "Initial " + label.toLowerCase() + " binding must reference a declared computeBuffers ID.", binding, "buffer");
          else if (initial.type !== type || (slot.count !== undefined && initial.count !== slot.count)) error("TC_RENDER_BUFFER_TYPE", "Initial " + label.toLowerCase() + " slot type/count differs from the buffer declaration.", binding, "buffer");
        }
        buffers.push(slot);
      }
    }
    return { buffers, bufferTypes };
  };
  const renderTextures = (def: Obj, label: "Material" | "Postprocess") => {
    const textures: MaterialTextureInput[] = [];
    const textureSlots: Record<string, ComputeTextureBinding> = Object.create(null);
    for (const raw of list(def.textures, def, "textures")) {
      const binding = obj(raw, def, "textures"), name = text(binding.name, binding, "name");
      if (!/^[a-zA-Z][a-zA-Z0-9_.-]*$/.test(name) || Object.hasOwn(textureSlots, name))
        error("TC_RENDER_TEXTURE_SLOT", label + " texture slot names must be valid and unique.", binding, "name");
      if (registry("asset").has(name))
        error("TC_RENDER_TEXTURE_SLOT", "Texture slot name conflicts with static asset ID: " + name, binding, "name");
      for (const key of Object.keys(binding)) if (!["name", "filter", "wrapU", "wrapV", "texture", "width", "height"].includes(key))
        error("TC_RENDER_TEXTURE_SLOT", "Unknown " + label.toLowerCase() + " texture slot field " + key, binding, key);
      const filter = binding.filter === undefined ? "linear" : binding.filter, wrapU = binding.wrapU === undefined ? "clamp" : binding.wrapU, wrapV = binding.wrapV === undefined ? "clamp" : binding.wrapV;
      if (filter !== "nearest" && filter !== "linear")
        error("TC_RENDER_TEXTURE_SAMPLER", "Texture filter must be nearest or linear.", binding, "filter");
      for (const [field, value] of [["wrapU", wrapU], ["wrapV", wrapV]] as const) if (!["clamp", "repeat", "mirror"].includes(String(value)))
        error("TC_RENDER_TEXTURE_SAMPLER", "Texture addressing must be clamp, repeat or mirror.", binding, field);
      const slot: MaterialTextureInput = {
        name, filter: filter === "nearest" ? "nearest" : "linear",
        wrapU: wrapU === "repeat" || wrapU === "mirror" ? wrapU : "clamp",
        wrapV: wrapV === "repeat" || wrapV === "mirror" ? wrapV : "clamp",
      };
      textureSlots[name] = { ...slot };
      for (const field of ["width", "height"] as const) if (binding[field] !== undefined) {
        const value = binding[field];
        if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > 2 ** 24)
          error("TC_RENDER_TEXTURE_SIZE", "Texture slot dimensions must be positive integers with at most 2^24 texels.", binding, field);
        else slot[field] = value;
      }
      if (slot.width !== undefined && slot.height !== undefined && slot.width * slot.height > 2 ** 24)
        error("TC_RENDER_TEXTURE_SIZE", "Texture slot dimensions exceed 2^24 texels.", binding, "width");
      if (binding.texture !== undefined) {
        slot.texture = text(binding.texture, binding, "texture");
        const initial = initialTextures.get(slot.texture);
        if (!initial) error("TC_RENDER_TEXTURE_MISSING", "Initial " + label.toLowerCase() + " binding must reference a declared computeTextures ID.", binding, "texture");
        else {
          const size = typeof initial.asset === "string" ? assets.find(asset => asset.id === initial.asset)?.metadata : initial;
          for (const field of ["width", "height"] as const) if (slot[field] !== undefined && typeof size?.[field] === "number" && slot[field] !== size[field])
            error("TC_RENDER_TEXTURE_SIZE", "Initial " + label.toLowerCase() + " slot dimensions differ from the texture declaration.", binding, field);
        }
      }
      textures.push(slot);
    }
    return { textures, textureSlots };
  };
  const materials: SceneIR["materials"] = [];
  for (const [name, def] of registry("material")) {
    const material: SceneIR["materials"][number] = {
      id: name,
      color: text(def.color, def, "color", "#ffffff"),
      roughness: num(def.roughness, def, "roughness", 0.5, 0, 1),
      metalness: num(def.metalness, def, "metalness", 0, 0, 1),
      source: located(def),
    };
    if (def.emissive !== undefined)
      material.emissive = text(def.emissive, def, "emissive");
    if (def.emissiveIntensity !== undefined)
      material.emissiveIntensity = num(
        def.emissiveIntensity,
        def,
        "emissiveIntensity",
        1,
        0,
      );
    if (def.opacity !== undefined)
      material.opacity = num(def.opacity, def, "opacity", 1, 0, 1);
    if (def.alphaTest !== undefined)
      material.alphaTest = num(def.alphaTest, def, "alphaTest", 0, 0, 1);
    if (def.side !== undefined) {
      if (!["front", "back", "double"].includes(String(def.side)))
        error("TC_MATERIAL_SIDE", "Unknown material side.", def, "side");
      else material.side = def.side as "front" | "back" | "double";
    }
    if (def.transmission !== undefined)
      material.transmission = num(
        def.transmission,
        def,
        "transmission",
        0,
        0,
        1,
      );
    if (def.ior !== undefined)
      material.ior = num(def.ior, def, "ior", 1.5, Number.EPSILON);
    if (def.specularIntensity !== undefined)
      material.specularIntensity = num(def.specularIntensity, def, "specularIntensity", 1, 0, 1);
    if (def.specularColor !== undefined) {
      const color = text(def.specularColor, def, "specularColor"), normalized = color.toLowerCase();
      if (!/^#(?:[a-f0-9]{3}|[a-f0-9]{6})$/i.test(color) && !Object.hasOwn(Color.NAMES, normalized))
        error("TC_MATERIAL_SPECULAR_COLOR", "Specular color must be an sRGB hex or named color.", def, "specularColor");
      material.specularColor = color;
    }
    if (def.attenuationColor !== undefined)
      material.attenuationColor = text(
        def.attenuationColor,
        def,
        "attenuationColor",
      );
    if (def.attenuationDistance !== undefined)
      material.attenuationDistance = num(
        def.attenuationDistance,
        def,
        "attenuationDistance",
        1,
        Number.EPSILON,
      );
    if ((material.transmission ?? 0) > 0 && material.metalness !== 0)
      error(
        "TC_MATERIAL_TRANSMISSION",
        "A closed dielectric volume cannot also be metallic.",
        def,
        "metalness",
        "Use metalness: 0 for dielectric transmission.",
      );
    if ((material.transmission ?? 0) > 0 && ((material.specularIntensity ?? 1) !== 1 || (material.specularColor !== undefined && !["#fff", "#ffffff", "white"].includes(material.specularColor.toLowerCase()))))
      error("TC_MATERIAL_SPECULAR_TRANSMISSION", "Non-default specular color/intensity on transmissive media is not supported.", def, "transmission", "Use default white specular with transmission, or set transmission to zero.");
    if (
      !(material.transmission! > 0) &&
      (def.attenuationColor !== undefined ||
        def.attenuationDistance !== undefined)
    )
      error(
        "TC_MATERIAL_TRANSMISSION",
        "Absorption requires positive transmission.",
        def,
        "transmission",
      );
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
    const slots = renderBuffers(def, "Material");
    const sampled = renderTextures(def, "Material");
    if (def.textures !== undefined) material.textures = sampled.textures;
    if (def.buffers !== undefined) material.buffers = slots.buffers;
    if (def.graph !== undefined) material.graph = graph(def.graph, def, "vec3", "material", slots.bufferTypes, undefined, sampled.textureSlots);
    if (def.graphs !== undefined) {
      const channels = obj(def.graphs, def, "graphs");
      const types = { baseColor: "vec3", emissive: "vec3", roughness: "float", metalness: "float", opacity: "float", normalWorld: "vec3" } as const;
      const graphs: NonNullable<typeof material.graphs> = {};
      for (const [channel, value] of Object.entries(channels)) {
        if (!Object.hasOwn(types, channel)) { error("TC_GRAPH_CHANNEL", "Unknown material graph channel " + channel, channels, channel); continue; }
        const key = channel as keyof typeof types;
        graphs[key] = graph(value, channels, types[key], "material", slots.bufferTypes, undefined, sampled.textureSlots);
        if ((key === "opacity" || key === "emissive") && graphs[key]?.requiredInputs?.includes("viewDirectionWorld"))
          error("TC_GRAPH_CONTEXT", "Coverage and emitted radiance are direction independent in this material model.", channels, channel);
      }
      if (material.graph && graphs.baseColor) error("TC_GRAPH_CHANNEL", "Use either legacy graph or graphs.baseColor, not both.", channels, "baseColor");
      if ((material.transmission ?? 0) > 0 && graphs.metalness) error("TC_MATERIAL_TRANSMISSION", "A closed dielectric graph cannot change metalness in this material model.", channels, "metalness");
      material.graphs = graphs;
    }
    if (def.vertex !== undefined) {
      const channels = obj(def.vertex, def, "vertex");
      const vertex: NonNullable<typeof material.vertex> = {};
      if (!Object.keys(channels).length) error("TC_VERTEX_GRAPH", "Declare at least a position or normal vertex graph.", def, "vertex");
      for (const [channel, value] of Object.entries(channels)) {
        if (channel !== "position" && channel !== "normal") { error("TC_VERTEX_GRAPH", "Unknown vertex graph channel " + channel, channels, channel); continue; }
        vertex[channel] = graph(value, channels, "vec3", "vertex", slots.bufferTypes, undefined, sampled.textureSlots);
      }
      material.vertex = vertex;
    }
    const parameters = new Map<string, NonNullable<typeof material.parameters>[number]>();
    for (const g of [material.graph, ...Object.values(material.graphs ?? {}), ...Object.values(material.vertex ?? {})]) for (const parameter of g?.parameters ?? []) {
      const old = parameters.get(parameter.name);
      if (old && JSON.stringify(old) !== JSON.stringify(parameter)) error("TC_GRAPH_PARAMETER", "Material graphs disagree about parameter " + parameter.name, def, "graphs");
      else parameters.set(parameter.name, parameter);
    }
    if (parameters.size) material.parameters = [...parameters.values()];
    materials.push(material);
  }
  const computes: SceneIR["computes"] = [];
  const postProcesses: NonNullable<SceneIR["postProcesses"]> = [];
  const declaredPost = list(game.postProcesses, game, "postProcesses").map(raw => obj(raw, game, "postProcesses"));
  const postIDs = new Set<string>();
  for (const definition of declaredPost) {
    if (definition.kind !== "postprocess") error("TC_POSTPROCESS_KIND", "Use definePostProcess declarations in postProcesses.", definition, "kind");
    const name = id(definition);
    if (postIDs.has(name) || name === "scene" || name.startsWith("scene."))
      error("TC_POSTPROCESS_ID", "Postprocess IDs must be unique and cannot use the reserved scene namespace.", definition, "id");
    postIDs.add(name);
  }
  const frameChannels = new Set(["scene.color", "scene.normal", "scene.depth"]);
  for (const definition of declaredPost) {
    const name = id(definition);
    for (const key of Object.keys(definition)) if (!["id", "kind", "graph", "enabled", "buffers", "textures"].includes(key)) error("TC_POSTPROCESS_FIELD", "Unknown postprocess field " + key, definition, key);
    const slots = renderBuffers(definition, "Postprocess");
    const sampled = renderTextures(definition, "Postprocess");
    const result = compileGraphDeclaration(definition.graph, "vec4", {
      owner: definition, domain: "postprocess", inputs: ["uv", "screenSize", "texelSize"],
      textures: new Set(assets.filter(asset => asset.type === "texture").map(asset => asset.id)),
      textureSlots: sampled.textureSlots,
      buffers: slots.bufferTypes, frameChannels, historyChannels: postIDs,
    });
    for (const issue of result.issues) error(issue.code, issue.message, issue.owner, issue.field, issue.suggestion);
    if (definition.enabled !== undefined && typeof definition.enabled !== "boolean") error("TC_POSTPROCESS_SETTINGS", "enabled must be boolean.", definition, "enabled");
    postProcesses.push({ id: name, enabled: definition.enabled !== false, graph: result.graph, ...(definition.buffers !== undefined ? { buffers: slots.buffers } : {}), ...(definition.textures !== undefined ? { textures: sampled.textures } : {}), source: located(definition) });
    frameChannels.add(name);
  }
  for (const [name, def] of registry("compute")) {
    const buffers: NonNullable<SceneIR["computes"][number]["buffers"]> = [];
    const textures: NonNullable<SceneIR["computes"][number]["textures"]> = [], sampledTextures = new Set<string>();
    for (const raw of list(def.textures, def, "textures")) {
      const binding = obj(raw, def, "textures"), bindingName = text(binding.name, binding, "name");
      if (!/^[a-zA-Z][a-zA-Z0-9_.-]*$/.test(bindingName) || sampledTextures.has(bindingName)) error("TC_COMPUTE_TEXTURE_BINDING", "Texture slot names must be valid and unique.", binding, "name");
      for (const key of Object.keys(binding)) if (!["name", "filter", "wrapU", "wrapV"].includes(key)) error("TC_COMPUTE_TEXTURE_BINDING", "Unknown texture slot field " + key, binding, key);
      const filter = binding.filter ?? "linear", wrapU = binding.wrapU ?? "clamp", wrapV = binding.wrapV ?? "clamp";
      if (filter !== "nearest" && filter !== "linear") error("TC_COMPUTE_TEXTURE_SAMPLER", "Texture filter must be nearest or linear.", binding, "filter");
      for (const [field, value] of [["wrapU", wrapU], ["wrapV", wrapV]] as const) if (!["clamp", "repeat", "mirror"].includes(String(value))) error("TC_COMPUTE_TEXTURE_SAMPLER", "Texture addressing must be clamp, repeat or mirror.", binding, field);
      textures.push({ name: bindingName, filter: filter === "nearest" ? "nearest" : "linear", wrapU: wrapU === "repeat" || wrapU === "mirror" ? wrapU : "clamp", wrapV: wrapV === "repeat" || wrapV === "mirror" ? wrapV : "clamp" });
      sampledTextures.add(bindingName);
    }
    const bufferTypes: Record<string, GraphType> = Object.create(null);
    if (def.buffers !== undefined) {
      for (const raw of list(def.buffers, def, "buffers")) {
        const binding = obj(raw, def, "buffers");
        const bindingName = text(binding.name, binding, "name");
        for (const key of Object.keys(binding)) if (!["name", "type"].includes(key)) error("TC_COMPUTE_BINDING", "Unknown compute buffer declaration field " + key, binding, key);
        if (!/^[a-zA-Z][a-zA-Z0-9_.-]*$/.test(bindingName) || Object.hasOwn(bufferTypes, bindingName))
          error("TC_COMPUTE_BINDING", "Compute buffer names must be valid and unique.", binding, "name");
        if (!isGraphType(binding.type)) error("TC_GRAPH_TYPE", "Compute buffer type must be a declared graph value type.", binding, "type");
        const type = isGraphType(binding.type) ? binding.type : "float";
        bufferTypes[bindingName] = type;
        buffers.push({ name: bindingName, type });
      }
    }
    const outputType: GraphType = isGraphType(def.outputType) ? def.outputType : "float";
    if (!isGraphType(def.outputType))
      error(
        "TC_GRAPH_TYPE",
        "Compute outputType must be a declared graph value type.",
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
      graph: graph(def.graph, def, outputType, "compute", bufferTypes, sampledTextures),
      ...(buffers.length ? { buffers } : {}),
      ...(textures.length ? { textures } : {}),
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
      if (!["directional", "point", "spot"].includes(String(l.kind)))
        error(
          "TC_LIGHT_KIND",
          "Light must be directional, point, or spot.",
          l,
          "kind",
        );
      result.light = {
        kind: l.kind as "directional" | "point" | "spot",
        color: text(l.color, l, "color", "#ffffff"),
        intensity: num(l.intensity, l, "intensity", 1, 0),
        castShadow: l.castShadow !== false,
        ...(l.target !== undefined
          ? { target: vector(l.target, l, "target", [0, 0, 0]) }
          : {}),
        ...(l.kind === "spot" ? {
          angle: num(l.angle, l, "angle", Math.PI / 3, Number.EPSILON, Math.PI / 2),
          penumbra: num(l.penumbra, l, "penumbra", 0, 0, 1),
        } : {}),
        ...(l.kind === "spot" || l.kind === "point" ? {
          distance: num(l.distance, l, "distance", 0, 0, 3.4028234663852886e38),
          decay: num(l.decay, l, "decay", 2, 0, 3.4028234663852886e38),
        } : {}),
      };
      if (l.kind !== "spot" && (l.angle !== undefined || l.penumbra !== undefined))
        error("TC_LIGHT_KIND", "angle and penumbra require a spot light.", l, "kind");
      if (l.kind === "directional" && (l.distance !== undefined || l.decay !== undefined))
        error("TC_LIGHT_KIND", "distance and decay require a point or spot light.", l, "kind");
      if (typeof l.distance === "number" && l.distance > 0 && Math.fround(l.distance) === 0)
        error("TC_SCHEMA_RANGE", "distance must be representable as a positive float32 value.", l, "distance");
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
      for (const field of ["castShadow", "receiveShadow", "embeddedLights", "embeddedLightShadows"] as const)
        if (model[field] !== undefined && typeof model[field] !== "boolean")
          error("TC_MODEL_VALUE", field + " must be a boolean.", model, field);
      if (model.material !== undefined && model.materialSlots !== undefined)
        error("TC_MODEL_MATERIAL_CONFLICT", "Use either material or materialSlots, not both.", model, "materialSlots");
      let materialSlots: Record<string, string> | undefined;
      if (model.materialSlots !== undefined) {
        const slots = obj(model.materialSlots, model, "materialSlots");
        const entries = Object.entries(slots).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
        if (!entries.length) error("TC_MODEL_MATERIAL_SLOTS", "materialSlots must not be empty.", model, "materialSlots");
        materialSlots = Object.fromEntries(entries.map(([slot, value]) => {
          if (!slot.trim()) error("TC_MODEL_MATERIAL_SLOTS", "Material slot names must not be empty.", model, "materialSlots");
          const name = ref(value, slots, slot);
          requireRef("material", name, slots, slot);
          return [slot, name];
        }));
      }
      result.model = {
        castShadow: model.castShadow !== false,
        receiveShadow: model.receiveShadow !== false,
        embeddedLights: model.embeddedLights !== false,
        embeddedLightShadows: model.embeddedLightShadows === true,
        asset,
        scale: num(model.scale, model, "scale", 1, Number.EPSILON),
        ...(model.material !== undefined ? { material: (() => { const name = ref(model.material, model, "material"); requireRef("material", name, model, "material"); return name; })() } : {}),
        ...(materialSlots !== undefined ? { materialSlots } : {}),
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
    let backgroundTexture: string | undefined;
    if (environment.backgroundTexture !== undefined) {
      backgroundTexture = ref(environment.backgroundTexture, environment, "backgroundTexture");
      requireRef("asset", backgroundTexture, environment, "backgroundTexture");
      if (registry("asset").get(backgroundTexture)?.type !== "texture")
        error("TC_ASSET_TYPE", "Background panorama must reference a texture asset.", environment, "backgroundTexture");
    }
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
        ...(backgroundTexture !== undefined ? { backgroundTexture } : {}),
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
  const audioBuses: NonNullable<SceneIR["audioBuses"]> = [];
  const busIds = new Set<string>();
  for (const raw of list(game.audioBuses, game, "audioBuses")) {
    const bus = obj(raw, game, "audioBuses");
    const name = id(bus);
    if (busIds.has(name)) error("TC_DUPLICATE_ID", "Duplicate audio bus ID: " + name, bus, "id");
    busIds.add(name);
    audioBuses.push({ id: name, volume: num(bus.volume, bus, "volume", 1, 0, 1) });
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
    if (sound.bus !== undefined && (typeof sound.bus !== "string" || !busIds.has(sound.bus)))
      error("TC_AUDIO_BUS", "Sound bus must reference a declared audio bus.", sound, "bus");
    sounds.push({
      id: name,
      asset,
      volume: num(sound.volume, sound, "volume", 1, 0, 1),
      loop: sound.loop === true,
      ...(sound.bus !== undefined ? { bus: sound.bus as string } : {}),
    });
  }
  const ir: SceneIR = {
    format: "pelican.scene",
    version: 1,
    engineVersion: SDK_VERSION,
    gameId: id(game),
    ...(game.render !== undefined
      ? {
          render: (() => {
            try {
              return resolveRenderSettings(game.render);
            } catch (cause) {
              error("TC_RENDER_SETTINGS", String(cause), game, "render");
              return resolveRenderSettings({});
            }
          })(),
        }
      : {}),
    scene: primaryScene,
    ...(additionalScenes.length ? { scenes: additionalScenes } : {}),
    ...(game.input !== undefined ? { input } : {}),
    ...(game.ui !== undefined ? { ui } : {}),
    ...(game.sounds !== undefined ? { sounds } : {}),
    ...(game.audioBuses !== undefined ? { audioBuses } : {}),
    components,
    prefabs: [...resolvedPrefabs.values()],
    materials,
    computes,
    ...(computeBuffers.length ? { computeBuffers } : {}),
    ...(computeTextures.length ? { computeTextures } : {}),
    ...(postProcesses.length ? { postProcesses } : {}),
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
