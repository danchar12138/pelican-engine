import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { build } from "vite";
import { chromium } from "playwright";
import type { EntityIR, SceneIR } from "../packages/compiler/src/types.ts";
import { normalize } from "../packages/compiler/src/normalize.ts";
import type { ObjectValue } from "../packages/compiler/src/extract.ts";
import { planGameplayServices, preparePhysicsServices } from "../packages/renderer/src/service-plan.ts";
import { RuntimeHost } from "../packages/runtime/src/host.ts";
import { createWorld } from "../packages/runtime/src/world.ts";
import { createTerrainPlugin } from "../packages/runtime/src/terrain.ts";
import { createRopePlugin } from "../packages/simulation/src/rope-plugin.ts";
import { createClothPlugin } from "../packages/simulation/src/cloth-plugin.ts";
import { createFluidPlugin } from "../packages/simulation/src/fluid-plugin.ts";
import { createSoftBodyPlugin } from "../packages/simulation/src/softbody-plugin.ts";
import { SDK_VERSION, defineGame, defineScene, defineSystem, instantiateGame, type SystemDefinition } from "../packages/sdk/src/index.ts";

const source = { file: "game.ts", line: 1, column: 1, length: 1 };
function ir(): SceneIR {
  return {
    format: "pelican.scene", version: 1, engineVersion: SDK_VERSION, gameId: "service-plan",
    scene: { id: "main", camera: { position: [0, 2, 5], target: [0, 0, 0], fov: 50, near: 0.1, far: 100 },
      environment: { background: "#000000", ambientIntensity: 1 }, gravity: [0, -9.81, 0], entities: [] },
    components: [], systems: [], prefabs: [], materials: [], computes: [], assets: [],
  };
}
function body(id = "ball"): EntityIR {
  return { id, transform: { position: [0, 2, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }, components: {},
    rigidBody: { type: "dynamic", collider: { shape: "sphere", radius: 0.5 }, mass: 1, friction: 0.5, restitution: 0, trigger: false } };
}
function attach(host: RuntimeHost, systems: readonly SystemDefinition[] = []) {
  host.attach(instantiateGame(defineGame({ id: "service-plan", scene: defineScene({ id: "main", entities: [] }), systems }), host.facade));
}
async function normalized(extra: Record<string, unknown> = {}) {
  const game = { kind: "game", id: "service-plan", scene: { kind: "scene", id: "main", entities: [] }, ...extra };
  const definitions: ObjectValue[] = [];
  const seen = new Set<object>();
  function collect(value: unknown) {
    if (!value || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    if ("kind" in value) definitions.push(value as ObjectValue);
    for (const child of Object.values(value)) collect(child);
  }
  collect(game);
  return normalize(game as unknown as ObjectValue, { definitions, source: () => source }, process.cwd());
}

test("service intent covers all prefabs/scenes and preserves conservative auto for arbitrary user code", () => {
  const scene = ir();
  assert.deepEqual(planGameplayServices(scene), { physics3d: "empty", physics2d: false });
  scene.prefabs.push(body()); assert.equal(planGameplayServices(scene).physics3d, "native");
  scene.prefabs = []; scene.scenes = [{ ...scene.scene, id: "later", entities: [body()] }];
  assert.equal(planGameplayServices(scene).physics3d, "native");
  scene.scenes = []; scene.systems = [{ id: "arbitrary", phase: "update", source }];
  assert.equal(planGameplayServices(scene).physics3d, "native");
  scene.systems = []; scene.runtime = { version: "1" };
  assert.equal(planGameplayServices(scene).physics3d, "native");
  scene.services = { physics3d: "disabled" };
  assert.equal(planGameplayServices(scene).physics3d, "empty");
  scene.scene.entities.push(body());
  assert.throws(() => planGameplayServices(scene), /TC_PHYSICS_SERVICE_CONFLICT.*main.*auto or required/);
  scene.scene.entities = []; scene.services = { physics3d: "required" };
  assert.equal(planGameplayServices(scene).physics3d, "native");
});

test("compiler normalizes service intent/runtime presence and diagnoses disabled physical scenes/prefabs", async () => {
  const disabled = await normalized({ services: { physics3d: "disabled" }, runtime: { version: "1", create: { __runtime: true } } });
  assert.deepEqual(disabled.diagnostics, []);
  assert.deepEqual(disabled.ir!.services, { physics3d: "disabled" });
  assert.deepEqual(disabled.ir!.runtime, { version: "1" });
  assert.equal(planGameplayServices(disabled.ir!).physics3d, "empty");
  for (const services of [{ physics3d: "lazy" }, { physics3d: true }, { unknown: "required" }]) {
    const result = await normalized({ services });
    assert.ok(result.diagnostics.some(diagnostic => diagnostic.code === "TC_GAME_SERVICES"));
  }
  const physical = { id: "ball", rigidBody: { type: "dynamic", collider: { shape: "sphere", radius: 0.5 } } };
  for (const extra of [
    { scene: { kind: "scene", id: "main", entities: [physical] } },
    { prefabs: [{ kind: "prefab", ...physical }] },
    { scenes: [{ kind: "scene", id: "other", entities: [physical] }] },
    { scene: { kind: "scene", id: "main", entities: [{ id: "player", character: { radius: 0.3, height: 1.8, speed: 5 } }] } },
  ]) {
    const result = await normalized({ services: { physics3d: "disabled" }, ...extra });
    const conflict = result.diagnostics.find(diagnostic => diagnostic.code === "TC_PHYSICS_SERVICE_CONFLICT");
    assert.ok(conflict, JSON.stringify(result.diagnostics));
    assert.equal(conflict.source?.file, "game.ts");
    assert.match(conflict.suggestion, /auto.*required/);
  }
});

test("disabled physics supports queries before spawn, input validation, gravity, snapshot/restore and stable bridge diagnostics", async () => {
  const scene = ir(); scene.services = { physics3d: "disabled" };
  scene.materials.push({ id: "ground", color: "#ffffff", roughness: 1, metalness: 0, source });
  const query = defineSystem({ id: "empty-query", run(ctx) {
    assert.equal(ctx.physics.raycast([0, 0, 0], [0, -1, 0], 10), null);
    assert.deepEqual(ctx.physics.overlapSphere([0, 0, 0], 1), []);
  } });
  scene.systems = [{ id: query.id, phase: "update", source }];
  const factories = await preparePhysicsServices(scene);
  const host = new RuntimeHost(scene, { plugins: [...factories, createTerrainPlugin, createRopePlugin, createClothPlugin, createFluidPlugin, createSoftBodyPlugin] });
  try {
    attach(host, [query]);
    const physics = host.facade.physics;
    assert.equal(physics.castShape({ shape: "box", halfExtents: [1, 1, 1] }, [0, 0, 0], [0, 1, 0]), null);
    assert.deepEqual(physics.overlapBox([0, 0, 0], [1, 1, 1]), []);
    assert.deepEqual(physics.overlapCapsule([0, 0, 0], 0, 1), []);
    assert.throws(() => physics.raycast([0, 0, 0], [0, 0, 0], 10), /TC_PHYSICS_RAY/);
    assert.throws(() => physics.raycast([NaN, 0, 0], [1, 0, 0], 10), /TC_PHYSICS_VECTOR/);
    assert.throws(() => physics.raycast(new Array(3) as unknown as readonly [number, number, number], [1, 0, 0], 10), /TC_PHYSICS_VECTOR/);
    assert.throws(() => physics.overlapSphere([0, 0, 0], 0), /TC_PHYSICS_OVERLAP/);
    assert.throws(() => physics.castShape({ shape: "sphere", radius: 1 }, [0, 0, 0], [0, 0, 0]), /TC_PHYSICS_SWEEP/);
    assert.throws(() => physics.velocity("missing"), /TC_PHYSICS_ENTITY.*missing.*main/);
    physics.setGravity([0, -2, 0]);
    host.step(2);
    const saved = host.snapshot();
    physics.setGravity([0, -3, 0]); host.step(2); host.restore(saved);
    assert.deepEqual(physics.gravity(), [0, -2, 0]);
    assert.deepEqual(host.snapshot(), saved);
    const before = host.snapshot(), bad = structuredClone(before);
    (bad.plugins!["$engine.physics"].payload as { gravity: number[] }).gravity = [NaN, 0, 0];
    assert.throws(() => host.restore(bad), /TC_PHYSICS_VECTOR|TC_PLUGIN|TC_SERIALIZATION/);
    assert.deepEqual(host.snapshot(), before);
    assert.throws(() => host.facade.terrain.create({ id: "floor", columns: 2, rows: 2, cellSize: 2, origin: [-1, 0, -1], heights: [0, 0, 0, 0], material: "ground" }),
      /TC_PHYSICS_SERVICE_DISABLED.*required/);
    assert.deepEqual(host.snapshot(), before);
    host.startRecording(); host.step(3); const trace = host.stopRecording(); host.step();
    assert.equal(host.replay(trace).status, "passed");
    const world = createWorld({ entities: [] });
    try {
      const plugin = factories[0]({ scene, world, events: () => [], emit: () => { throw new Error("unexpected emit"); } });
      assert.throws(() => plugin.terrainPhysicsBridge!.removeTerrain("terrain"), /TC_PHYSICS_SERVICE_DISABLED.*main.*services.physics3d.*required/);
      assert.throws(() => plugin.ropePhysicsBridge!.sampleClothBody("body"), /TC_PHYSICS_SERVICE_DISABLED.*required/);
      plugin.dispose(); assert.throws(() => plugin.services!.physics!.gravity(), /TC_PHYSICS_DISPOSED/);
    } finally { world.dispose(); }
  } finally { host.dispose(); }
});

test("native preparation covers dynamic physical prefab spawn and synchronous terrain creation", async () => {
  const scene = ir(); scene.prefabs.push(body());
  const host = new RuntimeHost(scene, { plugins: await preparePhysicsServices(scene) });
  try {
    attach(host);
    host.facade.entities.spawn({ prefab: "ball", id: "spawned" }); host.step();
    assert.ok(host.facade.physics.raycast([0, 5, 0], [0, -1, 0], 10));
    assert.ok(host.facade.physics.velocity("spawned")[1] < 0);
  } finally { host.dispose(); }
  const required = ir(); required.services = { physics3d: "required" };
  required.materials.push({ id: "ground", color: "#ffffff", roughness: 1, metalness: 0, source });
  const terrain = new RuntimeHost(required, { plugins: [...await preparePhysicsServices(required), createTerrainPlugin] });
  try {
    attach(terrain);
    terrain.facade.terrain.create({ id: "floor", columns: 2, rows: 2, cellSize: 2, origin: [-1, 0, -1], heights: [0, 0, 0, 0], material: "ground" });
    assert.equal(terrain.facade.physics.raycast([0, 1, 0], [0, -1, 0], 2)?.entity, "$terrain/floor");
  } finally { terrain.dispose(); }
});

test("2D opt-in keeps its asynchronous native owner alongside disabled empty 3D queries", async () => {
  const scene = ir(); scene.services = { physics3d: "disabled" }; scene.scene.physics2d = { gravity: [0, -4] };
  const host = new RuntimeHost(scene, { plugins: await preparePhysicsServices(scene) });
  try {
    attach(host); assert.deepEqual(host.facade.physics2d.gravity(), [0, -4]);
    assert.equal(host.facade.physics.raycast([0, 0, 0], [0, -1, 0], 1), null);
    host.step(); const saved = host.snapshot(); host.step(); host.restore(saved); assert.deepEqual(host.snapshot(), saved);
  } finally { host.dispose(); }
});

test("empty physics preserves native scheduler metadata and restores old empty Rapier v3/absent plugin snapshots", async () => {
  const { createPhysicsFactory } = await import("../packages/physics/index.ts");
  const scene = ir();
  const native = new RuntimeHost(scene, { plugins: [await createPhysicsFactory()] });
  const empty = new RuntimeHost(scene, { plugins: await preparePhysicsServices(scene) });
  try {
    attach(native); attach(empty);
    native.facade.physics.setGravity([0, -2, 0]); native.step(3);
    empty.step(3);
    const legacy = native.snapshot();
    assert.deepEqual(empty.snapshot().scheduler.systems, legacy.scheduler.systems);
    empty.restore(legacy);
    assert.deepEqual(empty.facade.physics.gravity(), [0, -2, 0]);
    assert.equal((empty.inspect().plugins as { ids: string[] }).ids.includes("$engine.physics"), true);
    const malformed = structuredClone(legacy);
    (malformed.plugins!["$engine.physics"].payload as { bindings: string[] }).bindings.push("hidden");
    assert.throws(() => empty.restore(malformed), /TC_PHYSICS_SNAPSHOT/);
    native.step(2050);
    const checkpoint = native.snapshot();
    assert.equal((checkpoint.plugins!["$engine.physics"].payload as { version: number }).version, 4);
    const beforeCheckpointRestore = empty.snapshot();
    assert.throws(() => empty.restore(checkpoint), /TC_PHYSICS_SNAPSHOT.*required/);
    assert.deepEqual(empty.snapshot(), beforeCheckpointRestore);
    const required = new RuntimeHost({ ...scene, services: { physics3d: "required" } }, { plugins: await preparePhysicsServices({ ...scene, services: { physics3d: "required" } }) });
    try { attach(required); required.restore(checkpoint); assert.deepEqual(required.facade.physics.gravity(), [0, -2, 0]); }
    finally { required.dispose(); }
    const withoutPhysics = structuredClone(empty.snapshot());
    delete withoutPhysics.plugins!["$engine.physics"];
    withoutPhysics.scheduler.systems = withoutPhysics.scheduler.systems.filter(system => !system.id.startsWith("$engine.physics"));
    empty.restore(withoutPhysics);
    assert.deepEqual(empty.facade.physics.gravity(), scene.scene.gravity);
  } finally { native.dispose(); empty.dispose(); }
});

test("production gameplay bundle separates both native backends and Chromium empty-world prepare never requests them", { timeout: 120000 }, async t => {
  const root = await mkdtemp(path.join(tmpdir(), "pelican-service-plan-"));
  const outDir = path.join(root, "dist");
  const absolute = (name: string) => path.resolve(name).replaceAll("\\", "/");
  await writeFile(path.join(root, "index.html"), '<script type="module" src="/entry.ts"></script>');
  await writeFile(path.join(root, "entry.ts"), `
    import { prepareGameplay } from ${JSON.stringify(absolute("packages/renderer/src/gameplay.ts"))};
    import { RuntimeHost } from ${JSON.stringify(absolute("packages/runtime/src/host.ts"))};
    import { defineGame, defineScene, defineSystem, instantiateGame } from ${JSON.stringify(absolute("packages/sdk/src/index.ts"))};
    window.prepareEmpty = async function(ir) {
      const system = defineSystem({ id: "spin", run(ctx) { ctx.physics.raycast([0,0,0], [0,-1,0], 1); } });
      const content = await prepareGameplay(ir, location.href, {});
      const host = new RuntimeHost(ir, { plugins: content.plugins });
      try {
        host.attach(instantiateGame(defineGame({ id: ir.gameId, scene: defineScene({ id: "main", entities: [] }), systems: [system] }), host.facade));
        host.step(2);
        const saved = host.snapshot(); host.step(); host.restore(saved);
        return { ray: host.facade.physics.raycast([0,0,0],[0,-1,0],1), tick: host.facade.time.tick, plugins: host.inspect().plugins };
      } finally { host.dispose(); await content.dispose(); }
    };
  `);
  const chunks = new Map<string, { imports: string[]; dynamicImports: string[]; modules: string[]; entry: boolean }>();
  await build({ root, configFile: false, envFile: false, logLevel: "error", publicDir: false,
    build: { outDir, target: "es2023", minify: false },
    plugins: [{ name: "service-plan-contract", generateBundle(_options, bundle) {
      for (const [name, item] of Object.entries(bundle)) if (item.type === "chunk")
        chunks.set(name, { imports: item.imports, dynamicImports: item.dynamicImports, modules: Object.keys(item.modules), entry: item.isEntry });
    } }],
  });
  const staticChunks = new Set<string>();
  function visit(name: string) {
    if (staticChunks.has(name)) return;
    staticChunks.add(name); for (const dependency of chunks.get(name)?.imports ?? []) visit(dependency);
  }
  for (const [name, chunk] of chunks) if (chunk.entry) visit(name);
  const nativeChunks = [...chunks].filter(([, chunk]) => chunk.modules.some(module => /\/physics\/(?:index\.ts|rapier\.ts|physics2d\.ts|vendor\/rapier3d\/)/.test(module.replaceAll("\\", "/"))));
  assert.ok(nativeChunks.length >= 2, JSON.stringify([...chunks]));
  for (const [name] of nativeChunks) assert.equal(staticChunks.has(name), false, `${name} is a static entry dependency`);
  assert.ok([...chunks.values()].some(chunk => chunk.dynamicImports.length >= 2));
  const artifact = { root, entryStaticChunks: [...staticChunks], nativeChunks: nativeChunks.map(([name]) => name) };
  await writeFile(path.join(root, "bundle-contract.json"), JSON.stringify(artifact, null, 2));
  t.diagnostic(`Bundle evidence: ${path.join(root, "bundle-contract.json")}`);
  const server = createServer(async (request, response) => {
    try {
      const relative = new URL(request.url!, "http://localhost").pathname.slice(1) || "index.html";
      const file = path.resolve(outDir, relative);
      if (!file.startsWith(outDir + path.sep)) { response.writeHead(403).end(); return; }
      response.setHeader("Content-Type", file.endsWith(".js") ? "application/javascript" : "text/html");
      response.end(await readFile(file));
    } catch { response.writeHead(404).end(); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const browser = await chromium.launch({ headless: true, args: ["--disable-gpu"] });
  try {
    const page = await browser.newPage();
    const requested: string[] = [], errors: string[] = [];
    page.on("request", request => requested.push(new URL(request.url()).pathname.slice(1)));
    page.on("pageerror", error => errors.push(error.message));
    const address = server.address(); assert.ok(address && typeof address !== "string");
    await page.goto(`http://127.0.0.1:${address.port}/`);
    await page.waitForFunction(() => typeof (window as any).prepareEmpty === "function");
    const scene = ir(); scene.services = { physics3d: "disabled" }; scene.systems = [{ id: "spin", phase: "update", source }];
    const result = await page.evaluate(text => (window as any).prepareEmpty(JSON.parse(text)), JSON.stringify(scene));
    assert.equal(result.ray, null); assert.equal(result.tick, 2); assert.deepEqual(errors, []);
    for (const [name] of nativeChunks) assert.equal(requested.includes(name), false, `requested native backend ${name}`);
    await writeFile(path.join(root, "browser-contract.json"), JSON.stringify({ requested, result, errors, rendering: "not tested" }, null, 2));
  } finally { await browser.close(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});
