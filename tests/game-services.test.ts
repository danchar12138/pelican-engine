import assert from "node:assert/strict";
import test from "node:test";
import type { SceneIR } from "../packages/compiler/src/types.ts";
import {
  SDK_VERSION,
  defineGame,
  defineScene,
  defineSystem,
  instantiateGame,
  type AnimationService,
  type SystemContext,
  type SystemDefinition,
} from "../packages/sdk/src/index.ts";
import {
  createGameServices,
  GAME_SERVICES_MAX_VOICES,
} from "../packages/runtime/src/game-services.ts";
import { RuntimeHost } from "../packages/runtime/src/host.ts";
import type { RuntimePlugin } from "../packages/runtime/src/plugins.ts";

const source = { file: "game.ts", line: 1, column: 1, length: 1 };

test("services UI input commits Chinese text before gameplay and restores the same text with world anchor metadata", () => {
  const ir = fixture();
  ir.ui!.push({
    id: "name",
    kind: "input",
    text: "",
    value: 0,
    visible: true,
    anchor: "top-left",
    x: 0,
    y: 0,
    width: 180,
    color: "white",
    world: { entity: "player", offset: [0, 1, 0], occlude: true },
  });
  ir.systems = [{ id: "game-input", phase: "input", source }];
  const observed: string[] = [];
  const r = rig({
    ir,
    input: (ctx) => {
      observed.push(
        ctx.ui
          ? ctx
              .events("ui.text")
              .map((event) => (event.payload as any).text)
              .join("")
          : "",
      );
    },
  });
  try {
    r.host.emitExternal("ui.text", {
      id: "name",
      text: "\u4f60\u597d",
      composing: false,
    });
    r.host.step();
    assert.equal(
      r.driver.inspect().ui!.find((ui) => ui.id === "name")!.text,
      "\u4f60\u597d",
    );
    assert.ok(observed.includes("\u4f60\u597d"));
    const saved = r.host.snapshot();
    r.services.ui.setText("name", "changed");
    r.host.restore(saved);
    assert.equal(
      r.driver.inspect().ui!.find((ui) => ui.id === "name")!.text,
      "\u4f60\u597d",
    );
    const bad = structuredClone(saved);
    (bad.plugins!["game-services"].payload as any).ui.find(
      (ui: any) => ui.id === "name",
    ).world.offset = [0, NaN, 0];
    assert.throws(() => r.host.restore(bad), /TC_/);
    assert.equal(
      r.driver.inspect().ui!.find((ui) => ui.id === "name")!.text,
      "\u4f60\u597d",
    );
  } finally {
    r.host.dispose();
  }
});

test("services UI input rejects in-progress composition, unknown fields and oversized values before editing content", () => {
  for (const payload of [
    { id: "name", text: "draft", composing: true },
    { id: "name", text: "x", composing: false, rawEvent: {} },
    { id: "name", text: "x".repeat(4097), composing: false },
  ]) {
    const ir = fixture();
    ir.ui!.push({
      id: "name",
      kind: "input",
      text: "original",
      value: 0,
      visible: true,
      anchor: "top-left",
      x: 0,
      y: 0,
      width: 100,
      color: "white",
    });
    const r = rig({ ir });
    try {
      r.host.emitExternal("ui.text", payload);
      assert.throws(() => r.host.step(), /TC_UI_INPUT_EVENT/);
      assert.equal(
        r.driver.inspect().ui!.find((ui) => ui.id === "name")!.text,
        "original",
      );
    } finally {
      r.host.dispose();
    }
  }
});
function fixture(systems: readonly SystemDefinition[] = []): SceneIR {
  const scene: SceneIR["scene"] = {
    id: "field",
    camera: {
      position: [0, 2, 5],
      target: [0, 0, 0],
      fov: 50,
      near: 0.1,
      far: 100,
    },
    follow: {
      entity: "player",
      distance: 5,
      height: 2,
      lookHeight: 1,
      yaw: 0,
      smoothing: 0.1,
    },
    environment: { background: "#000000", ambientIntensity: 1 },
    gravity: [0, -9.81, 0],
    entities: [
      {
        id: "player",
        transform: {
          position: [0, 0, 0],
          rotation: [0, 0, 0],
          scale: [1, 1, 1],
        },
        components: {},
      },
    ],
  };
  return {
    format: "threecat.scene",
    version: 1,
    engineVersion: SDK_VERSION,
    gameId: "services-test",
    scene,
    scenes: [{ ...structuredClone(scene), id: "next" }],
    input: {
      left: ["KeyA", "ArrowLeft"],
      right: ["KeyD"],
      jump: ["Space", " "],
      confirm: ["ui:confirm"],
      shared: ["Space", " ", "KeyJ"],
    },
    ui: [
      {
        id: "label",
        kind: "text",
        text: "Ready",
        value: 0,
        visible: true,
        anchor: "top-left",
        x: 10,
        y: 10,
        width: 150,
        color: "#ffffff",
      },
      {
        id: "health",
        kind: "bar",
        text: "",
        value: 1,
        visible: true,
        anchor: "top-left",
        x: 10,
        y: 40,
        width: 150,
        color: "#00ff00",
      },
      {
        id: "confirm",
        kind: "button",
        text: "Go",
        value: 0,
        visible: true,
        anchor: "center",
        x: 0,
        y: 0,
        width: 100,
        color: "#ffffff",
      },
      {
        id: "unmapped",
        kind: "button",
        text: "No action",
        value: 0,
        visible: true,
        anchor: "center",
        x: 0,
        y: 30,
        width: 100,
        color: "#ffffff",
      },
    ],
    sounds: [
      { id: "hit", asset: "short", volume: 0.7, loop: false },
      { id: "ambient", asset: "unknown-duration", volume: 1, loop: true },
      { id: "unknown", asset: "unknown-duration", volume: 0.5, loop: false },
    ],
    assets: [
      {
        id: "short",
        type: "audio",
        path: "short.wav",
        sourcePath: "short.wav",
        hash: "short",
        metadata: { duration: 0.25 },
        source,
      },
      {
        id: "unknown-duration",
        type: "audio",
        path: "unknown.wav",
        sourcePath: "unknown.wav",
        hash: "unknown",
        source,
      },
    ],
    components: [],
    prefabs: [],
    materials: [],
    computes: [],
    systems: systems.map((system) => ({
      id: system.id,
      phase: system.phase ?? "update",
      source,
    })),
  };
}
function rig(
  options: {
    ir?: SceneIR;
    animation?: AnimationService;
    input?: (context: SystemContext) => void;
    update?: (context: SystemContext) => void;
    fixedDt?: number;
  } = {},
) {
  const systems = [
    ...(options.input
      ? [defineSystem({ id: "game-input", phase: "input", run: options.input })]
      : []),
    ...(options.update
      ? [
          defineSystem({
            id: "game-update",
            phase: "update",
            run: options.update,
          }),
        ]
      : []),
  ];
  const ir = options.ir ?? fixture(systems);
  const animation = options.animation ?? {
    play() {},
    state: () => ({ clip: null, time: 0, playing: false }),
  };
  const driver = createGameServices(ir, animation);
  let plugin!: RuntimePlugin;
  const host = new RuntimeHost(ir, {
    fixedDt: options.fixedDt ?? 0.125,
    plugins: [
      (context) => {
        plugin = driver.factory(context);
        return plugin;
      },
    ],
  });
  const game = instantiateGame(
    defineGame({
      id: ir.gameId,
      scene: defineScene({ id: ir.scene.id, entities: [] }),
      systems,
    }),
    host.facade,
  );
  host.attach(game);
  return { host, driver, plugin, ir, services: host.facade };
}

