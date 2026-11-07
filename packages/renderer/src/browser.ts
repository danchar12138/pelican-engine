import * as THREE from "three/webgpu";
import { prepareGameplay, type GameplayContent } from "./gameplay.ts";
import { createRopeVisualOwner } from "./rope-visuals.ts";
import { createClothVisualOwner } from "./cloth-visuals.ts";
import { createFluidVisualOwner } from "./fluid-visuals.ts";
import { createSoftBodyVisualOwner } from "./softbody-visuals.ts";
import { createSpriteVisualOwner } from "./sprite-visuals.ts";
import { sampleGameplayGamepad } from "./gamepad.ts";
import { createTilemapVisualOwner } from "./tilemap-visuals.ts";
import type { HostSnapshot } from "../../runtime/src/host.ts";
import { GPUTracer } from "./pathtrace.ts";
import { SurfaceTracer } from "./surface-tracer.ts";
import {
  createRenderSettingsDriver,
  resolveRenderSettings,
} from "../../runtime/src/render-settings.ts";
import { buildBVH, extractTriangles } from "./geometry.ts";
import { graphToTSL, evaluateGraph, runComputeGraph } from "./graph.ts";
import { uniform } from "three/tsl";
import { typedGraphToTSL, materialGraphNormalToTSL } from "./graph-tsl.ts";
import type { MaterialGraphBinding } from "./material-graphs.ts";
import { startupPolicy, boundedOperation, runtimeStatus, inspectTraceCapabilities } from "./startup.ts";
import { renderCapabilities, requireCompute, validateRenderCapabilities } from "../../runtime/src/render-capabilities.ts";
import { createComputeDriver } from "../../runtime/src/compute-service.ts";
import { createComputeExecutor } from "./compute-executor.ts";
import { createPostProcessComposer } from "./postprocess.ts";
import { vertexGraphsToTSL } from "./vertex-graphs.ts";
import { createVertexBoundsOwner } from "./vertex-bounds.ts";
import { createRenderBufferBridge } from "./render-buffers.ts";
import { createRenderTextureBridge } from "./render-textures.ts";
import { createComputeTextureAssets } from "./compute-texture-assets.ts";
import { SDK_VERSION } from "../../sdk/src/index.ts";
import type { SceneIR, GraphIR } from "../../compiler/src/types.ts";
import { RuntimeHost } from "../../runtime/src/host.ts";
import { resolveEntityDefinition } from "../../runtime/src/prefabs.ts";
import {
  ResourceManager,
  type ResourceScope,
} from "../../runtime/src/resources.ts";
import {
  parseCommand,
  result as protocolResult,
} from "../../protocol/src/index.ts";
import {
  validateBrowserCheckpoint,
  prepareCheckpointProbes,
  selectInspectRecords,
  type InspectPage,
} from "./checkpoint.ts";
import type {
  EngineFacade,
  Transform,
  ComponentData,
  RenderSettings,
  RenderCapabilities,
} from "../../sdk/src/index.ts";
import { createSimulation } from "../../../experiments/simulation/index.ts";
import type {
  Simulation,
  SimulationKind,
} from "../../../experiments/simulation/types.ts";
import { createWorldProbe } from "../../../experiments/world/index.ts";
import type { WorldProbe } from "../../../experiments/world/types.ts";

const width = Number(new URLSearchParams(location.search).get("width") ?? 960);
const height = Number(
  new URLSearchParams(location.search).get("height") ?? 540,
);
const status = document.querySelector<HTMLElement>("#status")!;
const errors: string[] = [];
const startup = startupPolicy(import.meta.env.DEV, location.search);
let adapterInfo:
  | {
      vendor: string;
      architecture: string;
      isFallbackAdapter: boolean;
      features: string[];
    }
  | undefined;
let mode: "raster" | "hybrid" | "path" = "raster";
let tick = 0,
  playing = false,
  cameraPhase = 0,
  bvhMs = 0,
  uploadMs = 0,
  submitMs = 0;
let frameAccumulator = 0;
let lastStepCpuMs = 0;
let lastFrameTime: number | undefined;
let triangleCount = 0,
  nodeCount = 0,
  generation = 0;
let lastGeometryHash = 0;
const inputLog: { tick: number; key: string }[] = [];
const topologyObjects: THREE.Mesh[] = [];
const metrics: {
  frame: number;
  bvhMs: number;
  uploadMs: number;
  submitMs: number;
  wallMs: number;
  simulationMs: number;
}[] = [];
const scene = new THREE.Scene();
const probeEnabled = new URLSearchParams(location.search).get("probe") === "m0";
const probeRoot = new THREE.Group();
probeRoot.visible = probeEnabled;
scene.add(probeRoot);
scene.background = new THREE.Color("#111d2a");
const perspectiveCamera = new THREE.PerspectiveCamera(48, width / height, 0.05, 100);
const orthographicCamera = new THREE.OrthographicCamera(-5 * width / height, 5 * width / height, 5, -5, 0.05, 100);
let camera: THREE.PerspectiveCamera | THREE.OrthographicCamera = perspectiveCamera;
function cameraCapabilities(backend: RenderCapabilities["backend"], orthographic: boolean): RenderCapabilities {
  const capabilities = renderCapabilities(backend);
  if (!orthographic) return capabilities;
  return { ...capabilities, availableModes: capabilities.availableModes.includes("raster") ? ["raster"] : [],
    modeLimitation: "Orthographic projection currently supports raster only. Use raster, or choose a perspective camera and WebGPU for hybrid/path modes." };
}
const rasterCanvas = document.createElement("canvas"),
  traceCanvas = document.createElement("canvas");
for (const canvas of [rasterCanvas, traceCanvas]) {
  canvas.style.position = "absolute";
  canvas.style.left = "0";
  canvas.style.top = "0";
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  document.body.appendChild(canvas);
}
traceCanvas.style.pointerEvents = "none";
traceCanvas.style.display = "none";
const standard = (color: number, roughness = 0.75) =>
  new THREE.MeshStandardMaterial({ color, roughness });
const ground = new THREE.Mesh(
  new THREE.BoxGeometry(14, 0.2, 14),
  standard(0x7c8797),
);
ground.position.y = -0.2;
ground.receiveShadow = true;
probeRoot.add(ground);
const back = new THREE.Mesh(
  new THREE.BoxGeometry(14, 5, 0.15),
  standard(0x243b50),
);
back.position.set(0, 2.2, -4);
probeRoot.add(back);
const box = new THREE.Mesh(
  new THREE.BoxGeometry(1, 1, 1),
  standard(0xe5923f, 0.25),
);
box.position.set(-1.6, 0.5, 0);
box.castShadow = true;
probeRoot.add(box);
const morphGeo = new THREE.SphereGeometry(0.7, 12, 8);
const original = morphGeo.getAttribute("position");
const morph = original.clone();
for (let i = 0; i < morph.count; i++)
  morph.setXYZ(
    i,
    original.getX(i) * (1 + 0.4 * Math.sin(original.getY(i) * 5)),
    original.getY(i) * 1.5,
    original.getZ(i),
  );
morphGeo.morphAttributes.position = [morph];
const morphMesh = new THREE.Mesh(morphGeo, standard(0x36a8a1, 0.4));
morphMesh.position.set(1.5, 0.8, -0.2);
morphMesh.castShadow = true;
probeRoot.add(morphMesh);
const skinGeo = new THREE.CylinderGeometry(0.24, 0.35, 1.8, 8, 6);
const positions = skinGeo.getAttribute("position");
const indices = [],
  weights = [];
for (let i = 0; i < positions.count; i++) {
  const y = positions.getY(i);
  const factor = Math.max(0, Math.min(1, (y + 0.3) / 1.2));
  indices.push(0, 1, 0, 0);
  weights.push(1 - factor, factor, 0, 0);
}
skinGeo.setAttribute("skinIndex", new THREE.Uint16BufferAttribute(indices, 4));
skinGeo.setAttribute(
  "skinWeight",
  new THREE.Float32BufferAttribute(weights, 4),
);
const skinned = new THREE.SkinnedMesh(skinGeo, standard(0xc24f72));
const root = new THREE.Bone(),
  tip = new THREE.Bone();
root.position.y = -0.9;
tip.position.y = 0.9;
root.add(tip);
skinned.add(root);
skinned.bind(new THREE.Skeleton([root, tip]));
skinned.position.set(0, 1, -1.4);
probeRoot.add(skinned);
const lamp = new THREE.PointLight(0xffdfb0, 100, 30, 2);
lamp.position.set(-3, 6, 3);
lamp.castShadow = true;
lamp.shadow.mapSize.set(1024, 1024);
probeRoot.add(lamp, new THREE.HemisphereLight(0xa4c8f0, 0x26321d, 1));

let renderer: THREE.Renderer, tracer: GPUTracer, device: GPUDevice;
let backendKind: "webgpu" | "webgl2" | "uninitialized" = "uninitialized";
let contextWasPlaying = false;
let waitingForWebglRestore = false;
let pendingSurface: AbortController | undefined;
const lostDevices = new WeakSet<GPUDevice>();
const lostRenderers = new WeakSet<THREE.Renderer>();
let surfaceTracer: SurfaceTracer | undefined;
let renderControl: ReturnType<typeof createRenderSettingsDriver> | undefined;
let computeControl: ReturnType<typeof createComputeDriver> | undefined;
let computeExecutor: ReturnType<typeof createComputeExecutor> | undefined;
let renderBufferBridge: ReturnType<typeof createRenderBufferBridge> | undefined;
let renderTextureBridge: ReturnType<typeof createRenderTextureBridge> | undefined;
let postComposer: ReturnType<typeof createPostProcessComposer> | undefined;
let vertexBounds: ReturnType<typeof createVertexBoundsOwner> | undefined;
let legacyTracerDisposed = false;
let recoveringGpu = false;
let recoveryTask: Promise<void> | undefined;
let recoveryCount = 0;
let drawTail: Promise<unknown> = Promise.resolve();
let tickTail: Promise<void> = Promise.resolve();
let nativeInputTail: Promise<void> = Promise.resolve();
let gamepadHost: RuntimeHost | undefined, gamepadFingerprint: string | undefined;
let inputDrawActive = false,
  inputDrawRequested = false;
