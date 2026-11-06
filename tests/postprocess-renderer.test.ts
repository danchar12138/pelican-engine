import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three/webgpu";
import { vec4 } from "three/tsl";
import { compileGraphDeclaration } from "../packages/compiler/src/graph.ts";
import type { PostProcessIR } from "../packages/compiler/src/types.ts";
import type { Graph, PostProcessState } from "../packages/sdk/src/index.ts";
import { DEFAULT_RENDER_SETTINGS } from "../packages/runtime/src/render-settings.ts";
import { createPostProcessComposer } from "../packages/renderer/src/postprocess.ts";

const source = { file: "fixture.ts", line: 1, column: 1, length: 1 };
function definition(
  id: string,
  frame = ["scene.color"],
  history: string[] = [],
  extra?: Graph,
): PostProcessIR {
  const nodes: any[] = [{ id: "uv", op: "input", name: "uv" }];
  for (const [op, channels] of [
    ["sampleFrame", frame],
    ["sampleHistory", history],
  ] as const)
    for (const channel of channels)
      nodes.push({ id: "n" + nodes.length, op, channel, inputs: ["uv"] });
  const samples = nodes.slice(1).map((n) => n.id);
  let output = samples.shift()!;
  for (const sample of samples) {
    const id = "n" + nodes.length;
    nodes.push({ id, op: "add", inputs: [output, sample] });
    output = id;
  }
  const result = compileGraphDeclaration(extra ?? { nodes, output }, "vec4", {
    domain: "postprocess",
    inputs: ["uv", "screenSize", "texelSize"],
    frameChannels: new Set([
      "scene.color",
      "scene.normal",
      "scene.depth",
      "a",
      "b",
      "c",
    ]),
    historyChannels: new Set(["a", "b", "c"]),
  });
  assert.deepEqual(result.issues, []);
  return { id, enabled: true, graph: result.graph, source };
}
function owner(definitions: readonly PostProcessIR[]) {
  const states: PostProcessState[] = definitions.map((d) => ({
    id: d.id,
    enabled: d.enabled,
    parameters: Object.fromEntries(
      (d.graph.parameters ?? []).map((p) => [p.name, p.default]),
    ),
  }));
  const revisions = Object.fromEntries(definitions.map((d) => [d.id, 0]));
  return {
    states: () => states,
    historyRevisions: () => revisions,
    values: states,
    revisions,
  };
}

