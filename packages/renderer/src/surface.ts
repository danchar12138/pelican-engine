import * as THREE from "three";
import type { SurfaceVertexDeformer } from "./vertex-contract.ts";

// Only extractor-owned deeply frozen objects receive this private provenance.
// A caller freezing arbitrary data cannot opt out of the general validation path.
const capturedSurfaces = new WeakSet<object>();
const capturedGeometry = new WeakSet<object>();
const capturedTriangles = new WeakSet<object>();
export function isCapturedSurface(value: object): boolean { return capturedSurfaces.has(value); }
export function hasCapturedGeometry(value: SurfaceScene): boolean { return capturedGeometry.has(value.triangles); }
export function isCapturedTriangle(value: SurfaceTriangle): boolean { return capturedTriangles.has(value); }

export type SurfaceVec2 = readonly [number, number];
export type SurfaceVec3 = readonly [number, number, number];
export type SurfaceVec4 = readonly [number, number, number, number];
export interface SurfaceDiagnostic {
  readonly code: string;
  readonly message: string;
  readonly objectUuid?: string;
  readonly materialUuid?: string;
  readonly textureUuid?: string;
}
export interface SurfacePixelData {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array | Uint8ClampedArray | Float32Array;
  readonly channels: 1 | 2 | 3 | 4;
  readonly encoding: "unorm8" | "float32";
  /** texture: already uploaded row order; image: source rows requiring texture.flipY. */
  readonly origin: "texture" | "image";
}
export interface SurfaceExtractionOptions {
  readonly layersMask?: number;
  readonly materialAdapter?: (
    material: THREE.Material,
  ) => THREE.Material | null | undefined;
  readonly textureCache?: SurfaceTextureCache;
  readonly meshCache?: SurfaceMeshCache;
  /** Engine-private post-morph/skin/instance, pre-world deformation. */
  readonly vertexDeformer?: SurfaceVertexDeformer;
  /** Engine-private extraction selection; excluded meshes still visit children. */
  readonly meshFilter?: (mesh: THREE.Mesh) => boolean;
  readonly decodedTextureProvider?: (
    texture: THREE.Texture,
  ) => SurfacePixelData | undefined;
}
export interface SurfaceTexture {
  readonly uuid: string;
  readonly sourceUuid: string;
  readonly width: number;
  readonly height: number;
  readonly format: number;
  readonly type: number;
  readonly mapping: number;
  readonly channel: number;
  readonly colorSpace: string;
  readonly flipY: boolean;
  readonly wrapS: number;
  readonly wrapT: number;
  readonly magFilter: number;
  readonly minFilter: number;
  readonly anisotropy: number;
  readonly generateMipmaps: boolean;
  readonly offset: SurfaceVec2;
  readonly repeat: SurfaceVec2;
  readonly center: SurfaceVec2;
  readonly rotation: number;
  readonly matrix: readonly number[];
  /** Frozen normalized RGBA texels; sRGB RGB values remain encoded until sampling. */
  readonly pixels?: readonly number[];
  readonly pixelEncoding?: "unorm8" | "float32";
  readonly pixelOrigin?: "texture" | "image";
}

/** Content-owned cache; clear on unload, dispose when the content owner ends. */
export class SurfaceTextureCache {
  private entries = new Map<
    THREE.Texture,
    {
      signature: readonly unknown[];
      snapshot: SurfaceTexture;
      diagnostics: readonly SurfaceDiagnostic[];
    }
  >();
  private disposed = false;
  private hits = 0;

  /** @internal Extraction calls this after the material/texture validation. */
  getSnapshot(
    texture: THREE.Texture,
    provider: SurfaceExtractionOptions["decodedTextureProvider"],
    diagnostics: SurfaceDiagnostic[],
  ): SurfaceTexture {
    if (this.disposed)
      return fail(
        "SURFACE_TEXTURE_CACHE_DISPOSED",
        "Create a new surface texture cache after dispose().",
        texture.uuid,
      );
    rejectExtensions(texture.userData, texture.uuid);
    const image = texture.image as
      | {
          width?: number;
          height?: number;
          naturalWidth?: number;
          naturalHeight?: number;
          currentSrc?: string;
          src?: string;
          complete?: boolean;
        }
      | undefined;
    const flags = texture as THREE.Texture & Record<string, unknown>;
    const signature: unknown[] = [
      texture.uuid,
      texture.version,
      texture.source,
      texture.source.uuid,
      texture.source.version,
      image,
      image?.width,
      image?.height,
      image?.naturalWidth,
      image?.naturalHeight,
      image?.currentSrc,
      image?.src,
      image?.complete,
      texture.format,
      texture.type,
      texture.mapping,
      texture.channel,
      texture.colorSpace,
      texture.flipY,
      texture.wrapS,
      texture.wrapT,
      texture.magFilter,
      texture.minFilter,
      texture.anisotropy,
      texture.generateMipmaps,
      texture.premultiplyAlpha,
      texture.mipmaps.length,
      texture.isRenderTargetTexture,
      texture.rotation,
      ...texture.offset.toArray(),
      ...texture.repeat.toArray(),
      ...texture.center.toArray(),
      ...textureMatrix(texture),
      provider,
      ...[
        "isDataTexture",
        "isCompressedTexture",
        "isDataArrayTexture",
        "isData3DTexture",
        "isVideoTexture",
        "isFramebufferTexture",
      ].map((key) => flags[key]),
    ];
    const cached = this.entries.get(texture);
    if (
      cached &&
      signature.length === cached.signature.length &&
      signature.every((value, i) => Object.is(value, cached.signature[i]))
    ) {
      this.hits++;
      diagnostics.push(...cached.diagnostics);
      return cached.snapshot;
    }
    const local: SurfaceDiagnostic[] = [];
    const snapshot = freezeDeep(snapshotTexture(texture, provider, local));
    diagnostics.push(...local);
    // Missing pixels may become available asynchronously without needsUpdate.
    if (snapshot.pixels)
      this.entries.set(texture, {
        signature,
        snapshot,
        diagnostics: freezeDeep(local),
      });
    else this.entries.delete(texture);
    return snapshot;
  }

  inspect() {
    return {
      disposed: this.disposed,
      entries: this.entries.size,
      hits: this.hits,
      texels: Array.from(this.entries.values()).reduce(
        (n, entry) => n + entry.snapshot.width * entry.snapshot.height,
        0,
      ),
      capacity: "host; no fixed resource limit",
    };
  }
  clear(): void {
    this.entries.clear();
    this.hits = 0;
  }
  dispose(): void {
    this.clear();
    this.disposed = true;
  }
}

export function createSurfaceTextureCache(): SurfaceTextureCache {
  return new SurfaceTextureCache();
}

/** Explicit GPU upload packing: R in bits 0..7, G 8..15, B 16..23, A 24..31.
 * Own the returned buffer alongside the frozen snapshot; no float32 staging copy.
 */
export function packSurfaceTextureRGBA8(texture: SurfaceTexture): Uint32Array {
  if (!texture.pixels || texture.pixelEncoding !== "unorm8")
    return fail(
      "SURFACE_TEXTURE_PACK_UNSUPPORTED",
      "RGBA8 packing requires decoded unorm8 pixels; HDR needs a separate packing format.",
      texture.uuid,
    );
  const packed = new Uint32Array(texture.width * texture.height);
  for (let i = 0; i < packed.length; i++) {
    const p = i * 4;
    packed[i] =
      Math.round(texture.pixels[p] * 255) |
      (Math.round(texture.pixels[p + 1] * 255) << 8) |
      (Math.round(texture.pixels[p + 2] * 255) << 16) |
      (Math.round(texture.pixels[p + 3] * 255) << 24);
  }
  return packed;
}
export type SurfaceMapSlot =
  | "map"
  | "alphaMap"
  | "normalMap"
  | "metalnessMap"
  | "roughnessMap"
  | "aoMap"
  | "emissiveMap"
  | "specularIntensityMap"
  | "specularColorMap";
export interface SurfaceMaterial {
  readonly uuid: string;
  readonly name: string;
  readonly kind: "standard" | "physical" | "unlit";
  readonly side: "front" | "back" | "double";
  readonly vertexColors: boolean;
  readonly flatShading: boolean;
  readonly baseColor: SurfaceVec4;
  readonly alphaMode: "opaque" | "mask" | "blend";
  readonly alphaTest: number;
  readonly roughness: number;
  readonly metalness: number;
  readonly normalScale: SurfaceVec2;
  readonly normalMapType: number;
  readonly aoMapIntensity: number;
  readonly emissive: SurfaceVec3;
  readonly emissiveIntensity: number;
  readonly transmission?: number;
  readonly ior?: number;
  readonly specularIntensity?: number;
  readonly specularColor?: SurfaceVec3;
  readonly attenuationColor?: SurfaceVec3;
  /** 0 is disabled, otherwise positive world-space distance. */
  readonly attenuationDistance?: number;
  readonly maps: Readonly<Partial<Record<SurfaceMapSlot, string>>>;
}
export interface SurfaceVertex {
  readonly position: SurfaceVec3;
  readonly normal: SurfaceVec3;
  readonly uv0?: SurfaceVec2;
  readonly uv1?: SurfaceVec2;
  readonly tangent?: SurfaceVec4;
  readonly color?: SurfaceVec4;
}
export interface SurfaceTriangle {
  readonly objectUuid: string;
  readonly geometryUuid: string;
  readonly instanceId: number;
  readonly instanceColor?: SurfaceVec3;
  readonly castShadow?: boolean;
  readonly receiveShadow?: boolean;
  readonly materialUuid: string;
  readonly materialIndex: number;
  readonly groupIndex: number;
  readonly elementOffset: number;
  readonly vertexIndices: readonly [number, number, number];
  readonly vertices: readonly [SurfaceVertex, SurfaceVertex, SurfaceVertex];
  readonly normalMatrix: readonly number[];
}
export interface SurfaceScene {
  readonly version: 1;
  readonly triangles: readonly SurfaceTriangle[];
  readonly materials: readonly SurfaceMaterial[];
  readonly textures: readonly SurfaceTexture[];
  readonly diagnostics: readonly SurfaceDiagnostic[];
}

/** Content-owned world-space triangle cache. Material records are never cached. */
export class SurfaceMeshCache {
  private entries = new Map<
    THREE.Mesh,
    {
      signature: readonly unknown[];
      triangles: readonly SurfaceTriangle[];
    }
  >();
  private disposed = false;
  private hits = 0;
  private misses = 0;

