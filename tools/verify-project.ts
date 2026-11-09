import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";
import {
  parseCommand,
  type ControlCommand,
  type Envelope,
} from "../packages/protocol/src/index.ts";
import { recipeAcceptance } from "./recipe-acceptance.ts";
import { captureFacts, compareDisplayPixels } from "./capture-facts.ts";
/** Shared recipe assertions are imported by contributor CI and installed author verify. */
export async function runProjectVerification(
  page: Page,
  options: {
    recipe?: string;
    output: string;
    baseline?: string;
    writeBaseline?: boolean;
  },
) {
  if (options.writeBaseline && !options.baseline)
    throw new Error(
      "TC_CLI_BASELINE: --write-baseline requires --baseline <file.png>.",
    );
  if (options.baseline && options.recipe)
    throw new Error(
      "TC_CLI_BASELINE: Controlled baselines use generic verify from a fresh session, without recipe actions.",
    );
  const acceptance = options.recipe
    ? recipeAcceptance(options.recipe)
    : undefined;
  if (options.recipe && !acceptance)
    throw new Error(
      "TC_CLI_VERIFY_RECIPE: No complete recipe acceptance for this ID. Run verify without --recipe for smoke; query recipe --id for boundaries.",
    );
  await mkdir(options.output, { recursive: true });
  const calls: {
    type: string;
    operations: number;
    status: string;
    ms: number;
  }[] = [];
  const command = async (input: ControlCommand): Promise<any> => {
    parseCommand(input);
    const started = Date.now();
    const response = (await page.evaluate(
      async (value) => (window as any).__pelican.command(value),
      input,
    )) as Envelope;
    calls.push({
      type: input.type,
      operations: input.type === "batch" ? input.commands.length : 1,
      status: response.status,
      ms: Date.now() - started,
    });
    assert.equal(
      response.status,
      "succeeded",
      JSON.stringify(response.diagnostics),
    );
    return response.data;
  };
  let failure: string | null = null,
    result: unknown = null;
  const started = Date.now();
  try {
    await command({ type: "pause" });
    const initial = await command({ type: "inspect", summary: true });
    assert.equal(initial.summary.ready, true);
    assert.equal(initial.summary.playback.playing, false);
    if (acceptance) result = await acceptance.run(page, command);
    else {
      await command({ type: "step", count: 3 });
      result = {
        scope:
          "Three fixed ticks, ready state and runtime errors only; no inferred gameplay or pixel brightness specification.",
      };
    }
    const state = await command({
      type: "inspect",
      fields: ["summary", "errors"],
    });
    assert.equal(state.summary.ready, true);
    assert.deepEqual(state.errors, []);
  } catch (error) {
    failure = String(error);
  }
  const observation = await command({
    type: "inspect",
    fields: ["summary", "adapter", "rendering"],
  }).catch(() => null);
  const image = path.join(options.output, "capture.png"),
    reportFile = path.join(options.output, "report.json");
  const png = await page.screenshot({ path: image });
  let baseline: unknown = null;
  if (options.baseline && !failure) {
    const control = {
      tick: observation?.summary.tick,
      camera: observation?.summary.camera,
      viewport: observation?.summary.viewport,
      mode: observation?.summary.mode,
      settings: observation?.rendering?.settings,
      samples: observation?.rendering?.surface?.samples ?? null,
      frameSerial: observation?.rendering?.surface?.frameSerial ?? null,
      historyResets: observation?.rendering?.surface?.historyResets ?? null,
      initialState:
        "fresh browser, automation paused, three fixed ticks, DPR=1",
    };
    const environment = {
      browser: page.context().browser()?.version(),
      adapter: observation?.adapter,
      backend: observation?.summary.backend,
    };
    try {
      if (options.writeBaseline) {
        await mkdir(path.dirname(options.baseline), { recursive: true });
        await writeFile(options.baseline, png);
        await writeFile(
          options.baseline + ".json",
          JSON.stringify({ control, environment }, null, 2) + "\n",
        );
        baseline = {
          written: true,
          path: options.baseline,
          control,
          environment,
        };
      } else {
        const previous = JSON.parse(
          await readFile(options.baseline + ".json", "utf8"),
        );
        assert.deepEqual(
          control,
          previous.control,
          "TC_BASELINE_CONTROL: Camera/tick/viewport/sampling/history controls differ.",
        );
        const comparison = compareDisplayPixels(
          png,
          await readFile(options.baseline),
        );
        baseline = {
          ...comparison,
          path: options.baseline,
          environment,
          previousEnvironment: previous.environment,
        };
        assert.equal(
          comparison.passed,
          true,
          "TC_BASELINE_PIXELS: Tolerant numeric comparison failed.",
        );
      }
    } catch (error) {
      failure = String(error);
    }
  }
  const report = {
    baseline,
    format: "pelican.verify",
    version: 1,
    kind: acceptance ? "recipe-acceptance" : "project-smoke",
    recipe: options.recipe ?? null,
    passed: failure === null,
    failure,
    result,
    calls,
    elapsedMs: Date.now() - started,
    environment: {
      browser: page.context().browser()?.version() ?? null,
      userAgent: await page.evaluate(() => navigator.userAgent),
      observation,
    },
    facts: captureFacts(png, observation),
    artifacts: [image, reportFile],
  };
  await writeFile(reportFile, JSON.stringify(report, null, 2) + "\n");
  return report;
}
