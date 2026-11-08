import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { setImmediate as turn } from "node:timers/promises";
import vm from "node:vm";
import ts from "typescript";
import * as THREE from "three/webgpu";
import { SurfaceTracer } from "../packages/renderer/src/surface-tracer.ts";
import {
  boundedOperation,
  inspectTraceCapabilities,
  runtimeStatus,
} from "../packages/renderer/src/startup.ts";
import { createRenderSettingsDriver as settingsDriver } from "../packages/runtime/src/render-settings.ts";
const createRenderSettingsDriver: typeof settingsDriver = (settings = {}, materials = [], capabilities = () => renderCapabilities("webgpu"), ...rest) => settingsDriver(settings, materials, capabilities, ...rest);
import {
  renderCapabilities,
  validateRenderCapabilities,
} from "../packages/runtime/src/render-capabilities.ts";

// Actual browser bodies and SurfaceTracer lifecycle with CPU-only device fixtures.
// These regressions do not establish GPU/backend rendering acceptance.
const source = await readFile(
  new URL("../packages/renderer/src/browser.ts", import.meta.url),
  "utf8",
);
const ast = ts.createSourceFile(
  "browser.ts",
  source,
  ts.ScriptTarget.Latest,
  true,
);

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function browserHarness(names: string[], values: Record<string, unknown> = {}) {
  const text = names
    .map((name) => {
      const found = ast.statements.filter(
        (node): node is ts.FunctionDeclaration =>
          ts.isFunctionDeclaration(node) && node.name?.text === name,
      );
      assert.equal(found.length, 1, `Expected browser function ${name}`);
      return found[0].getText(ast);
    })
    .join("\n")
    .replaceAll("import.meta.env.DEV", "false");
  const scope = vm.createContext({
    AbortController,
    THREE,
    structuredClone,
    performance,
    boundedOperation,
    inspectTraceCapabilities,
    runtimeStatus,
    renderCapabilities,
    validateRenderCapabilities,
    disposed: false,
    disposal: undefined,
    recoveringGpu: false,
    playing: true,
    terminalFault: false,
    lastFrameTime: 1,
    frameRequest: undefined,
    renderer: undefined,
    device: undefined,
    tracer: undefined,
    adapterInfo: undefined,
    surfaceTracer: undefined,
    pendingSurface: undefined,
    renderControl: undefined,
    computeControl: undefined,
    computeExecutor: undefined,
    renderBufferBridge: undefined,
    renderTextureBridge: undefined,
    postComposer: undefined,
    vertexBounds: undefined,
    legacyTracerDisposed: true,
    backendKind: "webgpu",
    contextWasPlaying: false,
    waitingForWebglRestore: false,
    lostDevices: new WeakSet(),
    lostRenderers: new WeakSet(),
    recoveryTask: undefined,
    recoveryEvents: [],
    recoveryCount: 0,
    width: 16,
    height: 8,
    mode: "path",
    tick: 3,
    probeEnabled: false,
    dynamicVisualRevision: 0,
    diagnosticsVisible: true,
    gameSurfaceDefaults: new Map(),
    ropeVisuals: { dispose() {} }, clothVisuals: { dispose() {} }, terrainVisuals: { dispose() {} }, fluidVisuals: { dispose() {} },
    softBodyVisuals: { dispose() {} }, spriteVisuals: { dispose() {} }, tilemapVisuals: { dispose() {} }, cinematicOverlay: { dispose() {} },
    clearDynamicVisuals() {},
    cameraCapabilities: () => renderCapabilities("webgpu"),
    renderedDynamicVisualRevision: 0,
    traceContentDirty: true,
    observedGraphOwner: undefined,
    observedGraphRevision: -1,
    observedGraphTick: -1,
    gamepadHost: undefined,
    gamepadFingerprint: undefined,
    tickTail: Promise.resolve(),
    nativeInputTail: Promise.resolve(),
    drawTail: Promise.resolve(),
    viewport: { width: 16, height: 8, cssWidth: 16, cssHeight: 8, pixelRatio: 1, fixed: true },
    resizeViewport: () => false,
    pointerInput: { drain() {}, dispose() {} },
    runtime: undefined,
    gameplay: undefined,
    simulation: undefined,
    world: undefined,
    compiledIR: null,
    contentScope: undefined,
    authoredLights: [],
    topologyObjects: [],
    gameObjects: new Map(),
    gameMaterials: new Map(),
    transforms: new Map(),
    componentState: new Map(),
    materialGraphs: [],
    errors: [],
    metrics: [],
    triangleCount: 0,
    nodeCount: 0,
    bvhMs: 0,
    uploadMs: 0,
    submitMs: 0,
    lastStepCpuMs: 0,
    camera: {},
    scene: {},
    startup: { automation: true },
    status: { hidden: false, textContent: "" },
    document: { documentElement: { dataset: { pelicanReady: "true" } }, removeEventListener() {} },
    window: { removeEventListener() {} },
    rasterCanvas: { style: {}, removeEventListener() {}, remove() {} },
    traceCanvas: { style: {}, remove() {} },
    resourceManager: { dispose() {}, inspect: () => ({ resources: 0 }) },
    releaseObject() {},
    syncRuntime() {},
    animate() {},
    onKeyDown() {},
    onKeyUp() {},
    onWindowBlur() {},
    onVisibilityChange() {},
    onResize() {},
    onContextRestored() {},
    onPageHide() {},
    reportFailure(error: unknown) {
      throw error;
    },
    ...values,
  });
  vm.runInContext(
    ts.transpileModule(text, {
      compilerOptions: {
        target: ts.ScriptTarget.ES2023,
        module: ts.ModuleKind.None,
      },
    }).outputText,
    scope,
  );
  return scope as Record<string, any>;
}

