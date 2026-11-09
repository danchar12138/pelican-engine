import { publishStartup } from "../../sdk/src/startup-observer.ts";
import type { EngineStartupSnapshot } from "../../sdk/src/index.ts";

/** Same public events drive the default screen and author-supplied npm UI. */
export function loadingStage(
  stage: EngineStartupSnapshot["stage"],
  message: string,
  detail: Partial<EngineStartupSnapshot> = {},
) {
  publishStartup({ ...detail, stage, message });
  if (
    typeof document === "undefined" ||
    typeof document.querySelector !== "function"
  )
    return;
  const label = document.querySelector<HTMLElement>("#loading-message");
  const overlay = document.querySelector<HTMLElement>("#loading");
  if (label) label.textContent = message;
  if (overlay)
    overlay.hidden =
      stage === "ready" ||
      document.documentElement?.dataset.pelicanReady === "true";
  const retry = document.querySelector<HTMLElement>("#loading-retry");
  if (retry) retry.hidden = stage !== "failed";
  const progress = document.querySelector<HTMLElement>("#render-progress");
  if (progress) {
    progress.textContent = message;
    progress.hidden =
      document.documentElement?.dataset.pelicanReady !== "true" ||
      !["pipeline", "first-frame", "download", "decode"].includes(stage);
  }
}

/** A network inactivity deadline, not a GPU compilation deadline or a total-download limit. */
export async function fetchLoadingAsset(
  input: RequestInfo | URL,
  init?: RequestInit,
  idleMs = 30000,
): Promise<Response> {
  if (!Number.isSafeInteger(idleMs) || idleMs < 1 || idleMs > 120000)
    throw Error("TC_ASSET_TIMEOUT_CONFIG: Network inactivity deadline must be an integer in [1,120000] ms.");
  const id = String(input instanceof Request ? input.url : input);
  const controller = new AbortController();
  const sourceSignal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
  const abort = () => controller.abort(sourceSignal?.reason);
  sourceSignal?.addEventListener("abort", abort, { once: true });
  if (sourceSignal?.aborted) abort();
  let timer: ReturnType<typeof setTimeout>;
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(
      () =>
        controller.abort(
          Error(
            `TC_ASSET_NETWORK_IDLE: ${id}; no download progress for ${idleMs} ms. Check network and retry.`,
          ),
        ),
      idleMs,
    );
  };
  const cleanup = () => {
    clearTimeout(timer);
    sourceSignal?.removeEventListener("abort", abort);
  };
  let loadedBytes = 0;
  arm();
  try {
    loadingStage("download", `Downloading ${id.split("/").at(-1)}`, {
      asset: id,
    });
    const response = await fetch(input, { ...init, signal: controller.signal });
    if (!response.ok)
      throw Error(
        `TC_ASSET_HTTP: ${id}; HTTP ${response.status}. Repair the resource URL or retry.`,
      );
    const total = Number(response.headers.get("content-length"));
    const totalBytes =
      total > 0 && !response.headers.get("content-encoding")
        ? total
        : undefined;
    if (!response.body) {
      cleanup();
      return response;
    }
    const reader = response.body.getReader();
    const stream = new ReadableStream<Uint8Array>({
      async pull(sink) {
        try {
          const { done, value } = await reader.read();
          if (done) {
            cleanup();
            sink.close();
            return;
          }
          loadedBytes += value.byteLength;
          arm();
          loadingStage(
            "download",
            `Downloading ${id.split("/").at(-1)} · ${(loadedBytes / 1048576).toFixed(1)} MiB`,
            { asset: id, loadedBytes, ...(totalBytes ? { totalBytes } : {}) },
          );
          sink.enqueue(value);
        } catch (error) {
          cleanup();
          sink.error(
            controller.signal.aborted ? controller.signal.reason : error,
          );
        }
      },
      async cancel(reason) {
        cleanup();
        controller.abort(reason);
        await reader.cancel(reason);
      },
    });
    return new Response(stream, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  } catch (error) {
    cleanup();
    throw controller.signal.aborted ? controller.signal.reason : error;
  }
}
