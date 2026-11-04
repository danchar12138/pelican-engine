import type { SceneIR } from "../../compiler/src/types.ts";
import type { AnimationService } from "../../sdk/src/index.ts";
import type {
  RuntimePlugin,
  RuntimePluginContext,
  RuntimePluginFactory,
  RuntimeServices,
} from "./plugins.ts";
import { cloneSerializable } from "./random.ts";

type Camera = NonNullable<SceneIR["scene"]["follow"]>;
type UI = NonNullable<SceneIR["ui"]>;
type StorageState = ReturnType<RuntimeServices["storage"]["status"]>;
export interface GameServiceRequest {
  type: "save" | "load" | "scene";
  id: string;
}
export interface GameServicesInspection {
  input: { held: string[]; pressed: string[]; released: string[] };
  camera: Camera | null;
  ui: SceneIR["ui"];
  audio: {
    volume: number;
    voices: {
      id: string;
      sound: string;
      volume: number;
      loop: boolean;
      entity: string | null;
      startedAt: number;
    }[];
  };
  storage: StorageState;
  scene: string;
}
export interface GameServicesDriver {
  factory: RuntimePluginFactory;
  inspect(): GameServicesInspection;
  takeRequests(): GameServiceRequest[];
  /** Platform transaction handoff only; never exposed through the gameplay SDK. */
  adoptStorageRequest(type: "save" | "load", slot: string): void;
  storageComplete(type: "save" | "load", slot: string, error?: string): void;
  completeVoice(id: string): void;
}

/** A failed play never evicts an existing voice or consumes an id. */
export const GAME_SERVICES_MAX_VOICES = 32;
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
    value && typeof value === "object" && Object.hasOwn(value, "world")
      ? [...UI_FIELDS, "world"]
      : UI_FIELDS,
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
  check(typeof ui.color === "string", code, "Invalid UI color.");
}

