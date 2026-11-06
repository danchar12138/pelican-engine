import type { LaunchOptions, Page } from "playwright";

export class AutomationError extends Error {
  constructor(
    readonly code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(`${code}: ${message}`, options);
    this.name = "AutomationError";
  }
}

function timeoutValue(timeoutMs: number): number {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000)
    throw new AutomationError(
      "TC_AUTOMATION_TIMEOUT_RANGE",
      "timeoutMs must be an integer in [1,120000].",
    );
  return timeoutMs;
}

export function automationLaunchOptions(timeoutMs = 30_000): LaunchOptions {
  return {
    headless: false,
    timeout: timeoutValue(timeoutMs),
    args: [
      "--use-angle=d3d11",
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
      "--disable-backgrounding-occluded-windows",
      "--disable-features=CalculateNativeWinOcclusion",
    ],
  };
}

export function automationURL(url: string): string {
  const target = new URL(url);
  target.searchParams.set("automation", "1");
  return target.href;
}

/** The caller owns cleanup; a frozen renderer must not control the Node deadline. */
export async function withAutomationDeadline<T>(
  operation: () => PromiseLike<T>,
  timeoutMs = 30_000,
  label = "Browser operation",
): Promise<T> {
  timeoutValue(timeoutMs);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new AutomationError(
                "TC_AUTOMATION_TIMEOUT",
                `${label} exceeded its ${timeoutMs} ms Node deadline.`,
              ),
            ),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export interface EngineWaitOptions {
  /** Production has no development control hook and must not get automation=1. */
  production?: boolean;
}

/** No RAF polling: Chromium can suspend animation frames in occluded windows. */
export async function waitForEngine(
  page: Pick<Page, "waitForFunction">,
  timeoutMs = 30_000,
  options: EngineWaitOptions = {},
): Promise<void> {
  timeoutValue(timeoutMs);
  try {
    await withAutomationDeadline(
      async () => {
        const handle = await page.waitForFunction(
          ({ production }) => {
            const data = document.documentElement.dataset;
            const runtime = globalThis as unknown as {
              __pelicanFailure?: unknown;
              __pelican?: { command?: unknown };
            };
            const failure = runtime.__pelicanFailure || data.pelicanFailure;
            if (failure) return { state: "failed", detail: String(failure) };
            if (data.pelicanReady !== "true") return false;
            if (
              !production &&
              typeof runtime.__pelican?.command !== "function"
            )
              return false;
            return { state: "ready" };
          },
          { production: options.production === true },
          { polling: 100, timeout: timeoutMs },
        );
        try {
          const status: unknown = await handle.jsonValue();
          if (!status || typeof status !== "object" || !("state" in status))
            throw new AutomationError(
              "TC_AUTOMATION_READY_PROTOCOL",
              "The readiness probe returned an invalid result.",
            );
          if (status.state === "failed")
            throw new AutomationError(
              "TC_AUTOMATION_BOOT_FAILED",
              "detail" in status
                ? String(status.detail)
                : "Engine boot failed.",
            );
          if (status.state !== "ready")
            throw new AutomationError(
              "TC_AUTOMATION_READY_PROTOCOL",
              "The readiness probe returned an unknown state.",
            );
        } finally {
          await handle.dispose();
        }
      },
      timeoutMs,
      "Engine readiness",
    );
  } catch (error) {
    if (error instanceof AutomationError) throw error;
    throw new AutomationError(
      error instanceof Error && error.name === "TimeoutError"
        ? "TC_AUTOMATION_TIMEOUT"
        : "TC_AUTOMATION_WAIT_FAILED",
      "Engine readiness failed; close the owned browser before retrying.",
      { cause: error },
    );
  }
}
