import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ViteDevServer } from "vite";
import type { Page } from "playwright";
import {
  AutomationError,
  automationLaunchOptions,
  automationURL,
  waitForEngine,
} from "./browser-session.ts";
import {
  parseCommand,
  PROTOCOL_VERSION,
  result,
  type ControlCommand,
  type Envelope,
  type ProtocolDiagnostic,
  type TaskStatus,
} from "../packages/protocol/src/index.ts";

const BODY_LIMIT = 1024 * 1024;
// Base64 plus the envelope must fit the unchanged client's 8 MiB response cap.
const CAPTURE_LIMIT = 6 * BODY_LIMIT - 3 * 1024;
const HISTORY_LIMIT = 256;
const QUEUE_LIMIT = 64;
const DEFAULT_TIMEOUT = 30_000;
const MAX_TIMEOUT = 120_000;
const ID_PATTERN = /^[a-zA-Z0-9_-]{1,96}$/;
const attached = new WeakSet<ViteDevServer>();

export interface ControlOptions {
  timeoutMs?: number;
}
export interface ControlHandle {
  close(): Promise<void>;
}
export interface ControlTaskSummary {
  taskId: string;
  status: TaskStatus;
  commandType: ControlCommand["type"];
  generation: number;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
}
export interface ControlStatus {
  generation: number;
  sessionNeedsReset: boolean;
  resetting: boolean;
  hasPage: boolean;
  closed: boolean;
  tasks: ControlTaskSummary[];
}
/** Minimal transport seam for CPU-only failure tests; it is never GPU evidence. */
export interface ControlPage {
  dispatch(command: ControlCommand): Promise<Envelope>;
  isClosed(): boolean;
  close(): Promise<void>;
}
export type ControlPageFactory = (options: {
  url: string;
  timeoutMs: number;
  signal: AbortSignal;
}) => Promise<ControlPage>;
interface Task {
  summary: ControlTaskSummary;
  command: ControlCommand;
  done: Promise<Envelope>;
  finish(value: Envelope): void;
  timer?: ReturnType<typeof setTimeout>;
}
interface Session {
  generation: number;
  abort: AbortController;
  ready: Promise<ControlPage>;
  page?: ControlPage;
  cleanup?: Promise<void>;
}
class BridgeError extends Error {
  constructor(
    readonly code: string,
    readonly httpStatus = 503,
  ) {
    super(code);
  }
}
function timeoutValue(value = DEFAULT_TIMEOUT): number {
  if (!Number.isInteger(value) || value < 10 || value > MAX_TIMEOUT)
    throw new Error(
      "TC_CONTROL_TIMEOUT_RANGE: timeoutMs must be an integer in [10,120000].",
    );
  return value;
}
function diagnostic(
  code: string,
  message: string,
  remediation = "Inspect task status; explicitly reset the control session before retrying if stateReset is true.",
): ProtocolDiagnostic {
  return { code, severity: "error", message, remediation };
}
function failed(
  id: string,
  code: string,
  message: string,
  data: unknown = null,
  status: TaskStatus = "failed",
): Envelope {
  return result(id, status, data, [diagnostic(code, message)]);
}
function loopback(address: string | undefined): boolean {
  const value = address?.toLowerCase().replace(/^::ffff:/, "");
  return (
    value === "::1" ||
    value === "[::1]" ||
    value === "localhost" ||
    /^127(?:\.\d{1,3}){3}$/.test(value ?? "")
  );
}
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function requestId(req: IncomingMessage): string {
  const id = req.headers["x-threecat-task-id"];
  return typeof id === "string" && ID_PATTERN.test(id)
    ? id
    : `control-${randomUUID()}`;
}
function writeJSON(
  res: ServerResponse,
  httpStatus: number,
  value: Envelope,
): void {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(httpStatus, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...([408, 413].includes(httpStatus) ? { Connection: "close" } : {}),
  });
  res.end(JSON.stringify(value));
}
/** Bounded even for chunked requests and peers that never finish sending. */
function readJSON(req: IncomingMessage, timeoutMs: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    const finish = (error?: BridgeError, value?: unknown) => {
      clearTimeout(timer);
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onError);
      req.off("aborted", onError);
      if (error) {
        req.resume();
        reject(error);
      } else resolve(value);
    };
    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size > BODY_LIMIT)
        finish(new BridgeError("TC_CONTROL_BODY_TOO_LARGE", 413));
      else chunks.push(chunk);
    };
    const onEnd = () => {
      try {
        finish(undefined, JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        finish(new BridgeError("TC_CONTROL_JSON_INVALID", 400));
      }
    };
    const onError = () =>
      finish(new BridgeError("TC_CONTROL_REQUEST_ABORTED", 400));
    const timer = setTimeout(
      () => finish(new BridgeError("TC_CONTROL_BODY_TIMEOUT", 408)),
      timeoutMs,
    );
    req.on("data", onData);
    req.once("end", onEnd);
    req.once("error", onError);
    req.once("aborted", onError);
    const length = req.headers["content-length"];
    if (length !== undefined && Number(length) > BODY_LIMIT)
      finish(new BridgeError("TC_CONTROL_BODY_TOO_LARGE", 413));
  });
}

