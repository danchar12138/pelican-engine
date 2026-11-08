import assert from "node:assert/strict";
import test from "node:test";
import {
  engineTasks,
  engineCapabilities,
  renderQuality,
} from "../packages/sdk/src/index.ts";
import { generateApiIndex } from "../tools/api-index.ts";
import { authorGuide } from "../tools/author-guide.ts";
import { recipeIds } from "../tools/npm/recipes.ts";
import { contentIterationCompatibility } from "../packages/schema/src/content-iteration.ts";
import type { SceneIR } from "../packages/compiler/src/types.ts";
import { resolveRenderSettings } from "../packages/runtime/src/render-settings.ts";
import { discoveryRecovery } from "../tools/discovery-recovery.ts";

test("every task resolves real capabilities, recipes and generated method declarations", async () => {
  const index = await generateApiIndex(),
    symbols = new Set(
      [...index.symbols, ...index.members].map((item) => item.name),
    );
  for (const task of engineTasks()) {
    assert.equal(engineTasks(task.id)[0].id, task.id);
    for (const alias of task.aliases)
      assert.ok(
        engineTasks(alias).some((item) => item.id === task.id),
        alias,
      );
    for (const feature of task.features)
      assert.ok(engineCapabilities(feature).length, feature);
    for (const method of task.methods)
      assert.ok(symbols.has(method), `${task.id}: ${method}`);
    for (const recipe of task.recipes)
      assert.ok(recipeIds.includes(recipe), recipe);
  }
  assert.ok(
    symbols.has("GameRuntimeInput.setup"),
    "Typed setup must remain available to exact method discovery.",
  );
  for (const feature of engineCapabilities())
    assert.ok(
      engineTasks().some(
        (task) => task.id === feature.id && task.features.includes(feature.id),
      ),
      `Undiscoverable feature ${feature.id}`,
    );
  for (const [goal, id] of [
    ["播放声音", "audio.playback"],
    ["我想雕刻地形", "world.terrain"],
    ["add localization to my game", "localization.messages"],
    ["显示瓦片地图", "presentation.tilemaps"],
  ]) {
    assert.ok(
      authorGuide(["--goal", goal]).discovery.features.some(
        (feature) => feature.id === id,
      ),
      goal,
    );
  }
});
test("natural-language goals compose tasks and unknown goals return honest actionable candidates", () => {
  for (const goal of [
    "让角色跳跃并保存游戏",
    "make a character jump and save game",
    "接npm组件",
    "让相机跟随角色",
    "加载动态资源",
  ]) {
    const result = authorGuide(["--goal", goal]);
    assert.equal(result.discovery.status, "matched", goal);
    assert.ok(result.discovery.tasks.length, goal);
    assert.ok(result.discovery.recipes.length, goal);
    assert.ok(result.discovery.next.length, goal);
  }
  assert.equal(engineTasks("jumpingjack").length, 0);
  for (const [goal, feature, method] of [
    ["npm", "runtime.composition", "defineGameRuntime"],
    ["worker", "runtime.transports", "createWorkerAdapter"],
    ["动态资源", "runtime.dynamic-data", "loadRuntimeBytes"],
    ["画质", "render.quality", "renderQuality"],
  ]) {
    const result = authorGuide(["--goal", goal]);
    assert.ok(
      result.discovery.features.some((item) => item.id === feature),
      goal,
    );
    assert.ok(
      result.discovery.tasks.some((item) => item.methods.includes(method)),
      method,
    );
  }
  const unknown = authorGuide(["--goal", "made-up-feature-xyz"]);
  assert.equal(unknown.discovery.status, "unrecognized");
  assert.equal(unknown.discovery.features.length, 0);
  assert.ok(
    unknown.discovery.candidates!.every(
      (candidate) =>
        authorGuide(["--goal", candidate.id]).discovery.status === "matched",
    ),
  );
});
test("quality presets are detached, high fidelity and retain explicit backend checks", () => {
  assert.deepEqual(resolveRenderSettings({}), renderQuality());
  assert.equal(renderQuality().maxBounces, 8);
  assert.equal(renderQuality("preview").denoise, true);
  assert.equal(renderQuality("capture").mode, "path");
  assert.equal(renderQuality("capture").maxBounces, 12);
  const changed = renderQuality();
  changed.exposure = 10;
  assert.equal(renderQuality().exposure, 1);
  assert.throws(() => renderQuality("invalid" as never), /TC_RENDER_QUALITY/);
});
test("API and capability failures share actionable task recovery without claiming support", () => {
  for (const [error, flag] of [
    ["TC_API_SEARCH_UNKNOWN", "--search"],
    ["TC_API_SYMBOL_UNKNOWN", "--symbol"],
    ["TC_CAPABILITY_UNKNOWN", "--feature"],
  ]) {
    const found = discoveryRecovery(new Error(error), [
      "api",
      flag,
      "让角色跳跃",
    ]);
    assert.equal(found.candidates![0].id, "character-jump");
    assert.equal(found.candidates![0].matchedIntent, true);
    assert.ok(found.remediation!.includes("not claims"));
  }
  assert.deepEqual(
    discoveryRecovery(new Error("TC_CAPABILITY_UNSUPPORTED"), []),
    {},
  );
});
test("iteration allows source-only changes, rejects resource and schema changes", () => {
  const before = {
    gameId: "game",
    runtime: { version: "1" },
    systems: [{ id: "tick", source: { file: "game.ts", line: 1 } }],
    assets: [{ id: "texture", hash: "a" }],
    components: [],
  } as unknown as SceneIR;
  const next = structuredClone(before);
  next.systems[0].source.line = 20;
  assert.equal(contentIterationCompatibility(before, next).compatible, true);
  for (const mutate of [
    (ir: SceneIR) => {
      ir.runtime!.version = "2";
    },
    (ir: SceneIR) => {
      ir.assets[0].hash = "b";
    },
    (ir: SceneIR) => {
      ir.systems[0].id = "new";
    },
  ]) {
    const changed = structuredClone(next);
    mutate(changed);
    assert.equal(
      contentIterationCompatibility(before, changed).compatible,
      false,
    );
  }
  const custom = { ...before, input: { source: ["w"] } };
  assert.equal(
    contentIterationCompatibility(custom, {
      ...custom,
      input: { source: ["a"] },
    }).compatible,
    false,
  );
});
