import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { test } from "node:test";
import type {
  ComponentData,
  ComponentSchema,
} from "../packages/sdk/src/index.ts";
import type {
  EntityHandle,
  EntityRecord,
  RuntimeComponentDefinition,
  RuntimeWorld,
  WorldAccess,
  WorldCommand,
  WorldSnapshot,
} from "../packages/runtime/src/contracts.ts";
import { createWorld } from "../packages/runtime/src/world.ts";
import { ComponentStorage } from "../packages/runtime/src/storage.ts";

const stats: RuntimeComponentDefinition = {
  id: "Stats",
  version: 2,
  schema: {
    hp: { type: "number", default: 10 },
    active: { type: "boolean", default: true },
    title: { type: "string", default: "hero" },
    velocity: { type: "vec3", default: [1, 2, 3] },
  },
};
const tag: RuntimeComponentDefinition = { id: "Tag", schema: {} };
function fixture(): RuntimeWorld {
  return createWorld({
    initialCapacity: 2,
    components: [stats, tag],
    entities: [
      { id: "root", components: { Stats: { hp: 20 } } },
      { id: "child", parent: "root", components: { Stats: {}, Tag: {} } },
      { id: "other", components: { Tag: {} } },
    ],
  });
}
function expectCode(operation: () => unknown, code: string): void {
  assert.throws(operation, new RegExp(`TC_WORLD_${code}:`));
}
function mutableVector(value: unknown): number[] {
  assert.ok(Array.isArray(value));
  return value as number[];
}

test("storage uses actual typed SoA columns, including flat vec3 and boolean bytes", () => {
  const storage = new ComponentStorage(stats.schema, 2);
  assert.ok(storage.columns.get("hp") instanceof Float64Array);
  assert.ok(storage.columns.get("active") instanceof Uint8Array);
  assert.ok(storage.columns.get("velocity") instanceof Float64Array);
  assert.ok(Array.isArray(storage.columns.get("title")));
  assert.equal(storage.columns.get("velocity")!.length, 6);
  storage.write(1, { hp: 4, active: true, velocity: [7, 8, 9], title: "npc" });
  assert.deepEqual(
    Array.from(storage.columns.get("velocity") as Float64Array),
    [0, 0, 0, 7, 8, 9],
  );
  assert.deepEqual(
    Array.from(storage.columns.get("active") as Uint8Array),
    [0, 1],
  );
  storage.grow(8);
  assert.equal(storage.presence.length, 8);
  assert.equal(storage.columns.get("velocity")!.length, 24);
  assert.deepEqual(storage.read(1), {
    hp: 4,
    active: true,
    title: "npc",
    velocity: [7, 8, 9],
  });
  assert.equal(storage.presence[7], 0);
  const clone = storage.clone();
  storage.write(1, { velocity: [0, 0, 0], title: "changed" });
  assert.deepEqual(clone.read(1).velocity, [7, 8, 9]);
  storage.remove(1);
  assert.equal(storage.presence[1], 0);
  assert.deepEqual(storage.read(1), {
    hp: 0,
    active: false,
    title: "",
    velocity: [0, 0, 0],
  });
});

test("defaults, independent returned values and partial updates preserve exact values", () => {
  const world = fixture();
  assert.deepEqual(world.getComponent("root", "Stats"), {
    hp: 20,
    active: true,
    title: "hero",
    velocity: [1, 2, 3],
  });
  assert.deepEqual(world.getTransform("root"), {
    position: [0, 0, 0],
    rotation: [0, 0, 0],
    scale: [1, 1, 1],
  });
  const before = world.getComponent("root", "Stats");
  mutableVector(before.velocity)[0] = 999;
  before.hp = 999;
  const transform = world.getTransform("root");
  mutableVector(transform.scale)[0] = 999;
  assert.equal(world.getComponent("root", "Stats").hp, 20);
  assert.deepEqual(world.getComponent("root", "Stats").velocity, [1, 2, 3]);
  assert.deepEqual(world.getTransform("root").scale, [1, 1, 1]);
  world.setComponent("root", "Stats", { active: false, title: "", hp: 0 });
  assert.deepEqual(world.getComponent("root", "Stats"), {
    hp: 0,
    active: false,
    title: "",
    velocity: [1, 2, 3],
  });
  world.setTransform("root", { position: [4, 5, 6] });
  assert.deepEqual(world.getTransform("root").position, [4, 5, 6]);
  assert.deepEqual(
    world.getComponent("root", "Transform"),
    world.getTransform("root"),
  );
  world.setComponent("root", "Transform", { rotation: [1, 2, 3] });
  assert.deepEqual(world.getTransform("root").rotation, [1, 2, 3]);
});

test("schema and spawn arguments are copied instead of retained", () => {
  const definition = structuredClone(stats);
  const world = createWorld({ components: [definition] });
  mutableVector(definition.schema.velocity.default)[0] = 999;
  const vector: [number, number, number] = [3, 4, 5];
  const component: ComponentData = { velocity: vector };
  world.spawn({
    id: "first",
    components: { Stats: component },
    transform: { position: vector },
  });
  vector[0] = 999;
  component.hp = 999;
  world.spawn({ id: "second", components: { Stats: {} } });
  assert.deepEqual(world.getComponent("first", "Stats").velocity, [3, 4, 5]);
  assert.equal(world.getComponent("first", "Stats").hp, 10);
  assert.deepEqual(world.getTransform("first").position, [3, 4, 5]);
  assert.deepEqual(world.getComponent("second", "Stats").velocity, [1, 2, 3]);
});

