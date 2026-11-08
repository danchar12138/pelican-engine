import test from "node:test";
import assert from "node:assert/strict";
import {
  defineGame,
  defineScene,
  instantiateGame,
  createRuntimeAdapter,
  type GameRuntimeScope,
  type RuntimeAdapterInput,
} from "../packages/sdk/src/index.ts";

function rig() {
  let scope!: GameRuntimeScope;
  const game = instantiateGame(
    defineGame({
      id: "adapters",
      scene: defineScene({ id: "main", entities: [] }),
      runtime: {
        version: "1",
        create(value) {
          scope = value;
        },
      },
    }),
    {} as any,
  );
  return { game, scope };
}
function transport() {
  let receive = (_: unknown) => {},
    fail = (_: unknown) => {};
  let closed = 0,
    detached = 0;
  const sent: number[] = [];
  const endpoint = {};
  const input: RuntimeAdapterInput<number, number> = {
    id: "test",
    version: "1",
    endpoint,
    ownership: "owned",
    capacity: 2,
    decode(value) {
      if (typeof value !== "number" || !Number.isFinite(value))
        throw new Error("Expected a finite number");
      return value;
    },
    subscribe(accept, reject) {
      receive = accept;
      fail = reject;
      return () => {
        detached++;
      };
    },
    send: (value) => {
      sent.push(value);
    },
    release: () => {
      closed++;
    },
  };
  return {
    input,
    sent,
    push: (value: unknown) => receive(value),
    fail: (error: unknown) => fail(error),
    counts: () => ({ closed, detached }),
  };
}

test("external adapters queue arbitrary validated messages and drain only at author-selected ticks", () => {
  const { game, scope } = rig(),
    native = transport();
  const adapter = createRuntimeAdapter(scope, native.input);
  try {
    native.push(1);
    native.push(2);
    assert.equal(adapter.inspect().queued, 2);
    assert.deepEqual(adapter.drain(1), [1]);
    adapter.send(42);
    assert.deepEqual(native.sent, [42]);
    assert.deepEqual(adapter.drain(), [2]);
    assert.throws(() => adapter.drain(0), /TC_ADAPTER_LIMIT/);
    native.push(3);
    adapter.clear();
    assert.deepEqual(adapter.drain(), []);
    assert.equal(adapter.inspect().received, 3);
  } finally {
    game.dispose();
  }
  native.push(999);
  assert.equal(adapter.inspect().state, "disposed");
  assert.equal(adapter.inspect().queued, 0);
  assert.deepEqual(native.counts(), { closed: 1, detached: 1 });
  adapter.dispose();
  game.dispose();
  assert.equal(native.counts().closed, 1);
  assert.throws(() => adapter.send(1), /TC_ADAPTER_DISPOSED/);
});

test("malformed messages, overflow and asynchronous decode fault safely instead of mutating engine state", () => {
  for (const error of ["decode", "overflow", "async", "transport"]) {
    const { game, scope } = rig(),
      native = transport();
    if (error === "async")
      native.input.decode = (() => Promise.resolve(1)) as any;
    const adapter = createRuntimeAdapter(scope, native.input);
    if (error === "decode") native.push("bad");
    else if (error === "overflow") {
      native.push(1);
      native.push(2);
      native.push(3);
    } else if (error === "async") native.push(1);
    else native.fail(new Error("network failed"));
    assert.equal(adapter.inspect().state, "faulted");
    assert.equal(adapter.inspect().queued, 0);
    assert.throws(() => adapter.drain(), /TC_ADAPTER_MESSAGE/);
    native.push(4);
    assert.equal(adapter.inspect().queued, 0);
    game.dispose();
    assert.equal(native.counts().closed, 1);
  }
});