// Renderer protocol fixture only: actual Three targets/materials/nodes, no GPU or shader evaluation.
function fixture() {
  let target: THREE.RenderTarget | null = new THREE.RenderTarget(3, 2);
  let face = 2,
    mip = 1,
    mrt: any = { original: true };
  const clear = new THREE.Color(0.2, 0.3, 0.4),
    viewport = new THREE.Vector4(1, 2, 8, 6),
    scissor = new THREE.Vector4(2, 3, 4, 5);
  Object.assign(viewport, { minDepth: 0.1, maxDepth: 0.9 });
  let alpha = 0.4,
    depth = 0.7,
    stencil = 9,
    scissorTest = true;
  const targets = new Set<THREE.RenderTarget>();
  const native = new Map<THREE.Texture, any>();
  const calls: {
    target: THREE.RenderTarget | null;
    mrt: any;
    object: any;
    material?: THREE.NodeMaterial;
    fragment: any;
    version?: number;
    tone: number;
    exposure: number;
    space: string;
    scissor: boolean;
  }[] = [];
  const control = { failDraw: 0, failInit: false, draws: 0 };
  const backend = {
    isWebGPUBackend: true,
    device: {
      limits: {
        maxColorAttachments: 8,
        maxColorAttachmentBytesPerSample: 32,
        maxTextureDimension2D: 4096,
      },
    },
    get: (t: THREE.Texture) => ({ texture: native.get(t) }),
  };
  const r = {
    backend,
    currentSamples: 4,
    samples: 4,
    reversedDepthBuffer: false,
    autoClear: false,
    autoClearColor: false,
    autoClearDepth: false,
    autoClearStencil: true,
    toneMapping: THREE.ACESFilmicToneMapping,
    toneMappingExposure: 2.25,
    outputColorSpace: THREE.SRGBColorSpace,
    xr: { enabled: true },
    getRenderTarget: () => target,
    setRenderTarget(t: THREE.RenderTarget | null, f = 0, m = 0) {
      target = t;
      face = f;
      mip = m;
      if (t) targets.add(t);
    },
    getActiveCubeFace: () => face,
    getActiveMipmapLevel: () => mip,
    getMRT: () => mrt,
    setMRT: (v: any) => {
      mrt = v;
    },
    getClearColor: (out: THREE.Color) => out.copy(clear),
    getClearAlpha: () => alpha,
    setClearColor(v: THREE.Color | number, a = 1) {
      clear.set(v as any);
      alpha = a;
    },
    getClearDepth: () => (r.reversedDepthBuffer ? 1 - depth : depth),
    setClearDepth: (v: number) => {
      depth = v;
    },
    getClearStencil: () => stencil,
    setClearStencil: (v: number) => {
      stencil = v;
    },
    getViewport: (out: THREE.Vector4) => out.copy(viewport),
    setViewport(
      v: number | THREE.Vector4,
      y?: number,
      z?: number,
      w?: number,
      minDepth = 0,
      maxDepth = 1,
    ) {
      if (typeof v === "number") viewport.set(v, y!, z!, w!);
      else viewport.copy(v);
      Object.assign(viewport, { minDepth, maxDepth });
    },
    getScissor: (out: THREE.Vector4) => out.copy(scissor),
    setScissor: (v: THREE.Vector4) => {
      scissor.copy(v);
    },
    getScissorTest: () => scissorTest,
    setScissorTest: (v: boolean) => {
      scissorTest = v;
    },
    getPixelRatio: () => 1,
    initRenderTarget(t: THREE.RenderTarget) {
      if (control.failInit) throw Error("init failure");
      targets.add(t);
      for (const texture of t.textures)
        if (!native.has(texture)) native.set(texture, { label: texture.name });
    },
    render(object: any) {
      control.draws++;
      calls.push({
        target,
        mrt,
        object,
        material: object.material,
        fragment: object.material?.fragmentNode,
        version: object.material?.version,
        tone: r.toneMapping,
        exposure: r.toneMappingExposure,
        space: r.outputColorSpace,
        scissor: scissorTest,
      });
      if (control.draws === control.failDraw) throw Error("draw failure");
    },
  };
  const snapshot = () => ({
    target,
    face,
    mip,
    mrt,
    clear: clear.toArray(),
    alpha,
    depth,
    stencil,
    viewport: viewport.toArray(),
    minDepth: (viewport as any).minDepth,
    maxDepth: (viewport as any).maxDepth,
    scissor: scissor.toArray(),
    scissorTest,
    autoClear: r.autoClear,
    color: r.autoClearColor,
    autoDepth: r.autoClearDepth,
    autoStencil: r.autoClearStencil,
    tone: r.toneMapping,
    exposure: r.toneMappingExposure,
    space: r.outputColorSpace,
    xr: r.xr.enabled,
  });
  return {
    renderer: r as unknown as THREE.Renderer,
    raw: r,
    calls,
    targets,
    native,
    control,
    snapshot,
  };
}
function setup(
  definitions = [definition("a"), definition("b", ["a"], ["a", "b"])],
) {
  const f = fixture(),
    o = owner(definitions);
  const c = createPostProcessComposer(
    f.renderer,
    16,
    12,
    definitions,
    new Map(),
  );
  return { ...f, c, o, inspect: () => c.inspect() as any };
}

test("HDR capture preserves size, actual samples, named attachments, and all caller state", () => {
  const f = setup(),
    before = f.snapshot();
  f.c.captureRaster(new THREE.Scene(), new THREE.PerspectiveCamera());
  assert.deepEqual(f.snapshot(), before);
  const call = f.calls[0],
    target = call.target!;
  assert.equal(target.width, 16);
  assert.equal(target.height, 12);
  assert.equal(target.samples, 4);
  assert.deepEqual(
    target.textures.map((t) => t.name),
    ["output", "normal", "linearDepth"],
  );
  for (const t of target.textures) {
    assert.equal(t.type, THREE.HalfFloatType);
    assert.equal(t.colorSpace, THREE.LinearSRGBColorSpace);
    assert.equal(t.generateMipmaps, false);
  }
  assert.deepEqual(f.inspect().sourceAttachments, [
    "output", "normal", "linearDepth",
  ]);
  for (const name of ["normal", "linearDepth"]) {
    assert.deepEqual(call.mrt.getClearColor(name).toArray(), [0, 0, 0]);
    assert.equal(call.mrt.getClearColor(name).a, 0);
  }
  assert.equal(call.mrt.getClearColor("output"), null);
  assert.equal(call.tone, THREE.NoToneMapping);
  assert.equal(call.exposure, 1);
  assert.equal(call.space, THREE.LinearSRGBColorSpace);
  assert.equal(call.scissor, false);
  f.c.dispose();
});