test("services: fixed driver contract, resolved copies, single host ownership and optional definitions", () => {
  const { host, driver, plugin, ir } = rig();
  try {
    assert.deepEqual(Object.keys(driver).sort(), [
      "adoptStorageRequest",
      "completeVoice",
      "factory",
      "inspect",
      "storageComplete",
      "takeRequests",
    ]);
    assert.deepEqual(host.inspect().plugins.services, [
      "animation",
      "audio",
      "camera",
      "input",
      "scenes",
      "storage",
      "ui",
    ]);
    assert.equal(plugin.id, "game-services");
    assert.deepEqual(
      plugin.systems?.map((system) => [system.id, system.phase]),
      [["$engine.input", "input"]],
    );
    const state = driver.inspect();
    assert.deepEqual(state, {
      input: { held: [], pressed: [], released: [] },
      camera: ir.scene.follow,
      ui: ir.ui,
      audio: { volume: 1, voices: [] },
      storage: { state: "idle", slot: null, error: null },
      scene: "field",
    });
    state.ui![0].text = "changed";
    state.camera!.yaw = 8;
    state.input.held.push("jump");
    assert.equal(driver.inspect().ui![0].text, "Ready");
    assert.equal(driver.inspect().camera!.yaw, 0);
    assert.deepEqual(driver.inspect().input.held, []);
    assert.throws(
      () => new RuntimeHost(ir, { plugins: [driver.factory] }),
      /TC_SERVICE_BOUND/,
    );
  } finally {
    host.dispose();
  }
  const empty = fixture();
  delete empty.input;
  delete empty.ui;
  delete empty.sounds;
  delete empty.scene.follow;
  delete empty.scenes;
  const minimal = rig({ ir: empty });
  try {
    assert.deepEqual(minimal.driver.inspect().ui, []);
    assert.equal(minimal.driver.inspect().camera, null);
    minimal.host.step();
    assert.equal(minimal.host.replay({}).status, "failed");
  } finally {
    minimal.host.dispose();
  }
});

test("services input: real host runs engine first, aggregates bindings, ignores repeat and unmapped UI", () => {
  const observations: unknown[] = [];
  const { host, services, driver } = rig({
    input(context) {
      observations.push([
        context.time.tick,
        context.input.held("left"),
        context.input.pressed("left"),
        context.input.released("left"),
        context.input.axis("left", "right"),
      ]);
    },
  });
  try {
    host.input("KeyA", true);
    host.step();
    host.input("KeyA", true);
    host.input("ArrowLeft", true);
    host.step();
    host.input("KeyA", false);
    host.step();
    host.input("ArrowLeft", false);
    host.step();
    host.step();
    assert.deepEqual(observations, [
      [1, true, true, false, -1],
      [2, true, false, false, -1],
      [3, true, false, false, -1],
      [4, false, false, true, 0],
      [5, false, false, false, 0],
    ]);
    host.input("Space", true);
    host.input("ui:confirm", true);
    host.input("ui:unmapped", true);
    host.step();
    assert.deepEqual(driver.inspect().input, {
      held: ["confirm", "jump", "shared"],
      pressed: ["confirm", "jump", "shared"],
      released: [],
    });
    assert.equal(services.input.pressed("confirm"), true);
    host.input("KeyA", true);
    host.input("KeyD", true);
    host.step();
    assert.equal(services.input.axis("left", "right"), 0);
    for (const method of ["held", "pressed", "released"] as const)
      assert.throws(() => services.input[method]("missing"), /TC_INPUT_ACTION/);
    assert.throws(
      () => services.input.axis("left", "missing"),
      /TC_INPUT_ACTION/,
    );
  } finally {
    host.dispose();
  }
});

test("services input: ordered press/release/repress preserves all same-tick transitions", () => {
  const { host, driver } = rig();
  try {
    host.input("Space", true);
    host.input("Space", false);
    host.input("Space", true);
    host.step();
    assert.deepEqual(driver.inspect().input, {
      held: ["jump", "shared"],
      pressed: ["jump", "shared"],
      released: ["jump", "shared"],
    });
    host.input("Space", false);
    host.input("Space", false);
    host.step();
    assert.deepEqual(driver.inspect().input, {
      held: [],
      pressed: [],
      released: ["jump", "shared"],
    });
    host.step();
    assert.deepEqual(driver.inspect().input, {
      held: [],
      pressed: [],
      released: [],
    });
  } finally {
    host.dispose();
  }
});

