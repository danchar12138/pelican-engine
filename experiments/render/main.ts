import * as THREE from "three/webgpu";
import { GPUTracer } from "./pathtrace.ts";
import { buildBVH, extractTriangles } from "./geometry.ts";
import { graphToTSL, evaluateGraph, runComputeGraph } from "./graph.ts";
import { uniform } from "three/tsl";
import type { SceneIR } from "../compiler/types.ts";
import type {
  EngineFacade,
  Transform,
  ComponentData,
} from "../../packages/sdk/src/index.ts";
import { createSimulation } from "../simulation/index.ts";
import type {
  Simulation,
  SimulationKind,
  SimulationSnapshot,
} from "../simulation/types.ts";
import { createWorldProbe } from "../world/index.ts";
import type { WorldProbe } from "../world/types.ts";

const width = Number(new URLSearchParams(location.search).get("width") ?? 960);
const height = Number(
  new URLSearchParams(location.search).get("height") ?? 540,
);
const status = document.querySelector("#status")!;
const errors: string[] = [];
let mode: "raster" | "hybrid" | "path" = "raster";
let tick = 0,
  playing = false,
  cameraPhase = 0,
  bvhMs = 0,
  uploadMs = 0,
  submitMs = 0;
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
}[] = [];
const scene = new THREE.Scene();
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
scene.add(ground);
const back = new THREE.Mesh(
  new THREE.BoxGeometry(14, 5, 0.15),
  standard(0x243b50),
);
back.position.set(0, 2.2, -4);
scene.add(back);
const box = new THREE.Mesh(
  new THREE.BoxGeometry(1, 1, 1),
  standard(0xe5923f, 0.25),
);
box.position.set(-1.6, 0.5, 0);
box.castShadow = true;
scene.add(box);
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
scene.add(morphMesh);
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
scene.add(skinned);
const lamp = new THREE.PointLight(0xffdfb0, 100, 30, 2);
lamp.position.set(-3, 6, 3);
lamp.castShadow = true;
lamp.shadow.mapSize.set(1024, 1024);
scene.add(lamp, new THREE.HemisphereLight(0xa4c8f0, 0x26321d, 1));

