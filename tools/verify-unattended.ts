import assert from "node:assert/strict";
import { chromium, type Browser } from "playwright";

/** Regression for startup/commands that used to appear stuck until the user focused the browser. */
export async function verifyUnattended(
  url: string,
  launch: () => Promise<Browser>,
) {
  const browser = await launch();
  const failures: string[] = [];
  try {
    const automatic = await browser.newPage({
      viewport: { width: 960, height: 540 },
    });
    automatic.on("pageerror", (error) => failures.push(error.message));
    await automatic.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });
    await automatic.waitForFunction(
      () => document.documentElement.dataset.threecatReady === "true",
      undefined,
      { polling: 100, timeout: 30000 },
    );
    const first = await automatic.evaluate(() =>
      (window as any).__threecat.inspect(),
    );
    const covering = await browser.newPage();
    await covering.goto("about:blank");
    // Never activate the game page or send keyboard/mouse input to make it progress.
    await new Promise((resolve) => setTimeout(resolve, 700));
    const second = await automatic.evaluate(() =>
      (window as any).__threecat.inspect(),
    );
    assert.equal(first.playback.playing, true);
    assert.equal(first.playback.automation, false);
    assert.ok(second.tick > first.tick);
    const status = await automatic.locator("#status").textContent();
    assert.match(status!, /running/);
    assert.doesNotMatch(status!, /Waiting GPU|\bready\b/);

    const controlled = await browser.newPage({
      viewport: { width: 960, height: 540 },
    });
    controlled.on("pageerror", (error) => failures.push(error.message));
    await controlled.addInitScript({
      content:
        "window.__rafCalls = 0; window.requestAnimationFrame = function(){ window.__rafCalls++; return window.__rafCalls; }; window.cancelAnimationFrame = function(){};",
    });
    const testURL = new URL(url);
    testURL.searchParams.set("automation", "1");
    await controlled.goto(testURL.href, {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });
    // Default Playwright RAF polling would never run against this deliberate stub.
    await controlled.waitForFunction(
      () =>
        typeof (window as any).__threecat?.command === "function" ||
        !!(window as any).__threecatFailure,
      undefined,
      { polling: 100, timeout: 30000 },
    );
    const initial = await controlled.evaluate(() => ({
      error: (window as any).__threecatFailure,
      state: (window as any).__threecat?.inspect(),
      status: document.querySelector("#status")?.textContent,
    }));
    assert.equal(initial.error, undefined);
    assert.equal(initial.state.playback.automation, true);
    assert.equal(initial.state.playback.playing, false);
    assert.equal(initial.state.tick, 0);
    assert.match(initial.status!, /paused · automation/);
    assert.doesNotMatch(initial.status!, /Waiting GPU|\bready\b/);
    await covering.bringToFront();
    const response = await controlled.evaluate(
      async () =>
        await (window as any).__threecat.command({ type: "step", count: 3 }),
    );
    assert.equal(response.status, "succeeded");
    assert.equal(response.data.tick, 3);
    assert.equal(response.data.runtime.scheduler.tick, 3);
    assert.equal(response.data.adapter.isFallbackAdapter, false);
    const screenshot = await controlled.screenshot({
      type: "png",
      timeout: 10000,
    });
    assert.equal(screenshot.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
    assert.deepEqual(failures, []);
    return {
      passed: true,
      inputActions: 0,
      gamePageActivated: false,
      normalPage: {
        initialTick: first.tick,
        backgroundTick: second.tick,
        status,
      },
      automationWithoutRAF: {
        initialTick: 0,
        finalTick: response.data.tick,
        status: initial.status,
        backend: response.data.backend,
        adapter: response.data.adapter,
        screenshotBytes: screenshot.byteLength,
      },
      failures,
    };
  } finally {
    await browser.close();
  }
}