test("intersection queries are deterministic entity-index order across reuse and growth", () => {
  const world = fixture();
  assert.deepEqual(world.query(), ["root", "child", "other"]);
  assert.deepEqual(world.query("Stats", "Tag"), ["child"]);
  assert.deepEqual(world.query("Transform", "Stats", "Stats"), [
    "root",
    "child",
  ]);
  world.destroy("other");
  world.spawn({ id: "replacement", components: { Stats: {}, Tag: {} } });
  world.spawn({ id: "new", components: { Stats: {} } });
  assert.deepEqual(world.query("Stats"), [
    "root",
    "child",
    "replacement",
    "new",
  ]);
  world.removeComponent("child", "Stats");
  assert.deepEqual(world.query("Stats", "Tag"), ["replacement"]);
  expectCode(() => world.query("Missing"), "COMPONENT");
});

test("10,000 entities: capacity growth, all fields, intersection and query cost report", (context) => {
  const world = createWorld({ initialCapacity: 1, components: [stats, tag] });
  const start = performance.now();
  for (let i = 0; i < 10_000; i++)
    world.spawn({
      id: `e${i}`,
      components: {
        Stats: {
          hp: i + 0.25,
          active: i % 2 === 0,
          title: `t${i}`,
          velocity: [i, -i, i / 2],
        },
        ...(i % 2 === 0 ? { Tag: {} } : {}),
      },
    });
  const spawnMs = performance.now() - start;
  assert.ok(world.inspect().capacity >= 10_000);
  assert.equal(world.inspect().entities, 10_000);
  const queryStart = performance.now();
  for (let run = 0; run < 20; run++) {
    const result = world.query("Stats", "Tag");
    assert.equal(result.length, 5_000);
    assert.equal(result[0], "e0");
    assert.equal(result.at(-1), "e9998");
  }
  const queryMs = (performance.now() - queryStart) / 20;
  for (const i of [0, 1, 31, 64, 511, 9999])
    assert.deepEqual(world.getComponent(`e${i}`, "Stats"), {
      hp: i + 0.25,
      active: i % 2 === 0,
      title: `t${i}`,
      velocity: [i, -i, i / 2],
    });
  context.diagnostic(
    JSON.stringify({
      entities: 10_000,
      capacity: world.inspect().capacity,
      spawnMs,
      queryMeanMs: queryMs,
      threshold: null,
    }),
  );
});

test("handles are world-specific and never resurrect on index or ID reuse", () => {
  const world = fixture(),
    other = fixture();
  const first = world.resolve("other");
  assert.ok(Object.isFrozen(first));
  assert.equal(world.id(first), "other");
  assert.equal(other.isAlive(first), false);
  expectCode(() => other.getTransform(first), "HANDLE");
  world.destroy(first);
  const next = world.spawn({ id: "other" });
  assert.equal(next.index, first.index);
  assert.ok(next.generation > first.generation);
  assert.equal(world.isAlive(first), false);
  expectCode(() => world.setTransform(first, {}), "HANDLE");
  assert.equal(world.isAlive({ ...next, generation: NaN }), false);
  assert.equal(world.isAlive({ ...next, index: 0.5 }), false);
  expectCode(() => world.resolve("absent"), "ENTITY");
});

test("forward parents are supported; deleting a parent cascades only its subtree", () => {
  const world = createWorld({
    entities: [
      { id: "leaf", parent: "branch" },
      { id: "root" },
      { id: "branch", parent: "root" },
      { id: "other" },
    ],
  });
  assert.deepEqual(
    world.records().map(({ id, parent }) => [id, parent]),
    [
      ["leaf", "branch"],
      ["root", undefined],
      ["branch", "root"],
      ["other", undefined],
    ],
  );
  const handles = ["leaf", "branch", "root"].map((id) => world.resolve(id));
  world.destroy("branch");
  assert.deepEqual(world.query(), ["root", "other"]);
  assert.equal(world.isAlive(handles[0]), false);
  assert.equal(world.isAlive(handles[1]), false);
  assert.equal(world.isAlive(handles[2]), true);
  const before = world.snapshot();
  expectCode(() => world.spawn({ id: "bad", parent: "missing" }), "PARENT");
  assert.deepEqual(world.snapshot(), before);
  expectCode(() => world.spawn({ id: "self", parent: "self" }), "PARENT");
  world.destroy("root");
  assert.deepEqual(world.query(), ["other"]);
});

for (const inputs of [
  [{ id: "a", parent: "a" }],
  [
    { id: "a", parent: "b" },
    { id: "b", parent: "a" },
  ],
  [
    { id: "a", parent: "b" },
    { id: "b", parent: "c" },
    { id: "c", parent: "a" },
  ],
])
  test(`reject constructor parent cycle ${inputs.length}`, () => {
    expectCode(() => createWorld({ entities: inputs }), "PARENT_CYCLE");
  });