test("services input: malformed external input fails explicitly before service state changes", () => {
  const { host, plugin } = rig();
  try {
    const before = plugin.snapshot();
    host.emitExternal("input.key", { key: "Space", pressed: "yes" });
    assert.throws(() => host.step(), /TC_INPUT_EVENT/);
    assert.match(host.inspect().scheduler.fault!.message, /TC_INPUT_EVENT/);
    assert.deepEqual(plugin.snapshot(), before);
  } finally {
    host.dispose();
  }
});

test("services animation: exact adapter passthrough, animation state excluded from service snapshots", () => {
  const calls: unknown[] = [];
  const expected = { clip: "walk", time: 1.25, playing: true };
  const adapter: AnimationService = {
    play(...args) {
      calls.push(args);
    },
    state(entity) {
      calls.push(entity);
      return expected;
    },
  };
  const { host, services, plugin } = rig({ animation: adapter });
  try {
    const before = plugin.snapshot();
    const options = { fade: 0.2, speed: 2, loop: false };
    services.animation.play("player", "walk", options);
    assert.equal(services.animation.state("player"), expected);
    assert.deepEqual(calls, [["player", "walk", options], "player"]);
    assert.equal((calls[0] as unknown[])[2], options);
    assert.deepEqual(plugin.snapshot(), before);
  } finally {
    host.dispose();
  }
});

test("services camera/UI: follow defaults, incremental orbit, typed mutations and strict validation", () => {
  const { host, services, driver, plugin } = rig();
  try {
    services.camera.follow("player", { yaw: 0.5, distance: 3, smoothing: 0 });
    services.camera.orbit(0.25);
    services.camera.orbit(-0.1);
    assert.deepEqual(driver.inspect().camera, {
      entity: "player",
      distance: 3,
      height: 2,
      lookHeight: 1,
      yaw: 0.65,
      smoothing: 0,
    });
    services.ui.setText("label", "Score: 2");
    services.ui.setText("confirm", "Retry");
    services.ui.setProgress("health", 0.25);
    services.ui.setVisible("label", false);
    assert.equal(driver.inspect().ui![0].text, "Score: 2");
    assert.equal(driver.inspect().ui![0].visible, false);
    assert.equal(driver.inspect().ui![1].value, 0.25);
    const before = plugin.snapshot();
    const invalid = [
      () => services.camera.follow("missing"),
      () => services.camera.follow("player", { distance: 0 }),
      () => services.camera.follow("player", { height: -1 }),
      () => services.camera.follow("player", { smoothing: 1.1 }),
      () => services.camera.follow("player", { lookHeight: NaN }),
      () => services.camera.orbit(Infinity),
      () => services.ui.setText("missing", "x"),
      () => services.ui.setProgress("label", 0.5),
      () => services.ui.setText("health", "x"),
      () => services.ui.setProgress("health", -0.1),
      () => services.ui.setProgress("health", Infinity),
      () => services.ui.setVisible("label", 1 as unknown as boolean),
      () => services.ui.setText("label", 1 as unknown as string),
    ];
    for (const attempt of invalid) assert.throws(attempt, /TC_/);
    assert.deepEqual(plugin.snapshot(), before);
    host.world.destroy("player");
    assert.throws(() => services.camera.follow("player"), /TC_CAMERA_TARGET/);
    assert.throws(
      () => services.audio.play("hit", { entity: "player" }),
      /TC_AUDIO_TARGET/,
    );
  } finally {
    host.dispose();
  }
  const ir = fixture();
  delete ir.scene.follow;
  const noFollow = rig({ ir });
  try {
    assert.throws(() => noFollow.services.camera.orbit(1), /TC_CAMERA_FOLLOW/);
  } finally {
    noFollow.host.dispose();
  }
});

test("services audio: deterministic ids/ticks, definition defaults, limits and stable explicit completion", () => {
  const { host, driver, services, plugin } = rig();
  try {
    host.step(2);
    const first = services.audio.play("hit");
    const second = services.audio.play("ambient", {
      volume: 0.2,
      loop: false,
      entity: "player",
    });
    services.audio.volume(0.4);
    assert.equal(first, "voice:1");
    assert.equal(second, "voice:2");
    assert.deepEqual(driver.inspect().audio, {
      volume: 0.4,
      voices: [
        {
          id: first,
          sound: "hit",
          volume: 0.7,
          loop: false,
          entity: null,
          startedAt: 2,
        },
        {
          id: second,
          sound: "ambient",
          volume: 0.2,
          loop: false,
          entity: "player",
          startedAt: 2,
        },
      ],
    });
    const before = plugin.snapshot();
    for (const attempt of [
      () => services.audio.volume(NaN),
      () => services.audio.volume(1.1),
      () => services.audio.play("missing"),
      () => services.audio.play("hit", { volume: -1 }),
      () => services.audio.play("hit", { loop: 1 as unknown as boolean }),
      () => services.audio.play("hit", { entity: "missing" }),
    ])
      assert.throws(attempt, /TC_/);
    assert.deepEqual(plugin.snapshot(), before);
    services.audio.stop(first);
    driver.completeVoice(first);
    driver.completeVoice(second);
    driver.completeVoice(second);
    assert.deepEqual(driver.inspect().audio.voices, []);
    for (let index = 0; index < GAME_SERVICES_MAX_VOICES; index++)
      services.audio.play("unknown");
    const full = plugin.snapshot();
    assert.throws(() => services.audio.play("unknown"), /TC_AUDIO_VOICE_LIMIT/);
    assert.deepEqual(plugin.snapshot(), full);
    services.audio.stop("voice:3");
    assert.equal(
      services.audio.play("unknown"),
      `voice:${GAME_SERVICES_MAX_VOICES + 3}`,
    );
  } finally {
    host.dispose();
  }
});

