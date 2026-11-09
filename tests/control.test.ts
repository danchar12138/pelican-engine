import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import {
  createServer as createHTTPServer,
  request as httpRequest,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { createServer as createViteServer, type ViteDevServer } from "vite";
import {
  attachControl,
  attachControlForTests,
  captureControlPage,
  type ControlPage,
  type ControlPageFactory,
  type ControlStatus,
} from "../tools/control-server.ts";
import { createControlClient } from "../tools/control-client.ts";
import { AutomationError } from "../tools/browser-session.ts";
import {
  result,
  type ControlCommand,
  type Envelope,
} from "../packages/protocol/src/index.ts";

// A known CPU fixture, not a rendered game image or GPU acceptance evidence.
const capturePNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aRp8AAAAASUVORK5CYII=",
  "base64",
);
test("structured runtime causes survive transport while free-text secrets and unsafe source paths do not", async t => {
  const fake = adapter(async () => result("runtime", "failed", null, [{ code: "TC_RUNTIME_SYSTEM", severity: "error", message: "private C:/secret/file token", remediation: "private secret", causeCodes: ["TC_PHYSICS_OPERATION", "TC_PHYSICS_SNAPSHOT"], tick: 18, stage: "system:$engine.physics", partialState: true, source: { file: "game.ts", line: 12, column: 4 } }]));
  const f = await fixture(t, async () => fake.page);
  const response = await f.client.send({ type: "step", count: 1 });
  assert.equal(response.status, "failed"); assert.deepEqual(response.diagnostics[0].causeCodes, ["TC_PHYSICS_OPERATION", "TC_PHYSICS_SNAPSHOT"]);
  assert.equal(response.diagnostics[0].tick, 18); assert.equal(response.diagnostics[0].stage, "system:$engine.physics");
  assert.deepEqual(response.diagnostics[0].source, { file: "game.ts", line: 12, column: 4 }); assert.equal(response.diagnostics[0].partialState, true);
  assert.doesNotMatch(JSON.stringify(response), /secret/);
});
test("boot failures retain sanitized engine causes and a targeted repair instead of hiding drift", async t => {
  const f = await fixture(t, async () => { throw new AutomationError("TC_AUTOMATION_BOOT_FAILED", "TC_GAME_CONSTRUCTION_DRIFT: C:/private/secret.ts; token=private-secret"); });
  const response = await f.client.send({ type: "inspect" });
  assert.equal(response.status, "failed");
  assert.equal(response.diagnostics[0].code, "TC_AUTOMATION_BOOT_FAILED");
  assert.deepEqual(response.diagnostics[0].causeCodes, ["TC_GAME_CONSTRUCTION_DRIFT"]);
  assert.match(response.diagnostics[0].remediation, /runtime.create\/setup/);
  assert.doesNotMatch(JSON.stringify(response), /secret|C:\//);
});

test("capture returns the owned viewport PNG after step, reusing the serialized session", async (t) => {
  let tick = 0;
  let capturedTick = -1;
  let screenshotCalls = 0;
  const screenshotGate = deferred<Buffer>();
  const fake = adapter(async (command) => {
    if (command.type === "capture")
      return captureControlPage(
        {
          viewportSize: () => ({ width: 1, height: 1 }),
          screenshot: async (options) => {
            assert.deepEqual(options, { type: "png", timeout: 1_000 });
            capturedTick = tick;
            screenshotCalls++;
            return screenshotGate.promise;
          },
        },
        1_000,
      );
    if (command.type === "step") tick += command.count;
    return result("runtime", "succeeded", { tick });
  });
  const f = await fixture(t, async () => fake.page);
  await f.client.send({ type: "pause" });
  await f.client.send({ type: "step", count: 30 });
  const capturing = f.client.send(
    { type: "capture" },
    { taskId: "capture-current" },
  );
  await waitFor(async () => screenshotCalls === 1);
  const inspect = f.client.send(
    { type: "inspect" },
    { taskId: "after-capture" },
  );
  await waitFor(async () =>
    data<ControlStatus>(await f.client.status()).tasks.some(
      (task) => task.taskId === "after-capture" && task.status === "queued",
    ),
  );
  assert.equal(fake.calls.length, 3);
  assert.equal(capturedTick, 30);
  screenshotGate.resolve(capturePNG);
  const response = await capturing;
  assert.equal(response.status, "succeeded");
  assert.equal(response.taskId, "capture-current");
  assert.deepEqual(response.data, {
    format: "png",
    base64: capturePNG.toString("base64"),
    width: 1,
    height: 1,
    bytes: capturePNG.length,
  });
  assert.deepEqual(
    Buffer.from(data<{ base64: string }>(response).base64, "base64"),
    capturePNG,
  );
  assert.equal(data<{ tick: number }>(await inspect).tick, 30);
  assert.equal(f.launches, 1);
  assert.equal(fake.closes, 0);
});

test("capture size cap fits unchanged client limits and oversized PNGs fail without image or reset", async (t) => {
  const limit = 6 * 1024 * 1024 - 3 * 1024;
  const accepted = await captureControlPage(
    {
      viewportSize: () => ({ width: 960, height: 540 }),
      screenshot: async () => Buffer.alloc(limit),
    },
    1_000,
  );
  assert.equal(accepted.status, "succeeded");
  assert.ok(Buffer.byteLength(JSON.stringify(accepted)) < 8 * 1024 * 1024);
  for (const bytes of [limit + 1, 6 * 1024 * 1024 + 1]) {
    const fake = adapter(async (command) =>
      command.type === "capture"
        ? captureControlPage(
            {
              viewportSize: () => ({ width: 960, height: 540 }),
              screenshot: async () => Buffer.alloc(bytes),
            },
            1_000,
          )
        : result("runtime", "succeeded", null),
    );
    const f = await fixture(t, async () => fake.page);
    const response = await f.client.send({ type: "capture" });
    assert.equal(response.status, "failed");
    assert.equal(response.diagnostics[0].code, "TC_CONTROL_CAPTURE_TOO_LARGE");
    assert.deepEqual(response.data, {
      format: "png",
      bytes,
      limitBytes: limit,
    });
    assert.equal("base64" in data<Record<string, unknown>>(response), false);
    assert.equal(
      data<ControlStatus>(await f.client.status()).sessionNeedsReset,
      false,
    );
    assert.equal(
      (await f.client.send({ type: "inspect" })).status,
      "succeeded",
    );
    assert.equal(f.launches, 1);
  }
});

test("capture never invents viewport dimensions or accepts output paths", async (t) => {
  let screenshots = 0;
  const response = await captureControlPage(
    {
      viewportSize: () => null,
      screenshot: async () => {
        screenshots++;
        return capturePNG;
      },
    },
    1_000,
  );
  assert.equal(response.status, "failed");
  assert.equal(response.diagnostics[0].code, "TC_CONTROL_CAPTURE_VIEWPORT");
  assert.equal(response.data, null);
  assert.equal(screenshots, 0);
  const f = await fixture(t);
  assert.equal(
    (
      await raw(
        f.url,
        "/__pelican/control",
        '{"type":"capture","path":"not-allowed.png"}',
      )
    ).status,
    400,
  );
  assert.equal(f.launches, 0);
});

test("pending capture shares fail-stop timeout and cancellation semantics, ignoring late PNGs", async (t) => {
  for (const operation of ["timeout", "cancel"] as const) {
    const image = deferred<Buffer>();
    let capturing = false;
    const fake = adapter(async () =>
      captureControlPage(
        {
          viewportSize: () => ({ width: 1, height: 1 }),
          screenshot: async () => {
            capturing = true;
            return image.promise;
          },
        },
        1_000,
      ),
    );
    const f = await fixture(t, async () => fake.page, {
      timeoutMs: operation === "timeout" ? 80 : 1_000,
    });
    const pending = f.client.send(
      { type: "capture" },
      { taskId: "pending-capture" },
    );
    await waitFor(async () => capturing);
    if (operation === "cancel") await f.client.cancel("pending-capture");
    const response = await pending;
    assert.equal(
      response.status,
      operation === "timeout" ? "timed_out" : "cancelled",
    );
    assert.equal(data<{ stateReset: boolean }>(response).stateReset, true);
    await waitFor(async () => fake.closes === 1);
    image.resolve(capturePNG);
    await new Promise((resolve) => setImmediate(resolve));
    const status = data<ControlStatus>(await f.client.status());
    assert.equal(status.sessionNeedsReset, true);
    assert.equal(
      status.tasks.find((task) => task.taskId === "pending-capture")?.status,
      response.status,
    );
    assert.equal(
      (await f.client.send({ type: "inspect" })).diagnostics[0].code,
      "TC_CONTROL_SESSION_RESET_REQUIRED",
    );
  }
});

test("screenshot transport failure is sanitized and discards the owned session", async (t) => {
  const fake = adapter(async () =>
    captureControlPage(
      {
        viewportSize: () => ({ width: 1, height: 1 }),
        screenshot: async () => {
          throw new Error("secret screenshot process path");
        },
      },
      1_000,
    ),
  );
  const f = await fixture(t, async () => fake.page);
  const response = await f.client.send({ type: "capture" });
  assert.equal(response.status, "failed");
  assert.equal(response.diagnostics[0].code, "TC_CONTROL_TRANSPORT_FAILURE");
  assert.equal(data<{ stateReset: boolean }>(response).stateReset, true);
  assert.doesNotMatch(JSON.stringify(response), /secret screenshot/);
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function adapter(dispatch?: ControlPage["dispatch"]) {
  const calls: ControlCommand[] = [];
  let closes = 0;
  let closed = false;
  const page: ControlPage = {
    isClosed: () => closed,
    dispatch: async (command) => {
      calls.push(command);
      return dispatch
        ? dispatch(command)
        : result("runtime-id", "succeeded", { transportFixture: true });
    },
    close: async () => {
      if (!closed) {
        closes++;
        closed = true;
      }
    },
  };
  return {
    page,
    calls,
    get closes() {
      return closes;
    },
    invalidate: () => {
      closed = true;
    },
  };
}
interface FixtureOptions {
  timeoutMs?: number;
  base?: string;
  bind?: string;
}
async function fixture(
  t: TestContext,
  factory?: ControlPageFactory,
  options: FixtureOptions = {},
) {
  const fake = adapter();
  let launches = 0;
  let receivedURL = "";
  const stack: {
    route: string;
    handle(req: IncomingMessage, res: ServerResponse, next: () => void): void;
  }[] = [];
  const http = createHTTPServer((req, res) => {
    let i = 0;
    const next = () => {
      const entry = stack[i++];
      if (entry) entry.handle(req, res, next);
      else {
        res.writeHead(404);
        res.end("not found");
      }
    };
    next();
  });
  const server = {
    config: {
      command: "serve",
      isProduction: false,
      base: options.base ?? "/",
    },
    httpServer: http,
    middlewares: { stack },
  } as unknown as ViteDevServer;
  const control = attachControlForTests(
    server,
    async (context) => {
      launches++;
      receivedURL = context.url;
      return factory ? factory(context) : fake.page;
    },
    { timeoutMs: options.timeoutMs ?? 1_000 },
  );
  t.after(async () => {
    await control.close().catch(() => undefined);
    http.closeAllConnections();
    await new Promise<void>((resolve) => http.close(() => resolve()));
  });
  await new Promise<void>((resolve) =>
    http.listen(0, options.bind ?? "127.0.0.1", resolve),
  );
  const address = http.address();
  assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}`;
  const client = createControlClient({ url, timeoutMs: 5_000 });
  return {
    server,
    http,
    control,
    url,
    client,
    fake,
    get launches() {
      return launches;
    },
    get receivedURL() {
      return receivedURL;
    },
  };
}
async function raw(
  url: string,
  route: string,
  body?: string,
  headers: Record<string, string> = {},
  method = body === undefined ? "GET" : "POST",
) {
  return new Promise<{
    status: number;
    headers: IncomingMessage["headers"];
    body: Envelope;
  }>((resolve, reject) => {
    const req = httpRequest(
      new URL(route, url),
      {
        method,
        // Each raw protocol probe owns its socket; oversized-body responses intentionally close it.
        agent: false,
        headers: {
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          ...headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          try {
            resolve({
              status: res.statusCode!,
              headers: res.headers,
              body: JSON.parse(Buffer.concat(chunks).toString()) as Envelope,
            });
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}
async function waitFor(check: () => Promise<boolean>, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  do {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  } while (Date.now() < deadline);
  assert.fail(
    "Condition did not become true within the bounded test deadline.",
  );
}
function data<T>(value: Envelope): T {
  return value.data as T;
}

// These are HTTP/queue/lifecycle tests with an injected transport. They prove no rendering or gameplay behavior.
test("attaching is lazy, resolves the bound port/base and reuses the same owned transport", async (t) => {
  const f = await fixture(t, undefined, { base: "/game/" });
  assert.equal(f.launches, 0);
  assert.equal((await f.client.status()).status, "succeeded");
  assert.equal(f.launches, 0);
  const commands: ControlCommand[] = [
    { type: "inspect" },
    { type: "pause" },
    { type: "step", count: 2 },
    { type: "resume" },
    { type: "snapshot" },
    { type: "restore", snapshot: { fixture: true } },
    { type: "input", key: "ArrowRight", pressed: true },
    {
      type: "setComponent",
      entity: "box",
      component: "Health",
      value: { hp: 7 },
    },
    { type: "mode", mode: "path" },
    { type: "recordStart" },
    { type: "recordStop" },
    { type: "recordCancel" },
    { type: "replay", trace: { fixture: true } },
  ];
  for (const command of commands)
    assert.equal((await f.client.send(command)).status, "succeeded");
  assert.deepEqual(f.fake.calls, commands);
  assert.equal(f.launches, 1);
  assert.equal(f.receivedURL, `${f.url}/game/`);
  const status = data<ControlStatus>(await f.client.status());
  assert.equal(status.tasks.length, commands.length);
  assert.ok(
    status.tasks.every(
      (task) =>
        task.status === "succeeded" && task.finishedAt! >= task.createdAt,
    ),
  );
  assert.equal(status.hasPage, true);
  await f.control.close();
  await f.control.close();
  assert.equal(f.fake.closes, 1);
});

test("real Vite GET status is not swallowed by the SPA fallback; no browser needed", async (t) => {
  const server = await createViteServer({
    configFile: false,
    appType: "spa",
    logLevel: "silent",
    server: { host: "127.0.0.1", port: 0, watch: null, hmr: false },
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  let launches = 0;
  const control = attachControlForTests(server, async () => {
    launches++;
    return adapter().page;
  });
  t.after(async () => {
    await control.close();
    await server.close();
  });
  await server.listen();
  const address = server.httpServer!.address();
  assert.ok(address && typeof address !== "string");
  const response = await raw(
    `http://127.0.0.1:${address.port}`,
    "/__pelican/status",
  );
  assert.equal(response.status, 200);
  assert.equal(response.body.status, "succeeded");
  assert.equal(response.headers["access-control-allow-origin"], undefined);
  assert.equal(launches, 0);
});

