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

/** Independent-AI-discovered contact regression: the gate must remain kinematic. */
export async function runM2Physics(root: string, output: string) {
  const project = path.join(root, "examples/physics-risk");
  await mkdir(output, { recursive: true });
  const compiled = await compileProject({
    projectRoot: project,
    outDir: path.join(project, ".pelican/public/generated"),
    engineRoot: root,
  });
  assert.equal(compiled.success, true, JSON.stringify(compiled.diagnostics));
  const server = await createServer({
    root,
    configFile: path.join(root, "vite.config.ts"),
    publicDir: path.join(project, ".pelican/public"),
    logLevel: "silent",
    server: { port: 0, host: "127.0.0.1", strictPort: true },
  });
  await server.listen();
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    browser = await chromium.launch(automationLaunchOptions());
    const owned = browser;
    return await withAutomationDeadline(
      async () => {
        const page = await owned.newPage({
            viewport: { width: 960, height: 540 },
          }),
          errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        page.on("console", (message) => {
          if (message.type() === "error") errors.push(message.text());
        });
        const url = new URL(server.resolvedUrls!.local[0]);
        url.searchParams.set("automation", "1");
        await page.goto(url.href, { waitUntil: "domcontentloaded" });
        await waitForEngine(page);
        const command = async (value: unknown) => {
          const response = await page.evaluate(
            async (value) => (window as any).__pelican.command(value),
            value,
          );
          assert.equal(response.status, "succeeded", JSON.stringify(response));
          return response.data;
        };
        await command({ type: "step", count: 30 });
        await command({ type: "input", key: "s", pressed: true });
        const contact = await command({ type: "step", count: 100 });
        assert.equal(
          contact.compiledIR.scene.entities.find(
            (entity: any) => entity.id === "gate",
          ).rigidBody.type,
          "kinematic",
        );
        assert.ok(
          contact.game.transforms.player.position[2] > 6.45 &&
            contact.game.transforms.player.position[2] < 6.55,
        );
        await command({ type: "input", key: "s", pressed: false });
        await command({ type: "step", count: 1 });
        const checkpoint = await command({ type: "snapshot" });
        await page.screenshot({
          path: path.join(output, "kinematic-contact.png"),
        });
        await command({ type: "recordStart" });
        await command({ type: "input", key: "w", pressed: true });
        const away = await command({ type: "step", count: 100 });
        assert.ok(
          away.game.transforms.player.position[2] < 2,
          JSON.stringify({
            contact: contact.game.transforms.player.position,
            away: away.game.transforms.player.position,
            physics: away.runtime.plugins,
          }),
        );
        await command({ type: "input", key: "w", pressed: false });
        await command({ type: "step", count: 1 });
        const trace = await command({ type: "recordStop" });
        await command({ type: "step", count: 3 });
        const replay = await command({ type: "replay", trace });
        assert.equal(replay.status, "passed");
        await command({ type: "restore", snapshot: checkpoint });
        await command({ type: "input", key: "e", pressed: true });
        await command({ type: "input", key: "e", pressed: false });
        await command({ type: "input", key: "s", pressed: true });
        const opened = await command({ type: "step", count: 60 });
        assert.ok(opened.game.transforms.gate.position[1] > 4.9);
        assert.ok(opened.game.transforms.player.position[2] > 9);
        await page.screenshot({
          path: path.join(output, "kinematic-open.png"),
        });
        assert.deepEqual(errors, []);
        const report = {
          passed: true,
          backend: contact.backend,
          adapter: contact.adapter,
          scenario:
            "three-entity public SDK character/floor/kinematic-gate contact then reverse and open",
          contact: contact.game.transforms.player.position,
          away: away.game.transforms.player.position,
          opened: {
            gate: opened.game.transforms.gate.position,
            player: opened.game.transforms.player.position,
          },
          replay,
          errors,
        };
        await writeFile(
          path.join(output, "kinematic-regression.json"),
          JSON.stringify(report, null, 2) + "\n",
        );
        return report;
      },
      60000,
      "Kinematic contact browser regression",
    );
  } finally {
    try {
      await browser?.close();
    } finally {
      await server.close();
    }
  }
}