  /** @internal Also called for empty scenes so disposed options fail early. */
  assertActive(): void {
    if (this.disposed)
      fail(
        "SURFACE_MESH_CACHE_DISPOSED",
        "Create a new surface mesh cache after dispose().",
      );
  }
  /** @internal The signature owns copied scalar state, not borrowed arrays. */
  get(
    mesh: THREE.Mesh,
    signature: readonly unknown[],
  ): readonly SurfaceTriangle[] | undefined {
    this.assertActive();
    const entry = this.entries.get(mesh);
    if (
      entry &&
      signature.length === entry.signature.length &&
      signature.every((v, i) => Object.is(v, entry.signature[i]))
    ) {
      this.hits++;
      return entry.triangles;
    }
    this.misses++;
    return undefined;
  }
  /** @internal Publish only successfully extracted, deeply frozen data. */
  set(
    mesh: THREE.Mesh,
    signature: readonly unknown[],
    triangles: SurfaceTriangle[],
  ): void {
    this.assertActive();
    this.entries.set(mesh, { signature, triangles: freezeDeep(triangles) });
  }
  inspect() {
    return {
      disposed: this.disposed,
      meshes: this.entries.size,
      triangles: Array.from(this.entries.values()).reduce(
        (n, e) => n + e.triangles.length,
        0,
      ),
      hits: this.hits,
      misses: this.misses,
      capacity: "host; no fixed resource limit",
    };
  }
  clear(): void {
    this.entries.clear();
    this.hits = this.misses = 0;
  }
  dispose(): void {
    this.clear();
    this.disposed = true;
  }
}

export function createSurfaceMeshCache(): SurfaceMeshCache {
  return new SurfaceMeshCache();
}
export interface SurfaceSampleOptions {
  readonly uv0?: SurfaceVec2;
  readonly uv1?: SurfaceVec2;
  readonly frontFacing?: boolean;
  readonly footprint?: "magnification" | "minification";
}
export interface SurfaceMaterialSample {
  readonly materialUuid: string;
  readonly discarded: boolean;
  readonly alphaMode: SurfaceMaterial["alphaMode"];
  readonly alpha: number;
  readonly coverage: number;
  readonly baseColor: SurfaceVec3;
  readonly roughness: number;
  readonly metalness: number;
  readonly specularIntensity: number;
  readonly specularColor: SurfaceVec3;
  readonly occlusion: number;
  readonly emissive: SurfaceVec3;
  readonly normal: SurfaceVec3;
}
export class SurfaceExtractionError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly identity?: string,
  ) {
    super(`${code}${identity ? ` [${identity}]` : ""}: ${message}`);
    this.name = "SurfaceExtractionError";
  }
}
const fail = (code: string, message: string, identity?: string): never => {
  throw new SurfaceExtractionError(code, message, identity);
};
const finite = (n: number, id: string, field: string): number =>
  Number.isFinite(n)
    ? n
    : fail("SURFACE_NON_FINITE", `${field} is not finite`, id);
const vec = (v: THREE.Vector3): SurfaceVec3 => [v.x, v.y, v.z];
const freezeDeep = <T>(value: T): T => {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
};
const srgbToLinear = (v: number): number =>
  v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
const finiteVector = (v: THREE.Vector3, id: string, field: string): void => {
  finite(v.x, id, `${field}.x`);
  finite(v.y, id, `${field}.y`);
  finite(v.z, id, `${field}.z`);
};
const isNode = (v: unknown): boolean =>
  !!v && typeof v === "object" && (v as { isNode?: boolean }).isNode === true;
