import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mapSourcePath } from "../experiments/compiler/source-map.ts";
test("source maps normalize Windows slash/case differences across engine and project drives", () => {
  const win = path.win32,
    project = "C:\\Users\\runner\\Temp\\game",
    sdk = "D:\\a\\threecat\\packages\\sdk\\src\\index.ts";
  assert.equal(
    mapSourcePath("D:/a/threecat/packages/sdk/src/index.ts", project, sdk, win),
    "threecat-sdk/index.ts",
  );
  assert.equal(
    mapSourcePath("d:/A/THREECAT/packages/sdk/src/index.ts", project, sdk, win),
    "threecat-sdk/index.ts",
  );
  assert.equal(mapSourcePath("../game.ts", project, sdk, win), "game.ts");
  assert.equal(
    mapSourcePath("C:/Users/runner/Temp/game/logic/move.ts", project, sdk, win),
    "logic/move.ts",
  );
  assert.equal(
    mapSourcePath("\0threecat:m0-game-entry", project, sdk, win),
    "threecat-generated-entry",
  );
  assert.throws(
    () => mapSourcePath("E:/unexpected/private.ts", project, sdk, win),
    /TC_SOURCE_MAP_EXTERNAL/,
  );
});
