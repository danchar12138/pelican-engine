import test from "node:test";
import assert from "node:assert/strict";
import { renderCapabilities, requireCompute } from "../packages/runtime/src/render-capabilities.ts";
import { createRenderSettingsDriver } from "../packages/runtime/src/render-settings.ts";
import { runtimeStatus } from "../packages/renderer/src/startup.ts";

test("WebGL2 rejects compute modes and denoising transactionally with remediation", () => {
  const defaults = createRenderSettingsDriver({}, [], () => renderCapabilities("webgl2"));
  assert.equal(defaults.service.state().mode,"raster");defaults.dispose();
  const driver = createRenderSettingsDriver({ mode: "raster" }, [], () => renderCapabilities("webgl2"));
  const before = driver.service.state();
  for (const mode of ["path", "hybrid"] as const)
    assert.throws(() => driver.service.configure({ mode }), /TC_RENDER_MODE_UNAVAILABLE.*Available modes: raster/);
  assert.throws(() => driver.service.configure({ denoise: true }), /TC_RENDER_COMPUTE_UNAVAILABLE.*WebGPU/);
  assert.deepEqual(driver.service.state(), before);
  driver.service.configure({ exposure: 3, samplesPerFrame: 8, maxBounces: 12 });
  assert.equal(driver.service.state().samplesPerFrame, 8);
  assert.equal(driver.service.state().maxBounces, 12);
  const report = driver.service.capabilities();
  assert.deepEqual(report, { backend: "webgl2", compute: false, availableModes: ["raster"] });
  (report.availableModes as string[]).push("path");
  assert.deepEqual(driver.service.capabilities().availableModes, ["raster"]);
  assert.throws(() => requireCompute(renderCapabilities("webgl2"), "custom compute"), /TC_RENDER_COMPUTE_UNAVAILABLE/);
  assert.throws(() => createRenderSettingsDriver({ mode: "path" }, [], () => renderCapabilities("webgl2")), /TC_RENDER_MODE_UNAVAILABLE/);
});

test("WebGPU preserves all modes and settings, backend status is explicit", () => {
  const driver = createRenderSettingsDriver({ mode: "path", denoise: true }, [], () => renderCapabilities("webgpu"));
  assert.equal(driver.service.state().mode, "path");
  assert.deepEqual(driver.service.capabilities().availableModes, ["raster", "hybrid", "path"]);
  assert.match(runtimeStatus({ backend: "webgl2", mode: "raster", playing: true, automation: false, tick: 1, triangles: 2 }), /WebGL2/);
});

test("checkpoint restore rechecks current backend before changing settings", () => {
  let backend: "webgpu" | "webgl2" = "webgpu";
  const driver = createRenderSettingsDriver({}, [], () => renderCapabilities(backend));
  const plugin = driver.factory({} as never);
  driver.service.configure({ mode: "path" });
  const snapshot = plugin.snapshot();
  driver.service.configure({ mode: "raster" });
  backend = "webgl2";
  assert.throws(() => plugin.restore(snapshot), /TC_RENDER_MODE_UNAVAILABLE/);
  assert.equal(driver.service.state().mode, "raster");
});
