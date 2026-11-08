import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import ts from "typescript";
import * as THREE from "three/webgpu";
import { Accessor, Document, NodeIO } from "@gltf-transform/core";
import {
  SDK_VERSION,
  defineGame,
  defineScene,
  instantiateGame,
} from "../packages/sdk/src/index.ts";
import { RuntimeHost } from "../packages/runtime/src/host.ts";
import { ResourceManager } from "../packages/runtime/src/resources.ts";
import type { SceneIR } from "../packages/compiler/src/types.ts";
import {
  prepareCheckpointProbes,
  selectInspectRecords,
  validateBrowserCheckpoint,
} from "../packages/renderer/src/checkpoint.ts";
import { createSimulation } from "../experiments/simulation/index.ts";
import { createWorldProbe } from "../experiments/world/index.ts";
import { runtimeStatus, inspectTraceCapabilities } from "../packages/renderer/src/startup.ts";
import { createRenderSettingsDriver } from "../packages/runtime/src/render-settings.ts";
import { createComputeDriver } from "../packages/runtime/src/compute-service.ts";
import { createComputeTextureAssets } from "../packages/renderer/src/compute-texture-assets.ts";
import { renderCapabilities, validateRenderCapabilities } from "../packages/runtime/src/render-capabilities.ts";
import { resolveEntityDefinition } from "../packages/runtime/src/prefabs.ts";
import { createGameServices } from "../packages/runtime/src/game-services.ts";
import { createModelLibrary } from "../packages/renderer/src/models.ts";
import { prepareGameplay } from "../packages/renderer/src/gameplay.ts";
import { createManagedGeometry } from "../packages/renderer/src/managed-geometry.ts";
import { setupPBRMaterial } from "../packages/renderer/src/pbr-material.ts";
import { createLightPlugin } from "../packages/gameplay/src/lights.ts";
import { createCinematicOverlay } from "../packages/renderer/src/cinematic-overlay.ts";
import { createRopeVisualOwner } from "../packages/renderer/src/rope-visuals.ts";
import { createClothVisualOwner } from "../packages/renderer/src/cloth-visuals.ts";
import { createFluidVisualOwner } from "../packages/renderer/src/fluid-visuals.ts";
import { createSoftBodyVisualOwner } from "../packages/renderer/src/softbody-visuals.ts";
import { createSpriteVisualOwner } from "../packages/renderer/src/sprite-visuals.ts";
import { createTilemapVisualOwner } from "../packages/renderer/src/tilemap-visuals.ts";
import { createCinematicPlugin } from "../packages/runtime/src/cinematics.ts";
import { createRopePlugin } from "../packages/simulation/src/rope-plugin.ts";
import { createClothPlugin } from "../packages/simulation/src/cloth-plugin.ts";
import { createFluidPlugin } from "../packages/simulation/src/fluid-plugin.ts";
import { createSoftBodyPlugin } from "../packages/simulation/src/softbody-plugin.ts";
import { createTerrainPlugin } from "../packages/runtime/src/terrain.ts";
import { createSpritePlugin } from "../packages/gameplay/src/sprites.ts";
import { createTilemapPlugin } from "../packages/gameplay/src/tilemaps.ts";
const presentationPlugins = [createLightPlugin, createCinematicPlugin, createRopePlugin, createClothPlugin, createFluidPlugin, createSoftBodyPlugin, createTerrainPlugin, createSpritePlugin, createTilemapPlugin];

// Execute the actual browser function bodies with real CPU World/resources/Three objects.
// No fake adapter result is used, and none of these tests constitutes GPU evidence.
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
function body(name: string) {
  const found = ast.statements.filter(
    (node): node is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(node) && node.name?.text === name,
  );
  assert.equal(found.length, 1, `Expected one browser function ${name}`);
  return found[0].getText(ast);
}
function harness(names: string[], context: Record<string, unknown>) {
  const text = names
    .map(body)
    .join("\n")
    .replaceAll("import.meta.env.BASE_URL", '"/"')
    .replaceAll("import.meta.env.DEV", "true");
  const script = ts.transpileModule(text, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2023,
      module: ts.ModuleKind.None,
    },
  }).outputText;
  const scope = vm.createContext({
    structuredClone,
    createManagedGeometry,
    setupPBRMaterial,
    gameplay: undefined,
    renderControl: undefined,
    computeControl: undefined,
    computeExecutor: undefined,
    renderBufferBridge: undefined,
    renderTextureBridge: undefined,
    postComposer: undefined,
    vertexBounds: undefined,
    surfaceTracer: undefined,
    pendingSurface: undefined,
    recoveringGpu: false,
    recoveryCount: 0,
    recoveryEvents: [],
    contentIteration: { status: "idle", applied: 0 },
    contentReleasedKeys: new Set<string>(),
    createRenderSettingsDriver,
    createComputeDriver,
    createComputeTextureAssets,
    renderCapabilities,
    validateRenderCapabilities,
    cameraCapabilities: (backend: "webgpu" | "webgl2") => renderCapabilities(backend),
    perspectiveCamera: new THREE.PerspectiveCamera(), orthographicCamera: new THREE.OrthographicCamera(),
    backendKind: "webgpu",
    lastStepCpuMs: 0,
    performance,
    startup: { automation: true, playing: false },
    playing: false,
    runtimeStatus,
    inspectTraceCapabilities,
    probeEnabled: false,
    dynamicVisualRevision: 0,
    diagnosticsVisible: true,
    gameSurfaceDefaults: new Map(),
    clearDynamicVisuals() {},
    ropeVisuals: createRopeVisualOwner(), clothVisuals: createClothVisualOwner(), terrainVisuals: createClothVisualOwner(),
    fluidVisuals: createFluidVisualOwner(), softBodyVisuals: createSoftBodyVisualOwner(), spriteVisuals: createSpriteVisualOwner(), tilemapVisuals: createTilemapVisualOwner(),
    cinematicOverlay: { clear() {}, dispose() {}, sync() {} },
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
    onWindowBlur() {},
    onVisibilityChange() {},
    onResize() {},
    resolveEntityDefinition,
    URL,
    document: { baseURI: "http://localhost/", removeEventListener() {} },
    ...context,
  });
  // Vite substitutions only; tested functions remain the source implementations.
  vm.runInContext(script, scope);
  return scope as Record<string, any>;
}

