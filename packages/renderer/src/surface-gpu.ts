import * as THREE from "three";
import { hasCapturedGeometry } from "./surface.ts";
import type {
  SurfaceScene,
  SurfaceTriangle,
  SurfaceTexture,
} from "./surface.ts";

/** Private storage-buffer ABI, all fields occupy vec4-aligned float32 slots. */
export const SURFACE_GPU_ABI = 1;
export const SURFACE_TRIANGLE_FLOATS = 72;
export const SURFACE_MATERIAL_FLOATS = 32;
export const SURFACE_TEXTURE_FLOATS = 24;
type GeometryCache = WeakMap<SurfaceTriangle, { key: string; data: Float32Array }>;
/** Cached only for deeply frozen extractor-owned triangles; raw inputs are still checked. */
export function createSurfaceGeometryPacker() {
  const cache: GeometryCache = new WeakMap();
  return (snapshot: SurfaceScene, ordered: readonly SurfaceTriangle[], ids: ReadonlyMap<string, number>, windings: ReadonlyMap<string, 1 | -1>) =>
    packSurfaceGeometry(snapshot, ordered, ids, windings, cache);
}
const fail = (code: string, message: string): never => {
  throw new Error(code + ": " + message);
};
function finite(value: number, label: string) {
  if (!Number.isFinite(value) || !Number.isFinite(Math.fround(value)))
    fail("TC_SURFACE_GPU_NUMBER", label + " is not representable as float32.");
  return value;
}
function indexMap(values: readonly { uuid: string }[]) {
  const result = new Map<string, number>();
  values.forEach((value, index) => {
    if (result.has(value.uuid))
      fail("TC_SURFACE_GPU_ID", "Duplicate content identity " + value.uuid);
    result.set(value.uuid, index);
  });
  return result;
}
function reference(map: Map<string, number>, id: string | undefined) {
  if (id === undefined) return -1;
  const index = map.get(id);
  if (index === undefined)
    fail("TC_SURFACE_GPU_REFERENCE", "Missing content " + id);
  return index!;
}

export function validateSurfaceTextureCoordinates(
  snapshot: SurfaceScene,
  ordered: readonly SurfaceTriangle[] = snapshot.triangles,
): void {
  const materials = indexMap(snapshot.materials),
    textures = new Map(snapshot.textures.map((texture) => [texture.uuid, texture]));
  const channels = snapshot.materials.map(material => {
    const result = new Set<number>();
    for (const textureId of Object.values(material.maps)) {
      const texture = textures.get(textureId!);
      if (!texture) fail("TC_SURFACE_GPU_REFERENCE", "Missing material texture " + textureId);
      result.add(texture!.channel);
    }
    return [...result];
  });
  for (const triangle of ordered) {
    const required = channels[reference(materials, triangle.materialUuid)];
    for (const channel of required) {
      for (const vertex of triangle.vertices)
        if ((channel === 0 ? vertex.uv0 : vertex.uv1) === undefined)
          fail("TC_SURFACE_GPU_UV", `Triangle ${triangle.objectUuid} is missing texture channel ${channel}.`);
    }
  }
}

