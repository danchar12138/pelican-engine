import * as THREE from "three/webgpu";
import {
  cubeTexture,
  equirectUV,
  float,
  screenUV,
  texture,
  vec3,
  vec4,
} from "three/tsl";

export interface EnvironmentRadiance {
  readonly uuid: string;
  /** Texture.version at submission, not Source.version or PMREM roughness. */
  readonly sourceVersion: number;
  readonly width: number;
  readonly height: number;
  /** Linear-sRGB HDR RGBA, row 0 north (+Y); each result owns this buffer. */
  readonly data: Float32Array;
}

export class EnvironmentCaptureError extends Error {
  constructor(
    readonly code: string,
    readonly textureUuid: string | null,
    message: string,
    options?: ErrorOptions,
  ) {
    super(code + ": " + message, options);
    this.name = "EnvironmentCaptureError";
  }
}

interface Revision {
  version: number;
  source: THREE.Texture["source"];
  sourceVersion: number;
  image: unknown;
  pmremVersion: number;
  mapping: number;
  width: number;
  height: number;
  sampling: string;
}
interface Entry {
  revision: Revision;
  promise: Promise<EnvironmentRadiance>;
  reject: (error: EnvironmentCaptureError) => void;
  release: () => void;
  unlisten: () => void;
  active: boolean;
  result?: EnvironmentRadiance;
}

function describe(input: THREE.Texture): Revision {
  const flags = input as THREE.Texture & {
    isCubeTexture?: boolean;
    isCompressedTexture?: boolean;
    isCompressedCubeTexture?: boolean;
    isDataArrayTexture?: boolean;
    isData3DTexture?: boolean;
    isVideoTexture?: boolean;
    isDepthTexture?: boolean;
  };
  const unsupported = (message: string): never => {
    throw new EnvironmentCaptureError(
      "TC_ENVIRONMENT_UNSUPPORTED",
      input.uuid,
      message,
    );
  };
  if (
    flags.isCompressedTexture ||
    flags.isCompressedCubeTexture ||
    flags.isDataArrayTexture ||
    flags.isData3DTexture ||
    flags.isVideoTexture ||
    flags.isDepthTexture ||
    input.format !== THREE.RGBAFormat ||
    ![THREE.UnsignedByteType, THREE.HalfFloatType, THREE.FloatType].some(
      (type) => type === input.type,
    ) ||
    ![
      THREE.NoColorSpace,
      THREE.LinearSRGBColorSpace,
      THREE.SRGBColorSpace,
    ].some((space) => space === input.colorSpace) ||
    input.premultiplyAlpha
  )
    unsupported(
      "Use an uncompressed RGBA byte/half/float environment in linear-sRGB or sRGB without premultiplied alpha.",
    );
  let width: number, height: number;
  if (flags.isCubeTexture) {
    if (input.mapping !== THREE.CubeReflectionMapping)
      unsupported("CubeTexture requires CubeReflectionMapping.");
    const faces = input.image as {
      width?: number;
      height?: number;
      image?: { width: number; height: number };
    }[];
    if (!Array.isArray(faces) || faces.length !== 6)
      unsupported("CubeTexture must have six ready faces.");
    const size = faces[0]?.image ?? faces[0];
    const side = size?.width ?? 0;
    if (
      !faces.every((face) => {
        const image = face?.image ?? face;
        return image?.width === side && image?.height === side;
      })
    )
      unsupported("CubeTexture faces must be ready, square and equal-sized.");
    width = side * 4;
    height = side * 2;
  } else {
    if (input.mapping !== THREE.EquirectangularReflectionMapping)
      unsupported(
        "Use EquirectangularReflectionMapping or the locked WebGPU PMREM CubeTexture. Legacy CubeUV atlases are not supported by r187 TSL.",
      );
    const image = input.image as { width?: number; height?: number } | null;
    width = image?.width ?? 0;
    height = image?.height ?? 0;
  }
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width <= 0 ||
    height <= 0 ||
    !Number.isSafeInteger(width * height * 16)
  )
    throw new EnvironmentCaptureError(
      "TC_ENVIRONMENT_DIMENSIONS",
      input.uuid,
      "Supply a ready environment with positive integral dimensions that fit RGBA32F storage.",
    );
  return {
    version: input.version,
    source: input.source,
    sourceVersion: input.source.version,
    image: input.image,
    pmremVersion: input.pmremVersion,
    mapping: input.mapping,
    width,
    height,
    sampling: [
      input.type,
      input.format,
      input.colorSpace,
      input.flipY,
      input.wrapS,
      input.wrapT,
      input.magFilter,
      input.minFilter,
    ].join(":"),
  };
}

