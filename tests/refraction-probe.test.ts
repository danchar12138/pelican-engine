import test from "node:test";
import assert from "node:assert/strict";
import {
  assertBeerSample,
  linearAttenuation,
  refractionDifference,
  REFRACTION_SCENES,
} from "../tools/m3-refraction-probe.ts";

test("Beer probe checks linear world-distance attenuation, not sRGB or a missing shadow segment", () => {
  const color = linearAttenuation();
  assert.ok(Math.abs(color[0] - 0.21586050011389926) < 1e-12);
  assertBeerSample(color, 1);
  assertBeerSample(
    color.map((value) => value ** 2),
    2,
  );
  assert.throws(() => assertBeerSample(color, 2));
  assert.throws(() => assertBeerSample([128 / 255, 192 / 255, 224 / 255], 1));
  assert.throws(() => assertBeerSample([NaN, 1, 1], 1));
  assert.throws(() => assertBeerSample([1, 1], 1));
});
test("optical comparison isolates RGB in a fixed central ROI and rejects malformed or nonfinite input", () => {
  const a = Array(16 * 4).fill(0),
    b = Array(16 * 4).fill(0);
  for (let pixel = 0; pixel < 16; pixel++) {
    b[pixel * 4] = 0.3;
    b[pixel * 4 + 3] = 99;
  }
  assert.ok(Math.abs(refractionDifference(a, b, 4, 4) - 0.1) < 1e-12);
  assert.equal(refractionDifference(b, b, 4, 4), 0);
  assert.throws(() => refractionDifference([], b, 4, 4));
  assert.throws(() => refractionDifference(a, b, 0, 4));
  b[(1 * 4 + 1) * 4] = NaN;
  assert.throws(() => refractionDifference(a, b, 4, 4));
});
test("refraction scene matrix includes closed, nested, refractive, rough, scaled, translated and finite-light paths", () => {
  assert.equal(REFRACTION_SCENES.length, 12);
  assert.equal(new Set(REFRACTION_SCENES).size, 12);
  for (const scene of [
    "nested-inside",
    "rough-optics",
    "small-optics",
    "translated-optics",
    "lit-absorbing",
  ])
    assert.ok(REFRACTION_SCENES.some((value) => value === scene));
});
