import * as THREE from "three/webgpu";
import * as TSL from "three/tsl";
import type { PostProcessIR } from "../../compiler/src/types.ts";
import type { GraphValue, RenderSettings } from "../../sdk/src/index.ts";
import type { PostProcessOwnerView } from "../../runtime/src/postprocess-contract.ts";
import type { TracePresentationTargets } from "./postprocess-contract.ts";
import { typedGraphToTSL } from "./graph-tsl.ts";
import type { createRenderBufferBridge } from "./render-buffers.ts";
import type { createRenderTextureBridge } from "./render-textures.ts";

type Node = any;
type Backend = THREE.Renderer["backend"] & {
  isWebGPUBackend?: boolean;
  isWebGLBackend?: boolean;
  device?: GPUDevice;
  gl?: WebGL2RenderingContext;
  get(texture: THREE.Texture): { texture?: GPUTexture };
};
type Binding = { channel: string; node: Node };
type Pass = {
  definition: PostProcessIR;
  targets: [THREE.RenderTarget, THREE.RenderTarget];
  material: THREE.NodeMaterial;
  parameters: Map<string, Node>;
  frame: Binding[];
  history: Binding[];
  read: number;
  valid: boolean;
  enabled: boolean;
  revision: number | undefined;
};
const fail = (code: string, message: string): never => {
  throw Error("TC_POSTPROCESS_" + code + ": " + message);
};

// Three's public getter copies a Vector4 with additional depth-range properties.
class ViewportSnapshot extends THREE.Vector4 {
  minDepth = 0;
  maxDepth = 1;
  override copy(v: THREE.Vector4): this {
    super.copy(v);
    const range = v as THREE.Vector4 & { minDepth?: number; maxDepth?: number };
    this.minDepth = range.minDepth ?? 0;
    this.maxDepth = range.maxDepth ?? 1;
    return this;
  }
}

