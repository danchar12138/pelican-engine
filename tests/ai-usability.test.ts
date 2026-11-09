import { compareDisplayPixels } from "../tools/capture-facts.ts";
import { createWorld } from "../packages/runtime/src/world.ts";
import {
  readRecipeAssets,
  validateRecipeAssets,
  prepareRecipeAssetCopy,
} from "../tools/npm/recipes.ts";
import { symlink, mkdir } from "node:fs/promises";
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { encode } from "fast-png";
import { compactAuthorGuide } from "../tools/author-guide.ts";
import {
  engineTasks,
  diagnoseRendering,
  renderQuality,
} from "../packages/sdk/src/index.ts";
import {
  result,
  normalizeDiagnostic,
  exitCodeFor,
  parseCommand,
  PROTOCOL_VERSION,
} from "../packages/protocol/src/index.ts";
import {
  projectInspection,
  selectInspectRecords,
} from "../packages/renderer/src/checkpoint.ts";
import { captureFacts } from "../tools/capture-facts.ts";
import { renderProtocolReference } from "../tools/protocol-reference.ts";
import { writeAuthorEntry } from "../tools/npm/layout.ts";
test("compact complete envelopes fit 2 KiB across task catalog, preserve continuation and avoid compilation", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pelican-compact-"));
  await writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ dependencies: { "pelican-engine": "1.9.0" } }),
  );
  await writeFile(
    path.join(root, "pelican.project.json"),
    JSON.stringify({ entry: "missing.ts" }),
  );
  for (const id of ["", "unknown-task", ...engineTasks().map((t) => t.id)]) {
    const data = await compactAuthorGuide(id ? ["--goal", id] : [], root);
    const bytes = Buffer.byteLength(
      JSON.stringify(result("guide-1794215497775", "succeeded", data)) + "\n",
    );
    assert.ok(bytes <= 2048, id + " produced " + bytes);
    assert.equal(data.truncated, true);
    assert.match(data.continuation, /^pelican guide/);
    assert.equal(data.project.entry, "missing.ts");
  }
  await writeAuthorEntry(root, process.cwd());
  const entry = await readFile(path.join(root, "AGENTS.md"), "utf8");
  for (const task of engineTasks())
    assert.ok(entry.includes("--goal " + task.id));
});
test("diagnostic normalization is lossless and exit classification is shared", () => {
  const input = {
    code: "TC_RUNTIME_SYSTEM",
    severity: "error",
    message: "failed",
    suggestion: "query exact method",
    causeCodes: ["TC_FAIL"],
    tick: 4,
    stage: "update",
    system: "move",
    entity: "p",
    resource: "mesh",
    source: { file: "game.ts", line: 1, column: 2 },
  };
  const normalized = normalizeDiagnostic(input);
  assert.equal(normalized.remediation, input.suggestion);
  assert.deepEqual(normalized.source, input.source);
  assert.equal(normalized.tick, 4);
  assert.equal(
    result("x", "failed", null, [normalized]).protocolVersion,
    PROTOCOL_VERSION,
  );
  for (const [status, code, want] of [
    ["succeeded", "TC_X", 0],
    ["failed", "TC_CLI_FILE", 1],
    ["failed", "TC_RUNTIME_SYSTEM", 2],
    ["failed", "TC_CONTROL_RUNTIME_UNAVAILABLE", 3],
    ["cancelled", "TC_X", 3],
    ["timed_out", "TC_X", 3],
  ] as const)
    assert.equal(
      exitCodeFor(result("x", status, null, [{ ...normalized, code }])),
      want,
    );
});
test("inspect explicit fields preserve diagnostic dependencies under pagination", () => {
  const assets = [
    { id: "a", hash: "same" },
    { id: "b", hash: "same" },
  ];
  const page = selectInspectRecords([{ id: "a" }, { id: "b" }], { limit: 1 });
  const view = projectInspection(
    {
      mode: "raster",
      backend: "WebGPUBackend",
      tick: 9,
      ready: true,
      playback: { playing: false },
      compiledIR: { assets },
      errors: [],
      runtime: { records: page.records },
      paging: page.paging,
    },
    { fields: ["compiledIR", "summary", "rendering"] },
  );
  assert.equal(view.summary.statistics.entities, 2);
  assert.equal(view.selection.availability.rendering, "unavailable");
  assert.equal(view.selection.truncated, true);
  assert.ok(
    diagnoseRendering(view).findings.some(
      (f) => f.code === "TC_ASSET_DUPLICATE_CONTENT",
    ),
  );
  assert.equal(
    parseCommand({ type: "inspect", summary: true }).type,
    "inspect",
  );
  assert.throws(
    () => parseCommand({ type: "inspect", fields: ["bogus"] }),
    /TC_PROTOCOL_INSPECT/,
  );
});
test("capture facts measure known display pixels without inferring dark-image faults", () => {
  const png = encode({
    width: 4,
    height: 1,
    channels: 4,
    data: Uint8Array.from([
      0, 0, 0, 255, 255, 255, 255, 255, 128, 128, 128, 255, 255, 0, 0, 255,
    ]),
  });
  const facts = captureFacts(png, { backend: "WebGPUBackend", tick: 4 });
  assert.equal(facts.darkPixelRatio, 0.25);
  assert.equal(facts.upperSaturatedPixelRatio, 0.5);
  assert.equal(facts.luminance.min, 0);
  assert.equal(facts.luminance.max, 1);
  assert.ok(
    Math.abs(facts.luminance.mean - (1 + 0.2158605 + 0.2126) / 4) < 0.00001,
  );
  assert.equal(
    facts.luminance.histogram.reduce((a, b) => a + b),
    4,
  );
  assert.match(facts.colorSpace, /not scene radiance/);
  assert.equal(facts.evidence.sha256.length, 64);
});
test("HTTP reference is generated from real command contract", async () => {
  const doc = await renderProtocolReference(process.cwd());
  assert.match(doc, /type: "inspect"/);
  assert.match(doc, /__pelican\/control/);
  assert.match(doc, /--data-binary @request.json/);
  assert.match(doc, /TC_PROTOCOL_VERSION_UNSUPPORTED/);
  assert.equal(await readFile("docs/npm/HTTP-PROTOCOL.md","utf8"),doc);
});
test("default raster retains explicit hybrid/path selection", () => {
  assert.equal(renderQuality().mode, "raster");
  assert.equal(renderQuality("realtime").mode, "raster");
  assert.equal(renderQuality("high").mode, "path");
  assert.equal(renderQuality("medium").mode, "hybrid");
});

