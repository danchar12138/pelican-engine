import test from 'node:test';
import assert from 'node:assert/strict';
import { BSDF_SHADER, evaluateBsdf, bsdfPdf, sampleBsdf } from '../packages/renderer/src/bsdf.ts';

const n = [0, 0, 1] as const, base = [0.2, 0.4, 0.6] as const;
const color = [1, 0.3, 0.1] as const;
test('physical specular closed form and sampling consistency', () => {
  for (const intensity of [0, 0.4, 1]) for (const cosine of [1, 0.01]) for (const metal of [0, 0.5, 1]) {
    const v = [Math.sqrt(1 - cosine * cosine), 0, cosine] as const;
    const actual = evaluateBsdf(n, v, v, base, 0.35, metal, 1.5, intensity, color);
    const alpha = 0.35 ** 2;
    const denominator = 1 - cosine * cosine + alpha * alpha * cosine * cosine;
    const distribution = alpha * alpha / (Math.PI * denominator * denominator);
    const visibility = 0.25 / (cosine * Math.sqrt(alpha * alpha + (1 - alpha * alpha) * cosine * cosine));
    for (let i = 0; i < 3; i++) {
      const f0 = 0.04 * color[i] * intensity * (1 - metal) + base[i] * metal;
      const f90 = intensity * (1 - metal) + metal;
      const fv = f0 + (f90 - f0) * (1 - cosine) ** 5;
      const expected = f0 * distribution * visibility + base[i] * (1 - metal) * (1 - fv) ** 2 / Math.PI;
      assert.ok(Math.abs(actual[i] - expected) < 1e-9 * Math.max(1, Math.abs(expected)));
    }
    for (const branch of [0.01, 0.9]) {
      const s = sampleBsdf(n, v, base, 0.35, metal, [branch, 0.3, 0.4], 1.5, intensity, color);
      if (!s.pdf) continue;
      assert.ok(Math.abs(s.pdf - bsdfPdf(n, v, s.direction, base, 0.35, metal, 1.5, intensity, color)) < 1e-12);
      const f = evaluateBsdf(n, v, s.direction, base, 0.35, metal, 1.5, intensity, color);
      for (let i = 0; i < 3; i++) assert.ok(Math.abs(s.weight[i] - f[i] * s.direction[2] / s.pdf) < 1e-10);
    }
  }
  assert.deepEqual(evaluateBsdf(n, n, n, base, 0.35, 1, 1.5, 0, color), evaluateBsdf(n, n, n, base, 0.35, 1));
  assert.throws(() => evaluateBsdf(n, n, n, base, 0.35, 0, 1.5, NaN, color), /specularIntensity/);
});

test('defaults remain identical and WGSL exposes specular plus legacy wrappers', () => {
  const v = [0.6, 0, 0.8] as const;
  const random = [0.4, 0.3, 0.4] as const;
  for (const metal of [0, 0.5, 1]) {
    assert.deepEqual(evaluateBsdf(n, v, n, base, 0.35, metal), evaluateBsdf(n, v, n, base, 0.35, metal, 1.5, 1, [1, 1, 1]));
    assert.equal(bsdfPdf(n, v, n, base, 0.35, metal), bsdfPdf(n, v, n, base, 0.35, metal, 1.5, 1, [1, 1, 1]));
    assert.deepEqual(sampleBsdf(n, v, base, 0.35, metal, random), sampleBsdf(n, v, base, 0.35, metal, random, 1.5, 1, [1, 1, 1]));
  }
  for (const name of ['Evaluate', 'Pdf', 'Sample']) {
    assert.match(BSDF_SHADER, new RegExp(`fn bsdf${name}Specular\\([^)]*ior:f32,intensity:f32,color:vec3f\\)`));
    assert.match(BSDF_SHADER, new RegExp(`fn bsdf${name}Ior\\([^)]*\\)[^{]*\\{return bsdf${name}Specular\\([^;]*ior,1\\.0,vec3f\\(1\\)\\);\\}`));
  }
  assert.throws(() => bsdfPdf(n, n, n, base, 0.35, 0, 1.5, -0.1, color), /specular/);
  assert.throws(() => sampleBsdf(n, n, base, 0.35, 0, random, 1.5, 1, [0, 2, 1]), /specular/);
});
