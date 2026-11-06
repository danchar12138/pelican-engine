import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { decode } from "fast-png";
import { serveDist } from "./static-server.ts";
import { automationLaunchOptions, waitForEngine, withAutomationDeadline } from "./browser-session.ts";
import { sourceFingerprint } from "./source-fingerprint.ts";

const dist = process.argv[2], output = process.argv[3];
if (!dist || !output) throw new Error("Usage: sparse-static-probe <dist> <output>");
await mkdir(output, { recursive: true });
const source = (await sourceFingerprint(process.cwd())).sha256;
const server = await serveDist(path.resolve(dist), 0, "/sparse/game/");
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  browser = await chromium.launch(automationLaunchOptions());
  const page = await browser.newPage({ viewport: { width: 320, height: 240 } });
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
  await page.route("**/*", route => new URL(route.request().url()).origin === new URL(server.url).origin ? route.continue() : route.abort());
  const url = new URL(server.url); url.search = "width=320&height=240";
  await page.goto(url.href, { waitUntil: "domcontentloaded" });
  await waitForEngine(page, 30000, { production: true });
  const identity = await page.evaluate(async () => {
    const adapter = await navigator.gpu?.requestAdapter({ powerPreference: "high-performance" });
    return { backend: document.documentElement.dataset.pelicanBackend, fallback: adapter?.info?.isFallbackAdapter ?? null,
      vendor: adapter?.info?.vendor ?? "", control: typeof (window as any).__pelican };
  });
  assert.equal(identity.backend, "webgpu");
  assert.equal(identity.fallback, false);
  assert.equal(identity.control, "undefined");
  assert.equal((await page.request.get(server.url + "__pelican/control")).status(), 404);
  await withAutomationDeadline(() => page.waitForFunction(() => document.documentElement.dataset.pelicanFrameState === "idle", undefined, { polling: 100 }), 30000, "production first frame");
  const capture = async (name: string) => decode(await page.locator("canvas:visible").first().screenshot({ path: path.join(output, name + ".png") }));
  const before = await capture("original");
  await page.keyboard.press("a");
  await new Promise(resolve => setTimeout(resolve, 500));
  assert.equal(await page.evaluate(() => document.documentElement.dataset.pelicanFailure ?? null), null);
  const after = await capture("optimized");
  assert.equal(before.width, 320); assert.equal(before.height, 240);
  assert.equal(after.width, before.width); assert.equal(after.height, before.height);
  assert.equal(after.channels, before.channels);
  let red = 0, changed = 0;
  for (let i = 0; i < before.width * before.height; i++) {
    const p = i * before.channels;
    if (before.data[p] > 40 && before.data[p] > before.data[p + 1] * 2 && before.data[p] > before.data[p + 2] * 2) red++;
    if ([0, 1, 2].some(c => Math.abs(before.data[p + c] - after.data[p + c]) > 3)) changed++;
  }
  assert.ok(red > 100, `Expected visible sparse geometry, found ${red} red pixels`);
  assert.ok(changed <= before.width * before.height * 0.001, `Original and optimized differ: ${changed} pixels`);
  assert.deepEqual(errors, []);
  await page.reload({ waitUntil: "domcontentloaded" });
  await waitForEngine(page, 30000, { production: true });
  assert.equal(await page.evaluate(() => document.documentElement.dataset.pelicanFailure ?? null), null);
  assert.equal((await sourceFingerprint(process.cwd())).sha256, source);
  const report = { scope: "sparse GLB static deployment development", formalMilestoneAccepted: false, probeSourceIdentity: source,
    backend: identity, redPixels: red, changedPixels: changed, subpath: "/sparse/game/", reload: true, errors,
    limitations: ["The source fingerprint identifies the probe-time workspace, not the build inputs.", "Matching images do not independently prove the A-key model switch.", "Single local device and scene, not formal M3 acceptance."] };
  await writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report));
} finally {
  await browser?.close();
  await server.close();
}