function localMatrix(o: THREE.Object3D): THREE.Matrix4 {
  return o.matrixAutoUpdate
    ? new THREE.Matrix4().compose(o.position, o.quaternion, o.scale)
    : o.matrix.clone();
}
function validateAffine(matrix: THREE.Matrix4, identity: string): void {
  const e = matrix.elements;
  for (const n of e) finite(n, identity, "transform matrix");
  if (e[3] !== 0 || e[7] !== 0 || e[11] !== 0 || e[15] !== 1)
    fail(
      "SURFACE_TRANSFORM_UNSUPPORTED",
      "Surface transforms must be affine matrices",
      identity,
    );
}
function worldMatrix(
  o: THREE.Object3D,
  cache: Map<THREE.Object3D, THREE.Matrix4>,
): THREE.Matrix4 {
  const old = cache.get(o);
  if (old) return old;
  const result = o.matrixWorldAutoUpdate
    ? o.parent
      ? worldMatrix(o.parent, cache).clone().multiply(localMatrix(o))
      : localMatrix(o)
    : o.matrixWorld.clone();
  validateAffine(result, o.uuid);
  cache.set(o, result);
  return result;
}
function rejectExtensions(
  userData: Record<string, unknown>,
  identity: string,
): void {
  const extensions = userData.gltfExtensions;
  if (extensions && typeof extensions === "object")
    for (const key of Object.keys(extensions)) {
      if (
        key !== "KHR_texture_transform" &&
        key !== "KHR_materials_emissive_strength"
      )
        fail(
          "SURFACE_EXTENSION_UNSUPPORTED",
          "Extension " +
            key +
            " has no surface representation; remove it or implement an adapter",
          identity,
        );
    }
}
function textureMatrix(t: THREE.Texture): number[] {
  const result = (
    t.matrixAutoUpdate
      ? new THREE.Matrix3().setUvTransform(
          t.offset.x,
          t.offset.y,
          t.repeat.x,
          t.repeat.y,
          t.rotation,
          t.center.x,
          t.center.y,
        )
      : t.matrix
  ).elements.slice();
  for (const value of result) finite(value, t.uuid, "texture matrix");
  if (result[2] !== 0 || result[5] !== 0 || result[8] !== 1)
    fail(
      "SURFACE_UV_TRANSFORM_INVALID",
      "Use an affine UV matrix; Three samples matrix * vec3(uv, 1) without projective division",
      t.uuid,
    );
  return result;
}
function channelsFor(format: number): 1 | 2 | 3 | 4 {
  if (format === THREE.RedFormat) return 1;
  if (format === THREE.RGFormat) return 2;
  if (format === THREE.RGBFormat) return 3;
  if (format === THREE.RGBAFormat) return 4;
  return fail(
    "SURFACE_TEXTURE_FORMAT_UNSUPPORTED",
    `Texture format ${format} is not CPU-sampleable`,
  );
}
const capturedPixelArrays = new WeakSet<readonly number[]>();
/** Internal provenance: only dense numeric arrays validated by copyPixels qualify. */
export function isFrozenCapturedPixels(
  value: unknown,
): value is readonly number[] {
  return (
    Array.isArray(value) &&
    Object.isFrozen(value) &&
    capturedPixelArrays.has(value)
  );
}
function copyPixels(
  width: number,
  height: number,
  channels: 1 | 2 | 3 | 4,
  data: ArrayLike<number>,
  encoding: "unorm8" | "float32",
  origin: "texture" | "image",
  flipY: boolean,
  id: string,
): number[] {
  if (
    ![1, 2, 3, 4].includes(channels) ||
    (encoding !== "unorm8" && encoding !== "float32") ||
    (origin !== "texture" && origin !== "image")
  )
    fail(
      "SURFACE_TEXTURE_DATA_INVALID",
      "Decoded pixels require channels 1..4, an explicit encoding and row origin",
      id,
    );
  if (
    !Number.isInteger(width) ||
    width < 1 ||
    !Number.isInteger(height) ||
    height < 1
  )
    fail(
      "SURFACE_TEXTURE_SIZE_INVALID",
      "Texture dimensions must be positive integers",
      id,
    );
  if (data.length !== width * height * channels)
    fail(
      "SURFACE_TEXTURE_DATA_INVALID",
      "Pixel length differs from dimensions and channel count",
      id,
    );
  const out = new Array<number>(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const sy = origin === "image" && flipY ? height - 1 - y : y,
        si = (sy * width + x) * channels,
        di = (y * width + x) * 4;
      for (let c = 0; c < 4; c++) {
        const raw =
          c < channels
            ? data[si + c]
            : c === 3
              ? encoding === "unorm8"
                ? 255
                : 1
              : 0;
        out[di + c] = finite(
          encoding === "unorm8" ? raw / 255 : raw,
          id,
          "texture pixel",
        );
      }
    }
  capturedPixelArrays.add(out);
  return out;
}
function snapshotTexture(
  t: THREE.Texture,
  provider: SurfaceExtractionOptions["decodedTextureProvider"],
  diagnostics: SurfaceDiagnostic[],
): SurfaceTexture {
  rejectExtensions(t.userData, t.uuid);
  const image = t.image as
    | { width?: number; height?: number; data?: unknown }
    | undefined;
  let width = image?.width ?? 0,
    height = image?.height ?? 0,
    pixels: number[] | undefined,
    pixelEncoding: "unorm8" | "float32" | undefined,
    pixelOrigin: "texture" | "image" | undefined;
  try {
    const channels = channelsFor(t.format);
    if (t.mipmaps.length > 0)
      fail(
        "SURFACE_TEXTURE_TYPE_UNSUPPORTED",
        "Custom mip chains require a future adapter; the CPU reference cannot substitute image for supplied mip zero",
        t.uuid,
      );
    if (t.type !== THREE.UnsignedByteType && t.type !== THREE.FloatType)
      fail(
        "SURFACE_TEXTURE_TYPE_UNSUPPORTED",
        "Only unsigned-byte and float32 texture types have a CPU reference",
        t.uuid,
      );
    const textureFlags = t as unknown as {
      isCompressedTexture?: boolean;
      isDataArrayTexture?: boolean;
      isData3DTexture?: boolean;
      isVideoTexture?: boolean;
      isFramebufferTexture?: boolean;
    };
    if (
      textureFlags.isCompressedTexture ||
      textureFlags.isDataArrayTexture ||
      textureFlags.isData3DTexture ||
      textureFlags.isVideoTexture ||
      textureFlags.isFramebufferTexture ||
      t.isRenderTargetTexture ||
      t.premultiplyAlpha
    )
      fail(
        "SURFACE_TEXTURE_TYPE_UNSUPPORTED",
        "Dynamic/array/compressed/render-target/premultiplied textures require an explicit future adapter",
        t.uuid,
      );
    if (
      (t as unknown as { isDataTexture?: boolean }).isDataTexture === true &&
      ArrayBuffer.isView(image?.data)
    ) {
      const source = image!.data as unknown as ArrayLike<number>,
        bytes =
          image!.data instanceof Uint8Array ||
          image!.data instanceof Uint8ClampedArray;
      if (!bytes && !(image!.data instanceof Float32Array))
        fail(
          "SURFACE_TEXTURE_TYPE_UNSUPPORTED",
          "Only unsigned-byte and float32 DataTexture pixels are decoded",
          t.uuid,
        );
      if (
        (bytes && t.type !== THREE.UnsignedByteType) ||
        (!bytes && t.type !== THREE.FloatType)
      )
        fail(
          "SURFACE_TEXTURE_DATA_INVALID",
          "DataTexture typed array does not match its pixel type",
          t.uuid,
        );
      pixelEncoding = bytes ? "unorm8" : "float32";
      pixelOrigin = "image";
      pixels = copyPixels(
        width,
        height,
        channels,
        source,
        pixelEncoding,
        pixelOrigin,
        t.flipY,
        t.uuid,
      );
    } else if (provider) {
      const decoded = provider(t);
      if (decoded) {
        if (
          (decoded.encoding === "unorm8" &&
            !(
              decoded.data instanceof Uint8Array ||
              decoded.data instanceof Uint8ClampedArray
            )) ||
          (decoded.encoding === "float32" &&
            !(decoded.data instanceof Float32Array))
        )
          fail(
            "SURFACE_TEXTURE_DATA_INVALID",
            "Provider pixel array does not match encoding",
            t.uuid,
          );
        width = decoded.width;
        height = decoded.height;
        pixelEncoding = decoded.encoding;
        pixelOrigin = decoded.origin;
        pixels = copyPixels(
          width,
          height,
          decoded.channels,
          decoded.data,
          pixelEncoding,
          pixelOrigin,
          t.flipY,
          t.uuid,
        );
      } else
        diagnostics.push({
          code: "SURFACE_TEXTURE_PIXELS_UNAVAILABLE",
          message:
            "Decoded provider returned no pixels; texture identity is retained.",
          textureUuid: t.uuid,
        });
    } else
      diagnostics.push({
        code: "SURFACE_TEXTURE_PIXELS_UNAVAILABLE",
        message: "CPU pixels unavailable; texture identity is retained.",
        textureUuid: t.uuid,
      });
  } catch (error) {
    if (
      error instanceof SurfaceExtractionError &&
      (error.code === "SURFACE_TEXTURE_TYPE_UNSUPPORTED" ||
        error.code === "SURFACE_TEXTURE_FORMAT_UNSUPPORTED")
    )
      diagnostics.push({
        code: error.code,
        message: error.message,
        textureUuid: t.uuid,
      });
    else throw error;
  }
  for (const n of [
    ...textureMatrix(t),
    t.rotation,
    ...t.offset.toArray(),
    ...t.repeat.toArray(),
    ...t.center.toArray(),
    t.anisotropy,
    width,
    height,
  ])
    finite(n, t.uuid, "texture metadata");
  return {
    uuid: t.uuid,
    sourceUuid: t.source.uuid,
    width,
    height,
    format: t.format,
    type: t.type,
    mapping: t.mapping,
    channel: t.channel,
    colorSpace: t.colorSpace,
    flipY: t.flipY,
    wrapS: t.wrapS,
    wrapT: t.wrapT,
    magFilter: t.magFilter,
    minFilter: t.minFilter,
    anisotropy: t.anisotropy,
    generateMipmaps: t.generateMipmaps,
    offset: [t.offset.x, t.offset.y],
    repeat: [t.repeat.x, t.repeat.y],
    center: [t.center.x, t.center.y],
    rotation: t.rotation,
    matrix: textureMatrix(t),
    // Freeze numeric storage directly: freezeDeep must not allocate Object.values
    // for millions of texels on the first capture either.
    ...(pixels
      ? { pixels: Object.freeze(pixels), pixelEncoding, pixelOrigin }
      : {}),
  };
}
const unsupportedMaps = [
  "lightMap",
  "bumpMap",
  "displacementMap",
  "envMap",
  "specularMap",
  "gradientMap",
] as const;
const physicalExtensions = [
  "clearcoat",
  "iridescence",
  "sheen",
  "thickness",
  "anisotropy",
  "dispersion",
  "diffuseRoughness",
  "retroreflectivity",
] as const;
function snapshotMaterial(
  m: THREE.Material,
  materials: SurfaceMaterial[],
  byMaterial: Map<THREE.Material, SurfaceMaterial>,
  textures: SurfaceTexture[],
  byTexture: Map<THREE.Texture, SurfaceTexture>,
  options: SurfaceExtractionOptions,
  diagnostics: SurfaceDiagnostic[],
  original: THREE.Material,
): SurfaceMaterial {
  const cached = byMaterial.get(original);
  if (cached) return cached;
  const flags = m as unknown as {
    isMeshStandardMaterial?: boolean;
    isMeshPhysicalMaterial?: boolean;
    isMeshBasicMaterial?: boolean;
  };
  const unlit = flags.isMeshBasicMaterial === true;
  if ((m as unknown as { isNodeMaterial?: boolean }).isNodeMaterial)
    fail(
      "SURFACE_NODE_GRAPH_UNSUPPORTED",
      "Node materials require a graph-aware surface adapter",
      m.uuid,
    );
  if (!flags.isMeshStandardMaterial && !flags.isMeshPhysicalMaterial && !unlit)
    return fail(
      "SURFACE_MATERIAL_UNSUPPORTED",
      `Material ${m.type} is not standard/physical PBR or unlit`,
      m.uuid,
    );
  if (m.type !== "MeshStandardMaterial" && m.type !== "MeshPhysicalMaterial" && m.type !== "MeshBasicMaterial")
    return fail(
      "SURFACE_MATERIAL_CUSTOM_SUBCLASS",
      `Custom material ${m.type} is unsupported`,
      m.uuid,
    );
  if (
    m.onBeforeCompile.toString() !==
      THREE.Material.prototype.onBeforeCompile.toString() ||
    m.customProgramCacheKey() !==
      THREE.Material.prototype.customProgramCacheKey.call(m)
  )
    fail(
      "SURFACE_CUSTOM_SHADER_UNSUPPORTED",
      "Custom shader hooks are unsupported",
      m.uuid,
    );
  for (const [key, value] of Object.entries(m))
    if (key.endsWith("Node") && isNode(value))
      fail(
        "SURFACE_NODE_GRAPH_UNSUPPORTED",
        `Node property ${key} is unsupported`,
        m.uuid,
      );
  rejectExtensions(m.userData, m.uuid);
  if (
    m.constructor !== THREE.MeshStandardMaterial &&
    m.constructor !== THREE.MeshPhysicalMaterial &&
    m.constructor !== THREE.MeshBasicMaterial
  )
    fail(
      "SURFACE_MATERIAL_CUSTOM_SUBCLASS",
      "Custom material subclasses require an explicit surface adapter",
      m.uuid,
    );
  const s = m as THREE.MeshStandardMaterial;
  if (unlit && (m as THREE.MeshBasicMaterial).aoMap)
    fail(
      "SURFACE_MATERIAL_MAP_UNSUPPORTED",
      "Ambient occlusion on an unlit material is not supported by the surface tracer; remove aoMap or use a standard material",
      m.uuid,
    );
  if (s.wireframe)
    fail(
      "SURFACE_MATERIAL_MODE_UNSUPPORTED",
      "Wireframe materials are not triangle surfaces",
      m.uuid,
    );
  if (
    m.side !== THREE.FrontSide &&
    m.side !== THREE.BackSide &&
    m.side !== THREE.DoubleSide
  )
    fail("SURFACE_MATERIAL_SIDE_INVALID", "Unknown side value", m.uuid);
  for (const slot of unsupportedMaps)
    if ((s as unknown as Record<string, unknown>)[slot])
      fail(
        "SURFACE_MATERIAL_MAP_UNSUPPORTED",
        `${slot} is not sampled`,
        m.uuid,
      );
  const physicalMaterial =
    (s as unknown as { isMeshPhysicalMaterial?: boolean })
      .isMeshPhysicalMaterial === true;
  if (physicalMaterial) {
    const p = s as THREE.MeshPhysicalMaterial;
    if (
      !Number.isFinite(p.transmission) ||
      p.transmission < 0 ||
      p.transmission > 1 ||
      !Number.isFinite(p.ior) ||
      p.ior <= 0
    )
      fail(
        "SURFACE_PHYSICAL_VALUE_INVALID",
        "Transmission and IOR must be finite and in their supported domains.",
        m.uuid,
      );
    if (p.transmission > 0 && p.metalness !== 0)
      fail(
        "SURFACE_PHYSICAL_VALUE_INVALID",
        "Dielectric volume transmission requires metalness 0.",
        m.uuid,
      );
    if (
      p.transmission > 0 &&
      ((!Number.isFinite(p.attenuationDistance) &&
        p.attenuationDistance !== Infinity) ||
        p.attenuationDistance <= 0)
    )
      fail(
        "SURFACE_PHYSICAL_VALUE_INVALID",
        "Attenuation distance must be positive or Infinity.",
        m.uuid,
      );
    for (const key of physicalExtensions)
      if ((p as unknown as Record<string, number>)[key] !== 0)
        fail(
          "SURFACE_PHYSICAL_EXTENSION_UNSUPPORTED",
          `Active ${key} extension is unsupported`,
          m.uuid,
        );
    if (!Number.isFinite(p.specularIntensity) || p.specularIntensity < 0 || p.specularIntensity > 1 ||
      [p.specularColor.r, p.specularColor.g, p.specularColor.b].some(value => !Number.isFinite(value) || value < 0 || value > 1))
      fail("SURFACE_PHYSICAL_VALUE_INVALID", "Specular intensity and linear RGB must be in [0,1].", m.uuid);
    if (p.transmission > 0 && (p.specularIntensity !== 1 || p.specularColor.r !== 1 || p.specularColor.g !== 1 || p.specularColor.b !== 1))
      fail(
        "SURFACE_PHYSICAL_EXTENSION_UNSUPPORTED",
        "Non-default specular on transmissive media is unsupported",
        m.uuid,
      );
    if (p.transmission > 0 && (p.specularIntensityMap || p.specularColorMap))
      fail(
        "SURFACE_PHYSICAL_EXTENSION_UNSUPPORTED",
        "Specular texture maps on transmissive media are unsupported",
        m.uuid,
      );
    for (const key of [
      "diffuseRoughnessMap",
      "clearcoatMap",
      "clearcoatRoughnessMap",
      "clearcoatNormalMap",
      "iridescenceMap",
      "iridescenceThicknessMap",
      "sheenColorMap",
      "sheenRoughnessMap",
      "transmissionMap",
      "thicknessMap",
      "anisotropyMap",
    ] as const)
      if ((p as unknown as Record<string, unknown>)[key])
        fail(
          "SURFACE_PHYSICAL_EXTENSION_UNSUPPORTED",
          `Active extension map ${key} is unsupported`,
          m.uuid,
        );
  }
  if (!m.visible)
    fail(
      "SURFACE_MATERIAL_INVISIBLE",
      "Invisible material should be omitted before snapshotting",
      m.uuid,
    );
  if (
    m.blending !== THREE.NormalBlending ||
    m.clipIntersection ||
    m.clipShadows ||
    m.clippingPlanes?.length ||
    (m as THREE.Material & { alphaHash?: boolean; alphaToCoverage?: boolean })
      .alphaHash ||
    (m as THREE.Material & { alphaToCoverage?: boolean }).alphaToCoverage ||
    m.premultipliedAlpha
  )
    fail(
      "SURFACE_ALPHA_MODE_UNSUPPORTED",
      "Custom blending, clipping, alpha hash/coverage and premultiplied alpha are unsupported",
      m.uuid,
    );
  const maps: Partial<Record<SurfaceMapSlot, string>> = {};
  for (const slot of [
    "map",
    "alphaMap",
    "normalMap",
    "metalnessMap",
    "roughnessMap",
    "aoMap",
    "emissiveMap",
    "specularIntensityMap",
    "specularColorMap",
  ] as const) {
    const t = (s as THREE.MeshPhysicalMaterial)[slot];
    if (!t) continue;
    if (t.mapping !== THREE.UVMapping)
      fail(
        "SURFACE_TEXTURE_MAPPING_UNSUPPORTED",
        "Only UVMapping is supported",
        t.uuid,
      );
    if (t.channel !== 0 && t.channel !== 1)
      fail(
        "SURFACE_UV_CHANNEL_UNSUPPORTED",
        `UV channel ${t.channel} is unsupported`,
        t.uuid,
      );
    if (slot === "specularColorMap") {
      if (t.colorSpace !== THREE.SRGBColorSpace)
        fail("SURFACE_COLOR_SPACE_UNSUPPORTED", `${slot} must use SRGBColorSpace`, t.uuid);
    } else if (slot === "map" || slot === "emissiveMap") {
      if (
        ![
          THREE.NoColorSpace,
          THREE.SRGBColorSpace,
          THREE.LinearSRGBColorSpace,
        ].includes(t.colorSpace as never)
      )
        fail(
          "SURFACE_COLOR_SPACE_UNSUPPORTED",
          `Unsupported color space ${t.colorSpace}`,
          t.uuid,
        );
    } else if (t.colorSpace !== THREE.NoColorSpace)
      fail(
        "SURFACE_COLOR_SPACE_UNSUPPORTED",
        `${slot} must use NoColorSpace`,
        t.uuid,
      );
    let st = byTexture.get(t);
    if (!st) {
      st = options.textureCache
        ? options.textureCache.getSnapshot(
            t,
            options.decodedTextureProvider,
            diagnostics,
          )
        : snapshotTexture(t, options.decodedTextureProvider, diagnostics);
      byTexture.set(t, st);
      textures.push(st);
    }
    maps[slot] = st.uuid;
  }
  const c = s.color,
    material: SurfaceMaterial = {
      // Preserve source identity without mutating/cloning the adapted material.
      uuid: original.uuid,
      name: m.name,
      kind: unlit ? "unlit" : physicalMaterial ? "physical" : "standard",
      side:
        m.side === THREE.DoubleSide
          ? "double"
          : m.side === THREE.BackSide
            ? "back"
            : "front",
      vertexColors: s.vertexColors,
      flatShading: s.flatShading ?? false,
      baseColor: [c.r, c.g, c.b, s.opacity],
      alphaMode: m.transparent ? "blend" : m.alphaTest > 0 ? "mask" : "opaque",
      alphaTest: m.alphaTest,
      roughness: unlit ? 1 : s.roughness,
      metalness: unlit ? 0 : s.metalness,
      normalScale: unlit ? [1, 1] : [s.normalScale.x, s.normalScale.y],
      normalMapType: unlit ? THREE.TangentSpaceNormalMap : s.normalMapType,
      aoMapIntensity: unlit ? 1 : s.aoMapIntensity,
      emissive: unlit ? [0, 0, 0] : [s.emissive.r, s.emissive.g, s.emissive.b],
      emissiveIntensity: unlit ? 0 : s.emissiveIntensity,
      ...(physicalMaterial
        ? {
            transmission: (s as THREE.MeshPhysicalMaterial).transmission,
            ior: (s as THREE.MeshPhysicalMaterial).ior,
            specularIntensity: (s as THREE.MeshPhysicalMaterial).specularIntensity,
            specularColor: (s as THREE.MeshPhysicalMaterial).specularColor.toArray() as [number, number, number],
            attenuationColor: (
              s as THREE.MeshPhysicalMaterial
            ).attenuationColor.toArray() as [number, number, number],
            attenuationDistance:
              (s as THREE.MeshPhysicalMaterial).attenuationDistance === Infinity
                ? 0
                : (s as THREE.MeshPhysicalMaterial).attenuationDistance,
          }
        : {}),
      maps,
    };
  for (const n of [
    ...material.baseColor,
    ...material.normalScale,
    material.roughness,
    material.metalness,
    material.alphaTest,
    material.aoMapIntensity,
    ...material.emissive,
    material.emissiveIntensity,
    ...(physicalMaterial
      ? [
          material.transmission!,
          material.ior!,
          material.specularIntensity!,
          ...material.specularColor!,
          ...material.attenuationColor!,
          material.attenuationDistance!,
        ]
      : []),
  ])
    finite(n, m.uuid, "material factor");
  if (material.attenuationColor?.some((value) => value < 0 || value > 1))
    fail(
      "SURFACE_PHYSICAL_VALUE_INVALID",
      "Attenuation color must be linear RGB in [0,1].",
      m.uuid,
    );
  byMaterial.set(original, material);
  materials.push(material);
  return material;
}
function morphed(
  geometry: THREE.BufferGeometry,
  name: "position" | "normal" | "color",
  index: number,
  weights: readonly number[],
  identity: string,
): THREE.Vector4 {
  const base = geometry.getAttribute(name);
  if (index >= base.count)
    fail(
      "SURFACE_ATTRIBUTE_COUNT_INVALID",
      `${name} has fewer vertices than position`,
      identity,
    );
  const size = Math.min(base.itemSize, 4);
  const baseValue = new THREE.Vector4(
    base.getX(index),
    size > 1 ? base.getY(index) : 0,
    size > 2 ? base.getZ(index) : 0,
    size > 3 ? base.getW(index) : 1,
  );
  const targets = geometry.morphAttributes[name] as
    | THREE.BufferAttribute[]
    | undefined;
  if (!targets?.length) return baseValue;
  if (targets.length !== weights.length)
    fail(
      "SURFACE_MORPH_INFLUENCE_INVALID",
      `Morph ${name} target count does not match influences`,
      identity,
    );
  const baseInfluence = geometry.morphTargetsRelative
    ? 1
    : 1 - weights.reduce((sum, w) => sum + w, 0);
  const result = baseValue.clone().multiplyScalar(baseInfluence);
  for (let i = 0; i < targets.length; i++) {
    const weight = finite(weights[i], identity, "morph influence");
    if (weight === 0) continue;
    const target = targets[i];
    if (target.count !== base.count || target.itemSize !== base.itemSize)
      fail(
        "SURFACE_MORPH_ATTRIBUTE_INVALID",
        `Morph ${name} count/itemSize differs from base attribute`,
        identity,
      );
    const v = new THREE.Vector4(
      target.getX(index),
      target.itemSize > 1 ? target.getY(index) : 0,
      target.itemSize > 2 ? target.getZ(index) : 0,
      target.itemSize > 3
        ? target.getW(index)
        : name === "color" && size > 3
          ? 0
          : 1,
    );

    result.addScaledVector(v, weight);
  }
  return result;
}
function getVertex(
  mesh: THREE.Mesh,
  index: number,
  instance: THREE.Matrix4,
  normalMatrix: THREE.Matrix3,
  world: THREE.Matrix4,
  direction: THREE.Matrix3,
  material: SurfaceMaterial,
  cache: Map<THREE.Object3D, THREE.Matrix4>,
  instanceIndex: number,
  vertexDeformer?: SurfaceVertexDeformer,
): SurfaceVertex {
  const g = mesh.geometry,
    id = `${mesh.uuid}/${g.uuid}/${index}`;
  if (
    (mesh as unknown as { isInstancedMesh?: boolean }).isInstancedMesh &&
    (mesh as THREE.InstancedMesh).morphTexture
  )
    fail(
      "SURFACE_INSTANCE_MORPH_UNSUPPORTED",
      "Per-instance morph weights are unsupported",
      mesh.uuid,
    );
  const weights = mesh.morphTargetInfluences ?? [];
  for (const weight of weights) finite(weight, id, "morph influence");
  const p4 = morphed(g, "position", index, weights, id),
    position = new THREE.Vector3(p4.x, p4.y, p4.z);
  const normalAttribute = g.getAttribute("normal") as
    | THREE.BufferAttribute
    | undefined;
  let normal = normalAttribute
    ? new THREE.Vector3(
        ...(morphed(g, "normal", index, weights, id).toArray().slice(0, 3) as [
          number,
          number,
          number,
        ]),
      )
    : new THREE.Vector3();
  const ta = g.getAttribute("tangent") as THREE.BufferAttribute | undefined;
  let tangent = ta
    ? new THREE.Vector4(
        ta.getX(index),
        ta.getY(index),
        ta.getZ(index),
        ta.itemSize > 3 ? ta.getW(index) : 1,
      )
    : undefined;
  if ((mesh as unknown as { isSkinnedMesh?: boolean }).isSkinnedMesh === true) {
    const skinned = mesh as THREE.SkinnedMesh,
      si = g.getAttribute("skinIndex"),
      sw = g.getAttribute("skinWeight");
    if (!si || !sw)
      fail(
        "SURFACE_SKIN_ATTRIBUTES_MISSING",
        "skinIndex and skinWeight are required",
        id,
      );
    validateAffine(skinned.bindMatrix, mesh.uuid);
    if (skinned.bindMatrix.determinant() === 0)
      fail(
        "SURFACE_SINGULAR_TRANSFORM",
        "Skin bind matrix is singular",
        mesh.uuid,
      );
    let weightSum = 0;
    for (let j = 0; j < 4; j++) {
      const weight = finite(sw.getComponent(index, j), id, "skin weight");
      if (weight < 0)
        fail(
          "SURFACE_SKIN_WEIGHT_INVALID",
          "Skin weights must be nonnegative and normalized",
          id,
        );
      weightSum += weight;
    }
    if (Math.abs(weightSum - 1) > 1e-5)
      fail(
        "SURFACE_SKIN_WEIGHT_INVALID",
        "Normalize skin weights before extraction",
        id,
      );
    const bindInverse =
      skinned.bindMode === "attached"
        ? world.clone().invert()
        : skinned.bindMode === "detached"
          ? skinned.bindMatrix.clone().invert()
          : fail(
              "SURFACE_SKIN_BIND_MODE_UNSUPPORTED",
              `Unknown bind mode ${skinned.bindMode}`,
              mesh.uuid,
            );
    const weighted = new THREE.Matrix4().set(
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
      ),
      weightedPosition = new THREE.Vector3(),
      bindPosition = position.clone().applyMatrix4(skinned.bindMatrix);
    for (let j = 0; j < si.itemSize; j++) {
      const weight = finite(sw.getComponent(index, j), id, "skin weight");
      if (!weight) continue;
      const boneIndex = si.getComponent(index, j),
        bone = skinned.skeleton.bones[boneIndex],
        inverse = skinned.skeleton.boneInverses[boneIndex];
      if (!bone || !inverse)
        fail(
          "SURFACE_SKIN_BONE_INVALID",
          `Invalid bone index ${boneIndex}`,
          id,
        );
      const boneMatrix = worldMatrix(bone, cache).clone().multiply(inverse);
      validateAffine(boneMatrix, bone.uuid);
      for (let k = 0; k < 16; k++)
        weighted.elements[k] += boneMatrix.elements[k] * weight;
      weightedPosition.addScaledVector(
        bindPosition.clone().applyMatrix4(boneMatrix),
        weight,
      );
    }
    position.copy(weightedPosition.applyMatrix4(bindInverse));
    const skin = new THREE.Matrix3()
      .setFromMatrix4(bindInverse)
      .multiply(new THREE.Matrix3().setFromMatrix4(weighted))
      .multiply(new THREE.Matrix3().setFromMatrix4(skinned.bindMatrix));
    if (normalAttribute) normal.applyMatrix3(skin).normalize();
    if (tangent) {
      const t = new THREE.Vector3(tangent.x, tangent.y, tangent.z)
        .applyMatrix3(skin)
        .normalize();
      tangent.set(t.x, t.y, t.z, tangent.w);
    }
  }
  const read = (name: string, minimum: number): number[] | undefined => {
    const a = g.getAttribute(name) as THREE.BufferAttribute | undefined;
    if (!a) return undefined;
    if (index >= a.count)
      fail(
        "SURFACE_ATTRIBUTE_COUNT_INVALID",
        `${name} has fewer vertices than position`,
        id,
      );
    if (a.itemSize < minimum)
      fail(
        "SURFACE_ATTRIBUTE_SIZE_INVALID",
        `${name} itemSize < ${minimum}`,
        id,
      );
    return Array.from(
      { length: a.itemSize > 4 ? 4 : Math.max(minimum, a.itemSize) },
      (_, j) => finite(a.getComponent(index, j), id, name),
    );
  };
  let uv0: number[] | undefined, uv1: number[] | undefined;
  position.applyMatrix4(instance);
  let normalOverridden = false;
  if (vertexDeformer) {
    uv0 = read("uv", 2);
    uv1 = read("uv1", 2);
    const normalLocal = normal.clone();
    if (normalAttribute) {
      normalLocal
        .applyMatrix3(new THREE.Matrix3().getNormalMatrix(instance))
        .normalize();
      finiteVector(normalLocal, id, "vertex input normal");
      if (normalLocal.lengthSq() === 0)
        fail(
          "SURFACE_NORMAL_INVALID",
          "A vertex input normal must have nonzero length",
          id,
        );
    }
    finiteVector(position, id, "vertex input position");
    const result = vertexDeformer.evaluate(mesh, material.uuid, {
      positionLocal: vec(position),
      normalLocal: vec(normalLocal),
      vertexIndex: index,
      instanceIndex,
      ...(uv0 ? { uv: [uv0[0], uv0[1]] as SurfaceVec2 } : {}),
      ...(uv1 ? { uv1: [uv1[0], uv1[1]] as SurfaceVec2 } : {}),
    });
    if (result) {
      position.fromArray(result.position);
      finiteVector(position, id, "vertex output position");
      if (result.normal !== undefined) {
        if (!normalAttribute)
          fail(
            "TC_VERTEX_NORMAL_ATTRIBUTE",
            "A vertex normal graph requires a normal attribute; supply one before extraction",
            id,
          );
        normal.fromArray(result.normal);
        finiteVector(normal, id, "vertex output normal");
        if (normal.lengthSq() === 0)
          fail(
            "SURFACE_NORMAL_INVALID",
            "A vertex output normal must have nonzero length; retain the input normal for zero graph outputs",
            id,
          );
        normalOverridden = true;
      }
    }
  }
  position.applyMatrix4(world);
  finiteVector(position, id, "world position");
  if (normalAttribute)
    normal
      .applyMatrix3(
        normalOverridden
          ? new THREE.Matrix3().getNormalMatrix(world)
          : normalMatrix,
      )
      .normalize();
  if (tangent) {
    const t = new THREE.Vector3(tangent.x, tangent.y, tangent.z)
      .applyMatrix3(direction)
      .normalize();
    tangent.set(t.x, t.y, t.z, tangent.w);
  }
  if (!vertexDeformer) {
    uv0 = read("uv", 2);
    uv1 = read("uv1", 2);
  }
  const colorAttribute = g.getAttribute("color") as
    | THREE.BufferAttribute
    | undefined;
  let color = read("color", 3);
  if (color && material.vertexColors && g.morphAttributes.color?.length) {
    const c = morphed(g, "color", index, weights, id);
    color = [c.x, c.y, c.z, colorAttribute?.itemSize === 4 ? c.w : 1];
  } else if (color && color.length === 3) color.push(1);
  if (!normalAttribute) normal.set(0, 0, 0);
  else if (normal.lengthSq() === 0)
    fail(
      "SURFACE_NORMAL_INVALID",
      "A normal attribute must have nonzero length",
      id,
    );
  if (
    tangent &&
    (new THREE.Vector3(tangent.x, tangent.y, tangent.z).lengthSq() === 0 ||
      Math.abs(tangent.w) !== 1)
  )
    fail(
      "SURFACE_TANGENT_INVALID",
      "Tangent must be nonzero and handedness must be +/-1",
      id,
    );
  finiteVector(normal, id, "world normal");
  if (tangent)
    for (const n of tangent.toArray()) finite(n, id, "world tangent");
  return {
    position: vec(position),
    normal: vec(normal),
    ...(uv0 ? { uv0: uv0.slice(0, 2) as unknown as SurfaceVec2 } : {}),
    ...(uv1 ? { uv1: uv1.slice(0, 2) as unknown as SurfaceVec2 } : {}),
    ...(tangent ? { tangent: tangent.toArray() as SurfaceVec4 } : {}),
    ...(color ? { color: color as unknown as SurfaceVec4 } : {}),
  };
}
type Segment = {
  start: number;
  end: number;
  materialIndex: number;
  groupIndex: number;
};
function drawSegments(
  g: THREE.BufferGeometry,
  assigned: THREE.Material | THREE.Material[],
): Segment[] {
  const count = g.index?.count ?? g.getAttribute("position")?.count;
  if (count === undefined)
    fail("SURFACE_POSITION_MISSING", "Mesh has no position attribute", g.uuid);
  const rs = g.drawRange.start,
    re = Number.isFinite(g.drawRange.count) ? rs + g.drawRange.count : count;
  if (
    !Number.isInteger(rs) ||
    rs < 0 ||
    !(Number.isInteger(g.drawRange.count) || g.drawRange.count === Infinity) ||
    g.drawRange.count < 0
  )
    fail("SURFACE_DRAW_RANGE_INVALID", "drawRange is invalid", g.uuid);
  const intersect = (
    start: number,
    end: number,
    materialIndex: number,
    groupIndex: number,
  ): Segment[] => {
    const a = Math.max(0, start, rs),
      b = Math.min(count, end, re);
    if (b <= a) return [];
    if (a % 3 !== 0 || (b - a) % 3 !== 0)
      fail(
        "SURFACE_TRIANGLE_BOUNDARY_INVALID",
        "drawRange/group intersection is not triangle aligned",
        g.uuid,
      );
    return [{ start: a, end: b, materialIndex, groupIndex }];
  };
  if (!Array.isArray(assigned)) return intersect(0, count, 0, -1);
  const out: Segment[] = [];
  g.groups.forEach((group, groupIndex) => {
    const materialIndex = group.materialIndex ?? 0;
    if (
      !Number.isInteger(group.start) ||
      group.start < 0 ||
      !(Number.isInteger(group.count) || group.count === Infinity) ||
      group.count < 0 ||
      !Number.isInteger(materialIndex) ||
      materialIndex < 0
    )
      fail("SURFACE_GROUP_INVALID", "Geometry group is invalid", g.uuid);
    out.push(
      ...intersect(
        group.start,
        group.start + group.count,
        materialIndex,
        groupIndex,
      ),
    );
  });
  return out;
}