let frameSerial = 0;
const recoveryEvents: { phase: string; reason: string; tick: number }[] = [];
const gameObjects = new Map<string, THREE.Object3D>();
const gameRoot = new THREE.Group();
scene.add(gameRoot);
const ropeVisuals = createRopeVisualOwner();
const clothVisuals = createClothVisualOwner();
const fluidVisuals = createFluidVisualOwner();
const softBodyVisuals = createSoftBodyVisualOwner();
const spriteVisuals = createSpriteVisualOwner();
const tilemapVisuals = createTilemapVisualOwner();
scene.add(ropeVisuals.root, clothVisuals.root, fluidVisuals.root, softBodyVisuals.root, spriteVisuals.root, tilemapVisuals.root);
let dynamicVisualRevision = 0, renderedDynamicVisualRevision = 0;
const clearDynamicVisuals = () => {
  const ropesChanged = ropeVisuals.clear(), clothChanged = clothVisuals.clear(), fluidChanged = fluidVisuals.clear(), softBodiesChanged = softBodyVisuals.clear(), spritesChanged = spriteVisuals.clear(), tilemapsChanged = tilemapVisuals.clear();
  if (ropesChanged || clothChanged || fluidChanged || softBodiesChanged || spritesChanged || tilemapsChanged) dynamicVisualRevision++;
};
let authoredCamera = { position: [0, 3.4, 7], target: [0, 0.9, 0] };
let authoredLights: {
  definition: SceneIR["scene"]["entities"][number]["light"];
  object: THREE.Object3D;
}[] = [];
let compiledIR: SceneIR | null = null;
let runtime: RuntimeHost | undefined;
const resourceManager = new ResourceManager<{
  json: { descriptor: { url: string }; value: unknown };
  module: {
    descriptor: { url: string };
    value: {
      createGame: (engine: EngineFacade) => {
        update(dt: number): void;
        dispose(): void;
      };
    };
  };
}>();
resourceManager.registerLoader("json", {
  async load(descriptor, signal) {
    const response = await fetch(descriptor.url, { signal });
    if (!response.ok) throw new Error(`TC_RESOURCE_HTTP: ${response.status}`);
    return response.json();
  },
  dispose() {},
});
resourceManager.registerLoader("module", {
  async load(descriptor, signal) {
    const module = await import(/* @vite-ignore */ descriptor.url);
    if (signal.aborted) throw new Error("TC_RESOURCE_CANCELLED");
    if (typeof module.createGame !== "function")
      throw new Error("TC_GAME_EXPORT");
    return module;
  },
  dispose() {},
});
let gameplay: GameplayContent | undefined;
let contentScope: ResourceScope | undefined;
let contentGeneration = 0;
let loadingContent = false;
let disposed = false;
let terminalFault = false;
let restoring = false;
let frameRequest: number | undefined;
let disposal: Promise<void> | undefined;
let gameMaterials = new Map<string, THREE.MeshStandardNodeMaterial>();
const componentState = new Map<string, Record<string, ComponentData>>();
const transforms = new Map<string, Transform>();
const materialGraphs: {
  material: THREE.MeshStandardNodeMaterial;
  graph: SceneIR["materials"][number]["graph"];
  binding: MaterialGraphBinding;
  uniforms: Map<string, ReturnType<typeof uniform>>;
}[] = [];
const graphTime = uniform(0);
function slotTypes(graphs: readonly GraphIR[]) { return Object.assign({}, ...graphs.map(graph => graph.bufferTypes ?? {})); }
function materialSlotTypes(binding: MaterialGraphBinding) { return slotTypes([...Object.values(binding.graphs), ...Object.values(binding.vertex ?? {})]); }
function textureSlotTypes(graphs: readonly GraphIR[]) { return Object.assign({}, ...graphs.map(graph => graph.textureSlots ?? {})); }
function materialTextureTypes(binding: MaterialGraphBinding) { return textureSlotTypes([...Object.values(binding.graphs), ...Object.values(binding.vertex ?? {})]); }
function usesRenderTextures(ir: SceneIR) { return ir.materials.some(d => Object.keys(textureSlotTypes([...(d.graph ? [d.graph] : []), ...Object.values(d.graphs ?? {}), ...Object.values(d.vertex ?? {})])).length) || ir.postProcesses?.some(d => Object.keys(d.graph.textureSlots ?? {}).length); }
function usesRenderSlots(ir: SceneIR) { return ir.materials.some(d => Object.keys(slotTypes([...(d.graph ? [d.graph] : []), ...Object.values(d.graphs ?? {}), ...Object.values(d.vertex ?? {})])).length) || ir.postProcesses?.some(d => Object.keys(d.graph.bufferTypes ?? {}).length); }
function slotResources(owner: ReturnType<typeof createRenderSettingsDriver>, id: string) { return id.startsWith("$post.") ? owner.effectBuffers.resources(id.slice(6)) : owner.buffers.resources(id); }
function textureResources(owner: ReturnType<typeof createRenderSettingsDriver>, id: string) { return id.startsWith("$post.") ? owner.effectTextures.resources(id.slice(6)) : owner.textures.resources(id); }
function applyMaterialGraphs(material: THREE.MeshStandardNodeMaterial, binding: MaterialGraphBinding, uniforms: Map<string, ReturnType<typeof uniform>>, bridge?: ReturnType<typeof createRenderBufferBridge>, textureBridge?: ReturnType<typeof createRenderTextureBridge>) {
  const slots = materialSlotTypes(binding);
  if (Object.keys(slots).length) {
    if (!bridge) throw new Error("TC_RENDER_BUFFER_CAPABILITY: Material storage slots require a managed WebGPU bridge.");
    bridge.prepare(material, slots);
  }
  const textureSlots = materialTextureTypes(binding);
  if (Object.keys(textureSlots).length) {
    if (!textureBridge) throw new Error("TC_RENDER_TEXTURE_CAPABILITY: Material texture slots require a managed WebGPU bridge.");
    textureBridge.prepare(material, textureSlots);
  }
  const sampleTextureSlot = (name: string, uv: any) => textureBridge!.node(material, name, uv, textureSlots[name]);
  for (const [channel, graph] of Object.entries(binding.graphs)) {
    let node = typedGraphToTSL(graph, graphTime, uniforms, binding.textures, {
      readBuffer: (name, index, type) => bridge!.node(material, name, index, type, true),
      sampleTextureSlot,
    });
    if (channel === "normalWorld") node = materialGraphNormalToTSL(node);
    else if (["roughness", "metalness", "opacity"].includes(channel)) node = node.clamp(0, 1);
    const key = ({baseColor:"colorNode",emissive:"emissiveNode",roughness:"roughnessNode",metalness:"metalnessNode",opacity:"opacityNode",normalWorld:"normalNode"} as const)[channel as keyof typeof binding.graphs];
    (material as any)[key] = node;
  }
  if (binding.graphs.opacity) { material.transparent = true; material.alphaMap = null; }
  if (binding.vertex) {
    material.positionNode = vertexGraphsToTSL(binding, graphTime, uniforms, binding.textures, (name, index, type) => bridge!.node(material, name, index, type), sampleTextureSlot);
    material.userData.pelicanVertexNormal = Boolean(binding.vertex.normal);
  }
  material.needsUpdate = true;
}
const componentsId = (component: { id: string } | string) =>
  typeof component === "string" ? component : component.id;
