import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import {
  diagnoseRendering,
  engineStartup,
  onEngineStartup,
  renderQuality,
  engineTasks,
} from "../packages/sdk/src/index.ts";
import { publishStartup } from "../packages/sdk/src/startup-observer.ts";
import { fetchLoadingAsset } from "../packages/renderer/src/loading.ts";
import { emissionOnlyChange } from "../packages/renderer/src/history-policy.ts";
import { temporalFilterReference } from "../packages/renderer/src/temporal-filter.ts";
import {
  extractSurfaceScene,
  createSurfaceMeshCache,
} from "../packages/renderer/src/surface.ts";
import {
  createSurfaceGeometryPacker,
  packSurfaceGeometry,
} from "../packages/renderer/src/surface-gpu.ts";
import {
  createTraversalDataPacker,
  packTraversalData,
} from "../packages/renderer/src/traversal-nodes.ts";
import { createSurfaceAcceleration } from "../packages/renderer/src/acceleration.ts";
import {
  createSurfaceMotionPacker,
  packPreviousSurfacePositions,
} from "../packages/renderer/src/surface-motion.ts";

test("startup observers are detached, abortable, replay latest state and isolate UI exceptions", () => {
  const signal = new AbortController(),
    values: string[] = [];
  const stop = onEngineStartup((state) => {
    values.push(state.stage);
    state.message = "tampered";
  }, signal.signal);
  const bad = onEngineStartup(() => {
    if (engineStartup().stage !== "idle") throw Error("UI failed");
  });
  publishStartup({
    stage: "download",
    message: "Downloading",
    asset: "room.glb",
    loadedBytes: 100,
  });
  assert.equal(engineStartup().message, "Downloading");
  signal.abort();
  stop();
  bad();
  publishStartup({ stage: "ready", message: "Ready" });
  assert.equal(values.at(-1), "download");
  assert.equal(engineStartup().stage, "ready");
});
test("network progress uses byte events and cancellation, not a total GPU deadline", async () => {
  const old = globalThis.fetch;
  try {
    globalThis.fetch = async () =>
      new Response(
        new ReadableStream({
          start(sink) {
            sink.enqueue(new Uint8Array([1, 2]));
            setTimeout(() => {
              sink.enqueue(new Uint8Array([3]));
              sink.close();
            }, 15);
          },
        }),
        { headers: { "Content-Length": "3" } },
      );
    assert.deepEqual(
      new Uint8Array(
        await (
          await fetchLoadingAsset("https://assets.test/room", undefined, 40)
        ).arrayBuffer(),
      ),
      new Uint8Array([1, 2, 3]),
    );
    assert.equal(engineStartup().loadedBytes, 3);
    assert.equal(engineStartup().totalBytes, 3);
    globalThis.fetch = async (_input, init) =>
      new Promise((_resolve, reject) =>
        init?.signal?.addEventListener("abort", () =>
          reject(init.signal!.reason),
        ),
      );
    await assert.rejects(
      fetchLoadingAsset("https://assets.test/stalled", undefined, 10),
      /TC_ASSET_NETWORK_IDLE/,
    );
    const controller = new AbortController();
    const pending = fetchLoadingAsset("https://assets.test/cancel", {
      signal: controller.signal,
    });
    controller.abort(Error("CANCELLED"));
    await assert.rejects(pending, /CANCELLED/);
    globalThis.fetch = async () => new Response("missing", { status: 404 });
    await assert.rejects(
      fetchLoadingAsset("https://assets.test/missing"),
      /TC_ASSET_HTTP.*404/,
    );
  } finally {
    globalThis.fetch = old;
  }
});
test("emission changes preserve compatible guides; structure, albedo and graph rows still invalidate", () => {
  const before = new Float32Array(64),
    after = before.slice();
  after[11] = 2;
  assert.equal(emissionOnlyChange(before, after), true);
  after[32] = 0.2;
  assert.equal(emissionOnlyChange(before, after), false);
  assert.equal(emissionOnlyChange(undefined, after), false);
});
test("quality-first and balanced tiers preserve resolution while their default bounce budgets differ", () => {
  assert.equal(renderQuality("high").maxBounces, 8);
  assert.equal(renderQuality("medium").maxBounces, 4);
  assert.equal(renderQuality("high").samplesPerFrame, 4);
  assert.equal(renderQuality("medium").samplesPerFrame, 2);
  assert.equal("resolutionScale" in renderQuality("medium"), false);
  const tasks = engineTasks("动态室内低噪光追、加载进度和移动端性能优化");
  assert.ok(tasks.some((task) => task.id === "startup-feedback"));
  assert.ok(tasks.some((task) => task.id === "render-diagnostics"));
});
test("diagnostics explain observations without mutating quality or calling wall time FPS", () => {
  const input = {
    mode: "path" as const,
    metrics: [{ wallMs: 200 }],
    rendering: {
      surface: {
        samples: 2,
        uploadBytes: 2097152,
        temporal: { lastReset: true, resetReasons: ["materials"] },
      },
    },
  };
  const before = structuredClone(input),
    report = diagnoseRendering(input);
  assert.deepEqual(input, before);
  assert.ok(
    report.findings.some((f) => f.code === "TC_RENDER_HISTORY_INVALIDATED"),
  );
  assert.ok(report.findings.some((f) => f.code === "TC_RENDER_FRAME_BUDGET"));
  assert.equal(diagnoseRendering({}).frameProcessingMs.samples, 0);
});
test("persistent packing matches the independent full oracle across motion, materials and topology", () => {
  const scene = new THREE.Scene(),
    material = new THREE.MeshStandardMaterial();
  const moving = new THREE.Mesh(new THREE.BoxGeometry(), material),
    fixed = new THREE.Mesh(new THREE.SphereGeometry(0.5, 8, 6), material);
  scene.add(moving, fixed);
  const geometry = createSurfaceGeometryPacker(),
    traversal = createTraversalDataPacker(),
    motion = createSurfaceMotionPacker(),
    cache = createSurfaceMeshCache(),
    acceleration = createSurfaceAcceleration();
  let previous: ReturnType<typeof extractSurfaceScene> | undefined;
  for (let frame = 0; frame < 5; frame++) {
    moving.position.x = frame * 0.1;
    if (frame === 2) material.vertexColors = true;
    if (frame === 3) scene.remove(fixed);
    const surface = extractSurfaceScene(scene, { meshCache: cache });
    const tree = acceleration.update(surface);
    const packed = geometry(
      surface,
      tree.orderedTriangles,
      new Map(),
      new Map(),
    );
    assert.deepEqual(
      packed,
      packSurfaceGeometry(surface, tree.orderedTriangles),
    );
    assert.deepEqual(
      traversal(tree.nodes, packed, tree.topologyRevision),
      packTraversalData(tree.nodes, packed),
    );
    assert.deepEqual(
      motion(previous, surface, tree.orderedTriangles, tree.sourceIndices),
      packPreviousSurfacePositions(previous, surface, tree.orderedTriangles),
    );
    previous = surface;
  }
  moving.geometry.dispose();
  fixed.geometry.dispose();
  material.dispose();
  acceleration.dispose();
});
test("reactive temporal history is bounded and constant lighting does not gain or lose energy", () => {
  const current = new Float32Array([0.4, 0.5, 0.6, 2]);
  const result = temporalFilterReference({
    width: 1,
    height: 1,
    inputRadiance: current,
    normalDepth: [0, 1, 0, 2],
    albedoRoughness: [0.5, 0.5, 0.5, 0.5],
    reprojection: [0.5, 0.5, 2, 1],
    previousRadiance: [0.4, 0.5, 0.6, 100],
    previousNormalDepth: [0, 1, 0, 2],
    previousAlbedoRoughness: [0.5, 0.5, 0.5, 0.5],
    reactive: true,
  });
  assert.deepEqual(result.slice(0, 3), current.slice(0, 3));
  assert.equal(result[3], 10);
});