test("services audio: metadata duration expires deterministically at fixed ticks, loops and unknown durations persist", () => {
  const { host, driver, services, plugin } = rig();
  try {
    host.step();
    const short = services.audio.play("hit");
    const loop = services.audio.play("hit", { loop: true });
    const unknown = services.audio.play("unknown");
    host.step();
    assert.deepEqual(
      driver.inspect().audio.voices.map((voice) => voice.id),
      [short, loop, unknown],
    );
    const checkpoint = host.snapshot();
    host.step();
    assert.deepEqual(
      driver.inspect().audio.voices.map((voice) => voice.id),
      [loop, unknown],
    );
    const result = plugin.snapshot();
    host.restore(checkpoint);
    host.step();
    assert.deepEqual(plugin.snapshot(), result);
    host.step(10);
    assert.deepEqual(
      driver.inspect().audio.voices.map((voice) => voice.id),
      [loop, unknown],
    );
  } finally {
    host.dispose();
  }
});

test("services storage/scenes: drained requests, completion failure/retry and shared same-tick exclusion", () => {
  const { host, driver, services, plugin } = rig();
  try {
    assert.equal(services.scenes.current(), "field");
    assert.throws(() => services.scenes.load("missing"), /TC_SCENE_ID/);
    assert.throws(() => services.storage.save(""), /TC_STORAGE_SLOT/);
    services.storage.save("slot-a");
    assert.deepEqual(services.storage.status(), {
      state: "saving",
      slot: "slot-a",
      error: null,
    });
    assert.throws(
      () => driver.storageComplete("save", "slot-a"),
      /TC_STORAGE_COMPLETION/,
    );
    assert.deepEqual(driver.takeRequests(), [{ type: "save", id: "slot-a" }]);
    assert.deepEqual(driver.takeRequests(), []);
    assert.throws(() => services.storage.load("slot-b"), /TC_SERVICE_BUSY/);
    assert.throws(() => services.scenes.load("next"), /TC_SERVICE_BUSY/);
    assert.throws(
      () => driver.storageComplete("load", "slot-a"),
      /TC_STORAGE_COMPLETION/,
    );
    assert.throws(
      () => driver.storageComplete("save", "slot-b"),
      /TC_STORAGE_COMPLETION/,
    );
    driver.storageComplete("save", "slot-a", "quota exceeded");
    assert.deepEqual(services.storage.status(), {
      state: "failed",
      slot: "slot-a",
      error: "quota exceeded",
    });
    assert.throws(() => services.storage.save("slot-a"), /TC_SERVICE_BUSY/);
    host.step();
    services.storage.save("slot-a");
    assert.equal(services.storage.status().error, null);
    assert.deepEqual(driver.takeRequests(), [{ type: "save", id: "slot-a" }]);
    driver.storageComplete("save", "slot-a");
    assert.deepEqual(services.storage.status(), {
      state: "saved",
      slot: "slot-a",
      error: null,
    });
    assert.throws(
      () => driver.storageComplete("save", "slot-a"),
      /TC_STORAGE_COMPLETION/,
    );
    host.step();
    services.storage.load("slot-a");
    assert.deepEqual(driver.takeRequests(), [{ type: "load", id: "slot-a" }]);
    driver.storageComplete("load", "slot-a");
    assert.deepEqual(services.storage.status(), {
      state: "loaded",
      slot: "slot-a",
      error: null,
    });
    host.step();
    services.scenes.load("next");
    assert.deepEqual(driver.takeRequests(), [{ type: "scene", id: "next" }]);
    assert.equal(services.scenes.current(), "field");
    const checkpoint = plugin.snapshot();
    host.step();
    assert.throws(() => services.storage.save("slot-b"), /TC_SERVICE_BUSY/);
    plugin.restore(checkpoint);
    assert.deepEqual(driver.takeRequests(), []);
  } finally {
    host.dispose();
  }
});

test("services snapshots: capture all deterministic state, restore atomically, never snapshot animation or leak copies", () => {
  const { host, driver, services, plugin } = rig();
  try {
    host.input("KeyA", true);
    host.step();
    services.camera.orbit(0.5);
    services.ui.setProgress("health", 0.75);
    services.ui.setVisible("confirm", false);
    services.audio.play("unknown");
    services.audio.volume(0.25);
    services.storage.save("slot");
    assert.deepEqual(driver.takeRequests(), [{ type: "save", id: "slot" }]);
    const snapshot = host.snapshot();
    const inspection = driver.inspect();
    driver.storageComplete("save", "slot");
    host.input("KeyA", false);
    host.step(2);
    services.camera.orbit(3);
    services.ui.setProgress("health", 0);
    services.audio.stop("voice:1");
    host.restore(snapshot);
    assert.deepEqual(driver.inspect(), inspection);
    assert.deepEqual(host.snapshot(), snapshot);
    assert.deepEqual(driver.takeRequests(), []);
    assert.equal(services.audio.play("unknown"), "voice:2");
    const before = plugin.snapshot();
    const corrupt = JSON.parse(JSON.stringify(before));
    corrupt.ui[0].width = 500;
    assert.throws(() => plugin.restore(corrupt), /TC_SERVICES_SNAPSHOT/);
    assert.deepEqual(plugin.snapshot(), before);
    const leaked = JSON.parse(JSON.stringify(plugin.snapshot()));
    leaked.input.keys.length = 0;
    assert.deepEqual(plugin.snapshot(), before);
  } finally {
    host.dispose();
  }
});