function rendererFixture(
  backend: "webgpu" | "webgl2",
  init = Promise.resolve(),
) {
  const lost = deferred<GPUDeviceLostInfo>();
  const device = {
    lost: lost.promise,
    adapterInfo: {
      vendor: "fixture",
      architecture: "cpu",
      isFallbackAdapter: false,
    },
    features: new Set(),
    addEventListener() {},
    destroy() {},
  };
  const instances: Renderer[] = [];
  class Renderer {
    backend = { isWebGLBackend: backend === "webgl2", device };
    shadowMap = { enabled: false };
    toneMapping = undefined;
    disposals = 0;
    onDeviceLost = (_info: unknown) => {};
    constructor(readonly options: Record<string, unknown>) {
      instances.push(this);
    }
    setPixelRatio(_ratio: number) {}
    setSize(_width: number, _height: number) {}
    init() {
      return init;
    }
    async dispose() {
      this.disposals++;
    }
  }
  return {
    THREE: { WebGPURenderer: Renderer },
    GPUTracer: class {
      dispose() {}
    },
    instances,
    device,
    lost,
  };
}

function gpuGlobals(t: TestContext) {
  const values = {
    GPUBufferUsage: { UNIFORM: 1, COPY_DST: 2, STORAGE: 4, COPY_SRC: 8 },
    GPUTextureUsage: { RENDER_ATTACHMENT: 1, TEXTURE_BINDING: 2, COPY_SRC: 4 },
    GPUShaderStage: { COMPUTE: 1 },
    navigator: { gpu: { getPreferredCanvasFormat: () => "bgra8unorm" } },
  };
  for (const [key, value] of Object.entries(values)) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value });
    t.after(() => {
      if (previous) Object.defineProperty(globalThis, key, previous);
      else Reflect.deleteProperty(globalThis, key);
    });
  }
}