test("owned endpoints cannot be double-owned across adapters or instances; borrowing only detaches", () => {
  const a = rig(),
    b = rig(),
    native = transport();
  const owner = createRuntimeAdapter(a.scope, native.input);
  assert.throws(
    () => createRuntimeAdapter(a.scope, { ...native.input, id: "other" }),
    /TC_GAME_RUNTIME_OWNERSHIP/,
  );
  assert.throws(
    () => createRuntimeAdapter(b.scope, native.input),
    /TC_GAME_RUNTIME_OWNERSHIP/,
  );
  assert.throws(
    () => a.scope.own(native.input.endpoint, () => {}),
    /TC_GAME_RUNTIME_OWNERSHIP/,
  );
  const { release, ...borrowed } = native.input;
  const observer = createRuntimeAdapter(b.scope, {
    ...borrowed,
    ownership: "borrowed",
  });
  observer.dispose();
  assert.equal(native.counts().closed, 0);
  owner.dispose();
  assert.equal(native.counts().closed, 1);
  a.game.dispose();
  b.game.dispose();
});

test("adapter initialization failures release endpoints and early disposal frees IDs and ownership", () => {
  const { game, scope } = rig(),
    native = transport();
  assert.throws(
    () =>
      createRuntimeAdapter(scope, {
        ...native.input,
        subscribe() {
          throw new Error("subscribe failed");
        },
      }),
    /TC_ADAPTER_INIT/,
  );
  assert.equal(native.counts().closed, 1);
  const adapter = createRuntimeAdapter(scope, native.input);
  assert.throws(
    () => createRuntimeAdapter(scope, native.input),
    /TC_ADAPTER_DUPLICATE/,
  );
  adapter.dispose();
  const next = createRuntimeAdapter(scope, native.input);
  next.dispose();
  game.dispose();
  assert.equal(native.counts().closed, 3);
});

test("ordinary npm resource release and EventTarget listeners are instance-owned and idempotent", () => {
  const { game, scope } = rig();
  const order: string[] = [],
    resource = {
      terminate() {
        order.push("worker");
      },
    };
  const terminate = (value: typeof resource) => value.terminate();
  assert.equal(scope.own(resource, terminate), resource);
  scope.own(resource, terminate);
  assert.throws(
    () => scope.own(resource, () => {}),
    /TC_GAME_RUNTIME_OWNERSHIP/,
  );
  const target = new EventTarget();
  let hits = 0;
  const remove = scope.listen(target, "message", () => {
    hits++;
  });
  target.dispatchEvent(new Event("message"));
  assert.equal(hits, 1);
  remove();
  remove();
  target.dispatchEvent(new Event("message"));
  assert.equal(hits, 1);
  scope.listen(
    target,
    "message",
    () => {
      hits++;
    },
    { once: true },
  );
  target.dispatchEvent(new Event("message"));
  target.dispatchEvent(new Event("message"));
  assert.equal(hits, 2);
  const cancellation = new AbortController();
  scope.listen(
    target,
    "message",
    () => {
      hits++;
    },
    { signal: cancellation.signal },
  );
  cancellation.abort();
  target.dispatchEvent(new Event("message"));
  assert.equal(hits, 2);
  scope.listen(target, "message", () => {
    hits++;
  });
  scope.defer(() => {
    order.push("last");
  });
  game.dispose();
  target.dispatchEvent(new Event("message"));
  assert.equal(hits, 2);
  assert.deepEqual(order, ["last", "worker"]);
  scope.own(
    {
      close() {
        order.push("late");
      },
    },
    (value) => value.close(),
  );
  assert.deepEqual(order, ["last", "worker", "late"]);
});

test("listener cancellation and cleanup errors do not prevent other owned releases", () => {
  const { game, scope } = rig();
  let released = 0;
  scope.defer(() => {
    released++;
  });
  scope.listen(scope.signal, "abort", () => {
    throw new Error("abort cleanup failed");
  });
  assert.throws(() => game.dispose(), /TC_GAME_RUNTIME_DISPOSE/);
  assert.equal(released, 1);
  game.dispose();
});

test("custom data structures remain ordinary author data and are not silently added to saved state", () => {
  const { game, scope } = rig(),
    native = transport();
  const adapter = createRuntimeAdapter<Map<string, number>, number>(scope, {
    ...native.input,
    decode(value) {
      if (!(value instanceof Map)) throw new Error("Expected Map");
      return value;
    },
  });
  const data = new Map([["score", 3]]);
  native.push(data);
  assert.equal(adapter.drain()[0], data);
  assert.equal(game.snapshot!()!.payload, null);
  game.dispose();
});