test("browser draw queue serializes asynchronous surface setup and keeps later frames runnable after failure", async () => {
  const events: string[] = [];
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let call = 0,
    active = 0,
    peak = 0;
  const context = harness(["draw"], {
    drawTail: Promise.resolve(),
    frameSerial: 0,
    document: { documentElement: { dataset: {} }, removeEventListener() {} },
    drawFrame: async () => {
      const id = ++call;
      active++;
      peak = Math.max(peak, active);
      events.push("start-" + id);
      try {
        if (id === 1) await gate;
        if (id === 2) throw new Error("frame failed");
        events.push("end-" + id);
      } finally {
        active--;
      }
    },
  });
  const first = context.draw(),
    second = context.draw(),
    third = context.draw();
  const failure = assert.rejects(second, /frame failed/);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["start-1"]);
  assert.equal(
    context.document.documentElement.dataset.pelicanFrameState,
    "drawing",
  );
  release();
  await first;
  await failure;
  await third;
  assert.equal(peak, 1);
  assert.deepEqual(events, ["start-1", "end-1", "start-2", "start-3", "end-3"]);
  assert.equal(context.frameSerial, 2);
  assert.equal(
    context.document.documentElement.dataset.pelicanFrameSerial,
    "2",
  );
  assert.equal(
    context.document.documentElement.dataset.pelicanFrameState,
    "idle",
  );
});

test("late errors after browser teardown cannot publish a new runtime fault", () => {
  const errors: string[] = [];
  const context = harness(["reportFailure"], { disposed: true, errors, console: { error() { throw Error("disposed owner logged a fault"); } } });
  context.reportFailure(new Error("late cancelled compute"));
  assert.deepEqual(errors, []);
});

test("paused input draws coalesce bursts instead of starting a second renderer initialization", async () => {
  let resolve: () => void = () => {},
    calls = 0;
  const gate = new Promise<void>((done) => {
    resolve = done;
  });
  const context = harness(["requestInputDraw"], {
    inputDrawRequested: false,
    inputDrawActive: false,
    playing: false,
    disposed: false,
    draw: async () => {
      calls++;
      if (calls === 1) await gate;
    },
    reportFailure: (error: unknown) => {
      throw error;
    },
  });
  context.requestInputDraw();
  context.requestInputDraw();
  context.requestInputDraw();
  assert.equal(calls, 1);
  resolve();
  await new Promise<void>((done) => setImmediate(done));
  assert.equal(calls, 2);
  assert.equal(context.inputDrawActive, false);
  context.playing = true;
  context.requestInputDraw();
  await new Promise<void>((done) => setImmediate(done));
  assert.equal(calls, 2);
});
function ir(): SceneIR {
  return {
    format: "pelican.scene",
    version: 1,
    engineVersion: SDK_VERSION,
    gameId: "browser-contract",
    scene: {
      gravity: [0, -9.81, 0],
      id: "scene",
      camera: {
        position: [0, 1, 5],
        target: [0, 0, 0],
        fov: 50,
        near: 0.1,
        far: 100,
      },
      environment: { background: "#000000", ambientIntensity: 1 },
      entities: [
        {
          id: "root",
          transform: {
            position: [1, 0, 0],
            rotation: [0, 0, 0],
            scale: [1, 1, 1],
          },
          components: {},
          mesh: {
            geometry: { kind: "box", size: [1, 1, 1] },
            material: "red",
            castShadow: true,
            receiveShadow: true,
          },
        },
      ],
    },
    components: [],
    systems: [],
    prefabs: [],
    computes: [],
    assets: [],
    materials: [
      {
        id: "red",
        color: "#ff0000",
        roughness: 0.5,
        metalness: 0,
        source: { file: "game.ts", line: 1, column: 1, length: 1 },
      },
    ],
  };
}
const moduleValue = {
  createGame: (facade: any) =>
    instantiateGame(
      defineGame({
        id: "browser-contract",
        scene: defineScene({ id: "scene", entities: [] }),
      }),
      facade,
    ),
};
function hostRig() {
  const definition = ir();
  const host = new RuntimeHost(definition, { plugins: presentationPlugins });
  host.attach(moduleValue.createGame(host.facade));
  return { definition, host };
}
function viewHarness(host: RuntimeHost, definition: SceneIR) {
  const gameRoot = new THREE.Group();
  return harness(["releaseObject", "createEntityView", "syncRuntime"], {
    THREE,
    runtime: host,
    compiledIR: definition,
    gameRoot,
    gameObjects: new Map(),
    gameMaterials: new Map([
      ["red", new THREE.MeshStandardNodeMaterial({ color: "red" })],
    ]),
    transforms: new Map(),
    componentState: new Map(),
    authoredLights: [],
  });
}

