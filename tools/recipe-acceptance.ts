import assert from "node:assert/strict";
import { decode } from "fast-png";
import type { Page } from "playwright";
import type { ControlCommand } from "../packages/protocol/src/index.ts";
type Command = (input: ControlCommand) => Promise<any>;
const acceptance: Record<
  string,
  { run: (page: Page, command: Command) => Promise<unknown> }
> = {
  "render-quality": {
    run: async (page, command) => {
      assert.equal((await command({ type: "inspect" })).mode, "raster");
      await command({ type: "mode", mode: "path" });
      const highStartup = await command({ type: "snapshot" });
      await page.goto(page.url() + "&quality=low");
      await page.waitForFunction(
        () => document.documentElement.dataset.pelicanReady === "true",
        undefined,
        { timeout: 60000, polling: 100 },
      );
      const low = await command({ type: "snapshot" });
      const initial = await command({ type: "inspect" });
      assert.equal(initial.mode, "raster");
      assert.equal(initial.rendering.surface, undefined);
      await command({ type: "restore", snapshot: highStartup });
      assert.equal((await command({ type: "inspect" })).mode, "path");
      await command({ type: "restore", snapshot: low });
      assert.equal((await command({ type: "inspect" })).mode, "raster");
      const prepared = await command({ type: "prepareRender", mode: "path" });
      assert.equal(prepared.mode, "raster");
      assert.equal(prepared.tick, initial.tick);
      assert.equal(
        prepared.rendering.preparation.find((item: any) => item.mode === "path")
          .status,
        "ready",
      );
      assert.deepEqual(
        (await command({ type: "snapshot" })).runtime,
        low.runtime,
      );
      const click = async (id: string) => {
        await page.locator(`[data-pelican-element="${id}"]`).click();
        return command({ type: "step", count: 1 });
      };
      const high = await click("high");
      assert.equal(high.mode, "path");
      assert.equal(high.rendering.settings.denoise, true);
      const bytes = high.rendering.surface.ownedBytes;
      for (let i = 0; i < 3; i++) {
        const medium = await click("medium");
        assert.equal(medium.mode, "hybrid");
        assert.equal((await click("low")).rendering.settings.denoise, false);
        const state = await click("high");
        assert.equal(state.rendering.surface.ownedBytes, bytes);
      }
      await command({ type: "restore", snapshot: low });
      assert.equal((await command({ type: "inspect" })).mode, "raster");
      await page.setViewportSize({ width: 640, height: 360 });
      await command({ type: "step", count: 1 });
      assert.equal(
        (await command({ type: "inspect" })).rendering.preparation.find(
          (item: any) => item.mode === "path",
        ).status,
        "idle",
      );
      await command({ type: "prepareRender", mode: "path" });
      assert.deepEqual((await command({ type: "inspect" })).errors, []);
      return {
        defaultMode: "raster",
        explicitLow: true,
        preparedWithoutTick: true,
        repeatedSwitches: 9,
        tracingStorageBytes: bytes,
        resizeInvalidates: true,
      };
    },
  },
  "npm-component": {
    run: async (page, command) => {
      await command({ type: "step", count: 3 });
      const label = page.locator("[data-pelican-npm-counter]");
      assert.match(
        await label.innerText(),
        /^3 ticks \| \d+ compressed bytes$/,
      );
      await page.locator('[data-pelican-element="save"]').click();
      await command({ type: "step", count: 1 });
      await command({ type: "step", count: 3 });
      assert.match(await label.innerText(), /^7 ticks/);
      await page.locator('[data-pelican-element="load"]').click();
      await command({ type: "step", count: 1 });
      await command({ type: "step", count: 1 });
      assert.equal(await label.count(), 1);
      assert.match(await label.innerText(), /^5 ticks/);
      await page.setViewportSize({ width: 390, height: 844 });
      assert.equal(
        await label.evaluate(
          (element) => (element as HTMLElement).style.maxWidth,
        ),
        "358px",
      );
      return {
        npmRoundTrip: true,
        instanceContext: true,
        savedTicks: 4,
        resumedTicks: 5,
        ownedMarkers: 1,
      };
    },
  },
  "dynamic-texture": {
    run: async (page, command) => {
      await command({ type: "step", count: 1 });
      const first = await command({ type: "snapshot" });
      const label = page.locator('[data-pelican-element="state"]');
      assert.match(await label.innerText(), /^2 x 2 \| managed image$/);
      const image = decode(
        await page.locator("canvas:visible").first().screenshot(),
      );
      const colors = new Set<string>();
      for (let y = 160; y < 380; y += 20)
        for (let x = 360; x < 600; x += 20) {
          const i = (y * image.width + x) * image.channels;
          colors.add(
            `${image.data[i]},${image.data[i + 1]},${image.data[i + 2]}`,
          );
        }
      assert.ok(
        colors.size >= 4,
        `Decoded PNG must produce multiple real colors, got ${colors.size}`,
      );
      await command({ type: "step", count: 2 });
      await command({ type: "restore", snapshot: first });
      await command({ type: "step", count: 1 });
      assert.deepEqual((await command({ type: "inspect" })).errors, []);
      await page.evaluate(() => {
        (globalThis as any).__imageDocument = "same";
      });
      await command({ type: "reload" });
      await command({ type: "step", count: 1 });
      assert.equal(
        await page.evaluate(() => (globalThis as any).__imageDocument),
        "same",
      );
      assert.match(await label.innerText(), /^2 x 2/);
      return {
        decodedSize: [2, 2],
        visibleColors: colors.size,
        managedCheckpoint: true,
        compatibleReload: true,
      };
    },
  },
  "third-person": {
    run: async (page, command) => {
      await command({ type: "step", count: 90 });
      const base = await command({ type: "snapshot" });
      const before = await command({ type: "inspect" });
      const position = (state: any) =>
        state.game.transforms.player.position as number[];
      await command({ type: "input", key: " ", pressed: true });
      await command({ type: "step", count: 12 });
      const airborne = await command({ type: "inspect" });
      assert.ok(
        position(airborne)[1] > position(before)[1] + 0.2,
        JSON.stringify({ before: position(before), after: position(airborne) }),
      );
      assert.match(
        await page.locator('[data-pelican-element="state"]').innerText(),
        /Jumps 1/,
      );
      await command({ type: "step", count: 90 });
      assert.match(
        await page.locator('[data-pelican-element="state"]').innerText(),
        /Jumps 1/,
      );
      await command({ type: "input", key: " ", pressed: false });
      await command({ type: "restore", snapshot: base });
      await command({ type: "step", count: 1 });
      assert.match(
        await page.locator('[data-pelican-element="state"]').innerText(),
        /Jumps 0/,
      );
      await page.locator('[data-pelican-element="save"]').click();
      await command({ type: "step", count: 1 });
      await command({ type: "input", key: "d", pressed: true });
      await command({ type: "step", count: 20 });
      await command({ type: "input", key: "d", pressed: false });
      await page.locator('[data-pelican-element="load"]').click();
      await command({ type: "step", count: 1 });
      const loaded = await command({ type: "inspect" });
      assert.ok(Math.abs(position(loaded)[0] - position(before)[0]) < 0.05);
      assert.equal(await page.locator("[data-pelican-ui]").count(), 1);
      return {
        groundedJump: true,
        heldJumpCount: 1,
        savedWorldAndInstance: true,
        before: position(before),
        airborne: position(airborne),
        camera: loaded.gameplay.camera,
      };
    },
  },
  "runtime-lifecycle": {
    run: async (page, command) => {
      const initial = await command({ type: "inspect" });
      assert.equal(initial.tick, 0);
      assert.equal(await page.locator("[data-pelican-counter]").count(), 1);
      await command({ type: "step", count: 3 });
      const after = await command({ type: "inspect" });
      assert.equal(after.tick, 3);
      assert.match(
        await page.locator("[data-pelican-counter]").innerText(),
        /3 ticks/,
      );
      const focus = await page.evaluate(() => document.hasFocus());
      await page.locator('[data-pelican-element="save"]').click();
      await command({ type: "step", count: 1 });
      const checkpoint = await page
        .locator("[data-pelican-counter]")
        .innerText();
      assert.match(checkpoint, /4 ticks/);
      await command({ type: "step", count: 3 });
      assert.match(
        await page.locator("[data-pelican-counter]").innerText(),
        /7 ticks/,
      );
      await page.locator('[data-pelican-element="load"]').click();
      await command({ type: "step", count: 1 });
      assert.equal(await page.locator("[data-pelican-counter]").count(), 1);
      assert.equal(
        await page.locator("[data-pelican-counter]").innerText(),
        checkpoint,
      );
      const restored = await command({ type: "inspect" });
      assert.deepEqual(restored.errors, []);
      await command({ type: "step", count: 1 });
      assert.match(
        await page.locator("[data-pelican-counter]").innerText(),
        /5 ticks/,
      );
      return {
        initialTick: 0,
        finalTick: after.tick,
        focus,
        nativeInputRequired: false,
        asyncRuntimeSaveLoad: true,
        ownedMarkers: 1,
      };
    },
  },
  "pointer-3d": {
    run: async (page, command) => {
      await command({ type: "step", count: 1 });
      await command({ type: "input", key: "e", pressed: true });
      await command({ type: "step", count: 1 });
      await command({ type: "input", key: "e", pressed: false });
      let state = await command({ type: "inspect" });
      assert.ok(
        state.runtime.records.some(
          (entity: { id: string }) => entity.id === "prop-0",
        ),
      );
      await page.mouse.move(400, 250);
      await page.mouse.wheel(0, 100);
      await command({ type: "step", count: 1 });
      state = await command({ type: "inspect" });
      assert.equal(state.gameplay.input.pointer.wheel[1], 100);
      const batch = await command({
        type: "batch",
        commands: [
          { type: "pointer", x: 120, y: 80, buttons: 1, delta: [2, 3] },
          { type: "step", count: 1 },
          { type: "inspect", entity: "player" },
        ],
      });
      assert.equal(batch.completed, 3);
      assert.equal(batch.results[2].data.gameplay.input.pointer.buttons, 1);
      assert.deepEqual(
        batch.results[2].data.gameplay.input.pointer.position,
        [120, 80],
      );
      await command({ type: "step", count: 300 });
      state = await command({ type: "inspect" });
      assert.ok(
        !state.runtime.records.some(
          (entity: { id: string }) => entity.id === "prop-0",
        ),
      );
      const saved = await command({ type: "snapshot" });
      await command({ type: "step", count: 3 });
      await command({ type: "restore", snapshot: saved });
      return {
        tick: state.tick,
        adapter: state.adapter,
        backend: state.backend,
      };
    },
  },
  "external-adapters": {
    run: async (page, command) => {
      const label = page.locator('[data-pelican-element="state"]');
      const until = async (count: number) => {
        for (let i = 0; i < 100; i++) {
          await command({ type: "step", count: 1 });
          if ((await label.innerText()).endsWith(`| ${count}`)) return;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        throw new Error(`Worker palette did not reach ${count} messages`);
      };
      await until(1);
      const before = decode(
        await page.locator("canvas:visible").first().screenshot(),
      );
      const saved = await command({ type: "snapshot" });
      await page.locator('[data-pelican-element="refresh"]').click();
      await until(2);
      const after = decode(
        await page.locator("canvas:visible").first().screenshot(),
      );
      assert.equal(before.width, after.width);
      assert.equal(before.height, after.height);
      assert.equal(before.channels, after.channels);
      let changed = 0;
      for (let i = 0; i < before.data.length; i++)
        if (before.data[i] !== after.data[i]) changed++;
      assert.ok(
        changed > 64,
        `Worker data must visibly update the managed material buffer, changed=${changed}`,
      );
      await command({ type: "restore", snapshot: saved });
      await command({ type: "step", count: 1 });
      assert.match(await label.innerText(), /\| 1$/);
      const state = await command({ type: "inspect" });
      assert.deepEqual(state.errors, []);
      return {
        changedChannels: changed,
        restored: true,
        backend: state.backend,
        moduleWorker: true,
      };
    },
  },
  "dynamic-resources": {
    run: async (_page, command) => {
      await command({ type: "step", count: 2 });
      const saved = await command({ type: "snapshot" });
      await command({ type: "step", count: 2 });
      await command({ type: "restore", snapshot: saved });
      const state = await command({ type: "inspect" });
      assert.deepEqual(state.errors, []);
      assert.ok(state.rendering.bufferBindings);
      return {
        validatedData: true,
        checkpoint: true,
        bufferBindings: state.rendering.bufferBindings,
      };
    },
  },
  "managed-rendering": {
    run: async (page, command) => {
      const saved = await command({ type: "snapshot" });
      await command({ type: "step", count: 10 });
      const state = await command({ type: "inspect" });
      assert.equal(state.triangleCount, 2);
      assert.ok(state.rendering.postProcesses);
      const image = decode(
        await page.locator("canvas:visible").first().screenshot(),
      );
      let lit = 0;
      for (let i = 0; i < image.data.length; i += image.channels)
        if (
          Number(image.data[i]) +
            Number(image.data[i + 1]) +
            Number(image.data[i + 2]) >
          100
        )
          lit++;
      assert.ok(lit > 64);
      await command({ type: "restore", snapshot: saved });
      return {
        indexedTriangles: 2,
        visiblePixels: lit,
        managedPostprocess: true,
      };
    },
  },
  "dynamic-ui": {
    run: async (page, command) => {
      await page.setViewportSize({ width: 390, height: 844 });
      await command({ type: "step", count: 1 });
      const add = page.locator('[data-pelican-element="add"]');
      for (let i = 0; i < 3; i++) {
        await add.click();
        await command({ type: "step", count: 1 });
      }
      assert.match(
        await page.locator('[data-pelican-element="hint"]').innerText(),
        /Items: 3/,
      );
      const saved = await command({ type: "snapshot" });
      await page.locator('[data-pelican-element="item:0"]').click();
      await command({ type: "step", count: 1 });
      assert.match(
        await page.locator('[data-pelican-element="hint"]').innerText(),
        /Items: 2/,
      );
      await command({ type: "restore", snapshot: saved });
      await command({ type: "step", count: 1 });
      assert.match(
        await page.locator('[data-pelican-element="hint"]').innerText(),
        /Items: 3/,
      );
      const box = await add.boundingBox();
      assert.ok(box && box.x >= 0 && box.x + box.width <= 390);
      return {
        narrowScreen: true,
        continuousInteraction: true,
        restoredSlots: 3,
      };
    },
  },
  "startup-feedback": {
    run: async (page, command) => {
      assert.equal(
        await page.locator("[data-pelican-startup-feedback]").count(),
        0,
      );
      await command({ type: "reload", restart: true });
      await command({ type: "step", count: 1 });
      assert.equal(
        await page.locator("[data-pelican-startup-feedback]").count(),
        0,
      );
      return {
        readyObserverRemoved: true,
        restarted: true,
        scope:
          "Successful startup and observer cleanup. Network-delay/failure coverage is separate.",
      };
    },
  },
  "model-animation": {
    run: async (page, command) => {
      const before = await page.locator("canvas:visible").first().screenshot();
      const saved = await command({ type: "snapshot" });
      await command({ type: "step", count: 30 });
      const after = await page.locator("canvas:visible").first().screenshot();
      assert.notDeepEqual(before, after);
      const state = await command({ type: "inspect" });
      assert.ok(state.gameplay.models.playing > 0);
      await command({ type: "restore", snapshot: saved });
      return {
        animatedPixels: true,
        models: state.gameplay.models,
        checkpoint: true,
      };
    },
  },
  "audio-interaction": {
    run: async (page, command) => {
      const initial = await command({ type: "inspect" });
      assert.equal(initial.gameplay.decodedSounds, 1);
      await page.locator('[data-pelican-element="play"]').click();
      await command({ type: "step", count: 1 });
      const active = await command({ type: "inspect" });
      assert.equal(active.gameplay.audioDevice, "running");
      assert.match(
        await page.locator('[data-pelican-element="status"]').innerText(),
        /Playing/,
      );
      const saved = await command({ type: "snapshot" });
      await page.locator('[data-pelican-element="stop"]').click();
      await command({ type: "step", count: 1 });
      assert.equal(
        await page.locator('[data-pelican-element="status"]').innerText(),
        "Stopped",
      );
      await command({ type: "restore", snapshot: saved });
      await command({ type: "step", count: 1 });
      assert.match(
        await page.locator('[data-pelican-element="status"]').innerText(),
        /Playing/,
      );
      return {
        realDomUnlock: true,
        audioDevice: active.gameplay.audioDevice,
        decodedSounds: 1,
        logicalSaveRestore: true,
        audibility: "Not measured by a microphone",
      };
    },
  },
};
export function recipeAcceptance(id: string) {
  return acceptance[id];
}
