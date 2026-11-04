import test from "node:test";
import assert from "node:assert/strict";
import { parseCommand, result } from "../packages/protocol/src/index.ts";
import { assertJSON } from "../packages/runtime/src/error.ts";

test("control protocol accepts bounded valid operations and rejects ambiguous malformed input", () => {
  assert.deepEqual(parseCommand({ type: "step", count: 12 }), {
    type: "step",
    count: 12,
  });
  assert.deepEqual(
    parseCommand({ type: "input", key: "ArrowRight", pressed: true }),
    { type: "input", key: "ArrowRight", pressed: true },
  );
  assert.deepEqual(
    parseCommand({ type: "inspect", entity: "player", offset: 0, limit: 100 }),
    { type: "inspect", entity: "player", offset: 0, limit: 100 },
  );
  for (const command of [
    null,
    [],
    { type: "step", count: Infinity },
    { type: "step", count: -1 },
    { type: "step", count: 0.5 },
    { type: "inspect", typo: true },
    { type: "inspect", offset: -1 },
    { type: "inspect", limit: 0 },
    { type: "inspect", limit: 1001 },
    { type: "inspect", entity: "" },
    { type: "mode", mode: "webgl" },
    { type: "input", key: 3, pressed: true },
    { type: "setComponent", entity: "a", component: "Health", value: [] },
    { type: "unknown" },
  ])
    assert.throws(() => parseCommand(command), /TC_PROTOCOL_/);
});
test("JSON state validation rejects cycles, nonfinite data, executable values and special keys", () => {
  assert.doesNotThrow(() => assertJSON({ a: [1, true, null, "ok"] }));
  const shared = { a: 1 };
  assert.doesNotThrow(() => assertJSON([shared, shared]));
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  for (const value of [
    circular,
    { a: NaN },
    { a: undefined },
    { a() {} },
    new Date(),
    JSON.parse('{"__proto__":1}'),
  ])
    assert.throws(() => assertJSON(value), /TC_STATE_/);
  assert.equal(
    result("check-1", "failed", null, [
      { code: "TC_X", severity: "error", message: "x", remediation: "fix" },
    ]).diagnostics[0].code,
    "TC_X",
  );
});
