import { NodeIO, type GLTF } from "@gltf-transform/core";
import { InspectionContext } from "./errors.ts";
import { KHRMaterialsEmissiveStrength, KHRMaterialsIOR, KHRMaterialsSpecular, KHRMaterialsUnlit, KHRTextureTransform } from "@gltf-transform/extensions";
import { parseGLB, type AccessorData } from "./glb.ts";
import { normalizeSparseGLB } from "./glb-sparse.ts";
import { inspectTexture } from "./texture.ts";

export async function inspectModel(
  data: Buffer,
  ctx: InspectionContext,
): Promise<Record<string, unknown>> {
  const { json, bin, accessors } = parseGLB(data, ctx);
  const ref = <T>(list: T[] | undefined, value: unknown, at: string): T => {
    const i = ctx.integer(value, at, 0, (list?.length ?? 0) - 1);
    return list![i];
  };
  const vector = (
    value: unknown,
    length: number,
    at: string,
    min = -Infinity,
    max = Infinity,
  ): number[] => {
    ctx.check(
      Array.isArray(value) &&
        value.length === length &&
        value.every(
          (v) =>
            typeof v === "number" && Number.isFinite(v) && v >= min && v <= max,
        ),
      at,
      `Expected ${length} finite components in [${min}, ${max}].`,
    );
    return value;
  };
  const scalar = (value: unknown, at: string, min = 0, max = 1): number => {
    ctx.check(
      typeof value === "number" &&
        Number.isFinite(value) &&
        value >= min &&
        value <= max,
      at,
      `Expected a number in [${min}, ${max}].`,
    );
    return value;
  };
  const accessor = (
    index: unknown,
    at: string,
    type?: string,
    componentTypes?: number[],
  ): AccessorData => {
    const a = ref(accessors, index, at);
    ctx.check(
      (!type || a.definition.type === type) &&
        (!componentTypes ||
          componentTypes.includes(a.definition.componentType)),
      at,
      "Accessor has incompatible type or componentType.",
    );
    return a;
  };
  if (json.cameras?.length)
    ctx.unsupported(
      "cameras",
      "Camera import is not implemented by this inspection subset.",
    );
  const images = (json.images ?? []).map((image, i) => {
    const at = `images/${i}`;
    if (image.uri !== undefined)
      ctx.unsupported(
        at + "/uri",
        `External or URI image resource ${String(image.uri)} is not supported; embed image bytes in a buffer view.`,
      );
    const view = ref(json.bufferViews, image.bufferView, at + "/bufferView");
    ctx.check(
      view.byteStride === undefined && view.target === undefined,
      at,
      "Image buffer view must not have vertex stride or target.",
    );
    if (!["image/png", "image/jpeg"].includes(image.mimeType ?? ""))
      ctx.unsupported(
        at + "/mimeType",
        `Embedded image MIME ${String(image.mimeType)} is not implemented; use image/png or image/jpeg.`,
      );
    const start = view.byteOffset ?? 0;
    const result = inspectTexture(
      bin.subarray(start, start + view.byteLength),
      new InspectionContext(`${ctx.file}#${at}`),
    );
    ctx.check(
      result.format === (image.mimeType === "image/png" ? "png" : "jpeg"),
      at + "/mimeType",
      "Declared image MIME does not match encoded bytes.",
    );
    return {
      index: i,
      name: image.name ?? "",
      bytes: view.byteLength,
      ...result,
    };
  });
  for (const [i, s] of (json.samplers ?? []).entries()) {
    if (s.magFilter !== undefined)
      ctx.check(
        [9728, 9729].includes(s.magFilter),
        `samplers/${i}/magFilter`,
        "Invalid magnification filter.",
      );
    if (s.minFilter !== undefined)
      ctx.check(
        [9728, 9729, 9984, 9985, 9986, 9987].includes(s.minFilter),
        `samplers/${i}/minFilter`,
        "Invalid minification filter.",
      );
    for (const key of ["wrapS", "wrapT"] as const)
      if (s[key] !== undefined)
        ctx.check(
          [33071, 33648, 10497].includes(s[key]!),
          `samplers/${i}/${key}`,
          "Invalid wrapping mode.",
        );
  }
  const textures = (json.textures ?? []).map((t, i) => {
    ref(images, t.source, `textures/${i}/source`);
    if (t.sampler !== undefined)
      ref(json.samplers, t.sampler, `textures/${i}/sampler`);
    return {
      index: i,
      name: t.name ?? "",
      image: t.source!,
      sampler: t.sampler ?? null,
    };
  });
  const textureInfo = (
    info: GLTF.ITextureInfo | undefined,
    at: string,
  ): number | null => {
    if (info === undefined) return null;
    ctx.check(
      info && typeof info === "object" && !Array.isArray(info),
      at,
      "Expected texture info object.",
    );
    ref(textures, info.index, at + "/index");
    ctx.integer(info.texCoord ?? 0, at + "/texCoord", 0, 1);
    return info.index;
  };
  const materials = (json.materials ?? []).map((m, i) => {
    const at = `materials/${i}`,
      p = m.pbrMetallicRoughness;
    const specular = m.extensions?.KHR_materials_specular as {
      specularTexture?: GLTF.ITextureInfo;
      specularColorTexture?: GLTF.ITextureInfo;
    } | undefined;
    if (p !== undefined)
      ctx.check(
        p && typeof p === "object" && !Array.isArray(p),
        at + "/pbrMetallicRoughness",
        "Expected a PBR object.",
      );
    const slots = {
      baseColor: textureInfo(p?.baseColorTexture, at + "/baseColorTexture"),
      metallicRoughness: textureInfo(
        p?.metallicRoughnessTexture,
        at + "/metallicRoughnessTexture",
      ),
      normal: textureInfo(m.normalTexture, at + "/normalTexture"),
      occlusion: textureInfo(m.occlusionTexture, at + "/occlusionTexture"),
      emissive: textureInfo(m.emissiveTexture, at + "/emissiveTexture"),
      specular: textureInfo(specular?.specularTexture, `${at}/extensions/KHR_materials_specular/specularTexture`),
      specularColor: textureInfo(specular?.specularColorTexture, `${at}/extensions/KHR_materials_specular/specularColorTexture`),
    };
    if (m.normalTexture?.scale !== undefined)
      scalar(
        m.normalTexture.scale,
        at + "/normalTexture/scale",
        -Infinity,
        Infinity,
      );
    if (m.occlusionTexture?.strength !== undefined)
      scalar(m.occlusionTexture.strength, at + "/occlusionTexture/strength");
    if (m.alphaMode !== undefined)
      ctx.check(
        ["OPAQUE", "MASK", "BLEND"].includes(m.alphaMode),
        at + "/alphaMode",
        "Invalid alpha mode.",
      );
    if (m.alphaCutoff !== undefined)
      scalar(m.alphaCutoff, at + "/alphaCutoff", 0, Infinity);
    if (m.doubleSided !== undefined)
      ctx.check(
        typeof m.doubleSided === "boolean",
        at + "/doubleSided",
        "Expected boolean.",
      );
    return {
      index: i,
      name: m.name ?? "",
      ...(m.extensions?.KHR_materials_unlit ? { unlit: true } : {}),
      ...(m.extensions?.KHR_materials_specular ? { specular: m.extensions.KHR_materials_specular } : {}),
      ...(m.extensions?.KHR_materials_ior ? { ior: m.extensions.KHR_materials_ior } : {}),
      ...(m.extensions?.KHR_materials_emissive_strength ? { emissiveStrength: m.extensions.KHR_materials_emissive_strength } : {}),
      pbr: {
        baseColorFactor: vector(
          p?.baseColorFactor ?? [1, 1, 1, 1],
          4,
          at + "/baseColorFactor",
          0,
          1,
        ),
        metallicFactor: scalar(p?.metallicFactor ?? 1, at + "/metallicFactor"),
        roughnessFactor: scalar(
          p?.roughnessFactor ?? 1,
          at + "/roughnessFactor",
        ),
      },
      emissiveFactor: vector(
        m.emissiveFactor ?? [0, 0, 0],
        3,
        at + "/emissiveFactor",
        0,
        1,
      ),
      textures: slots,
      alphaMode: m.alphaMode ?? "OPAQUE",
      doubleSided: m.doubleSided ?? false,
    };
  });
  let vertexCount = 0,
    primitiveCount = 0,
    triangleCount = 0;
  const meshes = (json.meshes ?? []).map((mesh, i) => {
    const at = `meshes/${i}`;
    ctx.check(
      Array.isArray(mesh.primitives) && mesh.primitives.length > 0,
      at + "/primitives",
      "Mesh requires primitives.",
    );
    const primitives = mesh.primitives.map((p, k) => {
      const loc = `${at}/primitives/${k}`;
      ctx.check(
        p &&
          typeof p === "object" &&
          p.attributes &&
          typeof p.attributes === "object" &&
          !Array.isArray(p.attributes),
        loc,
        "Invalid primitive or attributes.",
      );
      const position = accessor(
        p.attributes.POSITION,
        loc + "/POSITION",
        "VEC3",
        [5126],
      );
      ctx.check(
        !position.definition.normalized &&
          position.definition.min &&
          position.definition.max,
        loc + "/POSITION",
        "POSITION requires non-normalized floats and verified min/max bounds.",
      );
      const count = position.definition.count;
      for (const [semantic, index] of Object.entries(p.attributes)) {
        const a = accessor(index, loc + "/" + semantic);
        ctx.check(
          a.definition.count === count,
          loc + "/" + semantic,
          "Vertex attributes have different element counts.",
        );
        const rules: Record<string, [string, number[]]> = {
          NORMAL: ["VEC3", [5126]],
          TANGENT: ["VEC4", [5126]],
          JOINTS_0: ["VEC4", [5121, 5123]],
          WEIGHTS_0: ["VEC4", [5126, 5121, 5123]],
        };
        if (rules[semantic]) {
          accessor(index, loc + "/" + semantic, ...rules[semantic]);
          ctx.check(
            semantic === "WEIGHTS_0"
              ? a.definition.componentType === 5126
                ? !a.definition.normalized
                : a.definition.normalized === true
              : !a.definition.normalized,
            loc + "/" + semantic,
            "Invalid attribute normalization.",
          );
        } else if (/^TEXCOORD_\d+$/.test(semantic)) {
          accessor(index, loc + "/" + semantic, "VEC2", [5126, 5121, 5123]);
          ctx.check(
            a.definition.componentType === 5126
              ? !a.definition.normalized
              : a.definition.normalized === true,
            loc + "/" + semantic,
            "Integer texture coordinates must be normalized.",
          );
        } else if (/^COLOR_\d+$/.test(semantic)) {
          ctx.check(
            ["VEC3", "VEC4"].includes(a.definition.type) &&
              [5126, 5121, 5123].includes(a.definition.componentType) &&
              (a.definition.componentType === 5126
                ? !a.definition.normalized
                : a.definition.normalized === true),
            loc + "/" + semantic,
            "Invalid color attribute.",
          );
        } else if (semantic !== "POSITION" && !semantic.startsWith("_"))
          ctx.unsupported(
            loc + "/" + semantic,
            "Vertex semantic is outside the implemented subset (only joint/weight set 0 is supported).",
          );
        if (semantic === "NORMAL" || semantic === "TANGENT") {
          for (let v = 0; v < a.definition.count; v++) {
            const start = v * a.components;
            ctx.check(
              Math.abs(
                a.values
                  .slice(start, start + 3)
                  .reduce((sum, n) => sum + n * n, 0) - 1,
              ) <= 0.01,
              loc + "/" + semantic,
              "Normal/tangent vectors must have unit length.",
            );
            if (semantic === "TANGENT")
              ctx.check(
                Math.abs(a.values[start + 3]) === 1,
                loc + "/TANGENT",
                "Tangent handedness must be +1 or -1.",
              );
          }
        }
        if (/^COLOR_/.test(semantic) && a.definition.componentType === 5126)
          ctx.check(
            a.values.every((v) => v >= 0 && v <= 1),
            loc + "/" + semantic,
            "Vertex colors must be in [0,1].",
          );
        const view =
          a.definition.bufferView === undefined
            ? undefined
            : json.bufferViews![a.definition.bufferView];
        if (view?.target !== undefined)
          ctx.check(
            view.target === 34962,
            loc + "/" + semantic,
            "Vertex attribute buffer view must target ARRAY_BUFFER.",
          );
        if (view)
          ctx.check(
            ((view.byteOffset ?? 0) + (a.definition.byteOffset ?? 0)) % 4 ===
              0 &&
              (view.byteStride ??
                a.components *
                  (
                    {
                      5120: 1,
                      5121: 1,
                      5122: 2,
                      5123: 2,
                      5125: 4,
                      5126: 4,
                    } as Record<number, number>
                  )[a.definition.componentType]) %
                4 ===
                0,
            loc + "/" + semantic,
            "Vertex attribute offset and stride must be four-byte aligned.",
          );
      }
      ctx.check(
        (p.attributes.JOINTS_0 === undefined) ===
          (p.attributes.WEIGHTS_0 === undefined),
        loc,
        "JOINTS_0 and WEIGHTS_0 must occur together.",
      );
      let elementCount = count;
      if (p.indices !== undefined) {
        const indices = accessor(
          p.indices,
          loc + "/indices",
          "SCALAR",
          [5121, 5123, 5125],
        );
        ctx.check(
          !indices.definition.normalized &&
            indices.values.every(
              (v) =>
                v < count &&
                v !==
                  (
                    { 5121: 255, 5123: 65535, 5125: 4294967295 } as Record<
                      number,
                      number
                    >
                  )[indices.definition.componentType],
            ),
          loc + "/indices",
          "Index exceeds vertex count or uses forbidden primitive restart value.",
        );
        if (indices.definition.bufferView !== undefined) {
          const view = json.bufferViews![indices.definition.bufferView];
          ctx.check(
            view.byteStride === undefined &&
              (view.target === undefined || view.target === 34963),
            loc + "/indices",
            "Index buffer view must not have stride and must target ELEMENT_ARRAY_BUFFER if target is specified.",
          );
        }
        elementCount = indices.definition.count;
      }
      const mode = ctx.integer(p.mode ?? 4, loc + "/mode", 0, 6);
      ctx.check(
        mode !== 4 || elementCount % 3 === 0,
        loc,
        "Triangle list element count must be divisible by three.",
      );
      ctx.check(
        mode !== 1 || elementCount % 2 === 0,
        loc,
        "Line list element count must be divisible by two.",
      );
      ctx.check(
        ![2, 3].includes(mode) || elementCount >= 2,
        loc,
        "Line loop/strip requires at least two elements.",
      );
      ctx.check(
        ![5, 6].includes(mode) || elementCount >= 3,
        loc,
        "Triangle strip/fan requires at least three elements.",
      );
      const triangles =
        mode === 4
          ? elementCount / 3
          : [5, 6].includes(mode)
            ? elementCount - 2
            : 0;
      if (p.material !== undefined) {
        ref(materials, p.material, loc + "/material");
        const m = json.materials![p.material];
        const specular = m.extensions?.KHR_materials_specular as {
          specularTexture?: GLTF.ITextureInfo;
          specularColorTexture?: GLTF.ITextureInfo;
        } | undefined;
        const activeTextures = m.extensions?.KHR_materials_unlit
          ? [m.pbrMetallicRoughness?.baseColorTexture]
          : [
              m.pbrMetallicRoughness?.baseColorTexture,
              m.pbrMetallicRoughness?.metallicRoughnessTexture,
              m.normalTexture,
              m.occlusionTexture,
              m.emissiveTexture,
              specular?.specularTexture,
              specular?.specularColorTexture,
            ];
        for (const info of activeTextures)
          if (info)
            ctx.check(
              p.attributes[`TEXCOORD_${(info.extensions?.KHR_texture_transform as { texCoord?: number } | undefined)?.texCoord ?? info.texCoord ?? 0}`] !== undefined,
              loc + "/material",
              "Textured material references a missing texture coordinate set.",
            );
      }
      if (p.targets !== undefined) {
        ctx.check(
          Array.isArray(p.targets) && p.targets.length > 0,
          loc + "/targets",
          "Expected morph targets.",
        );
        for (const [t, target] of p.targets.entries()) {
          ctx.check(
            target &&
              typeof target === "object" &&
              Object.keys(target).length > 0,
            loc + `/targets/${t}`,
            "Empty morph target.",
          );
          for (const [semantic, index] of Object.entries(target)) {
            ctx.check(
              ["POSITION", "NORMAL", "TANGENT"].includes(semantic),
              loc + `/targets/${t}`,
              "Invalid morph target semantic.",
            );
            const a = accessor(
              index,
              loc + `/targets/${t}/${semantic}`,
              "VEC3",
              [5126],
            );
            ctx.check(
              !a.definition.normalized &&
                a.definition.count === count &&
                p.attributes[semantic] !== undefined,
              loc + `/targets/${t}`,
              "Morph target count/type or base attribute is invalid.",
            );
          }
        }
      }
      vertexCount += count;
      primitiveCount++;
      triangleCount += triangles;
      return {
        vertexCount: count,
        elementCount,
        triangleCount: triangles,
        mode,
        material: p.material ?? null,
        morphTargetCount: p.targets?.length ?? 0,
        bounds: { min: position.min, max: position.max },
      };
    });
    ctx.check(
      primitives.every(
        (p) => p.morphTargetCount === primitives[0].morphTargetCount,
      ),
      at,
      "All mesh primitives must have the same number of morph targets.",
    );
    if (mesh.weights !== undefined) {
      ctx.check(
        primitives[0].morphTargetCount > 0,
        at + "/weights",
        "Mesh weights require morph targets.",
      );
      vector(mesh.weights, primitives[0].morphTargetCount, at + "/weights");
    }
    return {
      index: i,
      name: mesh.name ?? "",
      primitives,
      morphTargetCount: primitives[0].morphTargetCount,
    };
  });
  const parents = new Map<number, number>();
  for (const [i, n] of (json.nodes ?? []).entries()) {
    const at = `nodes/${i}`;
    if (n.mesh !== undefined) ref(meshes, n.mesh, at + "/mesh");
    if (n.camera !== undefined)
      ctx.unsupported(
        at + "/camera",
        "Camera nodes are outside the implemented subset.",
      );
    ctx.check(
      n.matrix === undefined ||
        (n.translation === undefined &&
          n.rotation === undefined &&
          n.scale === undefined),
      at,
      "Node cannot combine matrix with TRS transforms.",
    );
    if (n.matrix !== undefined) {
      const m = vector(n.matrix, 16, at + "/matrix");
      ctx.check(
        m[3] === 0 && m[7] === 0 && m[11] === 0 && m[15] === 1,
        at + "/matrix",
        "Node transform must be affine.",
      );
      for (const [a, b] of [
        [0, 4],
        [0, 8],
        [4, 8],
      ]) {
        const lengthA = Math.hypot(...m.slice(a, a + 3)),
          lengthB = Math.hypot(...m.slice(b, b + 3));
        if (lengthA && lengthB)
          ctx.check(
            Math.abs(
              (m[a] * m[b] + m[a + 1] * m[b + 1] + m[a + 2] * m[b + 2]) /
                lengthA /
                lengthB,
            ) <= 1e-5,
            at + "/matrix",
            "Node matrix contains shear and cannot be decomposed to TRS.",
          );
      }
    }
    if (n.translation !== undefined)
      vector(n.translation, 3, at + "/translation");
    if (n.scale !== undefined) vector(n.scale, 3, at + "/scale");
    if (n.rotation !== undefined) {
      const q = vector(n.rotation, 4, at + "/rotation", -1, 1);
      ctx.check(
        Math.abs(q.reduce((s, v) => s + v * v, 0) - 1) < 1e-4,
        at + "/rotation",
        "Node quaternion is not normalized.",
      );
    }
    if (n.weights !== undefined) {
      const mesh = ref(meshes, n.mesh, at + "/mesh");
      ctx.check(
        mesh.morphTargetCount > 0,
        at + "/weights",
        "Node weights require morph targets.",
      );
      vector(n.weights, mesh.morphTargetCount, at + "/weights");
    }
    if (n.children !== undefined) {
      ctx.check(
        Array.isArray(n.children) && n.children.length > 0,
        at + "/children",
        "Expected nonempty child node references.",
      );
      for (const child of n.children) {
        ref(json.nodes, child, at + "/children");
        ctx.check(
          child !== i && !parents.has(child),
          at + "/children",
          "Node has itself or a duplicate/multiple parent.",
        );
        parents.set(child, i);
      }
    }
  }
  // Iterative parent walk avoids stack overflow on cyclic or very deep graphs.
  const visited = new Set<number>();
  for (let i = 0; i < (json.nodes?.length ?? 0); i++) {
    const chain = new Set<number>();
    let node: number | undefined = i;
    while (node !== undefined && !visited.has(node)) {
      ctx.check(
        !chain.has(node),
        `nodes/${i}`,
        "Node hierarchy contains a cycle.",
      );
      chain.add(node);
      node = parents.get(node);
    }
    for (const v of chain) visited.add(v);
  }
  const skins = (json.skins ?? []).map((s, i) => {
    const at = `skins/${i}`;
    ctx.check(
      Array.isArray(s.joints) &&
        s.joints.length > 0 &&
        new Set(s.joints).size === s.joints.length,
      at + "/joints",
      "Skin requires unique joint references.",
    );
    for (const j of s.joints) ref(json.nodes, j, at + "/joints");
    const rootOf = (j: number): number => {
      while (parents.has(j)) j = parents.get(j)!;
      return j;
    };
    ctx.check(
      s.joints.every((j) => rootOf(j) === rootOf(s.joints[0])),
      at,
      "Skin joints do not share a common root.",
    );
    if (s.skeleton !== undefined) {
      ref(json.nodes, s.skeleton, at + "/skeleton");
      ctx.check(
        s.joints.every((j) => {
          while (j !== s.skeleton && parents.has(j)) j = parents.get(j)!;
          return j === s.skeleton;
        }),
        at + "/skeleton",
        "Skeleton root is not an ancestor of all joints.",
      );
    }
    if (s.inverseBindMatrices !== undefined) {
      const a = accessor(
        s.inverseBindMatrices,
        at + "/inverseBindMatrices",
        "MAT4",
        [5126],
      );
      ctx.check(
        !a.definition.normalized && a.definition.count === s.joints.length,
        at + "/inverseBindMatrices",
        "Inverse bind matrix count does not match joint count.",
      );
    }
    return {
      index: i,
      name: s.name ?? "",
      jointCount: s.joints.length,
      joints: [...s.joints],
      skeleton: s.skeleton ?? null,
      inverseBindMatrices: s.inverseBindMatrices ?? null,
    };
  });
  for (const [i, n] of (json.nodes ?? []).entries())
    if (n.skin !== undefined) {
      const at = `nodes/${i}/skin`,
        skin = ref(skins, n.skin, at);
      const mesh = ref(json.meshes, n.mesh, `nodes/${i}/mesh`);
      for (const [k, p] of mesh.primitives.entries()) {
        const joints = accessor(
          p.attributes.JOINTS_0,
          at + `/primitives/${k}/JOINTS_0`,
        );
        const weights = accessor(
          p.attributes.WEIGHTS_0,
          at + `/primitives/${k}/WEIGHTS_0`,
        );
        ctx.check(
          joints.values.every((j) => j < skin.jointCount),
          at,
          "Vertex references a joint outside the skin.",
        );
        const denominator =
          weights.definition.componentType === 5121
            ? 255
            : weights.definition.componentType === 5123
              ? 65535
              : 1;
        for (let v = 0; v < weights.definition.count; v++) {
          let sum = 0;
          for (let c = 0; c < 4; c++) {
            const w = weights.values[v * 4 + c] / denominator;
            ctx.check(w >= 0 && w <= 1, at, "Skin weights must be in [0,1].");
            sum += w;
          }
          ctx.check(
            Math.abs(sum - 1) <= 0.01,
            at,
            "Skin vertex weights do not sum to one.",
          );
        }
      }
    }
  for (const [i, s] of (json.scenes ?? []).entries())
    if (s.nodes !== undefined) {
      ctx.check(
        Array.isArray(s.nodes) &&
          s.nodes.length > 0 &&
          new Set(s.nodes).size === s.nodes.length,
        `scenes/${i}/nodes`,
        "Scene roots must be unique node references.",
      );
      for (const n of s.nodes) {
        ref(json.nodes, n, `scenes/${i}/nodes`);
        ctx.check(
          !parents.has(n),
          `scenes/${i}/nodes`,
          "Scene root node has a parent.",
        );
      }
    }
  if (json.scene !== undefined) ref(json.scenes, json.scene, "scene");
  const animations = (json.animations ?? []).map((a, i) => {
    const at = `animations/${i}`;
    ctx.check(
      Array.isArray(a.samplers) &&
        a.samplers.length > 0 &&
        Array.isArray(a.channels) &&
        a.channels.length > 0,
      at,
      "Animation requires samplers and channels.",
    );
    const samplers = a.samplers.map((s, k) => {
      ctx.check(
        s && typeof s === "object",
        at + `/samplers/${k}`,
        "Invalid animation sampler.",
      );
      const input = accessor(s.input, at + `/samplers/${k}/input`, "SCALAR", [
        5126,
      ]);
      ctx.check(
        !input.definition.normalized &&
          input.definition.min &&
          input.definition.max &&
          input.values.every(
            (v, j) => v >= 0 && (j === 0 || v > input.values[j - 1]),
          ),
        at + `/samplers/${k}/input`,
        "Animation times must be nonnegative, strictly increasing floats with verified bounds.",
      );
      const output = accessor(
        s.output,
        at + `/samplers/${k}/output`,
        undefined,
        [5126],
      );
      const interpolation = s.interpolation ?? "LINEAR";
      ctx.check(
        ["LINEAR", "STEP", "CUBICSPLINE"].includes(interpolation),
        at + `/samplers/${k}/interpolation`,
        "Unknown animation interpolation.",
      );
      ctx.check(
        !output.definition.normalized,
        at + `/samplers/${k}/output`,
        "Animation outputs must not be normalized.",
      );
      return { input, output, interpolation };
    });
    const targets = new Set<string>();
    let start = Infinity,
      end = -Infinity;
    const channels = a.channels.map((c, k) => {
      const loc = at + `/channels/${k}`;
      ctx.check(
        c && typeof c === "object" && c.target && typeof c.target === "object",
        loc,
        "Invalid animation channel target.",
      );
      const node = ref(json.nodes, c.target.node, loc + "/target/node");
      const s = ref(samplers, c.sampler, loc + "/sampler"),
        path = c.target.path;
      ctx.check(
        ["translation", "rotation", "scale", "weights"].includes(path),
        loc + "/target/path",
        "Unknown animation target path.",
      );
      const target = `${c.target.node}/${path}`;
      ctx.check(
        !targets.has(target),
        loc,
        "Duplicate animation channel for the same node/path.",
      );
      targets.add(target);
      ctx.check(
        node.matrix === undefined,
        loc,
        "Animation target node must use TRS, not matrix.",
      );
      let targetCount = 1;
      if (path === "weights") {
        const mesh = ref(meshes, node.mesh, loc + "/target/mesh");
        targetCount = mesh.morphTargetCount;
        ctx.check(
          targetCount > 0,
          loc,
          "Weights animation requires morph targets.",
        );
      }
      const type =
        path === "weights" ? "SCALAR" : path === "rotation" ? "VEC4" : "VEC3";
      ctx.check(
        s.output.definition.type === type &&
          s.output.definition.componentType === 5126 &&
          s.output.definition.count ===
            s.input.definition.count *
              targetCount *
              (s.interpolation === "CUBICSPLINE" ? 3 : 1),
        loc + "/output",
        "Animation output type/count does not match input, target and interpolation.",
      );
      if (path === "rotation") {
        const step = s.interpolation === "CUBICSPLINE" ? 12 : 4,
          first = s.interpolation === "CUBICSPLINE" ? 4 : 0;
        for (let p = first; p < s.output.values.length; p += step)
          ctx.check(
            Math.abs(
              s.output.values
                .slice(p, p + 4)
                .reduce((sum, v) => sum + v * v, 0) - 1,
            ) < 1e-3,
            loc + "/rotation",
            "Animation rotation quaternion is not normalized.",
          );
      }
      start = Math.min(start, s.input.values[0]);
      end = Math.max(end, s.input.values.at(-1)!);
      return {
        node: c.target.node!,
        path,
        sampler: c.sampler,
        interpolation: s.interpolation,
        keyframeCount: s.input.definition.count,
      };
    });
    return {
      index: i,
      name: a.name || `animation_${i}`,
      channelCount: channels.length,
      samplerCount: samplers.length,
      keyframeCount: samplers.reduce((n, s) => n + s.input.definition.count, 0),
      start,
      end,
      duration: end - start,
      channels,
    };
  });
  // The mature reader is used only after resource and semantic validation; no URI is read.
  const document = await new NodeIO()
    .registerExtensions([KHRMaterialsEmissiveStrength, KHRMaterialsIOR, KHRMaterialsSpecular, KHRMaterialsUnlit, KHRTextureTransform])
    .setStrictResources(true).readBinary(normalizeSparseGLB(data));
  const sceneIndex = json.scene ?? (json.scenes?.length ? 0 : null);
  let bounds: { min: number[]; max: number[] } | null = null;
  if (sceneIndex !== null) {
    const stack = [
      ...document.getRoot().listScenes()[sceneIndex].listChildren(),
    ];
    while (stack.length) {
      const node = stack.pop()!;
      stack.push(...node.listChildren());
      const m = node.getWorldMatrix();
      for (const primitive of node.getMesh()?.listPrimitives() ?? []) {
        const position = primitive.getAttribute("POSITION")!;
        const v: number[] = [];
        for (let i = 0; i < position.getCount(); i++) {
          position.getElement(i, v);
          const point = [
            m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + m[12],
            m[1] * v[0] + m[5] * v[1] + m[9] * v[2] + m[13],
            m[2] * v[0] + m[6] * v[1] + m[10] * v[2] + m[14],
          ];
          ctx.check(
            point.every(Number.isFinite),
            "bounds",
            "World transform produces non-finite geometry bounds.",
          );
          if (!bounds) bounds = { min: [...point], max: [...point] };
          else
            for (let c = 0; c < 3; c++) {
              bounds.min[c] = Math.min(bounds.min[c], point[c]);
              bounds.max[c] = Math.max(bounds.max[c], point[c]);
            }
        }
      }
    }
  }
  return {
    format: "glb",
    version: "2.0",
    meshCount: meshes.length,
    primitiveCount,
    vertexCount,
    triangleCount,
    nodeCount: json.nodes?.length ?? 0,
    sceneCount: json.scenes?.length ?? 0,
    materialCount: materials.length,
    textureCount: textures.length,
    imageCount: images.length,
    skinCount: skins.length,
    jointCount: skins.reduce((n, s) => n + s.jointCount, 0),
    animationCount: animations.length,
    meshes,
    materials,
    textures,
    images,
    skins,
    animations,
    bounds,
    boundsScene: sceneIndex,
    boundsSpace: "world-static-default-pose",
    bufferBytes: bin.length,
  };
}
