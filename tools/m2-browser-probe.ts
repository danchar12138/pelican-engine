import assert from "node:assert/strict";
import { chromium } from "playwright";
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import {
  automationLaunchOptions,
  waitForEngine,
  withAutomationDeadline,
} from "./browser-session.ts";
export async function runM2Journey(url: string, output: string) {
  await mkdir(output, { recursive: true });
  const browser = await chromium.launch(automationLaunchOptions());
  const errors: string[] = [];
  try {
    return await withAutomationDeadline(
      async () => {
        const page = await browser.newPage({
          viewport: { width: 1280, height: 720 },
        });
        page.on("pageerror", (e) => errors.push(e.message));
        page.on("console", (m) => {
          if (m.type() === "error") errors.push(m.text());
        });
        const target = new URL(url);
        target.searchParams.set("automation", "1");
        target.searchParams.set("width", "1280");
        target.searchParams.set("height", "720");
        await page.goto(target.href, { waitUntil: "domcontentloaded" });
        await waitForEngine(page);
        const cmd = async (value: unknown) => {
          const r = await page.evaluate(
            async (v) => (window as any).__pelican.command(v),
            value,
          );
          assert.equal(r.status, "succeeded", JSON.stringify(r));
          return r.data;
        };
        const state = () =>
          page.evaluate(() => (window as any).__pelican.inspect());
        const pixels = async () => {
          const png = await page
            .locator("canvas")
            .first()
            .screenshot({ type: "png", timeout: 10000 });
          return await page.evaluate(async (encoded) => {
            const image = new Image();
            image.src = "data:image/png;base64," + encoded;
            await image.decode();
            const canvas = document.createElement("canvas");
            canvas.width = image.width;
            canvas.height = image.height;
            const context = canvas.getContext("2d")!;
            context.drawImage(image, 0, 0);
            const data = context.getImageData(
              0,
              0,
              canvas.width,
              canvas.height,
            ).data;
            const colors = new Set<number>();
            let nonBlack = 0,
              hash = 2166136261;
            for (let i = 0; i < data.length; i += 4) {
              const color = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
              colors.add(color);
              if (color > 0x030303) nonBlack++;
              hash = Math.imul(hash ^ color, 16777619);
            }
            return {
              width: image.width,
              height: image.height,
              nonBlack,
              colors: colors.size,
              hash: hash >>> 0,
            };
          }, png.toString("base64"));
        };
        const step = (count: number) => cmd({ type: "step", count });
        const key = (key: string, pressed: boolean) =>
          cmd({ type: "input", key, pressed });
        const tap = async (k: string) => {
          await key(k, true);
          await key(k, false);
          return await step(1);
        };
        const move = async (k: string, n: number) => {
          await key(k, true);
          const s = await step(n);
          await key(k, false);
          console.log(
            JSON.stringify({
              move: k,
              n,
              tick: s.tick,
              player: s.game.transforms.player?.position,
              progress: s.game.components.player?.Progress,
              scene: s.gameplay.scene,
            }),
          );
          return s;
        };
        const initial = await state();
        assert.equal(initial.adapter.isFallbackAdapter, false);
        const initialPixels = await pixels();
        assert.ok(initialPixels.nonBlack > 100000);
        assert.ok(initialPixels.colors > 64);
        await step(15);
        await move("w", 65);
        let s = await tap("e");
        assert.equal(s.game.components.player.Progress.collected, 1);
        const saved = await tap("F5");
        assert.equal(saved.gameplay.storage.state, "saved");
        const movedPixels = await pixels();
        assert.notEqual(movedPixels.hash, initialPixels.hash);
        await page.screenshot({ path: path.join(output, "first-relic.png") });
        await move("a", 56);
        await move("w", 100);
        s = await tap("e");
        assert.equal(s.game.components.player.Progress.collected, 2);
        await move("s", 18);
        await move("d", 112);
        await move("w", 75);
        s = await tap("e");
        assert.equal(s.game.components.player.Progress.collected, 3);
        await page.screenshot({ path: path.join(output, "all-relics.png") });
        await move("a", 56);
        s = await move("w", 58);
        assert.equal(s.gameplay.scene, "sanctuary");
        await page.screenshot({ path: path.join(output, "sanctuary.png") });
        const loaded = await tap("F9");
        assert.equal(loaded.gameplay.scene, "courtyard");
        assert.equal(loaded.gameplay.storage.state, "loaded");
        assert.equal(loaded.game.components.player.Progress.collected, 1);
        assert.ok(
          Math.abs(
            loaded.game.transforms.player.position[2] -
              saved.game.transforms.player.position[2],
          ) < 0.02,
        );
        await page.reload({ waitUntil: "domcontentloaded" });
        await waitForEngine(page);
        const cold = await tap("F9");
        assert.equal(cold.gameplay.storage.state, "loaded");
        assert.equal(cold.game.components.player.Progress.collected, 1);
        const groundedY = cold.game.transforms.player.position[1];
        await tap(" ");
        const jumping = await step(10);
        assert.ok(
          jumping.game.transforms.player.position[1] > groundedY + 0.35,
        );
        const landed = await step(70);
        assert.ok(
          Math.abs(landed.game.transforms.player.position[1] - groundedY) <
            0.03,
        );
        await cmd({ type: "recordStart" });
        await move("d", 8);
        await step(1);
        const trace = await cmd({ type: "recordStop" });
        await step(3);
        const replay = await cmd({ type: "replay", trace });
        assert.equal(replay.status, "passed");
        const modeFailure = await page.evaluate(
          async () =>
            await (window as any).__pelican.command({
              type: "mode",
              mode: "path",
            }),
        );
        assert.equal(modeFailure.status, "failed");
        assert.ok(
          modeFailure.diagnostics.some((d: any) => d.code === "TC_TRACE_STAGE"),
        );
        assert.equal((await state()).mode, "raster");
        const storageKey = "pelican:m2-fox-journey:journey";
        const originalSave = await page.evaluate(
          (key) => localStorage.getItem(key),
          storageKey,
        );
        assert.ok(originalSave);
        await page.evaluate(
          (key) =>
            localStorage.setItem(
              key,
              JSON.stringify({ format: "bad-save", sceneId: "courtyard" }),
            ),
          storageKey,
        );
        const failedLoad = await tap("F9");
        assert.equal(failedLoad.gameplay.storage.state, "failed");
        assert.equal(failedLoad.ready, true);
        await page.evaluate(
          ({ key, value }) => localStorage.setItem(key, value),
          { key: storageKey, value: originalSave },
        );
        const recovered = await tap("F9");
        assert.equal(recovered.gameplay.storage.state, "loaded");
        assert.equal(recovered.game.components.player.Progress.collected, 1);
        const baseModels = recovered.gameplay.models.instances;
        const spawned = await tap("b");
        const crateId = Object.keys(spawned.game.transforms).find((id) =>
          id.startsWith("spawned-crate-"),
        )!;
        assert.ok(crateId);
        await tap("n");
        const dynamic = await step(60);
        assert.ok(dynamic.game.transforms[crateId].position[1] < 0.5);
        assert.equal(dynamic.gameplay.models.instances, baseModels + 1);
        assert.ok(
          Math.abs(dynamic.game.transforms.companion.position[1] - 0.71) < 0.05,
        );
        const dynamicSaved = await tap("F5");
        assert.equal(dynamicSaved.gameplay.storage.state, "saved");
        await page.reload({ waitUntil: "domcontentloaded" });
        await waitForEngine(page);
        const dynamicLoaded = await tap("F9");
        assert.equal(dynamicLoaded.gameplay.storage.state, "loaded");
        assert.equal(dynamicLoaded.gameplay.models.instances, baseModels + 1);
        assert.ok(dynamicLoaded.game.transforms[crateId]);
        assert.ok(dynamicLoaded.game.transforms.companion);
        await page.screenshot({
          path: path.join(output, "dynamic-prefabs.png"),
        });
        const additional = {
          initialPixels,
          movedPixels,
          jumping: jumping.game.transforms.player,
          landed: landed.game.transforms.player,
          replay,
          modeFailure,
          failedLoadStatus: failedLoad.gameplay.storage,
          recoveredStatus: recovered.gameplay.storage,
          dynamicPrefabs: {
            crateId,
            saved: dynamicSaved,
            loaded: dynamicLoaded,
          },
        };
        assert.deepEqual(errors, []);
        await writeFile(
          path.join(output, "journey.json"),
          JSON.stringify(
            {
              passed: true,
              initial,
              saved,
              won: s,
              loaded,
              cold,
              additional,
              errors,
            },
            null,
            2,
          ),
        );
        return {
          passed: true,
          initial,
          saved,
          won: s,
          loaded,
          cold,
          additional,
          errors,
        };
      },
      120000,
      "M2 full gameplay journey",
    );
  } finally {
    await browser.close();
  }
}
