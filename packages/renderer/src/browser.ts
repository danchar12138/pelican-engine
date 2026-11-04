import * as THREE from "three/webgpu";
import { prepareGameplay, type GameplayContent } from "./gameplay.ts";
import type { HostSnapshot } from "../../runtime/src/host.ts";
import { GPUTracer } from "./pathtrace.ts";
import { buildBVH, extractTriangles } from "./geometry.ts";
import { graphToTSL, evaluateGraph, runComputeGraph } from "./graph.ts";
import { uniform } from "three/tsl";
import { startupPolicy, boundedOperation, runtimeStatus } from "./startup.ts";
import { SDK_VERSION } from "../../sdk/src/index.ts";
import type { SceneIR } from "../../compiler/src/types.ts";
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
const camera = new THREE.PerspectiveCamera(48, width / height, 0.05, 100);
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
const gameObjects = new Map<string, THREE.Object3D>();
const gameRoot = new THREE.Group();
scene.add(gameRoot);
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
}[] = [];
const graphTime = uniform(0);
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
  playing = false;
  terminalFault = true;
  lastFrameTime = undefined;
  const message = String(error);
  errors.push(message);
  if (document.documentElement) {
    document.documentElement.dataset.threecatReady = "false";
    document.documentElement.dataset.threecatFailure = message;
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
  if (loadingContent || restoring)
    throw new Error(
      "TC_CONTENT_BUSY: Wait for the current content transaction.",
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
  root.traverse((object) => {
    if (object instanceof THREE.Mesh) {
      geometries.add(object.geometry);
      if (releaseMaterials)
        for (const material of Array.isArray(object.material)
          ? object.material
          : [object.material])
          materials.add(material);
    }
    if (object instanceof THREE.SkinnedMesh) object.skeleton.dispose();
    if (object instanceof THREE.Light && "shadow" in object)
      (object.shadow as THREE.LightShadow | undefined)?.dispose();
  });
  for (const geometry of geometries) geometry.dispose();
  for (const material of materials) material.dispose();
  (root.userData.lightTarget as THREE.Object3D | undefined)?.removeFromParent();
  root.removeFromParent();
  root.clear();
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
          )
        : new THREE.DirectionalLight(
            entity.light.color ?? "#ffffff",
            entity.light.intensity ?? 1,
          );
    light.castShadow = entity.light.castShadow ?? false;
    if (light instanceof THREE.DirectionalLight) {
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
    const mesh = new THREE.Mesh(geometry, material);
    mesh.castShadow = entity.mesh.castShadow;
    mesh.receiveShadow = entity.mesh.receiveShadow;
    node.add(mesh);
  }
  return node;
}
function syncRuntime() {
  if (!runtime) return;
  transforms.clear();
  componentState.clear();
  const records = runtime.world.records();
  const live = new Set(records.map((record) => record.id));
  const modelRecords = compiledIR
    ? records.filter(
        (record) => resolveEntityDefinition(compiledIR!, record)?.model,
      )
    : [];
  for (const record of modelRecords)
    gameplay?.models.register(
      record.id,
      resolveEntityDefinition(compiledIR!, record)!.model!,
    );
  gameplay?.models.reconcile(modelRecords.map((record) => record.id));
  // Detach surviving descendants before disposing a removed parent's owned visual subtree.
  const removed = new Set(
    [...gameObjects]
      .filter(([id]) => !live.has(id))
      .map(([, object]) => object),
  );
  for (const [id, object] of gameObjects)
    if (live.has(id)) {
      for (let parent = object.parent; parent; parent = parent.parent)
        if (removed.has(parent)) {
          gameRoot.add(object);
          break;
        }
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
    if (object && object.userData.threecatPrefab !== record.prefab) {
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
      object.userData.threecatPrefab = record.prefab;
      gameRoot.add(object);
      if (object.userData.lightTarget)
        gameRoot.add(object.userData.lightTarget);
      gameObjects.set(record.id, object);
    }
    if (modelRecords.some((model) => model.id === record.id))
      gameplay?.models.attach(record.id, object);
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
  format: "threecat.save";
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
  let candidate: RuntimeHost | undefined;
  let candidateGame: { update(dt: number): void; dispose(): void } | undefined;
  let attached = false;
  let committed = false;
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
    if (!ir || ir.format !== "threecat.scene" || ir.version !== 1)
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
      (saved.format !== "threecat.save" ||
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
    if (
      ir.input ||
      ir.ui ||
      ir.sounds ||
      ir.scene.follow ||
      ir.scene.environment.lighting === "studio" ||
      [...ir.scene.entities, ...ir.prefabs].some(
        (entity) => entity.model || entity.rigidBody || entity.character,
      ) ||
      ir.materials.some((material) => material.texture)
    )
      nextGameplay = await prepareGameplay(
        ir,
        new URL(import.meta.env.BASE_URL + "generated/", document.baseURI).href,
        renderer,
      );
    candidate = new RuntimeHost(ir, { plugins: nextGameplay?.plugins });
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
      const material = new THREE.MeshStandardNodeMaterial({
        color: definition.color,
        roughness: definition.roughness,
        metalness: definition.metalness,
      });
      if (definition.texture)
        material.map = nextGameplay!.textures.get(definition.texture)!;
      nextMaterials.set(definition.id, material);
      if (definition.graph) {
        material.colorNode = graphToTSL(definition.graph, graphTime);
        nextGraphs.push({ material, graph: definition.graph });
      }
    }
    for (const entity of ir.scene.entities) {
      const node = createEntityView(entity, nextMaterials);
      node.userData.threecatPrefab = entity.prefab;
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
    if (saved) {
      if (loadSlot)
        nextGameplay?.services.adoptStorageRequest("load", loadSlot);
      candidate.restore(saved.runtime);
    }
    if (disposed) throw new Error("TC_BROWSER_DISPOSED");
    // No await in commit: a complete host/view/scope replaces the previous content together.
    const previous = runtime,
      previousScope = contentScope,
      previousMaterials = gameMaterials,
      previousGameplay = gameplay;
    const previousRoot = new THREE.Group();
    if (gameRoot.children.length) previousRoot.add(...gameRoot.children);
    compiledIR = ir;
    runtime = candidate;
    gameplay = nextGameplay;
    contentScope = nextScope;
    gameMaterials = nextMaterials;
    committed = true;
    if (nextRoot.children.length) gameRoot.add(...nextRoot.children);
    gameObjects.clear();
    for (const [id, node] of nextObjects) gameObjects.set(id, node);
    materialGraphs.splice(0, materialGraphs.length, ...nextGraphs);
    authoredCamera = nextCamera;
    scene.background = nextBackground;
    scene.environment = nextGameplay?.environment ?? null;
    camera.fov = ir.scene.camera.fov;
    camera.near = ir.scene.camera.near;
    camera.far = ir.scene.camera.far;
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
    try {
      previous?.dispose();
    } catch (error) {
      errors.push(`TC_CONTENT_CLEANUP: ${String(error)}`);
    }
    await previousGameplay?.dispose();
    releaseObject(previousRoot);
    for (const material of previousMaterials.values()) material.dispose();
    await previousScope?.release();
    return ir;
  } catch (error) {
    if (!committed) {
      try {
        if (attached) candidate?.dispose();
        else {
          try {
            candidateGame?.dispose();
          } finally {
            candidate?.dispose();
          }
        }
      } catch (cleanupError) {
        errors.push(`TC_CONTENT_CLEANUP: ${String(cleanupError)}`);
      }
      await nextGameplay?.dispose();
      releaseObject(nextRoot);
      for (const material of nextMaterials.values()) material.dispose();
      await nextScope?.release();
    }
    throw error;
  } finally {
    loadingContent = false;
  }
}
/** Only completed fixed ticks may request browser persistence or scene transactions. */
async function processGameRequests() {
  if (!gameplay || !compiledIR || !runtime) return;
  const requests = gameplay.services.takeRequests();
  for (const request of requests) {
    if (request.type === "scene") {
      await loadGame(request.id);
      continue;
    }
    const slot = request.id;
    const key = "threecat:" + compiledIR.gameId + ":" + slot;
    try {
      if (request.type === "save") {
        syncRuntime();
        const saved: GameSave = {
          format: "threecat.save",
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
    const value = evaluateGraph(item.graph!, time);
    item.material.color.fromArray(
      typeof value === "number" ? [value, value, value] : value,
    );
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
  if (!gameplay?.services.inspect().camera) {
    camera.position.copy(target).add(offset);
    camera.lookAt(target);
  }
  camera.updateMatrixWorld();
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
  const color = new THREE.Color(definition?.color ?? 0xffdfb0);
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
      intensity: definition?.intensity ?? 55,
      directional: definition?.kind === "directional",
    },
    environment: (scene.background as THREE.Color).toArray(),
    ambient: compiledIR?.scene.environment.ambientIntensity ?? 1,
  };
}
async function draw(accumulate = false, changed = true) {
  if (disposed) throw new Error("TC_BROWSER_DISPOSED");
  const start = performance.now();
  syncRuntime();
  animate();
  if (changed) {
    if (gameplay && mode === "raster") {
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
  if (mode !== "path") renderer.render(scene, camera);
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
  status.hidden = Boolean(gameplay);
  status.textContent = runtimeStatus({
    mode,
    playing,
    automation: startup.automation,
    tick,
    triangles: triangleCount,
    faulted: terminalFault,
  });
}
function applyInput(key: string) {
  if (!probeEnabled) {
    const host = requireRuntime();
    host.input(key, true);
    if (!playing) stepRuntime();
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
    inputLog.push({ tick, key: event.key });
    applyInput(event.key);
    void draw(false, true).catch(reportFailure);
  } catch (error) {
    reportFailure(error);
  }
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
  try {
    requireRuntime().input(event.key, false);
  } catch (error) {
    reportFailure(error);
  }
}
window.addEventListener("keydown", onKeyDown);
window.addEventListener("keyup", onKeyUp);
function stepRuntime() {
  const started = performance.now();
  const host = requireRuntime();
  if (terminalFault)
    throw new Error(
      "TC_BROWSER_FAULTED: Restore a valid checkpoint or reload content before stepping.",
    );
  try {
    host.step(1);
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
  if (next !== "raster" && gameplay)
    throw new Error(
      "TC_TRACE_STAGE: Textured GLB game rendering currently requires raster; full material path tracing is planned for M3.",
    );
  mode = next;
  rasterCanvas.style.display = next === "path" ? "none" : "block";
  traceCanvas.style.display = next === "raster" ? "none" : "block";
  traceCanvas.style.opacity = next === "hybrid" ? "0.35" : "1";
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
    ready: !disposed && !terminalFault,
    playback: {
      playing,
      automation: startup.automation,
      state: terminalFault ? "faulted" : playing ? "running" : "paused",
    },
    backend: "WebGPUBackend",
    adapter: adapterInfo,
    mode,
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
      tracer: "software-triangle-BVH",
      hardwareRT: false,
      denoiser: false,
      hybrid: "raster + traced image compositing prototype",
      pathBounces: 5,
      tracedLights:
        "first authored light only; raster also contains private probe lights",
      textures: gameplay
        ? "GLB PBR and base-color textures in raster"
        : "no authored texture assets",
      experimentalProbes:
        "Four small CPU simulations and finite world probe are M0 debug sidecars, not M1 production modules",
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
  document.documentElement.dataset.threecatReady = "false";
  window.removeEventListener("keydown", onKeyDown);
  window.removeEventListener("keyup", onKeyUp);
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
  clean(() => gameplay?.dispose());
  clean(() => simulation?.dispose());
  clean(() => world?.dispose());
  clean(() => resourceManager.dispose());
  clean(() => releaseObject(scene, true, gameMaterials.values()));
  clean(() => tracer?.dispose());
  clean(() => renderer?.dispose());
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
async function boot() {
  if (!navigator.gpu)
    throw new Error("TC_GPU_UNAVAILABLE: WebGPU API is not available");
  const adapter = await boundedOperation(
    navigator.gpu.requestAdapter({
      powerPreference: "high-performance",
    }),
    "requestAdapter",
  );
  if (!adapter) throw new Error("TC_GPU_ADAPTER_UNAVAILABLE");
  if (adapter.info.isFallbackAdapter)
    throw new Error("TC_GPU_SOFTWARE_ADAPTER");
  adapterInfo = {
    vendor: adapter.info.vendor,
    architecture: adapter.info.architecture,
    isFallbackAdapter: adapter.info.isFallbackAdapter,
    features: [...adapter.features],
  };
  device = await boundedOperation(
    adapter
      .requestDevice({
        requiredFeatures: adapter.features.has("timestamp-query")
          ? ["timestamp-query"]
          : [],
      })
      .then((candidate) => {
        if (disposed) candidate.destroy();
        return candidate;
      }),
    "requestDevice",
  );
  if (disposed) {
    device.destroy();
    return;
  }
  device.addEventListener("uncapturederror", (event) =>
    errors.push(event.error.message),
  );
  device.lost.then((info) => {
    if (disposed) return;
    reportFailure(
      new Error(`TC_GPU_DEVICE_LOST:${info.reason}: ${info.message}`),
    );
    void disposeBrowser();
  });
  const backend = new THREE.WebGPUBackend({ device, canvas: rasterCanvas });
  renderer = new THREE.Renderer(backend, { antialias: true });
  renderer.library = new THREE.StandardNodeLibrary();
  renderer.setPixelRatio(1);
  renderer.setSize(width, height);
  renderer.shadowMap.enabled = true;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  await boundedOperation(renderer.init(), "renderer initialization");
  if (disposed) return;
  if (!(renderer.backend as THREE.WebGPUBackend).isWebGPUBackend)
    throw new Error("TC_GPU_WRONG_BACKEND");
  status.textContent = "GPU tracer";
  tracer = new GPUTracer(device, traceCanvas, width, height);
  status.textContent = "Loading compiled game";
  await boundedOperation(loadGame(), "compiled content initialization");
  status.textContent = "Drawing compiled game";
  setMode("raster");
  await draw();
  const api = {
    inspect,
    mode: async (next: typeof mode) => {
      requireRuntime();
      setMode(next);
      await draw(false, true);
      await boundedOperation(
        device.queue.onSubmittedWorkDone(),
        "GPU submission",
      );
      return inspect();
    },
    step: async (count = 1) => {
      requireRuntime();
      if (!Number.isInteger(count) || count < 1 || count > 10000)
        throw new Error("TC_PROTOCOL_STEPS: count must be in [1,10000].");
      for (let i = 0; i < count; i++) {
        stepRuntime();
        await processGameRequests();
        syncSimulation();
        await draw(false, true);
      }
      await boundedOperation(
        device.queue.onSubmittedWorkDone(),
        "GPU submission",
      );
      return inspect();
    },
    camera: async (phase: number) => {
      cameraPhase = phase;
      await draw(false, false);
      await boundedOperation(
        device.queue.onSubmittedWorkDone(),
        "GPU submission",
      );
      return inspect();
    },
    accumulate: async (count = 16) => {
      for (let i = 0; i < count; i++) await draw(i > 0, false);
      await boundedOperation(
        device.queue.onSubmittedWorkDone(),
        "GPU submission",
      );
      return tracer.pixelStats();
    },
    pixels: () => tracer.pixelStats(),
    gpuTimeMs: () => tracer.gpuTimeMs(),
    ray: (origin: number[], direction: number[]) =>
      tracer.queryRay(origin, direction),
    compute: async (id: string, time: number) => {
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
      await boundedOperation(
        device.queue.onSubmittedWorkDone(),
        "GPU submission",
      );
      return inspect();
    },
    snapshot: () => {
      const host = requireRuntime();
      syncRuntime();
      return structuredClone({
        format: "threecat.browser",
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
      }
      await draw();
      await boundedOperation(
        device.queue.onSubmittedWorkDone(),
        "GPU submission",
      );
      return inspect();
    },
    worldLoad: async () => {
      world?.dispose();
      world = createWorldProbe({ chunkSize: 2, cellsPerChunk: 4 });
      await Promise.all([world.loadChunk([0, 0]), world.loadChunk([1, 0])]);
      syncWorld();
      await draw();
      await boundedOperation(
        device.queue.onSubmittedWorkDone(),
        "GPU submission",
      );
      return inspect();
    },
    worldEdit: async () => {
      if (!world) throw new Error("TC_WORLD_NOT_LOADED");
      await world.applyEdits([{ chunk: [0, 0], x: 2, z: 2, height: 1.8 }]);
      syncWorld();
      await draw();
      await boundedOperation(
        device.queue.onSubmittedWorkDone(),
        "GPU submission",
      );
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
      await boundedOperation(
        device.queue.onSubmittedWorkDone(),
        "GPU submission",
      );
      return inspect();
    },
    worldReload: async () => {
      await world?.loadChunk([0, 0]);
      syncWorld();
      await draw();
      await boundedOperation(
        device.queue.onSubmittedWorkDone(),
        "GPU submission",
      );
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
      await boundedOperation(
        device.queue.onSubmittedWorkDone(),
        "GPU submission",
      );
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
        mode,
        playing,
        automation: startup.automation,
        tick,
        triangles: triangleCount,
      });
    },
    adapter: {
      vendor: adapter.info.vendor,
      architecture: adapter.info.architecture,
      isFallbackAdapter: adapter.info.isFallbackAdapter,
      features: [...adapter.features],
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
            const replay = host.replay(command.trace);
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
    (window as unknown as { __threecat: typeof api }).__threecat = api;
  async function loop(now: number) {
    if (disposed) return;
    try {
      if (playing && !terminalFault && !loadingContent && !restoring) {
        const elapsed =
          lastFrameTime === undefined ? 0 : (now - lastFrameTime) / 1000;
        lastFrameTime = now;
        frameAccumulator += Math.max(0, elapsed);
        let steps = 0;
        while (frameAccumulator >= 1 / 60 && steps < 8) {
          stepRuntime();
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
  document.documentElement.dataset.threecatReady = "true";
  status.textContent = runtimeStatus({
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
    (window as unknown as { __threecatFailure: string }).__threecatFailure =
      String(error);
  void disposeBrowser();
});