test("deep parent chains validate and cascade without recursive stack overflow", () => {
  const world = createWorld({
    entities: Array.from({ length: 10_000 }, (_, i) => ({
      id: `e${i}`,
      ...(i ? { parent: `e${i - 1}` } : {}),
    })),
  });
  assert.equal(world.inspect().entities, 10_000);
  world.destroy("e0");
  assert.equal(world.inspect().entities, 0);
});

for (const [name, patch] of Object.entries({
  unknown: { missing: 1 },
  nan: { hp: NaN },
  infinity: { hp: Infinity },
  numberString: { hp: "2" },
  boolNumber: { active: 1 },
  stringBool: { title: false },
  shortVec: { velocity: [1, 2] },
  badVec: { velocity: [1, NaN, 3] },
  sparseVec: { velocity: new Array(3) },
  extraVec: { velocity: [1, 2, 3, 4] },
  undefinedValue: { hp: undefined },
}))
  test(`invalid component patch is atomic: ${name}`, () => {
    const world = fixture(),
      before = world.snapshot(),
      revision = world.inspect().revision;
    expectCode(
      () =>
        world.setComponent("root", "Stats", {
          hp: 3,
          ...patch,
        } as unknown as ComponentData),
      name === "unknown" ? "FIELD" : "VALUE",
    );
    assert.deepEqual(world.snapshot(), before);
    assert.equal(world.inspect().revision, revision);
  });

test("transform validation is atomic and rejects unknown/nonfinite fields", () => {
  const world = fixture(),
    before = world.snapshot();
  expectCode(
    () =>
      world.setTransform("root", {
        position: [1, 2, 3],
        scale: [1, Infinity, 1],
      }),
    "VALUE",
  );
  expectCode(
    () => world.setComponent("root", "Transform", { missing: 1 }),
    "FIELD",
  );
  assert.deepEqual(world.snapshot(), before);
});

for (const [name, schema] of Object.entries({
  type: { hp: { type: "integer", default: 0 } },
  missingDefault: { hp: { type: "number" } },
  nanDefault: { hp: { type: "number", default: NaN } },
  boolDefault: { hp: { type: "boolean", default: 1 } },
  shortVecDefault: { hp: { type: "vec3", default: [0, 0] } },
  extra: { hp: { type: "number", default: 0, other: 1 } },
}))
  test(`reject invalid schema ${name} without registration`, () => {
    const world = fixture();
    assert.throws(
      () =>
        world.registerComponent({
          id: "Bad",
          schema: schema as ComponentSchema,
        }),
      /TC_WORLD_(SCHEMA|VALUE):/,
    );
    assert.equal(world.inspect().components, 2);
    expectCode(() => world.query("Bad"), "COMPONENT");
  });

test("registration, component presence and reserved Transform invariants", () => {
  const world = fixture();
  expectCode(() => world.registerComponent(stats), "DUPLICATE");
  expectCode(
    () => world.registerComponent({ id: "Transform", schema: {} }),
    "RESERVED",
  );
  expectCode(() => world.addComponent("root", "Transform"), "RESERVED");
  expectCode(() => world.removeComponent("root", "Transform"), "RESERVED");
  expectCode(
    () => world.spawn({ id: "bad", components: { Transform: {} } }),
    "RESERVED",
  );
  expectCode(() => world.spawn({ id: "root" }), "DUPLICATE");
  expectCode(() => world.addComponent("root", "Stats"), "DUPLICATE");
  expectCode(() => world.removeComponent("root", "Tag"), "MISSING_COMPONENT");
  expectCode(
    () => world.setComponent("other", "Stats", {}),
    "MISSING_COMPONENT",
  );
  expectCode(() => world.getComponent("other", "Stats"), "MISSING_COMPONENT");
  world.removeComponent("root", "Stats");
  world.addComponent("root", "Stats");
  assert.equal(world.getComponent("root", "Stats").hp, 10);
  world.registerComponent({
    id: "Late",
    schema: { n: { type: "number", default: 5 } },
  });
  world.addComponent("root", "Late");
  assert.equal(world.getComponent("root", "Late").n, 5);
});

for (const value of [0, -1, 1.5, NaN, Infinity])
  test(`reject invalid initial capacity ${value}`, () => {
    expectCode(() => createWorld({ initialCapacity: value }), "CAPACITY");
  });

test("queue captures inputs, commits atomically and preserves existing handles", () => {
  const world = fixture(),
    root = world.resolve("root");
  const data: ComponentData = { hp: 7, velocity: [4, 5, 6] };
  world.queue({
    type: "spawn",
    entity: { id: "queued", parent: "root", components: { Stats: data } },
  });
  mutableVector(data.velocity)[0] = 999;
  data.hp = 999;
  world.queue({ type: "addComponent", entity: "queued", component: "Tag" });
  world.queue({ type: "removeComponent", entity: "child", component: "Tag" });
  world.queue({ type: "destroy", entity: "other" });
  assert.equal(world.isAlive("queued"), false);
  assert.equal(world.inspect().pendingCommands, 4);
  const revision = world.inspect().revision;
  world.flush();
  assert.equal(world.inspect().revision, revision + 1);
  assert.equal(world.inspect().pendingCommands, 0);
  assert.equal(world.isAlive(root), true);
  assert.equal(world.isAlive("other"), false);
  assert.deepEqual(world.query("Stats", "Tag"), ["queued"]);
  assert.equal(world.getComponent("queued", "Stats").hp, 7);
  assert.deepEqual(world.getComponent("queued", "Stats").velocity, [4, 5, 6]);
});

