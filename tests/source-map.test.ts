import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mapSourcePath } from "../packages/compiler/src/source-map.ts";
import { resolveEnginePath } from "../packages/compiler/src/version.ts";
test("source maps normalize Windows slash/case differences across engine and project drives", () => {
  const win = path.win32,
    project = "C:\\Users\\runner\\Temp\\game",
    sdk = "D:\\a\\pelican\\packages\\sdk\\src\\index.ts";
  assert.equal(
    mapSourcePath("D:/a/pelican/packages/sdk/src/index.ts", project, sdk, win),
    "pelican-sdk/index.ts",
  );
  assert.equal(
    mapSourcePath("d:/A/PELICAN/packages/sdk/src/index.ts", project, sdk, win),
    "pelican-sdk/index.ts",
  );
  assert.equal(mapSourcePath("../game.ts", project, sdk, win), "game.ts");
  assert.equal(
    mapSourcePath("C:/Users/runner/Temp/game/logic/move.ts", project, sdk, win),
    "logic/move.ts",
  );
  assert.equal(
    mapSourcePath("\0pelican:m0-game-entry", project, sdk, win),
    "pelican-generated-entry",
  );
  assert.throws(
    () => mapSourcePath("E:/unexpected/private.ts", project, sdk, win),
    /TC_SOURCE_MAP_EXTERNAL/,
  );
});

test("source maps resolve sourceRoot before clearing it and retain SDK identity across drives", () => {
  const win = path.win32,
    project = "C:\\games\\demo",
    sdk = "D:\\engine\\packages\\sdk\\src\\index.ts";
  assert.equal(
    mapSourcePath("logic.ts", project, sdk, win, "../src"),
    "src/logic.ts",
  );
  assert.equal(
    mapSourcePath("index.ts", project, sdk, win, "D:/engine/packages/sdk/src"),
    "pelican-sdk/index.ts",
  );
  assert.equal(
    mapSourcePath(
      "systems/types.ts",
      project,
      sdk,
      win,
      "D:/engine/packages/sdk/src",
    ),
    "pelican-sdk/systems/types.ts",
  );
  assert.equal(
    mapSourcePath("C:/games/demo/game.ts", project, sdk, win, "D:/ignored"),
    "game.ts",
  );
});

test("source maps preserve POSIX case and map generated entries without leaking machine paths", () => {
  const posix = path.posix,
    project = "/game",
    sdk = "/engine/sdk/index.ts";
  assert.equal(
    mapSourcePath("../src/game.ts", project, sdk, posix),
    "src/game.ts",
  );
  assert.equal(
    mapSourcePath("/engine/sdk/Index.ts", project, sdk, posix),
    "pelican-sdk/Index.ts",
  );
  assert.equal(
    mapSourcePath("\0pelican:game-entry", project, sdk, posix),
    "pelican-generated-entry",
  );
  assert.equal(
    mapSourcePath("/engine/sdk-other/private.ts", project, sdk, posix),
    "../engine/sdk-other/private.ts",
  );
});

test("engine lock paths support relative, absolute cross-drive and UNC Windows directories", () => {
  const win = path.win32;
  assert.equal(
    resolveEnginePath("C:\\games\\demo", "../../engine", win),
    "C:\\engine",
  );
  assert.equal(
    resolveEnginePath("C:\\games\\demo", "D:/engines/pelican", win),
    "D:\\engines\\pelican",
  );
  assert.equal(
    resolveEnginePath("C:\\games\\demo", "//server/share/pelican", win),
    "\\\\server\\share\\pelican",
  );
});


test("cross-drive source maps include selected engine shared runtime dependencies without exposing unrelated paths", () => {
  const win = path.win32, project = "C:/Temp/game", engine = "D:/a/pelican-engine", sdk = engine + "/packages/sdk/src/index.ts";
  assert.equal(mapSourcePath(engine + "/packages/schema/src/json-value.ts", project, sdk, win, "", engine), "pelican-engine/packages/schema/src/json-value.ts");
  assert.equal(mapSourcePath("d:/A/PELICAN-ENGINE/packages/schema/src/json-value.ts", project, sdk, win, "", engine), "pelican-engine/packages/schema/src/json-value.ts");
  assert.equal(mapSourcePath(engine + "/packages/sdk/src/runtime-lifecycle.ts", project, sdk, win, "", engine), "pelican-sdk/runtime-lifecycle.ts");
  assert.equal(mapSourcePath("C:/Temp/game/game.ts", project, sdk, win, "", engine), "game.ts");
  assert.equal(mapSourcePath(engine + "/lib/schema/json-value.js", project, engine + "/lib/sdk/index.js", win, "", engine), "pelican-engine/lib/schema/json-value.js");
  assert.equal(mapSourcePath(engine + "/examples/demo/game.ts", engine + "/examples/demo", sdk, win, "", engine), "game.ts");
  for (const external of ["E:/private/file.ts", "D:/a/pelican-engine-other/file.ts", "D:/a/private/file.ts"])
    assert.throws(() => mapSourcePath(external, project, sdk, win, "", engine), /TC_SOURCE_MAP_EXTERNAL/);
});