test("browser views: destroy releases geometry; restore rebuilds authored mesh without restoring old handles", () => {
  const { host, definition } = hostRig();
  const view = viewHarness(host, definition);
  try {
    view.syncRuntime();
    const node = view.gameObjects.get("root");
    const mesh = node.children[0];
    let released = 0;
    mesh.geometry.addEventListener("dispose", () => released++);
    const saved = host.snapshot();
    const handle = host.world.resolve("root");
    host.world.queue({ type: "destroy", entity: "root" });
    host.world.flush();
    view.syncRuntime();
    assert.equal(released, 1);
    assert.equal(view.gameObjects.size, 0);
    host.restore(saved);
    view.syncRuntime();
    const restored = view.gameObjects.get("root");
    assert.notEqual(restored, node);
    assert.ok(restored.children[0] instanceof THREE.Mesh);
    assert.notEqual(restored.children[0].geometry, mesh.geometry);
    assert.equal(host.world.isAlive(handle), false);
    assert.equal(restored.position.x, 1);
  } finally {
    view.releaseObject(view.gameRoot);
    for (const material of view.gameMaterials.values()) material.dispose();
    host.dispose();
  }
});

test("browser views: runtime-only spawn is a Group; display maps are derived from World", () => {
  const { host, definition } = hostRig();
  const view = viewHarness(host, definition);
  try {
    host.world.queue({
      type: "spawn",
      entity: {
        id: "spawned",
        parent: "root",
        transform: { position: [2, 0, 0] },
      },
    });
    host.world.flush();
    view.transforms.set("fake", {});
    view.componentState.set("fake", {});
    view.syncRuntime();
    assert.equal(view.transforms.has("fake"), false);
    assert.equal(view.componentState.has("fake"), false);
    assert.equal(view.gameObjects.get("spawned").children.length, 0);
    view.gameRoot.updateMatrixWorld(true);
    assert.equal(
      view.gameObjects.get("spawned").getWorldPosition(new THREE.Vector3()).x,
      3,
    );
  } finally {
    view.releaseObject(view.gameRoot);
    for (const material of view.gameMaterials.values()) material.dispose();
    host.dispose();
  }
});

test("browser views: removing a parent and child disposes each geometry once", () => {
  const { host, definition } = hostRig();
  definition.prefabs.push({ ...structuredClone(definition.scene.entities[0]), id: "child" });
  const view = viewHarness(host, definition);
  try {
    host.world.spawn({ id: "child", prefab: "child", parent: "root" });
    view.syncRuntime();
    const child = view.gameObjects.get("child");
    let disposed = 0;
    child.children[0].geometry.addEventListener("dispose", () => disposed++);
    host.world.destroy("root");
    view.syncRuntime();
    assert.equal(disposed, 1);
    assert.equal(view.gameObjects.size, 0);
  } finally {
    view.releaseObject(view.gameRoot);
    for (const material of view.gameMaterials.values()) material.dispose();
    host.dispose();
  }
});

test("browser views: replacing a parent prefab preserves surviving child resources", () => {
  const { host, definition } = hostRig();
  definition.prefabs.push(
    { ...structuredClone(definition.scene.entities[0]), id: "parent-a" },
    { ...structuredClone(definition.scene.entities[0]), id: "parent-b" },
    { ...structuredClone(definition.scene.entities[0]), id: "child" },
  );
  const view = viewHarness(host, definition);
  try {
    host.world.spawn({ id: "parent", prefab: "parent-a" });
    host.world.spawn({ id: "child", prefab: "child", parent: "parent" });
    view.syncRuntime();
    const child = view.gameObjects.get("child");
    let disposed = 0;
    child.children[0].geometry.addEventListener("dispose", () => disposed++);
    host.world.destroy("parent");
    host.world.spawn({ id: "parent", prefab: "parent-b" });
    host.world.spawn({ id: "child", prefab: "child", parent: "parent" });
    view.syncRuntime();
    assert.equal(disposed, 0);
    assert.equal(view.gameObjects.get("child"), child);
    assert.equal(child.parent, view.gameObjects.get("parent"));
  } finally {
    view.releaseObject(view.gameRoot);
    for (const material of view.gameMaterials.values()) material.dispose();
    host.dispose();
  }
});

