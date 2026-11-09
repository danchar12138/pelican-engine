# Local HTTP control protocol

Generated from packages/protocol/src/index.ts. Do not edit command declarations here.

Protocol version: 0.1.0. Responses are one JSON Envelope per request: protocolVersion, taskId, status, diagnostics, artifacts, data. CLI defaults to JSON; --json is a compatibility no-op. dev emits newline-delimited lifecycle/build envelopes; no prose is written to stdout.

- POST /__pelican/control
- GET /__pelican/status
- POST /__pelican/cancel
- POST /__pelican/session

Commands use the original command object as the entire body, without a wrapping envelope. Optional header x-pelican-protocol-version validates an exact version; omission remains compatible. Explicit incompatible versions return HTTP 409 / TC_PROTOCOL_VERSION_UNSUPPORTED before any command executes.

## File requests

Write request.json containing {"type":"inspect","summary":true}, then run:

~~~sh
curl --request POST http://127.0.0.1:4173/__pelican/control --header "Content-Type: application/json" --header "x-pelican-protocol-version: 0.1.0" --data-binary @request.json
~~~

For a batch file use valid JSON: {"type":"batch","commands":[{"type":"pause"},{"type":"step","count":3},{"type":"inspect","summary":true}]}. For restore, the snapshot field is the snapshot object, not the CLI response envelope. Save CLI snapshot data with --output, then compose {type:restore,snapshot:<object>} using JSON quotes. Use the curl executable (curl.exe if the shell aliases curl). The HTTP examples require optional curl; normal author commands only need Node/npm.

## Command parameters

~~~ts
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
~~~

inspect fields: summary, assets, compiledIR, rendering, metrics, runtime, game, resources, gameplay, capabilities, errors, iteration, viewport, adapter, frameClock. summary/fields are opt-in; no fields preserves the full legacy response. Pagination controls entity records; explicitly selecting compiledIR retains it even with limit. The assets field selects only asset IDs/hashes needed for duplicate-content diagnosis. selection marks unavailable fields and list truncation. status reports control-session metadata, not game health; diagnose analyzes observations.

## Limits and failures

Body limit: 1048576 bytes, including chunked requests. JSON Content-Type required; compression rejected. Timeout is a server attach option (10..120000 ms; default 30000), not an extra command field. Queue time counts. Batch accepts 1..32 nonnested commands, prevalidates all, then executes sequentially; completed operations are not rolled back.

GET status reports bounded task history. Assign x-pelican-task-id before dispatch to correlate failures and cancellation; duplicate IDs fail. POST cancel body {taskId:<id>} cancels a queued task without changing runtime; cancellation/timeout of running work discards its owned browser, marks stateReset and requires explicit POST session body {action:reset}. Reset discards old state and does not imply checkpoint restoration. Cleanup must finish before new commands are admitted. Request disconnect does not prove the command never executed; inspect status before retrying.

Stable codes include TC_CONTROL_BODY_TOO_LARGE (413), TC_CONTROL_BODY_TIMEOUT (408), TC_CONTROL_COMMAND_INVALID (400), TC_CONTROL_SESSION_RESET_REQUIRED (409), TC_CONTROL_TASK_TIMEOUT, TC_CONTROL_TASK_CANCELLED, TC_CONTROL_HOST_REJECTED / TC_CONTROL_ORIGIN_REJECTED (403). Inspect diagnostics and status rather than assuming every HTTP 200 means task success.

CLI exit codes: {"success":0,"usage":1,"check":2,"environment":3}. Check/assertion failures now exit 2; environment, cancellation and timeout exit 3; usage exits 1. This replaces the legacy all-failures=1 behavior; scripts should accept all nonzero failures or adopt the classification.

## Security boundary

Development only; production has no control service/hook. Loopback peer and Host/port are checked. Origin must match when present, cross-site requests and preflights are rejected. The owned control browser restricts external requests; test external services with an explicit author-owned browser. Do not expose this server publicly.
