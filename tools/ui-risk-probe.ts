import assert from "node:assert/strict";
import path from "node:path";
import { writeFile, mkdir } from "node:fs/promises";
import { createServer } from "vite";
import { chromium } from "playwright";
import { compileProject } from "../packages/compiler/src/index.ts";
import {
  automationLaunchOptions,
  waitForEngine,
  withAutomationDeadline,
} from "./browser-session.ts";

/** M0-08/M2 prototype: browser-native composition, virtual standard-pad focus, real world UI projection/hit/occlusion. */
export async function runUIRisk(root: string, output: string) {
  const project = path.join(root, "examples/ui-risk");
  await mkdir(output, { recursive: true });
  const compile = await compileProject({
    projectRoot: project,
    outDir: path.join(project, ".pelican/public/generated"),
    engineRoot: root,
  });
  assert.equal(compile.success, true, JSON.stringify(compile.diagnostics));
  const server = await createServer({
    root,
    configFile: path.join(root, "vite.config.ts"),
    publicDir: path.join(project, ".pelican/public"),
    logLevel: "silent",
    server: { port: 0, host: "127.0.0.1", strictPort: true },
  });
  await server.listen();
  const browser = await chromium.launch(automationLaunchOptions());
  try {
    return await withAutomationDeadline(
      async () => {
        const page = await browser.newPage({
            viewport: { width: 1280, height: 720 },
          }),
          errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        page.on("console", (message) => {
          if (message.type() === "error") errors.push(message.text());
        });
        await page.addInitScript({
          content:
            'window.__uiInputTrace=[];for(const type of ["compositionstart","compositionupdate","compositionend","beforeinput","input","keydown"]){document.addEventListener(type,e=>{if(e.target?.dataset?.pelicanElement==="name")window.__uiInputTrace.push({type,data:e.data??null,inputType:e.inputType??null,isComposing:e.isComposing??null,value:e.target.value,key:e.key??null});},true);}window.__padButtons=Array(17).fill(false);Object.defineProperty(navigator,"getGamepads",{configurable:true,value:()=>[{id:"pelican virtual standard controller",index:0,connected:true,mapping:"standard",timestamp:performance.now(),axes:[0,0,0,0],buttons:window.__padButtons.map(pressed=>({pressed,touched:pressed,value:pressed?1:0}))}]});',
        });
        const url = new URL(server.resolvedUrls!.local[0]);
        url.searchParams.set("automation", "1");
        url.searchParams.set("width", "1280");
        url.searchParams.set("height", "720");
        await page.goto(url.href, { waitUntil: "domcontentloaded" });
        await waitForEngine(page);
        const command = async (value: unknown) => {
          const result = await page.evaluate(
            async (value) => (window as any).__pelican.command(value),
            value,
          );
          assert.equal(result.status, "succeeded", JSON.stringify(result));
          return result.data;
        };
        const step = (count = 1) => command({ type: "step", count });
        const tap = async (key: string) => {
          await command({ type: "input", key, pressed: true });
          await command({ type: "input", key, pressed: false });
          return step();
        };
        const state = () =>
          page.evaluate(() => (window as any).__pelican.inspect());
        const initial = await state();
        assert.equal(initial.backend, "WebGPUBackend");
        assert.equal(initial.adapter.isFallbackAdapter, false);
        const input = page.locator('[data-pelican-element="name"]'),
          world = page.locator('[data-pelican-element="world-control"]');
        assert.equal(await world.isVisible(), false);
        await page.screenshot({
          path: path.join(output, "ui-world-occluded.png"),
        });
        await input.click();
        await step(2);
        const keyEventsBeforeTyping = (await state()).game.components.control
          .UiProbe.gameKeyEvents;
        const cdp = await page.context().newCDPSession(page);
        await cdp.send("Input.imeSetComposition", {
          text: "你",
          selectionStart: 1,
          selectionEnd: 1,
        });
        await step(2);
        assert.equal((await state()).game.components.control.UiProbe.text, "");
        await cdp.send("Input.imeSetComposition", {
          text: "你好",
          selectionStart: 2,
          selectionEnd: 2,
        });
        await step(2);
        assert.equal(await input.inputValue(), "你好");
        await page.screenshot({
          path: path.join(output, "ui-composition.png"),
        });
        await cdp.send("Input.insertText", { text: "你好" });
        await step(2);
        assert.equal(
          (await state()).game.components.control.UiProbe.text,
          "你好",
        );
        await input.evaluate((element) =>
          (element as HTMLInputElement).setSelectionRange(0, 1),
        );
        const selection = await input.evaluate((element) => ({
          start: (element as HTMLInputElement).selectionStart,
          end: (element as HTMLInputElement).selectionEnd,
        }));
        assert.deepEqual(selection, { start: 0, end: 1 });
        await step(2);
        assert.deepEqual(
          await input.evaluate((element) => ({
            start: (element as HTMLInputElement).selectionStart,
            end: (element as HTMLInputElement).selectionEnd,
          })),
          selection,
        );
        await page.keyboard.press("End");
        await page.keyboard.type("w");
        await step(2);
        const typed = await state();
        assert.equal(typed.game.components.control.UiProbe.text, "你好w");
        assert.equal(typed.game.components.control.UiProbe.gameMoves, 0);
        assert.equal(
          typed.game.components.control.UiProbe.gameKeyEvents,
          keyEventsBeforeTyping,
        );
        await page.keyboard.press("Enter");
        await step(2);
        assert.equal(
          (await state()).game.components.control.UiProbe.submitted,
          1,
        );
        const button = async (index: number, pressed: boolean) => {
          await page.evaluate(
            ({ index, pressed }) =>
              ((window as any).__padButtons[index] = pressed),
            { index, pressed },
          );
          return step();
        };
        const focus: string[] = [];
        await button(13, true);
        focus.push(
          await page.evaluate(
            () =>
              document.activeElement?.getAttribute("data-pelican-element") ??
              "",
          ),
        );
        await button(13, false);
        await button(13, true);
        focus.push(
          await page.evaluate(
            () =>
              document.activeElement?.getAttribute("data-pelican-element") ??
              "",
          ),
        );
        await button(13, false);
        assert.deepEqual(focus, ["one", "two"]);
        await button(0, true);
        await button(0, false);
        await step();
        assert.equal(
          (await state()).game.components.control.UiProbe.buttons,
          1,
        );
        await page
          .locator('[data-pelican-element="title"]')
          .click({ force: true });
        await tap("v");
        assert.equal(await world.isVisible(), true);
        const before = await world.boundingBox();
        assert.ok(before);
        const hit = await page.evaluate(
          ({ x, y }) =>
            document
              .elementFromPoint(x, y)
              ?.getAttribute("data-pelican-element"),
          { x: before.x + before.width / 2, y: before.y + before.height / 2 },
        );
        assert.equal(hit, "world-control");
        await world.click();
        await step(2);
        assert.equal(
          (await state()).game.components.control.UiProbe.worldClicks,
          1,
        );
        await command({ type: "input", key: "w", pressed: true });
        await step(30);
        await command({ type: "input", key: "w", pressed: false });
        await step();
        const after = await world.boundingBox();
        assert.ok(after);
        assert.ok(after.x > before.x + 10);
        await page.screenshot({
          path: path.join(output, "ui-focus-world.png"),
        });
        const final = await state();
        assert.ok(final.game.components.control.UiProbe.gameMoves > 0);
        const trace = await page.evaluate(() => (window as any).__uiInputTrace);
        assert.ok(
          trace.some((event: any) => event.type === "compositionstart"),
        );
        assert.ok(trace.some((event: any) => event.type === "compositionend"));
        assert.ok(trace.some((event: any) => event.type === "input"));
        assert.deepEqual(errors, []);
        const report = {
          passed: true,
          backend: initial.backend,
          adapter: initial.adapter,
          composition: {
            source: "Chromium CDP native text-composition input path",
            trace,
            selection,
            committed: typed.game.components.control.UiProbe.text,
          },
          gamepad: {
            source: "injected standard Gamepad API samples",
            physicalControllerTested: false,
            focus,
          },
          worldUI: {
            initiallyOccluded: true,
            hit,
            before,
            after,
            clicks: final.game.components.control.UiProbe.worldClicks,
          },
          initial,
          final,
          errors,
          limitations: [
            "M2 risk prototype, not the complete M6 UI/layout/accessibility/gamepad system.",
            "Composition uses the browser text input path; operating-system IME candidate-window UI and a physical controller were not available for this test.",
          ],
        };
        await writeFile(
          path.join(output, "ui-prototype.json"),
          JSON.stringify(report, null, 2) + "\n",
        );
        return report;
      },
      90000,
      "UI risk prototype browser input and world interaction",
    );
  } finally {
    await browser.close();
    await server.close();
  }
}