const invalidCommands: [string, WorldCommand][] = [
  ["duplicate spawn", { type: "spawn", entity: { id: "root" } }],
  ["missing destroy", { type: "destroy", entity: "absent" }],
  [
    "duplicate add",
    { type: "addComponent", entity: "root", component: "Stats" },
  ],
  [
    "missing remove",
    { type: "removeComponent", entity: "child", component: "Tag" },
  ],
  [
    "bad data",
    {
      type: "addComponent",
      entity: "other",
      component: "Stats",
      data: { hp: NaN },
    },
  ],
  ["missing parent", { type: "spawn", entity: { id: "x", parent: "absent" } }],
];
for (const [name, command] of invalidCommands)
  test(`failed flush rolls back every structural kind: ${name}`, () => {
    const world = fixture(),
      before = world.snapshot(),
      handle = world.resolve("child"),
      revision = world.inspect().revision;
    world.queue({
      type: "spawn",
      entity: { id: "new", components: { Stats: {} } },
    });
    world.queue({ type: "removeComponent", entity: "child", component: "Tag" });
    world.queue({ type: "destroy", entity: "other" });
    world.queue({ type: "addComponent", entity: "root", component: "Tag" });
    world.queue(command);
    assert.throws(() => world.flush(), /TC_WORLD_/);
    assert.deepEqual(world.snapshot(), before);
    assert.equal(world.isAlive(handle), true);
    assert.equal(world.inspect().revision, revision);
    assert.equal(world.inspect().pendingCommands, 0);
    world.queue({ type: "spawn", entity: { id: "recovered" } });
    world.flush();
    assert.equal(world.isAlive("recovered"), true);
  });

test("destroy then ID reuse in one batch never revives retained handles", () => {
  const world = fixture(),
    old = world.resolve("other");
  world.queue({ type: "destroy", entity: old });
  world.queue({ type: "spawn", entity: { id: "other" } });
  world.flush();
  assert.equal(world.isAlive(old), false);
  const current = world.resolve("other");
  assert.equal(current.index, old.index);
  assert.ok(current.generation > old.generation);
  const before = world.snapshot();
  world.queue({ type: "destroy", entity: current });
  world.queue({ type: "spawn", entity: { id: "other" } });
  world.queue({ type: "addComponent", entity: current, component: "Tag" });
  expectCode(() => world.flush(), "HANDLE");
  assert.deepEqual(world.snapshot(), before);
  assert.equal(world.isAlive(current), true);
});

test("empty flush does not change revision", () => {
  const world = fixture(),
    before = world.inspect();
  world.flush();
  assert.deepEqual(world.inspect(), before);
});

test("invalid direct spawn/add are validated completely before touching columns or indices", () => {
  const world = fixture(),
    before = world.snapshot(),
    meta = world.inspect();
  expectCode(
    () =>
      world.spawn({ id: "bad", components: { Stats: { hp: 1 }, Unknown: {} } }),
    "COMPONENT",
  );
  expectCode(
    () => world.spawn({ id: "bad", transform: { position: [1, NaN, 2] } }),
    "VALUE",
  );
  expectCode(
    () =>
      world.addComponent("other", "Stats", { hp: 3, velocity: [NaN, 1, 2] }),
    "VALUE",
  );
  assert.deepEqual(world.snapshot(), before);
  assert.deepEqual(world.inspect(), meta);
});

test("deferred malformed payloads reject without leaking earlier changes", () => {
  const world = fixture(),
    before = world.snapshot();
  world.queue({ type: "spawn", entity: { id: "would-be-created" } });
  world.queue({
    type: "addComponent",
    entity: "other",
    component: "Stats",
    data: null as unknown as ComponentData,
  });
  expectCode(() => world.flush(), "SCHEMA");
  assert.deepEqual(world.snapshot(), before);
  expectCode(
    () => world.queue({ type: "unknown" } as unknown as WorldCommand),
    "COMMAND",
  );
  expectCode(
    () =>
      world.queue({
        type: "spawn",
        entity: {
          id: "bad",
          components: { Stats: { title: (() => {}) as unknown as string } },
        },
      }),
    "COMMAND",
  );
  assert.equal(world.inspect().pendingCommands, 0);
});

test("read/write permissions include Transform, intersection queries, records and snapshots", () => {
  const world = fixture();
  world.runSystem(
    "reader",
    { reads: ["Stats"], writes: [], structural: false },
    () => {
      assert.equal(world.getComponent("root", "Stats").hp, 20);
      assert.deepEqual(world.query("Stats"), ["root", "child"]);
      expectCode(() => world.query("Stats", "Tag"), "ACCESS_READ");
      expectCode(() => world.getTransform("root"), "ACCESS_READ");
      expectCode(() => world.getComponent("root", "Transform"), "ACCESS_READ");
      expectCode(
        () => world.setComponent("root", "Stats", { hp: 1 }),
        "ACCESS_WRITE",
      );
      expectCode(() => world.setTransform("root", {}), "ACCESS_WRITE");
      expectCode(() => world.snapshot(), "ACCESS_READ");
      expectCode(() => world.records(), "ACCESS_READ");
      expectCode(
        () => world.queue({ type: "spawn", entity: { id: "forbidden" } }),
        "ACCESS_STRUCTURAL",
      );
      assert.equal(world.id(world.resolve("root")), "root");
    },
  );
  world.runSystem(
    "writer",
    { reads: [], writes: ["Stats", "Transform"] },
    () => {
      world.setComponent("root", "Stats", { hp: 7 });
      assert.equal(world.getComponent("root", "Stats").hp, 7);
      world.setTransform("root", { position: [1, 2, 3] });
      assert.deepEqual(world.getTransform("root").position, [1, 2, 3]);
      assert.deepEqual(world.query("Stats", "Transform"), ["root", "child"]);
      expectCode(() => world.getComponent("other", "Tag"), "ACCESS_READ");
    },
  );
});