test("radial distance MRT never overrides hardware fragment depth and clears to zero", () => {
  const f = setup();
  try {
    f.c.captureRaster(new THREE.Scene(), new THREE.PerspectiveCamera());
    const rasterMRT = f.calls[0].mrt;
    assert.equal(rasterMRT.has("depth"), false);
    assert.equal(rasterMRT.has("linearDepth"), true);
    assert.deepEqual(rasterMRT.getClearColor("linearDepth").toArray(), [0, 0, 0]);
    assert.equal(rasterMRT.getClearColor("linearDepth").a, 0);
  } finally {
    f.c.dispose();
  }
});

test("native tracer targets reuse the initialized Three attachments without copies", () => {
  const f = setup(),
    before = f.snapshot();
  const targets = f.c.traceTargets();
  assert.deepEqual(targets, {
    color: { label: "output" },
    normal: { label: "normal" },
    depth: { label: "linearDepth" },
  });
  assert.equal(f.c.traceTargets().color, targets.color);
  assert.deepEqual(f.snapshot(), before);
  assert.equal(f.calls.length, 0);
  f.control.failInit = true;
  assert.throws(() => f.c.traceTargets(), /init failure/);
  assert.deepEqual(f.snapshot(), before);
  f.c.dispose();
});

test("frame routing and history commit only after successful final output", () => {
  const f = setup([
    definition("a", ["scene.color", "scene.normal", "scene.depth"], ["b"]),
    definition("b", ["a"], ["a", "b"]),
  ]);
  const before = f.snapshot();
  f.c.present(f.o, 1, DEFAULT_RENDER_SETTINGS);
  assert.deepEqual(f.snapshot(), before);
  let p = f.inspect().passes;
  assert.deepEqual(
    p.map((v: any) => v.read),
    [1, 1],
  );
  assert.deepEqual(
    p[0].frameBindings.map((v: any) => v.texture),
    ["output", "normal", "linearDepth"],
  );
  assert.deepEqual(
    p[0].frameBindings.map((v: any) => v.channel),
    ["scene.color", "scene.normal", "scene.depth"],
  );
  assert.deepEqual(
    p[1].frameBindings.map((v: any) => v.texture),
    ["a:1"],
  );
  assert.deepEqual(
    p[1].historyBindings.map((v: any) => v.texture),
    ["$postprocess.zero", "$postprocess.zero"],
  );
  f.c.present(f.o, 2, DEFAULT_RENDER_SETTINGS);
  p = f.inspect().passes;
  assert.deepEqual(
    p[0].historyBindings.map((v: any) => v.texture),
    ["b:1"],
  );
  assert.deepEqual(
    p[1].historyBindings.map((v: any) => v.texture),
    ["a:1", "b:1"],
  );
  assert.deepEqual(
    p.map((v: any) => v.read),
    [0, 0],
  );
  for (const c of f.calls.filter(
    (v) =>
      v.target?.texture.name.startsWith("a:") ||
      v.target?.texture.name.startsWith("b:"),
  ))
    assert.equal(c.target!.samples, 0);
  assert.equal(f.calls.at(-1)!.target, null);
  f.c.dispose();
});

test("pass and final draw failures restore state, do not advance histories, and retry the same write sides", () => {
  for (const failAt of [1, 2, 3]) {
    const f = setup();
    f.c.present(f.o, 0, DEFAULT_RENDER_SETTINGS);
    const before = f.snapshot(),
      read = f.inspect().passes.map((p: any) => p.read);
    f.control.failDraw = f.control.draws + failAt;
    assert.throws(
      () => f.c.present(f.o, 1, DEFAULT_RENDER_SETTINGS),
      /draw failure/,
    );
    assert.deepEqual(f.snapshot(), before);
    assert.deepEqual(
      f.inspect().passes.map((p: any) => p.read),
      read,
    );
    assert.equal(f.inspect().frames, 1);
    assert.equal(f.inspect().failures, 1);
    for (const call of f.calls) assert.equal(call.material?.vertexNode, null);
    f.control.failDraw = 0;
    f.c.present(f.o, 2, DEFAULT_RENDER_SETTINGS);
    assert.deepEqual(
      f.inspect().passes[1].historyBindings.map((v: any) => v.texture),
      ["a:1", "b:1"],
    );
    f.c.dispose();
  }
});

