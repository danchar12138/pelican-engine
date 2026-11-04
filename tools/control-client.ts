import { randomUUID } from "node:crypto";
import {
  parseCommand,
  PROTOCOL_VERSION,
  result,
  type ControlCommand,
  type Envelope,
  type TaskStatus,
} from "../packages/protocol/src/index.ts";
import type { ControlStatus } from "./control-server.ts";

export interface ControlClientOptions {
  url: string;
  timeoutMs?: number;
}
export interface ControlSendOptions {
  taskId?: string;
  signal?: AbortSignal;
}
export interface ControlClient {
  send(
    command: ControlCommand,
    options?: ControlSendOptions,
  ): Promise<Envelope>;
  status(): Promise<Envelope<ControlStatus>>;
  cancel(taskId: string): Promise<Envelope>;
  /** Explicit fresh session. Does not claim to preserve the discarded runtime state. */
  reset(): Promise<Envelope>;
}
const MAX_BODY = 1024 * 1024;
const MAX_RESPONSE = 8 * MAX_BODY;
const statuses: TaskStatus[] = [
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
];
function failure(
  taskId: string,
  code: string,
  status: TaskStatus = "failed",
): Envelope {
  return result(taskId, status, { stateUnknown: true }, [
    {
      code,
      severity: "error",
      message:
        "Control request did not yield a confirmed result. Runtime state must not be assumed preserved.",
      remediation:
        "Inspect server task status using the same taskId; explicitly reset the session when its state is discarded or uncertain.",
    },
  ]);
}
function loopback(host: string): boolean {
  return (
    host === "localhost" ||
    host === "[::1]" ||
    /^127(?:\.\d{1,3}){3}$/.test(host)
  );
}
/** Node-side client; imports do not start services, browsers, or command execution. */
export function createControlClient(
  options: ControlClientOptions,
): ControlClient {
  let base: URL;
  try {
    base = new URL(options.url);
  } catch {
    throw new Error(
      "TC_CONTROL_URL_INVALID: Expected a local HTTP development server URL.",
    );
  }
  if (
    base.protocol !== "http:" ||
    !loopback(base.hostname) ||
    base.username ||
    base.password ||
    base.search ||
    base.hash
  )
    throw new Error(
      "TC_CONTROL_URL_INVALID: Expected a loopback HTTP development server URL without credentials.",
    );
  const timeoutMs = options.timeoutMs ?? 35_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 10 || timeoutMs > 120_000)
    throw new Error(
      "TC_CONTROL_TIMEOUT_RANGE: timeoutMs must be an integer in [10,120000].",
    );
  async function request(
    route: string,
    body: unknown,
    sendOptions: ControlSendOptions = {},
  ): Promise<Envelope> {
    const taskId = sendOptions.taskId ?? `control-${randomUUID()}`;
    if (!/^[a-zA-Z0-9_-]{1,96}$/.test(taskId))
      return failure(`control-${randomUUID()}`, "TC_CONTROL_TASK_ID_INVALID");
    let serialized: string | undefined;
    try {
      if (body !== undefined) serialized = JSON.stringify(body);
      if (serialized && Buffer.byteLength(serialized) > MAX_BODY)
        return failure(taskId, "TC_CONTROL_BODY_TOO_LARGE");
    } catch {
      return failure(taskId, "TC_CONTROL_JSON_INVALID");
    }
    const abort = new AbortController();
    const externalAbort = () => abort.abort();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      abort.abort();
    }, timeoutMs);
    sendOptions.signal?.addEventListener("abort", externalAbort, {
      once: true,
    });
    if (sendOptions.signal?.aborted) abort.abort();
    try {
      const response = await fetch(new URL(route, base.origin), {
        method: body === undefined ? "GET" : "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Threecat-Task-Id": taskId,
        },
        body: serialized,
        signal: abort.signal,
        redirect: "error",
        credentials: "omit",
        cache: "no-store",
      });
      if (
        response.headers
          .get("content-type")
          ?.split(";", 1)[0]
          .trim()
          .toLowerCase() !== "application/json"
      ) {
        await response.body?.cancel();
        return failure(taskId, "TC_CONTROL_RESPONSE_INVALID");
      }
      const reader = response.body?.getReader();
      if (!reader) return failure(taskId, "TC_CONTROL_RESPONSE_INVALID");
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > MAX_RESPONSE) {
          await reader.cancel();
          return failure(taskId, "TC_CONTROL_RESPONSE_TOO_LARGE");
        }
        chunks.push(chunk.value);
      }
      const payload = JSON.parse(
        Buffer.concat(chunks).toString("utf8"),
      ) as Envelope;
      if (
        !payload ||
        payload.protocolVersion !== PROTOCOL_VERSION ||
        payload.taskId !== taskId ||
        !statuses.includes(payload.status) ||
        !Array.isArray(payload.diagnostics) ||
        !Array.isArray(payload.artifacts) ||
        !("data" in payload)
      )
        return failure(taskId, "TC_CONTROL_RESPONSE_INVALID");
      if (!response.ok && payload.status === "succeeded")
        return failure(taskId, "TC_CONTROL_RESPONSE_INVALID");
      return payload;
    } catch {
      return failure(
        taskId,
        timedOut
          ? "TC_CONTROL_CLIENT_TIMEOUT"
          : sendOptions.signal?.aborted
            ? "TC_CONTROL_CLIENT_CANCELLED"
            : "TC_CONTROL_TRANSPORT_FAILURE",
        timedOut
          ? "timed_out"
          : sendOptions.signal?.aborted
            ? "cancelled"
            : "failed",
      );
    } finally {
      clearTimeout(timer);
      sendOptions.signal?.removeEventListener("abort", externalAbort);
    }
  }
  return {
    send: async (command, sendOptions) => {
      try {
        parseCommand(command);
      } catch {
        return failure(
          sendOptions?.taskId ?? `control-${randomUUID()}`,
          "TC_CONTROL_COMMAND_INVALID",
        );
      }
      return request("/__threecat/control", command, sendOptions);
    },
    status: () =>
      request("/__threecat/status", undefined) as Promise<
        Envelope<ControlStatus>
      >,
    cancel: (taskId) => request("/__threecat/cancel", { taskId }),
    reset: () => request("/__threecat/session", { action: "reset" }),
  };
}