function validateGeometry(g: THREE.BufferGeometry, identity: string): void {
  for (const [name, expectedSizes] of Object.entries({
    position: [3],
    normal: [3],
    tangent: [4],
    color: [3, 4],
    uv: [2],
    uv1: [2],
    skinIndex: [4],
    skinWeight: [4],
  })) {
    const attribute = g.getAttribute(name);
    if (!attribute) continue;
    if (
      !(
        (attribute as THREE.BufferAttribute).isBufferAttribute ||
        (attribute as THREE.InterleavedBufferAttribute)
          .isInterleavedBufferAttribute
      ) ||
      !expectedSizes.includes(attribute.itemSize)
    )
      fail(
        "SURFACE_ATTRIBUTE_UNSUPPORTED",
        `${name} must be a readable CPU attribute with itemSize ${expectedSizes.join("/")}`,
        identity,
      );
    if (
      (attribute as THREE.InstancedBufferAttribute)
        .isInstancedBufferAttribute ||
      (
        (attribute as THREE.InterleavedBufferAttribute).data as unknown as
          | { isInstancedInterleavedBuffer?: boolean }
          | undefined
      )?.isInstancedInterleavedBuffer
    )
      fail(
        "SURFACE_DEFORMATION_UNSUPPORTED",
        `Instanced attribute ${name} requires an explicit deformation adapter`,
        identity,
      );
    if (attribute.count !== g.getAttribute("position").count)
      fail(
        "SURFACE_ATTRIBUTE_COUNT_INVALID",
        `${name} vertex count differs from position`,
        identity,
      );
  }
  if (g.index && g.index.itemSize !== 1)
    fail("SURFACE_INDEX_INVALID", "Index itemSize must be one", identity);
}