test("disabled pass aliases previous active upstream but freezes its own history", () => {
  const f = setup([
    definition("a"),
    definition("b", ["a"]),
    definition("c", ["b"], ["b"]),
  ]);
  f.c.present(f.o, 0, DEFAULT_RENDER_SETTINGS);
  f.o.values[1].enabled = false;
  f.c.present(f.o, 1, DEFAULT_RENDER_SETTINGS);
  const p = f.inspect().passes;
  assert.equal(p[1].read, 1);
  assert.equal(p[1].historyValid, true);
  assert.equal(p[2].frameBindings[0].texture, "a:0");
  assert.equal(p[2].historyBindings[0].texture, "b:1");
  f.o.values[0].enabled = false;
  f.c.present(f.o, 2, DEFAULT_RENDER_SETTINGS);
  assert.equal(f.inspect().passes[2].frameBindings[0].texture, "output");
  f.o.values[1].enabled = true;
  f.c.present(f.o, 3, DEFAULT_RENDER_SETTINGS);
  assert.equal(
    f.inspect().passes[2].historyBindings[0].texture,
    "$postprocess.zero",
  );
  assert.equal(f.inspect().resetReason, "reenable");
  f.c.dispose();
});

test("owner revisions, explicit reset, mode changes, and device replacement invalidate histories", () => {
  const f = setup();
  f.c.present(f.o, 0, DEFAULT_RENDER_SETTINGS);
  f.o.revisions.a++;
  f.c.present(f.o, 1, DEFAULT_RENDER_SETTINGS);
  assert.deepEqual(
    f.inspect().passes[1].historyBindings.map((v: any) => v.texture),
    ["$postprocess.zero", "b:1"],
  );
  f.c.resetHistory("snapshot-restore");
  assert.equal(
    f.inspect().passes.every((p: any) => !p.historyValid),
    true,
  );
  f.c.present(f.o, 2, DEFAULT_RENDER_SETTINGS);
  assert.equal(
    f
      .inspect()
      .passes[1].historyBindings.every(
        (b: any) => b.texture === "$postprocess.zero",
      ),
    true,
  );
  f.c.present(f.o, 3, { ...DEFAULT_RENDER_SETTINGS, mode: "path" });
  assert.equal(f.inspect().resetReason, "mode");
  assert.equal(
    f
      .inspect()
      .passes[1].historyBindings.every(
        (b: any) => b.texture === "$postprocess.zero",
      ),
    true,
  );
  f.raw.backend.device = { ...f.raw.backend.device };
  assert.throws(
    () => f.c.present(f.o, 4, DEFAULT_RENDER_SETTINGS),
    /TC_POSTPROCESS_CAPABILITY/,
  );
  f.c.dispose();
});