test("services snapshots: exhaustive schema, action/key types, definitions, references and coupled fields", () => {
  const { host, services, plugin } = rig();
  try {
    host.input("Space", true);
    host.step();
    services.audio.play("unknown");
    const snapshot = plugin.snapshot();
    // Intentionally malformed untrusted JSON payloads exercise the public unknown boundary.
    const mutations: ((data: any) => void)[] = [
      (d) => {
        d.extra = true;
      },
      (d) => {
        delete d.camera;
      },
      (d) => {
        d.version = 2;
      },
      (d) => {
        d.tick = -1;
      },
      (d) => {
        d.tick = 0.5;
      },
      (d) => {
        d.fixedDt = 0;
      },
      (d) => {
        d.definitions.bindings.jump = ["KeyX"];
      },
      (d) => {
        d.definitions.ui[0].text = "changed default";
      },
      (d) => {
        d.definitions.sounds[0].volume = 0.2;
      },
      (d) => {
        d.definitions.durations.hit = 10;
      },
      (d) => {
        d.input.keys = ["unknown"];
      },
      (d) => {
        d.input.keys = [1];
      },
      (d) => {
        d.input.held = [];
      },
      (d) => {
        d.input.pressed = ["missing"];
      },
      (d) => {
        d.input.released = [false];
      },
      (d) => {
        d.input.keys = ["Space", "Space"];
      },
      (d) => {
        d.input.extra = [];
      },
      (d) => {
        d.camera.distance = 0;
      },
      (d) => {
        d.camera.yaw = Infinity;
      },
      (d) => {
        d.camera.entity = 123;
      },
      (d) => {
        d.camera.extra = 1;
      },
      (d) => {
        d.ui.pop();
      },
      (d) => {
        d.ui[0].id = "missing";
      },
      (d) => {
        d.ui[1].value = 2;
      },
      (d) => {
        d.ui[0].visible = "true";
      },
      (d) => {
        d.ui[0].anchor = "bad";
      },
      (d) => {
        d.ui[0].kind = "bar";
      },
      (d) => {
        d.ui[0].width = 0;
      },
      (d) => {
        d.ui[1].text = "forbidden";
      },
      (d) => {
        d.ui[0].value = 1;
      },
      (d) => {
        d.audio.volume = -1;
      },
      (d) => {
        d.audio.nextVoice = 1;
      },
      (d) => {
        d.audio.voices[0].id = "voice:01";
      },
      (d) => {
        d.audio.voices[0].id = "voice:2";
      },
      (d) => {
        d.audio.voices[0].sound = "missing";
      },
      (d) => {
        d.audio.voices[0].volume = 2;
      },
      (d) => {
        d.audio.voices[0].loop = 0;
      },
      (d) => {
        d.audio.voices[0].entity = {};
      },
      (d) => {
        d.audio.voices[0].startedAt = 2;
      },
      (d) => {
        d.audio.voices.push({ ...d.audio.voices[0] });
      },
      (d) => {
        d.storage.state = "bad";
      },
      (d) => {
        d.storage.error = "bad";
      },
      (d) => {
        d.storage.slot = "wrong";
      },
      (d) => {
        d.storage.state = "saving";
      },
      (d) => {
        d.scene = "next";
      },
      (d) => {
        d.scenePending = 1;
      },
      (d) => {
        d.requestTick = 5;
      },
      (d) => {
        d.requests = [{ type: "save", id: "x" }];
      },
      (d) => {
        d.requests = [{ type: "scene", id: "missing" }];
      },
      (d) => {
        d.requests = [{ type: "bad", id: "x" }];
      },
      (d) => {
        d.requests = [{ type: "save", id: "x", extra: 1 }];
      },
    ];
    for (const mutate of mutations) {
      const bad = structuredClone(snapshot);
      mutate(bad);
      assert.throws(
        () => plugin.validateSnapshot(bad),
        /TC_SERVICES_SNAPSHOT/,
        mutate.toString(),
      );
      assert.throws(
        () => plugin.restore(bad),
        /TC_SERVICES_SNAPSHOT/,
        mutate.toString(),
      );
      assert.deepEqual(plugin.snapshot(), snapshot);
    }
    for (const bad of [
      null,
      [],
      { ...structuredClone(snapshot as object), ui: new Date() },
    ])
      assert.throws(() => plugin.restore(bad), /TC_SERVICES_SNAPSHOT/);
    const sparse = structuredClone(snapshot) as any;
    delete sparse.ui[1];
    assert.throws(() => plugin.restore(sparse), /TC_SERVICES_SNAPSHOT/);
    const accessor = structuredClone(snapshot) as any;
    Object.defineProperty(accessor.input, "keys", {
      enumerable: true,
      get() {
        throw new Error("getter must not run");
      },
    });
    assert.throws(() => plugin.restore(accessor), /TC_SERVICES_SNAPSHOT/);
    const cycle = structuredClone(snapshot) as any;
    cycle.input.keys = cycle;
    assert.throws(() => plugin.restore(cycle), /TC_SERVICES_SNAPSHOT/);
    assert.deepEqual(plugin.snapshot(), snapshot);
  } finally {
    host.dispose();
  }
});

test("services host: recording/replay reproduces input edges, UI, orbit, voice ids, duration expiry and pending requests", () => {
  const { host, driver, plugin } = rig({
    update(context) {
      if (context.input.pressed("jump")) {
        context.audio.play("hit");
        context.camera.orbit(0.25);
      }
      if (context.input.released("jump"))
        context.ui.setText("label", `Released at ${context.time.tick}`);
      if (context.input.pressed("confirm"))
        context.storage.save("recorded-slot");
    },
  });
  try {
    host.step(2);
    host.startRecording();
    host.input("Space", true);
    host.step();
    host.input("Space", true);
    host.step();
    host.input("Space", false);
    host.step();
    host.input("ui:confirm", true);
    host.step();
    const trace = host.stopRecording();
    const final = plugin.snapshot();
    const inspection = driver.inspect();
    assert.equal(inspection.ui![0].text, "Released at 5");
    assert.deepEqual(inspection.audio.voices, []);
    assert.deepEqual(host.replay(trace).status, "passed");
    assert.deepEqual(driver.inspect(), inspection);
    assert.deepEqual(plugin.snapshot(), final);
    assert.deepEqual(driver.takeRequests(), [
      { type: "save", id: "recorded-slot" },
    ]);
    assert.equal(host.replay(trace).status, "passed");
    assert.deepEqual(driver.takeRequests(), [
      { type: "save", id: "recorded-slot" },
    ]);
  } finally {
    host.dispose();
  }
});

