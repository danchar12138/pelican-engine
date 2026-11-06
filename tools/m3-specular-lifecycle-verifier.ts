/** Offline consistency only; this does not authenticate execution or authorize release. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verifyM3SpecularImageEvidence, type SpecularImageEvidenceOptions } from "./m3-specular-image-verifier.ts";

type Obj = Record<string, any>;
function object(value: unknown, label: string): Obj {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value), `${label}: expected object`);
  return value as Obj;
}
function count(value: unknown, label: string): number {
  assert.ok(typeof value === "number" && Number.isSafeInteger(value) && value >= 0, `${label}: expected nonnegative integer`);
  return value;
}
function resourceCounts(value: unknown, label: string): Obj {
  const resource = object(value, label), owned = object(resource.owned, `${label}.owned`);
  assert.equal(resource.disposed, false, `${label}.disposed`);
  const fields = ["entries", "pending", "loaded", "references", "scopes", "inFlightLoads", "inFlightDisposals"];
  for (const key of fields) count(owned[key], `${label}.${key}`);
  assert.ok(owned.loaded > 0 && owned.entries === owned.loaded && owned.references >= owned.loaded && owned.scopes > 0, `${label}: expected live resources`);
  assert.equal(owned.pending + owned.inFlightLoads + owned.inFlightDisposals, 0, `${label}: resources not settled`);
  assert.ok(Array.isArray(resource.entries) && resource.entries.length === owned.entries, `${label}: entries count`);
  const keys = resource.entries.map((value: unknown) => {
    const e = object(value, `${label}.entry`);
    assert.ok(typeof e.key === "string" && e.key.length > 0 && typeof e.type === "string" && e.type.length > 0 && e.state === "loaded", `${label}: invalid entry`);
    assert.ok(count(e.refCount, `${label}.refCount`) > 0, `${label}: unreferenced entry`);
    return `${e.type}\0${e.key}`;
  });
  assert.equal(new Set(keys).size, keys.length, `${label}: duplicate resources`);
  return { owned: Object.fromEntries(fields.map(k => [k, owned[k]])), keys: keys.sort() };
}

/** Requires trusted frozen filesystem snapshots; concurrent writers are not authenticated. */
export async function verifyM3SpecularLifecycleEvidence(options: SpecularImageEvidenceOptions) {
  const image = await verifyM3SpecularImageEvidence(options);
  const root = await realpath(options.evidenceRoot);
  const bytes = await readFile(path.resolve(root, options.report ?? "specular-textures-game.json"));
  assert.equal(createHash("sha256").update(bytes).digest("hex"), image.reportSha256, "report changed during verification");
  const report = object(JSON.parse(bytes.toString("utf8")), "report"), lifecycle = object(report.lifecycle, "lifecycle");
  assert.deepEqual(report.errors, [], "report errors");
  const initial = object(lifecycle.initialRasterCapabilities, "initial capabilities"), activated = object(lifecycle.activatedPathCapabilities, "path capabilities");
  assert.equal(initial.tracerInitialized, false, "initial tracer");
  assert.match(initial.tracer, /lazy initialization/i, "initial tracer");
  assert.equal(activated.tracerInitialized, true, "activated tracer");
  const snapshot = object(lifecycle.snapshot, "snapshot"), savedResources = object(snapshot.resources, "snapshot.resources");
  const tick = count(snapshot.tick, "snapshot.tick");
  assert.equal(snapshot.mode, "hybrid", "snapshot.mode");
  assert.ok(Array.isArray(snapshot.records) && snapshot.records.length > 0, "snapshot.records missing");
  assert.equal(count(lifecycle.steppedTick, "steppedTick"), tick + 1, "step tick");
  assert.equal(savedResources.format, "pelican.resources", "snapshot resource format");
  assert.equal(savedResources.version, 1, "snapshot resource version");
  assert.ok(Array.isArray(savedResources.resources) && savedResources.resources.length > 0, "snapshot resources missing");
  const savedKeys = savedResources.resources.map((value: unknown) => {
    const r = object(value, "snapshot resource");
    assert.ok(typeof r.type === "string" && r.type.length > 0 && typeof r.key === "string" && r.key.length > 0 && r.state === "loaded", "snapshot resource invalid");
    return `${r.type}\0${r.key}`;
  }).sort();
  assert.equal(new Set(savedKeys).size, savedKeys.length, "duplicate snapshot resources");
  const restore = object(lifecycle.restore, "restore"), rejected = object(lifecycle.invalidRestore, "invalidRestore"), beforeRejection = object(lifecycle.beforeRejection, "beforeRejection"), after = object(lifecycle.afterRejection, "afterRejection");
  const before = object(lifecycle.beforeRecovery, "beforeRecovery"), recovery = object(lifecycle.recovery, "recovery");
  for (const [name, state] of [["restore", restore], ["afterRejection", after], ["beforeRecovery", before], ["recovery", recovery]] as const)
    assert.equal(count(state.tick, `${name}.tick`), tick, `${name}.tick`);
  for (const [name, state] of [["restore", restore], ["beforeRejection", beforeRejection], ["afterRejection", after], ["beforeRecovery", before], ["recovery", recovery]] as const) {
    assert.equal(count(state.tick, `${name}.tick`), tick, `${name}.tick`);
    assert.equal(state.mode, snapshot.mode, `${name}.mode`);
    assert.deepEqual(state.records, snapshot.records, `${name}.records`);
  }
  assert.equal(rejected.status, "failed", "invalidRestore.status");
  assert.equal(rejected.data, null, "invalidRestore.data");
  assert.ok(Array.isArray(rejected.diagnostics) && rejected.diagnostics.some((d: any) => d?.code === "TC_BROWSER_SNAPSHOT" && d.severity === "error"), "invalidRestore diagnostic");
  assert.equal(before.mode, "hybrid", "beforeRecovery.mode");
  assert.equal(recovery.mode, before.mode, "recovery.mode");
  assert.ok(Array.isArray(before.records) && before.records.length > 0, "beforeRecovery.records missing");
  assert.deepEqual(recovery.records, before.records, "recovery.records");
  const oldRecovery = object(before.recovery, "beforeRecovery.recovery"), newRecovery = object(recovery.recovery, "recovery.recovery");
  assert.equal(oldRecovery.active, false, "beforeRecovery active"); assert.equal(newRecovery.active, false, "recovery active");
  assert.equal(count(newRecovery.count, "recovery.count"), count(oldRecovery.count, "beforeRecovery.count") + 1, "recovery count");
  assert.ok(Array.isArray(oldRecovery.events) && Array.isArray(newRecovery.events), "recovery events missing");
  assert.deepEqual(newRecovery.events.slice(0, oldRecovery.events.length), oldRecovery.events, "recovery event history");
  const events = newRecovery.events.slice(oldRecovery.events.length);
  assert.equal(events.length, 2, "recovery events count");
  assert.deepEqual(events.map((e: any) => e?.phase), ["lost", "restored"], "recovery events phases");
  for (const event of events) assert.equal(event.tick, tick, "recovery event tick");
  const baseline = resourceCounts(restore.resources, "restore.resources");
  assert.deepEqual(baseline.keys, savedKeys, "snapshot resource identities");
  for (const [name, state] of [["afterRejection", after], ["beforeRecovery", before], ["recovery", recovery]] as const)
    assert.deepEqual(resourceCounts(state.resources, `${name}.resources`), baseline, `${name} resource counts`);
  let modelBaseline: unknown;
  for (const entry of report.modes) {
    const label = `${entry.stage}-${entry.mode}`, models = object(entry.models, `${label}.models`), owned = object(models.owned, `${label}.models.owned`);
    const capture = object(entry.observation, `${label}.observation`), captureBefore = object(capture.before, `${label}.before`), captureAfter = object(capture.after, `${label}.after`);
    assert.equal(count(captureBefore.tick, `${label}.tick`), tick, `${label}.tick`);
    assert.equal(captureBefore.mode, entry.mode, `${label}.actualMode`);
    assert.deepEqual(captureBefore.records, snapshot.records, `${label}.records`);
    assert.deepEqual(captureAfter, captureBefore, `${label}.captureState`);
    assert.equal(models.disposed, false, `${label}.models.disposed`);
    assert.ok(count(models.instances, `${label}.instances`) > 0 && count(owned.textures, `${label}.textures`) > 0, `${label}: missing model or textures`);
    const modelCounts = { instances: models.instances, textures: owned.textures };
    if (!modelBaseline) modelBaseline = modelCounts;
    assert.deepEqual(modelCounts, modelBaseline, `${label}: model counts changed`);
    assert.deepEqual(resourceCounts(entry.resources, `${label}.resources`), baseline, `${label}: resource counts changed`);
    assert.equal(object(entry.capabilities, `${label}.capabilities`).tracerInitialized, true, `${label}.tracerInitialized`);
    if (entry.mode !== "raster") {
      const surface = object(entry.surface, `${label}.surface`), capture = object(surface.capture, `${label}.capture`), textures = object(capture.textures, `${label}.capture.textures`);
      assert.ok(count(surface.triangleCount, `${label}.triangleCount`) >= 4 && count(textures.entries, `${label}.textureEntries`) >= 2 && count(textures.texels, `${label}.texels`) > 0, `${label}: tracer capture missing`);
    }
  }
  return { verifiedProbe: "specular-lifecycle-report-consistency" as const, sourceIdentity: image.sourceIdentity, reportSha256: image.reportSha256, images: image.images,
    formalMilestoneAccepted: false as const, releaseAllowed: false as const,
    limitations: "Offline report and image consistency only; reported capture states are not independently authenticated. Cannot prove execution, GPU origin, hardware or lifecycle behavior. No release or formal M3 acceptance." };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const option = (name: string) => { const i = args.indexOf(name); if (i < 0 || !args[i + 1] || args[i + 1].startsWith("--")) throw new Error(`Missing ${name}`); return args[i + 1]; };
  try {
    const result = await verifyM3SpecularLifecycleEvidence({ sourceRoot: option("--source-root"), evidenceRoot: option("--evidence-root"), ...(args.includes("--report") ? { report: option("--report") } : {}) });
    if (args.includes("--output")) await writeFile(option("--output"), JSON.stringify(result, null, 2) + "\n", { flag: "wx" });
    console.log(JSON.stringify(result, null, 2));
  } catch (error) { console.error(error); process.exitCode = 1; }
}