test("parameters and time update existing nodes; dynamic texture bindings cannot merge", () => {
  const d = definition("a", [], [], {
    parameters: [
      { name: "gain", type: "float", default: 1 },
      { name: "tint", type: "vec4", default: [1, 1, 1, 1] },
    ],
    nodes: [
      { id: "uv", op: "input", name: "uv" },
      { id: "s", op: "sampleFrame", channel: "scene.color", inputs: ["uv"] },
      { id: "h", op: "sampleHistory", channel: "a", inputs: ["uv"] },
      { id: "gain", op: "parameter", name: "gain" },
      { id: "tint", op: "parameter", name: "tint" },
      { id: "time", op: "time" },
      { id: "g", op: "multiply", inputs: ["s", "gain"] },
      { id: "t", op: "multiply", inputs: ["g", "tint"] },
      { id: "u", op: "multiply", inputs: ["t", "time"] },
      { id: "out", op: "add", inputs: ["u", "h"] },
    ],
    output: "out",
  });
  const f = setup([d]);
  f.c.present(f.o, 2, DEFAULT_RENDER_SETTINGS);
  const first = f.calls[0],
    uniforms: any[] = [],
    textureNodes: any[] = [];
  first.fragment.traverse((n: any) => {
    if (n.isUniformNode && !n.isTextureNode) uniforms.push(n);
    if (n.isTextureNode) textureNodes.push(n);
  });
  const vector = uniforms.find((n) => n.value?.isVector4).value;
  assert.ok(textureNodes.length >= 2);
  for (const node of textureNodes) assert.equal(node.mergeable, false);
  f.o.values[0].parameters = { gain: 3, tint: [0.2, 0.4, 0.6, 1] };
  const allocated = f.inspect().resources.allocated;
  f.c.present(f.o, 5, DEFAULT_RENDER_SETTINGS);
  const next = f.calls[2];
  assert.equal(first.material, next.material);
  assert.equal(first.fragment, next.fragment);
  assert.equal(first.version, next.version);
  assert.equal(f.inspect().resources.allocated, allocated);
  assert.equal(
    uniforms.some((n) => n.value === 3),
    true,
  );
  assert.equal(
    uniforms.some((n) => n.value === 5),
    true,
  );
  assert.deepEqual(vector.toArray(), [0.2, 0.4, 0.6, 1]);
  f.c.dispose();
});

test("final output uses raster tone mapping, tracer ACES fit, and exposure-only debug", () => {
  const f = setup([definition("a")]);
  f.c.present(f.o, 0, { ...DEFAULT_RENDER_SETTINGS, exposure: 3 });
  const raster = f.calls.at(-1)!;
  assert.equal(raster.material!.toneMapped, false);
  assert.equal(raster.fragment.getToneMapping(), THREE.ACESFilmicToneMapping);
  assert.equal(raster.fragment.outputColorSpace, THREE.SRGBColorSpace);
  assert.equal(raster.exposure, 3);
  assert.equal(raster.tone, THREE.NoToneMapping);
  f.c.present(f.o, 1, {
    ...DEFAULT_RENDER_SETTINGS,
    mode: "path",
    exposure: 4,
  });
  const traced = f.calls.at(-1)!;
  assert.equal(traced.fragment.getToneMapping(), THREE.NoToneMapping);
  assert.equal(traced.exposure, 1);
  assert.notEqual(traced.fragment.colorNode, raster.fragment.colorNode);
  f.c.present(f.o, 2, {
    ...DEFAULT_RENDER_SETTINGS,
    mode: "path",
    exposure: 5,
  });
  assert.equal(f.calls.at(-1)!.fragment, traced.fragment);
  f.c.present(f.o, 3, {
    ...DEFAULT_RENDER_SETTINGS,
    mode: "path",
    debug: "normal",
    exposure: 8,
  });
  const debug = f.calls.at(-1)!;
  assert.equal(debug.fragment.getToneMapping(), THREE.NoToneMapping);
  assert.equal(debug.exposure, 1);
  const uniforms: any[] = [];
  debug.fragment.traverse((n: any) => {
    if (n.isUniformNode && n.value === 8) uniforms.push(n);
  });
  assert.equal(uniforms.length, 1);
  f.c.dispose();
});

test("capture failures restore state including reversed clear depth", () => {
  const f = setup();
  f.raw.reversedDepthBuffer = true;
  const before = f.snapshot();
  f.control.failDraw = 1;
  assert.throws(
    () => f.c.captureRaster(new THREE.Scene(), new THREE.Camera()),
    /draw failure/,
  );
  assert.deepEqual(f.snapshot(), before);
  f.c.dispose();
});

test("all disabled passes present the source without touching history", () => {
  const defs = [definition("a"), definition("b", ["a"])];
  for (const d of defs) d.enabled = false;
  const f = setup(defs);
  f.c.present(f.o, 0, DEFAULT_RENDER_SETTINGS);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].fragment.colorNode.value.name, "output");
  assert.equal(
    f.inspect().passes.every((p: any) => !p.historyValid && p.read === 0),
    true,
  );
  f.c.dispose();
});

