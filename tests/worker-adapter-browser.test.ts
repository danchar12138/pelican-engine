import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, cp, writeFile, readFile, rm, mkdir } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { once } from "node:events";
import { createServer } from "vite";
import { chromium } from "playwright";
import { WebSocketServer } from "ws";
import { compileProject } from "../packages/compiler/src/index.ts";
import { SDK_VERSION } from "../packages/sdk/src/index.ts";

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(path.join(tmpdir(), "pelican-worker-adapter-"));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(tmpdir()));
    await rm(root, { recursive: true, force: true });
  });
  await cp("examples/external-adapters", root, { recursive: true });
  await writeFile(
    path.join(root, "pelican.project.json"),
    JSON.stringify({ engineVersion: SDK_VERSION, content: "typescript" }),
  );
  return {
    root,
    compile: () =>
      compileProject({
        projectRoot: root,
        engineRoot: process.cwd(),
        outDir: "generated",
      }),
  };
}

test(
  "module workers are emitted, typechecked and included in cache fingerprints",
  { timeout: 60000 },
  async (t) => {
    const { root, compile } = await fixture(t);
    await cp(path.join(root, "palette-worker.ts"), path.join(root, "second-worker.ts"));
    const client = path.join(root, "palette-client.ts");
    await writeFile(client, (await readFile(client, "utf8")) + '\nexport function secondaryWorker() { return new Worker(new URL("./second-worker.ts", import.meta.url), {type:"module"}); }\n');
    const first = await compile();
    assert.equal(first.success, true, JSON.stringify(first.diagnostics));
    const worker = first.report.outputs.find((file) =>
      /^assets\/palette-worker-.*\.js$/.test(file),
    );
    assert.ok(worker, JSON.stringify(first.report.outputs));
    const workerMap = JSON.parse(
      await readFile(path.join(root, "generated", worker + ".map"), "utf8"),
    );
    assert.ok(
      workerMap.sources.includes("palette-worker.ts"),
      JSON.stringify(workerMap.sources),
    );
    assert.ok(
      first.report.inputs.some((input) => input.path === "palette-worker.ts"),
    );
    const code = await readFile(path.join(root, "generated/game.js"), "utf8");
    assert.ok(
      !code.includes('"/assets/palette-worker-'),
      "Worker URLs must stay relative to generated/game.js and work below a deployment base path.",
    );
    assert.ok((await compile()).report.incremental.cacheHit);
    await writeFile(
      path.join(root, "generated", worker),
      "corrupt worker output",
    );
    const repaired = await compile();
    assert.equal(repaired.success, true);
    assert.equal(repaired.report.incremental.cacheHit, false);
    assert.notEqual(
      await readFile(path.join(root, "generated", worker), "utf8"),
      "corrupt worker output",
    );
    const original = await readFile(
      path.join(root, "palette-worker.ts"),
      "utf8",
    );
    await writeFile(
      path.join(root, "palette-worker.ts"),
      original.replace("0.65", "0.75"),
    );
    const changed = await compile();
    assert.equal(changed.success, true, JSON.stringify(changed.diagnostics));
    assert.equal(changed.report.incremental.cacheHit, false);
    assert.ok(
      changed.report.incremental.changedInputs.some((file) =>
        file.includes("palette-worker.ts"),
      ),
    );
    assert.notEqual(
      changed.report.outputs.find((file) =>
        /^assets\/palette-worker-.*\.js$/.test(file),
      ),
      worker,
    );
    await writeFile(
      path.join(root, "palette-worker.ts"),
      'const invalid: number = "not-a-number"; export {};',
    );
    const invalid = await compile();
    assert.equal(invalid.success, false);
    assert.ok(
      invalid.diagnostics.some(
        (d) =>
          d.code.startsWith("TC_TS_") &&
          d.source?.file.endsWith("palette-worker.ts"),
      ),
      JSON.stringify(invalid.diagnostics),
    );
  },
);