/** Internal screenshot adapter, exported only to exercise the real path with CPU fixtures. */
export async function captureControlPage(
  page: Pick<Page, "screenshot" | "viewportSize">,
  timeoutMs: number,
): Promise<Envelope> {
  const viewport = page.viewportSize();
  if (!viewport || viewport.width <= 0 || viewport.height <= 0)
    return failed(
      "capture",
      "TC_CONTROL_CAPTURE_VIEWPORT",
      "The owned page has no valid configured viewport; no image was returned.",
    );
  const png = await page.screenshot({
    type: "png",
    timeout: timeoutValue(timeoutMs),
  });
  if (png.byteLength > CAPTURE_LIMIT)
    return failed(
      "capture",
      "TC_CONTROL_CAPTURE_TOO_LARGE",
      "The PNG exceeds the bounded capture transport size; no image was returned.",
      { format: "png", bytes: png.byteLength, limitBytes: CAPTURE_LIMIT },
    );
  return result("capture", "succeeded", {
    format: "png",
    base64: png.toString("base64"),
    width: viewport.width,
    height: viewport.height,
    bytes: png.byteLength,
  });
}

/** No init scripts or nested evaluated functions: safe under TSX's __name transform. */
const physicalPageFactory: ControlPageFactory = async ({
  url,
  timeoutMs,
  signal,
}) => {
  const { chromium } = await import("playwright");
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  const abort = () => {
    void browser?.close().catch(() => undefined);
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    if (signal.aborted) throw new BridgeError("TC_CONTROL_SESSION_STALE");
    browser = await chromium.launch(automationLaunchOptions(timeoutMs));
    if (signal.aborted) throw new BridgeError("TC_CONTROL_SESSION_STALE");
    const context = await browser.newContext({
      viewport: { width: 960, height: 540 },
      serviceWorkers: "block",
    });
    const origin = new URL(url).origin;
    await context.route("**/*", (route) => {
      if (new URL(route.request().url()).origin === origin)
        return route.continue();
      return route.abort("blockedbyclient");
    });
    await context.routeWebSocket("**/*", (socket) => {
      if (new URL(socket.url()).origin.replace(/^ws/, "http") === origin)
        socket.connectToServer();
      else socket.close();
    });
    const page = await context.newPage();
    await page.goto(automationURL(url), {
      waitUntil: "domcontentloaded",
      timeout: timeoutMs,
    });
    await waitForEngine(page, timeoutMs);
    if (signal.aborted) throw new BridgeError("TC_CONTROL_RUNTIME_UNAVAILABLE");
    const ownedBrowser = browser;
    return {
      isClosed: () => page.isClosed() || !ownedBrowser.isConnected(),
      dispatch: (command) =>
        command.type === "capture"
          ? captureControlPage(page, timeoutMs)
          : page.evaluate(async (value) => {
              const api = (
                window as unknown as {
                  __threecat?: {
                    command(input: ControlCommand): Promise<Envelope>;
                  };
                }
              ).__threecat;
              if (!api || typeof api.command !== "function")
                throw new Error("TC_CONTROL_RUNTIME_UNAVAILABLE");
              return api.command(value);
            }, command),
      close: async () => {
        signal.removeEventListener("abort", abort);
        await ownedBrowser.close();
      },
    };
  } catch (error) {
    signal.removeEventListener("abort", abort);
    await browser?.close().catch(() => undefined);
    throw new BridgeError(
      error instanceof AutomationError
        ? error.code
        : "TC_CONTROL_BROWSER_UNAVAILABLE",
    );
  }
};