/** Pure deterministic gameplay state. The caller owns platform I/O and the animation adapter. */
export function createGameServices(
  ir: SceneIR,
  animation: AnimationService,
): GameServicesDriver {
  const sceneId = ir.scene.id;
  const gameId = ir.gameId;
  const bindings = cloneSerializable(ir.input ?? {});
  const initialUI = cloneSerializable(ir.ui ?? []);
  const sounds = cloneSerializable(ir.sounds ?? []);
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
    durations,
    camera: initialCamera,
    assets: ir.assets.filter((asset) =>
      sounds.some((sound) => sound.asset === asset.id),
    ),
  });
  const definitionKey = canonical(definitions);
  const initial = () => ({
    format: "threecat.game-services" as const,
    version: 1 as const,
    definitions,
    tick: 0,
    fixedDt: null as number | null,
    input: {
      keys: [] as string[],
      held: [] as string[],
      pressed: [] as string[],
      released: [] as string[],
    },
    camera: cloneSerializable(initialCamera),
    ui: cloneSerializable(initialUI),
    audio: {
      volume: 1,
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
      setText(id, text) {
        const item = ui(id);
        check(item.kind !== "bar", "TC_UI_KIND", `UI ${id} is a progress bar.`);
        check(
          typeof text === "string",
          "TC_UI_VALUE",
          `UI ${id} text must be a string.`,
        );
        item.text = text;
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
              ["volume", "loop", "entity"].includes(key),
            ),
          "TC_AUDIO_VALUE",
          "Unknown audio options.",
        );
        const volume = Object.hasOwn(values, "volume")
          ? values.volume
          : sound.volume;
        const loop = Object.hasOwn(values, "loop") ? values.loop : sound.loop;
        finite(volume, "TC_AUDIO_VOLUME", `Sound ${id} volume`, 0, 1);
        check(
          typeof loop === "boolean",
          "TC_AUDIO_VALUE",
          `Sound ${id} loop must be boolean.`,
        );
        if (Object.hasOwn(values, "entity"))
          target(values.entity!, "TC_AUDIO_TARGET");
        check(
          state.audio.voices.length < GAME_SERVICES_MAX_VOICES,
          "TC_AUDIO_VOICE_LIMIT",
          `At most ${GAME_SERVICES_MAX_VOICES} voices may play; stop or complete a voice before retrying.`,
        );
        check(
          state.audio.nextVoice < Number.MAX_SAFE_INTEGER,
          "TC_AUDIO_VOICE_LIMIT",
          "Voice id counter exhausted; create a new runtime.",
        );
        const voice = `voice:${state.audio.nextVoice}`;
        state.audio.voices.push({
          id: voice,
          sound: id,
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
      volume(value) {
        alive();
        finite(value, "TC_AUDIO_VOLUME", "Master volume", 0, 1);
        state.audio.volume = value;
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
      input: { held, pressed, released },
      camera: state.camera,
      ui: state.ui,
      audio: { volume: state.audio.volume, voices: state.audio.voices },
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
      data.format === "threecat.game-services" && data.version === 1,
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
    object(data.input, ["keys", "held", "pressed", "released"], SNAPSHOT_ERROR);
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
        Object.values(data.input).every((items) => items.length === 0),
        SNAPSHOT_ERROR,
        "Initial input must be empty.",
      );
    if (data.camera !== null) cameraValue(data.camera, SNAPSHOT_ERROR);
    check(
      Array.isArray(data.ui) && data.ui.length === initialUI.length,
      SNAPSHOT_ERROR,
      "UI definitions differ.",
    );
    for (let i = 0; i < data.ui.length; i++) {
      const item = data.ui[i];
      uiValue(item, SNAPSHOT_ERROR);
      const original = initialUI[i];
      const immutable = (element: UI[number]) => {
        const {
          text: _text,
          value: _value,
          visible: _visible,
          ...rest
        } = element;
        return rest;
      };
      check(
        canonical(immutable(item)) === canonical(immutable(original)),
        SNAPSHOT_ERROR,
        "Immutable UI layout differs.",
      );
      if (item.kind === "bar")
        check(
          item.text === original.text,
          SNAPSHOT_ERROR,
          "Progress bar text cannot change.",
        );
      else
        check(
          item.value === original.value,
          SNAPSHOT_ERROR,
          "Non-bar progress cannot change.",
        );
    }
    object(data.audio, ["volume", "voices", "nextVoice"], SNAPSHOT_ERROR);
    finite(data.audio.volume, SNAPSHOT_ERROR, "Master volume", 0, 1);
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
        ["id", "sound", "volume", "loop", "entity", "startedAt"],
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
      finite(voice.volume, SNAPSHOT_ERROR, "Voice volume", 0, 1);
      check(
        typeof voice.loop === "boolean",
        SNAPSHOT_ERROR,
        "Invalid voice loop.",
      );
      if (voice.entity !== null)
        name(voice.entity, SNAPSHOT_ERROR, "Voice entity");
      integer(voice.startedAt, SNAPSHOT_ERROR, "Voice startedAt");
      check(
        voice.startedAt <= data.tick,
        SNAPSHOT_ERROR,
        "Voice starts in the future.",
      );
      const duration = durations[voice.sound];
      check(
        voice.loop ||
          duration === null ||
          data.fixedDt === null ||
          (data.tick - voice.startedAt) * data.fixedDt < duration ||
          voice.startedAt === data.tick,
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
              ["id", "text", "composing"],
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
            ui(payload.id, "input").text = payload.text;
          }
          const held = new Set(state.input.held);
          const pressed = new Set<string>();
          const released = new Set<string>();
          for (const event of context!.events("input.key")) {
            const payload = object(
              event.payload,
              ["key", "pressed"],
              "TC_INPUT_EVENT",
            );
            inputKey(payload.key, "TC_INPUT_EVENT");
            check(
              typeof payload.pressed === "boolean",
              "TC_INPUT_EVENT",
              "pressed must be boolean.",
            );
            if (!knownKeys.has(payload.key)) continue;
            if (payload.pressed) keys.add(payload.key);
            else keys.delete(payload.key);
            for (const id of actions) {
              const down = bindings[id].some((key) => keys.has(key));
              if (down && !held.has(id)) pressed.add(id);
              if (!down && held.has(id)) released.add(id);
              if (down) held.add(id);
              else held.delete(id);
            }
          }
          state.tick++;
          state.fixedDt = dt;
          state.input = {
            keys: [...keys].sort(),
            held: [...held].sort(),
            pressed: [...pressed].sort(),
            released: [...released].sort(),
          };
          state.audio.voices = state.audio.voices.filter(
            (voice) =>
              voice.loop ||
              durations[voice.sound] === null ||
              (state.tick - voice.startedAt) * dt < durations[voice.sound]!,
          );
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
  };
}
