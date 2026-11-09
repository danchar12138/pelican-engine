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
  /** Legacy compiler alias, retained during 1.x normalization. */
  suggestion?: string;
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
    diagnostics: diagnostics.map(normalizeDiagnostic),
    artifacts,
    data,
  };
}
export const INSPECT_FIELDS = ["summary", "assets", "compiledIR", "rendering", "metrics", "runtime", "game", "resources", "gameplay", "capabilities", "errors", "iteration", "viewport", "adapter", "frameClock"] as const;
export type InspectField = typeof INSPECT_FIELDS[number];
export type ControlCommand =
  | { type: "inspect"; entity?: string; offset?: number; limit?: number; summary?: boolean; fields?: readonly InspectField[] }
  | { type: "step"; count: number }
  | { type: "pause" }
  | { type: "resume" }
  | { type: "reload"; restart?: boolean }
  | { type: "prepareRender"; mode: "raster" | "hybrid" | "path" }
  | { type: "snapshot" }
  | { type: "capture"; facts?: boolean }
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
      requireKeys(["entity", "offset", "limit", "summary", "fields"]);
      if (v.summary !== undefined && typeof v.summary !== "boolean") throw new Error("TC_PROTOCOL_INSPECT: summary must be boolean.");
      if (v.fields !== undefined && (!Array.isArray(v.fields) || !v.fields.length || v.fields.length > INSPECT_FIELDS.length || new Set(v.fields).size !== v.fields.length || v.fields.some(f => !INSPECT_FIELDS.includes(f)))) throw new Error("TC_PROTOCOL_INSPECT: fields must be unique known inspect fields.");
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
    case "recordStart":
    case "recordStop":
    case "recordCancel":
      requireKeys([]);
      break;
    case "capture":
      requireKeys(["facts"]);
      if (v.facts !== undefined && typeof v.facts !== "boolean") throw new Error("TC_PROTOCOL_CAPTURE: facts must be boolean.");
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

/** One diagnostic vocabulary while retaining all compiler/runtime context and legacy aliases. */
export function normalizeDiagnostic(value: unknown): ProtocolDiagnostic {
  const d = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const code = typeof d.code === "string" ? d.code : "TC_UNKNOWN";
  return { ...d, code, severity: ["error","warning","info"].includes(String(d.severity)) ? d.severity as ProtocolDiagnostic["severity"] : "error",
    message: String(d.message ?? value), remediation: String(d.remediation ?? d.suggestion ?? remediationFor(code)) };
}
export const EXIT_CODES = { success: 0, usage: 1, check: 2, environment: 3 } as const;
/** Cancellation and transport timeout leave state uncertain: environment (3), not assertion failure. */
export function exitCodeFor(envelope: Pick<Envelope, "status" | "diagnostics">): number {
  if (["succeeded","queued","running"].includes(envelope.status)) return EXIT_CODES.success;
  if (["cancelled","timed_out"].includes(envelope.status)) return EXIT_CODES.environment;
  const codes = envelope.diagnostics.map(d => d.code);
  if (codes.some(c => /^TCENV_|^TCSETUP_|^TC_ENVIRONMENT_(?:ENOENT|EACCES|EPERM|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|ENOSPC)$|^TC_CLI_FAILURE$|TIMEOUT|OFFLINE|UNAVAILABLE|DEPENDENCY_MISSING|BROWSER_(?:MISSING|LAUNCH|OFFLINE)|NETWORK|ECONN|ENOENT|CONTROL_(FETCH|REQUEST|SESSION|CLOSED|CLEANUP)/.test(c))) return EXIT_CODES.environment;
  if (codes.some(c => /PROTOCOL_|CLI_|QUERY|RECIPE_ID|TASK_UNKNOWN|CAPABILITY_|COMMAND_INVALID|COMMAND_UNKNOWN|CREATE_|API_|RECIPE_|USAGE/.test(c))) return EXIT_CODES.usage;
  return EXIT_CODES.check;
}
/** Shared server limits and documentation inputs. Commands themselves remain ControlCommand. */
export const CONTROL_HTTP = { bodyLimit: 1048576, timeoutMinMs: 10, timeoutMaxMs: 120000,
  versionHeader: "x-pelican-protocol-version", routes: {
    command: {method:"POST",path:"/__pelican/control"}, status:{method:"GET",path:"/__pelican/status"},
    cancel:{method:"POST",path:"/__pelican/cancel"}, session:{method:"POST",path:"/__pelican/session"}
  } } as const;

export function remediationFor(code:string):string {
 if(/CONTROL_.*(TIMEOUT|CANCEL|SESSION|UNAVAILABLE)/.test(code))return "Run pelican status --port <port>; confirm the task ID and sessionNeedsReset, then pelican reset-session --port <port> before retrying discarded work.";
 if(/RECIPE|CREATE/.test(code))return "Run pelican guide --compact --goal <task>; query recipe --id <id>, then create in an empty game directory. Preserve existing files.";
 if(/RENDER|GPU/.test(code))return "Run pelican inspect --summary and pelican diagnose; query pelican capabilities --feature render.quality for actual backend and limits. Select raster explicitly when tracing is unavailable.";
 if(/TYPESCRIPT|TS_|TYPE/.test(code))return "Fix the referenced file/line using pelican api --symbol Type.member, then rerun pelican check. A type fix is not runtime acceptance.";
 return "Inspect the referenced source and query pelican guide --compact; use pelican api --symbol Type.member for the exact contract.";
}
