import test from "node:test";
import assert from "node:assert/strict";
import { neutralPointer, parsePointer, advancePointer } from "../packages/runtime/src/pointer.ts";
import { parseCommand } from "../packages/protocol/src/index.ts";

test("pointer aggregates tick movement, wheel and same-tick press/release edges", () => {
  const down = { ...neutralPointer(), position: [20, 10], buttons: 1, delta: [3, 4] };
  const up = { ...neutralPointer(), position: [23, 14], delta: [2, -1], wheel: [0, 40] };
  const result = advancePointer(neutralPointer(), [down, up]);
  assert.deepEqual(result.delta, [5, 3]); assert.deepEqual(result.wheel, [0, 40]);
  assert.equal(result.buttons, 0); assert.equal(result.pressed, 1); assert.equal(result.released, 1);
  const next = advancePointer(result, []);
  assert.deepEqual(next.delta, [0, 0]); assert.equal(next.pressed, 0); assert.equal(next.released, 0);
  const copy = parsePointer(result); (copy.position as unknown as number[])[0] = 999;
  assert.equal(result.position[0], 23);
});
test("pointer rejects malformed and excessive snapshots before adoption", () => {
  for (const input of [null, {}, { ...neutralPointer(), buttons: 32 }, { ...neutralPointer(), delta: [NaN, 0] },
    { ...neutralPointer(), contacts: [{ id: 1, position: [0, 0], pressure: 2, kind: "touch" }] }]) assert.throws(() => parsePointer(input), /TC_POINTER_EVENT/);
});
test("AI batches validate every command before writes and reject nesting or malformed pointers", () => {
  assert.equal(parseCommand({ type: "batch", commands: [{ type: "pointer", x: 20, y: 30, buttons: 1 }, { type: "step", count: 1 }] }).type, "batch");
  assert.throws(() => parseCommand({ type: "batch", commands: [{ type: "step", count: 1 }, { type: "pointer", x: NaN, y: 1, buttons: 1 }] }), /TC_PROTOCOL_POINTER/);
  assert.throws(() => parseCommand({ type: "batch", commands: [{ type: "batch", commands: [] }] }), /TC_PROTOCOL_BATCH/);
});