function surfaceFixture() {
  const lost = deferred<GPUDeviceLostInfo>();
  const resources: { destroys: number; destroy(): void }[] = [];
  const state = { shaders: 0, compute: 0, raster: 0, scopes: 0, pops: 0 };
  const pipeline = { getBindGroupLayout: () => ({}) };
  const resource = () => {
    const result = {
      destroys: 0,
      destroy() {
        this.destroys++;
      },
    };
    resources.push(result);
    return result;
  };
  const mock = {
    lost: lost.promise,
    features: new Set<string>(),
    destroy() {},
    limits: { maxTextureDimension2D: 4096, maxStorageBufferBindingSize: 1e7 },
    createBuffer: resource,
    createTexture: resource,
    pushErrorScope() {
      state.scopes++;
    },
    async popErrorScope() {
      state.pops++;
      return null;
    },
    createShaderModule() {
      state.shaders++;
      return { getCompilationInfo: async () => ({ messages: [] }) };
    },
    async createComputePipelineAsync() {
      state.compute++;
      return pipeline;
    },
    async createRenderPipelineAsync() {
      state.raster++;
      return pipeline;
    },
    createBindGroupLayout: () => ({}),
    createPipelineLayout: () => ({}),
  };
  return {
    device: mock as unknown as GPUDevice,
    mock,
    state,
    resources,
    pipeline,
    lost,
  };
}

function canvasFixture() {
  const state = { configured: 0, unconfigured: 0 };
  const context = {
    configure() {
      state.configured++;
    },
    unconfigure() {
      state.unconfigured++;
    },
  };
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => context,
  } as unknown as HTMLCanvasElement;
  return { canvas, state };
}

function surfaceInBrowser(t: TestContext) {
  gpuGlobals(t);
  const gpu = surfaceFixture(),
    canvas = canvasFixture();
  const validation = deferred<{ messages: [] }>();
  gpu.mock.createShaderModule = () => {
    gpu.state.shaders++;
    return { getCompilationInfo: () => validation.promise };
  };
  let signal: AbortSignal | undefined;
  const browser = browserHarness(["drawFrame", "disposeBrowser"], {
    device: gpu.device,
    traceCanvas: { style: {}, remove() {} },
    renderControl: createRenderSettingsDriver({ mode: "path" }),
    SurfaceTracer: {
      create: (
        _device: GPUDevice,
        _canvas: HTMLCanvasElement,
        width: number,
        height: number,
        _renderer: unknown,
        _fault: unknown,
        _debug: boolean,
        ownerSignal: AbortSignal,
      ) => {
        signal = ownerSignal;
        return SurfaceTracer.create(
          gpu.device,
          canvas.canvas,
          width,
          height,
          undefined,
          undefined,
          false,
          signal,
        );
      },
    },
  });
  return {
    ...gpu,
    canvas: canvas.canvas,
    contextState: canvas.state,
    browser,
    validation,
    signal: () => signal,
  };
}

test("recovery rejects a replacement device or GL renderer lost during reconstruction", async (t) => {
  for (const backend of ["webgpu", "webgl2"] as const) {
    await t.test(backend, async () => {
      const fixture = rendererFixture(backend),
        rebuild = deferred<void>();
      const browser = browserHarness(["initializeGpu", "recoverGpu"], {
        ...fixture,
        renderer: { async dispose() {} },
        backendKind: backend,
        gameplay: { rebuildGpuResources: () => rebuild.promise },
        draw: async () => {},
      });
      const work = browser.recoverGpu({
        reason: "unknown",
        message: "original backend lost",
      });
      const failure = assert.rejects(
        work,
        /TC_GPU_RECOVERY_FAILED.*TC_GPU_RECOVERY_DEVICE_LOST/,
      );
      await turn();
      assert.equal(fixture.instances.length, 1);
      assert.equal(browser.recoveringGpu, true);
      if (backend === "webgpu") {
        fixture.lost.resolve({
          reason: "unknown",
          message: "replacement lost",
        } as GPUDeviceLostInfo);
      } else {
        fixture.instances[0].onDeviceLost({ api: "WebGL" });
      }
      await turn();
      assert.ok(
        backend === "webgpu"
          ? browser.lostDevices.has(fixture.device)
          : browser.lostRenderers.has(fixture.instances[0]),
      );
      rebuild.resolve();
      await failure;
      assert.equal(
        browser.document.documentElement.dataset.pelicanReady,
        "false",
      );
      assert.equal(browser.recoveryCount, 0);
      assert.equal(browser.playing, false);
      assert.equal(browser.recoveringGpu, false);
      assert.equal(browser.recoveryEvents.at(-1).phase, "failed");
      assert.equal(
        browser.recoveryEvents.some(
          (event: { phase: string }) => event.phase === "restored",
        ),
        false,
      );
    });
  }
});

