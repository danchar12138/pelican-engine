import test from "node:test";
import assert from "node:assert/strict";
import {
  startupPolicy,
  boundedOperation,
  runtimeStatus,
} from "../packages/renderer/src/startup.ts";

test("normal development and production auto-run; only explicit development automation is paused", () => {
  assert.deepEqual(startupPolicy(true, ""), {
    automation: false,
    playing: true,
  });
  assert.deepEqual(startupPolicy(false, "?automation=1"), {
    automation: false,
    playing: true,
  });
  assert.deepEqual(startupPolicy(true, "?automation=1"), {
    automation: true,
    playing: false,
  });
  assert.deepEqual(startupPolicy(true, "?automation=0"), {
    automation: false,
    playing: true,
  });
});
test("completed status never retains a Waiting GPU / ready loading label", () => {
  const running = runtimeStatus({
    mode: "raster",
    playing: true,
    automation: false,
    tick: 0,
    triangles: 12,
  });
  const paused = runtimeStatus({
    mode: "raster",
    playing: false,
    automation: true,
    tick: 0,
    triangles: 12,
  });
  assert.match(running, /running/);
  assert.match(paused, /paused · automation/);
  assert.doesNotMatch(running + paused, /Waiting GPU|\bready\b/);
});
test("unresolved GPU work rejects on a timer without requestAnimationFrame, input or focus", async () => {
  const start = performance.now();
  await assert.rejects(
    boundedOperation(new Promise<void>(() => {}), "test stalled GPU", 20),
    /TC_GPU_TIMEOUT.*test stalled GPU/,
  );
  assert.ok(performance.now() - start < 1000);
  assert.equal(
    await boundedOperation(Promise.resolve(42), "completed", 100),
    42,
  );
  await assert.rejects(
    boundedOperation(Promise.reject(new Error("device failed")), "failure"),
    /device failed/,
  );
});
