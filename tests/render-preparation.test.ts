import assert from "node:assert/strict";
import test from "node:test";
import { createRenderPreparation } from "../packages/runtime/src/render-preparation.ts";
import { createRenderSettingsDriver } from "../packages/runtime/src/render-settings.ts";
import { renderCapabilities } from "../packages/runtime/src/render-capabilities.ts";
import { renderQuality } from "../packages/sdk/src/index.ts";

test("preparation requests deduplicate and do not alter rendering or saved state", async () => {
  const driver = createRenderSettingsDriver({ mode: "raster" }, [], () =>
    renderCapabilities("webgpu"),
  );
  const plugin = driver.factory({} as never),
    before = plugin.snapshot();
  const calls: string[] = [];
  driver.service.prepare("path");
  driver.service.prepare("path");
  assert.equal(driver.service.preparation("path").status, "queued");
  await driver.preparation.flush(async (mode) => {
    calls.push(mode);
  });
  assert.deepEqual(calls, ["path"]);
  assert.equal(driver.service.preparation("path").status, "ready");
  assert.deepEqual(plugin.snapshot(), before);
  driver.service.prepare("path");
  await driver.preparation.flush(async (mode) => {
    calls.push(mode);
  });
  assert.deepEqual(calls, ["path"]);
  driver.preparation.invalidate();
  assert.equal(driver.service.preparation("path").status, "idle");
  plugin.dispose();
  assert.throws(() => driver.service.prepare("path"), /TC_RENDER_DISPOSED/);
});
test("failures remain inspectable and retryable, stale/late completion cannot publish readiness", async () => {
  const owner = createRenderPreparation(() => {});
  owner.request("path");
  await owner.flush(async () => {
    throw new Error("INJECTED");
  });
  assert.equal(owner.state("path").status, "failed");
  assert.match(owner.state("path").error!, /INJECTED/);
  owner.request("path");
  let resume!: () => void;
  const pending = owner.flush(
    () =>
      new Promise<void>((resolve) => {
        resume = resolve;
      }),
  );
  assert.equal(owner.state("path").status, "preparing");
  owner.invalidate();
  resume();
  await pending;
  assert.equal(owner.state("path").status, "idle");
  owner.request("hybrid");
  const disposed = owner.flush(
    () =>
      new Promise<void>((resolve) => {
        resume = resolve;
      }),
  );
  owner.dispose();
  resume();
  await disposed;
  assert.throws(() => owner.state("hybrid"), /TC_RENDER_DISPOSED/);
});
test("unsupported and invalid preparation requests fail before queue mutation", () => {
  const driver = createRenderSettingsDriver({ mode: "raster" }, [], () =>
    renderCapabilities("webgl2"),
  );
  assert.throws(
    () => driver.service.prepare("path"),
    /TC_RENDER_MODE_UNAVAILABLE/,
  );
  assert.equal(driver.service.preparation("path").status, "idle");
  assert.throws(
    () => driver.service.prepare("invalid" as never),
    /TC_RENDER_SETTINGS/,
  );
  assert.throws(
    () => createRenderSettingsDriver().service.prepare("path"),
    /TC_RENDER_PREPARATION_UNAVAILABLE/,
  );
  driver.dispose();
});
test("player startup tier does not change authored save compatibility and restoration still checks backend", () => {
  const make = (tier: "high" | "low", backend: "webgpu" | "webgl2" = "webgpu") =>
    createRenderSettingsDriver({}, [], () => renderCapabilities(backend), [], undefined, undefined, renderQuality(tier));
  const high = make("high"), low = make("low"), fallback = make("low", "webgl2");
  const highPlugin = high.factory({} as never), lowPlugin = low.factory({} as never), fallbackPlugin = fallback.factory({} as never);
  try {
    const saved = highPlugin.snapshot();
    assert.equal(low.service.state().mode, "raster");
    assert.deepEqual((saved as any).defaults, (lowPlugin.snapshot() as any).defaults);
    lowPlugin.restore(saved);
    assert.equal(low.service.state().mode, "path", "A supported saved mode restores across startup tiers.");
    assert.throws(() => fallbackPlugin.restore(saved), /TC_RENDER_MODE_UNAVAILABLE/);
    assert.equal(fallback.service.state().mode, "raster", "Unsupported saved modes reject before mutation.");
  } finally { highPlugin.dispose(); lowPlugin.dispose(); fallbackPlugin.dispose(); }
});