const facade: EngineFacade = {
  getTransform(id) {
    if (!runtime) throw new Error("TC_RUNTIME_NOT_ATTACHED");
    return runtime.facade.getTransform(id);
  },
  setTransform(id, patch) {
    if (!runtime) throw new Error("TC_RUNTIME_NOT_ATTACHED");
    runtime.facade.setTransform(id, patch);
    syncRuntime();
  },
  getComponent(id: string, component: any): any {
    if (!runtime) throw new Error("TC_RUNTIME_NOT_ATTACHED");
    return runtime.facade.getComponent(id, componentsId(component));
  },
  setComponent(id: string, component: any, value: any) {
    if (!runtime) throw new Error("TC_RUNTIME_NOT_ATTACHED");
    runtime.facade.setComponent(id, componentsId(component), value);
    syncRuntime();
  },
  query(component) {
    return runtime?.world.query(componentsId(component)) ?? [];
  },
};
function reportFailure(error: unknown) {
  if (disposed) return;
  playing = false;
  terminalFault = true;
  lastFrameTime = undefined;
  const message = String(error);
  errors.push(message);
  if (document.documentElement) {
    document.documentElement.dataset.pelicanReady = "false";
    document.documentElement.dataset.pelicanFailure = message;
  }
  status.hidden = false;
  status.textContent = message;
  console.error(error);
}
function requireRuntime() {
  if (disposed)
    throw new Error(
      "TC_BROWSER_DISPOSED: Reload the page before issuing commands.",
    );
  if (loadingContent || restoring || recoveringGpu)
    throw new Error(
      "TC_CONTENT_BUSY: Wait for the current content or GPU recovery transaction.",
    );
  if (!runtime) throw new Error("TC_RUNTIME_NOT_ATTACHED");
  return runtime;
}
function releaseObject(
  root: THREE.Object3D,
  releaseMaterials = false,
  ownedMaterials: Iterable<THREE.Material> = [],
) {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>(ownedMaterials);
  const skeletons = new Set<THREE.Skeleton>(), shadows = new Set<THREE.LightShadow>();
  const failures: unknown[] = [];
  const clean = (action: () => void) => { try { action(); } catch (error) { failures.push(error); } };
  clean(() => root.traverse((object) => {
    if (object instanceof THREE.Mesh) {
      geometries.add(object.geometry);
      if (releaseMaterials)
        for (const material of Array.isArray(object.material)
          ? object.material
          : [object.material])
          materials.add(material);
    }
    if (object instanceof THREE.SkinnedMesh) skeletons.add(object.skeleton);
    if (object instanceof THREE.Light && "shadow" in object) {
      const shadow = object.shadow as THREE.LightShadow | undefined;
      if (shadow) shadows.add(shadow);
    }
  }));
  for (const shadow of shadows) clean(() => shadow.dispose());
  for (const skeleton of skeletons) clean(() => skeleton.dispose());
  for (const geometry of geometries) clean(() => geometry.dispose());
  for (const material of materials) clean(() => material.dispose());
  clean(() => (root.userData.lightTarget as THREE.Object3D | undefined)?.removeFromParent());
  clean(() => root.removeFromParent());
  clean(() => root.clear());
  if (failures.length) throw new AggregateError(failures, "TC_SCENE_RESOURCES_DISPOSE: Some scene resources could not be released; inspect the causes and restart the scene.");
}
function createEntityView(
  entity: SceneIR["scene"]["entities"][number],
  materials: Map<string, THREE.MeshStandardNodeMaterial>,
) {
  const node = new THREE.Group();
  node.name = entity.id;
  if (entity.light) {
    const light =
      entity.light.kind === "point"
        ? new THREE.PointLight(
            entity.light.color ?? "#ffffff",
            entity.light.intensity ?? 1,
            entity.light.distance ?? 0,
            entity.light.decay ?? 2,
          )
        : entity.light.kind === "spot"
          ? new THREE.SpotLight(
              entity.light.color ?? "#ffffff",
              entity.light.intensity ?? 1,
              entity.light.distance ?? 0,
              entity.light.angle ?? Math.PI / 3,
              entity.light.penumbra ?? 0,
              entity.light.decay ?? 2,
            )
          : new THREE.DirectionalLight(
            entity.light.color ?? "#ffffff",
            entity.light.intensity ?? 1,
          );
    light.castShadow = entity.light.castShadow ?? false;
    if (light instanceof THREE.DirectionalLight || light instanceof THREE.SpotLight) {
      light.target.position.fromArray(entity.light.target ?? [0, 0, 0]);
      // Targets use world coordinates and must remain outside the transformed light group.
      node.userData.lightTarget = light.target;
    }
    if ("shadow" in light) {
      const shadow = entity.light.shadow;
      light.shadow.mapSize.set(
        shadow?.mapSize ?? 2048,
        shadow?.mapSize ?? 2048,
      );
      light.shadow.bias = shadow?.bias ?? -0.0001;
      light.shadow.normalBias = shadow?.normalBias ?? 0.04;
      light.shadow.camera.near = shadow?.near ?? 0.1;
      light.shadow.camera.far = shadow?.far ?? 100;
      if (light instanceof THREE.DirectionalLight) {
        const extent = shadow?.extent ?? 20;
        Object.assign(light.shadow.camera, {
          left: -extent,
          right: extent,
          top: extent,
          bottom: -extent,
        });
      }
      light.shadow.camera.updateProjectionMatrix();
    }
    node.add(light);
  }
  if (entity.mesh) {
    const material = materials.get(entity.mesh.material);
    if (!material)
      throw new Error(`TC_MATERIAL_MISSING: ${entity.mesh.material}`);
    const g = entity.mesh.geometry;
    const geometry =
      g.kind === "box"
        ? new THREE.BoxGeometry(...(g.size ?? [1, 1, 1]))
        : g.kind === "sphere"
          ? new THREE.SphereGeometry(g.radius ?? 0.5, g.segments ?? 12, 8)
          : new THREE.PlaneGeometry(...(g.size ?? [1, 1]));
    for (const input of material.userData.pelicanGraphInputs ?? []) {
      if ((input === "uv" || input === "uv1") && !geometry.hasAttribute(input)) {
        geometry.dispose();
        throw new Error(`TC_GRAPH_UV: Material ${entity.mesh.material} requires ${input} on entity ${entity.id}. Use geometry with that UV channel or change the graph.`);
      }
    }
    const mesh = new THREE.Mesh(geometry, material);
    mesh.castShadow = entity.mesh.castShadow;
    mesh.receiveShadow = entity.mesh.receiveShadow;
    node.add(mesh);
  }
  return node;
}
function syncRuntime(): boolean {
  if (!runtime) { clearDynamicVisuals(); return dynamicVisualRevision !== renderedDynamicVisualRevision; }
  transforms.clear();
  componentState.clear();
  const records = runtime.world.records();
  const lightOverrides = new Map((gameplay ? runtime.facade.lights.visuals() : []).map(item => [item.entity, item]));
  const live = new Set(records.map((record) => record.id));
  const modelRecords = compiledIR
    ? records.filter(
        (record) => resolveEntityDefinition(compiledIR!, record)?.model,
      )
    : [];
  gameplay?.models.reconcileBindings(modelRecords.map((record) => ({
    entity: record.id,
    definition: resolveEntityDefinition(compiledIR!, record)!.model!,
  })));
  // Each entity view owns its own visual subtree; detach tracked descendants before disposal.
  const prefabById = new Map(records.map((record) => [record.id, record.prefab]));
  const removed = new Set(
    [...gameObjects]
      .filter(([id, object]) => !live.has(id) || object.userData.pelicanPrefab !== prefabById.get(id))
      .map(([, object]) => object),
  );
  for (const object of gameObjects.values())
    for (let parent = object.parent; parent; parent = parent.parent)
      if (removed.has(parent)) {
        gameRoot.add(object);
        break;
      }
  for (const [id, object] of gameObjects)
    if (!live.has(id)) {
      gameplay?.models.remove(id);
      releaseObject(object);
      gameObjects.delete(id);
    }
  for (const record of records) {
    transforms.set(record.id, structuredClone(record.transform));
    componentState.set(record.id, structuredClone(record.components));
    let object = gameObjects.get(record.id);
    if (object && object.userData.pelicanPrefab !== record.prefab) {
      gameplay?.models.get(record.id)?.node.removeFromParent();
      releaseObject(object);
      gameObjects.delete(record.id);
      object = undefined;
    }
    if (!object) {
      const authored = compiledIR
        ? resolveEntityDefinition(compiledIR, record)
        : undefined;
      object = authored
        ? createEntityView(authored, gameMaterials)
        : new THREE.Group();

      object.name = record.id;
      object.userData.pelicanPrefab = record.prefab;
      gameRoot.add(object);
      if (object.userData.lightTarget)
        gameRoot.add(object.userData.lightTarget);
      gameObjects.set(record.id, object);
    }
    if (modelRecords.some((model) => model.id === record.id))
      gameplay?.models.attach(record.id, object);
    const definition = compiledIR ? resolveEntityDefinition(compiledIR, record)?.light : undefined;
    const light = object.children.find((child): child is THREE.Light => child instanceof THREE.Light);
    if (definition && light) {
      const override = lightOverrides.get(record.id);
      light.intensity = override?.intensity ?? definition.intensity ?? 1;
      light.color.set(definition.color ?? "#ffffff");
      if (override?.color) light.color.setRGB(...override.color);
      light.visible = override?.visible ?? true;
      if (light instanceof THREE.DirectionalLight || light instanceof THREE.SpotLight)
        light.target.position.fromArray(override?.target ?? definition.target ?? [0, 0, 0]);
    }
    object.position.fromArray(record.transform.position);
    object.rotation.set(...record.transform.rotation);
    object.scale.fromArray(record.transform.scale);
  }
  for (const record of records) {
    const object = gameObjects.get(record.id)!;
    const parent = record.parent ? gameObjects.get(record.parent) : gameRoot;
    if (parent && object.parent !== parent) parent.add(object);
  }
  gameRoot.updateMatrixWorld(true);
  authoredLights = [];
  for (const entity of compiledIR?.scene.entities ?? [])
    if (entity.light) {
      const light = gameObjects
        .get(entity.id)
        ?.children.find((child) => child instanceof THREE.Light);
      if (light)
        authoredLights.push({ definition: entity.light, object: light });
    }
  if (gameplay) {
    if (ropeVisuals.sync(runtime.facade.ropes.visuals(), gameMaterials)) dynamicVisualRevision++;
    if (clothVisuals.sync(runtime.facade.cloth.visuals(), gameMaterials)) dynamicVisualRevision++;
    if (fluidVisuals.sync(runtime.facade.fluid.visuals(), gameMaterials)) dynamicVisualRevision++;
    if (softBodyVisuals.sync(runtime.facade.softBodies.visuals(), gameMaterials)) dynamicVisualRevision++;
    if (spriteVisuals.sync(runtime.facade.sprites.visuals(), gameMaterials, gameObjects)) dynamicVisualRevision++;
    if (tilemapVisuals.sync(runtime.facade.tilemaps.visuals(), gameMaterials, gameObjects,
      (id, x, y) => runtime!.facade.tilemaps.readChunk(id, x, y))) dynamicVisualRevision++;
  } else clearDynamicVisuals();
  return dynamicVisualRevision !== renderedDynamicVisualRevision;
}
let simulation: Simulation | undefined;
const simulationGroup = new THREE.Group();
scene.add(simulationGroup);
let world: WorldProbe | undefined;
const worldGroup = new THREE.Group();
scene.add(worldGroup);
function syncWorld() {
  for (const child of [...worldGroup.children]) {
    worldGroup.remove(child);
    if (child instanceof THREE.Mesh) {
      child.geometry.dispose();
      (child.material as THREE.Material).dispose();
    }
  }
  if (!world) return;
  for (const chunk of world.getRenderState().chunks) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(chunk.positions, 3),
    );
    geometry.setIndex(chunk.indices);
    geometry.computeVertexNormals();
    const mesh = new THREE.Mesh(
      geometry,
      new THREE.MeshStandardMaterial({
        color: 0x61935c,
        roughness: 0.9,
        side: THREE.DoubleSide,
      }),
    );
    mesh.position.set(0, 0.15, -1);
    worldGroup.add(mesh);
  }
}
function syncSimulation() {
  // Rebuild the deliberately tiny probe representation; production pooling is a later milestone.
  for (const child of [...simulationGroup.children]) {
    simulationGroup.remove(child);
    if (child instanceof THREE.Mesh) {
      child.geometry.dispose();
      (child.material as THREE.Material).dispose();
    }
  }
  if (!simulation) return;
  const state = simulation.getRenderState();
  const offset = new THREE.Vector3(0, 0.3, 1.4);
  for (const [list, color] of [
    [state.bodies, 0xffb54a],
    [state.particles, 0x4ea9d9],
  ] as const)
    for (const particle of list) {
      const mesh = new THREE.Mesh(
        new THREE.IcosahedronGeometry(particle.radius, 0),
        standard(color, 0.5),
      );
      mesh.position.fromArray(particle.position).add(offset);
      simulationGroup.add(mesh);
    }
  if (state.triangles.length) {
    const vertices: number[] = [];
    for (const triangle of state.triangles)
      for (const index of triangle)
        vertices.push(
          ...new THREE.Vector3()
            .fromArray(state.particles[index].position)
            .add(offset)
            .toArray(),
        );
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(vertices, 3),
    );
    geometry.computeVertexNormals();
    const mesh = new THREE.Mesh(
      geometry,
      new THREE.MeshStandardMaterial({
        color: 0x7bd1cd,
        side: THREE.DoubleSide,
        roughness: 0.7,
      }),
    );
    simulationGroup.add(mesh);
  }
}
interface GameSave {
  format: "pelican.save";
  version: 1;
  engineVersion: string;
  gameId: string;
  sceneId: string;
  assets: Record<string, string>;
  runtime: HostSnapshot;
}
async function loadGame(sceneId?: string, saved?: GameSave, loadSlot?: string) {
  if (disposed) throw new Error("TC_BROWSER_DISPOSED");
  if (loadingContent || restoring)
    throw new Error(
      "TC_CONTENT_BUSY: Wait for the current content transaction.",
    );
  loadingContent = true;
  let nextScope: ResourceScope | undefined;
  let nextGameplay: GameplayContent | undefined;
  let nextRender: ReturnType<typeof createRenderSettingsDriver> | undefined;
  let nextCompute: ReturnType<typeof createComputeDriver> | undefined;
  let nextPostComposer: ReturnType<typeof createPostProcessComposer> | undefined;
  let nextVertexBounds: ReturnType<typeof createVertexBoundsOwner> | undefined;
  let nextComputeExecutor: ReturnType<typeof createComputeExecutor> | undefined;
  let nextRenderBufferBridge: ReturnType<typeof createRenderBufferBridge> | undefined;
  let nextRenderTextureBridge: ReturnType<typeof createRenderTextureBridge> | undefined;
  let candidate: RuntimeHost | undefined;
  let candidateGame: { update(dt: number): void; dispose(): void } | undefined;
  let attached = false;
  let committed = false;
  let previousCleanup: (() => Promise<void>) | undefined;
  const cleanup = async (label: string, action: () => unknown) => {
    try { await action(); } catch (error) { errors.push(`TC_CONTENT_CLEANUP: ${label}: ${String(error)}`); }
  };
  const nextRoot = new THREE.Group();
  const nextMaterials = new Map<string, THREE.MeshStandardNodeMaterial>();
  const nextObjects = new Map<string, THREE.Object3D>();
  const nextGraphs: typeof materialGraphs = [];
  try {
    nextScope = resourceManager.createScope();
    const generation = ++contentGeneration;
    const sceneURL = new URL(
      `${import.meta.env.BASE_URL}generated/scene.ir.json`,
      document.baseURI,
    );
    sceneURL.searchParams.set("v", String(generation));
    const sceneLease = await resourceManager.acquire(
      "json",
      `compiled-scene-${generation}`,
      { url: sceneURL.href },
      nextScope,
    );
    const ir = structuredClone(
      resourceManager.get(sceneLease.handle),
    ) as SceneIR;
    if (!ir || ir.format !== "pelican.scene" || ir.version !== 1)
      throw new Error("TC_IR_VERSION");
    if (sceneId && sceneId !== ir.scene.id) {
      const selected = ir.scenes?.find((entry) => entry.id === sceneId);
      if (!selected) throw new Error("TC_SCENE_MISSING: " + sceneId);
      ir.scenes = [
        ir.scene,
        ...(ir.scenes ?? []).filter((entry) => entry.id !== sceneId),
      ];
      ir.scene = selected;
    }
    if (
      saved &&
      (saved.format !== "pelican.save" ||
        saved.version !== 1 ||
        saved.engineVersion !== SDK_VERSION ||
        saved.gameId !== ir.gameId ||
        JSON.stringify(saved.assets) !==
          JSON.stringify(
            Object.fromEntries(ir.assets.map((a) => [a.id, a.hash])),
          ))
    )
      throw new Error(
        "TC_SAVE_VERSION: Save does not match this game version and asset set.",
      );
    // Normal games have SDK services even when their content is only primitives.
    if (
      !probeEnabled ||
      ir.input ||
      ir.ui ||
      ir.sounds ||
      ir.scene.follow ||
      ir.scene.environment.lighting === "studio" ||
      ir.scene.environment.backgroundTexture ||
      ir.scene.environment.lightingTexture ||
      [...ir.scene.entities, ...ir.prefabs].some(
        (entity) => entity.model || entity.rigidBody || entity.character,
      ) ||
      ir.materials.some((material) => material.texture)
    )
      nextGameplay = await prepareGameplay(
        ir,
        new URL(import.meta.env.BASE_URL + "generated/", document.baseURI).href,
        renderer,
        nextMaterials,
      );
    nextComputeExecutor = backendKind === "webgpu" && (ir.computes.length || ir.computeBuffers?.length || ir.computeTextures?.length) ? createComputeExecutor(device) : undefined;
    nextCompute = createComputeDriver({
      kernels: ir.computes,
      buffers: ir.computeBuffers,
      textures: ir.computeTextures,
      textureAssets: createComputeTextureAssets(nextGameplay?.textures ?? new Map()),
      capabilities: () => renderCapabilities(backendKind),
      time: () => candidate?.facade.time.elapsed ?? 0,
      executor: nextComputeExecutor,
    });
    nextRender = createRenderSettingsDriver(ir.render ?? {}, ir.materials,
      () => cameraCapabilities(backendKind, ir.scene.camera.projection === "orthographic"), ir.postProcesses, {
      describe: handle => { const descriptor = nextCompute!.service.describeBuffer(handle); return { id: descriptor.id, type: descriptor.type, count: descriptor.count }; },
      resource: id => nextCompute!.resource(id),
      setPins: ids => nextCompute!.setRenderPins(ids),
    }, {
      describe: handle => { const { id, width, height, format } = nextCompute!.service.describeTexture(handle); return { id, width, height, format }; },
      resource: id => nextCompute!.textureResource(id),
      setPins: ids => nextCompute!.setRenderPins(ids),
    });
    if (usesRenderSlots(ir))
      nextRenderBufferBridge = createRenderBufferBridge(renderer, () => computeExecutor, id => slotResources(nextRender!, id));
    if (usesRenderTextures(ir))
      nextRenderTextureBridge = createRenderTextureBridge(renderer, () => computeExecutor, id => textureResources(nextRender!, id));
    candidate = new RuntimeHost(ir, {
      plugins: [nextRender.factory, nextCompute.factory, ...(nextGameplay?.plugins ?? [])],
    });
    const gameURL = new URL(
      `${import.meta.env.BASE_URL}generated/game.js`,
      document.baseURI,
    );
    gameURL.searchParams.set("v", String(generation));
    const moduleLease = await resourceManager.acquire(
      "module",
      `compiled-game-${generation}`,
      { url: gameURL.href },
      nextScope,
    );
    const module = resourceManager.get(moduleLease.handle);
    candidateGame = module.createGame(candidate.facade);
    candidate.attach(candidateGame);
    attached = true;
    if (ir.postProcesses?.length) nextPostComposer = createPostProcessComposer(renderer, width, height, ir.postProcesses, nextGameplay?.textures ?? new Map(), nextRenderBufferBridge, nextRenderTextureBridge);
    const nextCamera = {
      position: [...ir.scene.camera.position],
      target: [...ir.scene.camera.target],
    };
    const nextBackground = new THREE.Color(ir.scene.environment.background);
    const ambient = new THREE.HemisphereLight(
      0xa4c8f0,
      0x26321d,
      ir.scene.environment.ambientIntensity,
    );
    nextRoot.add(ambient);
    for (const definition of ir.materials) {
      const Material =
        (definition.transmission ?? 0) > 0 || definition.ior !== undefined || definition.specularIntensity !== undefined || definition.specularColor !== undefined
          ? THREE.MeshPhysicalNodeMaterial
          : THREE.MeshStandardNodeMaterial;
      const material = new Material({
        color: definition.color,
        roughness: definition.roughness,
        metalness: definition.metalness,
        emissive: definition.emissive ?? "#000000",
        emissiveIntensity: definition.emissiveIntensity ?? 1,
        opacity: definition.opacity ?? 1,
        transparent: definition.transparent ?? (definition.opacity ?? 1) < 1,
        alphaTest: definition.alphaTest ?? 0,
        side:
          definition.side === "double"
            ? THREE.DoubleSide
            : definition.side === "back"
              ? THREE.BackSide
              : THREE.FrontSide,
      });
      if (material instanceof THREE.MeshPhysicalNodeMaterial) {
        material.transmission = definition.transmission ?? 0;
        material.ior = definition.ior ?? 1.5;
        material.specularIntensity = definition.specularIntensity ?? 1;
        material.specularColor.set(definition.specularColor ?? "#ffffff");
        material.attenuationColor.set(definition.attenuationColor ?? "#ffffff");
        material.attenuationDistance =
          definition.attenuationDistance ?? Infinity;
      }
      material.name = definition.id;
      if (definition.texture)
        material.map = nextGameplay!.textures.get(definition.texture)!;
      nextMaterials.set(definition.id, material);
      if (definition.graph || definition.graphs || definition.vertex) {
        const graphs = { ...(definition.graph ? { baseColor: definition.graph } : {}), ...definition.graphs };
        const uniforms = new Map<string, ReturnType<typeof uniform>>();
        for (const p of definition.parameters ?? []) {
          const value = Array.isArray(p.default) ? p.default.length === 2 ? new THREE.Vector2(...p.default as [number,number]) : p.default.length === 3 ? new THREE.Vector3(...p.default as [number,number,number]) : new THREE.Vector4(...p.default as [number,number,number,number]) : p.default;
          uniforms.set(p.name, (uniform as any)(value, p.type));
        }
        const textures = nextGameplay?.textures ?? new Map<string, THREE.Texture>();
        const binding: MaterialGraphBinding = { id: definition.id, graphs, ...(definition.vertex ? { vertex: definition.vertex } : {}), time: 0, parameters: nextRender.service.materialParameters(definition.id), textures };
        if (Object.keys(materialSlotTypes(binding)).length) binding.buffers = nextRender.buffers.resources(definition.id);
        if (Object.keys(materialTextureTypes(binding)).length) binding.managedTextures = nextRender.textures.resources(definition.id);
        applyMaterialGraphs(material, binding, uniforms, nextRenderBufferBridge, nextRenderTextureBridge);
        material.userData.pelicanGraphInputs = [...new Set([...Object.values(graphs), ...Object.values(definition.vertex ?? {})].flatMap(graph => graph.requiredInputs ?? []))];
        nextGraphs.push({ material, graph: definition.graph, binding, uniforms });
      }
    }
    for (const entity of ir.scene.entities) {
      const node = createEntityView(entity, nextMaterials);
      node.userData.pelicanPrefab = entity.prefab;
      if (entity.model)
        nextGameplay!.models.instantiate(entity.id, entity.model, node);
      node.position.fromArray(entity.transform.position);
      node.rotation.set(...entity.transform.rotation);
      node.scale.fromArray(entity.transform.scale);
      nextRoot.add(node);
      if (node.userData.lightTarget) nextRoot.add(node.userData.lightTarget);
      nextObjects.set(entity.id, node);
    }
    for (const entity of ir.scene.entities)
      if (entity.parent)
        nextObjects.get(entity.parent)!.add(nextObjects.get(entity.id)!);
    nextRoot.traverse(object => {
      if (!(object instanceof THREE.Mesh)) return;
      for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
        for (const input of material.userData.pelicanGraphInputs ?? [])
          if ((input === "uv" || input === "uv1") && !object.geometry.hasAttribute(input)) throw new Error(`TC_GRAPH_UV: Material ${material.name} requires ${input} on object ${object.name || object.uuid}.`);
        if (material.userData.pelicanVertexNormal && !object.geometry.hasAttribute("normal")) throw new Error("TC_VERTEX_NORMAL_ATTRIBUTE: Vertex normal graphs require a normal attribute.");
      }
    });
    if (saved) {
      if (loadSlot)
        nextGameplay?.services.adoptStorageRequest("load", loadSlot);
      candidate.restore(saved.runtime);
    }
    if (nextGraphs.some(item => item.binding.vertex)) {
      nextVertexBounds = createVertexBoundsOwner();
      for (const item of nextGraphs) {
        item.binding.time = candidate.inspect().scheduler.tick / 60;
        item.binding.parameters = nextRender.service.materialParameters(item.binding.id);
        if (item.binding.buffers) item.binding.buffers = nextRender.buffers.resources(item.binding.id);
        if (item.binding.managedTextures) item.binding.managedTextures = nextRender.textures.resources(item.binding.id);
      }
      const boundsScene = new THREE.Scene();
      boundsScene.add(nextRoot);
      nextVertexBounds.update(boundsScene, new Map(nextGraphs.map(item => [item.material, item.binding])));
      nextRoot.removeFromParent();
    }
    if (disposed) throw new Error("TC_BROWSER_DISPOSED");
    // No await in commit: a complete host/view/scope replaces the previous content together.
    const previous = runtime,
      previousScope = contentScope,
      previousMaterials = gameMaterials,
      previousGameplay = gameplay,
      previousPostComposer = postComposer,
      previousVertexBounds = vertexBounds,
      previousRenderBufferBridge = renderBufferBridge,
      previousRenderTextureBridge = renderTextureBridge;
    const previousRoot = new THREE.Group();
    if (gameRoot.children.length) previousRoot.add(...gameRoot.children);
    previousCleanup = async () => {
      await cleanup("previous runtime", () => previous?.dispose());
      await cleanup("previous gameplay", () => previousGameplay?.dispose());
      await cleanup("previous postprocess", () => previousPostComposer?.dispose());
      await cleanup("previous vertex bounds", () => previousVertexBounds?.dispose());
      await cleanup("previous buffer bridge", () => previousRenderBufferBridge?.dispose());
      await cleanup("previous texture bridge", () => previousRenderTextureBridge?.dispose());
      await cleanup("previous scene", () => releaseObject(previousRoot));
      for (const [id, material] of previousMaterials) await cleanup(`previous material ${id}`, () => material.dispose());
      await cleanup("previous resource scope", () => previousScope?.release());
    };
    compiledIR = ir;
    runtime = candidate;
    renderControl = nextRender;
    computeControl = nextCompute;
    computeExecutor = nextComputeExecutor;
    renderBufferBridge = nextRenderBufferBridge;
    renderTextureBridge = nextRenderTextureBridge;
    postComposer = nextPostComposer;
    vertexBounds = nextVertexBounds;
    surfaceTracer?.clearContent();
    gameplay = nextGameplay;
    contentScope = nextScope;
    gameMaterials = nextMaterials;
    committed = true;
    clearDynamicVisuals();
    if (nextRoot.children.length) gameRoot.add(...nextRoot.children);
    gameObjects.clear();
    for (const [id, node] of nextObjects) gameObjects.set(id, node);
    materialGraphs.splice(0, materialGraphs.length, ...nextGraphs);
    authoredCamera = nextCamera;
    scene.background = nextGameplay?.background ?? nextBackground;
    scene.backgroundRotation.set(0, ir.scene.environment.backgroundRotation ?? 0, 0);
    scene.backgroundIntensity = ir.scene.environment.backgroundIntensity ?? 1;
    scene.environment = nextGameplay?.environment ?? null;
    scene.environmentRotation.set(0, ir.scene.environment.lightingRotation ?? 0, 0);
    scene.environmentIntensity = ir.scene.environment.lightingIntensity ?? 1;
    camera = ir.scene.camera.projection === "orthographic" ? orthographicCamera : perspectiveCamera;
    camera.near = ir.scene.camera.near;
    camera.far = ir.scene.camera.far;
    if (camera instanceof THREE.PerspectiveCamera) camera.fov = ir.scene.camera.fov;
    else {
      const halfHeight = (ir.scene.camera.orthographicSize ?? 10) / 2;
      camera.left = -halfHeight * width / height;
      camera.right = halfHeight * width / height;
      camera.top = halfHeight;
      camera.bottom = -halfHeight;
    }
    camera.updateProjectionMatrix();
    tick = candidate.inspect().scheduler.tick;
    frameAccumulator = 0;
    lastFrameTime = undefined;
    inputLog.length = 0;
    terminalFault = false;
    syncRuntime();
    nextGameplay?.mount(
      (key, pressed) => {
        if (!loadingContent && !restoring && !disposed)
          runtime?.input(key, pressed);
      },
      (type, payload) => {
        if (!loadingContent && !restoring && !disposed)
          runtime?.emitExternal(type, payload);
      },
    );
    await previousCleanup();
    previousCleanup = undefined;
    return ir;
  } catch (error) {
    if (committed && previousCleanup) {
      await previousCleanup();
      previousCleanup = undefined;
    } else if (!committed) {
      if (!attached) await cleanup("candidate game", () => candidateGame?.dispose());
      await cleanup("candidate runtime", () => candidate?.dispose());
      await cleanup("candidate gameplay", () => nextGameplay?.dispose());
      await cleanup("candidate render", () => nextRender?.dispose());
      await cleanup("candidate compute", () => nextCompute?.dispose());
      await cleanup("candidate postprocess", () => nextPostComposer?.dispose());
      await cleanup("candidate vertex bounds", () => nextVertexBounds?.dispose());
      await cleanup("candidate buffer bridge", () => nextRenderBufferBridge?.dispose());
      await cleanup("candidate texture bridge", () => nextRenderTextureBridge?.dispose());
      await cleanup("candidate scene", () => releaseObject(nextRoot));
      for (const [id, material] of nextMaterials) await cleanup(`candidate material ${id}`, () => material.dispose());
      await cleanup("candidate resource scope", () => nextScope?.release());
    }
    throw error;
  } finally {
    loadingContent = false;
  }
}
/** Only completed fixed ticks may request browser persistence or scene transactions. */
async function processGameRequests() {
  await computeControl?.flush();
  if (!gameplay || !compiledIR || !runtime) return;
  const requests = gameplay.services.takeRequests();
  for (const request of requests) {
    if (request.type === "scene") {
      await loadGame(request.id);
      continue;
    }
    const slot = request.id;
    const key = "pelican:" + compiledIR.gameId + ":" + slot;
    try {
      if (request.type === "save") {
        syncRuntime();
        const saved: GameSave = {
          format: "pelican.save",
          version: 1,
          engineVersion: SDK_VERSION,
          gameId: compiledIR.gameId,
          sceneId: compiledIR.scene.id,
          assets: Object.fromEntries(
            compiledIR.assets.map((a) => [a.id, a.hash]),
          ),
          runtime: runtime.snapshot(),
        };
        localStorage.setItem(key, JSON.stringify(saved));
        gameplay.services.storageComplete("save", slot);
      } else {
        const text = localStorage.getItem(key);
        if (text === null) throw new Error("TC_SAVE_MISSING: " + slot);
        const saved = JSON.parse(text) as GameSave;
        if (!saved || typeof saved.sceneId !== "string")
          throw new Error("TC_SAVE_FORMAT");
        await loadGame(saved.sceneId, saved, slot);
        gameplay!.services.storageComplete("load", slot);
      }
    } catch (error) {
      gameplay?.services.storageComplete(request.type, slot, String(error));
    }
  }
}
function animate() {
  const time = tick / 60;
  graphTime.value = time;
  for (const item of materialGraphs) {
    item.binding.time = time;
    item.binding.parameters = renderControl!.service.materialParameters(item.binding.id);
    if (item.binding.buffers) item.binding.buffers = renderControl!.buffers.resources(item.binding.id);
    if (item.binding.managedTextures) item.binding.managedTextures = renderControl!.textures.resources(item.binding.id);
    for (const [name, parameter] of item.uniforms) {
      const value = item.binding.parameters[name];
      if (Array.isArray(value)) (parameter.value as THREE.Vector2 | THREE.Vector3 | THREE.Vector4).fromArray(value);
      else parameter.value = value as any;
    }
    if (probeEnabled && item.graph) {
      const value = evaluateGraph(item.graph, time);
      if (typeof value === "boolean") throw Error("TC_GRAPH_TYPE: Legacy color graph must return vec3.");
      item.material.color.fromArray(typeof value === "number" ? [value,value,value] : [...value]);
    }
  }
  box.position.x = -1.6 + Math.sin(time) * 0.65;
  box.rotation.y = time * 0.5;
  morphMesh.morphTargetInfluences![0] = (Math.sin(time * 1.3) + 1) * 0.5;
  tip.rotation.z = Math.sin(time * 1.8) * 0.5;
  const base = new THREE.Vector3().fromArray(authoredCamera.position),
    target = new THREE.Vector3().fromArray(authoredCamera.target);
  const offset = base
    .sub(target)
    .applyAxisAngle(new THREE.Vector3(0, 1, 0), cameraPhase);
  const cameraState = gameplay?.services.inspect();
  if (!cameraState?.camera && !cameraState?.cameraPose) {
    camera.position.copy(target).add(offset);
    camera.lookAt(target);
  }
  camera.updateMatrixWorld();
  vertexBounds?.update(scene, new Map(materialGraphs.map(item => [item.material, item.binding])));
  gameplay?.present(camera, gameObjects, playing ? 1 / 60 : 0, tick);
}
function updateTraceGeometry() {
  const start = performance.now();
  const geometry = buildBVH(extractTriangles(scene));
  bvhMs = performance.now() - start;
  triangleCount = geometry.triangleCount;
  nodeCount = geometry.nodeCount;
  let hash = 2166136261;
  for (let i = 0; i < geometry.triangles.length; i += 7)
    hash = Math.imul(
      hash ^ Math.round(geometry.triangles[i] * 10000),
      16777619,
    );
  lastGeometryHash = hash >>> 0;
  const uploadStart = performance.now();
  tracer.upload(geometry);
  uploadMs = performance.now() - uploadStart;
  generation++;
}
function cameraFrame() {
  if (!(camera instanceof THREE.PerspectiveCamera))
    throw new Error("TC_RENDER_MODE_UNAVAILABLE: Orthographic projection currently supports raster only; choose a perspective camera for hybrid/path modes.");
  const forward = new THREE.Vector3();
  camera.getWorldDirection(forward);
  const right = new THREE.Vector3()
    .setFromMatrixColumn(camera.matrixWorld, 0)
    .multiplyScalar(
      Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * camera.aspect,
    );
  const up = new THREE.Vector3()
    .setFromMatrixColumn(camera.matrixWorld, 1)
    .multiplyScalar(Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)));
  const light = authoredLights[0];
  const position = light
    ? light.object.getWorldPosition(new THREE.Vector3()).toArray()
    : [-3, 6, 3];
  const definition = light?.definition;
  const actualLight = light?.object instanceof THREE.Light ? light.object : undefined;
  const color = actualLight?.color ?? new THREE.Color(0xffdfb0);
  return {
    origin: camera.position.toArray(),
    forward: forward.toArray(),
    right: right.toArray(),
    up: up.toArray(),
    near: camera.near,
    far: camera.far,
    light: {
      position,
      color: color.toArray(),
      intensity: actualLight ? (actualLight.visible ? actualLight.intensity : 0) : 55,
      directional: definition?.kind === "directional",
    },
    environment: scene.background instanceof THREE.Color ? scene.background.toArray() : [0, 0, 0],
    ambient: compiledIR?.scene.environment.ambientIntensity ?? 1,
  };
}
function draw(accumulate = false, changed = true) {
  const operation = drawTail.then(async () => {
    document.documentElement.dataset.pelicanFrameState = "drawing";
    try {
      await drawFrame(accumulate, changed);
      frameSerial++;
      document.documentElement.dataset.pelicanFrameSerial =
        String(frameSerial);
    } finally {
      document.documentElement.dataset.pelicanFrameState = "idle";
    }
  });
  drawTail = operation.catch(() => {});
  return operation;
}
async function drawFrame(accumulate = false, changed = true) {
  if (disposed) throw new Error("TC_BROWSER_DISPOSED");
  await computeControl?.flush();
  const start = performance.now();
  const ropeChanged = syncRuntime();
  const ropeRevision = dynamicVisualRevision;
  changed = changed || ropeChanged;
  animate();
  renderBufferBridge?.update();
  renderTextureBridge?.update();
  const settings =
    renderControl?.service.state() ?? resolveRenderSettings({ mode });
  const effects = postComposer && renderControl?.postProcesses.states().some(effect => effect.enabled) ? postComposer : undefined;
  validateRenderCapabilities(settings, renderControl?.service.capabilities() ?? cameraCapabilities(backendKind, camera instanceof THREE.OrthographicCamera));
  if (mode !== settings.mode) setMode(settings.mode);
  if (probeEnabled && vertexBounds) throw new Error("TC_VERTEX_PROBE_UNSUPPORTED: Vertex graphs require a normal game scene, not the historical tracing sidecar.");
  rasterCanvas.style.display = mode === "raster" || effects ? "block" : "none";
  traceCanvas.style.display = mode === "raster" || effects ? "none" : "block";
  if (effects && probeEnabled) throw new Error("TC_POSTPROCESS_PROBE_UNSUPPORTED: Controlled effects require a normal game scene, not the historical M0 tracing sidecar.");
  if (mode !== "raster" && !probeEnabled) {
    if (!(camera instanceof THREE.PerspectiveCamera))
      throw new Error("TC_RENDER_MODE_UNAVAILABLE: Orthographic projection currently supports raster only; choose a perspective camera for hybrid/path modes.");
    if (!surfaceTracer) {
      if (!legacyTracerDisposed) {
        tracer.dispose();
        legacyTracerDisposed = true;
      }
      const controller = new AbortController();
      const ownedDevice = device;
      pendingSurface = controller;
      const retain = (candidate: SurfaceTracer) => {
        if (controller.signal.aborted || disposed || device !== ownedDevice) {
          candidate.dispose();
          throw new Error("TC_TRACE_CANCELLED: Surface initialization owner changed.");
        }
        return candidate;
      };
      try {
        const candidate = await boundedOperation(SurfaceTracer.create(
          device,
          traceCanvas,
          width,
          height,
          renderer,
          reportFailure,
          import.meta.env.DEV,
          controller.signal,
        ).then(retain), "surface renderer initialization");
        surfaceTracer = retain(candidate);
      } finally {
        controller.abort();
        if (pendingSurface === controller) pendingSurface = undefined;
      }
      changed = true;
    }
    const surfaceState = surfaceTracer.inspect();
    const needsMotion = settings.denoise && settings.debug === "beauty";
    if (
      changed ||
      surfaceState.triangleCount === 0 ||
      surfaceState.motion.enabled !== needsMotion
    )
      await boundedOperation(
        surfaceTracer.update(
          scene,
          new Set(materialGraphs.map((item) => item.material)),
          needsMotion,
          new Map(materialGraphs.map(item => [item.material, item.binding])),
          computeExecutor,
        ),
        "surface content capture",
      );
    if (effects) await surfaceTracer.prepareLinearPresentation();
    submitMs = surfaceTracer.render(camera, settings, effects?.traceTargets());
    if (effects) effects.present(renderControl!.postProcesses, tick / 60, settings);
    const report = surfaceTracer.inspect();
    triangleCount = report.triangleCount;
    nodeCount = report.nodeCount;
    bvhMs =
      (report.acceleration?.metrics.refitMs ?? 0) +
      (report.acceleration?.metrics.buildMs ?? 0);
    uploadMs = report.uploadMs;
    metrics.push({
      frame: tick,
      bvhMs,
      uploadMs,
      submitMs,
      wallMs: performance.now() - start,
      simulationMs: lastStepCpuMs,
    });
    if (metrics.length > 2000) metrics.shift();
    status.hidden = false;
    status.textContent = runtimeStatus({
      backend: backendKind,
      mode,
      playing,
      automation: startup.automation,
      tick,
      triangles: triangleCount,
      faulted: terminalFault,
    });
    renderedDynamicVisualRevision = ropeRevision;
    return;
  }
  if (changed) {
    if ((gameplay || legacyTracerDisposed || backendKind === "webgl2") && mode === "raster") {
      // Raster does not consume a CPU BVH. Count authored triangles without rebuilding/uploading tracing buffers.
      triangleCount = 0;
      scene.traverseVisible((object) => {
        if (object instanceof THREE.Mesh && !object.userData.noTrace)
          triangleCount +=
            (object.geometry.index?.count ??
              object.geometry.getAttribute("position").count) / 3;
      });
      nodeCount = 0;
      bvhMs = 0;
      uploadMs = 0;
    } else updateTraceGeometry();
  }
  renderer.toneMappingExposure = settings.exposure;
  if (mode !== "path") {
    if (effects) {
      effects.captureRaster(scene, camera);
      effects.present(renderControl!.postProcesses, tick / 60, settings);
    } else renderer.render(scene, camera);
  }
  if (mode !== "raster")
    submitMs = tracer.renderFrame(cameraFrame(), mode, accumulate);
  else submitMs = 0;
  metrics.push({
    frame: tick,
    bvhMs: changed ? bvhMs : 0,
    uploadMs: changed ? uploadMs : 0,
    submitMs,
    wallMs: performance.now() - start,
    simulationMs: lastStepCpuMs,
  });
  if (metrics.length > 2000) metrics.shift();
  status.hidden = false;
  status.textContent = runtimeStatus({
    backend: backendKind,
    mode,
    playing,
    automation: startup.automation,
    tick,
    triangles: triangleCount,
    faulted: terminalFault,
  });
  renderedDynamicVisualRevision = ropeRevision;
}
async function applyInput(key: string) {
  if (!probeEnabled) {
    const host = requireRuntime();
    host.input(key, true);
    if (!playing) await stepRuntime();
    syncRuntime();
    tick = host.inspect().scheduler.tick;
    return;
  }
  const id = compiledIR?.scene.entities.find((entity) => entity.mesh)?.id;
  if (!id) return;
  const t = facade.getTransform(id);
  if (key === "ArrowRight" || key === "ArrowLeft")
    facade.setTransform(id, {
      position: [
        t.position[0] + (key === "ArrowRight" ? 0.25 : -0.25),
        t.position[1],
        t.position[2],
      ],
    });
}
function onKeyDown(event: KeyboardEvent) {
  if (gameplay?.consumesKeyboard(event)) return;
  if (disposed || terminalFault || loadingContent || restoring || !runtime)
    return;
  try {
    if (
      compiledIR?.input &&
      Object.values(compiledIR.input).some((keys) => keys.includes(event.key))
    )
      event.preventDefault();
    gameplay?.unlockAudio();
    queueNativeInput(async () => {
      inputLog.push({ tick, key: event.key });
      await applyInput(event.key);
      if (!playing) requestInputDraw();
    });
  } catch (error) {
    reportFailure(error);
  }
}
function requestInputDraw() {
  inputDrawRequested = true;
  if (inputDrawActive) return;
  inputDrawActive = true;
  void (async () => {
    try {
      while (inputDrawRequested && !playing && !disposed) {
        inputDrawRequested = false;
        await draw(false, true);
      }
    } catch (error) {
      if (!disposed) reportFailure(error);
    } finally {
      inputDrawActive = false;
    }
  })();
}
function queueNativeInput(operation: () => void | Promise<void>) {
  nativeInputTail = nativeInputTail.then(async () => {
    await tickTail;
    if (disposed || terminalFault || loadingContent || restoring || !runtime) return;
    await operation();
  }).catch(error => { if (!disposed) reportFailure(error); });
}
async function pollGameplayGamepad(): Promise<void> {
  const host = runtime, current = gameplay;
  if (!host || !current || probeEnabled) return;
  const config = current.services.gamepadConfig();
  if (config.mode !== "game") { gamepadHost = host; gamepadFingerprint = undefined; return; }
  const suppressed = document.hidden || (typeof document.hasFocus === "function" && !document.hasFocus()) || current.blocksGameplayGamepad();
  const sample = sampleGameplayGamepad(suppressed), fingerprint = JSON.stringify([config.deadzone, sample]);
  if (gamepadHost === host && gamepadFingerprint === fingerprint) return;
  queueNativeInput(() => {
    if (runtime !== host) return;
    host.emitExternal("input.gamepad", sample);
    gamepadHost = host; gamepadFingerprint = fingerprint;
  });
  await nativeInputTail;
}
function onKeyUp(event: KeyboardEvent) {
  if (gameplay?.consumesKeyboard(event)) return;
  if (
    disposed ||
    terminalFault ||
    loadingContent ||
    restoring ||
    !runtime ||
    probeEnabled
  )
    return;
  queueNativeInput(() => { requireRuntime().input(event.key, false); });
}
function onWindowBlur() {
  const host = runtime, current = gameplay;
  gamepadFingerprint = undefined;
  if (!host || !current || disposed || terminalFault || loadingContent || restoring || current.services.gamepadConfig().mode !== "game") return;
  const sample = sampleGameplayGamepad(true);
  queueNativeInput(() => { if (runtime === host) host.emitExternal("input.gamepad", sample); });
}
window.addEventListener("keydown", onKeyDown);
window.addEventListener("keyup", onKeyUp);
window.addEventListener("blur", onWindowBlur);
async function stepRuntime() {
  const started = performance.now();
  const host = requireRuntime();
  if (terminalFault)
    throw new Error(
      "TC_BROWSER_FAULTED: Restore a valid checkpoint or reload content before stepping.",
    );
  try {
    const operation = tickTail.then(async () => {
      if (disposed || host !== runtime) throw new Error("TC_BROWSER_DISPOSED: Tick owner changed.");
      await host.stepAsync(1);
    });
    tickTail = operation.catch(() => {});
    await operation;
    tick = host.inspect().scheduler.tick;
    simulation?.step();
  } catch (error) {
    tick = host.inspect().scheduler.tick;
    reportFailure(error);
    throw error;
  } finally {
    lastStepCpuMs = performance.now() - started;
  }
}
function setMode(next: typeof mode) {
  if (next !== "raster" && camera instanceof THREE.OrthographicCamera)
    throw new Error("TC_RENDER_MODE_UNAVAILABLE: Orthographic projection currently supports raster only; choose a perspective camera for hybrid/path modes.");
  if (next !== "raster") requireCompute(renderCapabilities(backendKind), next);
  if (next !== mode) {
    surfaceTracer?.invalidateTemporal();
    postComposer?.resetHistory("mode");
  }
  mode = next;
  document.documentElement.dataset.pelicanMode = next;
  rasterCanvas.style.display = next === "raster" ? "block" : "none";
  traceCanvas.style.display = next === "raster" ? "none" : "block";
  traceCanvas.style.opacity = "1";
}
function inspect(options?: InspectPage) {
  const bounded =
    options &&
    (options.entity !== undefined ||
      options.offset !== undefined ||
      options.limit !== undefined);
  syncRuntime();
  const runtimeState = runtime?.inspect();
  const selected = bounded
    ? selectInspectRecords(runtimeState?.records ?? [], options)
    : undefined;
  return {
    ready: !disposed && !terminalFault && !recoveringGpu,
    playback: {
      playing,
      automation: startup.automation,
      state: terminalFault ? "faulted" : playing ? "running" : "paused",
    },
    backend: backendKind === "webgpu" ? "WebGPUBackend" : backendKind === "webgl2" ? "WebGLBackend" : "uninitialized",
    adapter: adapterInfo,
    mode,
    rendering: {
      cameraProjection: camera instanceof THREE.OrthographicCamera ? "orthographic" : "perspective",
      postProcesses: postComposer?.inspect(),
      vertex: vertexBounds?.inspect(),
      bufferBindings: renderBufferBridge?.inspect(),
      textureBindings: renderTextureBridge?.inspect(),
      computeGpu: computeExecutor?.inspect(),
      effectStates: renderControl?.postProcesses.states(),
      compute: computeControl?.inspect(),
      backendDiagnostic: backendKind === "webgl2" ? { code: "TC_RENDER_WEBGL2_FALLBACK", severity: "info", message: "WebGPU initialization unavailable; using Three.js built-in WebGL2 fallback. Available modes: raster." } : null,
      settings: renderControl?.service.state(),
      surface: surfaceTracer?.inspect(),
      gpuRecovery: {
        active: recoveringGpu,
        count: recoveryCount,
        events: [...recoveryEvents],
      },
    },
    tick,
    width,
    height,
    inputLog: [...inputLog],
    triangleCount,
    nodeCount,
    generation,
    geometryHash: lastGeometryHash,
    objects: {
      box: box.position.toArray(),
      morph: morphMesh.morphTargetInfluences![0],
      bone: tip.rotation.z,
      camera: camera.position.toArray(),
    },
    errors: [...errors],
    ...(bounded ? {} : { compiledIR }),
    runtime: runtimeState && {
      ...runtimeState,
      records: selected?.records ?? runtimeState.records,
    },
    ...(selected ? { paging: selected.paging } : {}),
    frameClock: {
      fixedDt: 1 / 60,
      accumulator: frameAccumulator,
      backlogTicks: Math.floor(frameAccumulator * 60),
      maxStepsPerFrame: 8,
    },
    resources: resourceManager.inspect(),
    gameplay: gameplay?.inspect(),
    game: {
      transforms: selected
        ? Object.fromEntries(
            selected.records.map((record) => [record.id, record.transform]),
          )
        : Object.fromEntries(transforms),
      components: selected
        ? Object.fromEntries(
            selected.records.map((record) => [record.id, record.components]),
          )
        : Object.fromEntries(componentState),
    },
    simulation: simulation?.inspect(),
    world: world?.inspect(),
    metrics: [...metrics],
    capabilities: {
      ...renderCapabilities(backendKind),
      ...inspectTraceCapabilities({ backend: backendKind, legacyProbe: probeEnabled, surfaceInitialized: !!surfaceTracer, gameplay: !!gameplay, maxBounces: renderControl?.service.state().maxBounces ?? 5 }),
    },
  };
}
async function disposeBrowser() {
  if (disposal) return disposal;
  disposed = true;
  playing = false;
  lastFrameTime = undefined;
  if (frameRequest !== undefined) cancelAnimationFrame(frameRequest);
  frameRequest = undefined;
  document.documentElement.dataset.pelicanReady = "false";
  window.removeEventListener("keydown", onKeyDown);
  window.removeEventListener("keyup", onKeyUp);
  window.removeEventListener("blur", onWindowBlur);
  rasterCanvas.removeEventListener("webglcontextrestored", onContextRestored);
  window.removeEventListener("pagehide", onPageHide);
  const pending: Promise<unknown>[] = [];
  const clean = (action: () => unknown) => {
    try {
      const result = action();
      if (result && typeof (result as Promise<unknown>).then === "function")
        pending.push(Promise.resolve(result));
    } catch (error) {
      errors.push(`TC_BROWSER_CLEANUP: ${String(error)}`);
    }
  };
  clean(() => runtime?.dispose());
  clean(() => computeControl?.dispose());
  clean(() => postComposer?.dispose());
  clean(() => vertexBounds?.dispose());
  clean(() => renderBufferBridge?.dispose());
  clean(() => renderTextureBridge?.dispose());
  clean(() => gameplay?.dispose());
  clean(() => simulation?.dispose());
  clean(() => world?.dispose());
  clean(() => resourceManager.dispose());
  clean(() => ropeVisuals.dispose());
  clean(() => clothVisuals.dispose());
  clean(() => fluidVisuals.dispose());
  clean(() => softBodyVisuals.dispose());
  clean(() => spriteVisuals.dispose());
  clean(() => tilemapVisuals.dispose());
  clean(() => releaseObject(scene, true, gameMaterials.values()));
  clean(() => pendingSurface?.abort());
  clean(() => tracer?.dispose());
  clean(() => surfaceTracer?.dispose());
  clean(async () => {
    const gl = backendKind === "webgl2" ? rasterCanvas.getContext("webgl2") : null;
    try {
      await renderer?.dispose();
    } finally {
      gl?.getExtension("WEBGL_lose_context")?.loseContext();
    }
  });
  clean(() => device?.destroy());
  gameObjects.clear();
  gameMaterials.clear();
  transforms.clear();
  componentState.clear();
  materialGraphs.length = 0;
  authoredLights = [];
  topologyObjects.length = 0;
  compiledIR = null;
  runtime = undefined;
  renderControl = undefined;
  computeControl = undefined;
  postComposer = undefined;
  vertexBounds = undefined;
  computeExecutor = undefined;
  renderBufferBridge = undefined;
  renderTextureBridge = undefined;
  gameplay = undefined;
  simulation = undefined;
  world = undefined;
  contentScope = undefined;
  rasterCanvas.remove();
  traceCanvas.remove();
  disposal = Promise.allSettled(pending).then((results) => {
    for (const result of results)
      if (result.status === "rejected")
        errors.push(`TC_BROWSER_CLEANUP: ${String(result.reason)}`);
  });
  return disposal;
}
function onPageHide() {
  void disposeBrowser();
}
window.addEventListener("pagehide", onPageHide);
async function initializeGpu() {
  let abandoned = false;
  const candidate = new THREE.WebGPURenderer({ canvas: rasterCanvas, antialias: true, powerPreference: "high-performance" });
  renderer = candidate;
  renderer.setPixelRatio(1);
  renderer.setSize(width, height);
  renderer.shadowMap.enabled = true;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.onDeviceLost = (info) => {
    if (disposed || renderer !== candidate) return;
    if (info.api === "WebGL") {
      lostRenderers.add(candidate);
      if (recoveringGpu) return;
      contextWasPlaying = playing;
      playing = false;
      recoveringGpu = true;
      waitingForWebglRestore = true;
      document.documentElement.dataset.pelicanReady = "false";
      recoveryEvents.push({ phase: "lost", reason: "TC_RENDER_CONTEXT_LOST: WebGL2 context lost; waiting for browser restoration.", tick });
      status.hidden = false;
      status.textContent = "WebGL2 · TC_RENDER_CONTEXT_LOST";
    }
  };
  try {
    await boundedOperation(candidate.init().then(async () => {
      if (abandoned || disposed || renderer !== candidate) await candidate.dispose();
    }), "renderer initialization");
  } catch (error) {
    abandoned = true;
    throw new Error("TC_RENDER_BACKEND_UNAVAILABLE: WebGPU and built-in WebGL2 fallback could not initialize. Enable a supported graphics backend and reload. " + String(error));
  }
  if (disposed) return;
  // Backend objects stay private; only plain capability data crosses the SDK boundary.
  const backend = candidate.backend as unknown as { isWebGLBackend?: boolean; device?: GPUDevice };
  backendKind = backend.isWebGLBackend ? "webgl2" : "webgpu";
  document.documentElement.dataset.pelicanBackend = backendKind;
  adapterInfo = undefined;
  legacyTracerDisposed = backendKind !== "webgpu";
  if (backendKind === "webgl2") return;
  if (!backend.device) throw new Error("TC_RENDER_BACKEND_UNAVAILABLE: Initialized backend has no compute device.");
  device = backend.device;
  const identity = device.adapterInfo;
  adapterInfo = {
    vendor: identity.vendor,
    architecture: identity.architecture,
    isFallbackAdapter: identity.isFallbackAdapter,
    features: [...device.features],
  };
  const ownedDevice = device;
  device.addEventListener("uncapturederror", (event) => {
    if (!disposed && device === ownedDevice && !recoveringGpu)
      reportFailure(new Error("TC_GPU_VALIDATION: " + event.error.message));
  });
  void device.lost.then((info) => {
    lostDevices.add(ownedDevice);
    if (disposed || device !== ownedDevice || recoveringGpu) return;
    recoveryTask = recoverGpu(info);
    void recoveryTask.catch((error) => {
      reportFailure(error);
    });
  });
  status.textContent = "GPU tracer";
  tracer = new GPUTracer(device, traceCanvas, width, height);
  legacyTracerDisposed = false;
}
async function submittedWork(label = "GPU submission") {
  if (backendKind === "webgpu") await boundedOperation(device.queue.onSubmittedWorkDone(), label);
}
function onContextRestored() {
  if (disposed || backendKind !== "webgl2" || !waitingForWebglRestore) return;
  waitingForWebglRestore = false;
  recoveringGpu = false;
  playing = contextWasPlaying;
  recoveryTask = recoverGpu({ reason: "unknown", message: "WebGL2 context restored" });
  void recoveryTask.catch(reportFailure);
}
rasterCanvas.addEventListener("webglcontextrestored", onContextRestored);
async function recoverGpu(info: Pick<GPUDeviceLostInfo, "reason" | "message">) {
  const wasPlaying = playing;
  recoveringGpu = true;
  playing = false;
  lastFrameTime = undefined;
  document.documentElement.dataset.pelicanReady = "false";
  status.hidden = false;
  status.textContent = `Rebuilding ${backendKind} resources`;
  recoveryEvents.push({
    phase: "lost",
    reason: info.reason + ": " + info.message,
    tick,
  });
  try {
    pendingSurface?.abort();
    renderBufferBridge?.dispose();
    renderBufferBridge = undefined;
    renderTextureBridge?.dispose();
    renderTextureBridge = undefined;
    computeControl?.replaceExecutor(undefined);
    postComposer?.dispose();
    postComposer = undefined;
    surfaceTracer?.dispose();
    surfaceTracer = undefined;
    tracer?.dispose();
    await renderer?.dispose();
    await initializeGpu();
    if (disposed) return;
    computeExecutor = backendKind === "webgpu" && (compiledIR?.computes.length || compiledIR?.computeBuffers?.length || compiledIR?.computeTextures?.length) ? createComputeExecutor(device) : undefined;
    computeControl?.replaceExecutor(computeExecutor);
    if (compiledIR && usesRenderSlots(compiledIR)) {
      renderBufferBridge = createRenderBufferBridge(renderer, () => computeExecutor, id => slotResources(renderControl!, id));
    }
    if (compiledIR && usesRenderTextures(compiledIR)) renderTextureBridge = createRenderTextureBridge(renderer, () => computeExecutor, id => textureResources(renderControl!, id));
    for (const item of materialGraphs) applyMaterialGraphs(item.material, item.binding, item.uniforms, renderBufferBridge, renderTextureBridge);
    if (gameplay)
      scene.environment =
        (await gameplay.rebuildGpuResources(renderer)) ?? null;
    if (compiledIR?.postProcesses?.length)
      postComposer = createPostProcessComposer(renderer, width, height, compiledIR.postProcesses, gameplay?.textures ?? new Map(), renderBufferBridge, renderTextureBridge);
    await draw(false, true);
    if (disposed) return;
    if (lostRenderers.has(renderer) || (backendKind === "webgpu" && lostDevices.has(device)))
      throw new Error("TC_GPU_RECOVERY_DEVICE_LOST: Replacement backend was lost during reconstruction. Reload after restoring graphics availability.");
    terminalFault = false;
    delete document.documentElement.dataset.pelicanFailure;
    document.documentElement.dataset.pelicanReady = "true";
    recoveryCount++;
    recoveryEvents.push({
      phase: "restored",
      reason: backendKind === "webgpu" ? "new WebGPU device" : "new WebGL2 renderer",
      tick,
    });
    playing = wasPlaying;
    lastFrameTime = undefined;
  } catch (error) {
    playing = false;
    recoveryEvents.push({ phase: "failed", reason: String(error), tick });
    throw new Error("TC_GPU_RECOVERY_FAILED: " + String(error));
  } finally {
    recoveringGpu = false;
  }
}
async function boot() {
  await initializeGpu();
  status.textContent = "Loading compiled game";
  await boundedOperation(loadGame(), "compiled content initialization");
  status.textContent = "Drawing compiled game";
  setMode("raster");
  await draw();
  const api = {
    inspect,
    configureRendering: async (settings: Partial<RenderSettings>) => {
      requireRuntime().facade.render.configure(settings);
      await draw(false, true);
      await submittedWork("render settings frame");
      return inspect();
    },
    exerciseDeviceLoss: async () => {
      requireRuntime();
      requireCompute(renderCapabilities(backendKind), "Device loss probe");
      const lost = device;
      lost.destroy();
      await boundedOperation(lost.lost, "injected device loss");
      await Promise.resolve();
      if (!recoveryTask) throw new Error("TC_GPU_RECOVERY_NOT_STARTED");
      await boundedOperation(recoveryTask, "device recovery", 60000);
      if (device === lost) throw new Error("TC_GPU_RECOVERY_DEVICE_UNCHANGED");
      return inspect();
    },
    exerciseContextLoss: async () => {
      requireRuntime();
      if (backendKind !== "webgl2") throw new Error("TC_RENDER_CONTEXT_PROBE_BACKEND: This probe requires WebGL2.");
      const gl = rasterCanvas.getContext("webgl2")!;
      const extension = gl.getExtension("WEBGL_lose_context");
      if (!extension) throw new Error("TC_RENDER_CONTEXT_PROBE_UNAVAILABLE: Browser does not expose WEBGL_lose_context.");
      const lost = new Promise<void>((resolve) => rasterCanvas.addEventListener("webglcontextlost", () => resolve(), { once: true }));
      const restored = new Promise<void>((resolve) => rasterCanvas.addEventListener("webglcontextrestored", () => resolve(), { once: true }));
      extension.loseContext();
      await boundedOperation(lost, "WebGL2 injected context loss");
      await new Promise((resolve) => setTimeout(resolve, 100));
      extension.restoreContext();
      await boundedOperation(restored, "WebGL2 context restoration");
      await boundedOperation(recoveryTask!, "WebGL2 resource recovery");
      return inspect();
    },
    mode: async (next: typeof mode) => {
      requireRuntime();
      const previous = mode;
      try {
        renderControl?.service.configure({ mode: next });
        setMode(next);
        await draw(false, true);
      } catch (error) {
        renderControl?.service.configure({ mode: previous });
        setMode(previous);
        await draw(false, true);
        throw error;
      }
      await submittedWork("GPU submission");
      return inspect();
    },
    step: async (count = 1) => {
      requireRuntime();
      if (!Number.isInteger(count) || count < 1 || count > 10000)
        throw new Error("TC_PROTOCOL_STEPS: count must be in [1,10000].");
      for (let i = 0; i < count; i++) {
        await stepRuntime();
        await processGameRequests();
        syncSimulation();
        await draw(false, true);
      }
      await submittedWork("GPU submission");
      return inspect();
    },
    camera: async (phase: number) => {
      cameraPhase = phase;
      await draw(false, false);
      await submittedWork("GPU submission");
      return inspect();
    },
    accumulate: async (count = 16) => {
      if (mode === "raster")
        throw new Error(
          "TC_TRACE_MODE: Accumulation is available in path or hybrid mode.",
        );
      if (!Number.isSafeInteger(count) || count < 1 || count > 4096)
        throw new Error(
          "TC_TRACE_SAMPLES: Development accumulation count must be an integer in [1,4096].",
        );
      for (let i = 0; i < count; i++) await draw(i > 0, false);
      await submittedWork("GPU submission");
      return surfaceTracer ? surfaceTracer.pixels() : tracer.pixelStats();
    },
    pixels: () =>
      surfaceTracer && mode !== "raster"
        ? surfaceTracer.pixels()
        : legacyTracerDisposed
          ? Promise.resolve({
              available: false,
              mode: "raster",
              reason:
                "Surface statistics are not a raster framebuffer readback; use the external current-page capture.",
            })
          : tracer.pixelStats(),
    linearPixels: (filtered = true) => {
      if (!surfaceTracer) throw new Error("TC_TRACE_NOT_ACTIVE");
      return surfaceTracer.readRadiance(filtered);
    },
    motionPixels: () => {
      if (!surfaceTracer) throw new Error("TC_TRACE_NOT_ACTIVE");
      return surfaceTracer.readMotion();
    },
    traceFaultTarget: (pixel: number, sample = 0) => {
      if (!surfaceTracer) throw new Error("TC_TRACE_NOT_ACTIVE");
      surfaceTracer.setFaultTarget(pixel, sample);
    },
    temporalPixels: () => {
      if (!surfaceTracer) throw new Error("TC_TRACE_NOT_ACTIVE");
      return surfaceTracer.readTemporal();
    },
    primaryStats: () => {
      if (!surfaceTracer || mode !== "hybrid")
        throw new Error("TC_TRACE_PRIMARY_NOT_ACTIVE");
      return surfaceTracer.readPrimaryStats();
    },
    guidePixels: () => {
      if (!surfaceTracer) throw new Error("TC_TRACE_NOT_ACTIVE");
      return surfaceTracer.readGuides();
    },
    gpuTimeMs: () =>
      backendKind !== "webgpu" ? Promise.resolve(null) : surfaceTracer ? surfaceTracer.gpuTimeMs() : tracer.gpuTimeMs(),
    vertexRay: (origin: [number, number, number], direction: [number, number, number]) => {
      requireRuntime();
      if (!vertexBounds) throw new Error("TC_VERTEX_NOT_ACTIVE: This scene has no controlled vertex graphs.");
      return vertexBounds.intersect(origin, direction);
    },
    ray: (origin: number[], direction: number[]) => {
      requireCompute(renderCapabilities(backendKind), "Traced ray query");
      return surfaceTracer
        ? surfaceTracer.queryRay(origin, direction)
        : tracer.queryRay(origin, direction);
    },
    compute: async (id: string, time: number) => {
      requireCompute(renderCapabilities(backendKind), "Compute graph");
      const definition = compiledIR?.computes.find((c) => c.id === id);
      if (!definition) throw new Error(`TC_COMPUTE_MISSING:${id}`);
      return runComputeGraph(
        device,
        definition.graph,
        definition.count,
        definition.workgroupSize,
        time,
      );
    },
    simulation: async (kind: SimulationKind) => {
      simulation?.dispose();
      simulation = createSimulation(kind);
      syncSimulation();
      await draw();
      await submittedWork("GPU submission");
      return inspect();
    },
    snapshot: () => {
      const host = requireRuntime();
      syncRuntime();
      return structuredClone({
        format: "pelican.browser",
        version: 1,
        engineVersion: SDK_VERSION,
        tick,
        cameraPhase,
        transforms: Object.fromEntries(transforms),
        components: Object.fromEntries(componentState),
        inputLog,
        simulation: simulation?.snapshot(),
        world: world?.snapshot(),
        runtime: host.snapshot(),
        frameAccumulator,
        resources: resourceManager.snapshot(contentScope),
        topology: topologyObjects.map((object) => object.position.toArray()),
      });
    },
    restore: async (value: unknown) => {
      const host = requireRuntime();
      const saved = validateBrowserCheckpoint(
        value,
        resourceManager.snapshot(contentScope),
      );
      restoring = true;
      let prepared:
        | Awaited<ReturnType<typeof prepareCheckpointProbes>>
        | undefined;
      const nextTopology: THREE.Mesh[] = [];
      let committed = false;
      try {
        prepared = await prepareCheckpointProbes(saved);
        for (const position of saved.topology) {
          const mesh = new THREE.Mesh(
            new THREE.IcosahedronGeometry(0.35, 0),
            standard(0x98dd66),
          );
          mesh.position.fromArray(position);
          nextTopology.push(mesh);
        }
        if (disposed || runtime !== host)
          throw new Error("TC_BROWSER_DISPOSED: Checkpoint owner changed.");
        // Host preflights scheduler/world atomically and preserves generational invalidation.
        // Invalid sidecars have already failed on isolated candidates, without touching this host.
        host.restore(saved.runtime);
        postComposer?.resetHistory("restore");
        surfaceTracer?.invalidateTemporal("restore");
        const previousSimulation = simulation,
          previousWorld = world;
        simulation = prepared.simulation;
        world = prepared.world;
        frameAccumulator = saved.frameAccumulator;
        lastFrameTime = undefined;
        tick = saved.tick;
        cameraPhase = saved.cameraPhase;
        terminalFault = false;
        inputLog.length = 0;
        inputLog.push(...saved.inputLog);
        for (const object of topologyObjects) releaseObject(object, true);
        topologyObjects.splice(0, topologyObjects.length, ...nextTopology);
        for (const mesh of nextTopology) scene.add(mesh);
        committed = true;
        previousSimulation?.dispose();
        previousWorld?.dispose();
        syncRuntime();
        syncSimulation();
        syncWorld();
      } finally {
        if (!committed) {
          prepared?.dispose();
          for (const object of nextTopology) releaseObject(object, true);
        }
        restoring = false;
        gamepadFingerprint = undefined;
      }
      await draw();
      await submittedWork("GPU submission");
      return inspect();
    },
    worldLoad: async () => {
      world?.dispose();
      world = createWorldProbe({ chunkSize: 2, cellsPerChunk: 4 });
      await Promise.all([world.loadChunk([0, 0]), world.loadChunk([1, 0])]);
      syncWorld();
      await draw();
      await submittedWork("GPU submission");
      return inspect();
    },
    worldEdit: async () => {
      if (!world) throw new Error("TC_WORLD_NOT_LOADED");
      await world.applyEdits([{ chunk: [0, 0], x: 2, z: 2, height: 1.8 }]);
      syncWorld();
      await draw();
      await submittedWork("GPU submission");
      return {
        state: inspect(),
        collision: world.sampleHeight({ chunk: [0, 0], local: [1, 0, 1] }),
        navigation: world.getNavigationState(),
      };
    },
    worldUnload: async () => {
      await world?.unloadChunk([0, 0]);
      syncWorld();
      await draw();
      await submittedWork("GPU submission");
      return inspect();
    },
    worldReload: async () => {
      await world?.loadChunk([0, 0]);
      syncWorld();
      await draw();
      await submittedWork("GPU submission");
      return inspect();
    },
    topology: async () => {
      const extra = new THREE.Mesh(
        new THREE.IcosahedronGeometry(0.35, 0),
        standard(0x98dd66),
      );
      extra.position.set(2, 0.5, 1.5);
      scene.add(extra);
      topologyObjects.push(extra);
      await draw();
      await submittedWork("GPU submission");
      return inspect();
    },
    play: () => {
      requireRuntime();
      if (terminalFault)
        throw new Error(
          "TC_BROWSER_FAULTED: Restore a valid checkpoint or reload content before resuming.",
        );
      playing = true;
      lastFrameTime = undefined;
      status.textContent = runtimeStatus({
        backend: backendKind,
        mode,
        playing,
        automation: startup.automation,
        tick,
        triangles: triangleCount,
      });
    },
    pause: () => {
      playing = false;
      lastFrameTime = undefined;
      status.textContent = runtimeStatus({
        backend: backendKind,
        mode,
        playing,
        automation: startup.automation,
        tick,
        triangles: triangleCount,
      });
    },
    get adapter() {
      return adapterInfo;
    },
    loadGame,
    setComponent: (id: string, component: string, value: ComponentData) =>
      facade.setComponent(id, component, value),
    worldTransforms: () => {
      scene.updateMatrixWorld(true);
      return Object.fromEntries(
        [...gameObjects].map(([id, object]) => [
          id,
          object.getWorldPosition(new THREE.Vector3()).toArray(),
        ]),
      );
    },
    geometryProbe: (id: "morph" | "skin", value: number) => {
      if (id === "morph") morphMesh.morphTargetInfluences![0] = value;
      else tip.rotation.z = value;
      const object = id === "morph" ? morphMesh : skinned;
      scene.updateMatrixWorld(true);
      if (object instanceof THREE.SkinnedMesh) object.skeleton.update();
      const vertices = [];
      for (let i = 0; i < object.geometry.getAttribute("position").count; i++)
        vertices.push(
          object
            .getVertexPosition(i, new THREE.Vector3())
            .applyMatrix4(object.matrixWorld)
            .toArray(),
        );
      updateTraceGeometry();
      return { vertices, hash: lastGeometryHash };
    },
    cameraDirection: () => cameraFrame(),
    command: async (input: unknown) => {
      const taskId = `runtime-${Date.now()}`;
      try {
        const command = parseCommand(input);
        await nativeInputTail;
        await tickTail;
        if (command.type !== "inspect") requireRuntime();
        let data: unknown;
        switch (command.type) {
          case "inspect":
            data = inspect(command);
            break;
          case "capture":
            throw new Error(
              "TC_CONTROL_TOOL_ONLY: Use capture --live through development bridge.",
            );
          case "step":
            data = await api.step(command.count);
            break;
          case "pause":
            api.pause();
            data = inspect();
            break;
          case "resume":
            api.play();
            data = inspect();
            break;
          case "snapshot":
            data = api.snapshot();
            break;
          case "recordStart":
            requireRuntime().startRecording();
            data = inspect();
            break;
          case "recordStop":
            data = requireRuntime().stopRecording();
            break;
          case "recordCancel":
            requireRuntime().cancelRecording();
            data = inspect();
            break;
          case "replay": {
            const host = requireRuntime();
            restoring = true;
            try {
              const replay = await host.replayAsync(command.trace);
              tick = host.inspect().scheduler.tick;
              if (replay.status !== "passed") {
                const error = new Error(
                  `TC_REPLAY_DIVERGENCE: ${replay.fault?.message ?? "Replay did not complete."}`,
                );
                reportFailure(error);
                throw error;
              }
              data = replay;
              syncRuntime();
              await draw();
            } finally { restoring = false; gamepadFingerprint = undefined; }
            break;
          }
          case "restore":
            data = await api.restore(command.snapshot);
            break;
          case "input":
            requireRuntime().input(command.key, command.pressed);
            data = inspect();
            break;
          case "setComponent":
            requireRuntime().facade.setComponent(
              command.entity,
              command.component,
              command.value as ComponentData,
            );
            syncRuntime();
            await draw();
            data = inspect();
            break;
          case "mode":
            data = await api.mode(command.mode);
            break;
        }
        if (data === undefined)
          throw new Error(
            "TC_CONTROL_NO_RESULT: Command did not produce a result.",
          );
        return protocolResult(taskId, "succeeded", data);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes("TC_GPU_TIMEOUT")) reportFailure(error);
        return protocolResult(taskId, "failed", null, [
          {
            code: message.match(/TC_[A-Z0-9_]+/)?.[0] ?? "TC_CONTROL_FAILURE",
            severity: "error",
            message,
            remediation:
              "Inspect the runtime state and correct the command or source before retrying.",
          },
        ]);
      }
    },
  };
  if (import.meta.env.DEV)
    (window as unknown as { __pelican: typeof api }).__pelican = api;
  async function loop(now: number) {
    if (disposed) return;
    try {
      if (
        playing &&
        !terminalFault &&
        !loadingContent &&
        !restoring &&
        !recoveringGpu
      ) {
        await pollGameplayGamepad();
        const elapsed =
          lastFrameTime === undefined ? 0 : (now - lastFrameTime) / 1000;
        lastFrameTime = now;
        frameAccumulator += Math.max(0, elapsed);
        let steps = 0;
        while (frameAccumulator >= 1 / 60 && steps < 8) {
          await stepRuntime();
          frameAccumulator -= 1 / 60;
          await processGameRequests();
          steps++;
        }
        if (steps) syncSimulation();
        await draw(false, steps > 0);
      } else {
        lastFrameTime = undefined;
      }
    } catch (error) {
      if (!terminalFault) reportFailure(error);
    }
    if (!disposed) frameRequest = requestAnimationFrame(loop);
  }
  frameRequest = requestAnimationFrame(loop);
  playing = startup.playing;
  document.documentElement.dataset.pelicanReady = "true";
  status.textContent = runtimeStatus({
    backend: backendKind,
    mode,
    playing,
    automation: startup.automation,
    tick,
    triangles: triangleCount,
  });
}
boot().catch((error) => {
  reportFailure(error);
  if (import.meta.env.DEV)
    (window as unknown as { __pelicanFailure: string }).__pelicanFailure =
      String(error);
  void disposeBrowser();
});