test("capability validation rejects insufficient device limits and never falls back", () => {
  for (const limits of [
    { maxColorAttachments: 2 },
    { maxColorAttachmentBytesPerSample: 16 },
    { maxTextureDimension2D: 8 },
  ]) {
    const f = fixture();
    Object.assign(f.raw.backend.device.limits, limits);
    assert.throws(
      () => createPostProcessComposer(f.renderer, 16, 12, [], new Map()),
      /TC_POSTPROCESS_CAPABILITY/,
    );
    assert.equal(f.targets.size, 0);
  }
  const f = fixture();
  f.raw.samples = 8;
  assert.throws(
    () => createPostProcessComposer(f.renderer, 16, 12, [], new Map()),
    /TC_POSTPROCESS_CAPABILITY/,
  );
  assert.throws(
    () => createPostProcessComposer(f.renderer, 0, 12, [], new Map()),
    /TC_POSTPROCESS_CAPABILITY/,
  );
});

test("scene MSAA survives the zero-sample final output conversion stage", () => {
  const f = fixture();
  f.raw.currentSamples = 0;
  f.raw.samples = 4;
  const composer = createPostProcessComposer(f.renderer, 16, 12, [], new Map());
  composer.captureRaster(new THREE.Scene(), new THREE.PerspectiveCamera());
  assert.equal(f.calls.at(-1)!.target!.samples, 4);
  assert.equal((composer.inspect() as any).samples, 4);
  composer.dispose();
});

function webgl(extension = true, supportedSamples = [4]) {
  const values = new Map<number, number>([
    [1, 4],
    [2, 4],
    [3, 4096],
    [4, 4096],
  ]);
  return {
    isWebGLBackend: true,
    gl: {
      MAX_COLOR_ATTACHMENTS: 1,
      MAX_DRAW_BUFFERS: 2,
      MAX_TEXTURE_SIZE: 3,
      MAX_RENDERBUFFER_SIZE: 4,
      RENDERBUFFER: 5,
      RGBA16F: 6,
      SAMPLES: 7,
      getExtension: (name: string) =>
        name === "EXT_color_buffer_float" && extension ? {} : null,
      getParameter: (p: number) => values.get(p),
      getInternalformatParameter: () => new Int32Array(supportedSamples),
    },
  };
}
test("WebGL2 explicitly requires float color renderability and exact HDR MSAA support", () => {
  const f = fixture();
  for (const backend of [webgl(false), webgl(true, [2])]) {
    (f.raw as any).backend = backend;
    assert.throws(
      () => createPostProcessComposer(f.renderer, 16, 12, [], new Map()),
      /TC_POSTPROCESS_CAPABILITY/,
    );
  }
  (f.raw as any).backend = webgl();
  const c = createPostProcessComposer(
    f.renderer,
    16,
    12,
    [definition("a")],
    new Map(),
  );
  c.captureRaster(new THREE.Scene(), new THREE.Camera());
  assert.equal(f.calls[0].target!.samples, 4);
  assert.throws(() => c.traceTargets(), /TC_POSTPROCESS_CAPABILITY/);
  c.dispose();
});

test("invalid graph inputs, dependencies, reserved and duplicate IDs fail before rendering", () => {
  const f = fixture();
  for (const defs of [
    [definition("a", ["b"]), definition("b")],
    [definition("a"), definition("a")],
    [definition("scene.color")],
    [
      {
        ...definition("a"),
        graph: {
          ...definition("a").graph,
          requiredInputs: ["normalWorld" as const],
        },
      },
    ],
    [definition("a", [], ["c"])],
  ])
    assert.throws(
      () => createPostProcessComposer(f.renderer, 16, 12, defs, new Map()),
      /TC_POSTPROCESS_GRAPH/,
    );
  assert.equal(f.calls.length, 0);
});

test("invalid owner or parameter state cannot commit history", () => {
  const f = setup();
  assert.throws(
    () =>
      f.c.present(
        { states: () => [], historyRevisions: () => ({}) },
        0,
        DEFAULT_RENDER_SETTINGS,
      ),
    /TC_POSTPROCESS_STATE/,
  );
  assert.throws(
    () => f.c.present(f.o, Infinity, DEFAULT_RENDER_SETTINGS),
    /TC_POSTPROCESS_STATE/,
  );
  delete f.o.revisions.a;
  assert.throws(
    () => f.c.present(f.o, 0, DEFAULT_RENDER_SETTINGS),
    /TC_POSTPROCESS_STATE/,
  );
  assert.equal(f.inspect().frames, 0);
  f.c.dispose();
});

