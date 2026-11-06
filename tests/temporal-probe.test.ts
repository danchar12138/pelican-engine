import test from "node:test";
import assert from "node:assert/strict";
import {
  compareTemporalPixels,
  temporalImageMse,
} from "../tools/m3-temporal-probe.ts";
test("temporal parity checks every scalar including effective counts and rejects nonfinite values", () => {
  assert.equal(
    compareTemporalPixels([1, 2, 3, 8], new Float32Array([1, 2, 3, 8])).scaled,
    0,
  );
  assert.throws(() => compareTemporalPixels([1, 2, 3, 9], [1, 2, 3, 8]));
  assert.throws(() => compareTemporalPixels([NaN, 2, 3, 8], [1, 2, 3, 8]));
  assert.throws(() => compareTemporalPixels([1], [1, 2]));
});
test("temporal quality uses display-domain nonnegative RGB, never sample counts", () => {
  assert.equal(temporalImageMse([1, 2, 3, 1], [1, 2, 3, 256]), 0);
  assert.equal(temporalImageMse([-1, 0, 0, 1], [0, 0, 0, 2]), 0);
  assert.ok(temporalImageMse([2, 2, 2, 1], [1, 1, 1, 256]) > 0);
  assert.throws(() => temporalImageMse([Infinity, 0, 0, 1], [1, 1, 1, 1]));
});