let renderer: THREE.Renderer, tracer: GPUTracer, device: GPUDevice;
let game: { update?: (dt: number) => void; dispose?: () => void } | undefined;
const gameObjects = new Map<string, THREE.Object3D>();
const gameRoot = new THREE.Group();
scene.add(gameRoot);
let authoredCamera = { position: [0, 3.4, 7], target: [0, 0.9, 0] };
let authoredLights: {
  definition: SceneIR["scene"]["entities"][number]["light"];
  object: THREE.Object3D;
}[] = [];
let compiledIR: SceneIR | null = null;
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
    const value = transforms.get(id);
    if (!value) throw new Error(`TC_ENTITY_MISSING:${id}`);
    return structuredClone(value);
  },
  setTransform(id, patch) {
    const value = transforms.get(id);
    if (!value) throw new Error(`TC_ENTITY_MISSING:${id}`);
    const next = { ...value, ...patch };
    transforms.set(id, structuredClone(next));
    const object = gameObjects.get(id);
    if (object) {
      object.position.fromArray(next.position);
      object.rotation.set(...next.rotation);
      object.scale.fromArray(next.scale);
    }
  },
  getComponent(id: string, component: any): any {
    const value = componentState.get(id)?.[componentsId(component)];
    if (!value) throw new Error(`TC_COMPONENT_MISSING:${id}`);
    return structuredClone(value);
  },
  setComponent(id: string, component: any, value: any) {
    const state = componentState.get(id);
    if (!state?.[componentsId(component)])
      throw new Error(`TC_COMPONENT_MISSING:${id}`);
    state[componentsId(component)] = {
      ...state[componentsId(component)],
      ...structuredClone(value),
    };
  },
  query(component) {
    return [...componentState]
      .filter(([, data]) => componentsId(component) in data)
      .map(([id]) => id);
  },
};
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
async function loadGame() {
  const response = await fetch(
    `${import.meta.env.BASE_URL}generated/scene.ir.json`,
  );
  if (!response.ok)
    throw new Error(`TC_COMPILED_SCENE_MISSING: ${response.status}`);
  const ir = (await response.json()) as SceneIR;
  if (ir.format !== "threecat.scene" || ir.version !== 1)
    throw new Error("TC_IR_VERSION");
  compiledIR = ir;
  game?.dispose?.();
  const disposedMaterials = new Set<THREE.Material>();
  gameRoot.traverse((object) => {
    if (object instanceof THREE.Mesh) {
      object.geometry.dispose();
      const material = object.material as THREE.Material;
      if (!disposedMaterials.has(material)) {
        material.dispose();
        disposedMaterials.add(material);
      }
    }
  });
  gameRoot.clear();
  gameObjects.clear();
  transforms.clear();
  componentState.clear();
  materialGraphs.length = 0;
  authoredLights = [];
  authoredCamera = {
    position: [...ir.scene.camera.position],
    target: [...ir.scene.camera.target],
  };
  camera.fov = ir.scene.camera.fov;
  camera.near = ir.scene.camera.near;
  camera.far = ir.scene.camera.far;
  camera.updateProjectionMatrix();
  scene.background = new THREE.Color(ir.scene.environment.background);
  const ambient = new THREE.HemisphereLight(
    0xa4c8f0,
    0x26321d,
    ir.scene.environment.ambientIntensity,
  );
  gameRoot.add(ambient);
  const materials = new Map<string, THREE.MeshStandardNodeMaterial>();
  for (const definition of ir.materials) {
    if (definition.texture)
      throw new Error(
        "TC_M0_TEXTURE_UNSUPPORTED: Texture import is compiled, but this M0 render adapter does not yet display textures.",
      );
    const material = new THREE.MeshStandardNodeMaterial({
      color: definition.color,
      roughness: definition.roughness,
      metalness: definition.metalness,
    });
    if (definition.graph) {
      material.colorNode = graphToTSL(definition.graph, graphTime);
      materialGraphs.push({ material, graph: definition.graph });
    }
    materials.set(definition.id, material);
  }
  for (const entity of ir.scene.entities) {
    const node = new THREE.Group();
    node.name = entity.id;
    node.position.fromArray(entity.transform.position);
    node.rotation.set(...entity.transform.rotation);
    node.scale.fromArray(entity.transform.scale);
    gameRoot.add(node);
    gameObjects.set(entity.id, node);
    componentState.set(
      entity.id,
      structuredClone(entity.components) as Record<string, ComponentData>,
    );
    transforms.set(entity.id, structuredClone(entity.transform));
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
      node.add(light);
      authoredLights.push({ definition: entity.light, object: light });
    }
    if (entity.mesh) {
      const g = entity.mesh.geometry;
      const geometry =
        g.kind === "box"
          ? new THREE.BoxGeometry(...(g.size ?? [1, 1, 1]))
          : g.kind === "sphere"
            ? new THREE.SphereGeometry(g.radius ?? 0.5, g.segments ?? 12, 8)
            : new THREE.PlaneGeometry(...(g.size ?? [1, 1]));
      const mesh = new THREE.Mesh(
        geometry,
        materials.get(entity.mesh.material)!,
      );
      mesh.castShadow = entity.mesh.castShadow;
      mesh.receiveShadow = entity.mesh.receiveShadow;
      node.add(mesh);
    }
  }
  for (const entity of ir.scene.entities)
    if (entity.parent)
      gameObjects.get(entity.parent)!.add(gameObjects.get(entity.id)!);
  const gameURL = new URL(
    `${import.meta.env.BASE_URL}generated/game.js`,
    document.baseURI,
  );
  gameURL.searchParams.set("v", String(Date.now()));
  const module = await import(/* @vite-ignore */ gameURL.href);
  game = module.createGame(facade);
  return ir;
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
  camera.position.copy(target).add(offset);
  camera.lookAt(target);
  camera.updateMatrixWorld();
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
  const start = performance.now();
  animate();
  if (changed) updateTraceGeometry();
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
  });
  if (metrics.length > 2000) metrics.shift();
  status.textContent = `threecat M0 · ${mode}\nWebGPU · ${triangleCount} triangles · tick ${tick}\n${mode === "hybrid" ? "prototype raster + 35% ray-traced compositing" : ""}`;
}
function applyInput(key: string) {
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
window.addEventListener("keydown", (event) => {
  inputLog.push({ tick, key: event.key });
  applyInput(event.key);
  void draw(false, true);
});
function setMode(next: typeof mode) {
  mode = next;
  rasterCanvas.style.display = next === "path" ? "none" : "block";
  traceCanvas.style.display = next === "raster" ? "none" : "block";
  traceCanvas.style.opacity = next === "hybrid" ? "0.35" : "1";
}
function inspect() {
  return {
    ready: true,
    backend: "WebGPUBackend",
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
    compiledIR,
    game: {
      transforms: Object.fromEntries(transforms),
      components: Object.fromEntries(componentState),
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
      textures: "unsupported in M0 render adapter",
    },
  };
}
async function boot() {
  if (!navigator.gpu)
    throw new Error("TC_GPU_UNAVAILABLE: WebGPU API is not available");
  const adapter = await navigator.gpu.requestAdapter({
    powerPreference: "high-performance",
  });
  if (!adapter) throw new Error("TC_GPU_ADAPTER_UNAVAILABLE");
  if (adapter.info.isFallbackAdapter)
    throw new Error("TC_GPU_SOFTWARE_ADAPTER");
  device = await adapter.requestDevice({
    requiredFeatures: adapter.features.has("timestamp-query")
      ? ["timestamp-query"]
      : [],
  });
  device.addEventListener("uncapturederror", (event) =>
    errors.push(event.error.message),
  );
  device.lost.then((info) => {
    errors.push(`TC_GPU_DEVICE_LOST:${info.reason}`);
    playing = false;
  });
  const backend = new THREE.WebGPUBackend({ device, canvas: rasterCanvas });
  renderer = new THREE.Renderer(backend, { antialias: true });
  renderer.library = new THREE.StandardNodeLibrary();
  renderer.setPixelRatio(1);
  renderer.setSize(width, height);
  renderer.shadowMap.enabled = true;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  await renderer.init();
  if (!(renderer.backend as THREE.WebGPUBackend).isWebGPUBackend)
    throw new Error("TC_GPU_WRONG_BACKEND");
  status.textContent = "GPU tracer";
  tracer = new GPUTracer(device, traceCanvas, width, height);
  status.textContent = "Loading compiled game";
  await loadGame();
  status.textContent = "Drawing compiled game";
  setMode("raster");
  await draw();
  status.textContent = "Waiting GPU";
  await device.queue.onSubmittedWorkDone();
  const api = {
    inspect,
    mode: async (next: typeof mode) => {
      setMode(next);
      await draw(false, true);
      await device.queue.onSubmittedWorkDone();
      return inspect();
    },
    step: async (count = 1) => {
      for (let i = 0; i < count; i++) {
        tick++;
        game?.update?.(1 / 60);
        simulation?.step();
        syncSimulation();
        await draw(false, true);
      }
      await device.queue.onSubmittedWorkDone();
      return inspect();
    },
    camera: async (phase: number) => {
      cameraPhase = phase;
      await draw(false, false);
      await device.queue.onSubmittedWorkDone();
      return inspect();
    },
    accumulate: async (count = 16) => {
      for (let i = 0; i < count; i++) await draw(i > 0, false);
      await device.queue.onSubmittedWorkDone();
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
      await device.queue.onSubmittedWorkDone();
      return inspect();
    },
    snapshot: () =>
      structuredClone({
        tick,
        cameraPhase,
        transforms: Object.fromEntries(transforms),
        components: Object.fromEntries(componentState),
        inputLog,
        simulation: simulation?.snapshot(),
        world: world?.snapshot(),
        topology: topologyObjects.map((object) => object.position.toArray()),
      }),
    restore: async (saved: any) => {
      tick = saved.tick;
      cameraPhase = saved.cameraPhase;
      for (const [id, t] of Object.entries(saved.transforms))
        facade.setTransform(id, t as Transform);
      componentState.clear();
      for (const [id, c] of Object.entries(saved.components))
        componentState.set(
          id,
          structuredClone(c) as Record<string, ComponentData>,
        );
      if (saved.simulation) {
        if (!simulation || simulation.kind !== saved.simulation.kind)
          simulation = createSimulation(saved.simulation.kind);
        simulation.restore(saved.simulation as SimulationSnapshot);
      } else {
        simulation?.dispose();
        simulation = undefined;
      }
      inputLog.length = 0;
      inputLog.push(...(saved.inputLog ?? []));
      syncSimulation();
      if (saved.world) {
        world?.dispose();
        world = createWorldProbe(saved.world.config);
        await world.restore(saved.world);
      } else {
        world?.dispose();
        world = undefined;
      }
      syncWorld();
      for (const object of topologyObjects) {
        object.removeFromParent();
        object.geometry.dispose();
        (object.material as THREE.Material).dispose();
      }
      topologyObjects.length = 0;
      for (const position of saved.topology ?? []) {
        const mesh = new THREE.Mesh(
          new THREE.IcosahedronGeometry(0.35, 0),
          standard(0x98dd66),
        );
        mesh.position.fromArray(position);
        scene.add(mesh);
        topologyObjects.push(mesh);
      }
      await draw();
      await device.queue.onSubmittedWorkDone();
      return inspect();
    },
    worldLoad: async () => {
      world?.dispose();
      world = createWorldProbe({ chunkSize: 2, cellsPerChunk: 4 });
      await Promise.all([world.loadChunk([0, 0]), world.loadChunk([1, 0])]);
      syncWorld();
      await draw();
      await device.queue.onSubmittedWorkDone();
      return inspect();
    },
    worldEdit: async () => {
      if (!world) throw new Error("TC_WORLD_NOT_LOADED");
      await world.applyEdits([{ chunk: [0, 0], x: 2, z: 2, height: 1.8 }]);
      syncWorld();
      await draw();
      await device.queue.onSubmittedWorkDone();
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
      await device.queue.onSubmittedWorkDone();
      return inspect();
    },
    worldReload: async () => {
      await world?.loadChunk([0, 0]);
      syncWorld();
      await draw();
      await device.queue.onSubmittedWorkDone();
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
      await device.queue.onSubmittedWorkDone();
      return inspect();
    },
    play: () => {
      playing = true;
    },
    pause: () => {
      playing = false;
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
  };
  if (import.meta.env.DEV)
    (window as unknown as { __threecat: typeof api }).__threecat = api;
  async function loop() {
    if (playing) {
      tick++;
      game?.update?.(1 / 60);
      simulation?.step();
      syncSimulation();
      await draw(false, true);
    }
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);
  document.documentElement.dataset.threecatReady = "true";
  status.textContent += "\nready";
  if (!import.meta.env.DEV) playing = true;
}
boot().catch((error) => {
  errors.push(String(error));
  status.textContent = String(error);
  if (import.meta.env.DEV)
    (window as unknown as { __threecatFailure: string }).__threecatFailure =
      String(error);
  console.error(error);
});