test("undefined access keeps legacy behavior; explicit empty lists grant nothing", () => {
  const world = fixture();
  const operation = () => {
    world.getTransform("root");
    world.setTransform("root", {});
    world.getComponent("root", "Stats");
    world.setComponent("root", "Stats", {});
    world.query("Stats");
  };
  world.runSystem("legacy", undefined as unknown as WorldAccess, operation);
  world.runSystem("legacy-fields", {}, operation);
  world.runSystem("empty", { reads: [], writes: [] }, () => {
    expectCode(() => world.getTransform("root"), "ACCESS_READ");
    expectCode(() => world.getComponent("root", "Stats"), "ACCESS_READ");
    expectCode(() => world.query("Stats"), "ACCESS_READ");
    expectCode(() => world.setTransform("root", {}), "ACCESS_WRITE");
    expectCode(() => world.setComponent("root", "Stats", {}), "ACCESS_WRITE");
  });
  world.runSystem("explicit-read-empty", { reads: [] }, () =>
    expectCode(() => world.getTransform("root"), "ACCESS_READ"),
  );
  world.runSystem("explicit-write-empty", { writes: [] }, () =>
    expectCode(() => world.setTransform("root", {}), "ACCESS_WRITE"),
  );
});

test("systems must queue all structural and lifecycle changes even with structural permission", () => {
  const world = fixture(),
    snapshot = world.snapshot();
  world.runSystem("structural", { structural: true }, () => {
    for (const operation of [
      () => world.spawn({ id: "bad" }),
      () => world.destroy("root"),
      () => world.addComponent("root", "Tag"),
      () => world.removeComponent("root", "Stats"),
      () => world.registerComponent({ id: "Bad", schema: {} }),
      () => world.flush(),
      () => world.restore(snapshot),
      () => world.dispose(),
    ])
      expectCode(operation, "STRUCTURAL");
    world.queue({ type: "spawn", entity: { id: "new" } });
    assert.equal(world.isAlive("new"), false);
  });
  world.flush();
  assert.equal(world.isAlive("new"), true);
});

test("queued writes retain originating permissions, including cascade destroy", () => {
  const world = fixture();
  const access: WorldAccess = { reads: [], writes: [], structural: true };
  world.runSystem("deny", access, () => {
    expectCode(
      () => world.queue({ type: "spawn", entity: { id: "bad" } }),
      "ACCESS_WRITE",
    );
    expectCode(
      () =>
        world.queue({ type: "addComponent", entity: "root", component: "Tag" }),
      "ACCESS_WRITE",
    );
    expectCode(
      () =>
        world.queue({
          type: "removeComponent",
          entity: "root",
          component: "Stats",
        }),
      "ACCESS_WRITE",
    );
    world.queue({ type: "destroy", entity: "root" });
  });
  access.writes = ["Transform", "Stats", "Tag"];
  const before = world.snapshot();
  expectCode(() => world.flush(), "ACCESS_WRITE");
  assert.deepEqual(world.snapshot(), before);
  world.runSystem(
    "cascade-no-tag",
    { reads: [], writes: ["Transform", "Stats"], structural: true },
    () => {
      world.queue({ type: "destroy", entity: "root" });
    },
  );
  expectCode(() => world.flush(), "ACCESS_WRITE");
  assert.deepEqual(world.snapshot(), before);
  world.runSystem(
    "cascade",
    { reads: [], writes: ["Transform", "Stats", "Tag"], structural: true },
    () => world.queue({ type: "destroy", entity: "root" }),
  );
  world.flush();
  assert.deepEqual(world.query(), ["other"]);
});

test("systems cannot elevate via nesting or mutable declarations and always restore access", () => {
  const world = fixture(),
    access: WorldAccess = { reads: [], writes: [] };
  world.runSystem("outer", access, () => {
    (access.reads as string[]).push("Stats");
    (access.writes as string[]).push("Stats");
    expectCode(() => world.getComponent("root", "Stats"), "ACCESS_READ");
    expectCode(() => world.runSystem("inner", {}, () => {}), "SYSTEM_NESTED");
  });
  assert.throws(
    () =>
      world.runSystem("throws", { reads: [], writes: [] }, () => {
        throw new Error("expected");
      }),
    /expected/,
  );
  world.setComponent("root", "Stats", { hp: 5 });
  assert.equal(world.getComponent("root", "Stats").hp, 5);
  assert.equal(
    world.runSystem("return", {}, () => 42),
    42,
  );
  expectCode(
    () => world.runSystem("async", {}, async () => {}),
    "SYSTEM_ASYNC",
  );
  expectCode(
    () => world.runSystem("promise", {}, () => Promise.resolve()),
    "SYSTEM_ASYNC",
  );
  expectCode(
    () =>
      world.runSystem("reject", {}, () =>
        Promise.reject(new Error("expected rejected work")),
      ),
    "SYSTEM_ASYNC",
  );
  assert.deepEqual(
    world.runSystem("ordinary-value", {}, () => ({ then: 12 })),
    { then: 12 },
  );
});

