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
  /** Optional discovery recovery; navigation choices are not implementation claims. */
  candidates?: readonly { kind: "task"; id: string; query: string; matchedIntent: boolean }[];
  source?: { file: string; line: number; column: number };
  causeCodes?: string[];
  tick?: number;
  stage?: string;
  system?: string;
  entity?: string;
  resource?: string;
  partialState?: boolean;
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
  | { type: "reload"; restart?: boolean }
  | { type: "prepareRender"; mode: "raster" | "hybrid" | "path" }
  | { type: "snapshot" }
  | { type: "capture" }
  | { type: "render"; samples: number; mode: "hybrid" | "path"; denoise?: boolean }
  | { type: "pointer"; x: number; y: number; buttons: number; delta?: readonly [number, number]; wheel?: readonly [number, number] }
  | { type: "batch"; commands: readonly ControlCommand[] }
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
    case "prepareRender":
      requireKeys(["mode"]);
      if (!["raster", "hybrid", "path"].includes(String(v.mode))) throw new Error("TC_PROTOCOL_MODE: prepareRender requires raster, hybrid or path.");
      break;
    case "reload":
      requireKeys(["restart"]);
      if (v.restart !== undefined && typeof v.restart !== "boolean")
        throw new Error("TC_PROTOCOL_RELOAD: restart must be boolean.");
      break;
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
    case "batch":
      requireKeys(["commands"]);
      if (!Array.isArray(v.commands) || !v.commands.length || v.commands.length > 32 || v.commands.some(command => !command || typeof command !== "object" || (command as { type?: unknown }).type === "batch"))
        throw new Error("TC_PROTOCOL_BATCH: Supply 1..32 non-nested commands. Completed operations are not rolled back on runtime failure.");
      for (const command of v.commands) parseCommand(command);
      break;
    case "pointer":
      requireKeys(["x", "y", "buttons", ...(Object.hasOwn(v, "delta") ? ["delta"] : []), ...(Object.hasOwn(v, "wheel") ? ["wheel"] : [])]);
      if (![v.x, v.y].every(n => typeof n === "number" && Number.isFinite(n) && Math.abs(n) <= 1e6) || !Number.isInteger(v.buttons) || (v.buttons as number) < 0 || (v.buttons as number) > 31 ||
          [v.delta, v.wheel].some(value => value !== undefined && (!Array.isArray(value) || value.length !== 2 || value.some(n => typeof n !== "number" || !Number.isFinite(n) || Math.abs(n) > 1e6))))
        throw new Error("TC_PROTOCOL_POINTER: Expected canvas-local CSS x/y, button mask 0..31 and finite delta/wheel pairs.");
      break;
    case "render":
      requireKeys(["samples", "mode", ...(Object.hasOwn(v, "denoise") ? ["denoise"] : [])]);
      if (!Number.isSafeInteger(v.samples) || (v.samples as number) < 1 || (v.samples as number) > 4096 || !["hybrid", "path"].includes(String(v.mode)) ||
          (v.denoise !== undefined && typeof v.denoise !== "boolean")) throw new Error("TC_PROTOCOL_RENDER: Expected 1..4096 samples, hybrid/path mode and optional denoise boolean.");
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