export function packSurfaceGeometry(
  snapshot: SurfaceScene,
  ordered: readonly SurfaceTriangle[] = snapshot.triangles,
  volumeIds: ReadonlyMap<string, number> = new Map(),
  volumeWindings: ReadonlyMap<string, 1 | -1> = new Map(),
  cache?: GeometryCache,
) {
  validateSurfaceTextureCoordinates(snapshot, ordered);
  const materials = indexMap(snapshot.materials);
  const output = new Float32Array(ordered.length * SURFACE_TRIANGLE_FLOATS);
  for (let index = 0; index < ordered.length; index++) {
    const triangle = ordered[index],
      materialIndex = reference(materials, triangle.materialUuid),
      offset = index * SURFACE_TRIANGLE_FLOATS;
    const material = snapshot.materials[materialIndex];
    const volumeKey = volumeIds.size || volumeWindings.size ? JSON.stringify([triangle.objectUuid, triangle.instanceId]) : "";
    const volumeId = volumeIds.get(volumeKey) ?? 0;
    const cacheKey = `${materialIndex}:${material.vertexColors}:${volumeId}:${volumeWindings.get(volumeKey) ?? 0}`;
    const cached = cache?.get(triangle);
    if (cached?.key === cacheKey) { output.set(cached.data, offset); continue; }
    const color = triangle.instanceColor ?? [1, 1, 1],
      tangent = triangle.vertices.every(
        (vertex) => vertex.tangent !== undefined,
      );
    for (let vertex = 0; vertex < 3; vertex++) {
      const data = triangle.vertices[vertex],
        positionW = vertex === 0 ? materialIndex : color[vertex - 1],
        normalW =
          vertex === 0
            ? color[2]
            : vertex === 1
              ? material.vertexColors
                ? 1
                : 0
              : tangent
                ? 1
                : 0;
      output.set([...data.position, positionW], offset + vertex * 4);
      output.set([...data.normal, normalW], offset + 12 + vertex * 4);
      output.set(
        [...(data.uv0 ?? [0, 0]), ...(data.uv1 ?? [0, 0])],
        offset + 24 + vertex * 4,
      );
      output.set(data.color ?? [1, 1, 1, 1], offset + 36 + vertex * 4);
      output.set(data.tangent ?? [0, 0, 0, 0], offset + 48 + vertex * 4);
    }
    for (let column = 0; column < 3; column++)
      output.set(
        [...triangle.normalMatrix.slice(column * 3, column * 3 + 3), 0],
        offset + 60 + column * 4,
      );
    const m = triangle.normalMatrix;
    const scales = [0, 3, 6].map((index) =>
      Math.hypot(m[index], m[index + 1], m[index + 2]),
    );
    const normalized = m.map(
      (value, index) => value / scales[Math.floor(index / 3)],
    );
    const determinant =
      normalized[0] *
        (normalized[4] * normalized[8] - normalized[5] * normalized[7]) -
      normalized[3] *
        (normalized[1] * normalized[8] - normalized[2] * normalized[7]) +
      normalized[6] *
        (normalized[1] * normalized[5] - normalized[2] * normalized[4]);
    if (!Number.isFinite(determinant) || determinant === 0)
      fail("TC_SURFACE_GPU_NORMAL_MATRIX", "Singular normal matrix.");
    // Physical shells can have either authored winding, even through a mirror.
    // Non-volume triangles keep their original transform-facing convention.
    output[offset + 63] = volumeId ? (volumeWindings.get(volumeKey) ?? (determinant > 0 ? 1 : -1)) : (determinant > 0 ? 1 : -1);
    output[offset + 67] = volumeId;
    output[offset + 71] = (triangle.castShadow === false ? 0 : 1) +
      (triangle.receiveShadow === false ? 0 : 2);
    const packed = output.subarray(offset, offset + SURFACE_TRIANGLE_FLOATS);
    for (const value of packed) finite(value, "Triangle data");
    // Do not trust shallow freezes: nested mutable positions must invalidate.
    if (cache && hasCapturedGeometry(snapshot))
      cache.set(triangle, { key: cacheKey, data: packed.slice() });
  }
  return output;
}
export interface PackedSurfaceResources {
  abi: 1;
  materials: Float32Array;
  textures: Float32Array;
  texels: Uint32Array;
  materialIds: string[];
  textureIds: string[];
  limitations: string[];
}
export function packSurfaceResources(
  snapshot: SurfaceScene,
): PackedSurfaceResources {
  const materialIds = indexMap(snapshot.materials),
    textureIds = indexMap(snapshot.textures),
    materials = new Float32Array(
      snapshot.materials.length * SURFACE_MATERIAL_FLOATS,
    ),
    textures = new Float32Array(
      snapshot.textures.length * SURFACE_TEXTURE_FLOATS,
    );
  let texelWords = 0;
  for (const texture of snapshot.textures) {
    if (
      !texture.pixels ||
      texture.pixels.length !== texture.width * texture.height * 4
    )
      fail(
        "TC_SURFACE_GPU_PIXELS",
        "Missing decoded pixels for " + texture.uuid,
      );
    if (
      !Number.isSafeInteger(texture.width) ||
      !Number.isSafeInteger(texture.height) ||
      texture.width < 1 ||
      texture.height < 1
    )
      fail("TC_SURFACE_GPU_TEXTURE", "Invalid dimensions for " + texture.uuid);
    texelWords +=
      texture.width *
      texture.height *
      (texture.pixelEncoding === "float32" ? 4 : 1);
  }
  if (!Number.isSafeInteger(texelWords) || texelWords > 0x3fffffff)
    fail(
      "TC_SURFACE_GPU_TEXTURE",
      "Texture storage exceeds addressable buffer layout.",
    );
  const texels = new Uint32Array(texelWords),
    floatBits = new Float32Array(texels.buffer),
    textureWords = new Uint32Array(textures.buffer);
  let word = 0;
  snapshot.textures.forEach((texture, index) => {
    const float = texture.pixelEncoding === "float32",
      srgb = texture.colorSpace === THREE.SRGBColorSpace;
    if (
      ![
        THREE.SRGBColorSpace,
        THREE.LinearSRGBColorSpace,
        THREE.NoColorSpace,
      ].includes(texture.colorSpace as never)
    )
      fail(
        "TC_SURFACE_GPU_COLOR_SPACE",
        "Unsupported color space " + texture.colorSpace,
      );
    const wrap = (mode: number) =>
      mode === THREE.RepeatWrapping
        ? 1
        : mode === THREE.MirroredRepeatWrapping
          ? 2
          : mode === THREE.ClampToEdgeWrapping
            ? 0
            : fail("TC_SURFACE_GPU_WRAP", "Unsupported wrapping " + mode);
    const nearest = [
        THREE.NearestFilter,
        THREE.NearestMipmapNearestFilter,
        THREE.NearestMipmapLinearFilter,
      ].includes(texture.magFilter as never),
      linear = [
        THREE.LinearFilter,
        THREE.LinearMipmapNearestFilter,
        THREE.LinearMipmapLinearFilter,
      ].includes(texture.magFilter as never);
    if (!nearest && !linear)
      fail(
        "TC_SURFACE_GPU_FILTER",
        "Unsupported magnification filter " + texture.magFilter,
      );
    const offset = index * SURFACE_TEXTURE_FLOATS,
      m = texture.matrix;
    // SurfaceTexture.pixels already uses uploaded texture row order. Never flip twice.
    textures.set(
      [
        word,
        texture.width,
        texture.height,
        texture.channel,
        wrap(texture.wrapS),
        wrap(texture.wrapT),
        linear ? 1 : 0,
        (float ? 1 : 0) | (srgb ? 2 : 0),
        m[0],
        m[1],
        m[2],
        0,
        m[3],
        m[4],
        m[5],
        0,
        m[6],
        m[7],
        m[8],
        0,
        texture.minFilter,
        texture.anisotropy,
        texture.generateMipmaps ? 1 : 0,
        0,
      ],
      offset,
    );
    textureWords.set(
      [
        word,
        texture.width,
        texture.height,
        texture.channel,
        wrap(texture.wrapS),
        wrap(texture.wrapT),
        linear ? 1 : 0,
        (float ? 1 : 0) | (srgb ? 2 : 0),
      ],
      offset,
    );
    for (let pixel = 0; pixel < texture.width * texture.height; pixel++) {
      if (float) {
        for (let channel = 0; channel < 4; channel++)
          floatBits[word++] = finite(
            texture.pixels![pixel * 4 + channel],
            "Float texture sample",
          );
      } else {
        let value = 0;
        for (let channel = 0; channel < 4; channel++) {
          const normalized = finite(
            texture.pixels![pixel * 4 + channel],
            "UNORM texture sample",
          );
          if (normalized < 0 || normalized > 1)
            fail("TC_SURFACE_GPU_UNORM", "UNORM texture sample outside [0,1].");
          value |= Math.round(normalized * 255) << (channel * 8);
        }
        texels[word++] = value >>> 0;
      }
    }
  });
  materials.set(packSurfaceMaterialTable(snapshot));
  for (const value of [...materials, ...textures])
    finite(value, "Resource data");
  return {
    abi: 1,
    materials,
    textures,
    texels,
    materialIds: [...materialIds.keys()],
    textureIds: [...textureIds.keys()],
    limitations: [
      "Buffer ABI and exact source texels only; shader, BSDF and graphics acceptance require separate integration.",
      "Texture metadata retains minification/mip parameters; this packer does not generate a mip chain.",
    ],
  };
}