function meshSignature(
  mesh: THREE.Mesh,
  world: THREE.Matrix4,
  worldCache: Map<THREE.Object3D, THREE.Matrix4>,
  resolved: ReadonlyMap<Segment, SurfaceMaterial | undefined>,
  vertexDeformer?: SurfaceVertexDeformer,
): unknown[] {
  const g = mesh.geometry,
    signature: unknown[] = [
      mesh.uuid,
      mesh.castShadow,
      mesh.receiveShadow,
      g,
      g.uuid,
      g.type,
      g.drawRange.start,
      g.drawRange.count,
      g.morphTargetsRelative,
    ];
  const attribute = (
    a:
      | THREE.BufferAttribute
      | THREE.InterleavedBufferAttribute
      | null
      | undefined,
  ) => {
    if (!a) {
      signature.push(a);
      return;
    }
    const ordinary = a as THREE.BufferAttribute,
      interleaved = a as THREE.InterleavedBufferAttribute,
      data = interleaved.data;
    signature.push(
      a,
      a.constructor,
      a.count,
      a.itemSize,
      a.normalized,
      ordinary.version,
      ordinary.isBufferAttribute,
      ordinary.gpuType,
      (
        ordinary as THREE.BufferAttribute & {
          isFloat16BufferAttribute?: boolean;
        }
      ).isFloat16BufferAttribute,
      interleaved.isInterleavedBufferAttribute,
      interleaved.offset,
      data,
      data?.version,
      data?.stride,
      data?.count,
      a.array,
      a.array?.constructor,
      a.array?.length,
      a.getX,
      a.getY,
      a.getZ,
      a.getW,
      a.getComponent,
    );
  };
  attribute(g.index);
  const attributes = Object.entries(g.attributes);
  signature.push(attributes.length);
  for (const [name, a] of attributes) {
    signature.push(name);
    attribute(a);
  }
  const morphs = Object.entries(g.morphAttributes);
  signature.push(morphs.length);
  for (const [name, targets] of morphs) {
    signature.push(name, targets?.length);
    for (const a of targets ?? []) attribute(a);
  }
  signature.push(g.groups.length);
  for (const group of g.groups)
    signature.push(group.start, group.count, group.materialIndex);
  const assigned = Array.isArray(mesh.material)
    ? mesh.material
    : [mesh.material];
  signature.push(Array.isArray(mesh.material), assigned.length);
  for (const m of assigned) signature.push(m, m?.uuid, m?.visible);
  for (const [segment, m] of resolved)
    signature.push(
      segment.start,
      segment.end,
      segment.materialIndex,
      segment.groupIndex,
      m?.uuid,
      m?.side,
      m?.flatShading,
      m?.vertexColors,
    );
  const chain = (object: THREE.Object3D) => {
    const seen = new Set<THREE.Object3D>();
    for (
      let current: THREE.Object3D | null = object;
      current;
      current = current.parent
    ) {
      if (seen.has(current))
        fail("SURFACE_TRANSFORM_UNSUPPORTED", "Cyclic ancestry", object.uuid);
      seen.add(current);
      signature.push(
        current,
        current.uuid,
        current.visible,
        current.layers.mask,
        current.matrixAutoUpdate,
        current.matrixWorldAutoUpdate,
        ...localMatrix(current).elements,
        ...current.matrix.elements,
        ...current.matrixWorld.elements,
      );
    }
    signature.push(null);
  };
  chain(mesh);
  signature.push(
    ...world.elements,
    mesh.morphTargetInfluences?.length,
    ...(mesh.morphTargetInfluences ?? []),
  );
  if ((mesh as THREE.InstancedMesh).isInstancedMesh) {
    const instanced = mesh as THREE.InstancedMesh;
    signature.push(instanced.count);
    attribute(instanced.instanceMatrix);
    attribute(instanced.instanceColor);
    // setMatrixAt/setColorAt do not bump attribute versions. Transforms and
    // instance colors are cheap scalar state and must be observed immediately.
    for (let i = 0; i < instanced.count * 16; i++)
      signature.push(instanced.instanceMatrix.array[i]);
    if (instanced.instanceColor)
      for (
        let i = 0;
        i < instanced.count * instanced.instanceColor.itemSize;
        i++
      )
        signature.push(instanced.instanceColor.array[i]);
  }
  if ((mesh as THREE.SkinnedMesh).isSkinnedMesh) {
    const skin = mesh as THREE.SkinnedMesh,
      skeleton = skin.skeleton;
    signature.push(
      skeleton,
      skin.bindMode,
      ...skin.bindMatrix.elements,
      ...skin.bindMatrixInverse.elements,
      skeleton?.bones.length,
      skeleton?.boneInverses.length,
    );
    for (const bone of skeleton?.bones ?? []) {
      signature.push(bone);
      if (bone) {
        chain(bone);
        signature.push(...worldMatrix(bone, worldCache).elements);
      }
    }
    for (const inverse of skeleton?.boneInverses ?? [])
      signature.push(inverse, ...(inverse?.elements ?? []));
  }
  signature.push(vertexDeformer !== undefined);
  if (vertexDeformer) {
    const state = vertexDeformer.signature(mesh);
    signature.push(state.length);
    for (const value of state) signature.push(value);
  }
  return signature;
}