test("dispose is idempotent, accounts owned resources, and leaves shared geometry/textures alive", () => {
  const f = fixture(),
    texture = new THREE.Texture();
  let textureDisposed = 0,
    geometryDisposed = 0,
    materialDisposed = 0,
    targetDisposed = 0;
  texture.addEventListener("dispose", () => textureDisposed++);
  const d = definition("a"),
    o = owner([d]);
  const c = createPostProcessComposer(
    f.renderer,
    16,
    12,
    [d],
    new Map([["shared", texture]]),
  );
  c.captureRaster(new THREE.Scene(), new THREE.Camera());
  c.present(o, 0, DEFAULT_RENDER_SETTINGS);
  const geometry = f.calls[1].object.geometry;
  geometry.addEventListener("dispose", () => geometryDisposed++);
  for (const m of new Set(f.calls.map((v) => v.material).filter(Boolean)))
    m!.addEventListener("dispose", () => materialDisposed++);
  for (const t of f.targets)
    t.addEventListener("dispose", () => targetDisposed++);
  c.dispose();
  c.dispose();
  const stats = c.inspect() as any;
  assert.equal(stats.resources.live, 0);
  assert.equal(stats.resources.allocated, stats.resources.released);
  assert.equal(textureDisposed, 0);
  assert.equal(geometryDisposed, 0);
  assert.equal(materialDisposed, 2);
  assert.equal(targetDisposed, 2);
  assert.throws(
    () => c.present(o, 1, DEFAULT_RENDER_SETTINGS),
    /TC_POSTPROCESS_DISPOSED/,
  );
  assert.throws(() => c.resetHistory(), /TC_POSTPROCESS_DISPOSED/);
  assert.throws(() => c.traceTargets(), /TC_POSTPROCESS_DISPOSED/);
  assert.throws(
    () => c.captureRaster(new THREE.Scene(), new THREE.Camera()),
    /TC_POSTPROCESS_DISPOSED/,
  );
});

test("construction failure disposes partially created targets, texture, and material", (t) => {
  const targetDispose = t.mock.method(
    THREE.RenderTarget.prototype,
    "dispose",
    () => {},
  );
  const materialDispose = t.mock.method(
    THREE.NodeMaterial.prototype,
    "dispose",
    () => {},
  );
  const textureDispose = t.mock.method(
    THREE.Texture.prototype,
    "dispose",
    () => {},
  );
  const f = fixture(),
    d = definition("a");
  d.graph.output = "missing";
  assert.throws(
    () => createPostProcessComposer(f.renderer, 16, 12, [d], new Map()),
    /TC_GRAPH_/,
  );
  assert.equal(targetDispose.mock.callCount(), 3);
  assert.equal(materialDispose.mock.callCount(), 1);
  assert.equal(textureDispose.mock.callCount(), 1);
});

test("declared postprocess buffer reads require and use the controlled bridge", () => {
  const f = fixture(), d: PostProcessIR = { id: "palette", enabled: true, source,
    buffers: [{ name: "colors", type: "vec4", count: 2, buffer: "initial" }],
    graph: { output: "color", outputType: "vec4", nodeTypes: { index: "float", color: "vec4" }, bufferTypes: { colors: "vec4" },
      nodes: [{ id: "index", op: "float", value: 0 }, { id: "color", op: "readBuffer", buffer: "colors", inputs: ["index"] }] },
  };
  assert.throws(() => createPostProcessComposer(f.renderer, 16, 12, [d], new Map()), /TC_RENDER_BUFFER_CAPABILITY/);
  let prepared = 0, read = 0;
  const bridge = { prepare(material: THREE.Material, slots: unknown) { prepared++; assert.equal(material.name, "$post.palette"); assert.deepEqual(slots, { colors: "vec4" }); },
    node(material: THREE.Material, name: string, index: unknown, type: string, robust: boolean) { read++; assert.equal(material.name, "$post.palette"); assert.equal(name, "colors"); assert.equal(type, "vec4"); assert.equal(robust, true); return vec4(0.1, 0.2, 0.3, 1); } };
  const composer = createPostProcessComposer(f.renderer, 16, 12, [d], new Map(), bridge as never);
  assert.equal(prepared, 1); assert.equal(read, 1); composer.dispose();
  delete d.graph.bufferTypes;
  assert.throws(() => createPostProcessComposer(f.renderer, 16, 12, [d], new Map(), bridge as never), /TC_POSTPROCESS_GRAPH/);
});