test("services host: invalid plugin payload leaves scheduler, world and service state untouched", () => {
  const { host, plugin } = rig();
  try {
    host.input("KeyA", true);
    host.step();
    const before = host.snapshot();
    const beforePlugin = plugin.snapshot();
    const bad = structuredClone(before);
    (bad.plugins!["game-services"].payload as any).input.keys = ["unknown"];
    bad.scheduler.tick += 1;
    bad.scheduler.time += bad.scheduler.fixedDt;
    assert.throws(() => host.restore(bad), /TC_SERVICES_SNAPSHOT/);
    assert.deepEqual(host.snapshot(), before);
    assert.deepEqual(plugin.snapshot(), beforePlugin);
  } finally {
    host.dispose();
  }
});

test("services lifecycle: all retained service/driver/plugin entry points reject after dispose", () => {
  const { host, driver, services, plugin } = rig();
  const retained = {
    input: services.input,
    animation: services.animation,
    camera: services.camera,
    ui: services.ui,
    audio: services.audio,
    storage: services.storage,
    scenes: services.scenes,
  };
  const snapshot = plugin.snapshot();
  host.dispose();
  const attempts = [
    () => retained.input.held("jump"),
    () => retained.input.pressed("jump"),
    () => retained.input.released("jump"),
    () => retained.input.axis("left", "right"),
    () => retained.animation.play("player", "walk"),
    () => retained.animation.state("player"),
    () => retained.camera.follow("player"),
    () => retained.camera.orbit(1),
    () => retained.ui.setText("label", "x"),
    () => retained.ui.setProgress("health", 0),
    () => retained.ui.setVisible("label", true),
    () => retained.audio.play("hit"),
    () => retained.audio.stop("voice:1"),
    () => retained.audio.volume(1),
    () => retained.storage.save("slot"),
    () => retained.storage.load("slot"),
    () => retained.storage.status(),
    () => retained.scenes.current(),
    () => retained.scenes.load("field"),
    () => driver.inspect(),
    () => driver.takeRequests(),
    () => driver.storageComplete("save", "slot"),
    () => driver.adoptStorageRequest("load", "slot"),
    () => driver.completeVoice("voice:1"),
    () => plugin.snapshot(),
    () => plugin.validateSnapshot(snapshot),
    () => plugin.restore(snapshot),
    () => plugin.systems![0].run(0.125),
  ];
  for (const attempt of attempts) assert.throws(attempt, /TC_SERVICE_DISPOSED/);
  plugin.dispose();
  host.dispose();
});

test("services input: literal Space key and UI down/up in one tick retain edges for exactly one tick", () => {
  const observations: unknown[] = [];
  const { host, services, driver } = rig({
    input(context) {
      observations.push([
        context.input.held("confirm"),
        context.input.pressed("confirm"),
        context.input.released("confirm"),
        context.input.pressed("jump"),
      ]);
    },
  });
  try {
    host.input(" ", true);
    host.input("ui:confirm", true);
    host.input("ui:confirm", false);
    host.step();
    assert.deepEqual(observations[0], [false, true, true, true]);
    assert.equal(services.input.held("jump"), true);
    assert.deepEqual(driver.inspect().input, {
      held: ["jump", "shared"],
      pressed: ["confirm", "jump", "shared"],
      released: ["confirm"],
    });
    host.step();
    assert.deepEqual(observations[1], [false, false, false, false]);
    host.input(" ", false);
    host.step();
    assert.equal(services.input.released("jump"), true);
    assert.equal(services.input.held("jump"), false);
  } finally {
    host.dispose();
  }
});

test("services storage: browser can dispatch load, restore saved snapshot, then complete the original load", () => {
  const { host, driver, services } = rig();
  try {
    host.step();
    services.ui.setText("label", "Saved state");
    services.storage.save("save-slot");
    assert.deepEqual(driver.takeRequests(), [
      { type: "save", id: "save-slot" },
    ]);
    const checkpoint = host.snapshot();
    driver.storageComplete("save", "save-slot");
    host.step();
    services.ui.setText("label", "Later state");
    services.storage.load("load-slot");
    assert.deepEqual(driver.takeRequests(), [
      { type: "load", id: "load-slot" },
    ]);
    host.restore(checkpoint);
    assert.equal(driver.inspect().ui![0].text, "Saved state");
    assert.deepEqual(driver.takeRequests(), []);
    assert.throws(
      () => driver.storageComplete("load", "wrong-slot"),
      /TC_STORAGE_COMPLETION/,
    );
    driver.storageComplete("load", "load-slot");
    assert.deepEqual(services.storage.status(), {
      state: "loaded",
      slot: "load-slot",
      error: null,
    });
    assert.throws(() => services.storage.save("load-slot"), /TC_SERVICE_BUSY/);
    host.step();
    services.storage.load("missing-slot");
    driver.takeRequests();
    driver.storageComplete("load", "missing-slot", "Save does not exist");
    assert.deepEqual(services.storage.status(), {
      state: "failed",
      slot: "missing-slot",
      error: "Save does not exist",
    });
    host.step();
    services.storage.load("load-slot");
    assert.deepEqual(driver.takeRequests(), [
      { type: "load", id: "load-slot" },
    ]);
  } finally {
    host.dispose();
  }
});

test("services snapshots: immutable definitions are detached from caller IR and incompatible games are rejected", () => {
  const { host, services, plugin, ir } = rig();
  try {
    const snapshot = plugin.snapshot();
    ir.scene.id = "mutated";
    ir.gameId = "mutated";
    ir.input!.jump = ["KeyX"];
    ir.ui![0].text = "mutated";
    ir.sounds![0].volume = 0;
    ir.assets[0].metadata!.duration = 10;
    assert.equal(services.scenes.current(), "field");
    plugin.restore(snapshot);
    assert.deepEqual(plugin.snapshot(), snapshot);
    const otherIR = fixture();
    otherIR.assets[0].hash = "different";
    const other = rig({ ir: otherIR });
    try {
      assert.throws(
        () => other.plugin.restore(snapshot),
        /TC_SERVICES_SNAPSHOT/,
      );
    } finally {
      other.host.dispose();
    }
  } finally {
    host.dispose();
  }
});