test("rejects production, missing HTTP servers, duplicate attach and unbounded timeout options", async (t) => {
  const f = await fixture(t);
  assert.throws(() => attachControl(f.server), /TC_CONTROL_ALREADY_ATTACHED/);
  assert.throws(
    () =>
      attachControl({
        ...f.server,
        config: { ...f.server.config, isProduction: true },
      }),
    /TC_CONTROL_DEV_ONLY/,
  );
  assert.throws(
    () =>
      attachControl({
        ...f.server,
        config: { ...f.server.config, command: "build" },
      }),
    /TC_CONTROL_DEV_ONLY/,
  );
  assert.throws(
    () => attachControl({ ...f.server, httpServer: null }),
    /TC_CONTROL_HTTP_REQUIRED/,
  );
  for (const timeoutMs of [0, 9, -1, Infinity, NaN, 120001, 100.5])
    assert.throws(
      () => attachControl(f.server, { timeoutMs }),
      /TC_CONTROL_TIMEOUT_RANGE/,
    );
});

test("malformed commands are rejected before creating a browser, without reflecting request secrets", async (t) => {
  const f = await fixture(t);
  for (const payload of [
    "{",
    "null",
    "[]",
    '{"type":"inspect","evaluate":"secret-password"}',
    '{"type":"step","count":10001}',
    '{"type":"untrusted-secret"}',
  ]) {
    const response = await raw(f.url, "/__pelican/control", payload);
    assert.equal(response.status, 400);
    assert.equal(response.body.status, "failed");
    assert.doesNotMatch(
      JSON.stringify(response.body),
      /secret-password|untrusted-secret/,
    );
  }
  assert.equal(f.launches, 0);
  assert.equal(data<ControlStatus>(await f.client.status()).tasks.length, 0);
});