test("malformed permission declarations fail before executing the system", () => {
  const world = fixture();
  let called = false;
  for (const access of [
    { reads: null },
    { writes: "Stats" },
    { reads: [1] },
    { reads: [""] },
    { reads: new Array(1) },
    { structural: 1 },
  ])
    expectCode(
      () =>
        world.runSystem("bad", access as unknown as WorldAccess, () => {
          called = true;
        }),
      "ACCESS",
    );
  assert.equal(called, false);
});

test("snapshot is deeply detached in both directions and reusable after every restore", () => {
  const world = fixture(),
    snapshot = world.snapshot(),
    original = structuredClone(snapshot);
  world.setComponent("root", "Stats", { hp: 3, velocity: [7, 8, 9] });
  world.setTransform("root", { position: [7, 8, 9] });
  world.destroy("child");
  assert.deepEqual(snapshot, original);
  for (let iteration = 0; iteration < 3; iteration++) {
    world.restore(snapshot);
    assert.deepEqual(world.snapshot(), original);
    world.setComponent("root", "Stats", { hp: iteration, velocity: [9, 9, 9] });
    world.setTransform("root", { scale: [2, 2, 2] });
    world.destroy("child");
    assert.deepEqual(snapshot, original);
  }
  world.restore(snapshot);
  snapshot.entities[0].components.Stats.hp = 888;
  mutableVector(snapshot.entities[0].transform.position)[0] = 888;
  mutableVector(snapshot.components[0].schema.velocity.default)[0] = 888;
  assert.deepEqual(world.snapshot(), original);
  world.spawn({ id: "defaults", components: { Stats: {} } });
  assert.deepEqual(world.getComponent("defaults", "Stats").velocity, [1, 2, 3]);
});

test("restores invalidate all past and future handles with monotonically advancing generations", () => {
  const world = fixture(),
    retained = [world.resolve("root"), world.resolve("other")],
    snapshot = world.snapshot();
  let maximum = Math.max(...retained.map((handle) => handle.generation));
  for (let iteration = 0; iteration < 30; iteration++) {
    world.restore(snapshot);
    for (const handle of retained) assert.equal(world.isAlive(handle), false);
    const restored = world.resolve("root");
    assert.ok(restored.generation > maximum);
    maximum = restored.generation;
    retained.push(restored);
    const future = world.spawn({ id: `future-${iteration}` });
    assert.ok(future.generation > maximum);
    maximum = future.generation;
    retained.push(future);
    world.destroy(future);
    const reused = world.spawn({ id: `reused-${iteration}` });
    assert.ok(reused.generation > maximum);
    maximum = reused.generation;
    retained.push(reused);
  }
});

const corruptions: [string, (snapshot: WorldSnapshot) => void][] = [
  [
    "version",
    (s) => {
      s.version = 2 as 1;
    },
  ],
  [
    "format",
    (s) => {
      s.format = "wrong" as "threecat.world";
    },
  ],
  [
    "duplicate entities",
    (s) => {
      s.entities.push(structuredClone(s.entities[0]));
    },
  ],
  [
    "duplicate definitions",
    (s) => {
      s.components.push(structuredClone(s.components[0]));
    },
  ],
  [
    "missing parent",
    (s) => {
      s.entities[0].parent = "missing";
    },
  ],
  [
    "cycle",
    (s) => {
      s.entities[0].parent = "child";
    },
  ],
  [
    "nonfinite transform",
    (s) => {
      s.entities[0].transform.position = [Infinity, 0, 0];
    },
  ],
  [
    "nonfinite component",
    (s) => {
      s.entities[0].components.Stats.hp = NaN;
    },
  ],
  [
    "invalid default",
    (s) => {
      (s.components[0].schema.hp as { default: number }).default = Infinity;
    },
  ],
  [
    "missing field",
    (s) => {
      delete s.entities[0].components.Stats.hp;
    },
  ],
  [
    "unknown field",
    (s) => {
      s.entities[0].components.Stats.extra = 2;
    },
  ],
  [
    "unknown component",
    (s) => {
      s.entities[0].components.Unknown = {};
    },
  ],
  [
    "invalid definition version",
    (s) => {
      s.components[0].version = -1;
    },
  ],
  [
    "missing transform",
    (s) => {
      delete (s.entities[0] as Partial<(typeof s.entities)[0]>).transform;
    },
  ],
  [
    "missing components",
    (s) => {
      delete (s.entities[0] as Partial<(typeof s.entities)[0]>).components;
    },
  ],
  [
    "null components",
    (s) => {
      s.entities[0].components = null as unknown as Record<
        string,
        ComponentData
      >;
    },
  ],
  [
    "null transform",
    (s) => {
      s.entities[0].transform =
        null as unknown as (typeof s.entities)[0]["transform"];
    },
  ],
  [
    "sparse entities",
    (s) => {
      s.entities.length += 1;
    },
  ],
  [
    "missing schema",
    (s) => {
      delete (s.components[0] as Partial<RuntimeComponentDefinition>).schema;
    },
  ],
  [
    "null entities",
    (s) => {
      s.entities = null as unknown as WorldSnapshot["entities"];
    },
  ],
  [
    "reserved component",
    (s) => {
      s.components[0].id = "Transform";
    },
  ],
];
for (const [name, corrupt] of corruptions)
  test(`restore rejects ${name} before changing live state or pending queue`, () => {
    const world = fixture(),
      snapshot = world.snapshot(),
      original = world.snapshot(),
      handle = world.resolve("root");
    world.queue({ type: "spawn", entity: { id: "pending" } });
    const before = world.inspect();
    corrupt(snapshot);
    assert.throws(() => world.restore(snapshot), /TC_WORLD_/);
    assert.deepEqual(world.snapshot(), original);
    assert.deepEqual(world.inspect(), before);
    assert.equal(world.isAlive(handle), true);
    world.flush();
    assert.equal(world.isAlive("pending"), true);
  });

