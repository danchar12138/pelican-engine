import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import test from "node:test";
import { chromium, type Page } from "playwright";
import ts from "typescript";
import type {
  UiElement,
  UiPosition,
  UIRenderer,
} from "../packages/renderer/src/ui.ts";

type Fixture = {
  ui: UIRenderer;
  definitions: UiElement[];
  positions: Map<string, UiPosition>;
  events: { type: string; payload: unknown }[];
  inputs: { key: string; pressed: boolean }[];
  keyboard: { key: string; consumed: boolean; prevented: boolean }[];
  pads: (Gamepad | null)[];
  polls: number;
  present(): void;
  listenerCount(): number;
};
declare global {
  interface Window {
    uiTest: Fixture;
  }
}
const definition = (
  id: string,
  kind: UiElement["kind"],
  x: number,
  y: number,
): UiElement => ({
  id,
  kind,
  text: kind === "input" ? "初始文本" : id,
  value: 0.6,
  visible: true,
  anchor: "top-left",
  x,
  y,
  width: kind === "input" ? 240 : 130,
  color: "#ffffff",
});
const definitions: UiElement[] = [
  definition("title", "text", 20, 10),
  definition("play", "button", 20, 80),
  definition("name", "input", 20, 140),
  { ...definition("hidden", "button", 20, 210), visible: false },
  {
    ...definition("world", "button", 99, 99),
    world: { entity: "npc", offset: [0, 2, 0], occlude: true },
  },
  definition("last", "button", 20, 260),
  { ...definition("health", "bar", 16, 16), anchor: "bottom-left" },
  { ...definition("topRight", "text", 18, 22), anchor: "top-right" },
  { ...definition("bottomRight", "text", 24, 28), anchor: "bottom-right" },
  { ...definition("center", "text", 99, 99), anchor: "center" },
];
const html = `<!doctype html><meta charset="utf-8"><style>body{margin:0;overflow:hidden}canvas{position:absolute;inset:0;width:100%;height:100%}</style>
<canvas></canvas><script type="module">
import {createUIRenderer} from '/ui.js';
const registered = new Map();
const add = EventTarget.prototype.addEventListener, remove = EventTarget.prototype.removeEventListener;
EventTarget.prototype.addEventListener = function(type, listener, options) {
  if (this instanceof HTMLElement && this.hasAttribute('data-pelican-ui')) {
    if (!registered.has(type)) registered.set(type, new Set());
    registered.get(type).add(listener);
  }
  return add.call(this, type, listener, options);
};
EventTarget.prototype.removeEventListener = function(type, listener, options) {
  if (this instanceof HTMLElement && this.hasAttribute('data-pelican-ui')) registered.get(type)?.delete(listener);
  return remove.call(this, type, listener, options);
};
const f = window.uiTest = {
  definitions: ${JSON.stringify(definitions)}, positions: new Map(), events: [], inputs: [], keyboard: [], pads: [], polls: 0,
  present() { this.ui.present(this.definitions, this.positions); },
  listenerCount() { return [...registered.values()].reduce((n, set) => n + set.size, 0); },
};
f.ui = createUIRenderer(f.definitions, {
  input: (key, pressed) => f.inputs.push({key, pressed}), emit: (type, payload) => f.events.push({type, payload}),
});
for (const type of ['keydown', 'keyup']) window.addEventListener(type, event => f.keyboard.push({key:event.key, consumed:f.ui.consumesKeyboard(event), prevented:event.defaultPrevented}));
document.querySelector('canvas').addEventListener('click', () => {
  const canvas = document.querySelector('canvas'); canvas.dataset.clicks = String(Number(canvas.dataset.clicks || 0) + 1);
});
// Startup and present must not depend on RAF, focus or a user gesture.
window.requestAnimationFrame = () => 0;
f.ui.mount();
</script>`;
const state = (page: Page) => page.evaluate(() => window.uiTest.ui.inspect());
const events = (page: Page) =>
  page.evaluate(() =>
    window.uiTest.events.filter((entry) => entry.type !== "ui.focus"),
  );