test("WebGL restoration cannot start a second recovery during reconstruction", async () => {
  const fixture = rendererFixture("webgl2");
  const rebuild = deferred<void>();
  const failures: unknown[] = [];
  const browser = browserHarness(["initializeGpu", "onContextRestored", "recoverGpu"], {
    ...fixture,
    renderer: { async dispose() {} },
    backendKind: "webgl2",
    gameplay: { rebuildGpuResources: () => rebuild.promise },
    draw: async () => {},
    reportFailure: (error: unknown) => failures.push(error),
  });
  const first = browser.recoverGpu({ reason: "unknown", message: "original loss" });
  const failure = assert.rejects(first, /TC_GPU_RECOVERY_FAILED.*TC_GPU_RECOVERY_DEVICE_LOST/);
  await turn();
  assert.equal(fixture.instances.length, 1);
  fixture.instances[0].onDeviceLost({ api: "WebGL" });
  browser.onContextRestored();
  await turn();
  const replacementCount = fixture.instances.length;
  rebuild.resolve();
  await failure;
  await turn();
  assert.equal(replacementCount, 1, "restoration must not start another recovery");
  assert.equal(browser.recoveryCount, 0);
  assert.equal(browser.document.documentElement.dataset.pelicanReady, "false");
  assert.deepEqual(failures, []);
});

test("WebGL context restoration starts exactly one recovery after an ordinary loss", async () => {
  const fixture = rendererFixture("webgl2");
  const rebuild = deferred<void>();
  const browser = browserHarness(["initializeGpu", "onContextRestored", "recoverGpu"], {
    ...fixture,
    backendKind: "webgl2",
    gameplay: { rebuildGpuResources: () => rebuild.promise },
    draw: async () => {},
  });
  await browser.initializeGpu();
  fixture.instances[0].onDeviceLost({ api: "WebGL" });
  assert.equal(browser.waitingForWebglRestore, true);
  browser.onContextRestored();
  const recovery = browser.recoveryTask;
  browser.onContextRestored();
  assert.equal(browser.recoveryTask, recovery);
  await turn();
  assert.equal(fixture.instances.length, 2);
  rebuild.resolve();
  await recovery;
  assert.equal(browser.recoveryCount, 1);
  assert.equal(browser.playing, true);
  assert.equal(browser.document.documentElement.dataset.pelicanReady, "true");
});

test("renderer initialization disposes a candidate that fulfills after its recovery deadline", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const late = deferred<void>(),
    fixture = rendererFixture("webgpu", late.promise);
  const browser = browserHarness(["initializeGpu"], {
    ...fixture,
    recoveringGpu: true,
    device: undefined,
    backendKind: "uninitialized",
  });
  const failure = assert.rejects(
    browser.initializeGpu(),
    /TC_RENDER_BACKEND_UNAVAILABLE.*TC_GPU_TIMEOUT/,
  );
  t.mock.timers.tick(30001);
  await failure;
  assert.equal(fixture.instances[0].disposals, 0);
  late.resolve();
  await turn();
  assert.equal(fixture.instances[0].disposals, 1);
  assert.equal(browser.device, undefined);
  assert.equal(browser.backendKind, "uninitialized");
  assert.equal(browser.adapterInfo, undefined);
});

