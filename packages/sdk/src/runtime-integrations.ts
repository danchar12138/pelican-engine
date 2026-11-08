import type {
  GameRuntimeScope,
  RuntimeJSONInput,
  WorkerAdapterInput,
  WebSocketAdapterInput,
} from "./index.ts";
import { createMessageBridge } from "./runtime-adapter.ts";
import { trackRuntimeRelease } from "./runtime-scope.ts";
import { isAsyncValue, handleNativeRejection } from "./runtime-async.ts";

function subscribeEvents(
  scope: GameRuntimeScope,
  endpoint: EventTarget,
  handlers: readonly (readonly [string, EventListener])[],
) {
  const removers: (() => void)[] = [];
  const detach = () => {
    const failures: unknown[] = [];
    for (const remove of removers.splice(0).reverse())
      try {
        remove();
      } catch (error) {
        failures.push(error);
      }
    if (failures.length)
      throw new AggregateError(
        failures,
        "TC_ADAPTER_DISPOSE: Could not remove every transport listener.",
      );
  };
  try {
    for (const [type, listener] of handlers)
      removers.push(scope.listen(endpoint, type, listener));
    return detach;
  } catch (error) {
    try {
      detach();
    } catch (cleanup) {
      throw new AggregateError(
        [error, cleanup],
        "TC_ADAPTER_INIT: Subscription and cleanup failed.",
      );
    }
    throw error;
  }
}

export function bridgeWorker<I, O>(
  scope: GameRuntimeScope,
  input: WorkerAdapterInput<I, O>,
) {
  if (
    !input?.endpoint ||
    typeof input.endpoint.postMessage !== "function" ||
    typeof input.endpoint.terminate !== "function"
  )
    throw new Error(
      "TC_ADAPTER_CONTRACT: Worker endpoint requires postMessage, terminate and EventTarget subscriptions.",
    );
  const { endpoint, transfer } = input;
  return createMessageBridge<I, O>(scope, {
    ...input,
    ...(input.ownership === "owned"
      ? {
          ownership: "owned" as const,
          release: () => endpoint.terminate(),
        }
      : { ownership: "borrowed" as const }),
    send: (value) => endpoint.postMessage(value, transfer?.(value) ?? []),
    subscribe(receive, fail) {
      return subscribeEvents(scope, endpoint, [
        ["message", (event) => receive((event as MessageEvent).data)],
        [
          "messageerror",
          () => fail("TC_WORKER_MESSAGE: Worker payload could not be decoded."),
        ],
        [
          "error",
          (event) => fail(`TC_WORKER_ERROR: ${(event as ErrorEvent).message}`),
        ],
      ]);
    },
  });
}

export function bridgeWebSocket<I, O>(
  scope: GameRuntimeScope,
  input: WebSocketAdapterInput<I, O>,
) {
  if (
    !input?.endpoint ||
    typeof input.endpoint.send !== "function" ||
    typeof input.endpoint.close !== "function" ||
    typeof input.encode !== "function"
  )
    throw new Error(
      "TC_ADAPTER_CONTRACT: WebSocket endpoint requires send, close, EventTarget subscriptions and an encode function.",
    );
  const { endpoint, encode } = input;
  return createMessageBridge<I, O>(scope, {
    ...input,
    ...(input.ownership === "owned"
      ? {
          ownership: "owned" as const,
          release: () => endpoint.close(1000, "game instance released"),
        }
      : { ownership: "borrowed" as const }),
    send(value) {
      if (endpoint.readyState !== 1)
        throw new Error(
          `TC_SOCKET_NOT_OPEN: ${input.id}; wait for OPEN before sending.`,
        );
      endpoint.send(encode(value));
    },
    subscribe(receive, fail) {
      return subscribeEvents(scope, endpoint, [
        ["message", (event) => receive((event as MessageEvent).data)],
        [
          "error",
          () =>
            fail(
              `TC_SOCKET_ERROR: ${input.id}; inspect transport/CORS/server diagnostics.`,
            ),
        ],
        [
          "close",
          (event) =>
            fail(
              `TC_SOCKET_CLOSED: ${input.id}; code ${(event as CloseEvent).code}; explicitly reconnect/resynchronize if required.`,
            ),
        ],
      ]);
    },
  });
}

export async function fetchRuntimeJSON<T>(
  scope: GameRuntimeScope,
  input: RuntimeJSONInput<T>,
): Promise<T> {
  const maxBytes = input.maxBytes ?? 1048576,
    timeoutMs = input.timeoutMs ?? 10000;
  const fail = (message: string) =>
    new Error(`TC_RUNTIME_FETCH: ${String(input.url)}; ${message}`);
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    maxBytes > 67108864 ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 120000 ||
    typeof input.decode !== "function"
  )
    throw fail(
      "Use maxBytes 1..67108864, timeoutMs 1..120000 and a synchronous decode function.",
    );
  scope.signal.throwIfAborted();
  const controller = new AbortController();
  const cancel = trackRuntimeRelease(scope, () =>
    controller.abort(fail("Instance released; request cancelled.")),
  );
  const timer = setTimeout(
    () => controller.abort(fail(`Deadline ${timeoutMs}ms exceeded.`)),
    timeoutMs,
  );
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const response = await fetch(input.url, { signal: controller.signal });
    if (!response.ok)
      throw fail(`HTTP ${response.status}; check the URL and server.`);
    const length = response.headers.get("content-length");
    if (length !== null && Number(length) > maxBytes)
      throw fail(`Body exceeds maxBytes ${maxBytes}.`);
    if (!response.body) throw fail("Response has no body.");
    reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      controller.signal.throwIfAborted();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw fail(`Body exceeds maxBytes ${maxBytes}.`);
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    const result = input.decode(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
    );
    if (isAsyncValue(result)) {
      handleNativeRejection(result);
      throw fail(
        "decode must be synchronous; prepare asynchronously before publishing on a fixed tick.",
      );
    }
    scope.signal.throwIfAborted();
    return result;
  } catch (error) {
    throw fail(`Dynamic JSON was not published. ${String(error)}`);
  } finally {
    clearTimeout(timer);
    try {
      await reader?.cancel();
    } catch {
      /* Cancellation may already have closed the transport. */
    }
    reader?.releaseLock();
    cancel();
  }
}
