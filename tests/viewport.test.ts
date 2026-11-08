import test from "node:test";
import assert from "node:assert/strict";
import { resolveViewport } from "../packages/renderer/src/viewport.ts";

test("viewport follows native DPR and mobile dimensions without reducing quality", () => {
  assert.deepEqual(resolveViewport("", 390, 844, 2), { width: 780, height: 1688, cssWidth: 390, cssHeight: 844, pixelRatio: 2, fixed: false });
  assert.deepEqual(resolveViewport("?width=960&height=540", 390, 844, 2), { width: 960, height: 540, cssWidth: 960, cssHeight: 540, pixelRatio: 1, fixed: true });
  for (const query of ["?width=300", "?height=400", "?width=0&height=4", "?width=NaN&height=4"]) assert.throws(() => resolveViewport(query, 390, 844, 2), /TC_VIEWPORT_SIZE/);
  assert.throws(() => resolveViewport("", 10000, 10000, 2), /No resolution reduction/);
});