test("successful restore replaces schemas and clears queued commands", () => {
  const world = fixture(),
    snapshot = world.snapshot(),
    other = createWorld({ components: [{ id: "Different", schema: {} }] });
  world.queue({ type: "spawn", entity: { id: "discard" } });
  world.restore(snapshot);
  assert.equal(world.inspect().pendingCommands, 0);
  assert.equal(world.isAlive("discard"), false);
  other.restore(snapshot);
  assert.deepEqual(other.snapshot(), snapshot);
  expectCode(() => other.query("Different"), "COMPONENT");
});

test("records and JSON snapshot round trips preserve parents, values and versioned schemas", () => {
  const world = fixture(),
    snapshot = world.snapshot();
  const records = world.records();
  records[0].components.Stats.hp = 999;
  mutableVector(records[0].transform.position)[0] = 999;
  records[1].parent = "other";
  assert.deepEqual(world.snapshot(), snapshot);
  world.restore(JSON.parse(JSON.stringify(snapshot)) as WorldSnapshot);
  assert.deepEqual(world.snapshot(), snapshot);
  assert.equal(world.snapshot().components[0].version, 2);
  const empty = createWorld();
  assert.deepEqual(empty.query(), []);
  empty.restore(world.snapshot());
  assert.deepEqual(empty.records(), world.records());
});

test("optional undefined parent/version fields are accepted and omitted in retained snapshots", () => {
  const world = createWorld({
    components: [{ ...tag, version: undefined }],
    entities: [
      {
        id: "group",
        parent: undefined,
        transform: undefined,
        components: undefined,
      },
      { id: "mesh", parent: "group", components: { Tag: {} } },
    ],
  });
  const saved = world.snapshot();
  assert.equal(Object.hasOwn(saved.entities[0], "parent"), false);
  assert.equal(Object.hasOwn(saved.components[0], "version"), false);
  const snapshot: WorldSnapshot = {
    ...saved,
    entities: saved.entities.map((entry) => ({
      ...entry,
      parent: entry.parent,
    })),
  };
  const oldGroup = world.resolve("group"),
    oldMesh = world.resolve("mesh");
  world.restore(snapshot);
  assert.equal(world.isAlive(oldGroup), false);
  assert.equal(world.isAlive(oldMesh), false);
  assert.deepEqual(world.snapshot(), saved);
  assert.deepEqual(world.query(), ["group", "mesh"]);
  const group = world.resolve("group"),
    mesh = world.resolve("mesh");
  assert.ok(group.generation > oldMesh.generation);
  assert.ok(mesh.generation > group.generation);
  world.destroy("group");
  assert.deepEqual(world.query(), []);
});