/** Private presentation owner. Call only after renderer.init(); never expose to games. */
export function createPostProcessComposer(
  renderer: THREE.Renderer,
  width: number,
  height: number,
  definitions: readonly PostProcessIR[],
  textures: ReadonlyMap<string, THREE.Texture>,
  buffers?: ReturnType<typeof createRenderBufferBridge>,
  managedTextures?: ReturnType<typeof createRenderTextureBridge>,
): {
  captureRaster(scene: THREE.Scene, camera: THREE.Camera): void;
  traceTargets(): TracePresentationTargets;
  present(
    owner: PostProcessOwnerView,
    time: number,
    settings: RenderSettings,
  ): void;
  resetHistory(reason?: string): void;
  dispose(): void;
  inspect(): unknown;
} {
  const backend = renderer.backend as Backend;
  const device = backend.device;
  // currentSamples is zero at the final output-conversion stage, not the scene's MSAA count.
  const samples = renderer.samples;
  if (![width, height].every((n) => Number.isSafeInteger(n) && n > 0))
    fail("CAPABILITY", "Positive integer target dimensions are required.");
  if (!Number.isSafeInteger(samples) || samples < 0)
    fail("CAPABILITY", "Cannot determine the renderer's actual MSAA samples.");
  if (backend.isWebGPUBackend) {
    const limits = device?.limits;
    if (
      !limits ||
      limits.maxColorAttachments < 3 ||
      limits.maxColorAttachmentBytesPerSample < 24 ||
      Math.max(width, height) > limits.maxTextureDimension2D ||
      ![0, 1, 4].includes(samples)
    )
      fail(
        "CAPABILITY",
        "Device cannot render three full-size rgba16float attachments at the current MSAA count.",
      );
  } else if (backend.isWebGLBackend) {
    const gl =
      backend.gl ?? fail("CAPABILITY", "WebGL2 backend is not initialized.");
    if (
      !gl.getExtension("EXT_color_buffer_float") ||
      gl.getParameter(gl.MAX_COLOR_ATTACHMENTS) < 3 ||
      gl.getParameter(gl.MAX_DRAW_BUFFERS) < 3 ||
      Math.max(width, height) > gl.getParameter(gl.MAX_TEXTURE_SIZE) ||
      Math.max(width, height) > gl.getParameter(gl.MAX_RENDERBUFFER_SIZE)
    )
      fail(
        "CAPABILITY",
        "WebGL2 requires EXT_color_buffer_float and three full-size rgba16float attachments.",
      );
    if (
      samples > 1 &&
      !(
        gl.getInternalformatParameter(
          gl.RENDERBUFFER,
          gl.RGBA16F,
          gl.SAMPLES,
        ) as Int32Array
      ).includes(samples)
    )
      fail(
        "CAPABILITY",
        "WebGL2 cannot preserve the current MSAA count for rgba16float.",
      );
  } else
    fail(
      "CAPABILITY",
      "An initialized Three WebGPU or WebGL2 backend is required.",
    );

  const ids = new Set<string>();
  const allowed = new Set(["uv", "screenSize", "texelSize"]);
  for (const d of definitions) {
    if (!d.id || d.id.startsWith("scene.") || ids.has(d.id))
      fail("GRAPH", "Duplicate or reserved pass ID: " + d.id);
    ids.add(d.id);
  }
  const earlier = new Set(["scene.color", "scene.normal", "scene.depth"]);
  for (const d of definitions) {
    if (d.graph.outputType !== "vec4")
      fail("GRAPH", d.id + " must output vec4.");
    for (const name of d.graph.requiredInputs ?? [])
      if (!allowed.has(name)) fail("GRAPH", "Unsupported input: " + name);
    // Check nodes as well as metadata so material inputs cannot leak in.
    for (const n of d.graph.nodes) {
      if (n.op === "input" && !allowed.has(n.name))
        fail("GRAPH", "Unsupported input: " + n.name);
      if (n.op === "readBuffer" && !Object.hasOwn(d.graph.bufferTypes ?? {}, n.buffer))
        fail("GRAPH", "Buffer reads require a declared postprocess slot.");
      if (n.op === "sampleFrame" && !earlier.has(n.channel))
        fail("GRAPH", "Forward or unknown frame channel: " + n.channel);
      if (n.op === "sampleHistory" && !ids.has(n.channel))
        fail("GRAPH", "Unknown history pass: " + n.channel);
    }
    earlier.add(d.id);
  }

  let disposed = false,
    allocated = 0,
    released = 0,
    frames = 0,
    failures = 0;
  let resets = 0,
    resetReason = "initial",
    lastMode: RenderSettings["mode"] | undefined;
  const resources: { dispose(): void }[] = [];
  const own = <T extends { dispose(): void }>(value: T): T => {
    resources.push(value);
    allocated++;
    return value;
  };
  const release = () => {
    for (const resource of resources.splice(0).reverse()) {
      resource.dispose();
      released++;
    }
  };
  const active = () => {
    if (disposed) fail("DISPOSED", "Composer is disposed.");
    if (
      renderer.backend !== backend ||
      (backend.isWebGPUBackend && backend.device !== device)
    )
      fail(
        "CAPABILITY",
        "Renderer device changed; dispose and recreate the composer.",
      );
  };
  const target = (name: string, count = 1, scene = false) => {
    const t = own(
      new THREE.RenderTarget(width, height, {
        count,
        type: THREE.HalfFloatType,
        format: THREE.RGBAFormat,
        colorSpace: THREE.LinearSRGBColorSpace,
        depthBuffer: scene,
        stencilBuffer: false,
        samples: scene ? samples : 0,
        minFilter: THREE.NearestFilter,
        magFilter: THREE.NearestFilter,
        generateMipmaps: false,
      }),
    );
    t.texture.name = name;
    return t;
  };
  const material = (name: string) => {
    const m = own(new THREE.NodeMaterial());
    m.name = name;
    m.toneMapped = false;
    m.depthTest = m.depthWrite = false;
    m.blending = THREE.NoBlending;
    return m;
  };
  const passes: Pass[] = [];
  try {
    const source = target("output", 3, true);
    source.textures[1].name = "normal";
    source.textures[2].name = "linearDepth";
    // Three's generated sky mesh is a real mesh, but not a surface hit.
    const isBackground = (builder: any) =>
      builder.object.name === "Background.mesh" &&
      builder.material.name === "Background.material";
    const rasterMRT = TSL.mrt({
      output: TSL.output,
      normal: TSL.Fn((builder: any) =>
        isBackground(builder) ? TSL.vec4(0) : TSL.vec4(TSL.normalWorld, 1),
      )(),
      // "depth" is reserved by NodeMaterial.setupDepth for hardware depth writes.
      linearDepth: TSL.Fn((builder: any) =>
        isBackground(builder)
          ? TSL.vec4(0)
          : TSL.vec4(
              TSL.max(TSL.positionWorld.sub(TSL.cameraPosition).length(), 1e-7),
              0,
              0,
              1,
            ),
      )(),
    });
    rasterMRT.setClearColor("normal", 0, 0);
    rasterMRT.setClearColor("linearDepth", 0, 0);
    const zero = own(
      new THREE.DataTexture(
        new Uint16Array(4),
        1,
        1,
        THREE.RGBAFormat,
        THREE.HalfFloatType,
      ),
    );
    zero.colorSpace = THREE.LinearSRGBColorSpace;
    zero.generateMipmaps = false;
    zero.needsUpdate = true;
    zero.name = "$postprocess.zero";
    const timeUniform = TSL.uniform(0);
    const makeUniform = (value: GraphValue, type: string) => {
      const v = Array.isArray(value)
        ? type === "vec2"
          ? new THREE.Vector2().fromArray(value)
          : type === "vec3"
            ? new THREE.Vector3().fromArray(value)
            : new THREE.Vector4().fromArray(value)
        : value;
      return TSL.uniform(v as any, type as any);
    };
    for (const d of definitions) {
      const p: Pass = {
        definition: d,
        targets: [target(d.id + ":0"), target(d.id + ":1")],
        material: material("PostProcess:" + d.id),
        parameters: new Map(
          (d.graph.parameters ?? []).map((v) => [
            v.name,
            makeUniform(v.default, v.type),
          ]),
        ),
        frame: [],
        history: [],
        read: 0,
        valid: false,
        enabled: d.enabled,
        revision: undefined,
      };
      passes.push(p);
      p.material.name = "$post." + d.id;
      if (Object.keys(d.graph.bufferTypes ?? {}).length) {
        if (!buffers) throw new Error("TC_RENDER_BUFFER_CAPABILITY: Postprocess storage slots require a managed WebGPU bridge.");
        buffers.prepare(p.material, d.graph.bufferTypes!);
      }
      if (Object.keys(d.graph.textureSlots ?? {}).length) {
        if (!managedTextures) throw new Error("TC_RENDER_TEXTURE_CAPABILITY: Postprocess texture slots require a managed WebGPU bridge.");
        managedTextures.prepare(p.material, d.graph.textureSlots!);
      }
      const sample = (bindings: Binding[], channel: string, uv: Node) => {
        const n = TSL.texture(zero, uv);
        n.updateMatrix = false;
        n.mergeable = false;
        bindings.push({ channel, node: n });
        return n.level(TSL.float(0));
      };
      p.material.fragmentNode = typedGraphToTSL(
        d.graph,
        timeUniform,
        p.parameters,
        textures,
        {
          inputs: {
            uv: TSL.uv(0),
            screenSize: TSL.uniform(new THREE.Vector2(width, height)),
            texelSize: TSL.uniform(new THREE.Vector2(1 / width, 1 / height)),
          },
          sampleFrame: (channel, uv) => sample(p.frame, channel, uv),
          sampleHistory: (channel, uv) => sample(p.history, channel, uv),
          readBuffer: (name, index, type) => {
            if (!buffers) throw new Error("TC_RENDER_BUFFER_CAPABILITY: Postprocess storage slots require a managed WebGPU bridge.");
            return buffers.node(p.material, name, index, type, true);
          },
          sampleTextureSlot: (name, uv) => {
            if (!managedTextures) throw new Error("TC_RENDER_TEXTURE_CAPABILITY: Postprocess texture slots require a managed WebGPU bridge.");
            return managedTextures.node(p.material, name, uv, d.graph.textureSlots![name]);
          },
        },
      );
    }
    const finalTexture = TSL.texture(source.texture, TSL.uv(0));
    finalTexture.updateMatrix = false;
    finalTexture.mergeable = false;
    const finalMaterial = material("PostProcess:Output");
    const traceExposure = TSL.uniform(1);
    const quad = new THREE.QuadMesh(finalMaterial);
    let finalKey = "";
    // Scope all mutations, including QuadMesh.render's non-finally vertexNode assignment.
    const scoped = (run: () => void) => {
      const state = {
        target: renderer.getRenderTarget(),
        face: renderer.getActiveCubeFace(),
        mip: renderer.getActiveMipmapLevel(),
        mrt: renderer.getMRT(),
        clear: renderer.getClearColor(new THREE.Color()),
        alpha: renderer.getClearAlpha(),
        depth: renderer.reversedDepthBuffer
          ? 1 - renderer.getClearDepth()
          : renderer.getClearDepth(),
        stencil: renderer.getClearStencil(),
        viewport: renderer.getViewport(
          new ViewportSnapshot(),
        ) as ViewportSnapshot,
        scissor: renderer.getScissor(new THREE.Vector4()),
        scissorTest: renderer.getScissorTest(),
        auto: renderer.autoClear,
        color: renderer.autoClearColor,
        autoDepth: renderer.autoClearDepth,
        autoStencil: renderer.autoClearStencil,
        tone: renderer.toneMapping,
        exposure: renderer.toneMappingExposure,
        space: renderer.outputColorSpace,
        xr: renderer.xr.enabled,
      };
      try {
        renderer.xr.enabled = false;
        renderer.toneMapping = THREE.NoToneMapping;
        renderer.toneMappingExposure = 1;
        renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
        renderer.setScissorTest(false);
        renderer.autoClear =
          renderer.autoClearColor =
          renderer.autoClearDepth =
            true;
        renderer.autoClearStencil = false;
        run();
      } finally {
        renderer.setRenderTarget(state.target, state.face, state.mip);
        renderer.setMRT(state.mrt);
        renderer.setClearColor(state.clear, state.alpha);
        renderer.setClearDepth(state.depth);
        renderer.setClearStencil(state.stencil);
        renderer.setViewport(
          state.viewport.x,
          state.viewport.y,
          state.viewport.z,
          state.viewport.w,
          state.viewport.minDepth,
          state.viewport.maxDepth,
        );
        renderer.setScissor(state.scissor);
        renderer.setScissorTest(state.scissorTest);
        renderer.autoClear = state.auto;
        renderer.autoClearColor = state.color;
        renderer.autoClearDepth = state.autoDepth;
        renderer.autoClearStencil = state.autoStencil;
        renderer.toneMapping = state.tone;
        renderer.toneMappingExposure = state.exposure;
        renderer.outputColorSpace = state.space;
        renderer.xr.enabled = state.xr;
      }
    };
    const draw = (m: THREE.NodeMaterial) => {
      quad.material = m;
      const vertex = m.vertexNode;
      try {
        quad.render(renderer);
      } finally {
        m.vertexNode = vertex;
      }
    };
    const resetHistory = (reason = "explicit") => {
      active();
      for (const p of passes) p.valid = false;
      resets++;
      resetReason = reason;
    };
    return {
      captureRaster(scene, camera) {
        active();
        scoped(() => {
          renderer.setRenderTarget(source);
          renderer.setMRT(rasterMRT);
          renderer.setClearDepth(1);
          renderer.render(scene, camera);
        });
      },
      traceTargets() {
        active();
        if (!backend.isWebGPUBackend)
          return fail("CAPABILITY", "Raw trace targets require WebGPU.");
        let result!: TracePresentationTargets;
        scoped(() => {
          renderer.initRenderTarget(source);
          const [color, normal, depth] = source.textures.map(
            (t) => backend.get(t).texture as GPUTexture | undefined,
          );
          if (!color || !normal || !depth)
            fail(
              "CAPABILITY",
              "Three did not allocate the three native HDR attachments.",
            );
          result = { color: color!, normal: normal!, depth: depth! };
        });
        return result;
      },
      present(owner, time, settings) {
        active();
        if (!Number.isFinite(Math.fround(time)))
          fail("STATE", "Time must fit finite f32.");
        const states = owner.states();
        const byId = new Map(states.map((s) => [s.id, s]));
        if (
          byId.size !== passes.length ||
          states.length !== passes.length ||
          passes.some((p) => !byId.has(p.definition.id))
        )
          fail(
            "STATE",
            "Owner pass IDs do not match the compiled definitions.",
          );
        const revisions = owner.historyRevisions();
        if (lastMode !== undefined && lastMode !== settings.mode)
          resetHistory("mode");
        lastMode = settings.mode;
        if (
          passes.some((p) => !p.enabled && byId.get(p.definition.id)!.enabled)
        )
          resetHistory("reenable");
        for (const p of passes) {
          const id = p.definition.id,
            revision = revisions[id];
          if (!Number.isSafeInteger(revision) || revision < 0)
            fail("STATE", "Missing history revision: " + id);
          if (p.revision !== revision) p.valid = false;
          p.revision = revision;
          p.enabled = byId.get(id)!.enabled;
        }
        timeUniform.value = time;
        const savedTone = renderer.toneMapping,
          savedSpace = renderer.outputColorSpace;
        try {
          scoped(() => {
            renderer.setMRT(null);
            renderer.setClearColor(0, 0);
            const channels = new Map<string, THREE.Texture>([
              ["scene.color", source.textures[0]],
              ["scene.normal", source.textures[1]],
              ["scene.depth", source.textures[2]],
            ]);
            let upstream = source.texture;
            for (const p of passes) {
              if (!p.enabled) {
                channels.set(p.definition.id, upstream);
                continue;
              }
              const output = p.targets[1 - p.read];
              for (const b of p.frame) {
                const t = channels.get(b.channel);
                if (!t || t === output.texture)
                  fail("GRAPH", "Unsafe frame attachment: " + b.channel);
                b.node.value = t;
              }
              for (const b of p.history) {
                const previous = passes.find(
                  (v) => v.definition.id === b.channel,
                )!;
                const t = previous.valid
                  ? previous.targets[previous.read].texture
                  : zero;
                if (t === output.texture)
                  fail("GRAPH", "Unsafe history attachment: " + b.channel);
                b.node.value = t;
              }
              const values = byId.get(p.definition.id)!.parameters;
              for (const definition of p.definition.graph.parameters ?? []) {
                const value = values[definition.name] ?? definition.default;
                const uniform = p.parameters.get(definition.name)!;
                const valid =
                  definition.type === "bool"
                    ? typeof value === "boolean"
                    : definition.type === "float"
                      ? typeof value === "number" &&
                        Number.isFinite(Math.fround(value))
                      : Array.isArray(value) &&
                        value.length === Number(definition.type.slice(3)) &&
                        value.every(
                          (n) =>
                            typeof n === "number" &&
                            Number.isFinite(Math.fround(n)),
                        );
                if (!valid)
                  fail(
                    "STATE",
                    "Invalid parameter: " +
                      p.definition.id +
                      ":" +
                      definition.name,
                  );
                if (Array.isArray(value)) uniform.value.fromArray(value);
                else uniform.value = value;
              }
              renderer.setRenderTarget(output);
              draw(p.material);
              upstream = output.texture;
              channels.set(p.definition.id, upstream);
            }
            finalTexture.value = upstream;
            // Explicit output transform; automatic renderer transforms remain disabled.
            const tracedBeauty =
              settings.mode !== "raster" && settings.debug === "beauty";
            const rasterBeauty =
              settings.mode === "raster" && settings.debug === "beauty";
            const tone = rasterBeauty ? savedTone : THREE.NoToneMapping;
            const key =
              tone + ":" + savedSpace + ":" + tracedBeauty + ":" + rasterBeauty;
            if (finalKey !== key) {
              let color = finalTexture.level(TSL.float(0));
              if (!rasterBeauty) {
                const exposed = TSL.max(color.rgb.mul(traceExposure), 0);
                // Match TRACE_PRESENT_SHADER, not Three's matrix-based ACES operator.
                const rgb = tracedBeauty
                  ? TSL.clamp(
                      exposed
                        .mul(exposed.mul(2.51).add(0.03))
                        .div(
                          exposed.mul(exposed.mul(2.43).add(0.59)).add(0.14),
                        ),
                      0,
                      1,
                    )
                  : exposed;
                color = TSL.vec4(rgb, color.a) as any;
              }
              finalMaterial.fragmentNode = TSL.renderOutput(
                color,
                tone,
                savedSpace,
              );
              finalMaterial.needsUpdate = true;
              finalKey = key;
            }
            traceExposure.value = settings.exposure;
            renderer.toneMappingExposure = rasterBeauty ? settings.exposure : 1;
            renderer.setRenderTarget(null);
            renderer.setViewport(
              0,
              0,
              width / renderer.getPixelRatio(),
              height / renderer.getPixelRatio(),
            );
            draw(finalMaterial);
          });
          // Commit only after the final draw AND state restoration succeeded.
          for (const p of passes)
            if (p.enabled) {
              p.read = 1 - p.read;
              p.valid = true;
            }
          frames++;
        } catch (error) {
          failures++;
          throw error;
        }
      },
      resetHistory,
      dispose() {
        if (disposed) return;
        disposed = true;
        release();
      },
      inspect() {
        return {
          disposed,
          width,
          height,
          samples,
          format: "rgba16float",
          sourceAttachments: ["output", "normal", "linearDepth"],
          frames,
          failures,
          resets,
          resetReason,
          resources: {
            allocated,
            released,
            live: allocated - released,
            targets: disposed ? 0 : 1 + passes.length * 2,
            textures: disposed ? 0 : 4 + passes.length * 2,
          },
          passes: passes.map((p) => ({
            id: p.definition.id,
            enabled: p.enabled,
            historyValid: p.valid,
            read: p.read,
            revision: p.revision,
            frameBindings: p.frame.map((b) => ({
              channel: b.channel,
              texture: b.node.value.name,
            })),
            historyBindings: p.history.map((b) => ({
              channel: b.channel,
              texture: b.node.value.name,
            })),
          })),
        };
      },
    };
  } catch (error) {
    release();
    throw error;
  }
}