test("loopback Host and exact same HTTP origin are required, with no CORS opt-in", async (t) => {
  const f = await fixture(t);
  const command = '{"type":"inspect"}';
  for (const headers of [
    { Origin: "https://external.example" },
    { Origin: "null" },
    { Host: "external.example" },
    { Origin: "http://localhost:99" },
    { "Sec-Fetch-Site": "cross-site" },
    { "Sec-Fetch-Site": "same-site" },
    { "Access-Control-Request-Method": "POST" },
    { Host: "127.0.0.1:1" },
  ] as Record<string, string>[]) {
    const response = await raw(f.url, "/__pelican/control", command, headers);
    assert.equal(response.status, 403);
    assert.equal(response.headers["access-control-allow-origin"], undefined);
  }
  assert.equal(f.launches, 0);
  assert.equal(
    (
      await raw(f.url, "/__pelican/control", command, {
        Origin: f.url,
        "Sec-Fetch-Site": "same-origin",
      })
    ).status,
    200,
  );
  // A wildcard-listening Vite server is still usable only over its loopback connection.
  const all = await fixture(t, undefined, { bind: "0.0.0.0" });
  assert.equal(
    (await all.client.send({ type: "inspect" })).status,
    "succeeded",
  );
});

test("methods, JSON content type, encoding, task IDs and bounded bodies are checked", async (t) => {
  const f = await fixture(t);
  assert.equal((await raw(f.url, "/__pelican/control")).status, 405);
  assert.equal((await raw(f.url, "/__pelican/status", "{}")).status, 405);
  assert.equal(
    (
      await raw(f.url, "/__pelican/control", "{}", {
        "Content-Type": "text/plain",
      })
    ).status,
    415,
  );
  assert.equal(
    (
      await raw(f.url, "/__pelican/control", "{}", {
        "Content-Encoding": "gzip",
      })
    ).status,
    415,
  );
  assert.equal(
    (
      await raw(f.url, "/__pelican/control", '{"type":"inspect"}', {
        "X-Pelican-Task-Id": "invalid id",
      })
    ).status,
    400,
  );
  const large = JSON.stringify({
    type: "restore",
    snapshot: { padding: "x".repeat(1024 * 1024) },
  });
  assert.equal((await raw(f.url, "/__pelican/control", large)).status, 413);
  assert.equal(
    (
      await raw(f.url, "/__pelican/control", large, {
        "Content-Length": String(Buffer.byteLength(large)),
      })
    ).status,
    413,
  );
  assert.equal(f.launches, 0);
});

