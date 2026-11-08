import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { WebSocketServer } from "ws";
import {
  createWorkerAdapter,
  createWebSocketAdapter,
  loadRuntimeJSON,
  loadRuntimeBytes,
  type EngineFacade,
} from "../packages/sdk/src/index.ts";
import { createRuntimeScope } from "../packages/sdk/src/runtime-scope.ts";

class Endpoint extends EventTarget {
  closed = 0;
  readyState = 1;
  sent: unknown[] = [];
  postMessage(value: unknown, transfer: Transferable[]) {
    this.sent.push([value, transfer]);
  }
  terminate() {
    this.closed++;
  }
  send(value: unknown) {
    this.sent.push(value);
  }
  close() {
    this.closed++;
    this.dispatchEvent(new Event("close"));
  }
}
const owner = () => createRuntimeScope({} as EngineFacade, "integration");
const decode = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new Error("NUMBER");
  return value;
};
test("concrete adapters keep their claimed endpoint when author configuration is reused", () => {
  const scope = owner(),
    first = new Endpoint(),
    second = new Endpoint();
  const workerInput = {
    id: "stable-worker",
    version: "1",
    endpoint: first as unknown as Worker,
    ownership: "owned" as const,
    decode,
  };
  const worker = createWorkerAdapter(scope.scope, workerInput);
  workerInput.endpoint = second as unknown as Worker;
  worker.send(1);
  assert.equal(first.sent.length, 1);
  assert.equal(second.sent.length, 0);
  const socketInput = {
    id: "stable-socket",
    version: "1",
    endpoint: second as unknown as WebSocket,
    ownership: "owned" as const,
    decode,
    encode: JSON.stringify,
  };
  const socket = createWebSocketAdapter(scope.scope, socketInput);
  socketInput.endpoint = first as unknown as WebSocket;
  socket.send(2);
  assert.deepEqual(second.sent, ["2"]);
  scope.dispose();
  assert.equal(first.closed, 1);
  assert.equal(second.closed, 1);
});
test("Worker adapter transfers explicitly, drains validated data and releases only owned endpoints", () => {
  for (const ownership of ["owned", "borrowed"] as const) {
    const scope = owner(),
      endpoint = new Endpoint(),
      transferred = new ArrayBuffer(4);
    const bridge = createWorkerAdapter(scope.scope, {
      id: "worker",
      version: "1",
      endpoint: endpoint as unknown as Worker,
      ownership,
      decode,
      transfer: () => [transferred],
    });
    bridge.send(1);
    assert.deepEqual(endpoint.sent, [[1, [transferred]]]);
    endpoint.dispatchEvent(new MessageEvent("message", { data: 2 }));
    assert.deepEqual(bridge.drain(), [2]);
    endpoint.dispatchEvent(new MessageEvent("message", { data: "bad" }));
    assert.throws(() => bridge.drain(), /TC_ADAPTER_MESSAGE.*NUMBER/);
    scope.dispose();
    scope.dispose();
    assert.equal(endpoint.closed, ownership === "owned" ? 1 : 0);
    endpoint.dispatchEvent(new MessageEvent("message", { data: 3 }));
    assert.equal(bridge.inspect().state, "disposed");
  }
});
test("WebSocket adapter validates frames, encodes output and reports disconnect without hidden reconnect", () => {
  const scope = owner(),
    endpoint = new Endpoint();
  const bridge = createWebSocketAdapter(scope.scope, {
    id: "socket",
    version: "1",
    endpoint: endpoint as unknown as WebSocket,
    ownership: "owned",
    decode: (value) => decode(JSON.parse(String(value))),
    encode: JSON.stringify,
  });
  bridge.send(4);
  assert.deepEqual(endpoint.sent, ["4"]);
  endpoint.dispatchEvent(new MessageEvent("message", { data: "5" }));
  assert.deepEqual(bridge.drain(), [5]);
  endpoint.dispatchEvent(new Event("close"));
  assert.throws(() => bridge.drain(), /TC_SOCKET_CLOSED/);
  scope.dispose();
  assert.equal(endpoint.closed, 1);
});
test("concrete WebSocket adapter exchanges frames with a real third-party ws server", async () => {
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  server.on("connection", (socket) =>
    socket.on("message", (data) => socket.send(data.toString())),
  );
  await once(server, "listening");
  const scope = owner();
  const socket = new WebSocket(
    `ws://127.0.0.1:${(server.address() as { port: number }).port}`,
  );
  const adapter = createWebSocketAdapter<number, number>(scope.scope, {
    id: "real-socket",
    version: "1",
    endpoint: socket,
    ownership: "owned",
    decode: (value) => decode(JSON.parse(String(value))),
    encode: JSON.stringify,
  });
  try {
    await once(socket, "open");
    const received = once(socket, "message");
    adapter.send(42);
    await received;
    assert.deepEqual(adapter.drain(), [42]);
    scope.dispose();
    assert.equal(adapter.inspect().state, "disposed");
  } finally {
    scope.dispose();
    for (const client of server.clients) client.terminate();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
test("concrete adapters reject invalid endpoints and clean partially attached listeners immediately", () => {
  const scope = owner();
  assert.throws(
    () => createWorkerAdapter(scope.scope, { endpoint: {} } as never),
    /TC_ADAPTER_CONTRACT/,
  );
  assert.throws(
    () =>
      createWebSocketAdapter(scope.scope, {
        endpoint: new Endpoint(),
      } as never),
    /TC_ADAPTER_CONTRACT/,
  );
  class Broken extends Endpoint {
    attached = new Set<string>();
    override addEventListener(
      type: string,
      listener: EventListenerOrEventListenerObject | null,
      options?: AddEventListenerOptions | boolean,
    ) {
      if (type === "error") throw new Error("INJECTED_LISTENER");
      this.attached.add(type);
      super.addEventListener(type, listener, options);
    }
    override removeEventListener(
      type: string,
      listener: EventListenerOrEventListenerObject | null,
      options?: EventListenerOptions | boolean,
    ) {
      this.attached.delete(type);
      super.removeEventListener(type, listener, options);
    }
  }
  const endpoint = new Broken();
  assert.throws(
    () =>
      createWorkerAdapter(scope.scope, {
        id: "broken",
        version: "1",
        endpoint: endpoint as unknown as Worker,
        ownership: "owned",
        decode,
      }),
    /INJECTED_LISTENER/,
  );
  assert.equal(endpoint.attached.size, 0);
  assert.equal(endpoint.closed, 1);
  scope.dispose();
  assert.equal(endpoint.closed, 1);
});
test("dynamic JSON enforces bytes, validation, HTTP errors, timeout and instance cancellation", async () => {
  const server = createServer((request, response) => {
    if (request.url === "/slow") return;
    if (request.url === "/http") {
      response.writeHead(404);
      response.end();
      return;
    }
    if (request.url === "/stream") {
      response.writeHead(200, { "content-type": "application/json" });
      response.write("[");
      response.end("1,2,3,4,5]");
      return;
    }
    response.end("42");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    scope = owner();
  try {
    assert.equal(await loadRuntimeJSON(scope.scope, { url: base, decode }), 42);
    await assert.rejects(
      loadRuntimeJSON(scope.scope, { url: base, maxBytes: 1, decode }),
      /TC_RUNTIME_FETCH.*exceeds/,
    );
    await assert.rejects(
      loadRuntimeJSON(scope.scope, {
        url: base + "/stream",
        maxBytes: 3,
        decode,
      }),
      /TC_RUNTIME_FETCH.*exceeds/,
    );
    await assert.rejects(
      loadRuntimeJSON(scope.scope, { url: base + "/http", decode }),
      /HTTP 404/,
    );
    await assert.rejects(
      loadRuntimeJSON(scope.scope, {
        url: base,
        decode() {
          throw new Error("DECODE");
        },
      }),
      /DECODE/,
    );
    await assert.rejects(
      loadRuntimeJSON(scope.scope, { url: base, decode: async () => 0 }),
      /decode must be synchronous/,
    );
    await assert.rejects(
      loadRuntimeJSON(scope.scope, {
        url: base + "/slow",
        timeoutMs: 20,
        decode,
      }),
      /Deadline/,
    );
    for (const options of [{ maxBytes: 0 }, { timeoutMs: 120001 }])
      await assert.rejects(
        loadRuntimeJSON(scope.scope, { url: base, decode, ...options }),
        /Use maxBytes/,
      );
    const pending = loadRuntimeJSON(scope.scope, {
      url: base + "/slow",
      decode,
    });
    scope.dispose();
    await assert.rejects(pending, /cancelled|abort/i);
  } finally {
    scope.dispose();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
test("binary fetch preserves exact bytes, bounds chunked responses and aborts active bodies", async () => {
  const bytes = new Uint8Array([0, 255, 128, 0, 42]);
  const server = createServer((request, response) => {
    if (request.url === "/pending") {
      response.writeHead(200);
      response.write(bytes.subarray(0, 1));
      return;
    }
    response.writeHead(200, { "content-type": "application/octet-stream" });
    response.write(bytes.subarray(0, 2));
    response.end(bytes.subarray(2));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    scope = owner();
  try {
    assert.deepEqual(
      await loadRuntimeBytes(scope.scope, { url: new URL(base) }),
      bytes,
    );
    await assert.rejects(
      loadRuntimeBytes(scope.scope, { url: base, maxBytes: 4 }),
      /TC_RUNTIME_FETCH.*exceeds/,
    );
    await assert.rejects(
      loadRuntimeBytes(scope.scope, { url: base + "/pending", timeoutMs: 30 }),
      /Deadline/,
    );
    const pending = loadRuntimeBytes(scope.scope, { url: base + "/pending" });
    scope.dispose();
    await assert.rejects(pending, /cancelled|abort/i);
    await assert.rejects(
      loadRuntimeBytes(scope.scope, { url: base }),
      /abort/i,
    );
  } finally {
    scope.dispose();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
