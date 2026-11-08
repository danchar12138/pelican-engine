import test from "node:test";
import assert from "node:assert/strict";
import { resolveViewport, presentationSize } from "../packages/renderer/src/viewport.ts";

test("viewport follows native DPR and mobile dimensions without reducing quality", () => {
  assert.deepEqual(resolveViewport("", 390, 844, 2), { width: 780, height: 1688, cssWidth: 390, cssHeight: 844, pixelRatio: 2, fixed: false });
  assert.deepEqual(resolveViewport("?width=960&height=540", 390, 844, 2), { width: 960, height: 540, cssWidth: 960, cssHeight: 540, pixelRatio: 1, fixed: true });
  for (const query of ["?width=300", "?height=400", "?width=0&height=4", "?width=NaN&height=4"]) assert.throws(() => resolveViewport(query, 390, 844, 2), /TC_VIEWPORT_SIZE/);
  assert.throws(() => resolveViewport("", 10000, 10000, 2), /No resolution reduction/);
});
test("world UI keeps CSS coordinates when the raster canvas is hidden by path or hybrid presentation", () => {
  const physical = { x: 960, y: 540 };
  assert.deepEqual(presentationSize(physical, { getBoundingClientRect: () => ({ width: 0, height: 0 }), style: { width: "480px", height: "270px" } }), { width: 480, height: 270 });
  assert.deepEqual(presentationSize(physical, { getBoundingClientRect: () => ({ width: 480, height: 270 }), style: { width: "100%", height: "100%" } }), { width: 480, height: 270 });
  assert.deepEqual(presentationSize(physical), { width: 960, height: 540 });
});
