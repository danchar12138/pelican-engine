/** Idempotent locked dependency preparation; no global install or browser download by default. */
import path from "node:path";
import {
  doctor,
  diagnostic,
  envelope,
  inspectDependencies,
  isDirectInvocation,
  npmCommand,
  parseArguments,
  printReport,
  runCommand,
  sanitizeReport,
} from "./doctor.ts";
import type {
  CommandResult,
  DoctorOptions,
  Envelope,
  EnvironmentData,
} from "./doctor.ts";

export interface SetupOptions extends DoctorOptions {
  /** Prefer existing npm cache; network may fill missing locked packages. */
  offline?: boolean;
  /** Explicit opt-in only. The root integration may install Chromium separately. */
  installBrowser?: boolean;
}
export interface SetupData {
  actions: {
    action: "dependencies" | "browser";
    result: "reused" | "installed" | "failed";
    source: string;
  }[];
  environment: Envelope<EnvironmentData> | null;
}

export async function setup(
  options: SetupOptions = {},
): Promise<Envelope<SetupData>> {
  const projectRoot = path.resolve(options.projectRoot ?? process.cwd());
  const diagnostics = [] as ReturnType<typeof diagnostic>[];
  const data: SetupData = { actions: [], environment: null };
  const finish = () =>
    sanitizeReport(
      envelope(options.taskId ?? "setup", diagnostics, data),
      projectRoot,
    );
  const runner = options.runCommand ?? runCommand;
  const invoke = async (
    file: string,
    args: string[],
  ): Promise<CommandResult> => {
    try {
      return await runner(file, args, {
        cwd: projectRoot,
        timeoutMs: options.timeoutMs ?? 300_000,
        ...(options.signal ? { signal: options.signal } : {}),
      });
    } catch {
      return { exitCode: null, stdout: "", failure: "failed" };
    }
  };
  if (options.signal?.aborted) {
    diagnostics.push(
      diagnostic(
        "TCSETUP_CANCELLED",
        "error",
        "Setup was cancelled before making changes.",
        "Rerun setup when ready.",
      ),
    );
    return finish();
  }
  const dependencies = await inspectDependencies(projectRoot);
  if (!dependencies.lockUsable) {
    diagnostics.push(...dependencies.diagnostics);
    return finish();
  }
  if (dependencies.ready)
    data.actions.push({
      action: "dependencies",
      result: "reused",
      source: "verified locked node_modules",
    });
  else {
    const npm = npmCommand(projectRoot);
    if (!npm) {
      diagnostics.push(
        diagnostic(
          "TCSETUP_NPM_MISSING",
          "error",
          "No usable npm CLI was found.",
          "Use the supplied Node distribution or a user-level Node installation containing npm.",
        ),
      );
      return finish();
    }
    const result = await invoke(npm.file, [
      ...npm.prefix,
      "ci",
      options.offline ? "--offline" : "--prefer-offline",
      "--no-audit",
      "--no-fund",
    ]);
    if (result.exitCode !== 0) {
      data.actions.push({
        action: "dependencies",
        result: "failed",
        source: options.offline ? "npm cache only" : "npm cache preferred",
      });
      diagnostics.push(
        diagnostic(
          result.failure === "timeout"
            ? "TCSETUP_INSTALL_TIMEOUT"
            : result.failure === "aborted"
              ? "TCSETUP_CANCELLED"
              : "TCSETUP_INSTALL_FAILED",
          "error",
          "Locked dependency installation did not complete successfully.",
          "Check cache/network availability and package permissions; rerun setup. Raw npm output is excluded because it may contain credentials.",
        ),
      );
      return finish();
    }
    const installed = await inspectDependencies(projectRoot);
    if (!installed.ready) {
      diagnostics.push(
        ...installed.diagnostics,
        diagnostic(
          "TCSETUP_INSTALL_INCOMPLETE",
          "error",
          "npm completed but the locked dependency tree is not ready.",
          "Repair the local dependency installation before continuing.",
        ),
      );
      data.actions.push({
        action: "dependencies",
        result: "failed",
        source: "npm ci post-install verification",
      });
      return finish();
    }
    data.actions.push({
      action: "dependencies",
      result: "installed",
      source: options.offline
        ? "npm cache only"
        : "npm cache preferred; locked registry fallback permitted",
    });
  }
  data.environment = await doctor({
    ...options,
    projectRoot,
    taskId: "environment",
  });
  if (options.installBrowser && !data.environment.data.browser.installed) {
    if (options.offline) {
      diagnostics.push(
        diagnostic(
          "TCSETUP_BROWSER_OFFLINE",
          "error",
          "Bundled Chromium is missing and offline mode forbids downloading it.",
          "Install Chromium explicitly while online, then rerun offline setup.",
        ),
      );
      return finish();
    }
    const result = await invoke(process.execPath, [
      path.join(projectRoot, "node_modules/playwright/cli.js"),
      "install",
      "chromium",
    ]);
    if (result.exitCode !== 0) {
      data.actions.push({
        action: "browser",
        result: "failed",
        source: "locked Playwright browser installer",
      });
      diagnostics.push(
        diagnostic(
          result.failure === "timeout"
            ? "TCSETUP_BROWSER_TIMEOUT"
            : result.failure === "aborted"
              ? "TCSETUP_CANCELLED"
              : "TCSETUP_BROWSER_INSTALL_FAILED",
          "error",
          "Playwright Chromium installation failed.",
          "Retry the explicit browser install after checking network/cache access. No system Chrome or global installation is required.",
        ),
      );
      return finish();
    }
    data.environment = await doctor({
      ...options,
      projectRoot,
      taskId: "environment",
    });
    data.actions.push({
      action: "browser",
      result: data.environment.data.browser.installed ? "installed" : "failed",
      source: "locked Playwright browser installer",
    });
  } else if (data.environment.data.browser.installed)
    data.actions.push({
      action: "browser",
      result: "reused",
      source: "Playwright executablePath",
    });
  diagnostics.push(...data.environment.diagnostics);
  return finish();
}

if (isDirectInvocation(import.meta.url)) {
  let projectRoot = process.cwd();
  try {
    const args = parseArguments(process.argv.slice(2), [
      "--offline",
      "--install-browser",
    ]);
    projectRoot = path.resolve(args.projectRoot ?? process.cwd());
    const result = await setup({
      projectRoot,
      offline: args.flags.has("--offline"),
      installBrowser: args.flags.has("--install-browser"),
    });
    await printReport(result, args.output, projectRoot);
  } catch {
    await printReport(
      envelope(
        "setup",
        [
          diagnostic(
            "TCSETUP_ARGUMENT_OR_INTERNAL_ERROR",
            "error",
            "Setup could not complete.",
            "Use setup [--project directory] [--offline] [--install-browser] [--output relative-file.json].",
          ),
        ],
        null,
      ),
      undefined,
      projectRoot,
    );
  }
}