test("browser views: replacing a parent prefab replaces its model without releasing a surviving child's shared geometry", async () => {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const positions = doc.createAccessor("positions", buffer).setType(Accessor.Type.VEC3)
    .setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]));
  const mesh = doc.createMesh("triangle").addPrimitive(doc.createPrimitive().setAttribute("POSITION", positions));
  const scene = doc.createScene("scene").addChild(doc.createNode("triangle").setMesh(mesh));
  doc.getRoot().setDefaultScene(scene);
  const bytes = await new NodeIO().writeBinary(doc);
  const models = createModelLibrary({ a: "a.glb", b: "b.glb" }, {
    baseURL: "https://assets.test/",
    fetch: async () => new Response(bytes.slice(), { status: 200 }),
  });
  await models.prepare();
  const { host, definition } = hostRig();
  const base = structuredClone(definition.scene.entities[0]);
  definition.prefabs.push(
    { ...base, id: "parent-a", mesh: undefined, model: { asset: "a", scale: 1 } },
    { ...base, id: "parent-b", mesh: undefined, model: { asset: "b", scale: 1 } },
    { ...base, id: "parent-empty", mesh: undefined },
    { ...base, id: "child", mesh: undefined, model: { asset: "a", scale: 1 } },
  );
  const view = viewHarness(host, definition);
  view.gameplay = { models };
  try {
    host.world.spawn({ id: "parent", prefab: "parent-a" });
    host.world.spawn({ id: "child", prefab: "child", parent: "parent" });
    view.syncRuntime();
    const old = models.get("parent")!;
    const child = models.get("child")!;
    const geometry = (child.node.getObjectByName("triangle") as THREE.Mesh).geometry;
    let disposed = 0;
    geometry.addEventListener("dispose", () => disposed++);
    host.world.destroy("parent");
    host.world.spawn({ id: "parent", prefab: "parent-b" });
    host.world.spawn({ id: "child", prefab: "child", parent: "parent" });
    view.syncRuntime();
    assert.notEqual(models.get("parent"), old);
    assert.equal(models.snapshot().animations.find((item) => item.entity === "parent")?.asset, "b");
    assert.equal(models.get("child"), child);
    assert.equal(child.node.parent, view.gameObjects.get("child"));
    assert.equal(view.gameObjects.get("child").parent, view.gameObjects.get("parent"));
    assert.equal(disposed, 0);
    assert.equal(models.inspect().instances, 2);
    host.world.destroy("parent");
    host.world.spawn({ id: "parent", prefab: "parent-a" });
    host.world.spawn({ id: "child", prefab: "child", parent: "parent" });
    view.syncRuntime();
    assert.equal((models.get("parent")!.node.getObjectByName("triangle") as THREE.Mesh).geometry, geometry);
    host.world.destroy("parent");
    host.world.spawn({ id: "parent", prefab: "parent-empty" });
    host.world.spawn({ id: "child", prefab: "child", parent: "parent" });
    view.syncRuntime();
    assert.equal(models.get("parent"), undefined);
    assert.equal(models.get("child"), child);
    assert.equal(disposed, 0);
    assert.equal(view.gameObjects.get("child").parent, view.gameObjects.get("parent"));
  } finally {
    await models.dispose();
    view.releaseObject(view.gameRoot);
    for (const material of view.gameMaterials.values()) material.dispose();
    host.dispose();
  }
});

test("gameplay model snapshots restore changed prefab definitions without mutating active models during preflight", async () => {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const positions = doc.createAccessor("positions", buffer).setType(Accessor.Type.VEC3)
    .setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]));
  const mesh = doc.createMesh("triangle").addPrimitive(doc.createPrimitive().setAttribute("POSITION", positions));
  doc.getRoot().setDefaultScene(doc.createScene("scene").addChild(doc.createNode("triangle").setMesh(mesh)));
  const bytes = await new NodeIO().writeBinary(doc);
  const oldFetch = globalThis.fetch;
  const oldDocument = globalThis.document;
  globalThis.fetch = async () => new Response(bytes.slice(), { status: 200 });
  globalThis.document = { createElement: () => ({ dataset: {}, style: {}, addEventListener() {}, removeEventListener() {}, remove() {} }) } as unknown as typeof globalThis.document;
  const definition = ir();
  const base = structuredClone(definition.scene.entities[0]);
  definition.prefabs.push(
    { ...base, id: "a", mesh: undefined, model: { asset: "a", scale: 1 } },
    { ...base, id: "b", mesh: undefined, model: { asset: "b", scale: 1 } },
  );
  for (const id of ["a", "b"]) definition.assets.push({ id, type: "model", path: `${id}.glb`, sourcePath: `${id}.glb`, hash: id, source: { file: "game.ts", line: 1, column: 1, length: 1 } });
  let gameplay: Awaited<ReturnType<typeof prepareGameplay>> | undefined;
  let host: RuntimeHost | undefined;
  try {
    gameplay = await prepareGameplay(definition, "https://assets.test/", {} as THREE.Renderer);
    host = new RuntimeHost(definition, { plugins: gameplay.plugins });
    host.attach(moduleValue.createGame(host.facade));
    host.world.spawn({ id: "item", prefab: "a" });
    const savedA = host.snapshot();
    host.world.destroy("item");
    host.world.spawn({ id: "item", prefab: "b" });
    const savedB = host.snapshot();
    const active = gameplay.models.get("item")!;
    const geometry = (active.node.getObjectByName("triangle") as THREE.Mesh).geometry;
    const beforeInspection = gameplay.models.inspect();
    let disposed = 0;
    geometry.addEventListener("dispose", () => disposed++);
    const modelIndex = host.inspect().plugins.ids.indexOf("$engine.models");
    assert.ok(modelIndex >= 0);
    const plugin = gameplay.plugins[modelIndex]({ world: host.world, scene: definition, events: () => [], emit: () => { throw new Error("unexpected emit"); } });
    plugin.validateSnapshot(savedA.plugins!["$engine.models"].payload);
    assert.equal(gameplay.models.get("item"), active);
    assert.throws(() => gameplay!.models.register("item", { asset: "a" }), /TC_MODEL_DEFINITION_CONFLICT/);
    const bad = structuredClone(savedA);
    const payload = bad.plugins!["$engine.models"].payload as any;
    payload.animation.animations[0].asset = "b";
    assert.throws(() => host!.restore(bad), /TC_MODEL_INVALID_SNAPSHOT/);
    const badWorld = structuredClone(savedB);
    (badWorld.plugins!["$engine.models"].payload as any).bindings[0].prefab = "a";
    (badWorld.plugins!["$engine.models"].payload as any).animation.animations[0].asset = "a";
    assert.throws(() => host!.restore(badWorld), /TC_MODEL_BINDINGS_WORLD/);
    assert.equal(gameplay.models.get("item"), active);
    assert.equal((active.node.getObjectByName("triangle") as THREE.Mesh).geometry, geometry);
    assert.equal(disposed, 0);
    assert.deepEqual(gameplay.models.inspect(), beforeInspection);
    assert.throws(() => gameplay!.models.register("item", { asset: "a" }), /TC_MODEL_DEFINITION_CONFLICT/);
    gameplay.models.register("item", { asset: "b" });
    assert.deepEqual(host.snapshot(), savedB);
    host.restore(savedA);
    assert.equal(gameplay.models.snapshot().animations[0].asset, "a");
    assert.notEqual(gameplay.models.get("item"), active);
    assert.equal(disposed, 0);
    host.restore(savedB);
    assert.equal(gameplay.models.snapshot().animations[0].asset, "b");
    assert.equal((gameplay.models.get("item")!.node.getObjectByName("triangle") as THREE.Mesh).geometry, geometry);
    assert.equal(disposed, 0);
  } finally {
    host?.dispose();
    await gameplay?.dispose();
    globalThis.fetch = oldFetch;
    globalThis.document = oldDocument;
  }
});

