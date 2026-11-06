import test from "node:test";
import assert from "node:assert/strict";
import { assertMaterialGraphValues, makeMaterialGraphFixture } from "../tools/m3-material-graph-gpu-probe.ts";

test("graph fixture updates, clamps and rejects invalid values", () => {
  const first = makeMaterialGraphFixture([0.25, 0.75]);
  const second = makeMaterialGraphFixture([1.5, -0.25]);
  assert.equal(first.count, 4);
  assert.deepEqual(first.expected.slice(0, 8), [0.2, 0.25, 0.2, 1, 1, 2, 3, 1]);
  assert.deepEqual(second.expected.slice(0, 4), [0.8, 1, 0.8, 0]);
  assert.deepEqual(second.expected.slice(16, 20), [0, 0, 0, 1]);
  assert.notDeepEqual(first.table, second.table);
  assertMaterialGraphValues(first.expected, first.expected);
  assert.throws(() => assertMaterialGraphValues([NaN], [0]));
  assert.throws(() => assertMaterialGraphValues([0], [1]));
  assert.throws(() => makeMaterialGraphFixture([Infinity, 0]), /TC_GRAPH_VALUE/);
  assert.throws(() => makeMaterialGraphFixture([1e100, 0]), /TC_GRAPH_VALUE/);
});