function same(a: Revision, b: Revision): boolean {
  return (Object.keys(a) as (keyof Revision)[]).every(
    (key) => a[key] === b[key],
  );
}

function submit(
  renderer: THREE.Renderer,
  target: THREE.RenderTarget,
  material: THREE.NodeMaterial,
) {
  const viewport = renderer.getViewport(
    new THREE.Vector4(),
  ) as THREE.Vector4 & { minDepth?: number; maxDepth?: number };
  const scissor = renderer.getScissor(new THREE.Vector4());
  const state = {
    target: renderer.getRenderTarget(),
    face: renderer.getActiveCubeFace(),
    mip: renderer.getActiveMipmapLevel(),
    toneMapping: renderer.toneMapping,
    exposure: renderer.toneMappingExposure,
    colorSpace: renderer.outputColorSpace,
    autoClear: renderer.autoClear,
    autoClearColor: renderer.autoClearColor,
    autoClearDepth: renderer.autoClearDepth,
    autoClearStencil: renderer.autoClearStencil,
    scissorTest: renderer.getScissorTest(),
    mrt: renderer.getMRT(),
    renderObject: renderer.getRenderObjectFunction(),
    opaque: renderer.opaque,
    transparent: renderer.transparent,
  };
  try {
    renderer.setRenderTarget(target);
    renderer.setMRT(null);
    renderer.setRenderObjectFunction(null);
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.toneMappingExposure = 1;
    renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    // The opaque full-screen triangle writes every texel; no clear is needed.
    renderer.autoClear = false;
    renderer.opaque = true;
    renderer.transparent = true;
    new THREE.QuadMesh(material).render(renderer);
    return renderer.readRenderTargetPixelsAsync(
      target,
      0,
      0,
      target.width,
      target.height,
    );
  } finally {
    renderer.setRenderTarget(state.target, state.face, state.mip);
    renderer.setMRT(state.mrt);
    renderer.setRenderObjectFunction(state.renderObject);
    renderer.toneMapping = state.toneMapping;
    renderer.toneMappingExposure = state.exposure;
    renderer.outputColorSpace = state.colorSpace;
    renderer.autoClear = state.autoClear;
    renderer.autoClearColor = state.autoClearColor;
    renderer.autoClearDepth = state.autoClearDepth;
    renderer.autoClearStencil = state.autoClearStencil;
    renderer.opaque = state.opaque;
    renderer.transparent = state.transparent;
    renderer.setViewport(
      viewport.x,
      viewport.y,
      viewport.z,
      viewport.w,
      viewport.minDepth ?? 0,
      viewport.maxDepth ?? 1,
    );
    renderer.setScissor(scissor);
    renderer.setScissorTest(state.scissorTest);
  }
}