/** Numeric reference for shader upload/readback tests; sRGB decoding precedes filtering. */
export function unpackSurfaceTexel(
  resources: PackedSurfaceResources,
  textureIndex: number,
  x: number,
  y: number,
): readonly [number, number, number, number] {
  if (
    !Number.isInteger(textureIndex) ||
    textureIndex < 0 ||
    textureIndex >= resources.textureIds.length
  )
    return fail("TC_SURFACE_GPU_TEXEL", "Invalid texture index.");
  const metadata = resources.textures.subarray(
    textureIndex * SURFACE_TEXTURE_FLOATS,
    (textureIndex + 1) * SURFACE_TEXTURE_FLOATS,
  );
  const words = new Uint32Array(
    resources.textures.buffer,
    resources.textures.byteOffset + textureIndex * SURFACE_TEXTURE_FLOATS * 4,
    metadata.length,
  );
  if (
    metadata.length !== SURFACE_TEXTURE_FLOATS ||
    !Number.isInteger(x) ||
    !Number.isInteger(y) ||
    x < 0 ||
    y < 0 ||
    x >= words[1] ||
    y >= words[2]
  )
    return fail("TC_SURFACE_GPU_TEXEL", "Invalid texture coordinates.");
  const flags = words[7],
    offset = words[0] + (y * words[1] + x) * (flags & 1 ? 4 : 1);
  const floats = new Float32Array(
    resources.texels.buffer,
    resources.texels.byteOffset,
    resources.texels.length,
  );
  const output = [0, 1, 2, 3].map((channel) =>
    flags & 1
      ? floats[offset + channel]
      : ((resources.texels[offset] >>> (channel * 8)) & 255) / 255,
  );
  if (flags & 2)
    for (let channel = 0; channel < 3; channel++) {
      const value = output[channel];
      output[channel] =
        value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    }
  return output as unknown as readonly [number, number, number, number];
}

