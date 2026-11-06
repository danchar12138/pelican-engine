import test from "node:test";
import assert from "node:assert/strict";
import { buildEnvironmentImportance } from "../packages/renderer/src/environment-importance.ts";
test("environment alias density integrates to one on a sphere and preserves nonuniform luminance energy", () => {
  const data = new Float32Array(8 * 4 * 4);
  for (let index = 0; index < data.length; index += 4)
    data.set([1, 1, 1, 1], index);
  const uniform = buildEnvironmentImportance(data, 8, 4);
  let probability = 0,
    area = 0;
  for (let index = 0; index < uniform.table.length; index += 4) {
    probability += uniform.table[index];
    area += uniform.table[index + 3];
    assert.ok(
      Math.abs(
        uniform.table[index] / uniform.table[index + 3] - 1 / (4 * Math.PI),
      ) < 1e-8,
    );
  }
  assert.ok(Math.abs(probability - 1) < 1e-6);
  assert.ok(Math.abs(area - 4 * Math.PI) < 1e-6);
  assert.ok(Math.abs(uniform.integralLuminance - 4 * Math.PI) < 1e-10);
  data.set([20, 20, 20, 1], (2 * 8 + 3) * 4);
  const bright = buildEnvironmentImportance(data, 8, 4);
  assert.ok(bright.table[(2 * 8 + 3) * 4] > uniform.table[(2 * 8 + 3) * 4] * 5);
});
test("alias sampling frequencies match target probabilities without fixed-direction holes", () => {
  const data = new Float32Array(16 * 8 * 4);
  for (let y = 0; y < 8; y++)
    for (let x = 0; x < 16; x++)
      data.set([1 + x + y, 1 + x + y, 1 + x + y, 1], (y * 16 + x) * 4);
  const result = buildEnvironmentImportance(data, 16, 8),
    bins = new Uint32Array(128);
  let seed = 0x12345678;
  for (let sample = 0; sample < 200000; sample++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const random = (seed / 4294967296) * 128,
      index = Math.floor(random),
      selected =
        random - index < result.table[index * 4 + 2]
          ? index
          : result.table[index * 4 + 1];
    bins[selected]++;
  }
  for (let index = 0; index < 128; index++)
    assert.ok(Math.abs(bins[index] / 200000 - result.table[index * 4]) < 0.002);
});
test("black maps stay well-defined while invalid source radiance never becomes a fake proposal", () => {
  const result = buildEnvironmentImportance(new Float32Array(16), 2, 2);
  assert.equal(result.integralLuminance, 0);
  assert.equal(result.table[0], 0.25);
  assert.throws(
    () => buildEnvironmentImportance(new Float32Array([NaN, 0, 0, 1]), 1, 1),
    /TC_ENVIRONMENT_RADIANCE/,
  );
  assert.throws(
    () => buildEnvironmentImportance(new Float32Array([0, -1, 0, 1]), 1, 1),
    /TC_ENVIRONMENT_RADIANCE/,
  );
});
