import type {
  GameRuntimeScope,
  RuntimeAdapterInput,
  RuntimeMessageAdapter,
} from "./index.ts";
import { trackRuntimeRelease, claimRuntimeResource } from "./runtime-scope.ts";
import { isAsyncValue, handleNativeRejection } from "./runtime-async.ts";

const owners = new WeakMap<GameRuntimeScope, Set<string>>();
const synchronous = (value: unknown) => {
  if (isAsyncValue(value)) {
    handleNativeRejection(value);
    throw new Error(
      "Callback returned a promise; perform asynchronous preparation before accepting a message.",
    );
  }
};

/** Queue arbitrary validated external data without giving asynchronous callbacks ECS/GPU ownership. */
export function createMessageBridge<I, O>(
  scope: GameRuntimeScope,
  input: RuntimeAdapterInput<I, O>,
): RuntimeMessageAdapter<I, O> {
  if (!scope?.signal || typeof scope.defer !== "function")
    throw new Error(
      "TC_ADAPTER_SCOPE: Use the GameRuntimeScope supplied to runtime.create.",
    );
  if (!input || typeof input !== "object")
    throw new Error("TC_ADAPTER_CONTRACT: Supply an adapter definition.");
  const { id, version, ownership, endpoint } = input;
  const capacity = input.capacity ?? 256;
  if (
    typeof id !== "string" ||
    !id.trim() ||
    typeof version !== "string" ||
    !version.trim() ||
    !Number.isSafeInteger(capacity) ||
    capacity < 1 ||
    capacity > 65536 ||
    typeof input.decode !== "function" ||
    typeof input.subscribe !== "function" ||
    typeof input.send !== "function" ||
    !endpoint ||
    !["object", "function"].includes(typeof endpoint) ||
    !["owned", "borrowed"].includes(ownership) ||
    (ownership === "owned"
      ? typeof input.release !== "function"
      : input.release !== undefined)
  )
    throw new Error(
      "TC_ADAPTER_CONTRACT: Supply id/version, synchronous send/decode/subscribe, capacity 1..65536 and explicit owned/borrowed ownership. Owned endpoints require release().",
    );
  if (scope.signal.aborted)
    throw new Error(
      `TC_ADAPTER_DISPOSED: ${id}; create adapters inside a live runtime.create.`,
    );
  const ids = owners.get(scope) ?? new Set<string>();
  if (ids.has(id))
    throw new Error(
      `TC_ADAPTER_DUPLICATE: ${id}; use a unique adapter ID per game instance.`,
    );
  const unclaim =
    ownership === "owned"
      ? claimRuntimeResource(scope, endpoint, id)
      : () => {};
  owners.set(scope, ids);
  ids.add(id);
  let state: "active" | "faulted" | "disposed" = "active";
  const isDisposed = () => state === "disposed";
  let fault: Error | undefined;
  let queue: I[] = [];
  let received = 0,
    sent = 0,
    drained = 0;
  let unsubscribe: (() => void) | undefined;
  let releaseEndpoint: (() => void) | undefined =
    ownership === "owned" ? input.release : undefined;
  let send: ((message: O) => void) | undefined = input.send;
  let decode: ((message: unknown) => I) | undefined = input.decode;
  const fail = (reason: unknown) => {
    if (state !== "active") return;
    state = "faulted";
    fault = new Error(
      `TC_ADAPTER_MESSAGE: ${id}@${version}; ${String(reason)} Repair the external protocol or recreate the adapter.`,
      { cause: reason },
    );
    queue = [];
  };
  const assertActive = () => {
    if (state === "disposed")
      throw new Error(
        `TC_ADAPTER_DISPOSED: ${id}; this endpoint no longer belongs to a live instance.`,
      );
    if (fault) throw fault;
  };
  const dispose = trackRuntimeRelease(scope, () => {
    if (state === "disposed") return;
    state = "disposed";
    queue = [];
    ids.delete(id);
    const detached = unsubscribe,
      closed = releaseEndpoint;
    unsubscribe = undefined;
    releaseEndpoint = undefined;
    send = undefined;
    decode = undefined;
    const errors: unknown[] = [];
    for (const operation of [detached, closed])
      if (operation)
        try {
          synchronous(operation());
        } catch (error) {
          errors.push(error);
        }
    unclaim();
    if (errors.length)
      throw new AggregateError(
        errors,
        `TC_ADAPTER_DISPOSE: ${id}; detach listeners and release the owned endpoint synchronously.`,
      );
  });
  try {
    const detached: unknown = input.subscribe((value) => {
      if (state !== "active" || scope.signal.aborted) return;
      try {
        if (queue.length >= capacity)
          throw new Error(
            `TC_ADAPTER_OVERFLOW: ${id}; consume messages in synchronous systems or increase the explicit capacity.`,
          );
        const result = decode!(value);
        synchronous(result);
        if (state !== "active" || scope.signal.aborted) return;
        queue.push(result);
        received++;
      } catch (error) {
        fail(error);
      }
    }, fail);
    if (typeof detached !== "function") {
      if (isAsyncValue(detached)) {
        void Promise.resolve(detached).then(
          (late) => {
            if (typeof late === "function")
              try {
                synchronous(late());
              } catch (error) {
                fault = new Error(
                  `TC_ADAPTER_DISPOSE: ${id}; late unsubscribe failed. ${String(error)}`,
                  { cause: error },
                );
              }
          },
          () => {},
        );
      }
      synchronous(detached);
      throw new Error(
        "subscribe must return a synchronous unsubscribe function.",
      );
    }
    if (isDisposed()) synchronous(detached());
    else unsubscribe = detached as () => void;
    if (scope.signal.aborted) dispose();
    assertActive();
  } catch (error) {
    try {
      dispose();
    } catch (cleanup) {
      throw new AggregateError(
        [error, cleanup],
        `TC_ADAPTER_INIT: ${id}; initialization and cleanup failed.`,
      );
    }
    throw new Error(
      `TC_ADAPTER_INIT: ${id}; fix subscribe and endpoint readiness. ${String(error)}`,
      { cause: error },
    );
  }
  return {
    send(value) {
      assertActive();
      try {
        synchronous(send!(value));
        sent++;
      } catch (error) {
        fail(error);
        throw (
          fault ??
          new Error(
            `TC_ADAPTER_SEND: ${id}; transport failed after disposal. ${String(error)}`,
            { cause: error },
          )
        );
      }
    },
    drain(limit = capacity) {
      assertActive();
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > capacity)
        throw new Error(
          `TC_ADAPTER_LIMIT: ${id}; drain limit must be 1..${capacity}.`,
        );
      const values = queue.splice(0, limit);
      drained += values.length;
      return values;
    },
    clear() {
      assertActive();
      queue = [];
    },
    inspect: () => ({
      id,
      version,
      ownership,
      state,
      capacity,
      queued: queue.length,
      received,
      sent,
      drained,
      ...(fault ? { error: fault.message } : {}),
    }),
    dispose,
  };
}