test("services: zero duration, finite options and malformed immutable definitions are checked", () => {
  const zero = fixture();
  zero.assets[0].metadata!.duration = 0;
  const { host, services, driver, plugin } = rig({ ir: zero });
  try {
    services.audio.play("hit");
    plugin.validateSnapshot(plugin.snapshot());
    host.step();
    assert.deepEqual(driver.inspect().audio.voices, []);
    const before = plugin.snapshot();
    for (const attempt of [
      () => services.audio.play("hit", { volume: null as unknown as number }),
      () => services.audio.play("hit", { loop: null as unknown as boolean }),
      () => services.audio.play("hit", { entity: null as unknown as string }),
      () => services.audio.play("hit", { extra: true } as never),
      () => services.camera.follow("player", { extra: true } as never),
      () => services.camera.follow("player", { smoothing: -0.1 }),
      () => services.camera.follow("player", { distance: Infinity }),
    ])
      assert.throws(attempt, /TC_/);
    assert.deepEqual(plugin.snapshot(), before);
    services.camera.follow("player", { smoothing: 0.15 });
    assert.equal(driver.inspect().camera!.smoothing, 0.15);
  } finally {
    host.dispose();
  }
  for (const mutate of [
    (ir: SceneIR) => {
      ir.scene.follow!.entity = "missing";
    },
    (ir: SceneIR) => {
      ir.scene.follow!.smoothing = 2;
    },
    (ir: SceneIR) => {
      ir.assets[0].metadata!.duration = NaN;
    },
    (ir: SceneIR) => {
      ir.assets[0].metadata!.duration = -1;
    },
    (ir: SceneIR) => {
      ir.assets[0].type = "binary";
    },
    (ir: SceneIR) => {
      ir.sounds![0].volume = Infinity;
    },
    (ir: SceneIR) => {
      ir.input!.jump = ["\n"];
    },
    (ir: SceneIR) => {
      ir.input!.jump = [" ", " "];
    },
  ]) {
    const ir = fixture();
    mutate(ir);
    assert.throws(
      () =>
        createGameServices(ir, {
          play() {},
          state: () => ({ clip: null, time: 0, playing: false }),
        }),
      /TC_/,
    );
  }
});

test("services storage adoption: validates platform requests without changing snapshots, status or queues", () => {
  const { host, driver, services, plugin } = rig();
  try {
    const before = host.snapshot();
    for (const type of ["scene", "", null, 1] as const) {
      assert.throws(
        () => driver.adoptStorageRequest(type as "load", "slot"),
        /TC_STORAGE_REQUEST/,
      );
    }
    for (const slot of [
      "",
      " ",
      "bad\nslot",
      "x".repeat(65),
      null,
      1,
    ] as const) {
      assert.throws(
        () => driver.adoptStorageRequest("load", slot as string),
        /TC_STORAGE_SLOT/,
      );
    }
    assert.deepEqual(host.snapshot(), before);
    driver.adoptStorageRequest("load", "platform-slot");
    assert.deepEqual(host.snapshot(), before);
    assert.deepEqual(driver.takeRequests(), []);
    assert.deepEqual(services.storage.status(), {
      state: "idle",
      slot: null,
      error: null,
    });
    assert.equal("adoptStorageRequest" in services.storage, false);
    assert.throws(
      () => driver.adoptStorageRequest("load", "other-slot"),
      /TC_SERVICE_BUSY/,
    );
    assert.throws(
      () => driver.adoptStorageRequest("save", "other-slot"),
      /TC_SERVICE_BUSY/,
    );
    assert.throws(() => services.storage.save("other-slot"), /TC_SERVICE_BUSY/);
    assert.throws(() => services.scenes.load("next"), /TC_SERVICE_BUSY/);
    assert.throws(
      () => driver.storageComplete("load", "other-slot"),
      /TC_STORAGE_COMPLETION/,
    );
    assert.throws(
      () => driver.storageComplete("save", "platform-slot"),
      /TC_STORAGE_COMPLETION/,
    );
    assert.deepEqual(host.snapshot(), before);
    driver.storageComplete("load", "platform-slot");
    assert.deepEqual(services.storage.status(), {
      state: "loaded",
      slot: "platform-slot",
      error: null,
    });
    assert.throws(
      () => driver.storageComplete("load", "platform-slot"),
      /TC_STORAGE_COMPLETION/,
    );
    host.step();
    services.storage.save("save-slot");
    driver.takeRequests();
    plugin.restore(plugin.snapshot());
    driver.adoptStorageRequest("save", "save-slot");
    driver.storageComplete("save", "save-slot");
    assert.deepEqual(services.storage.status(), {
      state: "saved",
      slot: "save-slot",
      error: null,
    });
  } finally {
    host.dispose();
  }
});

test("services storage adoption: queued storage, dispatched storage and scene ownership cannot be replaced", () => {
  for (const type of ["save", "load", "scene"] as const) {
    const { host, driver, services } = rig();
    try {
      if (type === "scene") services.scenes.load("next");
      else services.storage[type]("original-slot");
      const before = host.snapshot();
      assert.throws(
        () => driver.adoptStorageRequest("load", "adopted-slot"),
        /TC_SERVICE_BUSY/,
      );
      assert.deepEqual(host.snapshot(), before);
      assert.deepEqual(driver.takeRequests(), [
        { type, id: type === "scene" ? "next" : "original-slot" },
      ]);
      const dispatched = host.snapshot();
      assert.throws(
        () => driver.adoptStorageRequest("load", "adopted-slot"),
        /TC_SERVICE_BUSY/,
      );
      assert.deepEqual(host.snapshot(), dispatched);
      if (type !== "scene") {
        driver.storageComplete(type, "original-slot");
        assert.equal(
          services.storage.status().state,
          type === "save" ? "saved" : "loaded",
        );
      }
    } finally {
      host.dispose();
    }
  }
});