test("oversized JSON uploads finish draining before a reliable 413 response closes their socket", async (t) => {
  const f = await fixture(t),
    seen = deferred<void>(),
    ended = deferred<boolean>();
  f.http.once("request", (incoming, response) => {
    response.once("finish", () =>
      ended.resolve(incoming.complete && incoming.readableEnded),
    );
    seen.resolve();
  });
  const body = JSON.stringify({
    type: "restore",
    snapshot: { padding: "x".repeat(1024 * 1024) },
  });
  let req!: ReturnType<typeof httpRequest>;
  const response = new Promise<{ status: number; body: Envelope }>(
    (resolve, reject) => {
      req = httpRequest(
        f.url + "/__pelican/control",
        {
          method: "POST",
          agent: false,
          headers: {
            "Content-Type": "application/json",
            "Content-Length": String(Buffer.byteLength(body)),
          },
        },
        (res) => {
          const parts: Buffer[] = [];
          res.on("data", (part) => parts.push(part));
          res.on("error", reject);
          res.on("end", () => {
            try {
              resolve({
                status: res.statusCode!,
                body: JSON.parse(Buffer.concat(parts).toString()),
              });
            } catch (error) {
              reject(error);
            }
          });
        },
      );
      req.on("error", reject);
    },
  );
  void response.catch(() => {});
  try {
    req.write(body.slice(0, 128));
    await seen.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    req.end(body.slice(128));
    const result = await response;
    assert.equal(result.status, 413);
    assert.equal(result.body.diagnostics[0].code, "TC_CONTROL_BODY_TOO_LARGE");
    assert.equal(await ended.promise, true);
    assert.equal(f.launches, 0);
  } finally {
    req.destroy();
  }
});