const inputSelector = '[data-pelican-element="name"]';
const buttonSelector = '[data-pelican-element="play"]';
async function sample(
  page: Page,
  buttons: number[] = [],
  axes: number[] = [0, 0],
  mapping = "standard",
) {
  return page.evaluate(
    ({ buttons, axes, mapping }) => {
      const f = window.uiTest;
      Object.defineProperty(navigator, "getGamepads", {
        configurable: true,
        value: [
          () => {
            f.polls++;
            return f.pads;
          },
        ][0],
      });
      f.pads = [
        {
          index: 0,
          id: "VIRTUAL STANDARD TEST INPUT",
          connected: true,
          mapping,
          axes,
          buttons: Array.from({ length: 17 }, (_, index) => ({
            pressed: buttons.includes(index),
            touched: buttons.includes(index),
            value: buttons.includes(index) ? 1 : 0,
          })),
        } as unknown as Gamepad,
      ];
      f.present();
      return f.ui.inspect();
    },
    { buttons, axes, mapping },
  );
}

test(
  "M0-08/M2 UI: real Chromium DOM/native IME/clipboard; virtual standard gamepad",
  { timeout: 120_000 },
  async (t) => {
    const source = await readFile(
      new URL("../packages/renderer/src/ui.ts", import.meta.url),
      "utf8",
    );
    const javascript = ts.transpileModule(source, {
      compilerOptions: {
        target: ts.ScriptTarget.ES2023,
        module: ts.ModuleKind.ESNext,
      },
    }).outputText;
    const inputModule = ts.transpileModule(await readFile(new URL("../packages/schema/src/ui-input.ts", import.meta.url), "utf8"), {
      compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext },
    }).outputText;
    const server = createServer((request, response) => {
      response.setHeader(
        "Content-Type",
        request.url === "/ui.js" || request.url?.endsWith("/schema/src/ui-input.ts")
          ? "text/javascript; charset=utf-8"
          : "text/html; charset=utf-8",
      );
      response.end(request.url === "/ui.js" ? javascript : request.url?.endsWith("/schema/src/ui-input.ts") ? inputModule : html);
    });
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
    const abort = () => {
      void browser?.close();
      server.closeAllConnections();
      server.close();
    };
    t.signal.addEventListener("abort", abort, { once: true });
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      browser = await chromium.launch({ headless: true, timeout: 15_000 });
      t.diagnostic(
        `Chromium ${browser.version()}; native DOM/IME only; virtual gamepad; no camera/GPU evidence`,
      );
      const origin = `http://127.0.0.1:${address.port}`;
      async function check(name: string, run: (page: Page) => Promise<void>) {
        await t.test(name, { timeout: 20_000 }, async () => {
          const context = await browser!.newContext({
            viewport: { width: 900, height: 650 },
            permissions: ["clipboard-read", "clipboard-write"],
          });
          const page = await context.newPage();
          page.setDefaultTimeout(5_000);
          page.setDefaultNavigationTimeout(5_000);
          const errors: string[] = [];
          page.on("pageerror", (error) => errors.push(error.message));
          try {
            await page.goto(origin, { waitUntil: "load" });
            await page.waitForFunction(() => !!window.uiTest?.ui, undefined, {
              polling: 25,
            });
            await run(page);
            assert.deepEqual(errors, []);
          } finally {
            await context.close();
          }
        });
      }
      await check(
        "mount without click/focus/RAF; screen style and selectors",
        async (page) => {
          assert.equal((await state(page)).focus, null);
          await page.evaluate(() => window.uiTest.ui.mount());
          assert.equal(await page.locator("[data-pelican-ui]").count(), 1);
          assert.deepEqual(
            await page.locator(inputSelector).evaluate((node) => ({
              tag: node.tagName,
              autofocus: (node as HTMLInputElement).autofocus,
            })),
            { tag: "INPUT", autofocus: false },
          );
          const layout = await page.evaluate(() => {
            const right = document.querySelector<HTMLElement>(
              '[data-pelican-element="topRight"]',
            )!;
            const bottom = document.querySelector<HTMLElement>(
              '[data-pelican-element="bottomRight"]',
            )!;
            const center = document
              .querySelector<HTMLElement>('[data-pelican-element="center"]')!
              .getBoundingClientRect();
            return {
              right: right.style.right,
              top: right.style.top,
              bottom: bottom.style.bottom,
              bottomRight: bottom.style.right,
              centerX: center.x + center.width / 2,
              centerY: center.y + center.height / 2,
              padding: document.querySelector<HTMLElement>(
                '[data-pelican-element="play"]',
              )!.style.padding,
              bar: document.querySelector<HTMLProgressElement>(
                '[data-pelican-element="health"]',
              )!.value,
            };
          });
          assert.deepEqual(layout, {
            right: "18px",
            top: "22px",
            bottom: "28px",
            bottomRight: "24px",
              centerX: 549,
              centerY: 424,
            padding: "8px 12px",
            bar: 0.6,
          });
          await page.mouse.click(750, 450);
          assert.equal(
            await page.locator("canvas").getAttribute("data-clicks"),
            "1",
          );
          assert.deepEqual(await events(page), []);
        },
      );
      await check(
        "native CDP Chinese composition/repaint/pad exclusion and pending commit echo",
        async (page) => {
          await page.locator(inputSelector).click();
          await page
            .locator(inputSelector)
            .evaluate((node: HTMLInputElement) => node.select());
          const cdp = await page.context().newCDPSession(page);
          try {
            await cdp.send("Input.imeSetComposition", {
              text: "你",
              selectionStart: 1,
              selectionEnd: 1,
            });
            await cdp.send("Input.imeSetComposition", {
              text: "你好",
              selectionStart: 2,
              selectionEnd: 2,
            });
            const composing = await state(page);
            assert.equal(composing.composing, true);
            assert.equal(composing.inputValue, "你好");
            assert.ok(
              composing.trace.some(
                (entry) => entry.type === "compositionstart" && entry.trusted,
              ),
            );
            assert.ok(
              composing.trace.some(
                (entry) =>
                  entry.type === "input" && entry.composing && entry.trusted,
              ),
            );
            assert.deepEqual(await events(page), []);
            await page.evaluate(() => {
              const f = window.uiTest;
              for (let i = 0; i < 12; i++) f.present();
              f.definitions.find((element) => element.id === "name")!.text =
                "旧tick远端文本";
              f.present();
            });
            assert.equal((await sample(page, [13, 0])).focus, "name");
            assert.deepEqual(
              (await state(page)).selection,
              composing.selection,
            );
            assert.equal((await state(page)).inputValue, "你好");
            await page.keyboard.press("Enter");
            assert.deepEqual(await events(page), []);
            await cdp.send("Input.insertText", { text: "你好" });
            assert.equal((await state(page)).composing, false);
            assert.equal((await state(page)).inputValue, "你好");
            assert.deepEqual(await events(page), [
              {
                type: "ui.text",
                payload: { id: "name", text: "你好", composing: false },
              },
            ]);
            assert.equal(
              (await sample(page, [13, 0])).focus,
              "name",
              "held pad cannot replay an edge consumed during composition",
            );
            await page
              .locator(inputSelector)
              .evaluate((node: HTMLInputElement) =>
                node.setSelectionRange(0, 1, "backward"),
              );
            await page.evaluate(() => {
              for (let i = 0; i < 12; i++) window.uiTest.present();
            });
            const waiting = await state(page);
            assert.equal(waiting.inputValue, "你好");
            assert.deepEqual(waiting.selection, {
              start: 0,
              end: 1,
              direction: "backward",
            });
            assert.equal(
              waiting.elements.find((element) => element.id === "name")!
                .pendingCommit,
              "你好",
            );
            await page.evaluate(() => {
              const f = window.uiTest;
              f.definitions.find((element) => element.id === "name")!.text =
                "你好";
              f.present();
            });
            assert.equal(
              (await state(page)).elements.find(
                (element) => element.id === "name",
              )!.pendingCommit,
              null,
            );
            assert.deepEqual((await state(page)).selection, waiting.selection);
            await page.evaluate(() => {
              const f = window.uiTest;
              f.definitions.find((element) => element.id === "name")!.text =
                "你好回显";
              f.present();
            });
            assert.equal((await state(page)).inputValue, "你好回显");
            assert.deepEqual((await state(page)).selection, waiting.selection);
          } finally {
            await cdp.detach();
          }
        },
      );
      await check(
        "native clipboard Chinese/emoji selection replacement and default text keys",
        async (page) => {
          await page.locator(inputSelector).click();
          await page
            .locator(inputSelector)
            .evaluate((node: HTMLInputElement) =>
              node.setSelectionRange(1, 3, "backward"),
            );
          assert.deepEqual((await state(page)).selection, {
            start: 1,
            end: 3,
            direction: "backward",
          });
          await page.evaluate(() =>
            navigator.clipboard.writeText("粘贴🙂中文"),
          );
          await page.keyboard.press("Control+V");
          const pasted = await state(page);
          assert.equal(pasted.inputValue, "初粘贴🙂中文本");
          assert.ok(
            pasted.trace.some(
              (entry) => entry.type === "paste" && entry.trusted,
            ),
          );
          assert.ok(
            pasted.trace.some(
              (entry) =>
                entry.type === "input" &&
                entry.inputType === "insertFromPaste" &&
                entry.trusted,
            ),
          );
          await page.evaluate(() => window.uiTest.present());
          assert.equal((await state(page)).inputValue, pasted.inputValue);
          assert.deepEqual((await state(page)).selection, pasted.selection);
          await page.keyboard.press("ArrowLeft");
          assert.equal(
            (await state(page)).selection!.start,
            pasted.selection!.start - 1,
          );
          assert.ok(
            (await page.evaluate(() => window.uiTest.keyboard)).every(
              (entry) => entry.consumed && !entry.prevented,
            ),
          );
        },
      );
      await check(
        "older commit echoes cannot roll back newer edits; blur allows state writeback",
        async (page) => {
          await page.locator(inputSelector).click();
          await page
            .locator(inputSelector)
            .evaluate((node: HTMLInputElement) => node.select());
          await page.keyboard.insertText("甲");
          await page.keyboard.insertText("乙");
          await page.evaluate(() => {
            const f = window.uiTest;
            f.definitions.find((element) => element.id === "name")!.text = "甲";
            f.present();
          });
          assert.equal((await state(page)).inputValue, "甲乙");
          await page.locator(buttonSelector).click();
          await page.evaluate(() => window.uiTest.present());
          const input = (await state(page)).elements.find(
            (element) => element.id === "name",
          )!;
          assert.equal(input.inputValue, "甲");
          assert.equal(input.pendingCommit, null);
        },
      );
      await check(
        "Enter submits input only; native click/Enter/Space activate buttons; focus changes emit once",
        async (page) => {
          await page.locator(inputSelector).click();
          await page.evaluate(() => {
            for (let i = 0; i < 10; i++) window.uiTest.present();
          });
          assert.deepEqual(await page.evaluate(() => window.uiTest.events), [
            { type: "ui.focus", payload: { id: "name" } },
          ]);
          await page.keyboard.down("Enter");
          await page.keyboard.down("Enter");
          await page.keyboard.up("Enter");
          assert.deepEqual(await events(page), [
            { type: "ui.submit", payload: { id: "name", text: "初始文本" } },
          ]);
          assert.deepEqual(await page.evaluate(() => window.uiTest.inputs), []);
          assert.ok(
            (await page.evaluate(() => window.uiTest.keyboard)).every(
              (entry) => entry.consumed,
            ),
          );
          await page.locator(buttonSelector).click();
          await page.keyboard.press("Enter");
          await page.keyboard.press("Space");
          assert.deepEqual(
            await page.evaluate(() => window.uiTest.inputs),
            Array.from({ length: 3 }, () => [
              { key: "ui:play", pressed: true },
              { key: "ui:play", pressed: false },
            ]).flat(),
          );
          assert.equal(
            (await events(page)).filter((entry) => entry.type === "ui.activate")
              .length,
            3,
          );
          assert.deepEqual(
            await page.evaluate(() =>
              window.uiTest.events.filter((entry) => entry.type === "ui.focus"),
            ),
            [
              { type: "ui.focus", payload: { id: "name" } },
              { type: "ui.focus", payload: { id: null } },
              { type: "ui.focus", payload: { id: "play" } },
            ],
          );
          assert.equal(
            await page.evaluate(() =>
              window.uiTest.ui.consumesKeyboard(
                new KeyboardEvent("keydown", { isComposing: true }),
              ),
            ),
            true,
          );
          assert.equal(
            await page.evaluate(() =>
              window.uiTest.ui.consumesKeyboard(
                new KeyboardEvent("keydown", { key: "w" }),
              ),
            ),
            false,
          );
        },
      );
      await check(
        "world pixels/visibility/occlusion enforce real elementFromPoint, click and focus exclusion",
        async (page) => {
          await page.evaluate(() => {
            window.uiTest.positions.set("world", {
              x: 420,
              y: 180,
              visible: true,
              occluded: false,
            });
            window.uiTest.present();
          });
          const world = page.locator('[data-pelican-element="world"]');
          assert.deepEqual(
            await world.evaluate((node) => {
              const r = node.getBoundingClientRect();
              return { x: r.x, y: r.y };
            }),
            { x: 519, y: 279 },
          );
          await page.evaluate(() => {
            const f = window.uiTest;
            const first = f.definitions.find(
              (element) => element.id === "world",
            )!;
            f.definitions.push({
              ...first,
              id: "worldSecond",
              world: { entity: "npc", offset: [0, 3, 0], occlude: true },
            });
            f.positions.set("worldSecond", {
              x: 600,
              y: 180,
              visible: true,
              occluded: false,
            });
            f.present();
          });
          assert.equal(
            await page
              .locator('[data-pelican-element="worldSecond"]')
              .evaluate((node) => node.getBoundingClientRect().x),
            699,
          );
          await page.mouse.click(539, 294);
          assert.equal((await state(page)).focus, "world");
          assert.equal(
            await page.evaluate(() => window.uiTest.inputs.length),
            2,
          );
          for (const mode of [
            "occluded",
            "invisible",
            "missing",
            "nonfinite",
          ] as const) {
            await page.evaluate((mode) => {
              const f = window.uiTest;
              f.positions.set("world", {
                x: mode === "nonfinite" ? NaN : 420,
                y: 180,
                visible: mode !== "invisible",
                occluded: mode === "occluded",
              });
              if (mode === "missing") f.positions.clear();
              f.present();
            }, mode);
            assert.equal((await state(page)).focus, null);
            assert.deepEqual(
              await world.evaluate((node: HTMLButtonElement) => {
                node.focus();
                node.click();
                node.dispatchEvent(new MouseEvent("click", { bubbles: true }));
                return {
                  display: getComputedStyle(node).display,
                  disabled: node.disabled,
                  tabIndex: node.tabIndex,
                  focused: document.activeElement === node,
                  hit:
                    document
                      .elementFromPoint(539, 294)
                      ?.getAttribute("data-pelican-element") ?? null,
                };
              }),
              {
                display: "none",
                disabled: true,
                tabIndex: -1,
                focused: false,
                hit: null,
              },
            );
            await page.mouse.click(539, 294);
            assert.equal(
              await page.evaluate(() => window.uiTest.inputs.length),
              2,
            );
          }
          assert.equal(
            await page.locator("canvas").getAttribute("data-clicks"),
            "4",
          );
          await page.evaluate(() => {
            const f = window.uiTest;
            f.definitions.find(
              (element) => element.id === "world",
            )!.world!.occlude = false;
            f.positions.set("world", {
              x: 420,
              y: 180,
              visible: true,
              occluded: true,
            });
            f.present();
          });
          assert.equal(await world.isVisible(), true);
          await page.evaluate(() => {
            window.uiTest.definitions.find(
              (element) => element.id === "world",
            )!.kind = "input";
            window.uiTest.present();
          });
          await world.click();
          const cdp = await page.context().newCDPSession(page);
          try {
            await cdp.send("Input.imeSetComposition", {
              text: "世",
              selectionStart: 1,
              selectionEnd: 1,
            });
            assert.equal((await state(page)).composing, true);
          } finally {
            await cdp.detach();
          }
          await page.evaluate(() => {
            window.uiTest.positions.clear();
            window.uiTest.present();
          });
          assert.equal((await state(page)).focus, null);
          assert.equal((await state(page)).composing, false);
          assert.equal(
            (await events(page)).filter((entry) => entry.type === "ui.text")
              .length,
            0,
          );
          assert.equal(await world.isDisabled(), true);
        },
      );
      await check(
        "virtual standard gamepad dpad/axes/A edges, stable order and hidden exclusions",
        async (page) => {
          assert.equal((await sample(page)).focus, null);
          assert.deepEqual((await state(page)).gamepad, {
            source: "virtual",
            hardwareVerified: false,
            index: 0,
            connected: 1,
          });
          assert.equal((await sample(page, [13])).focus, "play");
          assert.equal((await sample(page, [13])).focus, "play");
          await sample(page);
          assert.equal((await sample(page, [15])).focus, "name");
          await sample(page);
          await sample(page, [0]);
          assert.deepEqual(await events(page), []);
          await sample(page);
          assert.equal((await sample(page, [], [0, 1])).focus, "last");
          await sample(page);
          assert.equal((await sample(page, [12])).focus, "name");
          await sample(page);
          assert.equal((await sample(page, [14])).focus, "play");
          await sample(page);
          await sample(page, [0]);
          await sample(page, [0]);
          assert.deepEqual(await page.evaluate(() => window.uiTest.inputs), [
            { key: "ui:play", pressed: true },
            { key: "ui:play", pressed: false },
          ]);
          await sample(page);
          assert.equal((await sample(page, [], [-1, 0])).focus, "last");
          await sample(page);
          assert.equal((await sample(page, [], [1, 0])).focus, "play");
          await sample(page);
          assert.equal((await sample(page, [13])).focus, "name");
          await page.evaluate(() =>
            window.uiTest.positions.set("world", {
              x: 420,
              y: 180,
              visible: true,
              occluded: false,
            }),
          );
          await sample(page);
          assert.equal((await sample(page, [13])).focus, "world");
          await page.evaluate(() => {
            window.uiTest.positions.clear();
            window.uiTest.present();
          });
          assert.equal((await state(page)).focus, null);
          assert.equal((await sample(page, [13])).focus, null);
          await sample(page);
          assert.equal((await sample(page, [13])).focus, "play");
          await sample(page, [], [0, 0], "");
          assert.equal((await state(page)).gamepad.source, "none");
          const polls = await page.evaluate(() => window.uiTest.polls);
          await state(page);
          assert.equal(await page.evaluate(() => window.uiTest.polls), polls);
        },
      );
      await check(
        "inspect detached pure JSON and newest 128 native event traces",
        async (page) => {
          await page.locator(inputSelector).click();
          await page.keyboard.type("a".repeat(150));
          const inspected = await state(page);
          assert.equal(inspected.trace.length, 128);
          assert.ok(inspected.trace[0].sequence > 1);
          assert.ok(
            inspected.trace.every(
              (entry, index, array) =>
                index === 0 || entry.sequence === array[index - 1].sequence + 1,
            ),
          );
          assert.deepEqual(JSON.parse(JSON.stringify(inspected)), inspected);
          assert.ok(
            inspected.trace.some(
              (entry) => entry.type === "input" && entry.trusted,
            ),
          );
          const detached = await page.evaluate(() => {
            const f = window.uiTest,
              value = f.ui.inspect();
            value.trace[0].type = "MUTATED";
            if (value.trace[0].selection) value.trace[0].selection.start = -999;
            value.elements[0].id = "MUTATED";
            return f.ui.inspect();
          });
          assert.notEqual(detached.trace[0].type, "MUTATED");
          assert.notEqual(detached.elements[0].id, "MUTATED");
          assert.notEqual(detached.trace[0].selection?.start, -999);
        },
      );
      await check(
        "remove/dispose release focus and all handlers, including retained detached nodes",
        async (page) => {
          await page.locator(inputSelector).click();
          await page.evaluate(() => {
            const f = window.uiTest;
            f.definitions = f.definitions.filter(
              (element) => element.id !== "name",
            );
            f.present();
          });
          assert.equal((await state(page)).focus, null);
          assert.equal(await page.locator(inputSelector).count(), 0);
          const result = await page.evaluate(() => {
            const f = window.uiTest,
              root = document.querySelector<HTMLElement>("[data-pelican-ui]")!,
              button = document.querySelector<HTMLElement>(
                '[data-pelican-element="play"]',
              )!;
            const before = f.listenerCount();
            button.focus();
            f.ui.dispose();
            const snapshot = JSON.stringify(f.ui.inspect()),
              callbacks = f.inputs.length + f.events.length;
            root.appendChild(button);
            document.body.appendChild(root);
            button.click();
            button.dispatchEvent(
              new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
            );
            button.dispatchEvent(
              new CompositionEvent("compositionstart", {
                data: "中文",
                bubbles: true,
              }),
            );
            root.remove();
            f.ui.dispose();
            f.ui.mount();
            f.present();
            return {
              before,
              after: f.listenerCount(),
              unchanged: JSON.stringify(f.ui.inspect()) === snapshot,
              callbacksUnchanged:
                f.inputs.length + f.events.length === callbacks,
              roots: document.querySelectorAll("[data-pelican-ui]").length,
              keyboard: f.ui.consumesKeyboard(
                new KeyboardEvent("keydown", { isComposing: true }),
              ),
              state: f.ui.inspect(),
            };
          });
          assert.ok(result.before > 0);
          assert.equal(result.after, 0);
          assert.equal(result.unchanged, true);
          assert.equal(result.callbacksUnchanged, true);
          assert.equal(result.roots, 0);
          assert.equal(result.keyboard, false);
          assert.equal(result.state.disposed, true);
          assert.equal(result.state.focus, null);
          assert.deepEqual(result.state.elements, []);
        },
      );
    } finally {
      t.signal.removeEventListener("abort", abort);
      try {
        await browser?.close();
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) =>
          server.close((error) =>
            error &&
            (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING"
              ? reject(error)
              : resolve(),
          ),
        );
      }
    }
  },
);