test("initialization preserves built-in backend selection and authored antialiasing", async () => {
  for (const backend of ["webgpu", "webgl2"] as const) {
    const fixture = rendererFixture(backend);
    const browser = browserHarness(["initializeGpu"], { ...fixture });
    await browser.initializeGpu();
    const candidate = fixture.instances[0];
    assert.equal(browser.backendKind, backend);
    assert.equal(candidate.options.canvas, browser.rasterCanvas);
    assert.equal(candidate.options.antialias, true);
    assert.equal(Object.hasOwn(candidate.options, "forceWebGL"), false);
    assert.equal(candidate.disposals, 0);
    assert.equal(
      browser.document.documentElement.dataset.pelicanBackend,
      backend,
    );
  }
});

test("surface create rejects a pre-aborted owner before allocation", async (t) => {
  gpuGlobals(t);
  const gpu = surfaceFixture(),
    canvas = canvasFixture(),
    controller = new AbortController();
  controller.abort();
  await assert.rejects(
    SurfaceTracer.create(
      gpu.device,
      canvas.canvas,
      16,
      8,
      undefined,
      undefined,
      false,
      controller.signal,
    ),
    /TC_TRACE_CANCELLED/,
  );
  assert.equal(gpu.resources.length, 0);
  assert.equal(canvas.state.configured, 0);
});

test("browser surface deadline aborts and destroys pending setup without retaining a late result", async (t) => {
  const fixture = surfaceInBrowser(t);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  fixture.browser.boundedOperation = (
    promise: Promise<unknown>,
    label: string,
  ) => boundedOperation(promise, label, 5);
  const failure = assert.rejects(fixture.browser.drawFrame(), /TC_GPU_TIMEOUT/);
  await turn();
  assert.ok(fixture.resources.length > 0);
  t.mock.timers.tick(6);
  await failure;
  assert.equal(fixture.signal()?.aborted, true);
  assert.equal(fixture.browser.pendingSurface, undefined);
  assert.equal(fixture.browser.surfaceTracer, undefined);
  assert.ok(fixture.resources.every((resource) => resource.destroys === 1));
  assert.equal(fixture.contextState.unconfigured, 1);
  fixture.validation.resolve({ messages: [] });
  await turn();
  assert.equal(fixture.browser.surfaceTracer, undefined);
  assert.ok(fixture.resources.every((resource) => resource.destroys === 1));
});

test("browser disposal aborts surface initialization before its pipelines settle", async (t) => {
  const fixture = surfaceInBrowser(t);
  const failure = assert.rejects(
    fixture.browser.drawFrame(),
    /TC_TRACE_DISPOSED|TC_TRACE_CANCELLED/,
  );
  await turn();
  await fixture.browser.disposeBrowser();
  assert.equal(fixture.signal()?.aborted, true);
  assert.ok(fixture.resources.every((resource) => resource.destroys === 1));
  fixture.validation.resolve({ messages: [] });
  await failure;
  assert.equal(fixture.browser.surfaceTracer, undefined);
  assert.equal(fixture.browser.errors.length, 0);
});

test("surface handoff rejects stale ownership before and after the browser deadline await", async (t) => {
  for (const stage of ["before retain", "after retain"] as const) {
    for (const reason of ["abort", "dispose", "device replacement"] as const) {
      await t.test(`${stage}: ${reason}`, async () => {
        let disposals = 0;
        const candidate = {
          dispose() {
            disposals++;
          },
        };
        const browser = browserHarness(["drawFrame"], {
          device: {},
          renderControl: createRenderSettingsDriver({ mode: "path" }),
        });
        const invalidate = () => {
          if (reason === "abort") browser.pendingSurface.abort();
          else if (reason === "dispose") browser.disposed = true;
          else browser.device = {};
        };
        browser.SurfaceTracer = {
          async create() {
            if (stage === "before retain") invalidate();
            return candidate;
          },
        };
        browser.boundedOperation = async (promise: Promise<unknown>) => {
          const result = await promise;
          if (stage === "after retain") invalidate();
          return result;
        };
        await assert.rejects(browser.drawFrame(), /TC_TRACE_CANCELLED/);
        assert.equal(disposals, 1);
        assert.equal(browser.surfaceTracer, undefined);
        assert.equal(browser.pendingSurface, undefined);
      });
    }
  }
});

