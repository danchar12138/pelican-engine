import test from "node:test";
import assert from "node:assert/strict";
import { inspectTraceCapabilities } from "../packages/renderer/src/startup.ts";

test("render diagnostics distinguish lazy surface, legacy probe, and unavailable compute", () => {
  const state = { backend: "webgpu" as const, legacyProbe: false, surfaceInitialized: false, gameplay: true, maxBounces: 3 };
  const lazy = inspectTraceCapabilities(state);
  assert.match(String(lazy.tracer), /surface.*lazy/);
  assert.equal(lazy.tracerInitialized, false);
  assert.match(String(lazy.hybrid), /actual shadow/);
  assert.match(String(lazy.textures), /surface tracing/);
  const active = inspectTraceCapabilities({ ...state, surfaceInitialized: true });
  assert.equal(active.tracer, "WebGPU surface triangle-BVH");
  assert.equal(active.tracerInitialized, true);
  const legacy = inspectTraceCapabilities({ ...state, legacyProbe: true });
  assert.match(String(legacy.tracer), /legacy/);
  assert.equal(legacy.denoiser, false);
  for (const backend of ["webgl2", "uninitialized"] as const) {
    const unavailable = inspectTraceCapabilities({ ...state, backend });
    assert.equal(unavailable.tracer, false);
    assert.equal(unavailable.tracerInitialized, false);
    assert.equal(unavailable.hybrid, false);
    assert.equal(unavailable.tracedLights, false);
  }
});