test("an unfinished request body times out without allocating a browser", async (t) => {
  const f = await fixture(t, undefined, { timeoutMs: 50 });
  const response = await new Promise<{ status: number; body: Envelope }>(
    (resolve, reject) => {
      const req = httpRequest(
        `${f.url}/__pelican/control`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": "100",
          },
        },
        (res) => {
          const parts: Buffer[] = [];
          res.on("data", (part) => parts.push(part));
          res.on("end", () => {
            resolve({
              status: res.statusCode!,
              body: JSON.parse(Buffer.concat(parts).toString()),
            });
            req.destroy();
          });
        },
      );
      req.on("error", reject);
      req.write("{");
    },
  );
  assert.equal(response.status, 408);
  assert.equal(response.body.diagnostics[0].code, "TC_CONTROL_BODY_TIMEOUT");
  assert.equal(f.launches, 0);
});

test("an oversized unfinished upload remains bounded and returns 413 without retaining or launching", async (t) => {
  const f = await fixture(t, undefined, { timeoutMs: 50 });
  const result = await new Promise<{ status: number; body: Envelope }>(
    (resolve, reject) => {
      const req = httpRequest(
        f.url + "/__pelican/control",
        {
          method: "POST",
          agent: false,
          headers: {
            "Content-Type": "application/json",
            "Content-Length": String(1024 * 1024 + 100),
          },
        },
        (res) => {
          const parts: Buffer[] = [];
          res.on("data", (part) => parts.push(part));
          res.on("error", reject);
          res.on("end", () => {
            try {
              resolve({
                status: res.statusCode!,
                body: JSON.parse(Buffer.concat(parts).toString()),
              });
            } catch (error) {
              reject(error);
            } finally {
              req.destroy();
            }
          });
        },
      );
      req.on("error", reject);
      req.write("{");
    },
  );
  assert.equal(result.status, 413);
  assert.equal(result.body.diagnostics[0].code, "TC_CONTROL_BODY_TOO_LARGE");
  assert.equal(f.launches, 0);
});

test("concurrent commands are FIFO and status exposes bounded metadata and caller-provided IDs", async (t) => {
  const gate = deferred<Envelope>();
  const fake = adapter(async (command) =>
    command.type === "step"
      ? gate.promise
      : result("r", "succeeded", { echoed: command.type }),
  );
  const f = await fixture(t, async () => fake.page);
  const first = f.client.send({ type: "step", count: 1 }, { taskId: "first" });
  await waitFor(async () =>
    data<ControlStatus>(await f.client.status()).tasks.some(
      (task) => task.taskId === "first" && task.status === "running",
    ),
  );
  const second = f.client.send({ type: "inspect" }, { taskId: "second" });
  await waitFor(async () =>
    data<ControlStatus>(await f.client.status()).tasks.some(
      (task) => task.taskId === "second" && task.status === "queued",
    ),
  );
  assert.equal(fake.calls.length, 1);
  const duplicate = await f.client.send(
    { type: "inspect" },
    { taskId: "first" },
  );
  assert.equal(duplicate.diagnostics[0].code, "TC_CONTROL_TASK_DUPLICATE");
  const status = data<ControlStatus>(await f.client.status());
  assert.ok(
    status.tasks.every((task) => !("data" in task) && !("command" in task)),
  );
  gate.resolve(result("r", "succeeded", { first: true }));
  assert.equal((await first).taskId, "first");
  assert.equal((await second).taskId, "second");
  assert.deepEqual(
    fake.calls.map((command) => command.type),
    ["step", "inspect"],
  );
});

test("cancelling queued work never dispatches it and preserves the running session", async (t) => {
  const gate = deferred<Envelope>();
  const fake = adapter(async () => gate.promise);
  const f = await fixture(t, async () => fake.page);
  const running = f.client.send(
    { type: "step", count: 1 },
    { taskId: "running" },
  );
  await waitFor(async () => fake.calls.length === 1);
  const queued = f.client.send({ type: "inspect" }, { taskId: "queued" });
  await waitFor(async () =>
    data<ControlStatus>(await f.client.status()).tasks.some(
      (task) => task.taskId === "queued",
    ),
  );
  const cancel = await f.client.cancel("queued");
  assert.equal(cancel.status, "succeeded");
  assert.equal(data<{ stateReset: boolean }>(cancel).stateReset, false);
  assert.equal((await queued).status, "cancelled");
  assert.equal(fake.closes, 0);
  gate.resolve(result("r", "succeeded", null));
  assert.equal((await running).status, "succeeded");
  assert.equal(fake.calls.length, 1);
  assert.equal(
    data<ControlStatus>(await f.client.status()).sessionNeedsReset,
    false,
  );
});