test(
  "real module Worker and WebSocket adapters initialize, feed managed buffers, isolate instances and release",
  { timeout: 90000 },
  async (t) => {
    const { root, compile } = await fixture(t),
      compiled = await compile();
    assert.equal(compiled.success, true, JSON.stringify(compiled.diagnostics));
    const generated = path.join(root, "generated");
    const server = await createServer({
      configFile: false,
      root: process.cwd(),
      logLevel: "error",
      server: { port: 0, host: "127.0.0.1", fs: { strict: false } },
      plugins: [
        {
          name: "worker-adapter-fixture",
          configureServer(server) {
            server.middlewares.use((request, response, next) => {
              const pathname = new URL(request.url ?? "/", "http://localhost")
                .pathname;
              if (pathname === "/__adapter") {
                response.setHeader("Content-Type", "text/html");
                response.end("<!doctype html><title>Adapter lifecycle</title>");
                return;
              }
              if (!pathname.startsWith("/__generated/")) {
                next();
                return;
              }
              const file = path.resolve(
                generated,
                decodeURIComponent(pathname.slice("/__generated/".length)),
              );
              if (!file.startsWith(generated + path.sep)) {
                response.writeHead(403).end();
                return;
              }
              void readFile(file).then(
                (data) => {
                  response.setHeader(
                    "Content-Type",
                    file.endsWith(".js")
                      ? "application/javascript"
                      : "application/json",
                  );
                  response.end(data);
                },
                () => response.writeHead(404).end(),
              );
            });
          },
        },
      ],
    });
    const sockets = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    await once(sockets, "listening");
    let connected = 0,
      closed = 0,
      messages = 0;
    sockets.on("connection", (socket) => {
      connected++;
      socket.send(JSON.stringify({ value: 0.8 }));
      socket.on("message", (data) => {
        messages++;
        socket.send(data.toString());
      });
      socket.once("close", () => {
        closed++;
      });
    });
    await server.listen();
    const address = server.httpServer!.address(),
      socketAddress = sockets.address();
    assert.ok(
      address &&
        typeof address !== "string" &&
        socketAddress &&
        typeof socketAddress !== "string",
    );
    const browser = await chromium.launch({
      headless: true,
      args: ["--disable-gpu"],
    });
    try {
      const page = await browser.newPage(),
        errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(
        `http://127.0.0.1:${address.port}/__adapter?socket=ws://127.0.0.1:${socketAddress.port}`,
      );
      await page.addScriptTag({
        content: "globalThis.__name = value => value;",
      });
      const result = await page.evaluate(async (text) => {
        const hostURL = "/packages/runtime/src/host.ts",
          computeURL = "/packages/runtime/src/compute-service.ts",
          servicesURL = "/packages/runtime/src/game-services.ts";
        const { RuntimeHost } = await import(hostURL),
          { createComputeDriver } = await import(computeURL),
          { createGameServices } = await import(servicesURL);
        const ir = JSON.parse(text),
          gameURL = "/__generated/game.js";
        const module = await import(/* @vite-ignore */ gameURL);
        const NativeWorker = Worker;
        let created = 0,
          terminated = 0;
        globalThis.Worker = class extends NativeWorker {
          constructor(...args: ConstructorParameters<typeof Worker>) {
            super(...args);
            created++;
          }
          terminate() {
            terminated++;
            super.terminate();
          }
        } as typeof Worker;
        const make = () => {
          const compute = createComputeDriver({
            kernels: [],
            buffers: ir.computeBuffers,
            capabilities: () => ({
              backend: "webgpu",
              compute: true,
              availableModes: ["raster"],
            }),
          });
          const services = createGameServices(ir, {
            play() {},
            state: () => ({ clip: null, time: 0, playing: false }),
          });
          const host = new RuntimeHost(ir, {
            plugins: [compute.factory, services.factory],
          });
          host.attach(module.createGame(host.facade));
          return { host, compute };
        };
        const a = make(),
          b = make();
        const state = (owner: typeof a) =>
          (owner.host.snapshot().runtime!.payload as any)["external-palette"];
        const wait = async (owner: typeof a, expected: number) => {
          for (let i = 0; i < 100; i++) {
            await owner.host.stepAsync(1);
            if (state(owner).received >= expected) return;
            await new Promise((resolve) => setTimeout(resolve, 20));
          }
          throw new Error("Worker did not produce a palette");
        };
        try {
          await a.host.stepAsync(1);
          await b.host.stepAsync(1);
          await wait(a, 1);
          await wait(b, 1);
          a.host.emitExternal("ui.activate", { id: "refresh" });
          await wait(a, 2);
          const isolated = state(b).received === 1;
          const saved = a.host.snapshot();
          a.host.emitExternal("ui.activate", { id: "refresh" });
          await wait(a, 3);
          a.host.restore(saved);
          const restored = state(a).received === 2;
          const values = a.compute.service.readBuffer(
            a.compute.service.resolve("adapterPalette"),
          );
          return {
            isolated,
            restored,
            values,
            workerResourcesCreated: created,
            received: [state(a).received, state(b).received],
          };
        } finally {
          a.host.dispose();
          b.host.dispose();
          globalThis.Worker = NativeWorker;
          (globalThis as any).__workerReleaseCounts = { created, terminated };
        }
      }, JSON.stringify(compiled.ir));
      assert.equal(result.isolated, true);
      assert.equal(result.restored, true);
      assert.equal(result.workerResourcesCreated, 2);
      assert.equal(result.values.length, 1);
      assert.deepEqual(
        await page.evaluate(() => (globalThis as any).__workerReleaseCounts),
        { created: 2, terminated: 2 },
      );
      assert.deepEqual(errors, []);
      for (let i = 0; i < 50 && closed !== connected; i++)
        await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(connected, 2);
      assert.equal(closed, 2);
      assert.ok(messages >= 1);
    } finally {
      await browser.close();
      await server.close();
      for (const socket of sockets.clients) socket.terminate();
      await new Promise<void>((resolve) => sockets.close(() => resolve()));
    }
  },
);
