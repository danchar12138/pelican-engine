import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_RENDER_SETTINGS,
  resolveRenderSettings,
  createRenderSettingsDriver,
} from "../packages/runtime/src/render-settings.ts";
test("render settings resolve once, isolate returned values and reject unknown or invalid controls atomically", () => {
  assert.equal(
    resolveRenderSettings({ mode: "path", samplesPerFrame: 4 }).mode,
    "path",
  );
  const driver = createRenderSettingsDriver({ mode: "hybrid" }),
    before = driver.service.state();
  const copy = driver.service.state() as any;
  copy.mode = "bad";
  assert.equal(driver.service.state().mode, "hybrid");
  for (const patch of [
    { mode: "webgl" },
    { samplesPerFrame: 0 },
    { maxBounces: NaN },
    { denoise: "yes" },
    { exposure: Infinity },
    { debug: "unknown" },
    { internalDevice: 1 },
  ])
    assert.throws(
      () => driver.service.configure(patch as never),
      /TC_RENDER_SETTINGS/,
    );
  assert.deepEqual(driver.service.state(), before);
  assert.equal(DEFAULT_RENDER_SETTINGS.mode, "path");
  assert.equal(DEFAULT_RENDER_SETTINGS.denoise, true);
  assert.equal(resolveRenderSettings({ mode: "raster" }).denoise, false);
  driver.dispose();
  assert.throws(() => driver.service.state(), /TC_RENDER_DISPOSED/);
});
test("render snapshot binds initial settings and validates current values before restoring", () => {
  const driver = createRenderSettingsDriver({ mode: "path" }),
    plugin = driver.factory({} as never),
    saved = plugin.snapshot();
  driver.service.configure({ exposure: 2 });
  plugin.restore(saved);
  assert.equal(driver.service.state().exposure, 1);
  const bad = structuredClone(saved) as any;
  bad.settings.samplesPerFrame = 0;
  assert.throws(() => plugin.restore(bad), /TC_RENDER_SETTINGS/);
  assert.equal(driver.service.state().samplesPerFrame, 2);
  const other = createRenderSettingsDriver({ mode: "raster" }).factory(
    {} as never,
  );
  assert.throws(() => other.restore(saved), /TC_RENDER_SNAPSHOT/);
  plugin.dispose();
});