test("small recipe assets carry hashes/licenses and reject traversal, tampering and directory links", async () => {
  const assets = await readRecipeAssets(process.cwd(), "model-animation");
  assert.ok(assets.length >= 2);
  assert.ok(assets.every((a) => a.license === "CC0-1.0"));
  assert.throws(
    () => validateRecipeAssets([{ ...assets[0], path: "../escape.glb" }]),
    /TC_RECIPE_ASSET_PATH/,
  );
  assert.throws(
    () => validateRecipeAssets([{ ...assets[0], sha256: "0".repeat(64) }]),
    /TC_RECIPE_ASSET_INTEGRITY/,
  );
  const root = await mkdtemp(path.join(tmpdir(), "pelican-recipe-asset-"));
  await (
    await prepareRecipeAssetCopy(root, assets)
  )();
  assert.equal(
    (await readFile(path.join(root, assets[0].path))).length,
    assets[0].bytes,
  );
  await assert.rejects(
    () => prepareRecipeAssetCopy(root, assets),
    /TC_CREATE_EXISTS/,
  );
  const linked = await mkdtemp(path.join(tmpdir(), "pelican-linked-asset-"));
  await symlink(
    path.join(root, "assets"),
    path.join(linked, "assets"),
    process.platform === "win32" ? "junction" : "dir",
  );
  await assert.rejects(
    () => prepareRecipeAssetCopy(linked, assets),
    /TC_RECIPE_ASSET_PATH/,
  );
});

test("opt-in bounded development trace records actual system order and managed writes without saving telemetry", () => {
  const plain = createWorld();
  assert.equal(plain.inspect().developmentTrace, undefined);
  const world = createWorld({ traceLimit: 5, entities: [{ id: "p" }] });
  world.runSystem("move", { writes: ["Transform"] }, () =>
    world.setTransform("p", { position: [1, 2, 3] }),
  );
  assert.deepEqual(
    world.inspect().developmentTrace?.entries.map((e) => e.kind),
    ["system-start", "managed-write", "system-end"],
  );
  assert.throws(
    () =>
      world.runSystem("bad", { writes: [] }, () =>
        world.setTransform("p", { position: [0, 0, 0] }),
      ),
    /TC_WORLD_ACCESS_WRITE/,
  );
  const trace = world.inspect().developmentTrace!;
  assert.equal(trace.entries.length, 5);
  assert.ok(trace.dropped > 0);
  assert.ok(
    trace.entries.some((e) => e.kind === "fault" && e.system === "bad"),
  );
  assert.ok(!JSON.stringify(world.snapshot()).includes("developmentTrace"));
  world.dispose();
  assert.equal(world.inspect().developmentTrace?.entries.length, 0);
});

test("controlled screenshot comparison uses explicit tolerances and rejects visible divergence", () => {
  const image = (v: number) =>
    encode({
      width: 2,
      height: 2,
      channels: 4,
      data: Uint8Array.from(
        Array.from({ length: 4 }, () => [v, v, v, 255]).flat(),
      ),
    });
  assert.equal(compareDisplayPixels(image(128), image(128)).passed, true);
  assert.equal(compareDisplayPixels(image(129), image(128)).passed, true);
  assert.equal(compareDisplayPixels(image(255), image(0)).passed, false);
});