test("late asynchronous unsubscribe is rejected but still cleaned up after initialization fails", async () => {
  const { game, scope } = rig(),
    native = transport();
  let resolve!: (value: () => void) => void,
    detached = 0;
  assert.throws(
    () =>
      createRuntimeAdapter(scope, {
        ...native.input,
        subscribe: (() =>
          new Promise<() => void>((done) => {
            resolve = done;
          })) as any,
      }),
    /TC_ADAPTER_INIT/,
  );
  assert.equal(native.counts().closed, 1);
  resolve(() => {
    detached++;
  });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(detached, 1);
  game.dispose();
});

test("multiple registrations of the same defer callback each keep their original exactly-once semantics", () => {
  const { game, scope } = rig();
  let calls = 0;
  const release = () => {
    calls++;
  };
  scope.defer(release);
  scope.defer(release);
  game.dispose();
  game.dispose();
  assert.equal(calls, 2);
});

test("ordinary data fields named then are not mistaken for asynchronous work", () => {
  const { game, scope } = rig(),
    native = transport();
  const adapter = createRuntimeAdapter<
    { then: boolean; value: number },
    number
  >(scope, {
    ...native.input,
    decode(value) {
      return value as { then: boolean; value: number };
    },
  });
  native.push({ then: false, value: 3 });
  assert.deepEqual(adapter.drain(), [{ then: false, value: 3 }]);
  game.dispose();
  const saved = instantiateGame(
    defineGame({
      id: "plain-then",
      scene: defineScene({ id: "s", entities: [] }),
      runtime: {
        version: "1",
        create() {
          return {
            snapshot: () => ({ then: false, value: 1 }),
            validateSnapshot() {},
            restore() {},
          };
        },
      },
    }),
    {} as any,
  );
  assert.deepEqual(saved.snapshot!()!.payload, { then: false, value: 1 });
  saved.dispose();
});

test("JSON state validation never invokes a then getter while detecting asynchronous hooks", () => {
  let calls = 0;
  const game = instantiateGame(
    defineGame({
      id: "getter",
      scene: defineScene({ id: "s", entities: [] }),
      runtime: {
        version: "1",
        create() {
          return {
            snapshot: () =>
              Object.defineProperty({ value: 1 }, "then", {
                enumerable: true,
                get() {
                  calls++;
                  return () => {};
                },
              }) as any,
            validateSnapshot() {},
            restore() {},
          };
        },
      },
    }),
    {} as any,
  );
  assert.throws(() => game.snapshot!());
  assert.equal(calls, 0);
  game.dispose();
});

test("explicit release adapters never inspect a third-party dispose property", () => {
  const { game, scope } = rig();
  let reads = 0,
    closed = 0;
  const resource = {
    close() {
      closed++;
    },
    get dispose(): never {
      reads++;
      throw new Error("not an engine disposable");
    },
  };
  scope.own(resource, (value) => value.close());
  game.dispose();
  assert.equal(reads, 0);
  assert.equal(closed, 1);
});

test("separate SDK module copies share endpoint ownership within one realm", async () => {
  const firstURL = new URL("../packages/sdk/src/runtime-scope.ts?copy=first", import.meta.url);
  const secondURL = new URL("../packages/sdk/src/runtime-scope.ts?copy=second", import.meta.url);
  const first = await import(firstURL.href), second = await import(secondURL.href);
  const a = first.createRuntimeScope({}, "first"), b = second.createRuntimeScope({}, "second");
  let closed = 0; const resource = { close() { closed++; } };
  a.scope.own(resource, (value: typeof resource) => value.close());
  assert.throws(() => b.scope.own(resource, (value: typeof resource) => value.close()), /TC_GAME_RUNTIME_OWNERSHIP/);
  b.dispose(); assert.equal(closed, 0); a.dispose(); assert.equal(closed, 1);
});