test("browser views: spawned prefab creates real geometry and retains content identity across restore", () => {
  const { host, definition } = hostRig();
  definition.prefabs.push({
    ...structuredClone(definition.scene.entities[0]),
    id: "crate",
  });
  const view = viewHarness(host, definition);
  try {
    host.world.queue({
      type: "spawn",
      entity: {
        id: "copy",
        prefab: "crate",
        transform: { position: [3, 0, 0] },
      },
    });
    host.world.flush();
    view.syncRuntime();
    const copy = view.gameObjects.get("copy");
    assert.ok(copy.children[0] instanceof THREE.Mesh);
    assert.equal(copy.position.x, 3);
    const saved = host.world.snapshot();
    host.world.destroy("copy");
    view.syncRuntime();
    host.world.restore(saved);
    view.syncRuntime();
    assert.ok(view.gameObjects.get("copy").children[0] instanceof THREE.Mesh);
    assert.equal(
      host.world.records().find((r) => r.id === "copy")?.prefab,
      "crate",
    );
  } finally {
    view.releaseObject(view.gameRoot);
    for (const material of view.gameMaterials.values()) material.dispose();
    host.dispose();
  }
});

async function loadHarness() {
  const { host, definition } = hostRig();
  const view = viewHarness(host, definition);
  view.syncRuntime();
  const manager = new ResourceManager<any>();
  let payload: unknown = definition;
  let moduleFail = false;
  let runtimeReady: Promise<void> | undefined;
  let created!: () => void;
  let whenCreated = new Promise<void>(resolve => { created = resolve; });
  manager.registerLoader("json", { load: async () => payload, dispose() {} });
  manager.registerLoader("module", {
    load: async () => {
      if (moduleFail) throw new Error("module failure");
      return { createGame(engine: Parameters<typeof moduleValue.createGame>[0]) {
        const game = moduleValue.createGame(engine); created();
        return runtimeReady ? { ...game, ready: runtimeReady } : game;
      } };
    },
    dispose() {},
  });
  const scope = manager.createScope();
  await manager.acquire("json", "initial-scene", { url: "scene" }, scope);
  await manager.acquire("module", "initial-game", { url: "game" }, scope);
  const context = harness(
    ["releaseObject", "createEntityView", "syncRuntime", "slotTypes", "materialSlotTypes", "textureSlotTypes", "materialTextureTypes", "usesRenderTextures", "usesRenderSlots", "slotResources", "textureResources", "applyMaterialGraphs", "loadGame"],
    {
      ...view,
      THREE,
      RuntimeHost,
      boundedOperation: async (work: Promise<unknown>) => await work,
      // The actual browser has one realm; translate the VM-created descriptor into the owner's realm.
      resourceManager: {
        createScope: () => manager.createScope(),
        get: (handle: any) => manager.get(handle),
        acquire: (type: string, key: string, descriptor: any, owner: any) =>
          manager.acquire(type, key, structuredClone(descriptor), owner),
      },
      contentScope: scope,
      loadingContent: false,
      restoring: false,
      disposed: false,
      contentGeneration: 0,
      materialGraphs: [],
      probeEnabled: false,
      renderer: undefined,
      // Keep real SDK services; this CPU transaction harness has no DOM/GPU presentation.
      async prepareGameplay(content: SceneIR) {
        const models = createModelLibrary([]);
        const services = createGameServices(content, models.animation);
        return {
          plugins: [services.factory, ...presentationPlugins],
          models,
          services,
          textures: new Map(),
          mount() {},
          dispose: () => models.dispose(),
        };
      },
      graphTime: { value: 0 },
      graphToTSL() {
        throw new Error("invalid graph");
      },
      typedGraphToTSL() {
        throw new Error("invalid graph");
      },
      camera: new THREE.PerspectiveCamera(),
      authoredCamera: {},
      scene: new THREE.Scene(),
      inputLog: [],
      errors: [],
      tick: 0,
      frameAccumulator: 0,
      lastFrameTime: undefined,
      terminalFault: false,
    },
  );
  return {
    context,
    host,
    manager,
    setPayload(value: unknown) {
      payload = value;
    },
    failModule() {
      moduleFail = true;
    },
    setReadiness(value: Promise<void>) { runtimeReady = value; whenCreated = new Promise<void>(resolve => { created = resolve; }); },
    created: () => whenCreated,
    async dispose() {
      context.runtime.dispose();
      await context.gameplay?.dispose();
      context.releaseObject(context.gameRoot);
      for (const material of context.gameMaterials.values()) material.dispose();
      await manager.dispose();
    },
  };
}

