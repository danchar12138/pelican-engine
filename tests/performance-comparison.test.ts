import assert from "node:assert/strict";
import test from "node:test";
import { summarizeGpu } from "../tools/m3-performance-comparison.ts";

test("GPU distributions sort without mutating samples and use pooled-style medians", () => {
  const samples = [4, 1, 3, 2];
  assert.deepEqual(summarizeGpu(samples), {
    count: 4,
    unknownCount: 0,
    min: 1,
    max: 4,
    mean: 2.5,
    median: 2.5,
    p95: 4,
  });
  assert.deepEqual(samples, [4, 1, 3, 2]);
  assert.equal(summarizeGpu([3, 1, 2]).median, 2);
  assert.equal(summarizeGpu([0]).median, 0);
  assert.equal(
    summarizeGpu(Array.from({ length: 100 }, (_, i) => i + 1)).p95,
    95,
  );
});

test("missing, invalid and nonfinite GPU timings stay unknown", () => {
  const empty = {
    count: 0,
    unknownCount: 0,
    min: null,
    max: null,
    mean: null,
    median: null,
    p95: null,
  };
  assert.deepEqual(summarizeGpu([]), empty);
  for (const value of [
    null,
    undefined,
    "2",
    {},
    false,
    NaN,
    Infinity,
    -Infinity,
    -1,
  ])
    assert.deepEqual(summarizeGpu(value), { ...empty, unknownCount: 1 });
  assert.deepEqual(summarizeGpu([null, NaN, Infinity, -1, "4", 2, 4]), {
    count: 2,
    unknownCount: 5,
    min: 2,
    max: 4,
    mean: 3,
    median: 3,
    p95: 4,
  });
  assert.ok(
    Number.isFinite(summarizeGpu([Number.MAX_VALUE, Number.MAX_VALUE]).mean),
  );
});
