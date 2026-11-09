import assert from "node:assert/strict";
import test from "node:test";
import { startupRenderSettings } from "../packages/renderer/src/startup-quality.ts";
import { resolveRenderSettings } from "../packages/runtime/src/render-settings.ts";
test("omitted quality selects default path while an explicit player tier preserves authored exposure and lighting", () => {
  assert.equal(
    resolveRenderSettings(startupRenderSettings({}, "")).mode,
    "path",
  );
  assert.equal(startupRenderSettings({ mode: "hybrid" }, "").mode, "hybrid");
  const low = startupRenderSettings(
    { exposure: 1.7, directLighting: false },
    "?quality=low",
  );
  assert.equal(low.mode, "raster");
  assert.equal(low.denoise, false);
  assert.equal(low.exposure, 1.7);
  assert.equal(low.directLighting, false);
  assert.equal(startupRenderSettings({}, "?quality=medium").mode, "hybrid");
  assert.equal(startupRenderSettings({}, "?quality=high").mode, "path");
  for (const search of [
    "?quality=bad",
    "?quality=",
    "?quality=high&quality=low",
  ])
    assert.throws(() => startupRenderSettings({}, search), /TC_RENDER_QUALITY/);
});