test("browser scene transactions await author initialization before commit and preserve old content on rejection", async () => {
  for (const reject of [false, true]) {
    const rig = await loadHarness();
    let resolve!: () => void, fail!: (error: Error) => void;
    const ready = new Promise<void>((yes, no) => { resolve = yes; fail = no; });
    rig.setReadiness(ready);
    try {
      const previous = rig.context.runtime;
      const transaction = rig.context.loadGame();
      await rig.created();
      assert.equal(rig.context.runtime, previous);
      assert.equal(previous.inspect().disposed, false);
      if (reject) {
        fail(new Error("runtime initialization failed"));
        await assert.rejects(transaction, /runtime initialization failed/);
        assert.equal(rig.context.runtime, previous);
        assert.equal(previous.inspect().disposed, false);
      } else {
        resolve(); await transaction;
        assert.notEqual(rig.context.runtime, previous);
        assert.equal(previous.inspect().disposed, true);
      }
    } finally { await rig.dispose(); }
  }
});

for (const failure of [
  "json-null",
  "module",
  "material-graph",
  "missing-material",
] as const)
  test(`browser load transaction: ${failure} preserves old Host, view and scope`, async () => {
    const rig = await loadHarness();
    const { context, host, manager } = rig;
    const original = context.gameObjects.get("root");
    const snapshot = host.snapshot();
    try {
      if (failure === "json-null") rig.setPayload(null);
      if (failure === "module") rig.failModule();
      if (failure === "material-graph") {
        const broken = ir();
        broken.materials[0].graph = {
          nodes: [],
          output: "missing",
          outputType: "vec3",
          nodeTypes: {},
        };
        rig.setPayload(broken);
      }
      if (failure === "missing-material") {
        const broken = ir();
        broken.scene.entities[0].mesh!.material = "missing";
        rig.setPayload(broken);
      }
      const message = {
        "json-null": /TC_IR_VERSION/,
        module: /Resource loading failed/,
        "material-graph": /invalid graph/,
        "missing-material": /TC_MATERIAL_MISSING/,
      }[failure];
      await assert.rejects(context.loadGame(), message);
      assert.equal(context.runtime, host);
      assert.equal(context.gameObjects.get("root"), original);
      assert.deepEqual(host.snapshot(), snapshot);
      assert.equal(context.loadingContent, false);
      assert.deepEqual(manager.inspect().owned, {
        entries: 2,
        pending: 0,
        loaded: 2,
        references: 2,
        scopes: 1,
        inFlightLoads: 0,
        inFlightDisposals: 0,
      });
    } finally {
      await rig.dispose();
    }
  });

test("browser load transaction: commit replaces content and disposes previous ownership", async () => {
  const rig = await loadHarness();
  try {
    const oldNode = rig.context.gameObjects.get("root");
    let released = 0;
    oldNode.children[0].geometry.addEventListener("dispose", () => released++);
    await rig.context.loadGame();
    assert.notEqual(rig.context.runtime, rig.host);
    assert.equal(rig.host.inspect().disposed, true);
    assert.equal(released, 1);
    assert.equal(rig.manager.inspect().owned.scopes, 1);
    assert.equal(rig.manager.inspect().owned.entries, 2);
    assert.equal(rig.context.runtime.facade.scenes.current(), "scene");
  } finally {
    await rig.dispose();
  }
});

test("browser first-load transaction does not call Object3D.add with an empty spread", async () => {
  const rig = await loadHarness();
  const originalAdd = THREE.Object3D.prototype.add;
  const invalid: unknown[][] = [];
  THREE.Object3D.prototype.add = function (...objects: THREE.Object3D[]) {
    if (!objects.length || objects.some((object) => !object))
      invalid.push(objects);
    return originalAdd.apply(
      this,
      objects as [THREE.Object3D, ...THREE.Object3D[]],
    );
  };
  try {
    rig.context.gameRoot.clear();
    rig.context.gameObjects.clear();
    await rig.context.loadGame();
    assert.deepEqual(invalid, []);
    assert.equal(rig.manager.inspect().owned.scopes, 1);
  } finally {
    THREE.Object3D.prototype.add = originalAdd;
    await rig.dispose();
  }
});

test("checkpoint: display validation is detached, rejects invalid topology/input/resource identity", () => {
  const { host } = hostRig();
  const resources = {
    format: "pelican.resources",
    version: 1,
    resources: [],
  } as const;
  const saved = {
    format: "pelican.browser",
    version: 1,
    engineVersion: SDK_VERSION,
    tick: 0,
    cameraPhase: 0,
    frameAccumulator: 0,
    inputLog: [],
    topology: [[1, 2, 3]],
    runtime: host.snapshot(),
    resources,
  };
  try {
    const checked = validateBrowserCheckpoint(saved, resources as any);
    checked.topology[0][0] = 9;
    assert.equal(saved.topology[0][0], 1);
    for (const patch of [
      { topology: [[0, Infinity, 0]] },
      { inputLog: [{ tick: 1, key: "a" }] },
      { runtime: undefined },
      { resources: {} },
      { frameAccumulator: -1 },
    ])
      assert.throws(
        () =>
          validateBrowserCheckpoint({ ...saved, ...patch }, resources as any),
        /TC_BROWSER_/,
      );
  } finally {
    host.dispose();
  }
});

test("checkpoint: real probe preflight rejects invalid simulation/world before touching live runtime", async () => {
  const { host } = hostRig();
  const simulation = createSimulation("cloth");
  const world = createWorldProbe();
  try {
    await world.loadChunk([0, 0]);
    const before = host.snapshot();
    const handle = host.world.resolve("root");
    const badSimulation = simulation.snapshot();
    badSimulation.particles[0].position[0] = Infinity;
    await assert.rejects(
      prepareCheckpointProbes({ simulation: badSimulation }),
    );
    const badWorld = world.snapshot();
    badWorld.resident[0].heights = [];
    await assert.rejects(
      prepareCheckpointProbes({
        simulation: simulation.snapshot(),
        world: badWorld,
      }),
    );
    assert.deepEqual(host.snapshot(), before);
    assert.equal(host.world.isAlive(handle), true);
    const prepared = await prepareCheckpointProbes({
      simulation: simulation.snapshot(),
      world: world.snapshot(),
    });
    assert.deepEqual(prepared.simulation!.snapshot(), simulation.snapshot());
    assert.deepEqual(prepared.world!.snapshot(), world.snapshot());
    prepared.dispose();
  } finally {
    host.dispose();
    simulation.dispose();
    world.dispose();
  }
});