test("running cancellation closes the owned page, invalidates queued tasks and requires explicit reset", async (t) => {
  const hanging = deferred<Envelope>();
  const old = adapter(async () => hanging.promise);
  const fresh = adapter();
  let n = 0;
  const f = await fixture(t, async () => (++n === 1 ? old.page : fresh.page));
  const running = f.client.send(
    { type: "step", count: 1 },
    { taskId: "active" },
  );
  await waitFor(async () => old.calls.length === 1);
  const queued = f.client.send({ type: "inspect" }, { taskId: "obsolete" });
  await waitFor(async () =>
    data<ControlStatus>(await f.client.status()).tasks.some(
      (task) => task.taskId === "obsolete",
    ),
  );
  const cancel = await f.client.cancel("active");
  assert.equal(data<{ stateReset: boolean }>(cancel).stateReset, true);
  assert.equal((await running).status, "cancelled");
  assert.equal((await queued).status, "cancelled");
  assert.equal(old.closes, 1);
  assert.equal(
    (await f.client.send({ type: "inspect" })).diagnostics[0].code,
    "TC_CONTROL_SESSION_RESET_REQUIRED",
  );
  assert.equal((await f.client.reset()).status, "succeeded");
  assert.equal((await f.client.send({ type: "inspect" })).status, "succeeded");
  hanging.reject(new Error("late sensitive browser exception"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fresh.calls.length, 1);
  assert.equal(
    data<ControlStatus>(await f.client.status()).sessionNeedsReset,
    false,
  );
  assert.equal((await f.client.cancel("active")).status, "succeeded");
});

test("a command timeout fails stop, does not hang on evaluation and never claims state preserved", async (t) => {
  const fake = adapter(async () => new Promise<Envelope>(() => undefined));
  const f = await fixture(t, async () => fake.page, { timeoutMs: 80 });
  const response = await f.client.send({ type: "step", count: 1 });
  assert.equal(response.status, "timed_out");
  assert.equal(response.diagnostics[0].code, "TC_CONTROL_TASK_TIMEOUT");
  assert.equal(data<{ stateReset: boolean }>(response).stateReset, true);
  await waitFor(async () => fake.closes === 1);
  assert.equal(
    (await f.client.send({ type: "inspect" })).diagnostics[0].code,
    "TC_CONTROL_SESSION_RESET_REQUIRED",
  );
});

test("a late factory cannot dispatch stale commands or contaminate a fresh generation", async (t) => {
  const factory = deferred<ControlPage>();
  const old = adapter();
  const fresh = adapter();
  let launches = 0;
  const f = await fixture(
    t,
    async () => (++launches === 1 ? factory.promise : fresh.page),
    { timeoutMs: 70 },
  );
  const timedOut = await f.client.send({ type: "inspect" });
  assert.equal(timedOut.status, "timed_out");
  assert.equal((await f.client.reset()).status, "failed"); // Still-owned launch has not completed cleanup.
  factory.resolve(old.page);
  await waitFor(async () => old.closes === 1);
  assert.equal(old.calls.length, 0);
  assert.equal((await f.client.reset()).status, "succeeded");
  assert.equal((await f.client.send({ type: "inspect" })).status, "succeeded");
  assert.equal(fresh.calls.length, 1);
});

test("closed transports and browser failures are sanitized and discard their generation", async (t) => {
  for (const kind of ["closed", "throw", "factory"] as const) {
    const fake = adapter(async () => {
      throw new Error("secret token at C:/private/credentials.json");
    });
    if (kind === "closed") fake.invalidate();
    const f = await fixture(t, async () => {
      if (kind === "factory") throw new Error("secret launch args");
      return fake.page;
    });
    const response = await f.client.send({ type: "inspect" });
    assert.equal(response.status, "failed");
    assert.equal(data<{ stateReset: boolean }>(response).stateReset, true);
    assert.doesNotMatch(JSON.stringify(response), /secret|credentials|C:\//);
    assert.equal(
      data<ControlStatus>(await f.client.status()).sessionNeedsReset,
      true,
    );
  }
});

test("runtime failure envelopes preserve the session but raw runtime messages are not reflected", async (t) => {
  const fake = adapter(async () =>
    result("runtime", "failed", null, [
      {
        code: "TC_ENTITY_MISSING",
        severity: "error",
        message: "secret at C:/private",
        remediation: "secret",
      },
    ]),
  );
  const f = await fixture(t, async () => fake.page);
  const response = await f.client.send({ type: "inspect" });
  assert.equal(response.status, "failed");
  assert.equal(response.diagnostics[0].code, "TC_ENTITY_MISSING");
  assert.doesNotMatch(JSON.stringify(response), /secret|C:\//);
  assert.equal(
    data<ControlStatus>(await f.client.status()).sessionNeedsReset,
    false,
  );
  assert.equal(fake.closes, 0);
});

test("malformed runtime envelopes are transport failures rather than successful commands", async (t) => {
  const fake = adapter(
    async () =>
      ({ status: "succeeded", data: "not-a-shared-envelope" }) as Envelope,
  );
  const f = await fixture(t, async () => fake.page);
  const response = await f.client.send({ type: "inspect" });
  assert.equal(response.diagnostics[0].code, "TC_CONTROL_RESPONSE_INVALID");
  assert.equal(data<{ stateReset: boolean }>(response).stateReset, true);
});

test("client timeouts and aborts report uncertain state; HTTP disconnect cancels owned work", async (t) => {
  const fake = adapter(async () => new Promise<Envelope>(() => undefined));
  const f = await fixture(t, async () => fake.page);
  const impatient = createControlClient({ url: f.url, timeoutMs: 50 });
  const timedOut = await impatient.send(
    { type: "step", count: 1 },
    { taskId: "client-timeout" },
  );
  assert.equal(timedOut.status, "timed_out");
  assert.equal(data<{ stateUnknown: boolean }>(timedOut).stateUnknown, true);
  await waitFor(async () => fake.closes === 1);
  assert.equal(
    data<ControlStatus>(await f.client.status()).sessionNeedsReset,
    true,
  );
  const abort = new AbortController();
  abort.abort();
  const cancelled = await f.client.send(
    { type: "inspect" },
    { taskId: "pre-aborted", signal: abort.signal },
  );
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.diagnostics[0].code, "TC_CONTROL_CLIENT_CANCELLED");
});

test("closing bridge interrupts running work, cancels queue and is idempotent", async (t) => {
  const fake = adapter(async () => new Promise<Envelope>(() => undefined));
  const f = await fixture(t, async () => fake.page);
  const first = f.client.send({ type: "inspect" }, { taskId: "close-active" });
  await waitFor(async () => fake.calls.length === 1);
  const second = f.client.send({ type: "inspect" }, { taskId: "close-queued" });
  await waitFor(async () =>
    data<ControlStatus>(await f.client.status()).tasks.some(
      (task) => task.taskId === "close-queued",
    ),
  );
  const close1 = f.control.close();
  assert.equal(f.control.close(), close1);
  await close1;
  assert.equal((await first).status, "cancelled");
  assert.equal((await second).status, "cancelled");
  assert.equal(fake.closes, 1);
  assert.equal(f.server.middlewares.stack.length, 0);
});

test("HTTP server close cleans up an idle owned browser even without explicit control.close", async (t) => {
  const f = await fixture(t);
  await f.client.send({ type: "inspect" });
  f.http.closeAllConnections();
  await new Promise<void>((resolve) => f.http.close(() => resolve()));
  await waitFor(async () => f.fake.closes === 1);
});

test("queue saturation returns a bounded busy response, never launching extra browsers", async (t) => {
  const fake = adapter(async () => new Promise<Envelope>(() => undefined));
  const f = await fixture(t, async () => fake.page, { timeoutMs: 5_000 });
  const first = f.client.send({ type: "inspect" }, { taskId: "busy-active" });
  await waitFor(async () => fake.calls.length === 1);
  const queued = Array.from({ length: 64 }, (_, i) =>
    f.client.send({ type: "inspect" }, { taskId: `busy-${i}` }),
  );
  await waitFor(
    async () =>
      data<ControlStatus>(await f.client.status()).tasks.filter(
        (task) => task.status === "queued",
      ).length === 64,
  );
  const overflow = await f.client.send({ type: "inspect" });
  assert.equal(overflow.diagnostics[0].code, "TC_CONTROL_QUEUE_FULL");
  await f.control.close();
  for (const response of await Promise.all([first, ...queued]))
    assert.equal(response.status, "cancelled");
  assert.equal(f.launches, 1);
  assert.equal(fake.calls.length, 1);
});

test("completed history is bounded without retaining snapshots or command payloads", async (t) => {
  const f = await fixture(t);
  for (let i = 0; i < 265; i++)
    assert.equal(
      (await f.client.send({ type: "inspect" })).status,
      "succeeded",
    );
  const status = data<ControlStatus>(await f.client.status());
  assert.equal(status.tasks.length, 256);
  assert.ok(status.tasks.every((task) => task.status === "succeeded"));
});

test("cancel/reset malformed and unknown task requests are bounded without browser startup", async (t) => {
  const f = await fixture(t);
  for (const [route, body, expected] of [
    ["/__pelican/cancel", '{"taskId":"missing"}', 404],
    ["/__pelican/cancel", '{"taskId":4}', 400],
    ["/__pelican/session", '{"action":"anything"}', 400],
  ] as const)
    assert.equal((await raw(f.url, route, body)).status, expected);
  assert.equal((await f.client.reset()).status, "succeeded");
  assert.equal(f.launches, 0);
});

test("client validates local URL, timeouts, serializability and commands before network use", async (t) => {
  for (const url of [
    "https://127.0.0.1:1",
    "http://example.com",
    "file:///tmp",
    "http://secret:password@localhost:1",
    "http://localhost:1?secret=1",
    "invalid",
  ])
    assert.throws(() => createControlClient({ url }), /TC_CONTROL_URL_INVALID/);
  for (const timeoutMs of [0, 1, Infinity, 120001])
    assert.throws(
      () => createControlClient({ url: "http://localhost", timeoutMs }),
      /TC_CONTROL_TIMEOUT_RANGE/,
    );
  const f = await fixture(t);
  assert.equal(
    (await f.client.send({ type: "not-allowed" } as unknown as ControlCommand))
      .diagnostics[0].code,
    "TC_CONTROL_COMMAND_INVALID",
  );
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  assert.equal(
    (await f.client.send({ type: "restore", snapshot: circular }))
      .diagnostics[0].code,
    "TC_CONTROL_JSON_INVALID",
  );
  assert.equal(
    (
      await f.client.send({
        type: "restore",
        snapshot: { padding: "x".repeat(1024 * 1024) },
      })
    ).diagnostics[0].code,
    "TC_CONTROL_BODY_TOO_LARGE",
  );
  assert.equal(f.launches, 0);
});

test("client rejects non-envelope HTTP responses and never follows external redirects", async (t) => {
  const http = createHTTPServer((req, res) => {
    if (req.url === "/__pelican/control") {
      res.writeHead(302, { Location: "http://external.invalid/secret" });
      res.end();
    } else {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("secret raw server exception");
    }
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    http.closeAllConnections();
    await new Promise<void>((resolve) => http.close(() => resolve()));
  });
  const address = http.address();
  assert.ok(address && typeof address !== "string");
  const client = createControlClient({
    url: `http://127.0.0.1:${address.port}`,
  });
  const inspect = await client.send({ type: "inspect" });
  assert.equal(inspect.diagnostics[0].code, "TC_CONTROL_TRANSPORT_FAILURE");
  assert.doesNotMatch(JSON.stringify(inspect), /external|secret/);
  assert.equal(
    (await client.status()).diagnostics[0].code,
    "TC_CONTROL_RESPONSE_INVALID",
  );
});

test("explicit reset while running cancels old work and starts only a clean lazy session", async (t) => {
  const old = adapter(async () => new Promise<Envelope>(() => undefined));
  const fresh = adapter();
  let launches = 0;
  const f = await fixture(t, async () =>
    ++launches === 1 ? old.page : fresh.page,
  );
  const running = f.client.send(
    { type: "step", count: 1 },
    { taskId: "reset-active" },
  );
  await waitFor(async () => old.calls.length === 1);
  const generation = data<ControlStatus>(await f.client.status()).generation;
  const reset = await f.client.reset();
  assert.equal(reset.status, "succeeded");
  assert.equal(data<{ stateReset: boolean }>(reset).stateReset, true);
  assert.equal((await running).status, "cancelled");
  assert.equal(old.closes, 1);
  assert.equal(launches, 1); // Reset never launches a replacement until a command needs it.
  assert.ok(
    data<ControlStatus>(await f.client.status()).generation > generation,
  );
  assert.equal((await f.client.send({ type: "inspect" })).status, "succeeded");
  assert.equal(fresh.calls.length, 1);
});

test("cleanup failure blocks replacement and close reports a stable sanitized error", async (t) => {
  const fake = adapter();
  fake.page.close = async () => {
    throw new Error("secret driver process path");
  };
  const f = await fixture(t, async () => fake.page, { timeoutMs: 50 });
  assert.equal((await f.client.send({ type: "inspect" })).status, "succeeded");
  const reset = await f.client.reset();
  assert.equal(reset.status, "failed");
  assert.equal(reset.diagnostics[0].code, "TC_CONTROL_CLEANUP_PENDING");
  assert.doesNotMatch(JSON.stringify(reset), /secret|driver process/);
  assert.equal(
    (await f.client.send({ type: "inspect" })).diagnostics[0].code,
    "TC_CONTROL_SESSION_RESET_REQUIRED",
  );
  await assert.rejects(f.control.close(), /TC_CONTROL_CLEANUP_PENDING/);
  assert.equal(f.launches, 1);
});

test("oversized runtime responses discard the session instead of growing the HTTP result", async (t) => {
  const fake = adapter(async () =>
    result("runtime", "succeeded", "x".repeat(8 * 1024 * 1024)),
  );
  const f = await fixture(t, async () => fake.page);
  const response = await f.client.send({ type: "inspect" });
  assert.equal(response.diagnostics[0].code, "TC_CONTROL_RESPONSE_TOO_LARGE");
  assert.equal(data<{ stateReset: boolean }>(response).stateReset, true);
  assert.ok(JSON.stringify(response).length < 2_000);
});

test("late successful commands cannot overwrite cancellation or a fresh session", async (t) => {
  const late = deferred<Envelope>();
  const old = adapter(async () => late.promise);
  const fresh = adapter();
  let launches = 0;
  const f = await fixture(t, async () =>
    ++launches === 1 ? old.page : fresh.page,
  );
  const running = f.client.send(
    { type: "step", count: 1 },
    { taskId: "late-success" },
  );
  await waitFor(async () => old.calls.length === 1);
  await f.client.cancel("late-success");
  assert.equal((await running).status, "cancelled");
  assert.equal((await f.client.reset()).status, "succeeded");
  assert.equal((await f.client.send({ type: "inspect" })).status, "succeeded");
  late.resolve(result("old-runtime", "succeeded", { obsolete: true }));
  await new Promise((resolve) => setImmediate(resolve));
  const status = data<ControlStatus>(await f.client.status());
  assert.equal(
    status.tasks.find((task) => task.taskId === "late-success")?.status,
    "cancelled",
  );
  assert.equal(status.sessionNeedsReset, false);
  assert.equal(fresh.closes, 0);
});

test("undefined runtime return values are normalized to JSON null without losing the envelope", async (t) => {
  const fake = adapter(async () => result("runtime", "succeeded", undefined));
  const f = await fixture(t, async () => fake.page);
  const response = await f.client.send({ type: "inspect" });
  assert.equal(response.status, "succeeded");
  assert.equal(response.data, null);
});

test("disconnecting during an unfinished body does not leak an unhandled request error", async (t) => {
  const f = await fixture(t);
  const arrived = new Promise<void>((resolve) =>
    f.http.once("request", () => resolve()),
  );
  const req = httpRequest(`${f.url}/__pelican/control`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Content-Length": "100" },
  });
  req.on("error", () => undefined);
  req.write("{");
  await arrived;
  req.destroy();
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal((await f.client.status()).status, "succeeded");
  assert.equal(f.launches, 0);
});

test("explicit incompatible HTTP version rejects before launch while omitted version stays compatible", async t=>{
 const f=await fixture(t);
 const bad=await fetch(f.url+"/__pelican/control",{method:"POST",headers:{"Content-Type":"application/json","x-pelican-protocol-version":"999.0.0"},body:JSON.stringify({type:"inspect"})});
 assert.equal(bad.status,409);assert.equal((await bad.json()).diagnostics[0].code,"TC_PROTOCOL_VERSION_UNSUPPORTED");assert.equal(f.launches,0);
 const old=await fetch(f.url+"/__pelican/control",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({type:"inspect"})});
 assert.equal((await old.json()).status,"succeeded");assert.equal(f.launches,1);
});