/** Attach before server.listen(), or after listen: the actual bound port is resolved lazily.
 * POST /__threecat/control -> ControlCommand -> Envelope (same browser until reset).
 * GET /__threecat/status -> Envelope<ControlStatus> (bounded metadata, no snapshots).
 * POST /__threecat/cancel {taskId}; POST /__threecat/session {action:"reset"}.
 * An aborted HTTP command also cancels its task. Running cancellation discards state.
 */
export function attachControl(
  server: ViteDevServer,
  options: ControlOptions = {},
): ControlHandle {
  return attach(server, options, physicalPageFactory);
}
/** Test-only dependency injection; not an alternate engine API or GPU verification path. */
export function attachControlForTests(
  server: ViteDevServer,
  pageFactory: ControlPageFactory,
  options: ControlOptions = {},
): ControlHandle {
  return attach(server, options, pageFactory);
}
function attach(
  server: ViteDevServer,
  options: ControlOptions,
  pageFactory: ControlPageFactory,
): ControlHandle {
  const timeoutMs = timeoutValue(options.timeoutMs);
  if (server.config.command !== "serve" || server.config.isProduction)
    throw new Error(
      "TC_CONTROL_DEV_ONLY: Control is available only on a development server.",
    );
  if (!server.httpServer)
    throw new Error(
      "TC_CONTROL_HTTP_REQUIRED: A local HTTP server is required.",
    );
  if (attached.has(server))
    throw new Error(
      "TC_CONTROL_ALREADY_ATTACHED: Only one control bridge is allowed per server.",
    );
  attached.add(server);
  const tasks = new Map<string, Task>();
  // Terminal history contains metadata only, never command bodies or resolved snapshots.
  const history = new Map<string, ControlTaskSummary>();
  const queue: Task[] = [];
  const cleanup = new Set<Promise<void>>();
  let generation = 0;
  let session: Session | undefined;
  let needsReset = false;
  let resetting: Promise<boolean> | undefined;
  let closed = false;
  let draining = false;
  let active: Task | undefined;
  let closePromise: Promise<void> | undefined;

  const state = () => ({
    stateReset: true,
    sessionNeedsReset: needsReset,
    generation,
  });
  function settle(task: Task, value: Envelope): void {
    if (task.summary.status !== "queued" && task.summary.status !== "running")
      return;
    clearTimeout(task.timer);
    task.summary.status = value.status;
    task.summary.finishedAt = Date.now();
    tasks.delete(task.summary.taskId);
    const queuedIndex = queue.indexOf(task);
    if (queuedIndex >= 0) queue.splice(queuedIndex, 1);
    task.finish(value);
  }
  function prune(): void {
    for (const [id, summary] of history) {
      if (history.size < HISTORY_LIMIT) break;
      if (summary.status !== "queued" && summary.status !== "running")
        history.delete(id);
    }
  }
  function retire(old: Session): void {
    if (old.cleanup) return;
    old.abort.abort();
    const pending = old.ready.then(
      (page) => page.close(),
      () => undefined,
    );
    old.cleanup = pending;
    cleanup.add(pending);
    // Always observe both fulfillment and rejection, including late factory/evaluate failures.
    void pending.then(
      () => cleanup.delete(pending),
      () => {
        /* Keep failed cleanup: reset must not silently continue. */
      },
    );
  }
  function discard(): void {
    generation++;
    needsReset = true;
    const old = session;
    session = undefined;
    if (old) retire(old);
    for (const task of [...queue])
      if (task.summary.status === "queued")
        settle(
          task,
          failed(
            task.summary.taskId,
            "TC_CONTROL_SESSION_STALE",
            "Queued command was not executed because the session was discarded.",
            state(),
            "cancelled",
          ),
        );
  }
  function terminate(
    task: Task,
    status: "cancelled" | "timed_out",
    code: string,
  ): void {
    if (task.summary.status !== "queued" && task.summary.status !== "running")
      return;
    const running = task.summary.status === "running";
    if (running) discard();
    settle(
      task,
      failed(
        task.summary.taskId,
        code,
        running
          ? "The owned browser session was discarded; explicitly reset before sending another command."
          : "The queued command was not executed.",
        running ? state() : { stateReset: false, executed: false, generation },
        status,
      ),
    );
  }
  function serverURL(): string {
    const address = server.httpServer?.address();
    if (!address || typeof address === "string" || !address.port)
      throw new BridgeError("TC_CONTROL_SERVER_NOT_LISTENING");
    // Never trust Host, resolvedUrls or the configured (possibly busy/zero) port.
    const base =
      server.config.base.startsWith("/") && !server.config.base.startsWith("//")
        ? server.config.base
        : "/";
    return `http://127.0.0.1:${address.port}${base}`;
  }
  async function getPage(task: Task): Promise<ControlPage> {
    if (!session) {
      const url = serverURL();
      const abort = new AbortController();
      const current: Session = {
        generation,
        abort,
        ready: Promise.resolve().then(() =>
          pageFactory({ url, timeoutMs, signal: abort.signal }),
        ),
      };
      session = current;
      void current.ready.then(
        (page) => {
          current.page = page;
        },
        () => undefined,
      );
    }
    const owner = session;
    const page = await owner.ready;
    if (
      closed ||
      owner !== session ||
      owner.generation !== task.summary.generation ||
      task.summary.status !== "running"
    )
      throw new BridgeError("TC_CONTROL_SESSION_STALE");
    if (page.isClosed()) throw new BridgeError("TC_CONTROL_BROWSER_CLOSED");
    return page;
  }
  function normalized(task: Task, payload: unknown): Envelope {
    if (
      !record(payload) ||
      payload.protocolVersion !== PROTOCOL_VERSION ||
      !["succeeded", "failed"].includes(String(payload.status)) ||
      !Array.isArray(payload.diagnostics) ||
      !Array.isArray(payload.artifacts) ||
      !("data" in payload)
    )
      throw new BridgeError("TC_CONTROL_RESPONSE_INVALID");
    // Never reflect raw browser errors, stacks, paths or untrusted diagnostic messages.
    const diagnostics: ProtocolDiagnostic[] = payload.diagnostics
      .slice(0, 32)
      .map((value) => {
        const code =
          record(value) &&
          typeof value.code === "string" &&
          /^TC[A-Z0-9_]{1,90}$/.test(value.code)
            ? value.code
            : "TC_CONTROL_RUNTIME_FAILURE";
        return diagnostic(
          code,
          "Runtime command reported a diagnostic. Inspect the referenced command and project source.",
          "Correct the command or project source and retry; a runtime failure envelope alone does not reset the session.",
        );
      });
    const value = result(
      task.summary.taskId,
      payload.status as TaskStatus,
      payload.data === undefined ? null : payload.data,
      diagnostics,
    );
    const json = JSON.stringify(value);
    if (Buffer.byteLength(json) > 8 * BODY_LIMIT)
      throw new BridgeError("TC_CONTROL_RESPONSE_TOO_LARGE");
    return JSON.parse(json) as Envelope;
  }
  async function drain(): Promise<void> {
    if (draining) return;
    draining = true;
    try {
      while (!closed) {
        const task = queue.shift();
        if (!task) break;
        if (task.summary.status !== "queued") continue;
        if (needsReset || resetting) {
          settle(
            task,
            failed(
              task.summary.taskId,
              "TC_CONTROL_SESSION_RESET_REQUIRED",
              "Explicitly reset the session before retrying.",
              state(),
              "cancelled",
            ),
          );
          continue;
        }
        active = task;
        task.summary.status = "running";
        task.summary.startedAt = Date.now();
        try {
          const execution = getPage(task).then((page) =>
            page.dispatch(task.command),
          );
          const payload = await Promise.race([execution, task.done]);
          if (task.summary.status !== "running") continue;
          if (task.summary.generation !== generation)
            throw new BridgeError("TC_CONTROL_SESSION_STALE");
          settle(task, normalized(task, payload));
        } catch (error) {
          if (task.summary.status !== "running") continue;
          const code =
            error instanceof BridgeError
              ? error.code
              : "TC_CONTROL_TRANSPORT_FAILURE";
          discard();
          settle(
            task,
            failed(
              task.summary.taskId,
              code,
              "Browser transport failed. The owned session was discarded; explicitly reset before retrying.",
              state(),
            ),
          );
        } finally {
          if (active === task) active = undefined;
        }
      }
    } finally {
      draining = false;
    }
  }
  async function waitForCleanup(): Promise<boolean> {
    if (!cleanup.size) return true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        Promise.all([...cleanup]).then(
          () => true,
          () => false,
        ),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), timeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  function resetSession(): Promise<boolean> {
    if (resetting) return resetting;
    if (active?.summary.status === "running")
      terminate(active, "cancelled", "TC_CONTROL_SESSION_RESET");
    else discard();
    const token = generation;
    resetting = waitForCleanup()
      .then((ok) => {
        if (ok && !closed && generation === token) needsReset = false;
        return ok && !closed && generation === token;
      })
      .finally(() => {
        resetting = undefined;
      });
    return resetting;
  }
  function assertLocal(req: IncomingMessage): void {
    if (
      !loopback(req.socket.remoteAddress) ||
      !loopback(req.socket.localAddress)
    )
      throw new BridgeError("TC_CONTROL_LOOPBACK_ONLY", 403);
    const authority = req.headers.host;
    if (!authority || /[\s/@?#\\]/.test(authority))
      throw new BridgeError("TC_CONTROL_HOST_REJECTED", 403);
    let host: URL;
    try {
      host = new URL(`http://${authority}`);
    } catch {
      throw new BridgeError("TC_CONTROL_HOST_REJECTED", 403);
    }
    if (!loopback(host.hostname) || host.port !== new URL(serverURL()).port)
      throw new BridgeError("TC_CONTROL_HOST_REJECTED", 403);
    const origin = req.headers.origin;
    if (origin !== undefined && origin !== host.origin)
      throw new BridgeError("TC_CONTROL_ORIGIN_REJECTED", 403);
    const site = req.headers["sec-fetch-site"];
    if (site && site !== "same-origin" && site !== "none")
      throw new BridgeError("TC_CONTROL_ORIGIN_REJECTED", 403);
    if (req.headers["access-control-request-method"])
      throw new BridgeError("TC_CONTROL_ORIGIN_REJECTED", 403);
  }
  async function handle(
    req: IncomingMessage,
    res: ServerResponse,
    route: string,
  ): Promise<void> {
    const id = requestId(req);
    try {
      assertLocal(req);
      if (closed) throw new BridgeError("TC_CONTROL_CLOSED", 503);
      if (route === "/__threecat/status") {
        if (req.method !== "GET")
          throw new BridgeError("TC_CONTROL_METHOD", 405);
        const data: ControlStatus = {
          generation,
          sessionNeedsReset: needsReset,
          resetting: !!resetting,
          hasPage: !!session?.page && !session.page.isClosed(),
          closed,
          tasks: [...history.values()].map((summary) => ({ ...summary })),
        };
        writeJSON(res, 200, result(id, "succeeded", data));
        return;
      }
      if (req.method !== "POST")
        throw new BridgeError("TC_CONTROL_METHOD", 405);
      if (
        req.headers["content-type"]?.split(";", 1)[0].trim().toLowerCase() !==
        "application/json"
      )
        throw new BridgeError("TC_CONTROL_CONTENT_TYPE", 415);
      if (
        req.headers["content-encoding"] &&
        req.headers["content-encoding"] !== "identity"
      )
        throw new BridgeError("TC_CONTROL_CONTENT_ENCODING", 415);
      const body = await readJSON(req, timeoutMs);
      if (closed || res.destroyed)
        throw new BridgeError("TC_CONTROL_CLOSED", 503);
      if (route === "/__threecat/cancel") {
        if (
          !record(body) ||
          Object.keys(body).length !== 1 ||
          typeof body.taskId !== "string" ||
          !ID_PATTERN.test(body.taskId)
        )
          throw new BridgeError("TC_CONTROL_CANCEL_INVALID", 400);
        const summary = history.get(body.taskId);
        if (!summary) throw new BridgeError("TC_CONTROL_TASK_UNKNOWN", 404);
        const task = tasks.get(body.taskId);
        const running = summary.status === "running";
        const cancellable = running || summary.status === "queued";
        if (task) terminate(task, "cancelled", "TC_CONTROL_TASK_CANCELLED");
        const cleaned = running ? await waitForCleanup() : true;
        writeJSON(
          res,
          cleaned ? 200 : 503,
          result(
            id,
            cleaned ? "succeeded" : "failed",
            {
              taskId: body.taskId,
              status: summary.status,
              cancelled: cancellable,
              stateReset: running,
              sessionNeedsReset: needsReset,
              generation,
            },
            cleaned
              ? []
              : [
                  diagnostic(
                    "TC_CONTROL_CLEANUP_PENDING",
                    "Owned browser cleanup did not complete; a fresh session is blocked.",
                  ),
                ],
          ),
        );
        return;
      }
      if (route === "/__threecat/session") {
        if (
          !record(body) ||
          Object.keys(body).length !== 1 ||
          body.action !== "reset"
        )
          throw new BridgeError("TC_CONTROL_SESSION_INVALID", 400);
        const ok = await resetSession();
        writeJSON(
          res,
          ok ? 200 : 503,
          result(
            id,
            ok ? "succeeded" : "failed",
            state(),
            ok
              ? []
              : [
                  diagnostic(
                    "TC_CONTROL_CLEANUP_PENDING",
                    "Cleanup has not completed; the old state is discarded and new commands remain blocked.",
                  ),
                ],
          ),
        );
        return;
      }
      let command: ControlCommand;
      try {
        command = parseCommand(body);
      } catch {
        throw new BridgeError("TC_CONTROL_COMMAND_INVALID", 400);
      }
      const headerId = req.headers["x-threecat-task-id"];
      if (
        headerId !== undefined &&
        (typeof headerId !== "string" || !ID_PATTERN.test(headerId))
      )
        throw new BridgeError("TC_CONTROL_TASK_ID_INVALID", 400);
      if (history.has(id))
        throw new BridgeError("TC_CONTROL_TASK_DUPLICATE", 409);
      if (needsReset || resetting) {
        writeJSON(
          res,
          409,
          failed(
            id,
            "TC_CONTROL_SESSION_RESET_REQUIRED",
            "The previous state is discarded. Explicitly reset the session before starting a fresh one.",
            state(),
          ),
        );
        return;
      }
      if (
        queue.filter((task) => task.summary.status === "queued").length >=
        QUEUE_LIMIT
      )
        throw new BridgeError("TC_CONTROL_QUEUE_FULL", 429);
      prune();
      let finish!: (value: Envelope) => void;
      const task: Task = {
        summary: {
          taskId: id,
          status: "queued",
          commandType: command.type,
          generation,
          createdAt: Date.now(),
        },
        command,
        done: new Promise((resolve) => {
          finish = resolve;
        }),
        finish: (value) => finish(value),
      };
      tasks.set(id, task);
      history.set(id, task.summary);
      queue.push(task);
      task.timer = setTimeout(
        () =>
          terminate(
            task,
            "timed_out",
            task.summary.status === "queued"
              ? "TC_CONTROL_QUEUE_TIMEOUT"
              : "TC_CONTROL_TASK_TIMEOUT",
          ),
        timeoutMs,
      );
      const disconnected = () => {
        if (!res.writableEnded)
          terminate(task, "cancelled", "TC_CONTROL_CLIENT_DISCONNECTED");
      };
      res.once("close", disconnected);
      void drain();
      const payload = await task.done;
      res.off("close", disconnected);
      writeJSON(
        res,
        payload.status === "timed_out"
          ? 504
          : payload.status === "failed"
            ? 422
            : 200,
        payload,
      );
    } catch (error) {
      const known =
        error instanceof BridgeError
          ? error
          : new BridgeError("TC_CONTROL_REQUEST_FAILED", 500);
      writeJSON(
        res,
        known.httpStatus,
        failed(
          id,
          known.code,
          "Control request could not be completed. Check the command, request limits and local development server.",
        ),
      );
    }
  }
  const middleware = (
    req: IncomingMessage,
    res: ServerResponse,
    next: () => void,
  ) => {
    const route = req.url?.split("?", 1)[0];
    if (
      ![
        "/__threecat/control",
        "/__threecat/status",
        "/__threecat/cancel",
        "/__threecat/session",
      ].includes(route ?? "")
    ) {
      next();
      return;
    }
    void handle(req, res, route!);
  };
  // Prepend so GET status cannot be swallowed by Vite's already-installed SPA fallback.
  const layer = { route: "", handle: middleware };
  server.middlewares.stack.unshift(layer);
  const onServerClose = () => {
    void close().catch(() => undefined);
  };
  server.httpServer.once("close", onServerClose);
  function close(): Promise<void> {
    if (closePromise) return closePromise;
    closed = true;
    if (active?.summary.status === "running")
      terminate(active, "cancelled", "TC_CONTROL_CLOSED");
    else discard();
    const index = server.middlewares.stack.indexOf(layer);
    if (index >= 0) server.middlewares.stack.splice(index, 1);
    server.httpServer?.off("close", onServerClose);
    closePromise = waitForCleanup().then((ok) => {
      if (!ok)
        throw new Error(
          "TC_CONTROL_CLEANUP_PENDING: Owned browser cleanup did not complete.",
        );
    });
    return closePromise;
  }
  return { close };
}