/** Private CPU-to-GPU preparation interface. Captures current world-space scene surfaces without mutating Three objects. */
export function extractSurfaceScene(
  scene: THREE.Scene,
  options: SurfaceExtractionOptions = {},
): SurfaceScene {
  options.meshCache?.assertActive();
  if (THREE.ColorManagement.workingColorSpace !== THREE.LinearSRGBColorSpace)
    fail(
      "SURFACE_WORKING_COLOR_SPACE_UNSUPPORTED",
      "CPU reference requires Three working LinearSRGBColorSpace",
      scene.uuid,
    );
  rejectExtensions(scene.userData, scene.uuid);
  if (scene.overrideMaterial)
    fail(
      "SURFACE_SCENE_OVERRIDE_UNSUPPORTED",
      "scene.overrideMaterial requires an explicit surface adapter",
      scene.uuid,
    );
  const triangles: SurfaceTriangle[] = [],
    materials: SurfaceMaterial[] = [],
    textures: SurfaceTexture[] = [],
    diagnostics: SurfaceDiagnostic[] = [];
  const byMaterial = new Map<THREE.Material, SurfaceMaterial>(),
    adaptedMaterials = new Map<THREE.Material, THREE.Material>(),
    byTexture = new Map<THREE.Texture, SurfaceTexture>(),
    worldCache = new Map<THREE.Object3D, THREE.Matrix4>(),
    layerMask = options.layersMask ?? 0xffffffff;
  if (scene.environment || scene.background || scene.fog)
    diagnostics.push({
      code: "SURFACE_SCENE_EFFECTS_NOT_CAPTURED",
      message:
        "Scene environment/background/fog are outside the surface contract",
      objectUuid: scene.uuid,
    });
  const visit = (object: THREE.Object3D, visible: boolean): void => {
    if (!visible || !object.visible) return;
    if (
      !object.userData.noTrace &&
      (object as unknown as { isMesh?: boolean }).isMesh === true &&
      object.layers.mask & layerMask &&
      (options.meshFilter?.(object as THREE.Mesh) ?? true)
    ) {
      const mesh = object as THREE.Mesh,
        g = mesh.geometry;
      if (!g)
        fail(
          "SURFACE_GEOMETRY_MISSING",
          "Mesh requires BufferGeometry",
          mesh.uuid,
        );
      if (
        (g as unknown as { isBufferGeometry?: boolean }).isBufferGeometry !==
          true ||
        g.type === "InstancedBufferGeometry" ||
        (mesh as unknown as { isBatchedMesh?: boolean }).isBatchedMesh
      )
        fail(
          "SURFACE_GEOMETRY_UNSUPPORTED",
          "Only ordinary BufferGeometry is supported",
          mesh.uuid,
        );
      if (
        mesh.constructor !== THREE.Mesh &&
        mesh.constructor !== THREE.SkinnedMesh &&
        mesh.constructor !== THREE.InstancedMesh
      )
        fail(
          "SURFACE_DEFORMATION_UNSUPPORTED",
          `Custom mesh/deformation ${mesh.constructor.name} is unsupported`,
          mesh.uuid,
        );
      if (
        mesh.onBeforeRender.toString() !==
        THREE.Object3D.prototype.onBeforeRender.toString()
      )
        fail(
          "SURFACE_CUSTOM_RENDER_HOOK_UNSUPPORTED",
          "Custom onBeforeRender is unsupported",
          mesh.uuid,
        );
      const nativeVertex = (mesh as unknown as { isSkinnedMesh?: boolean })
        .isSkinnedMesh
        ? THREE.SkinnedMesh.prototype.getVertexPosition
        : THREE.Mesh.prototype.getVertexPosition;
      if (mesh.getVertexPosition !== nativeVertex)
        fail(
          "SURFACE_DEFORMATION_UNSUPPORTED",
          "Overridden getVertexPosition is unsupported; use ordinary mesh/morph/skin state",
          mesh.uuid,
        );
      rejectExtensions(mesh.userData, mesh.uuid);
      rejectExtensions(g.userData, g.uuid);
      const position = g.getAttribute("position");
      if (!position || position.itemSize < 3)
        fail(
          "SURFACE_POSITION_MISSING",
          "position itemSize >= 3 is required",
          mesh.uuid,
        );
      validateGeometry(g, `${mesh.uuid}/${g.uuid}`);
      for (const name of Object.keys(g.morphAttributes))
        if (!["position", "normal", "color"].includes(name))
          fail(
            "SURFACE_MORPH_ATTRIBUTE_UNSUPPORTED",
            `Morph attribute ${name} is unsupported`,
            mesh.uuid,
          );
      if (
        (mesh as unknown as { isInstancedMesh?: boolean }).isInstancedMesh &&
        (mesh as THREE.InstancedMesh).morphTexture
      )
        fail(
          "SURFACE_INSTANCE_MORPH_UNSUPPORTED",
          "Instanced per-instance morph weights are unsupported",
          mesh.uuid,
        );
      const assigned = mesh.material,
        segments = drawSegments(g, assigned),
        world = worldMatrix(mesh, worldCache),
        isInstanced =
          (mesh as unknown as { isInstancedMesh?: boolean }).isInstancedMesh ===
          true,
        count = isInstanced ? (mesh as THREE.InstancedMesh).count : 1;
      if (
        !Number.isInteger(count) ||
        count < 0 ||
        (isInstanced &&
          count > (mesh as THREE.InstancedMesh).instanceMatrix.count)
      )
        fail(
          "SURFACE_INSTANCE_COUNT_INVALID",
          "InstancedMesh.count exceeds matrix attributes",
          mesh.uuid,
        );
      const resolved = new Map<Segment, SurfaceMaterial | undefined>();
      const materialFor = (segment: Segment): SurfaceMaterial | undefined => {
        const m = Array.isArray(assigned)
          ? assigned[segment.materialIndex]
          : assigned;
        if (!m)
          fail(
            "SURFACE_MATERIAL_INDEX_MISSING",
            "Group references missing material " + segment.materialIndex,
            mesh.uuid + "/" + g.uuid,
          );
        if (!m.visible) return undefined;
        let adapted = adaptedMaterials.get(m);
        if (!adapted) {
          adapted = options.materialAdapter?.(m) ?? m;
          adaptedMaterials.set(m, adapted);
        }
        const material = snapshotMaterial(
          adapted,
          materials,
          byMaterial,
          textures,
          byTexture,
          options,
          diagnostics,
          m,
        );
        if (
          material.maps.normalMap &&
          !g.hasAttribute("tangent") &&
          !diagnostics.some(
            (d) =>
              d.code === "SURFACE_NORMAL_FRAME_REFERENCE_ONLY" &&
              d.objectUuid === mesh.uuid,
          )
        )
          diagnostics.push({
            code: "SURFACE_NORMAL_FRAME_REFERENCE_ONLY",
            message:
              "Missing tangent: CPU reference derives an orthonormal triangle frame from this normal map's transformed UVs. This is not a pixel-identical implementation of Three WebGPU derivative TBN.",
            objectUuid: mesh.uuid,
            materialUuid: material.uuid,
          });
        return material;
      };
      if (options.meshCache && count > 0)
        for (const segment of segments)
          resolved.set(segment, materialFor(segment));
      const signature = options.meshCache
          ? meshSignature(
              mesh,
              world,
              worldCache,
              resolved,
              options.vertexDeformer,
            )
          : undefined,
        cached = signature
          ? options.meshCache!.get(mesh, signature)
          : undefined,
        firstTriangle = triangles.length;
      if (cached) {
        // Do not spread: a content-owned mesh can contain more than the argument limit.
        for (const triangle of cached) triangles.push(triangle);
      } else {
        for (let instanceId = 0; instanceId < count; instanceId++) {
          const instance = new THREE.Matrix4();
          let instanceColor: SurfaceVec3 | undefined;
          if (isInstanced) {
            const instanced = mesh as THREE.InstancedMesh;
            instanced.getMatrixAt(instanceId, instance);
            if (instanced.instanceColor) {
              const color = new THREE.Color();
              instanced.getColorAt(instanceId, color);
              instanceColor = [color.r, color.g, color.b];
            }
          }
          const combined = world.clone().multiply(instance),
            determinant = finite(
              combined.determinant(),
              mesh.uuid,
              "transform determinant",
            );
          validateAffine(instance, `${mesh.uuid}/instance/${instanceId}`);
          if (instanceColor)
            for (const n of instanceColor)
              finite(n, mesh.uuid, "instance color");
          if (determinant === 0)
            fail(
              "SURFACE_SINGULAR_TRANSFORM",
              "Combined world/instance transform is singular",
              mesh.uuid,
            );
          const normalMatrix = new THREE.Matrix3().getNormalMatrix(combined),
            direction = new THREE.Matrix3().setFromMatrix4(combined);
          for (const n of normalMatrix.elements)
            finite(n, mesh.uuid, "inverse-transpose normal matrix");
          for (const segment of segments) {
            const material = options.meshCache
              ? resolved.get(segment)
              : materialFor(segment);
            if (!material) continue;
            for (
              let offset = segment.start;
              offset < segment.end;
              offset += 3
            ) {
              const indices = [0, 1, 2].map(
                (k) => g.index?.getX(offset + k) ?? offset + k,
              ) as [number, number, number];
              for (const i of indices)
                if (!Number.isInteger(i) || i < 0 || i >= position.count)
                  fail(
                    "SURFACE_INDEX_INVALID",
                    `Vertex index ${i} is out of range`,
                    g.uuid,
                  );
              const vertices = indices.map((i) =>
                getVertex(
                  mesh,
                  i,
                  instance,
                  normalMatrix,
                  world,
                  direction,
                  material,
                  worldCache,
                  instanceId,
                  options.vertexDeformer,
                ),
              ) as [SurfaceVertex, SurfaceVertex, SurfaceVertex];
              const p = vertices.map((v) => new THREE.Vector3(...v.position)),
                face = p[1].sub(p[0]).cross(p[2].sub(p[0]));
              finiteVector(face, g.uuid, "triangle cross product");
              if (face.lengthSq() === 0)
                fail(
                  "SURFACE_DEGENERATE_TRIANGLE",
                  "Cannot generate a face normal for a degenerate triangle",
                  g.uuid,
                );
              if (!g.hasAttribute("normal") || material.flatShading) {
                face.normalize();
                for (const v of vertices)
                  (v as { normal: SurfaceVec3 }).normal = vec(face);
              }
              for (const v of vertices)
                for (const n of [
                  ...v.position,
                  ...v.normal,
                  ...(v.uv0 ?? []),
                  ...(v.uv1 ?? []),
                  ...(v.tangent ?? []),
                  ...(v.color ?? []),
                ])
                  finite(n, mesh.uuid, "vertex attribute");
              triangles.push({
                objectUuid: mesh.uuid,
                geometryUuid: g.uuid,
                instanceId,
                castShadow: mesh.castShadow,
                receiveShadow: mesh.receiveShadow,
                ...(instanceColor ? { instanceColor } : {}),
                materialUuid: material.uuid,
                materialIndex: segment.materialIndex,
                groupIndex: segment.groupIndex,
                elementOffset: offset,
                vertexIndices: indices,
                vertices,
                normalMatrix: normalMatrix.elements.slice(),
              });
            }
          }
        }
        if (signature)
          options.meshCache!.set(
            mesh,
            signature,
            triangles.slice(firstTriangle),
          );
      }
    } else if (
      !object.userData.noTrace &&
      ((
        object as unknown as {
          isPoints?: boolean;
          isLine?: boolean;
          isSprite?: boolean;
        }
      ).isPoints ||
        (object as unknown as { isLine?: boolean }).isLine ||
        (object as unknown as { isSprite?: boolean }).isSprite)
    ) {
      diagnostics.push({
        code: "SURFACE_RENDERABLE_UNSUPPORTED",
        message: `${object.type} is outside triangle surface extraction`,
        objectUuid: object.uuid,
      });
    }
    if (
      (object as unknown as { isLight?: boolean }).isLight &&
      object.layers.mask & layerMask
    )
      diagnostics.push({
        code: "SURFACE_LIGHT_NOT_CAPTURED",
        message: "Lights are outside the material surface contract",
        objectUuid: object.uuid,
      });
    for (const child of object.children) visit(child, true);
  };
  visit(scene, true);
  const captured = freezeDeep({
    version: 1 as const,
    triangles,
    materials,
    textures,
    diagnostics,
  });
  capturedSurfaces.add(captured);
  capturedGeometry.add(captured.triangles);
  for (const triangle of captured.triangles) capturedTriangles.add(triangle);
  return captured;
}
function textureById(
  snapshot: SurfaceScene,
  id: string,
  material: SurfaceMaterial,
): SurfaceTexture {
  const texture = snapshot.textures.find((t) => t.uuid === id);
  if (!texture)
    return fail(
      "SURFACE_TEXTURE_ID_MISSING",
      `Missing texture ${id}`,
      material.uuid,
    );
  if (!texture.pixels)
    return fail(
      "SURFACE_TEXTURE_PIXELS_UNAVAILABLE",
      "CPU sampling requires decoded pixels",
      texture.uuid,
    );
  if (texture.mapping !== THREE.UVMapping || texture.channel > 1)
    return fail(
      "SURFACE_TEXTURE_SAMPLING_UNSUPPORTED",
      "Mapping/channel is unsupported",
      texture.uuid,
    );
  return texture;
}
function wrapIndex(i: number, size: number, mode: number): number {
  if (mode === THREE.RepeatWrapping) return ((i % size) + size) % size;
  if (mode === THREE.MirroredRepeatWrapping) {
    const t = ((i % (2 * size)) + 2 * size) % (2 * size);
    return t < size ? t : 2 * size - 1 - t;
  }
  if (mode === THREE.ClampToEdgeWrapping)
    return Math.max(0, Math.min(size - 1, i));
  return fail("SURFACE_WRAP_UNSUPPORTED", `Unknown wrap mode ${mode}`);
}
function sampleTexture(
  t: SurfaceTexture,
  uv: SurfaceVec2,
  footprint: "magnification" | "minification",
): SurfaceVec4 {
  if (!t.pixels || t.width < 1 || t.height < 1)
    return fail(
      "SURFACE_TEXTURE_PIXELS_UNAVAILABLE",
      "CPU pixels are unavailable",
      t.uuid,
    );
  const m = t.matrix,
    q = m[2] * uv[0] + m[5] * uv[1] + m[8];
  if (!q)
    return fail(
      "SURFACE_UV_TRANSFORM_INVALID",
      "UV transform has homogeneous w=0",
      t.uuid,
    );
  let u = (m[0] * uv[0] + m[3] * uv[1] + m[6]) / q,
    v = (m[1] * uv[0] + m[4] * uv[1] + m[7]) / q;
  const wrap = (x: number, mode: number): number => {
    if (mode === THREE.ClampToEdgeWrapping) return Math.max(0, Math.min(1, x));
    if (mode === THREE.RepeatWrapping) return ((x % 1) + 1) % 1;
    if (mode === THREE.MirroredRepeatWrapping) {
      const r = ((x % 2) + 2) % 2;
      return r <= 1 ? r : 2 - r;
    }
    return fail(
      "SURFACE_WRAP_UNSUPPORTED",
      `Unknown wrap mode ${mode}`,
      t.uuid,
    );
  };
  u = wrap(u, t.wrapS);
  v = wrap(v, t.wrapT);
  const filter = footprint === "magnification" ? t.magFilter : t.minFilter;
  const nearest = [
    THREE.NearestFilter,
    THREE.NearestMipmapNearestFilter,
    THREE.NearestMipmapLinearFilter,
  ].includes(filter as never);
  const linear = [
    THREE.LinearFilter,
    THREE.LinearMipmapNearestFilter,
    THREE.LinearMipmapLinearFilter,
  ].includes(filter as never);
  if (!nearest && !linear)
    return fail(
      "SURFACE_FILTER_UNSUPPORTED",
      `Filter ${filter} is unsupported`,
      t.uuid,
    );
  const read = (x: number, y: number): SurfaceVec4 => {
    const i =
      (wrapIndex(y, t.height, t.wrapT) * t.width +
        wrapIndex(x, t.width, t.wrapS)) *
      4;
    const rgb = [t.pixels![i], t.pixels![i + 1], t.pixels![i + 2]];
    if (t.colorSpace === THREE.SRGBColorSpace)
      for (let c = 0; c < 3; c++) rgb[c] = srgbToLinear(rgb[c]);
    else if (
      t.colorSpace !== THREE.NoColorSpace &&
      t.colorSpace !== THREE.LinearSRGBColorSpace
    )
      fail(
        "SURFACE_COLOR_SPACE_UNSUPPORTED",
        `Cannot sample ${t.colorSpace}`,
        t.uuid,
      );
    return [rgb[0], rgb[1], rgb[2], t.pixels![i + 3]];
  };
  if (nearest) return read(Math.floor(u * t.width), Math.floor(v * t.height));
  const x = u * t.width - 0.5,
    y = v * t.height - 0.5,
    x0 = Math.floor(x),
    y0 = Math.floor(y),
    tx = x - x0,
    ty = y - y0;
  const a = read(x0, y0),
    b = read(x0 + 1, y0),
    c = read(x0, y0 + 1),
    d = read(x0 + 1, y0 + 1);
  return [0, 1, 2, 3].map((i) =>
    THREE.MathUtils.lerp(
      THREE.MathUtils.lerp(a[i], b[i], tx),
      THREE.MathUtils.lerp(c[i], d[i], tx),
      ty,
    ),
  ) as unknown as SurfaceVec4;
}
/** Engine-private base-level sampler shared with material surface sampling. */
export function sampleSurfaceTexture(
  texture: SurfaceTexture,
  uv: SurfaceVec2,
): SurfaceVec4 {
  for (const value of uv) finite(value, texture.uuid, "sample UV");
  return sampleTexture(texture, uv, "magnification");
}
function interpolateUV(
  triangle: SurfaceTriangle,
  channel: 0 | 1,
  bary: SurfaceVec3,
): SurfaceVec2 | undefined {
  const key = channel === 0 ? "uv0" : "uv1",
    values = triangle.vertices.map((v) => v[key]);
  if (values.some((v) => !v)) return undefined;
  return [0, 1].map((axis) =>
    values.reduce((sum, uv, i) => sum + uv![axis] * bary[i], 0),
  ) as unknown as SurfaceVec2;
}
/** CPU reference for declared solid/DataTexture/provider-backed maps; this is not a shader, BSDF, tracer, or lighting implementation. */
export function sampleSurfaceMaterial(
  snapshot: SurfaceScene,
  triangleOrIndex: number | SurfaceTriangle,
  barycentric: SurfaceVec3,
  options: SurfaceSampleOptions = {},
): SurfaceMaterialSample {
  const tri =
    typeof triangleOrIndex === "number"
      ? snapshot.triangles[triangleOrIndex]
      : triangleOrIndex;
  if (!tri)
    return fail(
      "SURFACE_TRIANGLE_INDEX_INVALID",
      "Triangle is absent from snapshot",
    );
  const material = snapshot.materials.find((m) => m.uuid === tri.materialUuid);
  if (!material)
    return fail(
      "SURFACE_MATERIAL_ID_MISSING",
      `Missing material ${tri.materialUuid}`,
    );
  if (
    barycentric.some((v) => !Number.isFinite(v) || v < 0 || v > 1) ||
    Math.abs(barycentric[0] + barycentric[1] + barycentric[2] - 1) > 1e-6
  )
    fail(
      "SURFACE_BARYCENTRIC_INVALID",
      "Coordinates must be finite and sum to one",
      tri.geometryUuid,
    );
  const frontFacing = options.frontFacing ?? true,
    discarded =
      (material.transmission ?? 0) === 0 &&
      ((material.side === "front" && !frontFacing) ||
        (material.side === "back" && frontFacing));
  const blend = (key: "normal" | "color"): number[] =>
    [0, 1, 2, 3].map((axis) =>
      tri.vertices.reduce(
        (sum, v, i) =>
          sum +
          ((v[key] as readonly number[] | undefined)?.[axis] ??
            (axis === 3 ? 1 : key === "color" ? 1 : 0)) *
            barycentric[i],
        0,
      ),
    );
  let normal = new THREE.Vector3(...blend("normal").slice(0, 3));
  if (!normal.lengthSq()) {
    const p = tri.vertices.map((v) => new THREE.Vector3(...v.position));
    normal = p[1].sub(p[0]).cross(p[2].sub(p[0])).normalize();
  }
  if (
    (material.transmission ?? 0) > 0
      ? !frontFacing
      : material.side === "back" || (material.side === "double" && !frontFacing)
  )
    normal.negate();
  normal.normalize();
  const color = [...material.baseColor],
    vertexColor = blend("color");
  if (material.vertexColors && tri.vertices.some((v) => v.color))
    for (let i = 0; i < 4; i++) color[i] *= vertexColor[i];
  if (tri.instanceColor)
    for (let i = 0; i < 3; i++) color[i] *= tri.instanceColor[i];
  const uvFor = (t: SurfaceTexture): SurfaceVec2 => {
    const uv =
      (t.channel === 0 ? options.uv0 : options.uv1) ??
      interpolateUV(tri, t.channel as 0 | 1, barycentric);
    if (!uv)
      return fail(
        "SURFACE_UV_MISSING",
        `Texture ${t.uuid} requires uv${t.channel}`,
        t.uuid,
      );
    for (const value of uv) finite(value, t.uuid, "sample UV");
    return uv;
  };
  const map = (
    slot: SurfaceMapSlot,
  ): { texture: SurfaceTexture; value: SurfaceVec4 } | undefined => {
    const id = material.maps[slot];
    if (!id) return undefined;
    const texture = textureById(snapshot, id, material);
    return {
      texture,
      value: sampleTexture(
        texture,
        uvFor(texture),
        options.footprint ?? "magnification",
      ),
    };
  };
  const baseMap = map("map"),
    alphaMap = map("alphaMap");
  if (baseMap) for (let i = 0; i < 4; i++) color[i] *= baseMap.value[i];
  if (alphaMap) color[3] *= alphaMap.value[1];
  const roughnessMap = map("roughnessMap"),
    metalnessMap = map("metalnessMap"),
    aoMap = map("aoMap"),
    emissiveMap = map("emissiveMap"),
    normalMap = map("normalMap"),
    specularIntensityMap = map("specularIntensityMap"),
    specularColorMap = map("specularColorMap");
  const roughness = material.roughness * (roughnessMap?.value[1] ?? 1),
    metalness = material.metalness * (metalnessMap?.value[2] ?? 1),
    specularIntensity = (material.specularIntensity ?? 1) * (specularIntensityMap?.value[3] ?? 1),
    specularColor = (material.specularColor ?? [1, 1, 1]).map(
      (v, i) => v * (specularColorMap?.value[i] ?? 1),
    ) as [number, number, number];
  const occlusion = 1 + ((aoMap?.value[0] ?? 1) - 1) * material.aoMapIntensity;
  const emissive = material.emissive.map(
    (v, i) => v * material.emissiveIntensity * (emissiveMap?.value[i] ?? 1),
  ) as [number, number, number];
  if (normalMap) {
    const sampled = new THREE.Vector3(
      normalMap.value[0] * 2 - 1,
      normalMap.value[1] * 2 - 1,
      normalMap.value[2] * 2 - 1,
    );
    sampled.x *= material.normalScale[0];
    sampled.y *= material.normalScale[1];
    const sideSign = (
      (material.transmission ?? 0) > 0
        ? !frontFacing
        : material.side === "back" ||
          (material.side === "double" && !frontFacing)
    )
      ? -1
      : 1;
    if (material.normalMapType === THREE.ObjectSpaceNormalMap)
      normal = sampled
        .applyMatrix3(new THREE.Matrix3().fromArray(tri.normalMatrix))
        .multiplyScalar(sideSign)
        .normalize();
    else if (material.normalMapType === THREE.TangentSpaceNormalMap) {
      let tangent: THREE.Vector3, handedness: number;
      if (tri.vertices.every((v) => v.tangent)) {
        tangent = tri.vertices
          .reduce(
            (sum, v, i) =>
              sum.addScaledVector(
                new THREE.Vector3(
                  ...(v.tangent!.slice(0, 3) as [number, number, number]),
                ),
                barycentric[i],
              ),
            new THREE.Vector3(),
          )
          .normalize();
        handedness =
          Math.sign(
            tri.vertices.reduce(
              (sum, v, i) => sum + v.tangent![3] * barycentric[i],
              0,
            ),
          ) || 1;
        tangent.multiplyScalar(sideSign);
      } else {
        const key = normalMap.texture.channel === 0 ? "uv0" : "uv1",
          uvs = tri.vertices.map((v) => v[key]);
        if (uvs.some((v) => !v))
          fail(
            "SURFACE_UV_MISSING",
            `Normal map ${normalMap.texture.uuid} requires UVs`,
            normalMap.texture.uuid,
          );
        const m = normalMap.texture.matrix,
          transform = (uv: SurfaceVec2) => [
            m[0] * uv[0] + m[3] * uv[1] + m[6],
            m[1] * uv[0] + m[4] * uv[1] + m[7],
          ];
        const a = transform(uvs[0]!),
          b = transform(uvs[1]!),
          c = transform(uvs[2]!),
          du1 = b[0] - a[0],
          dv1 = b[1] - a[1],
          du2 = c[0] - a[0],
          dv2 = c[1] - a[1],
          det = du1 * dv2 - du2 * dv1;
        if (det === 0)
          fail(
            "SURFACE_NORMAL_TANGENT_DEGENERATE",
            "UVs do not define a tangent frame",
            tri.geometryUuid,
          );
        const p = tri.vertices.map((v) => new THREE.Vector3(...v.position));
        const edge1 = p[1].sub(p[0]),
          edge2 = p[2].sub(p[0]);
        tangent = edge1
          .clone()
          .multiplyScalar(dv2)
          .addScaledVector(edge2, -dv1)
          .multiplyScalar(1 / det);
        const derivativeB = edge2
          .clone()
          .multiplyScalar(du1)
          .addScaledVector(edge1, -du2)
          .multiplyScalar(1 / det);
        tangent
          .addScaledVector(normal, -tangent.dot(normal))
          .normalize()
          .multiplyScalar(sideSign);
        handedness = Math.sign(
          new THREE.Vector3().crossVectors(normal, tangent).dot(derivativeB),
        );
        if (!handedness || tangent.lengthSq() === 0)
          fail(
            "SURFACE_NORMAL_TANGENT_DEGENERATE",
            "UV derivatives and shading normal cannot define an orthonormal tangent frame",
            tri.geometryUuid,
          );
      }
      const bitangent = new THREE.Vector3()
        .crossVectors(normal, tangent)
        .multiplyScalar(handedness * sideSign)
        .normalize();
      normal = tangent
        .multiplyScalar(sampled.x)
        .addScaledVector(bitangent, sampled.y)
        .addScaledVector(normal, sampled.z)
        .normalize();
    } else
      fail(
        "SURFACE_NORMAL_MAP_TYPE_UNSUPPORTED",
        `Unknown normal map type ${material.normalMapType}`,
        material.uuid,
      );
  }
  const alpha = color[3];
  for (const n of [
    ...color,
    roughness,
    metalness,
    specularIntensity,
    ...specularColor,
    occlusion,
    ...emissive,
    ...normal.toArray(),
  ])
    finite(n, material.uuid, "sample result");
  if (normal.lengthSq() === 0)
    fail(
      "SURFACE_NORMAL_INVALID",
      "Sampled normal has zero length",
      material.uuid,
    );
  const alphaDiscarded = material.alphaTest > 0 && alpha <= material.alphaTest;
  const coverage =
    discarded || alphaDiscarded
      ? 0
      : material.alphaMode === "blend"
        ? alpha
        : 1;
  return {
    materialUuid: material.uuid,
    discarded: discarded || alphaDiscarded,
    alphaMode: material.alphaMode,
    alpha,
    coverage,
    baseColor: color.slice(0, 3) as unknown as SurfaceVec3,
    roughness,
    metalness,
    specularIntensity,
    specularColor,
    occlusion,
    emissive,
    normal: vec(normal.normalize()),
  };
}