test("seeded operation sequences agree with an independent entity-record model", () => {
  const world = createWorld({ initialCapacity: 1, components: [stats, tag] });
  let model = new Map<string, EntityRecord>(),
    handles = new Map<string, EntityHandle>();
  const stale: EntityHandle[] = [];
  const exercised = new Set<string>();
  let saved:
    | { world: WorldSnapshot; model: Map<string, EntityRecord> }
    | undefined;
  let seed = 0x1367abcd,
    sequence = 0;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed >>> 8;
  };
  const entity = (id: string, parent?: string): EntityRecord => ({
    id,
    ...(parent === undefined ? {} : { parent }),
    transform: { position: [1, 2, 3], rotation: [0, 0, 0], scale: [1, 1, 1] },
    components: {
      Stats: { hp: 10, active: true, title: "hero", velocity: [1, 2, 3] },
    },
  });
  for (let step = 0; step < 600; step++) {
    const ids = [...model.keys()],
      selected = ids[random() % Math.max(ids.length, 1)],
      choice = random() % 8;
    if (!model.size || choice === 0) {
      exercised.add("spawn");
      const id = `model-${sequence++}`,
        parent = ids.length && random() & 1 ? selected : undefined;
      const input = entity(id, parent);
      handles.set(id, world.spawn(input));
      model.set(id, input);
    } else if (choice === 1) {
      exercised.add("update");
      const hp = random() / 7;
      world.setComponent(selected, "Stats", { hp });
      model.get(selected)!.components.Stats.hp = hp;
      const position: [number, number, number] = [step, -step, step / 2];
      world.setTransform(selected, { position });
      model.get(selected)!.transform.position = position;
    } else if (choice === 2) {
      exercised.add("toggle");
      const entry = model.get(selected)!;
      if (entry.components.Tag) {
        world.removeComponent(selected, "Tag");
        delete entry.components.Tag;
      } else {
        world.addComponent(selected, "Tag");
        entry.components.Tag = {};
      }
    } else if (choice === 3) {
      exercised.add("destroy");
      const removed = new Set([selected]);
      let changed = true;
      while (changed) {
        changed = false;
        for (const entry of model.values())
          if (
            entry.parent !== undefined &&
            removed.has(entry.parent) &&
            !removed.has(entry.id)
          ) {
            removed.add(entry.id);
            changed = true;
          }
      }
      world.destroy(selected);
      for (const id of removed) {
        stale.push(handles.get(id)!);
        model.delete(id);
        handles.delete(id);
      }
    } else if (choice === 4) {
      exercised.add("snapshot");
      saved = { world: world.snapshot(), model: structuredClone(model) };
    } else if (choice === 5 && saved) {
      exercised.add("restore");
      stale.push(...handles.values());
      world.restore(saved.world);
      model = structuredClone(saved.model);
      handles = new Map([...model.keys()].map((id) => [id, world.resolve(id)]));
    } else if (choice === 6) {
      exercised.add("queue");
      const id = `queued-${sequence++}`,
        input = entity(id, selected);
      world.queue({ type: "spawn", entity: input });
      world.queue({ type: "addComponent", entity: id, component: "Tag" });
      world.flush();
      input.components.Tag = {};
      model.set(id, input);
      handles.set(id, world.resolve(id));
    } else {
      exercised.add("rollback");
      const before = world.snapshot(),
        id = `rollback-${sequence++}`;
      world.queue({ type: "spawn", entity: entity(id) });
      world.queue({ type: "removeComponent", entity: id, component: "Tag" });
      expectCode(() => world.flush(), "MISSING_COMPONENT");
      assert.deepEqual(world.snapshot(), before);
    }
    const expected = [...model.values()].sort(
      (a, b) => handles.get(a.id)!.index - handles.get(b.id)!.index,
    );
    assert.deepEqual(world.records(), expected, `Records at step ${step}`);
    assert.deepEqual(
      world.query("Stats", "Tag"),
      expected.filter((entry) => entry.components.Tag).map((entry) => entry.id),
    );
    assert.equal(world.inspect().entities, model.size);
    for (const handle of stale)
      assert.equal(
        world.isAlive(handle),
        false,
        `Stale handle at step ${step}`,
      );
    for (const handle of handles.values())
      assert.equal(world.isAlive(handle), true);
  }
  assert.deepEqual(
    [...exercised].sort(),
    [
      "spawn",
      "update",
      "toggle",
      "destroy",
      "snapshot",
      "restore",
      "queue",
      "rollback",
    ].sort(),
  );
});

test("prototype-like IDs and field names remain ordinary user data", () => {
  const schema = Object.fromEntries([
    ["__proto__", { type: "number", default: 5 }],
    ["constructor", { type: "string", default: "ok" }],
  ]) as ComponentSchema;
  const world = createWorld({
    components: [{ id: "__proto__", schema }],
    entities: [
      {
        id: "__proto__",
        components: Object.fromEntries([["__proto__", {}]]),
      },
    ],
  });
  assert.equal(world.getComponent("__proto__", "__proto__").__proto__, 5);
  world.setComponent(
    "__proto__",
    "__proto__",
    Object.fromEntries([["__proto__", 9]]),
  );
  const snapshot = world.snapshot();
  world.restore(snapshot);
  assert.equal(world.getComponent("__proto__", "__proto__").__proto__, 9);
  assert.deepEqual(world.query("__proto__"), ["__proto__"]);
});

test("dispose releases state, is idempotent, and every data operation fails explicitly", () => {
  const world = fixture(),
    snapshot = world.snapshot();
  world.queue({ type: "spawn", entity: { id: "pending" } });
  world.dispose();
  world.dispose();
  assert.deepEqual(
    { ...world.inspect(), revision: 0 },
    {
      entities: 0,
      capacity: 0,
      components: 0,
      pendingCommands: 0,
      revision: 0,
      disposed: true,
    },
  );
  for (const operation of [
    () => world.registerComponent(stats),
    () => world.spawn({ id: "x" }),
    () => world.destroy("root"),
    () => world.resolve("root"),
    () => world.id("root"),
    () => world.isAlive("root"),
    () => world.getTransform("root"),
    () => world.setTransform("root", {}),
    () => world.getComponent("root", "Stats"),
    () => world.setComponent("root", "Stats", {}),
    () => world.addComponent("root", "Stats"),
    () => world.removeComponent("root", "Stats"),
    () => world.query(),
    () => world.records(),
    () => world.queue({ type: "destroy", entity: "root" }),
    () => world.flush(),
    () => world.runSystem("system", {}, () => {}),
    () => world.snapshot(),
    () => world.restore(snapshot),
  ])
    expectCode(operation, "DISPOSED");
});
