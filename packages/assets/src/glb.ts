import path from "node:path";
import { type GLTF } from "@gltf-transform/core";
import { InspectionContext } from "./errors.ts";

export type AccessorData = {
  definition: GLTF.IAccessor;
  values: number[];
  components: number;
  min: number[];
  max: number[];
};
export type Container = {
  json: GLTF.IGLTF;
  bin: Buffer;
  accessors: AccessorData[];
};

export function parseGLB(data: Buffer, ctx: InspectionContext): Container {
  if (data.toString("latin1", 0, 4) !== "glTF") {
    if (path.extname(ctx.file).toLowerCase() === ".glb")
      ctx.invalid("GLB/header", "Missing or damaged GLB magic bytes.");
    ctx.unsupported(
      "model/format",
      "Only self-contained GLB 2.0 is implemented; JSON .gltf is not supported.",
    );
  }
  ctx.check(data.length >= 20, "GLB/header", "Truncated GLB header.");
  if (data.readUInt32LE(4) !== 2)
    ctx.unsupported(
      "GLB/version",
      `GLB version ${data.readUInt32LE(4)} is not implemented.`,
    );
  ctx.check(
    data.readUInt32LE(8) === data.length && data.length % 4 === 0,
    "GLB/length",
    "Declared GLB length must equal actual bytes and be four-byte aligned.",
  );
  let offset = 12,
    raw: unknown,
    bin: Buffer = Buffer.alloc(0),
    hasBin = false;
  while (offset < data.length) {
    ctx.check(
      offset + 8 <= data.length,
      "GLB/chunk",
      "Truncated chunk header.",
    );
    const size = data.readUInt32LE(offset),
      type = data.readUInt32LE(offset + 4),
      end = offset + 8 + size;
    ctx.check(
      size % 4 === 0 && end <= data.length,
      "GLB/chunk",
      "Chunk length is misaligned or exceeds GLB boundary.",
    );
    const chunk = data.subarray(offset + 8, end);
    if (type === 0x4e4f534a) {
      ctx.check(
        offset === 12 && raw === undefined,
        "GLB/JSON",
        "Exactly one JSON chunk must be first.",
      );
      try {
        raw = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(chunk),
        );
      } catch {
        ctx.invalid(
          "GLB/JSON",
          "Malformed UTF-8 or JSON chunk (padding must be spaces).",
        );
      }
    } else if (type === 0x004e4942) {
      ctx.check(
        raw !== undefined && !hasBin,
        "GLB/BIN",
        "Duplicate BIN chunk or BIN before JSON.",
      );
      hasBin = true;
      bin = chunk;
    } else
      ctx.unsupported(
        "GLB/chunk",
        `Unknown GLB chunk type 0x${type.toString(16)}.`,
      );
    offset = end;
  }
  ctx.check(
    raw && typeof raw === "object" && !Array.isArray(raw),
    "GLB/JSON",
    "JSON root must be an object.",
  );
  const json = raw as GLTF.IGLTF;
  ctx.check(
    json.asset && typeof json.asset === "object",
    "asset",
    "Missing glTF asset declaration.",
  );
  if (
    json.asset.version !== "2.0" ||
    (json.asset.minVersion !== undefined && json.asset.minVersion !== "2.0")
  )
    ctx.unsupported("asset/version", "Only glTF 2.0 is implemented.");
  for (const key of [
    "buffers",
    "bufferViews",
    "accessors",
    "images",
    "textures",
    "samplers",
    "materials",
    "meshes",
    "nodes",
    "skins",
    "animations",
    "scenes",
    "cameras",
  ] as const) {
    const list = json[key];
    if (list !== undefined)
      ctx.check(
        Array.isArray(list) &&
          list.length > 0 &&
          list.every(
            (item) => item && typeof item === "object" && !Array.isArray(item),
          ),
        key,
        "Expected a nonempty array of objects.",
      );
  }
  const supported = new Set(["KHR_materials_specular", "KHR_materials_ior", "KHR_materials_emissive_strength"]);
  for (const key of ["extensionsUsed", "extensionsRequired"] as const)
    if (json[key] !== undefined) {
      ctx.check(
        Array.isArray(json[key]) &&
          json[key]!.length > 0 &&
          json[key]!.every((s) => typeof s === "string" && s.length > 0) &&
          new Set(json[key]).size === json[key]!.length,
        key,
        "Expected extension names.",
      );
      const unknown = json[key]!.filter((name) => !supported.has(name));
      if (unknown.length)
        ctx.unsupported(
          key,
          `glTF extensions are not implemented: ${unknown.join(", ")}.`,
        );
    }
  const used = new Set(json.extensionsUsed ?? []);
  for (const name of json.extensionsRequired ?? [])
    ctx.check(used.has(name), "extensionsRequired", `${name} must also be declared in extensionsUsed.`);
  const encountered = new Set<string>();
  // Never silently lose optional extension semantics in the metadata.
  const checkExtensions = (value: unknown, location: string): void => {
    if (typeof value === "number")
      ctx.check(
        Number.isFinite(value),
        location,
        "JSON numbers must be finite.",
      );
    if (!value || typeof value !== "object") return;
    if (!Array.isArray(value) && "name" in value)
      ctx.check(
        typeof value.name === "string",
        location + "/name",
        "Object name must be a string.",
      );
    for (const [key, child] of Object.entries(value)) {
      if (key === "extras") continue;
      if (key === "extensions") {
        ctx.check(
          child && typeof child === "object" && !Array.isArray(child),
          location + "/extensions",
          "Expected extension object.",
        );
        for (const [name, payload] of Object.entries(child)) {
          const at = location + "/extensions/" + name;
          if (!supported.has(name) || !/^glTF\/materials\/(0|[1-9]\d*)$/.test(location))
            ctx.unsupported(at, `Extension payload ${name} is not supported at this location.`);
          ctx.check(used.has(name), at, `${name} must be declared in extensionsUsed.`);
          encountered.add(name);
          ctx.check(payload && typeof payload === "object" && !Array.isArray(payload), at, "Expected extension object.");
          for (const [field, fieldValue] of Object.entries(payload)) {
            if (name === "KHR_materials_specular" && (field === "specularTexture" || field === "specularColorTexture")) {
              checkExtensions(fieldValue, at + "/" + field);
              continue;
            }
            if (field === "extensions" || field === "extras") {
              checkExtensions({ [field]: fieldValue }, at);
              continue;
            }
            const allowed = name === "KHR_materials_specular"
              ? ["specularFactor", "specularColorFactor"]
              : name === "KHR_materials_ior" ? ["ior"] : ["emissiveStrength"];
            ctx.check(allowed.includes(field), at + "/" + field, "Unknown extension property.");
            const validNumber = (v: unknown, min: number, max: number) =>
              typeof v === "number" && Number.isFinite(v) && v >= min && v <= max;
            ctx.check(field === "specularColorFactor"
              ? Array.isArray(fieldValue) && fieldValue.length === 3 && fieldValue.every(v => validNumber(v, 0, 1))
              : validNumber(fieldValue, field === "ior" ? 1 : 0, field === "ior" || field === "emissiveStrength" ? Infinity : 1) &&
                (field !== "emissiveStrength" || Number.isFinite(Math.fround(fieldValue as number))),
              at + "/" + field, "Invalid extension factor or IOR.");
          }
        }
      } else checkExtensions(child, location + "/" + key);
    }
  };
  checkExtensions(json, "glTF");
  for (const name of used)
    ctx.check(encountered.has(name), "extensionsUsed", `${name} is declared but not used by a material.`);
  const buffers = json.buffers ?? [];
  for (let i = 0; i < buffers.length; i++)
    if (buffers[i].uri !== undefined)
      ctx.unsupported(
        `buffers/${i}/uri`,
        `External or URI buffer resource ${String(buffers[i].uri)} is not supported; embed it in the GLB BIN chunk.`,
      );
  ctx.check(
    buffers.length <= 1,
    "buffers",
    "GLB may have only one embedded buffer.",
  );
  if (buffers.length) {
    const size = ctx.integer(buffers[0].byteLength, "buffers/0/byteLength", 1);
    ctx.check(
      hasBin && size <= bin.length && bin.length - size <= 3,
      "buffers/0",
      "Missing BIN resource or buffer length differs from BIN length beyond padding.",
    );
    ctx.check(
      bin.subarray(size).every((b) => b === 0),
      "GLB/BIN",
      "BIN padding must be zero.",
    );
    bin = bin.subarray(0, size);
  } else ctx.check(!hasBin, "GLB/BIN", "BIN chunk has no buffer declaration.");
  for (const [i, view] of (json.bufferViews ?? []).entries()) {
    ctx.check(
      view.buffer === 0 && buffers.length === 1,
      `bufferViews/${i}/buffer`,
      "Buffer reference does not exist.",
    );
    const start = ctx.integer(
        view.byteOffset ?? 0,
        `bufferViews/${i}/byteOffset`,
      ),
      size = ctx.integer(view.byteLength, `bufferViews/${i}/byteLength`, 1);
    ctx.check(
      start + size <= bin.length,
      `bufferViews/${i}`,
      "Buffer view exceeds embedded buffer boundary.",
    );
    if (view.byteStride !== undefined) {
      ctx.integer(view.byteStride, `bufferViews/${i}/byteStride`, 4, 252);
      ctx.check(
        view.byteStride % 4 === 0,
        `bufferViews/${i}/byteStride`,
        "Vertex stride must be a multiple of four.",
      );
    }
    if (view.target !== undefined)
      ctx.check(
        [34962, 34963].includes(view.target),
        `bufferViews/${i}/target`,
        "Invalid buffer view target.",
      );
  }
  const sizes: Record<number, number> = {
    5120: 1,
    5121: 1,
    5122: 2,
    5123: 2,
    5125: 4,
    5126: 4,
  };
  const counts: Record<string, number> = {
    SCALAR: 1,
    VEC2: 2,
    VEC3: 3,
    VEC4: 4,
    MAT2: 4,
    MAT3: 9,
    MAT4: 16,
  };
  let inspectedValues = 0;
  const accessors = (json.accessors ?? []).map((a, i): AccessorData => {
    const at = `accessors/${i}`;
    ctx.integer(a.count, at + "/count", 1);
    ctx.check(
      sizes[a.componentType] && counts[a.type],
      at,
      "Invalid accessor componentType or type.",
    );
    const size = sizes[a.componentType],
      components = counts[a.type];
    if (a.type.startsWith("MAT") && size < 4)
      ctx.unsupported(
        at,
        "Matrix accessors with sub-32-bit components are not implemented.",
      );
    if (a.normalized !== undefined)
      ctx.check(
        typeof a.normalized === "boolean" &&
          (!a.normalized || [5120, 5121, 5122, 5123].includes(a.componentType)),
        at + "/normalized",
        "Invalid normalized accessor.",
      );
    const byteOffset = ctx.integer(a.byteOffset ?? 0, at + "/byteOffset");
    ctx.check(
      byteOffset % size === 0,
      at,
      "Accessor byte offset is misaligned.",
    );
    let source: Buffer | undefined,
      stride = size * components,
      start = 0;
    if (a.bufferView !== undefined) {
      const index = ctx.integer(
        a.bufferView,
        at + "/bufferView",
        0,
        (json.bufferViews?.length ?? 0) - 1,
      );
      const view = json.bufferViews![index];
      stride = view.byteStride ?? stride;
      ctx.check(
        stride >= size * components &&
          stride % size === 0 &&
          byteOffset + (a.count - 1) * stride + size * components <=
            view.byteLength,
        at,
        "Accessor range or stride exceeds buffer view boundary.",
      );
      start = (view.byteOffset ?? 0) + byteOffset;
      ctx.check(
        start % size === 0,
        at,
        "Accessor absolute byte offset is misaligned.",
      );
      source = bin;
    } else
      ctx.check(
        byteOffset === 0,
        at,
        "Accessor without buffer view cannot have byte offset.",
      );
    inspectedValues += a.count * components;
    if (inspectedValues > 16_000_000)
      ctx.unsupported(
        at,
        "Accessors exceed the 16 million scalar inspection limit.",
      );
    const replacements = new Map<number, number>();
    if (a.sparse !== undefined) {
      const sparse = a.sparse, sparseAt = at + "/sparse";
      ctx.check(sparse && typeof sparse === "object" && !Array.isArray(sparse), sparseAt, "Expected a sparse object.");
      const count = ctx.integer(sparse.count, sparseAt + "/count", 1, a.count);
      ctx.check(sparse.indices && typeof sparse.indices === "object" && !Array.isArray(sparse.indices), sparseAt + "/indices", "Expected sparse indices.");
      ctx.check(sparse.values && typeof sparse.values === "object" && !Array.isArray(sparse.values), sparseAt + "/values", "Expected sparse values.");
      const indexSize = sizes[sparse.indices.componentType];
      ctx.check([5121, 5123, 5125].includes(sparse.indices.componentType), sparseAt + "/indices/componentType", "Sparse indices must be unsigned byte, short, or int.");
      const sparseStart = (part: typeof sparse.indices | typeof sparse.values, label: string, alignment: number, length: number) => {
        const resource = sparseAt + "/" + label;
        const index = ctx.integer(part.bufferView, resource + "/bufferView", 0, (json.bufferViews?.length ?? 0) - 1);
        const view = json.bufferViews![index];
        const offset = ctx.integer(part.byteOffset ?? 0, resource + "/byteOffset");
        ctx.check(view.byteStride === undefined && view.target === undefined, resource + "/bufferView", "Sparse buffer views cannot have byteStride or target.");
        ctx.check(offset % alignment === 0 && ((view.byteOffset ?? 0) + offset) % alignment === 0, resource + "/byteOffset", "Sparse data is misaligned.");
        ctx.check(offset + length <= view.byteLength, resource, "Sparse data exceeds buffer view boundary.");
        return (view.byteOffset ?? 0) + offset;
      };
      const indexStart = sparseStart(sparse.indices, "indices", indexSize, count * indexSize);
      const valueStart = sparseStart(sparse.values, "values", size, count * components * size);
      let previous = -1;
      for (let n = 0; n < count; n++) {
        const p = indexStart + n * indexSize;
        const index = indexSize === 1 ? bin.readUInt8(p) : indexSize === 2 ? bin.readUInt16LE(p) : bin.readUInt32LE(p);
        ctx.check(index > previous && index < a.count, sparseAt + "/indices", "Sparse indices must be strictly increasing and within accessor count.");
        replacements.set(index, valueStart + n * components * size);
        previous = index;
      }
    }
    const values: number[] = [],
      min = Array(components).fill(Infinity) as number[],
      max = Array(components).fill(-Infinity) as number[];
    for (let element = 0; element < a.count; element++)
      for (let c = 0; c < components; c++) {
        const replacement = replacements.get(element);
        const p = replacement === undefined ? start + element * stride + c * size : replacement + c * size;
        let v = 0;
        if (source || replacement !== undefined)
          switch (a.componentType) {
            case 5120:
              v = bin.readInt8(p);
              break;
            case 5121:
              v = bin.readUInt8(p);
              break;
            case 5122:
              v = bin.readInt16LE(p);
              break;
            case 5123:
              v = bin.readUInt16LE(p);
              break;
            case 5125:
              v = bin.readUInt32LE(p);
              break;
            case 5126:
              v = bin.readFloatLE(p);
              break;
          }
        ctx.check(
          Number.isFinite(v),
          at,
          "Accessor contains a non-finite value.",
        );
        min[c] = Math.min(min[c], v);
        max[c] = Math.max(max[c], v);
        values.push(v);
      }
    for (const [key, actual] of [
      ["min", min],
      ["max", max],
    ] as const)
      if (a[key] !== undefined) {
        const declared = a[key]!;
        ctx.check(
          Array.isArray(declared) &&
            declared.length === components &&
            declared.every(
              (v, c) =>
                Number.isFinite(v) &&
                Math.abs(v - actual[c]) <=
                  Math.max(1, Math.abs(actual[c])) * 1e-6,
            ),
          at + "/" + key,
          "Declared accessor bounds do not match decoded values.",
        );
      }
    return { definition: a, values, components, min, max };
  });
  return { json, bin, accessors };
}
