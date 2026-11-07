import type { SceneIR } from "../../compiler/src/types.ts";
import type { AnimationControlService, AnimationService, GamepadState, LocalizationVariables } from "../../sdk/src/index.ts";
import type {
  RuntimePlugin,
  RuntimePluginContext,
  RuntimePluginFactory,
  RuntimeServices,
} from "./plugins.ts";
import { cloneSerializable } from "./random.ts";
import { isUiColor } from "../../schema/src/ui-color.ts";
import { neutralGamepad, parseGamepad } from "./gamepad.ts";

type Camera = NonNullable<SceneIR["scene"]["follow"]>;
type UI = NonNullable<SceneIR["ui"]>;
type StorageState = ReturnType<RuntimeServices["storage"]["status"]>;
export interface GameServiceRequest {
  type: "save" | "load" | "scene";
  id: string;
}
export interface GameServicesInspection {
  input: { held: string[]; pressed: string[]; released: string[]; gamepadMode: "ui" | "game"; gamepadDeadzone: number; gamepad: GamepadState };
  camera: Camera | null;
  ui: SceneIR["ui"];
  audio: {
    volume: number;
    busVolumes?: { id: string; volume: number; fade?: { from: number; target: number; duration: number; startedAt: number } }[];
    voices: {
      id: string;
      sound: string;
      bus?: string;
      volume: number;
      loop: boolean;
      entity: string | null;
      startedAt: number;
      pausedAt?: number | null;
      pausedTicks?: number;
      priority?: number;
      occlusion?: boolean;
    }[];
  };
  storage: StorageState;
  scene: string;
}
export interface GameServicesDriver {
  factory: RuntimePluginFactory;
  inspect(): GameServicesInspection;
  uiKind(id: string): UI[number]["kind"] | undefined;
  gamepadConfig(): { mode: "ui" | "game"; deadzone: number };
  takeRequests(): GameServiceRequest[];
  /** Platform transaction handoff only; never exposed through the gameplay SDK. */
  adoptStorageRequest(type: "save" | "load", slot: string): void;
  storageComplete(type: "save" | "load", slot: string, error?: string): void;
  completeVoice(id: string): void;
  audioClock(): { tick: number; fixedDt: number | null; revision: number; versions: Record<string, number> };
}

/** A failed play never evicts an existing voice or consumes an id. */
export const GAME_SERVICES_MAX_VOICES = 32;
const MAX_DYNAMIC_UI = 512;
type UITextBinding = { id: string; key: string; variables: LocalizationVariables };
function uiTextBinding(value: unknown, code: string): asserts value is UITextBinding {
  const binding = object(value, ["id", "key", "variables"], code);
  name(binding.id, code, "UI id");
  check(typeof binding.key === "string" && binding.key.trim().length > 0 && binding.key.length <= 128 && !/[\x00-\x1f\x7f]/.test(binding.key), code, "Invalid localization key.");
  const vars = binding.variables;
  check(vars !== null && typeof vars === "object" && !Array.isArray(vars) && Object.keys(vars).length <= 32, code, "Invalid localization variables.");
  for (const [key, entry] of Object.entries(vars))
    check(/^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/.test(key) && (typeof entry === "boolean" || (typeof entry === "string" && entry.length <= 4096) || (typeof entry === "number" && Number.isFinite(entry))), code, `Invalid localization variable ${key}.`);
}
const SNAPSHOT_ERROR = "TC_SERVICES_SNAPSHOT";
const fail = (code: string, message: string): never => {
  throw new Error(`${code}: ${message}`);
};
function check(value: unknown, code: string, message: string): asserts value {
  if (!value) fail(code, message);
}
function object(
  value: unknown,
  keys: string[],
  code: string,
): Record<string, unknown> {
  check(
    value !== null && typeof value === "object" && !Array.isArray(value),
    code,
    "Expected an object.",
  );
  const result = value as Record<string, unknown>;
  check(
    Object.keys(result).sort().join("\0") === [...keys].sort().join("\0"),
    code,
    `Expected fields ${keys.join(", ")}.`,
  );
  return result;
}
function name(
  value: unknown,
  code: string,
  label: string,
): asserts value is string {
  check(
    typeof value === "string" &&
      value.trim().length > 0 &&
      value.length <= 64 &&
      !/[\x00-\x1f\x7f]/.test(value),
    code,
    `${label} must contain 1..64 printable characters.`,
  );
}
function inputKey(value: unknown, code: string): asserts value is string {
  check(
    typeof value === "string" &&
      value.length > 0 &&
      value.length <= 64 &&
      !/[\x00-\x1f\x7f]/.test(value),
    code,
    "Input key must contain 1..64 printable characters; a literal space is valid.",
  );
}
/** Convert a reserved gamepad binding into a thresholded action key. */
function gamepadKey(key: string, pad: GamepadState, previous: boolean): boolean | undefined {
  const button = /^gamepad:button:(0|[1-9]\d*)$/.exec(key);
  if (button) {
    const index = Number(button[1]), value = pad.connected && index < 32 ? pad.buttons[index] ?? 0 : 0;
    return value >= (previous ? 0.45 : 0.55);
  }
  const axis = /^gamepad:axis:(0|[1-9]\d*):(positive|negative)$/.exec(key);
  if (axis) {
    const index = Number(axis[1]), value = pad.connected && index < 8 ? pad.axes[index] ?? 0 : 0;
    const signed = axis[2] === "negative" ? -value : value;
    return signed >= (previous ? 0.45 : 0.55);
  }
  return undefined;
}
function finite(
  value: unknown,
  code: string,
  label: string,
  min = -Infinity,
  max = Infinity,
): asserts value is number {
  check(
    typeof value === "number" &&
      Number.isFinite(value) &&
      value >= min &&
      value <= max,
    code,
    `${label} must be finite in [${min}, ${max}].`,
  );
}
function integer(
  value: unknown,
  code: string,
  label: string,
  min = 0,
): asserts value is number {
  check(
    Number.isSafeInteger(value) && (value as number) >= min,
    code,
    `${label} must be a safe integer >= ${min}.`,
  );
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`,
      )
      .join(",")}}`;
  return JSON.stringify(value);
}
function cameraValue(value: unknown, code: string): asserts value is Camera {
  const c = object(
    value,
    ["entity", "distance", "height", "lookHeight", "yaw", "smoothing"],
    code,
  );
  name(c.entity, code, "Camera target");
  finite(c.distance, code, "Camera distance", Number.MIN_VALUE);
  finite(c.height, code, "Camera height", 0);
  finite(c.lookHeight, code, "Camera lookHeight", 0);
  finite(c.yaw, code, "Camera yaw");
  finite(c.smoothing, code, "Camera smoothing", 0, 1);
}
const UI_FIELDS = [
  "id",
  "kind",
  "text",
  "value",
  "visible",
  "anchor",
  "x",
  "y",
  "width",
  "color",
];
function uiValue(value: unknown, code: string): asserts value is UI[number] {
  const ui = object(
    value,
    [...UI_FIELDS,
      ...(value && typeof value === "object" && Object.hasOwn(value, "world") ? ["world"] : []),
      ...(value && typeof value === "object" && Object.hasOwn(value, "generation") ? ["generation"] : [])],
    code,
  );
  name(ui.id, code, "UI id");
  check(
    ["text", "bar", "button", "input"].includes(ui.kind as string),
    code,
    "Unknown UI kind.",
  );
  check(
    typeof ui.text === "string" && typeof ui.visible === "boolean",
    code,
    "Invalid UI text/visible.",
  );
  finite(ui.value, code, "UI progress", 0, 1);
  if (ui.world !== undefined) {
    const world = object(ui.world, ["entity", "offset", "occlude"], code);
    name(world.entity, code, "World UI entity");
    check(
      typeof world.occlude === "boolean",
      code,
      "World UI occlude must be boolean.",
    );
    check(
      Array.isArray(world.offset) &&
        world.offset.length === 3 &&
        world.offset.every(
          (value) => typeof value === "number" && Number.isFinite(value),
        ),
      code,
      "World UI offset must be finite Vec3.",
    );
  }
  check(
    ["top-left", "top-right", "bottom-left", "bottom-right", "center"].includes(
      ui.anchor as string,
    ),
    code,
    "Unknown UI anchor.",
  );
  finite(ui.x, code, "UI x");
  finite(ui.y, code, "UI y");
  finite(ui.width, code, "UI width", Number.MIN_VALUE);
  check(isUiColor(ui.color), code, "UI color must use a supported CSS color.");
  if (Object.hasOwn(ui, "generation")) integer(ui.generation, code, "UI generation", 1);
}