test("browser retains a completed surface and clears its pending controller without disposing it", async () => {
  let disposals = 0,
    updates = 0;
  let signal: AbortSignal | undefined;
  const candidate = {
    dispose() {
      disposals++;
    },
    async update() {
      updates++;
    },
    render: () => 0,
    inspect: () => ({
      triangleCount: 4,
      nodeCount: 1,
      uploadMs: 0,
      motion: { enabled: false },
    }),
  };
  const browser = browserHarness(["drawFrame"], {
    device: {},
    renderControl: createRenderSettingsDriver({ mode: "path" }),
    SurfaceTracer: {
      async create(...args: unknown[]) {
        signal = args[7] as AbortSignal;
        return candidate;
      },
    },
  });
  await browser.drawFrame();
  assert.equal(browser.surfaceTracer, candidate);
  assert.equal(browser.pendingSurface, undefined);
  assert.equal(signal?.aborted, true);
  assert.equal(disposals, 0);
  assert.equal(updates, 1);
});

test("completed creation detaches cancellation and stale disposal preserves the newer canvas owner", async (t) => {
  gpuGlobals(t);
  const old = surfaceFixture(),
    current = surfaceFixture(),
    canvas = canvasFixture();
  const late = deferred<{ messages: [] }>(),
    controller = new AbortController();
  old.mock.createShaderModule = () => ({
    getCompilationInfo: () => late.promise,
  });
  const pending = SurfaceTracer.create(
    old.device,
    canvas.canvas,
    16,
    8,
    undefined,
    undefined,
    false,
    controller.signal,
  );
  const failure = assert.rejects(pending, /TC_TRACE_DISPOSED/);
  await turn();
  const liveController = new AbortController();
  const live = await SurfaceTracer.create(
    current.device,
    canvas.canvas,
    16,
    8,
    undefined,
    undefined,
    false,
    liveController.signal,
  );
  t.after(() => live.dispose());
  liveController.abort();
  assert.ok(current.resources.every((resource) => resource.destroys === 0));
  controller.abort();
  assert.equal(canvas.state.unconfigured, 0);
  assert.ok(old.resources.every((resource) => resource.destroys === 1));
  late.resolve({ messages: [] });
  await failure;
  assert.equal(canvas.state.unconfigured, 0);
  live.dispose();
  live.dispose();
  assert.equal(canvas.state.unconfigured, 1);
  assert.ok(current.resources.every((resource) => resource.destroys === 1));
});

test("surface cancellation prevents late pipeline completion from starting more GPU work", async (t) => {
  gpuGlobals(t);
  const gpu = surfaceFixture(),
    canvas = canvasFixture(),
    controller = new AbortController();
  const late = deferred<typeof gpu.pipeline>();
  gpu.mock.createComputePipelineAsync = () => {
    gpu.state.compute++;
    return late.promise;
  };
  const failure = assert.rejects(
    SurfaceTracer.create(
      gpu.device,
      canvas.canvas,
      16,
      8,
      undefined,
      undefined,
      false,
      controller.signal,
    ),
    /TC_TRACE_DISPOSED/,
  );
  await turn();
  assert.equal(gpu.state.compute, 1);
  const shaders = gpu.state.shaders,
    raster = gpu.state.raster;
  controller.abort();
  late.resolve(gpu.pipeline);
  await failure;
  assert.equal(
    gpu.state.shaders,
    shaders,
    "aborted surface must not compile the primary shader",
  );
  assert.equal(
    gpu.state.raster,
    raster,
    "aborted surface must not start a raster pipeline",
  );
});