test("inspect: bounded records, filtered totals, empty page and missing entity diagnostics", () => {
  const records = Array.from({ length: 1200 }, (_, i) => ({ id: `e${i}` }));
  const page = selectInspectRecords(records, { offset: 11, limit: 3 });
  assert.deepEqual(page.paging, {
    total: 1200,
    offset: 11,
    limit: 3,
    returned: 3,
  });
  assert.deepEqual(
    page.records.map((record) => record.id),
    ["e11", "e12", "e13"],
  );
  assert.equal(selectInspectRecords(records, {}).records.length, 100);
  assert.deepEqual(selectInspectRecords(records, { entity: "e9" }).paging, {
    total: 1,
    offset: 0,
    limit: 100,
    returned: 1,
  });
  assert.equal(
    selectInspectRecords(records, { offset: 5000 }).paging.returned,
    0,
  );
  assert.throws(
    () => selectInspectRecords(records, { entity: "absent" }),
    /TC_BROWSER_ENTITY_MISSING/,
  );
});

test("browser inspect: optional selection omits IR, slices both render maps, default shape stays compatible", () => {
  const { host, definition } = hostRig();
  const view = viewHarness(host, definition);
  const context = harness(["inspect"], {
    ...view,
    selectInspectRecords,
    disposed: false,
    terminalFault: false,
    adapterInfo: {},
    mode: "raster",
    tick: 0,
    width: 960,
    height: 540,
    inputLog: [],
    triangleCount: 12,
    nodeCount: 1,
    generation: 1,
    lastGeometryHash: 123,
    box: { position: new THREE.Vector3() },
    morphMesh: { morphTargetInfluences: [0] },
    tip: { rotation: { z: 0 } },
    camera: new THREE.PerspectiveCamera(),
    errors: [],
    frameAccumulator: 0,
    resourceManager: { inspect: () => ({}) },
    simulation: undefined,
    world: undefined,
    metrics: [],
  });
  try {
    const initial = context.inspect();
    assert.equal(initial.capabilities.tracer, "WebGPU surface triangle-BVH (lazy initialization)");
    assert.equal(initial.capabilities.tracerInitialized, false);
    assert.equal(initial.compiledIR, definition);
    assert.equal("paging" in initial, false);
    assert.equal(initial.runtime.records.length, 1);
    const selected = context.inspect({ entity: "root", limit: 1 });
    assert.equal("compiledIR" in selected, false);
    assert.deepEqual(Object.keys(selected.game.transforms), ["root"]);
    assert.deepEqual(Object.keys(selected.game.components), ["root"]);
    assert.equal(selected.paging.returned, 1);
    const empty = context.inspect({ offset: 1 });
    assert.equal(empty.runtime.records.length, 0);
    assert.equal(Object.keys(empty.game.transforms).length, 0);
    assert.throws(
      () => context.inspect({ entity: "missing" }),
      /TC_BROWSER_ENTITY_MISSING/,
    );
  } finally {
    view.releaseObject(view.gameRoot);
    for (const material of view.gameMaterials.values()) material.dispose();
    host.dispose();
  }
});

function restoreFunction() {
  let found: ts.ArrowFunction | undefined;
  const visit = (node: ts.Node) => {
    if (
      ts.isPropertyAssignment(node) &&
      node.name.getText(ast) === "restore" &&
      ts.isArrowFunction(node.initializer)
    )
      found = node.initializer;
    ts.forEachChild(node, visit);
  };
  visit(ast);
  assert.ok(found);
  return ts.transpileModule(`globalThis.restore = ${found.getText(ast)}`, {
    compilerOptions: { target: ts.ScriptTarget.ES2023 },
  }).outputText;
}

