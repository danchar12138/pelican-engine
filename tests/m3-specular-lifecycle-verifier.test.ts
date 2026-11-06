import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { encode } from "fast-png";
import { verifyM3SpecularLifecycleEvidence } from "../tools/m3-specular-lifecycle-verifier.ts";

const hash = (x: string | Uint8Array) => createHash("sha256").update(x).digest("hex");
const colors = [[70,70,70], [0,0,0], [220,30,20], [20,210,30], [70,70,70]];
const samples = Object.fromEntries(["gray", "zeroAlphaRed", "red", "green", "grayReference"].map((n, i) => [n, colors[i]]));
function image() {
  const data = new Uint8Array(320 * 240 * 4);
  for (let i = 0; i < 320 * 240; i++) data[i * 4 + 3] = 255;
  [73,109,146,182,247].forEach((x, n) => { for (let y = 117; y < 124; y++) for (let px = x - 3; px < x + 4; px++) data.set(colors[n], (y * 320 + px) * 4); });
  return encode({ width: 320, height: 240, data, channels: 4, depth: 8 });
}
async function fixture(t: TestContext) {
  const temp = await mkdtemp(path.join(tmpdir(), "m3-lifecycle-"));
  t.after(async () => { assert.equal(path.dirname(temp), path.resolve(tmpdir())); assert.ok(path.basename(temp).startsWith("m3-lifecycle-")); await rm(temp, { recursive: true, force: true }); });
  const sourceRoot = path.join(temp, "source"), evidenceRoot = path.join(temp, "evidence");
  await mkdir(sourceRoot); await mkdir(evidenceRoot);
  const source = "fixture\n"; await writeFile(path.join(sourceRoot, "probe.ts"), source);
  const sourceIdentity = hash(JSON.stringify([{ path: "probe.ts", sha256: hash(source), bytes: Buffer.byteLength(source) }]));
  const resources = { disposed: false, owned: { entries: 1, pending: 0, loaded: 1, references: 1, scopes: 1, inFlightLoads: 0, inFlightDisposals: 0 }, entries: [{ type: "json", key: "scene", state: "loaded", refCount: 1 }] };
  const before = { tick: 4, mode: "hybrid", records: [{ id: "scene" }], recovery: { active: false, count: 0, events: [] }, resources };
  const after = structuredClone(before); after.recovery.count = 1; after.recovery.events = [{ phase: "lost", tick: 4 }, { phase: "restored", tick: 4 }] as never[];
  const modes = ["initial", "restored", "rejected", "recovered"].flatMap(stage => ["raster", "path", "hybrid"].map(mode => ({ stage, mode, screenshot: `${stage}-${mode}.png`, observation: { before: { tick: 4, mode, records: [{ id: "scene" }] }, after: { tick: 4, mode, records: [{ id: "scene" }] } }, samples, resources: structuredClone(resources), models: { disposed: false, instances: 1, owned: { textures: 2 } }, capabilities: { tracerInitialized: true }, surface: { triangleCount: 4, capture: { textures: { entries: 2, texels: 20 } } } })));
  const report = { scope: "KHR_materials_specular texture game probe", passed: true, compileOnly: false, phase: "complete", sourceIdentity, errors: [], modes, lifecycle: {
    initialRasterCapabilities: { tracerInitialized: false, tracer: "lazy initialization" }, activatedPathCapabilities: { tracerInitialized: true },
    snapshot: { tick: 4, mode: "hybrid", records: [{ id: "scene" }], resources: { format: "pelican.resources", version: 1, resources: [{ type: "json", key: "scene", state: "loaded" }] } }, steppedTick: 5,
    restore: { tick: 4, mode: "hybrid", records: [{ id: "scene" }], resources: structuredClone(resources) }, invalidRestore: { status: "failed", data: null, diagnostics: [{ code: "TC_BROWSER_SNAPSHOT", severity: "error" }] },
    beforeRejection: { tick: 4, mode: "hybrid", records: [{ id: "scene" }] }, afterRejection: { tick: 4, mode: "hybrid", records: [{ id: "scene" }], resources: structuredClone(resources) }, beforeRecovery: before, recovery: after,
  } };
  for (const entry of modes) await writeFile(path.join(evidenceRoot, entry.screenshot), image());
  const save = () => writeFile(path.join(evidenceRoot, "specular-textures-game.json"), JSON.stringify(report));
  await save(); return { sourceRoot, evidenceRoot, payload: report, save };
}
test("validates offline observations while keeping release closed", async t => {
  const f = await fixture(t), result = await verifyM3SpecularLifecycleEvidence(f);
  assert.equal(result.images.length, 12); assert.equal(result.releaseAllowed, false); assert.equal(result.formalMilestoneAccepted, false);
  assert.match(result.limitations, /GPU origin/); assert.match(result.limitations, /not independently authenticated/);
});
test("rejects lifecycle tampering and missing records even when passed is true", async t => {
  const f = await fixture(t), original = structuredClone(f.payload.lifecycle);
  const cases: [string, (l: any) => void, RegExp][] = [
    ["step", l => l.steppedTick = 4, /step tick/], ["restore", l => l.restore.tick++, /restore.tick/],
    ["rejection", l => l.invalidRestore.status = "succeeded", /invalidRestore/], ["diagnostic", l => l.invalidRestore.diagnostics = [], /diagnostic/],
    ["after rejection", l => l.afterRejection.tick++, /afterRejection.tick/], ["mode", l => l.recovery.mode = "path", /recovery.mode/],
    ["missing records", l => delete l.beforeRecovery.records, /records/], ["records", l => l.recovery.records[0].id = "other", /records/],
    ["count", l => l.recovery.recovery.count = 2, /recovery count/], ["event", l => l.recovery.recovery.events[1].tick++, /event tick/],
    ["resource", l => l.afterRejection.resources.owned.loaded = 0, /resources/], ["snapshot", l => l.snapshot.resources.resources[0].key = "other", /identities/],
  ];
  for (const [name, mutate, pattern] of cases) {
    f.payload.lifecycle = structuredClone(original); mutate(f.payload.lifecycle); await f.save();
    await assert.rejects(verifyM3SpecularLifecycleEvidence(f), pattern, name);
  }
});
test("rejects missing or forged screenshots, stage resources and stale source", async t => {
  const f = await fixture(t);
  f.payload.modes[4].models.owned.textures = 0; await f.save(); await assert.rejects(verifyM3SpecularLifecycleEvidence(f), /textures/);
  f.payload.modes[4].models.owned.textures = 2; await f.save();
  await rm(path.join(f.evidenceRoot, "recovered-path.png")); await assert.rejects(verifyM3SpecularLifecycleEvidence(f));
  await writeFile(path.join(f.evidenceRoot, "recovered-path.png"), Buffer.from("not PNG")); await assert.rejects(verifyM3SpecularLifecycleEvidence(f), /PNG/);
  await writeFile(path.join(f.evidenceRoot, "recovered-path.png"), image());
  await writeFile(path.join(f.sourceRoot, "probe.ts"), "changed"); await assert.rejects(verifyM3SpecularLifecycleEvidence(f), /sourceIdentity/);
});
test("rejects wrong capture mode, tick, records and state mutation", async t => {
  const f = await fixture(t);
  const original = structuredClone(f.payload.modes);
  for (const [mutate, pattern] of [
    [(entry: any) => entry.observation.before.mode = "hybrid", /actualMode/],
    [(entry: any) => entry.observation.before.tick++, /tick/],
    [(entry: any) => entry.observation.before.records[0].id = "other", /records/],
    [(entry: any) => entry.observation.after.tick++, /captureState/],
    [(entry: any) => delete entry.observation, /observation/],
  ] as const) {
    f.payload.modes = structuredClone(original); mutate(f.payload.modes[0]); await f.save();
    await assert.rejects(verifyM3SpecularLifecycleEvidence(f), pattern);
  }
});
