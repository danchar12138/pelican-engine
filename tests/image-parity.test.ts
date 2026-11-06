import test from "node:test";
import assert from "node:assert/strict";
import { linearImageDifference } from "../tools/m3-parity-probe.ts";

test("linear parity compares HDR RGB without confusing sample counts with opacity", () => {
  const a = [0, 1, 10, 64, 2, 3, 4, 64];
  assert.deepEqual(linearImageDifference(a, a), {
    maximumAbsolute: 0,
    meanAbsolute: 0,
    relativeL1: 0,
    reinhardRmse: 0,
    fields: 6,
  });
  const b = [...a];
  b[2] = 11;
  const difference = linearImageDifference(a, b);
  assert.equal(difference.maximumAbsolute, 1);
  assert.equal(difference.meanAbsolute, 1 / 6);
  assert.equal(difference.relativeL1, 1 / 20);
  assert.ok(Math.abs(difference.reinhardRmse - 1 / 132 / Math.sqrt(6)) < 1e-12);
});
test("parity cannot silently compare malformed, nonfinite, negative or differently accumulated images", () => {
  for (const [a, b] of [
    [[], []],
    [
      [1, 2, 3],
      [1, 2, 3],
    ],
    [[1, 2, 3, 1], []],
    [
      [NaN, 2, 3, 1],
      [1, 2, 3, 1],
    ],
    [
      [-1, 2, 3, 1],
      [1, 2, 3, 1],
    ],
    [
      [1, 2, 3, 1],
      [1, 2, 3, 2],
    ],
  ])
    assert.throws(() => linearImageDifference(a, b));
});