test("final GL cleanup awaits renderer disposal, aborts pending setup, and releases context once", async () => {
  const released = deferred<void>(),
    events: string[] = [],
    controller = new AbortController();
  controller.signal.addEventListener("abort", () => events.push("abort"));
  const browser = browserHarness(["disposeBrowser"], {
    backendKind: "webgl2",
    pendingSurface: controller,
    rasterCanvas: {
      removeEventListener() {},
      remove() {},
      getContext: () => ({
        getExtension: () => ({ loseContext: () => events.push("lose") }),
      }),
    },
    renderer: {
      async dispose() {
        events.push("dispose");
        await released.promise;
        events.push("disposed");
      },
    },
  });
  const first = browser.disposeBrowser(),
    second = browser.disposeBrowser();
  assert.deepEqual(events, ["abort", "dispose"]);
  released.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(events, ["abort", "dispose", "disposed", "lose"]);
  assert.equal(browser.errors.length, 0);
});

test("final GL context release still runs if renderer disposal rejects", async () => {
  let releases = 0;
  const browser = browserHarness(["disposeBrowser"], {
    backendKind: "webgl2",
    rasterCanvas: {
      removeEventListener() {},
      remove() {},
      getContext: () => ({
        getExtension: () => ({
          loseContext() {
            releases++;
          },
        }),
      }),
    },
    renderer: {
      async dispose() {
        throw new Error("injected renderer cleanup failure");
      },
    },
  });
  await browser.disposeBrowser();
  assert.equal(browser.errors.length, 1);
  assert.match(
    browser.errors[0],
    /TC_BROWSER_CLEANUP.*injected renderer cleanup failure/,
  );
  assert.equal(
    releases,
    1,
    "renderer cleanup failure must not retain the final GL context",
  );
});

test("final inspect remains usable after pagehide disposes the render settings service", async () => {
  const driver = createRenderSettingsDriver();
  const position = { toArray: () => [0, 0, 0] };
  let gameplayDisposed = false;
  const browser = browserHarness(
    ["disposeBrowser", "inspect", "syncRuntime", "onPageHide"],
    {
      renderControl: driver,
      runtime: { dispose: () => driver.dispose() },
      gameplay: {
        dispose() {
          gameplayDisposed = true;
        },
        inspect() {
          if (gameplayDisposed) throw new Error("TC_CONTENT_DISPOSED");
          return {};
        },
      },
      camera: { position },
      box: { position },
      morphMesh: { morphTargetInfluences: [0] },
      tip: { rotation: { z: 0 } },
      inputLog: [],
      generation: 0,
      lastGeometryHash: 0,
      frameAccumulator: 0,
    },
  );
  browser.onPageHide();
  await browser.disposal;
  assert.equal(gameplayDisposed, true);
  assert.throws(() => driver.service.state(), /TC_RENDER_DISPOSED/);
  const final = browser.inspect();
  assert.equal(final.ready, false);
  assert.equal(final.rendering.settings, undefined);
  assert.equal(final.runtime, undefined);
  assert.equal(final.gameplay, undefined);
  assert.equal(final.resources.resources, 0);
});

test("raster applies exposure before rendering and after renderer replacement on both backends", async () => {
  for (const backend of ["webgpu", "webgl2"] as const) {
    const driver = createRenderSettingsDriver({}, [], () =>
      renderCapabilities(backend),
    );
    const exposures: number[] = [];
    const renderer = () => ({
      toneMappingExposure: 1,
      render() {
        exposures.push(this.toneMappingExposure);
      },
    });
    const browser = browserHarness(["drawFrame"], {
      backendKind: backend,
      mode: "raster",
      renderControl: driver,
      renderer: renderer(),
    });
    driver.service.configure({ exposure: 3 });
    await browser.drawFrame(false, false);
    driver.service.configure({ exposure: 0.5 });
    await browser.drawFrame(false, false);
    browser.renderer = renderer();
    await browser.drawFrame(false, false);
    assert.deepEqual(exposures, [3, 0.5, 0.5]);
    driver.dispose();
  }
});
