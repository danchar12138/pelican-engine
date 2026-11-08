import assert from "node:assert/strict";
import test from "node:test";
import {
  defineGame,
  defineScene,
  defineGameRuntime,
  instantiateGame,
  type EngineFacade,
  type JsonValue,
} from "../packages/sdk/src/index.ts";
import { createRuntimeScope } from "../packages/sdk/src/runtime-scope.ts";

const facade = () =>
  ({
    getTransform() {
      return { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] };
    },
    setTransform() {},
    getComponent() {
      return {};
    },
    setComponent() {},
    query() {
      return [];
    },
  }) as unknown as EngineFacade;
const validate = (value: JsonValue) => {
  if (
    !value ||
    typeof value !== "object" ||
    !("count" in value) ||
    !Number.isSafeInteger(value.count) ||
    Number(value.count) < 0
  )
    throw new Error("BAD_COUNT");
};
// Compile-time contracts: contexts cannot be invented when no setup produces them.
function contextTypeChecks() {
  // @ts-expect-error A non-void dependency context requires setup.
  defineGameRuntime<null, { value: number }>({
    version: "1",
    state: () => null,
    validateState() {},
    systems: [],
  });
}
void contextTypeChecks;
function game() {
  return defineGame({
    id: "counter",
    scene: defineScene({ id: "main", entities: [] }),
    ...defineGameRuntime<{ count: number }>({
      version: "1",
      state: () => ({ count: 0 }),
      validateState: validate,
      systems: [
        {
          id: "count",
          run(_ctx, _dt, state) {
            state.value.count++;
          },
        },
      ],
    }),
  });
}
test("composed runtime binds once, isolates instances and restores detached validated state", async () => {
  const a = instantiateGame(game(), facade()),
    b = instantiateGame(game(), facade());
  try {
    await Promise.all([a.ready, b.ready]);
    a.update(1 / 60);
    a.update(1 / 60);
    b.update(1 / 60);
    assert.deepEqual(a.snapshot!()!.payload, { count: 2 });
    assert.deepEqual(b.snapshot!()!.payload, { count: 1 });
    const checkpoint = a.snapshot!()!;
    a.update(1 / 60);
    a.restore!(checkpoint);
    a.update(1 / 60);
    assert.deepEqual(a.snapshot!()!.payload, { count: 3 });
    (checkpoint.payload as { count: number }).count = 999;
    const before = a.snapshot!()!;
    assert.throws(
      () => a.restore!({ ...before, payload: { count: -1 } }),
      /BAD_COUNT/,
    );
    assert.deepEqual(a.snapshot!(), before);
  } finally {
    a.dispose();
    b.dispose();
  }
});
test("composed runtime rejects duplicate bindings, invalid/async validators and cancelled setup", async () => {
  assert.throws(
    () =>
      defineGameRuntime({
        version: "1",
        state: () => 0,
        validateState() {},
        systems: [
          { id: "x", run() {} },
          { id: "x", run() {} },
        ],
      }),
    /TC_GAME_RUNTIME_SYSTEM/,
  );
  for (const validateState of [
    () => {
      throw new Error("INVALID");
    },
    async () => {},
  ]) {
    const instance = instantiateGame(
      defineGame({
        id: "bad",
        scene: defineScene({ id: "main", entities: [] }),
        ...defineGameRuntime({
          version: "1",
          state: () => null,
          validateState,
          systems: [],
        }),
      }),
      facade(),
    );
    await assert.rejects(instance.ready!, /INVALID|TC_GAME_RUNTIME_ASYNC/);
    instance.dispose();
  }
  let release!: () => void,
    disposed = 0;
  const instance = instantiateGame(
    defineGame({
      id: "cancel",
      scene: defineScene({ id: "main", entities: [] }),
      ...defineGameRuntime({
        version: "1",
        state: () => null,
        validateState() {},
        systems: [],
        async setup(scope) {
          scope.defer(() => disposed++);
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        },
      }),
    }),
    facade(),
  );
  instance.dispose();
  release();
  await assert.rejects(instance.ready!, /aborted|AbortError/);
  assert.equal(disposed, 1);
});
test("cleanup early release is idempotent, unregisters and preserves reverse disposal", () => {
  const owner = createRuntimeScope(facade(), "test"),
    order: number[] = [];
  owner.scope.defer(() => order.push(1));
  const early = owner.scope.cleanup(() => order.push(2));
  owner.scope.defer(() => order.push(3));
  early();
  early();
  owner.dispose();
  owner.dispose();
  assert.deepEqual(order, [2, 3, 1]);
  assert.throws(
    () => owner.scope.cleanup(null as never),
    /TC_GAME_RUNTIME_DISPOSE/,
  );
});
test("setup returns typed transient dependencies per instance without serializing or sharing resources", async () => {
  let created = 0,
    released = 0;
  const calls: [number, number][] = [];
  type Dependencies = {
    id: number;
    cache: Map<string, number>;
    show(value: number): void;
  };
  const definition = defineGame({
    id: "context",
    scene: defineScene({ id: "main", entities: [] }),
    ...defineGameRuntime<{ count: number }, Dependencies>({
      version: "1",
      state: () => ({ count: 0 }),
      validateState: validate,
      async setup(scope) {
        const id = ++created,
          cache = new Map<string, number>();
        scope.defer(() => {
          released++;
          cache.clear();
        });
        return {
          id,
          cache,
          show(value) {
            calls.push([id, value]);
          },
        };
      },
      systems: [
        {
          id: "tick",
          run(_ctx, _dt, state, _scope, dependencies) {
            state.value.count++;
            dependencies.cache.set("last", state.value.count);
            dependencies.show(state.value.count);
          },
        },
      ],
    }),
  });
  const a = instantiateGame(definition, facade()),
    b = instantiateGame(definition, facade());
  try {
    await Promise.all([a.ready, b.ready]);
    a.update(1 / 60);
    b.update(1 / 60);
    const saved = a.snapshot!()!;
    a.update(1 / 60);
    a.restore!(saved);
    a.update(1 / 60);
    assert.deepEqual(a.snapshot!()!.payload, { count: 2 });
    assert.deepEqual(calls, [
      [1, 1],
      [2, 1],
      [1, 2],
      [1, 2],
    ]);
    a.dispose();
    b.update(1 / 60);
    assert.deepEqual(calls.at(-1), [2, 2]);
    assert.equal(released, 1);
  } finally {
    a.dispose();
    b.dispose();
  }
  assert.equal(created, 2);
  assert.equal(released, 2);
});
