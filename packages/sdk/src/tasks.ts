import type { EngineTask } from "./index.ts";
import { describeFeatures } from "./capabilities.ts";

// Task discovery only; exact signatures and feature boundaries remain source-derived.
const tasks: readonly EngineTask[] = [
  {
    id: "character-jump",
    title: "Move and jump a 3D character / 角色移动跳跃",
    aliases: [
      "jump",
      "jumping",
      "跳跃",
      "跳起来",
      "角色移动",
      "character movement",
    ],
    features: ["physics.rigid3d", "input.actions"],
    methods: [
      "PhysicsService.moveCharacter",
      "PhysicsService.grounded",
      "PhysicsService.setVelocity",
      "CharacterDefinition.jumpSpeed",
    ],
    recipes: ["third-person"],
    verify: [
      "Walk into a wall; jump only while grounded; land and jump again; hold jump without repeated airborne impulses.",
    ],
    limits: [
      "Character displacement is per fixed tick; velocity is units/second. Input bindings use KeyboardEvent.key, not KeyW.",
    ],
  },
  {
    id: "follow-camera",
    title: "Follow a character / 跟随相机",
    aliases: [
      "follow camera",
      "camera follow",
      "third person",
      "third-person",
      "跟随相机",
      "相机跟随",
      "第三人称",
    ],
    features: ["presentation.camera"],
    methods: [
      "CameraService.follow",
      "CameraService.setPose",
      "SceneInput.follow",
    ],
    recipes: ["third-person", "pointer-3d"],
    verify: ["Move, jump, save and load; inspect camera target and smoothing."],
    limits: [
      "Follow smoothing is not camera collision avoidance; implement occlusion using physics queries when needed.",
    ],
  },
  {
    id: "save-game",
    title: "Save and load a game / 保存游戏",
    aliases: [
      "save",
      "save game",
      "savegame",
      "load game",
      "保存游戏",
      "保存进度",
      "存档",
      "读档",
      "恢复进度",
    ],
    features: [
      "storage.save",
      "runtime.lifecycle",
      "runtime.composition",
      "state.json",
    ],
    methods: [
      "StorageService.save",
      "StorageService.load",
      "StorageService.status",
      "defineGameRuntime",
    ],
    recipes: ["third-person", "runtime-lifecycle", "gameplay-loop"],
    verify: [
      "Save, mutate world and instance state, load, check both restored; invalid saves must leave the old world intact.",
    ],
    limits: [
      "Browser storage is local to the origin; check failed status. External connections and arbitrary objects are not automatically saved.",
    ],
  },
  {
    id: "npm-component",
    title: "Compose ordinary npm modules / 接入 npm 组件",
    aliases: [
      "npm",
      "npm component",
      "npm组件",
      "接npm组件",
      "第三方",
      "third party",
      "依赖",
      "自定义扩展",
      "custom extension",
    ],
    features: [
      "content.libraries",
      "runtime.lifecycle",
      "runtime.composition",
      "runtime.adapters",
      "render.runtime",
    ],
    methods: [
      "defineGameRuntime",
      "GameRuntimeScope.own",
      "GameRuntimeScope.cleanup",
      "createRuntimeAdapter",
      "defineRenderExtension",
    ],
    recipes: [
      "npm-component",
      "runtime-lifecycle",
      "external-adapters",
      "managed-rendering",
    ],
    verify: [
      "Install recipe dependencies in the game; create two instances; dispose one without affecting the other; test save/load.",
    ],
    limits: [
      "Node-only libraries belong in build tools; browser-only imports belong in runtime.create/setup. Built-in gameplay services are optional.",
    ],
  },
  {
    id: "worker-transport",
    title: "Connect Worker or WebSocket / 外部消息适配",
    aliases: [
      "worker",
      "websocket",
      "transport",
      "网络",
      "外部消息",
      "消息队列",
    ],
    features: ["runtime.adapters", "runtime.transports"],
    methods: [
      "createWorkerAdapter",
      "createWebSocketAdapter",
      "RuntimeMessageAdapter.drain",
    ],
    recipes: ["external-adapters"],
    verify: [
      "Consume only on fixed ticks; test malformed data, overflow, disconnect, late messages and owned/borrowed cleanup.",
    ],
    limits: [
      "Not built-in netcode. External messages need an explicit record/resync protocol for deterministic replay.",
    ],
  },
  {
    id: "dynamic-resources",
    title: "Load dynamic data and update managed resources / 动态资源",
    aliases: [
      "dynamic resources",
      "dynamic assets",
      "动态资源",
      "动态数据",
      "fetch",
      "远程数据",
    ],
    features: [
      "runtime.dynamic-data",
      "runtime.adapters",
      "compute.managed",
      "render.bindings",
    ],
    methods: [
      "loadRuntimeJSON",
      "loadRuntimeBytes",
      "ComputeService.createBuffer",
      "ComputeService.writeBuffer",
      "ComputeService.createTexture",
      "RenderService.buffers",
    ],
    recipes: ["dynamic-texture", "dynamic-resources", "external-adapters"],
    verify: [
      "Test deadline/abort/size/validation failures; publish prepared data on a fixed tick; unbind before releasing resources.",
    ],
    limits: [
      "Bounded JSON/binary fetch and npm codecs can update managed resources, not full model streaming or arbitrary mesh topology replacement; CORS/CSP and decoded-size budgets still apply.",
    ],
  },
  {
    id: "realistic-rendering",
    title: "Realistic PBR and quality / 写实画质",
    aliases: [
      "quality",
      "realistic",
      "pbr",
      "aaa",
      "画质",
      "写实",
      "高模",
      "路径追踪",
    ],
    features: [
      "render.raster",
      "render.path",
      "render.material",
      "render.quality",
      "presentation.lights",
    ],
    methods: [
      "RenderService.configure",
      "RenderService.prepare",
      "RenderService.preparation",
      "renderQuality",
      "RenderService.capabilities",
      "MaterialInput",
      "LightDefinition",
    ],
    recipes: ["render-quality", "managed-rendering"],
    verify: [
      "Compare the same assets, camera, resolution and time/sample budget; inspect backend and capture unclipped materials and shadows.",
    ],
    limits: [
      "Default high is path with temporal/spatial filtering; medium is hybrid, low is raster. WebGL2 requires explicit low selection (renderQuality('low') or ?quality=low), never silent downgrade. Preparation is cached but not a frame-rate guarantee.",
    ],
  },
  {
    id: "stateful-iteration",
    title: "Iterate without losing compatible state / 保留状态迭代",
    aliases: ["hot reload", "hmr", "iteration", "迭代", "热更新", "保留状态"],
    features: ["runtime.lifecycle", "storage.save"],
    methods: ["defineGameRuntime", "GameRuntimeDefinition.version"],
    recipes: ["runtime-lifecycle"],
    verify: [
      "Change only system logic; confirm tick, entities and runtime state survive. Change a resource/schema and check an explicit restart requirement.",
    ],
    limits: [
      "Compatible logic changes use transactional content replacement; incompatible declarations are not silently migrated.",
    ],
  },
];
const normalize = (text: string) =>
  text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[._/-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
export function discoverTasks(goal = ""): EngineTask[] {
  const query = normalize(goal);
  // Keep every real feature discoverable from a task sentence without duplicating its vocabulary or API.
  const featureTasks: EngineTask[] = describeFeatures().map((feature) => ({
    id: feature.id,
    title: feature.description ?? feature.id,
    aliases: [...(feature.aliases ?? []), ...feature.symbols],
    features: [feature.id],
    methods: [...feature.symbols],
    recipes: [...feature.recipes],
    verify: [
      "Query the exact SDK contract and active backend, then run the behavior with game inputs/assets. Check diagnostics, save/restore and resource cleanup when applicable.",
    ],
    limits: [...feature.limits],
  }));
  const score = (task: EngineTask) =>
    Math.max(
      0,
      ...[task.id, ...task.aliases].map((alias) => {
        const word = normalize(alias);
        if (word === query) return 1000 + word.length;
        const found = /[\u3400-\u9fff]/.test(word)
          ? query.includes(word)
          : ` ${query.replace(/[^\p{L}\p{N} ]/gu, " ")} `.includes(` ${word} `);
        return found ? word.length : 0;
      }),
    );
  return [...tasks, ...featureTasks]
    .map((task, index) => ({
      task,
      score: score(task),
      curated: index < tasks.length,
    }))
    .filter((item) => !query || item.score > 0)
    .sort((a, b) => b.score - a.score || Number(b.curated) - Number(a.curated))
    .map(({ task }) => structuredClone(task));
}