/** Renderer-local GPU capture. Call between renders, after await renderer.init(). */
export function createEnvironmentCapture(renderer: THREE.Renderer) {
  const entries = new Map<THREE.Texture, Entry>();
  const diagnostics = new Map<
    string,
    { code: string; textureUuid: string | null; message: string }
  >();
  let disposed = false,
    reads = 0,
    hits = 0,
    shared = 0,
    allocated = 0,
    released = 0;
  const error = (
    code: string,
    input: THREE.Texture | null,
    message: string,
    cause?: unknown,
  ) => {
    const failure = new EnvironmentCaptureError(
      code,
      input?.uuid ?? null,
      message,
      cause === undefined ? undefined : { cause },
    );
    diagnostics.set(input?.uuid ?? "renderer", {
      code,
      textureUuid: failure.textureUuid,
      message,
    });
    return failure;
  };
  const cancel = (input: THREE.Texture, entry: Entry, code: string) => {
    if (entries.get(input) === entry) entries.delete(input);
    entry.unlisten();
    if (entry.active) {
      entry.active = false;
      entry.reject(
        error(
          code,
          input,
          "Capture invalidated; submit a fresh capture when the source and renderer are ready.",
        ),
      );
    }
    entry.release();
  };
  const clear = () => {
    for (const [input, entry] of entries)
      cancel(input, entry, "TC_ENVIRONMENT_CANCELLED");
    diagnostics.clear();
  };
  return {
    capture(input: THREE.Texture | null): Promise<EnvironmentRadiance | null> {
      if (input === null) return Promise.resolve(null);
      if (disposed)
        return Promise.reject(
          error(
            "TC_ENVIRONMENT_DISPOSED",
            input,
            "Create a new capture provider after dispose().",
          ),
        );
      let revision: Revision;
      try {
        revision = describe(input);
      } catch (failure) {
        const previous = entries.get(input);
        if (previous) cancel(input, previous, "TC_ENVIRONMENT_STALE");
        if (failure instanceof EnvironmentCaptureError) {
          diagnostics.set(input.uuid, {
            code: failure.code,
            textureUuid: input.uuid,
            message: failure.message,
          });
          return Promise.reject(failure);
        }
        return Promise.reject(
          error(
            "TC_ENVIRONMENT_UNSUPPORTED",
            input,
            "Environment metadata is not readable.",
            failure,
          ),
        );
      }
      let entry = entries.get(input);
      if (entry && !same(entry.revision, revision)) {
        cancel(input, entry, "TC_ENVIRONMENT_STALE");
        entry = undefined;
      }
      if (entry) {
        hits++;
        if (entry.active) shared++;
      } else {
        if (
          !(renderer.backend as { isWebGPUBackend?: boolean })
            .isWebGPUBackend ||
          !renderer.hasInitialized()
        )
          return Promise.reject(
            error(
              "TC_ENVIRONMENT_RENDERER",
              input,
              "Use an initialized WebGPU renderer; await renderer.init() before capture().",
            ),
          );
        const limit = (
          renderer.backend as {
            device?: { limits: { maxTextureDimension2D: number } };
          }
        ).device?.limits.maxTextureDimension2D;
        if (
          limit !== undefined &&
          (revision.width > limit || revision.height > limit)
        )
          return Promise.reject(
            error(
              "TC_ENVIRONMENT_DIMENSIONS",
              input,
              "The equirectangular output exceeds this GPU's maxTextureDimension2D; use a smaller source.",
            ),
          );
        let resolve!: (value: EnvironmentRadiance) => void;
        let reject!: (failure: EnvironmentCaptureError) => void;
        const promise = new Promise<EnvironmentRadiance>((yes, no) => {
          resolve = yes;
          reject = no;
        });
        entry = {
          revision,
          promise,
          reject,
          release: () => {},
          unlisten: () => {},
          active: true,
        };
        entries.set(input, entry);
        const current = entry;
        const onDispose = () =>
          cancel(input, current, "TC_ENVIRONMENT_SOURCE_DISPOSED");
        input.addEventListener("dispose", onDispose);
        current.unlisten = () =>
          input.removeEventListener("dispose", onDispose);
        let target: THREE.RenderTarget | undefined,
          material: THREE.NodeMaterial | undefined;
        current.release = () => {
          if (target) {
            target.dispose();
            target = undefined;
            released++;
          }
          if (material) {
            material.dispose();
            material = undefined;
            released++;
          }
        };
        const fail = (cause: unknown) => {
          if (!current.active) return;
          current.active = false;
          if (entries.get(input) === current) entries.delete(input);
          current.unlisten();
          current.release();
          reject(
            cause instanceof EnvironmentCaptureError
              ? cause
              : error(
                  "TC_ENVIRONMENT_READ_FAILED",
                  input,
                  "GPU environment capture failed; inspect the cause and retry after restoring GPU/source availability.",
                  cause,
                ),
          );
        };
        try {
          target = new THREE.RenderTarget(revision.width, revision.height, {
            type: THREE.FloatType,
            format: THREE.RGBAFormat,
            colorSpace: THREE.LinearSRGBColorSpace,
            depthBuffer: false,
            stencilBuffer: false,
            minFilter: THREE.NearestFilter,
            magFilter: THREE.NearestFilter,
            generateMipmaps: false,
          });
          allocated++;
          material = new THREE.NodeMaterial();
          allocated++;
          material.depthTest = false;
          material.depthWrite = false;
          material.blending = THREE.NoBlending;
          material.toneMapped = false;
          // WebGPU screenUV.y and readback rows both start at the top.
          const theta = screenUV.x.sub(0.5).mul(2 * Math.PI);
          const phi = screenUV.y.mul(Math.PI);
          const direction = vec3(
            phi.sin().mul(theta.cos()),
            phi.cos(),
            phi.sin().mul(theta.sin()),
          );
          const environment = (input as THREE.CubeTexture).isCubeTexture
            ? cubeTexture(input as THREE.CubeTexture, direction)
            : texture(input, equirectUV(direction));
          environment.updateMatrix = false;
          const sample = environment.level(float(0));
          material.fragmentNode = vec4(sample.rgb, 1);
          reads++;
          const readback = submit(renderer, target, material);
          void Promise.resolve(readback)
            .then((pixels) => {
              if (!current.active) return;
              try {
                if (!same(revision, describe(input)))
                  throw error(
                    "TC_ENVIRONMENT_STALE",
                    input,
                    "The texture changed during readback; capture the new revision.",
                  );
                if (
                  !(pixels instanceof Float32Array) ||
                  pixels.length !== revision.width * revision.height * 4
                )
                  throw error(
                    "TC_ENVIRONMENT_READ_LAYOUT",
                    input,
                    "Expected tightly packed RGBA32F from the locked WebGPU readback API.",
                  );
                const data = pixels.slice();
                if (!data.every(Number.isFinite))
                  throw error(
                    "TC_ENVIRONMENT_NONFINITE",
                    input,
                    "Environment radiance contains NaN or infinity; repair the source HDR texture.",
                  );
                const result = Object.freeze({
                  uuid: input.uuid,
                  sourceVersion: revision.version,
                  width: revision.width,
                  height: revision.height,
                  data,
                });
                current.result = result;
                current.active = false;
                current.release();
                diagnostics.delete(input.uuid);
                resolve(result);
              } catch (cause) {
                fail(cause);
              }
            }, fail)
            .catch(fail);
        } catch (cause) {
          fail(cause);
        }
      }
      // A shared read/promise never shares the mutable cache buffer with callers.
      return entry.promise.then((result) =>
        Object.freeze({ ...result, data: result.data.slice() }),
      );
    },
    inspect() {
      return {
        disposed,
        gpuReads: reads,
        cacheHits: hits,
        sharedPending: shared,
        entries: entries.size,
        pending: Array.from(entries.values()).filter((entry) => entry.active)
          .length,
        listeners: entries.size,
        resources: { allocated, released, live: allocated - released },
        retainedBytes: Array.from(entries.values()).reduce(
          (sum, entry) => sum + (entry.result?.data.byteLength ?? 0),
          0,
        ),
        layout: "linear-srgb/rgba32f/equirect/north-first" as const,
        diagnostics: Array.from(diagnostics.values(), (item) => ({ ...item })),
      };
    },
    clear,
    dispose() {
      clear();
      disposed = true;
    },
  };
}