export function packSurfaceMaterialTable(snapshot: SurfaceScene) {
  const textureIds = indexMap(snapshot.textures),
    materials = new Float32Array(
      snapshot.materials.length * SURFACE_MATERIAL_FLOATS,
    );
  snapshot.materials.forEach((material, index) => {
    const map = (slot: keyof typeof material.maps) =>
      reference(textureIds, material.maps[slot]);
    materials.set(
      [
        ...material.baseColor,
        material.roughness,
        material.metalness,
        material.alphaTest,
        material.aoMapIntensity,
        ...material.emissive,
        material.emissiveIntensity,
        map("map"),
        map("alphaMap"),
        map("normalMap"),
        map("roughnessMap"),
        map("metalnessMap"),
        map("aoMap"),
        map("emissiveMap"),
        material.side === "double" ? 2 : material.side === "back" ? 1 : 0,
        ...material.normalScale,
        material.normalMapType === THREE.ObjectSpaceNormalMap ? 1 : 0,
        material.alphaMode === "blend"
          ? 2
          : material.alphaMode === "mask"
            ? 1
            : 0,
        material.kind === "unlit" ? -1 : material.transmission ?? 0,
        material.ior ?? 1.5,
        (material.transmission ?? 0) > 0
          ? (material.attenuationDistance ?? 0)
          : map("specularIntensityMap") + 1,
        1 - (material.specularIntensity ?? 1),
        ...((material.transmission ?? 0) > 0 ? (material.attenuationColor ?? [1, 1, 1]) : (material.specularColor ?? [1, 1, 1])),
        (material.transmission ?? 0) > 0 ? 0 : map("specularColorMap") + 1,
      ],
      index * SURFACE_MATERIAL_FLOATS,
    );
  });
  for (const value of materials) finite(value, "Material data");
  return materials;
}