/** Pure deterministic gameplay state. The caller owns platform I/O and the animation adapter. */
export function createGameServices(
  ir: SceneIR,
  animation: AnimationService & Partial<AnimationControlService>,
): GameServicesDriver {
  const sceneId = ir.scene.id;
  const gameId = ir.gameId;
  const bindings = cloneSerializable(ir.input ?? {});
  const initialUI = cloneSerializable(ir.ui ?? []);
  const sounds = cloneSerializable(ir.sounds ?? []);
  const hasBuses = ir.audioBuses !== undefined;
  const buses = cloneSerializable(ir.audioBuses ?? []);
  const initialCamera = cloneSerializable(ir.scene.follow ?? null);
  const sceneIds = [ir.scene.id, ...(ir.scenes ?? []).map((scene) => scene.id)];
  const entityIds = ir.scene.entities.map((entity) => entity.id);
  const actions = Object.keys(bindings).sort();
  const knownKeys = new Set<string>();
  for (const action of actions) {
    name(action, "TC_INPUT_ACTION", "Input action");
    const keys = bindings[action];
    check(
      Array.isArray(keys) && keys.length > 0 && keys.length <= 16,
      "TC_INPUT_BINDINGS",
      `Action ${action} needs 1..16 keys.`,
    );
    for (const key of keys) {
      inputKey(key, "TC_INPUT_BINDINGS");
      knownKeys.add(key);
    }
    check(
      new Set(keys).size === keys.length,
      "TC_INPUT_BINDINGS",
      `Duplicate keys for ${action}.`,
    );
  }
  for (const item of initialUI) uiValue(item, "TC_UI_VALUE");
  check(
    new Set(initialUI.map((item) => item.id)).size === initialUI.length,
    "TC_UI_ID",
    "Duplicate UI ids.",
  );
  check(
    new Set(sounds.map((sound) => sound.id)).size === sounds.length,
    "TC_AUDIO_SOUND",
    "Duplicate sound ids.",
  );
  check(new Set(buses.map((bus) => bus.id)).size === buses.length, "TC_AUDIO_BUS", "Duplicate audio bus ids.");
  for (const bus of buses) {
    name(bus.id, "TC_AUDIO_BUS", "Audio bus id");
    finite(bus.volume, "TC_AUDIO_VOLUME", `Bus ${bus.id} volume`, 0, 1);
  }
  for (const id of sceneIds) name(id, "TC_SCENE_ID", "Scene id");
  check(
    new Set(sceneIds).size === sceneIds.length,
    "TC_SCENE_ID",
    "Duplicate scene ids.",
  );
  if (initialCamera) {
    cameraValue(initialCamera, "TC_CAMERA_VALUE");
    check(
      entityIds.includes(initialCamera.entity),
      "TC_CAMERA_TARGET",
      `Unknown target ${initialCamera.entity}; declare it in the scene.`,
    );
  }
  const durations: Record<string, number | null> = {};
  for (const sound of sounds) {
    name(sound.id, "TC_AUDIO_SOUND", "Sound id");
    if (sound.bus !== undefined)
      check(buses.some((bus) => bus.id === sound.bus), "TC_AUDIO_BUS", `Unknown audio bus ${sound.bus}.`);
    finite(sound.volume, "TC_AUDIO_VOLUME", `Sound ${sound.id} volume`, 0, 1);
    check(
      typeof sound.loop === "boolean",
      "TC_AUDIO_VALUE",
      `Sound ${sound.id} loop must be boolean.`,
    );
    const asset = ir.assets.find((item) => item.id === sound.asset);
    check(
      asset?.type === "audio",
      "TC_AUDIO_ASSET",
      `Sound ${sound.id} needs audio asset ${sound.asset}.`,
    );
    const duration = asset.metadata?.duration;
    if (duration !== undefined)
      finite(duration, "TC_AUDIO_DURATION", `Sound ${sound.id} duration`, 0);
    Object.defineProperty(durations, sound.id, {
      value: duration ?? null,
      enumerable: true,
    });
  }
  const definitions = cloneSerializable({
    game: gameId,
    scene: sceneId,
    sceneIds,
    entityIds,
    bindings,
    ui: initialUI,
    sounds,
    ...(hasBuses ? { audioBuses: buses } : {}),
    durations,
    camera: initialCamera,
    assets: ir.assets.filter((asset) =>
      sounds.some((sound) => sound.asset === asset.id),
    ),
  });
  const definitionKey = canonical(definitions);
  const initial = () => ({
    format: "pelican.game-services" as const,
    version: 1 as const,
    definitions,
    tick: 0,
    fixedDt: null as number | null,
    input: {
      keys: [] as string[],
      held: [] as string[],
      pressed: [] as string[],
      released: [] as string[],
      gamepadMode: "ui" as "ui" | "game",
      gamepadDeadzone: 0.15,
      gamepad: neutralGamepad(false, true),
    },
    camera: cloneSerializable(initialCamera),
    ui: cloneSerializable(initialUI),
    uiNextGeneration: 1,
    uiTextBindings: [] as UITextBinding[],
    audio: {
      volume: 1,
      ...(hasBuses ? { busVolumes: cloneSerializable(buses) as NonNullable<GameServicesInspection["audio"]["busVolumes"]> } : {}),
      voices: [] as GameServicesInspection["audio"]["voices"],
      nextVoice: 1,
    },
    storage: { state: "idle", slot: null, error: null } as StorageState,
    scene: sceneId,
    requests: [] as GameServiceRequest[],
    requestTick: null as number | null,
    scenePending: false,
  });
  type Snapshot = ReturnType<typeof initial>;
  let state = initial();
  let audioRevision = 0;
  const voiceVersions = new WeakMap<GameServicesInspection["audio"]["voices"][number], number>();
  let context: RuntimePluginContext | undefined;
  let disposed = false;
  // Dispatch belongs to the platform operation, not the saved game. In particular,
  // a load must remain completable after restore replaces deterministic state.
  let dispatchedStorage: GameServiceRequest | null = null;
  const alive = () => {
    check(
      !disposed,
      "TC_SERVICE_DISPOSED",
      "Game services were disposed; create a new driver.",
    );
  };
  const target = (id: string, code: string) => {
    name(id, code, "Entity id");
    check(
      context?.world.isAlive(id),
      code,
      `Entity ${id} does not exist; use a live scene entity.`,
    );
  };
  const action = (id: string) => {
    alive();
    check(
      typeof id === "string" && Object.hasOwn(bindings, id),
      "TC_INPUT_ACTION",
      `Unknown action ${String(id)}; declare it in game.input.`,
    );
  };
  const ui = (id: string, kind?: UI[number]["kind"]) => {
    alive();
    const item = state.ui.find((item) => item.id === id);
    check(
      item,
      "TC_UI_ID",
      `Unknown UI id ${String(id)}; declare it in game.ui.`,
    );
    check(
      kind === undefined || item.kind === kind,
      "TC_UI_KIND",
      `UI ${id} must be a ${kind}.`,
    );
    return item;
  };
  const localizedText = (binding: UITextBinding): string => {
    const i18n = context?.getLocalizationService?.();
    check(i18n, "TC_UI_LOCALIZATION", "Localized UI requires the localization service.");
    try { return i18n.text(binding.key, binding.variables); }
    catch (error) { return fail("TC_UI_LOCALIZATION", `UI ${binding.id}: ${String(error)}`); }
  };
  const displayUI = (item: UI[number]): UI[number] => {
    const binding = state.uiTextBindings.find(entry => entry.id === item.id);
    return binding ? { ...item, text: localizedText(binding) } : item;
  };
  const request = (type: GameServiceRequest["type"], id: string) => {
    alive();
    name(
      id,
      type === "scene" ? "TC_SCENE_ID" : "TC_STORAGE_SLOT",
      type === "scene" ? "Scene id" : "Storage slot",
    );
    if (type === "scene")
      check(
        sceneIds.includes(id),
        "TC_SCENE_ID",
        `Unknown scene ${id}; declare it in game.scenes.`,
      );
    check(
      state.requestTick !== state.tick &&
        !dispatchedStorage &&
        !state.scenePending &&
        !["saving", "loading"].includes(state.storage.state),
      "TC_SERVICE_BUSY",
      "A save/load/scene request is active or was issued this tick; finish it and retry next tick.",
    );
    state.requestTick = state.tick;
    state.requests.push({ type, id });
    if (type === "scene") state.scenePending = true;
    else
      state.storage = {
        state: type === "save" ? "saving" : "loading",
        slot: id,
        error: null,
      };
  };
  const services: Partial<RuntimeServices> = {
    input: {
      setGamepadMode(mode) {
        alive();
        check(mode === "ui" || mode === "game", "TC_GAMEPAD_MODE", "Gamepad mode must be ui or game.");
        if (state.input.gamepadMode === mode) return;
        state.input.gamepadMode = mode;
        if (mode === "ui") {
          const before = new Set(state.input.held);
          state.input.keys = state.input.keys.filter(key => !key.startsWith("gamepad:"));
          state.input.held = actions.filter(id => bindings[id].some(key => state.input.keys.includes(key))).sort();
          const released = new Set(state.input.released);
          for (const id of before) if (!state.input.held.includes(id)) released.add(id);
          state.input.released = [...released].sort();
        }
        state.input.gamepad = neutralGamepad(state.input.gamepad.available, mode === "ui");
      },
      setGamepadDeadzone(value) { alive(); finite(value, "TC_GAMEPAD_DEADZONE", "Gamepad deadzone", 0, 0.95); state.input.gamepadDeadzone = value; },
      gamepad() { alive(); return cloneSerializable(state.input.gamepad); },
      held(id) {
        action(id);
        return state.input.held.includes(id);
      },
      pressed(id) {
        action(id);
        return state.input.pressed.includes(id);
      },
      released(id) {
        action(id);
        return state.input.released.includes(id);
      },
      axis(negative, positive) {
        action(negative);
        action(positive);
        return (
          Number(state.input.held.includes(positive)) -
          Number(state.input.held.includes(negative))
        );
      },
    },
    animation: {
      play(entity, clip, options) {
        alive();
        animation.play(entity, clip, options);
      },
      state(entity) {
        alive();
        return animation.state(entity);
      },
      clips(entity) {
        alive();
        if (!animation.clips) throw new Error("TC_ANIMATION_ADAPTER: Clip inspection is unavailable in this animation adapter.");
        return animation.clips(entity);
      },
      pause(entity) {
        alive();
        if (!animation.pause) throw new Error("TC_ANIMATION_ADAPTER: Pause is unavailable in this animation adapter.");
        animation.pause(entity);
      },
      resume(entity) {
        alive();
        if (!animation.resume) throw new Error("TC_ANIMATION_ADAPTER: Resume is unavailable in this animation adapter.");
        animation.resume(entity);
      },
      seek(entity, time) {
        alive();
        if (!animation.seek) throw new Error("TC_ANIMATION_ADAPTER: Seek is unavailable in this animation adapter.");
        animation.seek(entity, time);
      },
      setSpeed(entity, speed) {
        alive();
        if (!animation.setSpeed) throw new Error("TC_ANIMATION_ADAPTER: Speed control is unavailable in this animation adapter.");
        animation.setSpeed(entity, speed);
      },
    },
    camera: {
      follow(entity, options = {}) {
        alive();
        target(entity, "TC_CAMERA_TARGET");
        const values = cloneSerializable(options);
        check(
          values &&
            typeof values === "object" &&
            !Array.isArray(values) &&
            Object.keys(values).every((key) =>
              ["distance", "height", "lookHeight", "yaw", "smoothing"].includes(
                key,
              ),
            ),
          "TC_CAMERA_VALUE",
          "Unknown camera options.",
        );
        const next = {
          distance: 5,
          height: 2,
          lookHeight: 1,
          yaw: 0,
          smoothing: 0.1,
          ...values,
          entity,
        };
        cameraValue(next, "TC_CAMERA_VALUE");
        state.camera = next;
      },
      orbit(yaw) {
        alive();
        finite(yaw, "TC_CAMERA_VALUE", "Orbit yaw delta");
        check(
          state.camera,
          "TC_CAMERA_FOLLOW",
          "Call camera.follow before orbit.",
        );
        const next = state.camera.yaw + yaw;
        finite(next, "TC_CAMERA_VALUE", "Resulting camera yaw");
        state.camera.yaw = next;
      },
    },
    ui: {
      create(definition) {
        alive();
        const input = cloneSerializable(definition);
        check(input && typeof input === "object" && !Array.isArray(input) &&
          Object.keys(input).every(key => ["id", "kind", "text", "value", "visible", "anchor", "x", "y", "width", "color", "world"].includes(key)),
          "TC_UI_VALUE", "UI definition contains unknown fields.");
        name(input.id, "TC_UI_ID", "UI id");
        check(!state.ui.some(item => item.id === input.id), "TC_UI_ID", `UI ${input.id} already exists.`);
        check(state.ui.length - initialUI.length < MAX_DYNAMIC_UI, "TC_UI_CAPACITY", `At most ${MAX_DYNAMIC_UI} dynamic UI elements may exist.`);
        check(Number.isSafeInteger(state.uiNextGeneration) && state.uiNextGeneration < Number.MAX_SAFE_INTEGER,
          "TC_UI_GENERATION", "UI generation exhausted; start a new scene.");
        let world: UI[number]["world"];
        if (input.world !== undefined) {
          const source = input.world;
          check(source && typeof source === "object" && !Array.isArray(source) &&
            Object.keys(source).every(key => ["entity", "offset", "occlude"].includes(key)),
            "TC_UI_VALUE", "World UI requires an entity and optional offset and occlude.");
          target(source.entity, "TC_UI_WORLD_ENTITY");
          world = { entity: source.entity, offset: source.offset === undefined ? [0, 0, 0] : source.offset,
            occlude: source.occlude === undefined ? true : source.occlude };
        }
        const item: UI[number] = { id: input.id, kind: input.kind,
          text: input.text === undefined ? "" : input.text, value: input.value === undefined ? 0 : input.value,
          visible: input.visible === undefined ? true : input.visible,
          anchor: input.anchor === undefined ? "top-left" : input.anchor,
          x: input.x === undefined ? 0 : input.x, y: input.y === undefined ? 0 : input.y,
          width: input.width === undefined ? 160 : input.width, color: input.color === undefined ? "#ffffff" : input.color,
          ...(world ? { world } : {}), generation: state.uiNextGeneration };
        uiValue(item, "TC_UI_VALUE");
        state.ui.push(item);
        return state.uiNextGeneration++;
      },
      remove(id) {
        const item = ui(id);
        check(item.generation !== undefined, "TC_UI_AUTHORED", `UI ${id} is declared in game.ui; hide it instead.`);
        state.ui.splice(state.ui.indexOf(item), 1);
        state.uiTextBindings = state.uiTextBindings.filter(binding => binding.id !== id);
      },
      get(id) { return cloneSerializable(displayUI(ui(id))); },
      setLayout(id, patch) {
        const item = ui(id), input = cloneSerializable(patch);
        check(input && typeof input === "object" && !Array.isArray(input) &&
          Object.keys(input).every(key => ["anchor", "x", "y", "width", "color"].includes(key)),
          "TC_UI_VALUE", "Layout accepts anchor, x, y, width and color only.");
        const next = { ...item, ...input };
        uiValue(next, "TC_UI_VALUE");
        Object.assign(item, input);
      },
      bindText(id, key, variables = {}) {
        const item = ui(id);
        check(item.kind === "text" || item.kind === "button", "TC_UI_KIND", `UI ${id} must be text or button to bind localization.`);
        const binding = cloneSerializable({ id, key, variables });
        uiTextBinding(binding, "TC_UI_LOCALIZATION");
        localizedText(binding);
        state.uiTextBindings = [...state.uiTextBindings.filter(entry => entry.id !== id), binding];
      },
      unbindText(id) {
        const item = ui(id);
        const binding = state.uiTextBindings.find(entry => entry.id === id);
        if (!binding) return;
        item.text = localizedText(binding);
        state.uiTextBindings = state.uiTextBindings.filter(entry => entry.id !== id);
      },
      setText(id, text) {
        const item = ui(id);
        check(item.kind !== "bar", "TC_UI_KIND", `UI ${id} is a progress bar.`);
        check(
          typeof text === "string",
          "TC_UI_VALUE",
          `UI ${id} text must be a string.`,
        );
        item.text = text;
        state.uiTextBindings = state.uiTextBindings.filter(binding => binding.id !== id);
      },
      setProgress(id, value) {
        const item = ui(id, "bar");
        finite(value, "TC_UI_VALUE", `UI ${id} progress`, 0, 1);
        item.value = value;
      },
      setVisible(id, visible) {
        const item = ui(id);
        check(
          typeof visible === "boolean",
          "TC_UI_VALUE",
          `UI ${id} visible must be boolean.`,
        );
        item.visible = visible;
      },
    },
    audio: {
      play(id, options = {}) {
        alive();
        const sound = sounds.find((sound) => sound.id === id);
        check(
          sound,
          "TC_AUDIO_SOUND",
          `Unknown sound ${String(id)}; declare it in game.sounds.`,
        );
        const values = cloneSerializable(options);
        check(
          values &&
            typeof values === "object" &&
            !Array.isArray(values) &&
            Object.keys(values).every((key) =>
              ["volume", "loop", "entity", "bus", "priority", "occlusion"].includes(key),
            ),
          "TC_AUDIO_VALUE",
          "Unknown audio options.",
        );
        const volume = Object.hasOwn(values, "volume")
          ? values.volume
          : sound.volume;
        const loop = Object.hasOwn(values, "loop") ? values.loop : sound.loop;
        const bus = Object.hasOwn(values, "bus") ? values.bus : sound.bus;
        if (bus !== undefined || Object.hasOwn(values, "bus")) {
          name(bus, "TC_AUDIO_BUS", "Audio bus id");
          check(buses.some((item) => item.id === bus), "TC_AUDIO_BUS", `Unknown audio bus ${bus}.`);
        }
        finite(volume, "TC_AUDIO_VOLUME", `Sound ${id} volume`, 0, 1);
        const priority = Object.hasOwn(values, "priority") ? values.priority : 0;
        integer(priority, "TC_AUDIO_PRIORITY", "Voice priority", 0);
        check(priority <= 255, "TC_AUDIO_PRIORITY", "Voice priority must be 0..255.");
        check(
          typeof loop === "boolean",
          "TC_AUDIO_VALUE",
          `Sound ${id} loop must be boolean.`,
        );
        if (Object.hasOwn(values, "entity"))
          target(values.entity!, "TC_AUDIO_TARGET");
        if (Object.hasOwn(values, "occlusion"))
          check(typeof values.occlusion === "boolean", "TC_AUDIO_OCCLUSION", "Audio occlusion must be boolean.");
        if (values.occlusion) {
          check(typeof values.entity === "string", "TC_AUDIO_OCCLUSION", "Audio occlusion requires a live spatial entity.");
          check(context?.getPhysicsService?.(), "TC_AUDIO_OCCLUSION", "Audio occlusion requires the 3D physics service.");
        }
        check(
          state.audio.nextVoice < Number.MAX_SAFE_INTEGER,
          "TC_AUDIO_VOICE_LIMIT",
          "Voice id counter exhausted; create a new runtime.",
        );
        if (state.audio.voices.length >= GAME_SERVICES_MAX_VOICES) {
          const lowest = state.audio.voices.reduce((candidate, voice) =>
            (voice.priority ?? 0) < (candidate.priority ?? 0) ? voice : candidate);
          check(priority > (lowest.priority ?? 0), "TC_AUDIO_VOICE_LIMIT",
            `At most ${GAME_SERVICES_MAX_VOICES} voices may play; use a higher priority to replace the oldest lowest-priority voice.`);
          state.audio.voices = state.audio.voices.filter((voice) => voice !== lowest);
        }
        const voice = `voice:${state.audio.nextVoice}`;
        state.audio.voices.push({
          id: voice,
          sound: id,
          ...(bus !== undefined ? { bus } : {}),
          ...(priority !== 0 ? { priority } : {}),
          ...(values.occlusion ? { occlusion: true } : {}),
          volume,
          loop,
          entity: values.entity ?? null,
          startedAt: state.tick,
        });
        state.audio.nextVoice++;
        return voice;
      },
      stop(id) {
        alive();
        name(id, "TC_AUDIO_VOICE", "Voice id");
        state.audio.voices = state.audio.voices.filter(
          (voice) => voice.id !== id,
        );
      },
      pause(id) {
        alive();
        name(id, "TC_AUDIO_VOICE", "Voice id");
        const voice = state.audio.voices.find((item) => item.id === id);
        if (voice && voice.pausedAt == null) {
          voice.pausedTicks ??= 0;
          voice.pausedAt = state.tick;
          voiceVersions.set(voice, (voiceVersions.get(voice) ?? 0) + 1);
        }
      },
      resume(id) {
        alive();
        name(id, "TC_AUDIO_VOICE", "Voice id");
        const voice = state.audio.voices.find((item) => item.id === id);
        if (voice && voice.pausedAt != null) {
          voice.pausedTicks = (voice.pausedTicks ?? 0) + state.tick - voice.pausedAt;
          voice.pausedAt = null;
          voiceVersions.set(voice, (voiceVersions.get(voice) ?? 0) + 1);
        }
      },
      volume(value) {
        alive();
        finite(value, "TC_AUDIO_VOLUME", "Master volume", 0, 1);
        state.audio.volume = value;
      },
      busVolume(id, value) {
        alive();
        name(id, "TC_AUDIO_BUS", "Audio bus id");
        const bus = state.audio.busVolumes?.find((item) => item.id === id);
        check(bus, "TC_AUDIO_BUS", `Unknown audio bus ${id}.`);
        finite(value, "TC_AUDIO_VOLUME", `Bus ${id} volume`, 0, 1);
        bus.volume = value;
        delete bus.fade;
      },
      fadeBus(id, target, duration) {
        alive();
        name(id, "TC_AUDIO_BUS", "Audio bus id");
        const bus = state.audio.busVolumes?.find((item) => item.id === id);
        check(bus, "TC_AUDIO_BUS", `Unknown audio bus ${id}.`);
        finite(target, "TC_AUDIO_VOLUME", `Bus ${id} fade target`, 0, 1);
        finite(duration, "TC_AUDIO_FADE", "Fade duration", 0);
        if (duration === 0 || bus.volume === target) {
          bus.volume = target;
          delete bus.fade;
        } else bus.fade = { from: bus.volume, target, duration, startedAt: state.tick };
      },
    },
    storage: {
      save(slot) {
        request("save", slot);
      },
      load(slot) {
        request("load", slot);
      },
      status() {
        alive();
        return cloneSerializable(state.storage);
      },
    },
    scenes: {
      current() {
        alive();
        return state.scene;
      },
      load(id) {
        request("scene", id);
      },
    },
  };
  const inspect = (): GameServicesInspection => {
    alive();
    const { held, pressed, released } = state.input;
    return cloneSerializable({
      input: { held, pressed, released, gamepadMode: state.input.gamepadMode, gamepadDeadzone: state.input.gamepadDeadzone, gamepad: state.input.gamepad },
      camera: state.camera,
      ui: state.ui.map(displayUI),
      audio: { volume: state.audio.volume, ...(state.audio.busVolumes !== undefined ? { busVolumes: state.audio.busVolumes } : {}), voices: state.audio.voices },
      storage: state.storage,
      scene: state.scene,
    });
  };
  const validate = (value: unknown): Snapshot => {
    alive();
    let data: Snapshot;
    try {
      data = cloneSerializable(value) as Snapshot;
    } catch {
      return fail(
        SNAPSHOT_ERROR,
        "Expected finite plain JSON without accessors, cycles, sparse arrays, or extra array properties.",
      );
    }
    object(
      data,
      [
        "format",
        "version",
        "definitions",
        "tick",
        "fixedDt",
        "input",
        "camera",
        "ui",
        ...(Object.hasOwn(data, "uiNextGeneration") ? ["uiNextGeneration"] : []),
        ...(Object.hasOwn(data, "uiTextBindings") ? ["uiTextBindings"] : []),
        "audio",
        "storage",
        "scene",
        "requests",
        "requestTick",
        "scenePending",
      ],
      SNAPSHOT_ERROR,
    );
    check(
      data.format === "pelican.game-services" && data.version === 1,
      SNAPSHOT_ERROR,
      "Unsupported format/version.",
    );
    check(
      canonical(data.definitions) === definitionKey,
      SNAPSHOT_ERROR,
      "Immutable gameplay definitions differ; use the same compiled game.",
    );
    integer(data.tick, SNAPSHOT_ERROR, "Tick");
    if (data.tick === 0)
      check(
        data.fixedDt === null,
        SNAPSHOT_ERROR,
        "Initial fixedDt must be null.",
      );
    else finite(data.fixedDt, SNAPSHOT_ERROR, "fixedDt", Number.MIN_VALUE);
    check(
      data.fixedDt === null || Number.isFinite(data.tick * data.fixedDt),
      SNAPSHOT_ERROR,
      "Clock time exceeds the finite range.",
    );
    const inputFields = data.input && typeof data.input === "object" ? data.input : {};
    object(data.input, ["keys", "held", "pressed", "released", ...(Object.hasOwn(inputFields, "gamepadMode") ? ["gamepadMode"] : []),
      ...(Object.hasOwn(inputFields, "gamepadDeadzone") ? ["gamepadDeadzone"] : []),
      ...(Object.hasOwn(inputFields, "gamepad") ? ["gamepad"] : [])], SNAPSHOT_ERROR);
    if (!Object.hasOwn(data.input, "gamepadMode")) data.input.gamepadMode = "ui";
    if (!Object.hasOwn(data.input, "gamepadDeadzone")) data.input.gamepadDeadzone = 0.15;
    if (!Object.hasOwn(data.input, "gamepad")) data.input.gamepad = neutralGamepad(false, true);
    finite(data.input.gamepadDeadzone, SNAPSHOT_ERROR, "Gamepad deadzone", 0, 0.95);
    check(data.input.gamepadMode === "ui" || data.input.gamepadMode === "game", SNAPSHOT_ERROR, "Invalid gamepad mode.");
    data.input.gamepad = parseGamepad(data.input.gamepad, SNAPSHOT_ERROR);
    if (data.input.gamepadMode === "ui") check(!data.input.gamepad.connected, SNAPSHOT_ERROR, "UI gamepad mode cannot expose a connected gameplay pad.");
    const strings = (
      value: unknown,
      allowed: ReadonlySet<string>,
      label: string,
    ) => {
      check(Array.isArray(value), SNAPSHOT_ERROR, `${label} must be an array.`);
      check(
        value.every((item) => typeof item === "string" && allowed.has(item)) &&
          new Set(value).size === value.length &&
          canonical(value) === canonical([...value].sort()),
        SNAPSHOT_ERROR,
        `${label} contains unknown, duplicate, or unsorted values.`,
      );
    };
    strings(data.input.keys, knownKeys, "Input keys");
    for (const field of ["held", "pressed", "released"] as const)
      strings(data.input[field], new Set(actions), `Input ${field}`);
    check(
      canonical(data.input.held) ===
        canonical(
          actions.filter((action) =>
            bindings[action].some((key) => data.input.keys.includes(key)),
          ),
        ),
      SNAPSHOT_ERROR,
      "Held actions disagree with input keys.",
    );
    check(
      data.input.pressed.every(
        (id) =>
          data.input.held.includes(id) || data.input.released.includes(id),
      ) &&
        data.input.released.every(
          (id) =>
            !data.input.held.includes(id) || data.input.pressed.includes(id),
        ),
      SNAPSHOT_ERROR,
      "Input edges disagree with final held state.",
    );
    if (data.tick === 0)
      check(
        [data.input.keys, data.input.held, data.input.pressed, data.input.released].every(items => items.length === 0) && !data.input.gamepad.connected,
        SNAPSHOT_ERROR,
        "Initial input must be empty.",
      );
    if (data.camera !== null) cameraValue(data.camera, SNAPSHOT_ERROR);
    if (!Object.hasOwn(data, "uiNextGeneration")) data.uiNextGeneration = 1;
    integer(data.uiNextGeneration, SNAPSHOT_ERROR, "Next UI generation", 1);
    check(Array.isArray(data.ui) && data.ui.length >= initialUI.length && data.ui.length <= initialUI.length + MAX_DYNAMIC_UI,
      SNAPSHOT_ERROR, "UI definitions or dynamic capacity differ.");
    const uiIds = new Set<string>(), generations = new Set<number>();
    for (let i = 0; i < data.ui.length; i++) {
      const item = data.ui[i];
      uiValue(item, SNAPSHOT_ERROR);
      check(!uiIds.has(item.id), SNAPSHOT_ERROR, "Duplicate UI id.");
      uiIds.add(item.id);
      if (i < initialUI.length) {
        const original = initialUI[i];
        check(item.id === original.id && item.kind === original.kind && item.generation === undefined &&
          canonical(item.world ?? null) === canonical(original.world ?? null), SNAPSHOT_ERROR, "Authored UI identity differs.");
        if (item.kind === "bar") check(item.text === original.text, SNAPSHOT_ERROR, "Progress bar text cannot change.");
        else check(item.value === original.value, SNAPSHOT_ERROR, "Non-bar progress cannot change.");
      } else {
        const generation = item.generation;
        check(generation !== undefined && generation < data.uiNextGeneration && !generations.has(generation),
          SNAPSHOT_ERROR, "Invalid or duplicate dynamic UI generation.");
        generations.add(generation);
      }
    }
    if (!Object.hasOwn(data, "uiTextBindings")) data.uiTextBindings = [];
    check(Array.isArray(data.uiTextBindings) && data.uiTextBindings.length <= data.ui.length, SNAPSHOT_ERROR, "Invalid UI localization bindings.");
    const boundIds = new Set<string>();
    for (const binding of data.uiTextBindings) {
      uiTextBinding(binding, SNAPSHOT_ERROR);
      const item = data.ui.find(entry => entry.id === binding.id);
      check(item && (item.kind === "text" || item.kind === "button") && !boundIds.has(binding.id), SNAPSHOT_ERROR, "Invalid or duplicate localized UI target.");
      boundIds.add(binding.id);
    }
    object(data.audio, ["volume", "voices", "nextVoice", ...(Object.hasOwn(data.audio, "busVolumes") ? ["busVolumes"] : [])], SNAPSHOT_ERROR);
    finite(data.audio.volume, SNAPSHOT_ERROR, "Master volume", 0, 1);
    if (data.audio.busVolumes !== undefined) {
      check(hasBuses && Array.isArray(data.audio.busVolumes) && data.audio.busVolumes.length === buses.length, SNAPSHOT_ERROR, "Invalid audio buses.");
      for (let i = 0; i < buses.length; i++) {
        const bus = object(data.audio.busVolumes[i], ["id", "volume", ...(Object.hasOwn(data.audio.busVolumes[i], "fade") ? ["fade"] : [])], SNAPSHOT_ERROR);
        check(bus.id === buses[i].id, SNAPSHOT_ERROR, "Invalid audio bus id or order.");
        finite(bus.volume, SNAPSHOT_ERROR, "Bus volume", 0, 1);
        if (Object.hasOwn(bus, "fade")) {
          const fade = object(bus.fade, ["from", "target", "duration", "startedAt"], SNAPSHOT_ERROR);
          finite(fade.from, SNAPSHOT_ERROR, "Fade start", 0, 1);
          finite(fade.target, SNAPSHOT_ERROR, "Fade target", 0, 1);
          finite(fade.duration, SNAPSHOT_ERROR, "Fade duration", Number.MIN_VALUE);
          integer(fade.startedAt, SNAPSHOT_ERROR, "Fade tick", 0);
          check(fade.startedAt <= data.tick && (data.fixedDt === null || (data.tick - fade.startedAt) * data.fixedDt < fade.duration), SNAPSHOT_ERROR, "Expired or future fade.");
          const expected = fade.from + (fade.target - fade.from) * Math.min(1, (data.tick - fade.startedAt) * (data.fixedDt ?? 0) / fade.duration);
          check(Math.abs(Number(bus.volume) - expected) < 1e-9, SNAPSHOT_ERROR, "Fade gain does not match tick.");
        }
      }
    } else if (hasBuses) {
      data.audio.busVolumes = cloneSerializable(buses);
    }
    integer(data.audio.nextVoice, SNAPSHOT_ERROR, "Next voice", 1);
    check(
      Array.isArray(data.audio.voices) &&
        data.audio.voices.length <= GAME_SERVICES_MAX_VOICES,
      SNAPSHOT_ERROR,
      "Too many voices or invalid voice list.",
    );
    let previousVoice = 0;
    for (const voice of data.audio.voices) {
      object(
        voice,
        ["id", "sound", "volume", "loop", "entity", "startedAt", ...(Object.hasOwn(voice, "bus") ? ["bus"] : []), ...(Object.hasOwn(voice, "priority") ? ["priority"] : []), ...(Object.hasOwn(voice, "occlusion") ? ["occlusion"] : []), ...(Object.hasOwn(voice, "pausedAt") || Object.hasOwn(voice, "pausedTicks") ? ["pausedAt", "pausedTicks"] : [])],
        SNAPSHOT_ERROR,
      );
      check(
        typeof voice.id === "string" && /^voice:[1-9]\d*$/.test(voice.id),
        SNAPSHOT_ERROR,
        "Invalid voice id.",
      );
      const sequence = Number(voice.id.slice(6));
      integer(sequence, SNAPSHOT_ERROR, "Voice sequence", 1);
      check(
        sequence > previousVoice && sequence < data.audio.nextVoice,
        SNAPSHOT_ERROR,
        "Voice ids are duplicated, unordered or beyond counter.",
      );
      previousVoice = sequence;
      check(
        sounds.some((sound) => sound.id === voice.sound),
        SNAPSHOT_ERROR,
        "Unknown voice sound.",
      );
      if (Object.hasOwn(voice, "bus"))
        check(typeof voice.bus === "string" && buses.some((bus) => bus.id === voice.bus), SNAPSHOT_ERROR, "Unknown voice bus.");
      else {
        const defaultBus = sounds.find((sound) => sound.id === voice.sound)?.bus;
        if (defaultBus !== undefined) voice.bus = defaultBus;
      }
      finite(voice.volume, SNAPSHOT_ERROR, "Voice volume", 0, 1);
      if (Object.hasOwn(voice, "priority")) {
        integer(voice.priority, SNAPSHOT_ERROR, "Voice priority", 1);
        check(voice.priority <= 255, SNAPSHOT_ERROR, "Invalid voice priority.");
      }
      check(
        typeof voice.loop === "boolean",
        SNAPSHOT_ERROR,
        "Invalid voice loop.",
      );
      if (voice.entity !== null)
        name(voice.entity, SNAPSHOT_ERROR, "Voice entity");
      if (Object.hasOwn(voice, "occlusion"))
        check(voice.occlusion === true && voice.entity !== null && context?.getPhysicsService?.(), SNAPSHOT_ERROR, "Occluded voice requires an entity and 3D physics service.");
      integer(voice.startedAt, SNAPSHOT_ERROR, "Voice startedAt");
      check(
        voice.startedAt <= data.tick,
        SNAPSHOT_ERROR,
        "Voice starts in the future.",
      );
      if (Object.hasOwn(voice, "pausedAt")) {
        integer(voice.pausedTicks, SNAPSHOT_ERROR, "Voice pausedTicks");
        if (voice.pausedAt !== null) integer(voice.pausedAt, SNAPSHOT_ERROR, "Voice pausedAt");
        check(
          (voice.pausedAt ?? data.tick) >= voice.startedAt &&
            (voice.pausedAt ?? data.tick) <= data.tick &&
            voice.pausedTicks! <= (voice.pausedAt ?? data.tick) - voice.startedAt,
          SNAPSHOT_ERROR,
          "Invalid voice pause history.",
        );
      }
      const duration = durations[voice.sound];
      check(
        voice.loop ||
          duration === null ||
          data.fixedDt === null ||
          ((voice.pausedAt ?? data.tick) - voice.startedAt - (voice.pausedTicks ?? 0)) * data.fixedDt < duration ||
          (voice.pausedAt ?? data.tick) - voice.startedAt - (voice.pausedTicks ?? 0) === 0,
        SNAPSHOT_ERROR,
        "Expired voice must have been reclaimed.",
      );
    }
    object(data.storage, ["state", "slot", "error"], SNAPSHOT_ERROR);
    check(
      ["idle", "saving", "loading", "saved", "loaded", "failed"].includes(
        data.storage.state,
      ),
      SNAPSHOT_ERROR,
      "Invalid storage state.",
    );
    if (data.storage.state === "idle")
      check(
        data.storage.slot === null && data.storage.error === null,
        SNAPSHOT_ERROR,
        "Idle storage must have no slot/error.",
      );
    else name(data.storage.slot, SNAPSHOT_ERROR, "Storage slot");
    check(
      data.storage.state === "failed"
        ? typeof data.storage.error === "string"
        : data.storage.error === null,
      SNAPSHOT_ERROR,
      "Storage error disagrees with state.",
    );
    check(
      data.scene === sceneId,
      SNAPSHOT_ERROR,
      "Current scene must match the host scene.",
    );
    if (data.requestTick !== null) {
      integer(data.requestTick, SNAPSHOT_ERROR, "Request tick");
      check(
        data.requestTick <= data.tick,
        SNAPSHOT_ERROR,
        "Request is in the future.",
      );
    }
    check(
      typeof data.scenePending === "boolean",
      SNAPSHOT_ERROR,
      "Invalid scenePending.",
    );
    const storageBusy =
      data.storage.state === "saving" || data.storage.state === "loading";
    check(
      !data.scenePending || !storageBusy,
      SNAPSHOT_ERROR,
      "Scene/storage requests conflict.",
    );
    check(
      (!data.scenePending && data.storage.state === "idle") ||
        data.requestTick !== null,
      SNAPSHOT_ERROR,
      "Request tick is missing.",
    );
    check(
      Array.isArray(data.requests) && data.requests.length <= 1,
      SNAPSHOT_ERROR,
      "Expected at most one pending request.",
    );
    for (const pending of data.requests) {
      object(pending, ["type", "id"], SNAPSHOT_ERROR);
      name(pending.id, SNAPSHOT_ERROR, "Request id");
      check(
        ["save", "load", "scene"].includes(pending.type),
        SNAPSHOT_ERROR,
        "Unknown request type.",
      );
      if (pending.type === "scene")
        check(
          data.scenePending && sceneIds.includes(pending.id),
          SNAPSHOT_ERROR,
          "Invalid pending scene.",
        );
      else
        check(
          !data.scenePending &&
            data.storage.slot === pending.id &&
            data.storage.state ===
              (pending.type === "save" ? "saving" : "loading"),
          SNAPSHOT_ERROR,
          "Pending request disagrees with storage status.",
        );
    }
    return data;
  };
  const plugin: RuntimePlugin = {
    id: "game-services",
    version: "1",
    services,
    systems: [
      {
        id: "$engine.input",
        phase: "input",
        run(dt) {
          alive();
          finite(dt, "TC_SERVICE_CLOCK", "fixedDt", Number.MIN_VALUE);
          check(
            state.fixedDt === null || state.fixedDt === dt,
            "TC_SERVICE_CLOCK",
            "fixedDt changed; create a new runtime.",
          );
          check(
            state.tick < Number.MAX_SAFE_INTEGER,
            "TC_SERVICE_CLOCK",
            "Tick counter exhausted.",
          );
          const keys = new Set(state.input.keys);
          for (const event of context!.events("ui.text")) {
            const payload = object(
              event.payload,
              ["id", "text", "composing", ...(event.payload && typeof event.payload === "object" && Object.hasOwn(event.payload, "generation") ? ["generation"] : [])],
              "TC_UI_INPUT_EVENT",
            );
            name(payload.id, "TC_UI_INPUT_EVENT", "Input id");
            check(
              typeof payload.text === "string" &&
                payload.text.length <= 4096 &&
                payload.composing === false,
              "TC_UI_INPUT_EVENT",
              "Only committed input text up to 4096 characters is delivered to gameplay.",
            );
            if (Object.hasOwn(payload, "generation")) {
              integer(payload.generation, "TC_UI_INPUT_EVENT", "UI generation", 1);
              const item = state.ui.find(entry => entry.id === payload.id);
              // Retired/replaced dynamic inputs may have an event already in flight.
              if (!item || item.kind !== "input" || item.generation !== payload.generation) continue;
              item.text = payload.text;
            } else {
              const item = ui(payload.id, "input");
              check(item.generation === undefined, "TC_UI_INPUT_EVENT", "Dynamic input events require a generation.");
              item.text = payload.text;
            }
          }
          const held = new Set(state.input.held);
          const pressed = new Set<string>();
          const released = new Set<string>();
          let gamepad = state.input.gamepad;
          const applyKey = (key: string, down: boolean) => {
            if (!knownKeys.has(key)) return;
            if (down) keys.add(key); else keys.delete(key);
            for (const id of actions) {
              const next = bindings[id].some(binding => keys.has(binding));
              if (next && !held.has(id)) pressed.add(id);
              if (!next && held.has(id)) released.add(id);
              if (next) held.add(id); else held.delete(id);
            }
          };
          // Preserve event sequence when keyboard and gamepad transitions share a tick.
          for (const event of context!.events()) {
            if (event.type === "input.key") {
              const payload = object(event.payload, ["key", "pressed"], "TC_INPUT_EVENT");
              inputKey(payload.key, "TC_INPUT_EVENT");
              check(typeof payload.pressed === "boolean", "TC_INPUT_EVENT", "pressed must be boolean.");
              applyKey(payload.key, payload.pressed);
            } else if (event.type === "input.gamepad") {
              const sample = parseGamepad(event.payload, "TC_GAMEPAD_EVENT");
              gamepad = state.input.gamepadMode === "game" ? { ...sample,
                axes: sample.axes.map(axis => Math.abs(axis) < state.input.gamepadDeadzone ? 0 : axis) } : neutralGamepad(sample.available, true);
              for (const key of knownKeys) {
                const down = gamepadKey(key, gamepad, keys.has(key));
                if (down !== undefined) applyKey(key, down);
              }
            }
          }
          state.tick++;
          state.fixedDt = dt;
          state.input = {
            keys: [...keys].sort(),
            held: [...held].sort(),
            pressed: [...pressed].sort(),
            released: [...released].sort(),
            gamepadMode: state.input.gamepadMode,
            gamepadDeadzone: state.input.gamepadDeadzone,
            gamepad,
          };
          state.audio.voices = state.audio.voices.filter(
            (voice) =>
              voice.loop ||
              voice.pausedAt != null ||
              durations[voice.sound] === null ||
              (state.tick - voice.startedAt - (voice.pausedTicks ?? 0)) * dt < durations[voice.sound]!,
          );
          for (const bus of state.audio.busVolumes ?? []) {
            if (!bus.fade) continue;
            const { from, target, duration, startedAt } = bus.fade;
            const progress = Math.min(1, (state.tick - startedAt) * dt / duration);
            bus.volume = from + (target - from) * progress;
            if (progress === 1) delete bus.fade;
          }
        },
      },
    ],
    inspect,
    snapshot() {
      alive();
      return cloneSerializable(state);
    },
    validateSnapshot(value) {
      validate(value);
    },
    restore(value) {
      const restored = validate(value);
      state = restored;
      audioRevision++;
      if (dispatchedStorage?.type !== "load") dispatchedStorage = null;
    },
    dispose() {
      disposed = true;
      context = undefined;
      dispatchedStorage = null;
    },
  };
  return {
    factory(value) {
      alive();
      check(
        !context,
        "TC_SERVICE_BOUND",
        "A game services driver belongs to one host; create a new driver.",
      );
      check(
        value.scene.scene.id === sceneId && value.scene.gameId === gameId,
        "TC_SERVICE_SCENE",
        "Driver and host must use the same compiled scene.",
      );
      context = value;
      return plugin;
    },
    inspect,
    uiKind(id) { alive(); return state.ui.find(item => item.id === id)?.kind; },
    gamepadConfig() { alive(); return { mode: state.input.gamepadMode, deadzone: state.input.gamepadDeadzone }; },
    takeRequests() {
      alive();
      const pending = cloneSerializable(state.requests);
      state.requests = [];
      const storage = pending.find((request) => request.type !== "scene");
      if (storage) dispatchedStorage = storage;
      return pending;
    },
    adoptStorageRequest(type, slot) {
      alive();
      check(
        type === "save" || type === "load",
        "TC_STORAGE_REQUEST",
        "Adopted request type must be save/load.",
      );
      name(slot, "TC_STORAGE_SLOT", "Storage slot");
      check(
        !dispatchedStorage &&
          !state.scenePending &&
          state.requests.length === 0,
        "TC_SERVICE_BUSY",
        "Cannot adopt storage while a dispatch or queued save/load/scene request is active.",
      );
      dispatchedStorage = { type, id: slot };
    },
    storageComplete(type, slot, error) {
      alive();
      check(
        type === "save" || type === "load",
        "TC_STORAGE_COMPLETION",
        "Completion type must be save/load.",
      );
      name(slot, "TC_STORAGE_SLOT", "Storage slot");
      check(
        error === undefined || typeof error === "string",
        "TC_STORAGE_COMPLETION",
        "Completion error must be a string.",
      );
      check(
        dispatchedStorage?.type === type &&
          dispatchedStorage.id === slot &&
          !state.scenePending &&
          state.requests.length === 0 &&
          (type === "load" ||
            (state.storage.slot === slot && state.storage.state === "saving")),
        "TC_STORAGE_COMPLETION",
        "Completion must match a dispatched active request.",
      );
      dispatchedStorage = null;
      state.requestTick = state.tick;
      state.storage = {
        state:
          error === undefined
            ? type === "save"
              ? "saved"
              : "loaded"
            : "failed",
        slot,
        error: error ?? null,
      };
    },
    completeVoice(id) {
      alive();
      name(id, "TC_AUDIO_VOICE", "Voice id");
      state.audio.voices = state.audio.voices.filter(
        (voice) => voice.id !== id,
      );
    },
    audioClock() {
      alive();
      return {
        tick: state.tick,
        fixedDt: state.fixedDt,
        revision: audioRevision,
        versions: Object.fromEntries(state.audio.voices.map((voice) => [voice.id, voiceVersions.get(voice) ?? 0])),
      };
    },
  };
}
