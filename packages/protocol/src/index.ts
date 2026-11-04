/** Shared transport schemas. No browser automation or GPU objects leak through this boundary. */
export const PROTOCOL_VERSION = "0.1.0" as const;
export type TaskStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "timed_out";
export interface ProtocolDiagnostic {
  code: string;
  severity: "error" | "warning" | "info";
  message: string;
  remediation: string;
  source?: { file: string; line: number; column: number };
}
export interface Artifact {
  type: string;
  path: string;
  bytes?: number;
  sha256?: string;
}
export interface Envelope<T = unknown> {
  protocolVersion: typeof PROTOCOL_VERSION;
  taskId: string;
  status: TaskStatus;
  diagnostics: ProtocolDiagnostic[];
  artifacts: Artifact[];
  data: T;
}
export function result<T>(
  taskId: string,
  status: TaskStatus,
  data: T,
  diagnostics: ProtocolDiagnostic[] = [],
  artifacts: Artifact[] = [],
): Envelope<T> {
  return {
    protocolVersion: PROTOCOL_VERSION,
    taskId,
    status,
    diagnostics,
    artifacts,
    data,
  };
}
export type ControlCommand =
  | { type: "inspect"; entity?: string; offset?: number; limit?: number }
  | { type: "step"; count: number }
  | { type: "pause" }
  | { type: "resume" }
  | { type: "snapshot" }
  | { type: "capture" }
  | { type: "recordStart" }
  | { type: "recordStop" }
  | { type: "recordCancel" }
  | { type: "replay"; trace: unknown }
  | { type: "restore"; snapshot: unknown }
  | { type: "input"; key: string; pressed: boolean }
  | {
      type: "setComponent";
      entity: string;
      component: string;
      value: Record<string, unknown>;
    }
  | { type: "mode"; mode: "raster" | "hybrid" | "path" };
export function parseCommand(value: unknown): ControlCommand {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("TC_PROTOCOL_COMMAND: Expected an object.");
  const v = value as Record<string, unknown>;
  if (typeof v.type !== "string")
    throw new Error("TC_PROTOCOL_COMMAND: Missing command type.");
  const requireKeys = (keys: string[]) => {
    for (const key of Object.keys(v))
      if (!["type", ...keys].includes(key))
        throw new Error(`TC_PROTOCOL_FIELD: Unknown command field ${key}.`);
  };
  switch (v.type) {
    case "inspect":
      requireKeys(["entity", "offset", "limit"]);
      if (
        v.entity !== undefined &&
        (typeof v.entity !== "string" ||
          !v.entity.length ||
          v.entity.length > 256)
      )
        throw new Error("TC_PROTOCOL_ENTITY: Invalid entity id.");
      if (
        v.offset !== undefined &&
        (!Number.isSafeInteger(v.offset) || Number(v.offset) < 0)
      )
        throw new Error("TC_PROTOCOL_PAGE: Invalid offset.");
      if (
        v.limit !== undefined &&
        (!Number.isInteger(v.limit) ||
          Number(v.limit) < 1 ||
          Number(v.limit) > 1000)
      )
        throw new Error("TC_PROTOCOL_PAGE: limit must be in [1,1000].");
      break;
    case "pause":
    case "resume":
    case "snapshot":
    case "capture":
    case "recordStart":
    case "recordStop":
    case "recordCancel":
      requireKeys([]);
      break;
    case "replay":
      requireKeys(["trace"]);
      if (!v.trace || typeof v.trace !== "object")
        throw new Error("TC_PROTOCOL_TRACE: trace is required.");
      break;
    case "step":
      requireKeys(["count"]);
      if (
        !Number.isInteger(v.count) ||
        Number(v.count) < 1 ||
        Number(v.count) > 10000
      )
        throw new Error(
          "TC_PROTOCOL_STEPS: count must be an integer in [1,10000].",
        );
      break;
    case "restore":
      requireKeys(["snapshot"]);
      if (!v.snapshot || typeof v.snapshot !== "object")
        throw new Error("TC_PROTOCOL_SNAPSHOT: snapshot is required.");
      break;
    case "input":
      requireKeys(["key", "pressed"]);
      if (
        typeof v.key !== "string" ||
        v.key.length > 64 ||
        typeof v.pressed !== "boolean"
      )
        throw new Error("TC_PROTOCOL_INPUT: Expected key and pressed.");
      break;
    case "setComponent":
      requireKeys(["entity", "component", "value"]);
      if (
        typeof v.entity !== "string" ||
        typeof v.component !== "string" ||
        !v.value ||
        typeof v.value !== "object" ||
        Array.isArray(v.value)
      )
        throw new Error(
          "TC_PROTOCOL_COMPONENT: Expected entity, component and value.",
        );
      break;
    case "mode":
      requireKeys(["mode"]);
      if (!["raster", "hybrid", "path"].includes(String(v.mode)))
        throw new Error("TC_PROTOCOL_MODE: Unknown render mode.");
      break;
    default:
      throw new Error(`TC_PROTOCOL_COMMAND: Unknown command ${v.type}.`);
  }
  return v as ControlCommand;
}
