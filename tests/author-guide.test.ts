import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { authorGuide, queryCapabilities } from "../tools/author-guide.ts";
import { SDK_VERSION, engineCapabilities } from "../packages/sdk/src/index.ts";

test("cold-start guide is compact, source-derived and permits ordinary npm composition", () => {
  const guide = authorGuide([]);
  assert.equal(guide.engineVersion, SDK_VERSION);
  assert.ok(Buffer.byteLength(JSON.stringify(guide)) < 4500);
  assert.match(guide.authoring.language, /Not a mandatory engine DSL/);
  assert.match(
    guide.authoring.dependencies,
    /No algorithm dependency approval list/,
  );
  const npm = authorGuide(["--goal", "npm"]);
  assert.ok(
    npm.discovery.features.some(
      (feature) => feature.id === "content.libraries",
    ),
  );
  assert.deepEqual(
    npm.discovery.recipes.find((recipe) => recipe.id === "runtime-lifecycle")
      ?.dependencies,
    { fflate: "0.8.3" },
  );
  const saved = authorGuide(["--goal", "存档"]);
  assert.ok(
    authorGuide(["--goal", "自定义扩展"]).discovery.recipes.some(
      (recipe) => recipe.id === "managed-rendering",
    ),
  );
  assert.ok(
    saved.discovery.features.some((feature) => feature.id === "storage.save"),
  );
  assert.ok(
    saved.discovery.next.some((command) => command.includes("StorageService")),
  );
  const unknown = authorGuide(["--goal", "unknownNotACapability"]);
  assert.equal(unknown.discovery.status, "unrecognized");
  assert.equal(unknown.discovery.failure?.code, "TC_TASK_UNKNOWN");
  assert.ok(unknown.discovery.candidates!.length > 3);
  assert.throws(() => authorGuide(["--goal", "硬件光追"]), /TC_CAPABILITY_UNSUPPORTED/);
  for (const args of [
    ["--goal"],
    ["--goal", " "],
    ["--goal", "npm", "--goal", "audio"],
    ["--unused"],
  ])
    assert.throws(() => authorGuide(args), /TC_GUIDE_QUERY/);
});

test("capability summaries reduce bytes, page deterministically and preserve full 1.x results", () => {
  const full = queryCapabilities([]),
    summary = queryCapabilities(["--summary"]);
  assert.deepEqual(full.features, engineCapabilities());
  assert.equal(full.total, summary.total);
  assert.ok(
    Buffer.byteLength(JSON.stringify(summary)) <
      Buffer.byteLength(JSON.stringify(full)) * 0.6,
  );
  const collected: string[] = [];
  for (let offset = 0; offset < full.total; offset += 7) {
    const page = queryCapabilities([
      "--summary",
      "--limit",
      "7",
      "--offset",
      String(offset),
    ]);
    collected.push(...page.features.map((feature) => feature.id));
    assert.equal(page.truncated, offset + 7 < full.total);
  }
  assert.deepEqual(
    collected,
    full.features.map((feature) => feature.id),
  );
  const empty = queryCapabilities(["--offset", "100000"]);
  assert.deepEqual(empty.features, []);
  assert.equal(empty.truncated, false);
  for (const args of [
    ["--limit"],
    ["--limit", "0"],
    ["--limit", "101"],
    ["--offset", "-1"],
    ["--offset", "1.5"],
    ["--summary", "--summary"],
  ])
    assert.throws(() => queryCapabilities(args), /TC_CAPABILITY_QUERY/);
});

test("actual CLI provides cold-start context and compact targeted discovery", () => {
  for (const args of [
    ["guide"],
    ["guide", "--goal", "npm"],
    ["capabilities", "--summary", "--limit", "3"],
  ]) {
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "tools/cli.ts", ...args],
      { encoding: "utf8", timeout: 30000, windowsHide: true },
    );
    assert.equal(result.status, 0, result.stderr + result.stdout);
    const output = JSON.parse(result.stdout);
    assert.equal(output.status, "succeeded");
    assert.equal(output.data.engineVersion, SDK_VERSION);
  }
});

test("task catalog pages expose every metadata route with an exact continuation",()=>{let ids:string[]=[];let offset=0;while(true){const page=authorGuide(["--tasks","--limit","7","--offset",String(offset)]);ids.push(...page.discovery.tasks.map(t=>t.id));if(!page.discovery.paging?.truncated)break;assert.match(page.discovery.paging.next!,/pelican guide --tasks --limit 7 --offset/);offset+=7;}assert.ok(ids.length>20);assert.equal(new Set(ids).size,ids.length);});