test("services storage adoption: cold candidate restores same-scene and cross-scene saves, completes only the transferred load", () => {
  for (const crossScene of [false, true]) {
    const savedIR = fixture();
    if (crossScene) {
      savedIR.scene = savedIR.scenes![0];
      savedIR.scenes = [fixture().scene];
    }
    const saved = rig({ ir: savedIR });
    let checkpoint: ReturnType<RuntimeHost["snapshot"]>;
    try {
      saved.host.step(2);
      saved.services.ui.setText("label", "State from saved scene");
      saved.services.audio.play("unknown");
      saved.services.storage.save("saved-slot");
      assert.deepEqual(saved.driver.takeRequests(), [
        { type: "save", id: "saved-slot" },
      ]);
      checkpoint = saved.host.snapshot();
    } finally {
      saved.host.dispose();
    }

    const active = rig();
    const candidate = rig({ ir: savedIR });
    try {
      active.host.step();
      active.services.ui.setText("label", "Old scene remains active");
      active.services.storage.load("requested-slot");
      const [request] = active.driver.takeRequests();
      assert.deepEqual(request, { type: "load", id: "requested-slot" });
      const oldState = active.host.snapshot();
      const emptyCandidate = candidate.host.snapshot();
      candidate.driver.adoptStorageRequest("load", request.id);
      assert.deepEqual(candidate.host.snapshot(), emptyCandidate);
      candidate.host.restore(checkpoint);
      assert.equal(
        candidate.services.scenes.current(),
        crossScene ? "next" : "field",
      );
      assert.equal(
        candidate.driver.inspect().ui![0].text,
        "State from saved scene",
      );
      assert.deepEqual(candidate.services.storage.status(), {
        state: "saving",
        slot: "saved-slot",
        error: null,
      });
      assert.deepEqual(candidate.driver.takeRequests(), []);
      assert.throws(
        () => candidate.driver.storageComplete("save", "saved-slot"),
        /TC_STORAGE_COMPLETION/,
      );
      assert.throws(
        () => candidate.driver.storageComplete("load", "saved-slot"),
        /TC_STORAGE_COMPLETION/,
      );
      candidate.driver.storageComplete("load", request.id);
      assert.deepEqual(candidate.services.storage.status(), {
        state: "loaded",
        slot: "requested-slot",
        error: null,
      });
      assert.deepEqual(
        candidate.driver.inspect().audio.voices.map((voice) => voice.id),
        ["voice:1"],
      );
      assert.deepEqual(active.host.snapshot(), oldState);
      assert.equal(active.services.scenes.current(), "field");
      assert.equal(
        active.driver.inspect().ui![0].text,
        "Old scene remains active",
      );
      candidate.host.step();
      candidate.services.storage.save("new-slot");
      assert.deepEqual(candidate.driver.takeRequests(), [
        { type: "save", id: "new-slot" },
      ]);
    } finally {
      candidate.host.dispose();
      active.host.dispose();
    }
  }
});

test("services storage adoption: candidate restore failure leaves old host intact and candidate dispatch completable", () => {
  const savedIR = fixture();
  savedIR.scene = savedIR.scenes![0];
  savedIR.scenes = [fixture().scene];
  const saved = rig({ ir: savedIR });
  let checkpoint: ReturnType<RuntimeHost["snapshot"]>;
  try {
    saved.host.step();
    saved.services.storage.save("slot");
    saved.driver.takeRequests();
    checkpoint = saved.host.snapshot();
  } finally {
    saved.host.dispose();
  }

  for (const failure of ["plugin", "scheduler"] as const) {
    const active = rig();
    const candidate = rig({ ir: savedIR });
    try {
      active.host.step();
      active.services.ui.setText("label", "Keep old state");
      active.services.storage.load("slot");
      active.driver.takeRequests();
      const oldState = active.host.snapshot();
      candidate.driver.adoptStorageRequest("load", "slot");
      const candidateState = candidate.host.snapshot();
      const bad = structuredClone(checkpoint);
      if (failure === "plugin")
        (bad.plugins!["game-services"].payload as any).input.keys = [
          "unknown-key",
        ];
      else bad.scheduler.fixedDt *= 2;
      assert.throws(
        () => candidate.host.restore(bad),
        failure === "plugin" ? /TC_SERVICES_SNAPSHOT/ : /TC_PLUGIN_RESTORE/,
      );
      assert.deepEqual(active.host.snapshot(), oldState);
      assert.deepEqual(candidate.host.snapshot(), candidateState);
      assert.deepEqual(candidate.driver.takeRequests(), []);
      assert.throws(
        () => candidate.driver.adoptStorageRequest("load", "replacement"),
        /TC_SERVICE_BUSY/,
      );
      candidate.driver.storageComplete(
        "load",
        "slot",
        "Candidate restore failed",
      );
      assert.deepEqual(candidate.services.storage.status(), {
        state: "failed",
        slot: "slot",
        error: "Candidate restore failed",
      });
      candidate.host.dispose();
      assert.deepEqual(active.host.snapshot(), oldState);
      active.driver.storageComplete("load", "slot", "Candidate restore failed");
      assert.equal(active.services.scenes.current(), "field");
      assert.equal(active.driver.inspect().ui![0].text, "Keep old state");
      assert.deepEqual(active.services.storage.status(), {
        state: "failed",
        slot: "slot",
        error: "Candidate restore failed",
      });
      active.host.step();
      active.services.storage.load("slot");
      assert.deepEqual(active.driver.takeRequests(), [
        { type: "load", id: "slot" },
      ]);
    } finally {
      candidate.host.dispose();
      active.host.dispose();
    }
  }
});