test("browser restore: invalid sidecars leave real Host, generations and presentation unchanged", async () => {
  const { host } = hostRig();
  const temporalInvalidations: string[] = [];
  const resources = { format: "pelican.resources", version: 1, resources: [] };
  const simulation = createSimulation("cloth");
  const world = createWorldProbe();
  await world.loadChunk([0, 0]);
  const context = vm.createContext({
    requireRuntime: () => host,
    resourceManager: { snapshot: () => structuredClone(resources) },
    contentScope: {},
    validateBrowserCheckpoint,
    prepareCheckpointProbes,
    THREE,
    standard: () => new THREE.MeshStandardMaterial(),
    runtime: host,
    simulation,
    world,
    restoring: false,
    gamepadFingerprint: undefined,
    disposed: false,
    frameAccumulator: 0,
    lastFrameTime: undefined,
    tick: 0,
    cameraPhase: 0,
    inputLog: [],
    topologyObjects: [],
    terminalFault: false,
    syncRuntime() {},
    syncSimulation() {},
    syncWorld() {},
    draw: async () => {},
    device: { queue: { onSubmittedWorkDone: async () => {} } },
    submittedWork: async () => {},
    inspect: () => host.inspect(),
    scene: new THREE.Scene(),
    boundedOperation: async (work: Promise<unknown>) => await work,
    postComposer: undefined,
    surfaceTracer: {
      invalidateTemporal(reason: string) {
        assert.equal(
          host.world.getTransform("root").position[0],
          1,
          "visual invalidation follows successful Host restore",
        );
        temporalInvalidations.push(reason);
      },
    },
  });
  vm.runInContext(restoreFunction(), context);
  try {
    const before = host.snapshot(),
      handle = host.world.resolve("root");
    const saved = {
      format: "pelican.browser",
      version: 1,
      engineVersion: SDK_VERSION,
      tick: 0,
      cameraPhase: 0,
      frameAccumulator: 0,
      inputLog: [],
      topology: [],
      runtime: before,
      resources,
      simulation: simulation.snapshot(),
      world: world.snapshot(),
    };
    const badSimulation = structuredClone(saved);
    badSimulation.simulation.particles[0].position[0] = Infinity;
    const badWorld = structuredClone(saved);
    badWorld.world.resident[0].heights = [];
    for (const broken of [badSimulation, badWorld]) {
      await assert.rejects((context as any).restore(broken));
      assert.deepEqual(host.snapshot(), before);
      assert.equal(host.world.isAlive(handle), true);
      assert.equal(context.simulation, simulation);
      assert.equal(context.world, world);
      assert.equal(context.restoring, false);
      assert.deepEqual(temporalInvalidations, []);
    }
    host.world.setTransform("root", { position: [9, 0, 0] });
    await (context as any).restore(saved);
    assert.deepEqual(temporalInvalidations, ["restore"]);
    assert.equal(host.world.isAlive(handle), false);
    assert.equal(context.restoring, false);
  } finally {
    host.dispose();
    (context.simulation as typeof simulation).dispose();
    (context.world as typeof world).dispose();
  }
});

test("browser source contracts: restore preflights probes, Host retains ownership, production auto plays", () => {
  const restoreStart = source.indexOf("restore: async (value: unknown)");
  const restoreEnd = source.indexOf("worldLoad:", restoreStart);
  const restore = source.slice(restoreStart, restoreEnd);
  assert.ok(
    restore.indexOf("prepareCheckpointProbes(saved)") <
      restore.indexOf("host.restore(saved.runtime)"),
  );
  assert.doesNotMatch(restore, /runtime\s*=|\.generation\s*=/);
  assert.match(
    source,
    /if \(import\.meta\.env\.DEV\)\s*\(window[\s\S]*?\.__pelican = api/,
  );
  assert.match(source, /playing = startup.playing/);
  assert.doesNotMatch(
    source,
    /status\.textContent = "Waiting GPU";\s*await boundedOperation\(\s*device\.queue\.onSubmittedWorkDone\(\)/,
    "initial queue completion must not block exposing the runtime",
  );
  let capture: ts.CaseClause | undefined;
  const visit = (node: ts.Node): void => {
    if (
      ts.isCaseClause(node) &&
      ts.isStringLiteral(node.expression) &&
      node.expression.text === "capture"
    )
      capture = node;
    ts.forEachChild(node, visit);
  };
  visit(ast);
  assert.ok(capture, "Capture dispatch must be explicit");
  const captureSource = capture.getText(ast);
  assert.throws(
    () => vm.runInNewContext(`switch ("capture") { ${captureSource} }`),
    /TC_CONTROL_TOOL_ONLY/,
  );
  assert.match(source, /if \(data === undefined\)\s*throw/);
  assert.match(body("stepRuntime"), /reportFailure\(error\);\s*throw error/);
  assert.match(body("requireRuntime"), /TC_RUNTIME_NOT_ATTACHED/);
  assert.doesNotMatch(
    source,
    /case "(?:input|recordStart|recordStop|setComponent)": runtime\?\./,
  );
});

test("browser disposal: idempotent cleanup isolates errors, clears ownership and stops RAF", async () => {
  const calls: string[] = [];
  const run = (id: string) => () => {
    calls.push(id);
  };
  const context = harness(["disposeBrowser"], {
    disposal: undefined,
    disposed: false,
    playing: true,
    lastFrameTime: 1,
    frameRequest: 7,
    cancelAnimationFrame: run("cancel"),
    document: { documentElement: { dataset: {} }, removeEventListener() {} },
    window: { removeEventListener() {} },
    onKeyDown() {},
    onKeyUp() {},
    onPageHide() {},
    onContextRestored() {},
    runtime: { dispose: run("host") },
    simulation: { dispose: run("simulation") },
    world: { dispose: run("world") },
    resourceManager: {
      dispose: async () => {
        calls.push("resources");
      },
    },
    releaseObject: run("scene"),
    scene: {},
    tracer: {
      dispose() {
        calls.push("tracer");
        throw new Error("injected cleanup");
      },
    },
    renderer: {
      dispose: async () => {
        calls.push("renderer");
      },
    },
    device: { destroy: run("device") },
    gameObjects: new Map(),
    gameMaterials: new Map(),
    transforms: new Map(),
    componentState: new Map(),
    materialGraphs: [],
    authoredLights: [],
    topologyObjects: [],
    compiledIR: {},
    contentScope: {},
    rasterCanvas: { remove: run("rasterCanvas"), removeEventListener() {} },
    traceCanvas: { remove: run("traceCanvas") },
    errors: [],
  });
  await context.disposeBrowser();
  await context.disposeBrowser();
  assert.deepEqual(calls, [
    "cancel",
    "host",
    "simulation",
    "world",
    "resources",
    "scene",
    "tracer",
    "renderer",
    "device",
    "rasterCanvas",
    "traceCanvas",
  ]);
  assert.equal(context.errors.length, 1);
  assert.equal(context.disposed, true);
  assert.equal(context.playing, false);
  assert.equal(context.runtime, undefined);
});
