import { graphicsLaunchArguments } from "../tools/browser-session.ts";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  DIELECTRIC_SHADER,
  DIELECTRIC_MIN_ALPHA,
  dielectricBeerAttenuation,
  dielectricFresnelCPU,
  dielectricPdfCPU,
  evaluateDielectric,
  sampleDielectric,
  type DielectricMaterial,
  type DielectricVec3,
} from "../packages/renderer/src/dielectric.ts";

const N: DielectricVec3 = [0, 0, 1];
const glass: DielectricMaterial = {
  etaOutside: 1,
  etaInside: 1.5,
  roughness: 0,
};
const dot = (a: DielectricVec3, b: DielectricVec3) =>
  a.reduce((s, x, i) => s + x * b[i], 0);
const scale = (a: DielectricVec3, s: number) =>
  a.map((x) => x * s) as unknown as DielectricVec3;
const viewAt = (z: number): DielectricVec3 => [Math.sqrt(1 - z * z), 0, z];
function close(a: number, b: number, eps = 1e-12): void {
  assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}, tolerance ${eps}`);
}
function vecClose(a: DielectricVec3, b: DielectricVec3, eps = 1e-12): void {
  a.forEach((x, i) => close(x, b[i], eps));
}
function rng(seed: number): () => number {
  return () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
}
const random3 = (next: () => number): DielectricVec3 => [
  next(),
  next(),
  next(),
];

// Separate textbook oracle using incident/transmitted angles and two polarizations.
function oracleFresnel(theta: number, ni: number, nt: number): number {
  const st = (ni / nt) * Math.sin(theta);
  if (st >= 1) return 1;
  const ti = Math.cos(theta),
    tt = Math.cos(Math.asin(st));
  const s = (ni * ti - nt * tt) / (ni * ti + nt * tt);
  const p = (nt * ti - ni * tt) / (nt * ti + ni * tt);
  return (s * s + p * p) / 2;
}

test("exact Fresnel: closed-form F0=.04, angle oracle, critical angle and matched IOR", () => {
  close(dielectricFresnelCPU(1, 1.5), 0.04);
  close(dielectricFresnelCPU(1, 1 / 1.5), 0.04);
  for (const ni of [1, 1.33, 1.5, 2.4])
    for (const nt of [1, 1.33, 1.5, 2.4])
      for (const degrees of [0, 17, 35, 50, 70, 89]) {
        const theta = (degrees * Math.PI) / 180;
        close(
          dielectricFresnelCPU(Math.cos(theta), nt / ni),
          ni === nt ? 0 : oracleFresnel(theta, ni, nt),
          2e-13,
        );
      }
  const critical = Math.asin(1 / 1.5);
  assert.ok(dielectricFresnelCPU(Math.cos(critical - 1e-5), 1 / 1.5) < 1);
  close(dielectricFresnelCPU(Math.cos(critical + 1e-5), 1 / 1.5), 1);
  close(dielectricFresnelCPU(0, 1), 0);
  close(dielectricFresnelCPU(0, 1.5), 1);
});

test("delta Snell, reciprocal eta, orientation, exact branch masses and TIR", () => {
  const f0 = sampleDielectric(N, N, glass, [0, 0, 0]);
  assert.equal(f0.event, "reflection");
  assert.ok(f0.delta);
  close(f0.pdf, 0.04);
  vecClose(f0.weight, [1, 1, 1]);
  const normalT = sampleDielectric(N, N, glass, [0.5, 0, 0]);
  close(normalT.pdf, 0.96);
  vecClose(normalT.direction, [0, 0, -1]);
  vecClose(normalT.weight, [4 / 9, 4 / 9, 4 / 9]);
  for (const cos of [1, 0.8, 0.2]) {
    const v = viewAt(cos),
      s = sampleDielectric(N, v, glass, [0.999999, 0, 0]);
    assert.equal(s.event, "transmission");
    close(s.eta, 1.5);
    close(Math.hypot(...s.direction), 1);
    close(
      Math.hypot(s.direction[0], s.direction[1]) * 1.5,
      Math.sqrt(1 - cos * cos),
    );
    const reverse = sampleDielectric(N, s.direction, glass, [0.999999, 0, 0]);
    assert.equal(reverse.event, "transmission");
    close(s.eta * reverse.eta, 1);
    vecClose(reverse.direction, v);
    vecClose(scale(s.weight, reverse.weight[0]), [1, 1, 1]);
    const flipped = sampleDielectric(
      [0, 0, -3],
      scale(v, 2),
      { ...glass, etaOutside: 1.5, etaInside: 1 },
      [0.999999, 0, 0],
    );
    vecClose(flipped.direction, s.direction);
    vecClose(flipped.weight, s.weight);
  }
  const v = viewAt(-0.5);
  for (const u of [0, 0.5, 0.999999]) {
    const s = sampleDielectric(N, v, glass, [u, 0.4, 0.8]);
    assert.equal(s.event, "reflection");
    close(s.pdf, 1);
    close(s.eta, 1);
    vecClose(s.weight, [1, 1, 1]);
  }
  close(dielectricPdfCPU(N, N, [0, 0, -1], glass), 0);
  vecClose(evaluateDielectric(N, N, [0, 0, -1], glass), [0, 0, 0]);
  for (const r of [0, 0.3, 1]) {
    const s = sampleDielectric(
      N,
      viewAt(0.2),
      { ...glass, roughness: r, etaInside: 1 },
      [0, 0.2, 0.3],
    );
    assert.equal(s.event, "transmission");
    assert.ok(s.delta);
    close(s.pdf, 1);
    vecClose(s.direction, scale(viewAt(0.2), -1));
  }
});

test("input validation, tangent nulls, linear tint and separate Beer attenuation", () => {
  for (const m of [
    { ...glass, etaInside: 0 },
    { ...glass, etaOutside: NaN },
    { ...glass, roughness: -1 },
    { ...glass, roughness: 2 },
    { ...glass, tint: [1, 2, 1] as DielectricVec3 },
    { ...glass, transport: "volume" as never },
  ])
    assert.throws(
      () => sampleDielectric(N, N, m, [0.5, 0.5, 0.5]),
      /DIELECTRIC_INPUT/,
    );
  for (const u of [
    [1, 0, 0],
    [-0.01, 0, 0],
    [NaN, 0, 0],
  ] as DielectricVec3[])
    assert.throws(() => sampleDielectric(N, N, glass, u), /DIELECTRIC_INPUT/);
  assert.throws(
    () => evaluateDielectric([0, 0, 0], N, N, glass),
    /DIELECTRIC_INPUT/,
  );
  assert.throws(
    () => dielectricPdfCPU(N, N, [0, Infinity, 1], glass),
    /DIELECTRIC_INPUT/,
  );
  assert.throws(() => dielectricFresnelCPU(-1, 1.5), /DIELECTRIC_INPUT/);
  assert.equal(
    sampleDielectric(N, [1, 0, 0], glass, [0.5, 0.5, 0.5]).event,
    "null",
  );
  const tint: DielectricVec3 = [0.25, 0.5, 1];
  const s = sampleDielectric(
    N,
    N,
    { ...glass, tint, transport: "importance" },
    [0.5, 0.5, 0.5],
  );
  vecClose(s.weight, tint);
  vecClose(
    sampleDielectric(N, N, { ...glass, tint }, [0, 0.5, 0.5]).weight,
    [1, 1, 1],
  );
  vecClose(dielectricBeerAttenuation(tint, 2, 4), [0.0625, 0.25, 1]);
  vecClose(dielectricBeerAttenuation([0, 0, 0], 2, 0), [1, 1, 1]);
  vecClose(dielectricBeerAttenuation([0, 0.25, 1], 2, 1), [0, 0.5, 1]);
  for (const [d, l] of [
    [0, 1],
    [-1, 1],
    [1, -1],
    [Infinity, 1],
    [1, NaN],
  ])
    assert.throws(
      () => dielectricBeerAttenuation(tint, d, l),
      /DIELECTRIC_INPUT/,
    );
  assert.throws(
    () => dielectricBeerAttenuation([-0.1, 0, 1], 2, 1),
    /DIELECTRIC_INPUT/,
  );
});

test("rough analytic normal-incidence values and half-vector Jacobian", () => {
  // At N.V=1, L=-N: h=N, D=1/(pi*a²), G=1, J=e²/(1-e)².
  const m = { ...glass, roughness: 0.5 },
    a = 0.25,
    d = 1 / (Math.PI * a * a),
    e = 1.5;
  close(evaluateDielectric(N, N, N, m)[0], (0.04 * d) / 4);
  close(dielectricPdfCPU(N, N, N, m), (0.04 * d) / 4);
  close(
    evaluateDielectric(N, N, [0, 0, -1], m)[0],
    (0.96 * d) / (1 - e) ** 2,
    1e-12,
  );
  close(
    dielectricPdfCPU(N, N, [0, 0, -1], m),
    (0.96 * d * e * e) / (1 - e) ** 2,
    1e-12,
  );
  const i = { ...m, transport: "importance" as const };
  close(
    evaluateDielectric(N, N, [0, 0, -1], i)[0],
    dielectricPdfCPU(N, N, [0, 0, -1], i),
    1e-12,
  );
  // Independent finite differential area of Snell's map: dOmega(h)/dOmega(l).
  const theta = 0.32,
    phi = 0.7,
    v = viewAt(0.83);
  function refract(t: number, p: number): DielectricVec3 {
    const h: DielectricVec3 = [
      Math.sin(t) * Math.cos(p),
      Math.sin(t) * Math.sin(p),
      Math.cos(t),
    ];
    const c = dot(v, h),
      k = c / e - Math.sqrt(1 - (1 - c * c) / (e * e));
    return [-v[0] / e + k * h[0], -v[1] / e + k * h[1], -v[2] / e + k * h[2]];
  }
  const h: DielectricVec3 = [
    Math.sin(theta) * Math.cos(phi),
    Math.sin(theta) * Math.sin(phi),
    Math.cos(theta),
  ];
  const l = refract(theta, phi),
    dt = 1e-5;
  const dx = refract(theta + dt, phi).map(
    (x, j) => (x - refract(theta - dt, phi)[j]) / (2 * dt),
  );
  const dy = refract(theta, phi + dt).map(
    (x, j) => (x - refract(theta, phi - dt)[j]) / (2 * dt),
  );
  const area = Math.hypot(
    dx[1] * dy[2] - dx[2] * dy[1],
    dx[2] * dy[0] - dx[0] * dy[2],
    dx[0] * dy[1] - dx[1] * dy[0],
  );
  const numerical = Math.sin(theta) / area;
  const jac = (e * e * Math.abs(dot(l, h))) / (dot(v, h) + e * dot(l, h)) ** 2;
  close(numerical, jac, 2e-8);
});

// Independent direct-sum half-vector oracle. No production helpers or VNDF mapping.
function directSumOracle(
  normal: DielectricVec3,
  view: DielectricVec3,
  light: DielectricVec3,
  m: DielectricMaterial,
): { f: DielectricVec3; pdf: number } {
  const unit = (v: DielectricVec3) => scale(v, 1 / Math.hypot(...v));
  let n = unit(normal);
  const v = unit(view),
    l = unit(light);
  const outside = dot(n, v) > 0;
  if (!outside) n = scale(n, -1);
  const nv = dot(n, v),
    nl = dot(n, l),
    reflection = nl > 0;
  const eta = outside ? m.etaInside / m.etaOutside : m.etaOutside / m.etaInside;
  if (nv <= 0 || nl === 0 || m.roughness === 0 || eta === 1)
    return { f: [0, 0, 0], pdf: 0 };
  const sum = v.map(
    (x, j) => x + (reflection ? 1 : eta) * l[j],
  ) as unknown as DielectricVec3;
  let h = unit(sum);
  if (dot(n, h) < 0) h = scale(h, -1);
  const vh = dot(v, h),
    lh = dot(l, h);
  if (vh <= 0 || lh * nl <= 0) return { f: [0, 0, 0], pdf: 0 };
  const a = Math.max(0.0025, m.roughness ** 2),
    nh = dot(n, h);
  const slope = Math.hypot(...h.map((x, j) => x - nh * n[j])) / nh;
  const d = 1 / (Math.PI * a * a * nh ** 4 * (1 + (slope / a) ** 2) ** 2);
  const lambda = (c: number) =>
    (Math.hypot(1, a * Math.tan(Math.acos(Math.min(1, Math.abs(c))))) - 1) / 2;
  const lv = lambda(nv),
    ll = lambda(nl),
    g = 1 / (1 + lv + ll);
  const F = oracleFresnel(Math.acos(Math.min(1, vh)), 1, eta);
  let f: number, pdf: number;
  if (reflection) {
    f = (F * d * g) / (4 * nv * nl);
    pdf = (F * d) / (4 * nv * (1 + lv));
  } else {
    // PBRT denominator differs algebraically from the implementation's Walter form.
    const denom = (lh + vh / eta) ** 2;
    f = (1 - F) * d * g * Math.abs((vh * lh) / (nv * nl * denom));
    if (m.transport !== "importance") f /= eta * eta;
    pdf = ((1 - F) * d * vh * Math.abs(lh)) / (nv * (1 + lv) * denom);
  }
  const color = reflection
    ? ([1, 1, 1] as const)
    : (m.tint ?? ([1, 1, 1] as const));
  return { f: scale(color, f), pdf };
}

test("stable query reconstruction vs independent direct-sum angular oracle", () => {
  const next = rng(0xd1e1ec7);
  for (let i = 0; i < 2400; i++) {
    const side = i % 2 ? -1 : 1,
      z = [0.0003, 0.03, 0.3, 0.8, 1][i % 5];
    const v = scale(viewAt(z), side);
    const r = [0.001, 0.05, 0.3, 1][Math.floor(i / 5) % 4];
    const a = Math.max(0.0025, r * r);
    const h = scale([a * (next() - 0.5), a * (next() - 0.5), 1], side);
    const hu = scale(h, 1 / Math.hypot(...h));
    const reflected = v.map(
      (x, j) => 2 * dot(v, hu) * hu[j] - x,
    ) as unknown as DielectricVec3;
    const l =
      i % 3 ? reflected : viewAt((0.05 + 0.95 * next()) * (i % 4 < 2 ? 1 : -1));
    const rotate = (q: DielectricVec3): DielectricVec3 =>
      i % 7 ? [0.6 * q[0] + 0.8 * q[2], q[1], -0.8 * q[0] + 0.6 * q[2]] : q;
    const n = rotate(N),
      vv = rotate(v),
      ll = rotate(l);
    const m: DielectricMaterial = {
      ...glass,
      roughness: r,
      tint: [0.3, 0.7, 0.9],
      transport: Math.floor(i / 11) % 2 ? "importance" : "radiance",
    };
    const expected = directSumOracle(n, vv, ll, m),
      f = evaluateDielectric(n, vv, ll, m),
      p = dielectricPdfCPU(n, vv, ll, m);
    f.forEach((x, j) =>
      close(x, expected.f[j], 2e-8 * Math.max(1, Math.abs(expected.f[j]))),
    );
    close(p, expected.pdf, 2e-8 * Math.max(1, expected.pdf));
  }
});

test("original failure packets 31 and 91 retained-h sample regressions", () => {
  for (const [z, u, pdf] of [
    [
      -0.029999999329447746,
      [0.19992941617965698, 0.7382331490516663, 0.7836077213287354],
      13411.236286906706,
    ],
    [
      0.029999999329447746,
      [0.7170161008834839, 0.4210855960845947, 0.746804416179657],
      105874.45075328225,
    ],
  ] as const) {
    const v: DielectricVec3 = [0.999549925327301, 0, z];
    const m: DielectricMaterial = {
      etaOutside: 1.3300000429153442,
      etaInside: 1,
      roughness: 0.0010000000474974513,
      transport: "importance",
    };
    const s = sampleDielectric(N, v, m, u);
    assert.equal(s.event, "reflection");
    assert.equal(s.delta, false);
    close(s.pdf, pdf, 1e-5);
    const oracle = directSumOracle(N, v, s.direction, m);
    close(s.pdf, oracle.pdf, 1e-5);
    close(
      s.weight[0],
      (oracle.f[0] * Math.abs(s.direction[2])) / oracle.pdf,
      2e-12,
    );
  }
});

test("roughness floor, null events, f*cos/pdf, reciprocity and eta adjoint", () => {
  const next = rng(0x6023);
  let nulls = 0,
    transmissions = 0;
  for (let k = 0; k < 12000; k++) {
    const v = viewAt((k % 2 ? -1 : 1) * (0.05 + 0.95 * next())),
      m: DielectricMaterial = {
        ...glass,
        roughness: [0.0001, 0.05, 0.2, 0.6, 1][k % 5],
      };
    const s = sampleDielectric(N, v, m, random3(next));
    if (s.event === "null") {
      nulls++;
      assert.equal(s.pdf, 0);
      continue;
    }
    assert.ok(!s.delta);
    close(Math.hypot(...s.direction), 1, 3e-14);
    const l = s.direction,
      f = evaluateDielectric(N, v, l, m),
      p = dielectricPdfCPU(N, v, l, m);
    close(p, s.pdf, 1e-9 * Math.max(1, p));
    f.forEach((x, c) => close((x * Math.abs(l[2])) / p, s.weight[c], 2e-10));
    const fi = evaluateDielectric(N, v, l, {
      ...m,
      transport: "importance",
    })[0];
    close(fi, f[0] * s.eta * s.eta, 1e-9 * Math.max(1, fi));
    const reverse = evaluateDielectric(N, l, v, m)[0];
    // f_radiance(v,l)*eta^2 == f_radiance(l,v) (same for reflection, eta=1).
    close(reverse, f[0] * s.eta * s.eta, 2e-7 * Math.max(1, reverse));
    if (s.event === "transmission") transmissions++;
    assert.ok(Number.isFinite(s.pdf) && s.pdf > 0);
    assert.ok(s.weight.every(Number.isFinite));
  }
  assert.ok(nulls > 100);
  assert.ok(transmissions > 1000);
  close(DIELECTRIC_MIN_ALPHA, 0.0025);
  const l: DielectricVec3 = [0.01, 0, -Math.sqrt(1 - 0.0001)];
  vecClose(
    evaluateDielectric(N, N, l, { ...glass, roughness: 0.0001 }),
    evaluateDielectric(N, N, l, { ...glass, roughness: 0.05 }),
    1e-9,
  );
});

// Independent projected-NDF integration, not the production visible-normal mapping.
// Midpoint quadrature in GGX projected-area CDF and azimuth integrates BOTH branches.
// Scalar formula weights facet area by projected view area and correlated masking.
function ndfReference(
  cos: number,
  r: number,
  eta: number,
  steps = 384,
  azimuths = 768,
): number[] {
  const a = Math.max(0.0025, r * r),
    nv = Math.abs(cos),
    vx = Math.sqrt(1 - nv * nv);
  const mask = (z: number) => Math.sqrt(1 + (a * a * (1 - z * z)) / (z * z));
  const out = [0, 0, 0, 0];
  for (let i = 0; i < steps; i++) {
    const endpoint = 1 - (i + 0.5) / steps,
      u = 1 - endpoint * endpoint,
      tan = a * Math.sqrt(u / (1 - u)),
      hz = 1 / Math.sqrt(1 + tan * tan),
      hr = Math.sqrt(1 - hz * hz);
    for (let j = 0; j < azimuths; j++) {
      const phi = ((j + 0.5) * 2 * Math.PI) / azimuths,
        hx = hr * Math.cos(phi),
        hy = hr * Math.sin(phi),
        c = vx * hx + nv * hz;
      if (c <= 0) continue;
      const F = oracleFresnel(Math.acos(Math.min(1, c)), 1, eta);
      for (const reflection of [true, false]) {
        let x: number, y: number, z: number;
        if (reflection) {
          x = 2 * c * hx - vx;
          y = 2 * c * hy;
          z = 2 * c * hz - nv;
          if (z <= 0) continue;
        } else {
          const sinT2 = (1 - c * c) / (eta * eta);
          if (sinT2 >= 1) continue;
          const k = c / eta - Math.sqrt(1 - sinT2);
          x = -vx / eta + k * hx;
          y = k * hy;
          z = -nv / eta + k * hz;
          if (z >= 0) continue;
        }
        const G = 2 / (mask(nv) + mask(Math.abs(z)));
        const w =
          (((reflection ? F : 1 - F) * G * c) /
            (nv * hz) /
            (steps * azimuths)) *
          (2 * endpoint);
        // Physical-space z for exiting queries is the opposite oriented z.
        const worldZ = cos < 0 ? -z : z;
        out[0] += w;
        out[1] += w * worldZ;
        out[2] += w * worldZ * worldZ;
        out[3] += w * x;
        void y;
      }
    }
  }
  return out;
}

test("importance furnace and oblique MC energy/direction moments vs independent NDF quadrature", (t) => {
  const cases = [
    { c: 1, r: 0.3 },
    { c: 0.8, r: 0.6 },
    { c: 0.18, r: 1 },
    { c: -0.85, r: 0.35 },
    { c: -0.5, r: 0.65 },
    { c: -0.12, r: 1 },
  ];
  let worstZ = 0;
  let earlyErrorSquared = 0,
    finalErrorSquared = 0,
    maxQuadratureDelta = 0;
  for (let k = 0; k < cases.length; k++) {
    const { c, r } = cases[k],
      eta = c > 0 ? 1.5 : 1 / 1.5;
    const earlySum = [0, 0, 0, 0];
    const ref = ndfReference(c, r, eta),
      fine = ndfReference(c, r, eta, 768, 1536);
    ref.forEach((x, j) => {
      maxQuadratureDelta = Math.max(maxQuadratureDelta, Math.abs(x - fine[j]));
    });
    ref.forEach((x, j) =>
      assert.ok(
        Math.abs(x - fine[j]) < 0.0012,
        `quadrature unresolved ${k}:${j}: ${x},${fine[j]}`,
      ),
    );
    const count = 196608,
      sum = [0, 0, 0, 0],
      sq = [0, 0, 0, 0];
    const m: DielectricMaterial = {
      ...glass,
      roughness: r,
      transport: "importance",
    };
    let next = rng(0x12345 + k);
    const v = viewAt(c);
    for (let j = 0; j < count; j++) {
      if (j % 65536 === 0)
        next = rng(0x12345 + k + Math.floor(j / 65536) * 0x1000001);
      const s = sampleDielectric(N, v, m, random3(next)),
        w = s.weight[0];
      // Importance is the energy comparison. No radiance eta^2 clamp is used.
      assert.ok(w >= 0 && w <= 1 + 1e-12);
      const q = [
        w,
        w * s.direction[2],
        w * s.direction[2] ** 2,
        w * s.direction[0],
      ];
      q.forEach((x, d) => {
        sum[d] += x;
        sq[d] += x * x;
        if (j % 65536 < 2048) earlySum[d] += x;
      });
    }
    sum.forEach((x, j) => {
      const mean = x / count,
        se = Math.sqrt(Math.max(0, sq[j] / count - mean * mean) / count);
      const quadratureError = 2 * Math.abs(ref[j] - fine[j]) + 2e-5;
      const z = Math.abs(mean - fine[j]) / Math.max(se, 1e-12);
      worstZ = Math.max(worstZ, z);
      earlyErrorSquared += (earlySum[j] / 6144 - fine[j]) ** 2;
      finalErrorSquared += (mean - fine[j]) ** 2;
      assert.ok(
        Math.abs(mean - fine[j]) <= 6 * se + quadratureError,
        JSON.stringify({ k, j, mean, reference: fine[j], se, quadratureError }),
      );
    });
    t.diagnostic(
      JSON.stringify({
        cos: c,
        roughness: r,
        samples: count,
        reference: fine,
        means: sum.map((x) => x / count),
      }),
    );
  }
  assert.ok(
    finalErrorSquared < earlyErrorSquared,
    "MC aggregate moment error must decrease with 32x samples",
  );
  t.diagnostic(
    JSON.stringify({
      worstStandardizedDifference: worstZ,
      maxQuadratureDelta,
      seedsPerCase: 3,
      samplesPerSeed: 65536,
      earlySamplesPerCase: 6144,
      earlyMomentRMSE: Math.sqrt(earlyErrorSquared / 24),
      finalMomentRMSE: Math.sqrt(finalErrorSquared / 24),
    }),
  );
});

test("delta white furnace is analytic in importance and eta-weighted radiance (including >1 exit radiance)", () => {
  for (const c of [1, 0.8, 0.15, -1, -0.85, -0.5]) {
    const v = viewAt(c),
      e = c > 0 ? 1.5 : 1 / 1.5,
      F = oracleFresnel(Math.acos(Math.abs(c)), 1, e);
    let importance = 0,
      radiance = 0,
      adjoint = 0;
    for (const u of [0, 0.999999999]) {
      const s = sampleDielectric(N, v, glass, [u, 0.3, 0.7]);
      // TIR repeats reflection for both u values: count its mass only once.
      if (u > 0 && F === 1) continue;
      const si = sampleDielectric(N, v, { ...glass, transport: "importance" }, [
        u,
        0.3,
        0.7,
      ]);
      importance += si.pdf * si.weight[0];
      radiance += s.pdf * s.weight[0];
      adjoint += s.pdf * s.weight[0] * s.eta * s.eta;
    }
    close(importance, 1);
    close(adjoint, 1);
    close(radiance, F + (1 - F) / (e * e));
    if (c === -1) assert.ok(radiance > 2);
  }
});
function deadline<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`DIELECTRIC_DEADLINE: ${label} ${ms}ms`)),
        ms,
      );
    }),
  ]).finally(() => clearTimeout(timer));
}

test(
  "773 hardware WebGPU packets, combined shader compile and readback",
  {
    skip:
      process.env.PELICAN_DIELECTRIC_GPU !== "1"
        ? "GPU not requested; CPU is not GPU proof. Set PELICAN_DIELECTRIC_GPU=1."
        : false,
    timeout: 110000,
  },
  async (t) => {
    const { chromium } = await import("playwright");
    const { BSDF_SHADER } = await import("../packages/renderer/src/bsdf.ts");
    const server = createServer((_req, res) => {
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end("<!doctype html><title>Dielectric hardware readback</title>");
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    let browserServer:
      | Awaited<ReturnType<typeof chromium.launchServer>>
      | undefined;
    let browser: Awaited<ReturnType<typeof chromium.connect>> | undefined;
    const failures: string[] = [];
    try {
      const addr = server.address();
      assert.ok(addr && typeof addr === "object");
      let page:
        | Awaited<ReturnType<NonNullable<typeof browser>["newPage"]>>
        | undefined;
      let backend: unknown;
      for (const headless of [true, false]) {
        try {
          browserServer = await chromium.launchServer({
            headless,
            channel: "chromium",
            timeout: 12000,
            args: graphicsLaunchArguments(),
          });
          browser = await chromium.connect(browserServer.wsEndpoint(), {
            timeout: 5000,
          });
          page = await browser.newPage();
          await page.goto(`http://127.0.0.1:${addr.port}`, { timeout: 5000 });
          const adapter = await deadline(
            page.evaluate(async () => {
              if (!navigator.gpu) return { skip: "navigator.gpu unavailable" };
              const a = await navigator.gpu.requestAdapter({
                powerPreference: "high-performance",
                forceFallbackAdapter: false,
              });
              if (!a) return { skip: "no adapter" };
              const info = a.info;
              if (
                info.isFallbackAdapter ||
                /swiftshader|llvmpipe|software|warp|basic render/i.test(
                  [
                    info.vendor,
                    info.architecture,
                    info.device,
                    info.description,
                  ].join(" "),
                )
              )
                return {
                  skip: `software/fallback adapter: ${JSON.stringify(info)}`,
                };
              return {
                vendor: info.vendor,
                architecture: info.architecture,
                device: info.device,
                description: info.description,
                isFallbackAdapter: info.isFallbackAdapter,
              };
            }),
            10000,
            "adapter probe",
          );
          if ("skip" in adapter) throw Error(adapter.skip);
          backend = { ...adapter, headless, angle: "d3d11" };
          break;
        } catch (error) {
          failures.push(
            `${headless ? "headless" : "headed"}: ${String(error)}`,
          );
          if (browserServer)
            await deadline(browserServer.kill(), 5000, "failed browser kill");
          browser = undefined;
          browserServer = undefined;
          page = undefined;
        }
      }
      if (!page) {
        assert.fail(
          `Hardware WebGPU unavailable: ${failures.join("; ")}. No GPU proof.`,
        );
        return;
      }
      const input: number[] = [];
      const next = rng(0x773dda);
      for (let i = 0; i < 768; i++) {
        const tilted = i % 3 === 0;
        const rotate = (v: DielectricVec3): DielectricVec3 =>
          tilted
            ? [0.6 * v[0] + 0.8 * v[2], v[1], -0.8 * v[0] + 0.6 * v[2]]
            : v;
        const n = rotate(N),
          z = [1, 0.8, 0.3, 0.03][i % 4] * (Math.floor(i / 4) % 2 ? -1 : 1),
          v = rotate(viewAt(z));
        const l = rotate(viewAt((0.05 + 0.95 * next()) * (i % 5 < 2 ? -1 : 1)));
        const r = [0, 0.001, 0.05, 0.3, 0.65, 1][i % 6];
        const outside = [1, 1.33, 1.5][i % 3],
          inside = i % 17 === 0 ? outside : [1.5, 1, 2.4][i % 3];
        input.push(
          ...n,
          r,
          ...v,
          outside,
          ...l,
          inside,
          ...(i % 7 === 0 ? [1, 1, 1] : [0.3, 0.7, 0.9]),
          Math.floor(i / 8) % 2,
          ...random3(next),
          i % 4,
        );
      }
      // Exact tangent, matched index, TIR, normal F0 and VNDF endpoint zero.
      for (const q of [
        [...N, 0, ...N, 1, 0, 0, -1, 1.5, 1, 1, 1, 0, 0.5, 0, 0, 0],
        [...N, 0, ...viewAt(-0.5), 1, ...N, 1.5, 1, 1, 1, 1, 0.999, 0, 0, 2],
        [...N, 0.5, 1, 0, 0, 1, ...N, 1.5, 1, 1, 1, 0, 0.5, 0.5, 0.5, 1],
        [...N, 1, ...viewAt(0.2), 1, 0, 0, -1, 1, 0, 0.5, 1, 0, 0, 0, 0, 0],
        [...N, 0.05, ...N, 1, 0, 0, -1, 1.5, 0.3, 0.7, 1, 1, 0, 0, 0, 3],
      ])
        input.push(...q);
      const packed = Array.from(new Float32Array(input));
      assert.equal(packed.length, 773 * 20);
      const packetSha256 = createHash("sha256")
        .update(new Uint8Array(new Float32Array(packed).buffer))
        .digest("hex");
      assert.equal(
        packetSha256,
        "488c27aebccc09d1fad36dede16f4db4836a4d1eac3f6ea9bacbd79e0741fef6",
        "Keep all original 773 input packets unchanged",
      );
      const shader =
        BSDF_SHADER +
        "\n" +
        DIELECTRIC_SHADER +
        /* wgsl */ `
struct DielectricQuery { n: vec3f, r: f32, v: vec3f, outside: f32, l: vec3f, inside: f32, tint: vec3f, mode: u32, random: vec3f, length: f32 }
// Input is packed floats; mode is converted explicitly below.
@group(0) @binding(0) var<storage,read> dielectricInput: array<f32>;
@group(0) @binding(1) var<storage,read_write> dielectricOutput: array<f32>;
fn dielectricStore3(base: u32, v: vec3f) {dielectricOutput[base]=v.x;dielectricOutput[base+1u]=v.y;dielectricOutput[base+2u]=v.z;}
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3u){
 let i=id.x; if(i>=773u){return;} let q=i*20u;let o=i*32u;
 let n=vec3f(dielectricInput[q],dielectricInput[q+1u],dielectricInput[q+2u]);
 let v=vec3f(dielectricInput[q+4u],dielectricInput[q+5u],dielectricInput[q+6u]);
 let l=vec3f(dielectricInput[q+8u],dielectricInput[q+9u],dielectricInput[q+10u]);
 let tint=vec3f(dielectricInput[q+12u],dielectricInput[q+13u],dielectricInput[q+14u]);
 let u=vec3f(dielectricInput[q+16u],dielectricInput[q+17u],dielectricInput[q+18u]);
 let m=DielectricMaterial(dielectricInput[q+7u],dielectricInput[q+11u],dielectricInput[q+3u],u32(dielectricInput[q+15u]),tint);
 let s=dielectricSample(n,v,m,u);
 dielectricStore3(o,dielectricEvaluate(n,v,l,m));dielectricOutput[o+3u]=dielectricPdf(n,v,l,m);
 dielectricStore3(o+4u,s.direction);dielectricOutput[o+7u]=s.pdf;
 dielectricStore3(o+8u,s.weight);dielectricOutput[o+11u]=s.eta;
 dielectricOutput[o+12u]=f32(s.event);dielectricOutput[o+13u]=f32(s.delta);
 var f=vec3f(0.0);var p=0.0;
 if(s.event!=0u){f=dielectricEvaluate(n,v,s.direction,m);p=dielectricPdf(n,v,s.direction,m);}
 dielectricStore3(o+16u,f);dielectricOutput[o+19u]=p;
 dielectricStore3(o+20u,dielectricBeerAttenuation(tint,2.0,dielectricInput[q+19u]));
 dielectricOutput[o+23u]=dielectricFresnel(1.0,m.etaInside/m.etaOutside);
 if(s.event!=0u && s.delta==0u){
  let vv=normalize(v); let nn=normalize(n);let outside=dot(nn,vv)>=0.0;
  let face=select(-nn,nn,outside);
  let e=select(m.etaOutside/m.etaInside,m.etaInside/m.etaOutside,outside);
  let alpha=max(0.0025,m.roughness*m.roughness);
  let h=dielectricVndf(face,vv,alpha,u.y,u.z);
  let vh=dot(vv,h);let lh=dot(s.direction,h);let nv=dot(face,vv);
  let f0=dielectricFresnel(vh,e);let pm=dielectricD(face,h,alpha)*vh/(nv*(1.0+dielectricLambda(nv,alpha)));
  var known=pm*f0/(4.0*vh);
  if(s.event==2u){let den=vh+e*lh;known=pm*(1.0-f0)*e*e*abs(lh)/(den*den);}
  var rebuilt=normalize(vv+select(e,1.0,s.event==1u)*s.direction);
  if(dot(face,rebuilt)<0.0){rebuilt=-rebuilt;}
  dielectricOutput[o+14u]=dielectricD(face,rebuilt,alpha)/dielectricD(face,h,alpha);
  dielectricOutput[o+15u]=nv;
  dielectricStore3(o+24u,h);dielectricStore3(o+27u,vv);
  dielectricOutput[o+30u]=known;dielectricOutput[o+31u]=dielectricD(face,h,alpha);
 }
}
`;
      // Keep browser execution in a raw function so the TS runner adds no helper closures.
      const execute = new Function(
        "return (async function(packet){" +
          String.raw`
 const adapter=await navigator.gpu.requestAdapter({powerPreference:'high-performance',forceFallbackAdapter:false});
 if(!adapter)throw Error('adapter disappeared');
 const info=adapter.info;
 if(info.isFallbackAdapter||/swiftshader|llvmpipe|software|warp|basic render/i.test([info.vendor,info.architecture,info.device,info.description].join(' ')))throw Error('nonhardware adapter');
 const device=await adapter.requestDevice();const buffers=[];
 try{
  device.pushErrorScope('validation');
  const input=device.createBuffer({size:packet.values.length*4,usage:GPUBufferUsage.STORAGE,mappedAtCreation:true});buffers.push(input);
  new Float32Array(input.getMappedRange()).set(packet.values);input.unmap();
  const size=773*32*4;
  const output=device.createBuffer({size,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC});buffers.push(output);
  const read=device.createBuffer({size,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});buffers.push(read);
  const module=device.createShaderModule({code:packet.shader});const compilation=await module.getCompilationInfo();
  const errors=compilation.messages.filter(m=>m.type==='error');if(errors.length)throw Error(JSON.stringify(errors.map(m=>({line:m.lineNum,message:m.message}))));
  const pipeline=await device.createComputePipelineAsync({layout:'auto',compute:{module,entryPoint:'main'}});
  const group=device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[input,output].map((buffer,binding)=>({binding,resource:{buffer}}))});
  const enc=device.createCommandEncoder();const pass=enc.beginComputePass();pass.setPipeline(pipeline);pass.setBindGroup(0,group);pass.dispatchWorkgroups(Math.ceil(773/64));pass.end();
  enc.copyBufferToBuffer(output,0,read,0,size);device.queue.submit([enc.finish()]);
  await read.mapAsync(GPUMapMode.READ);const values=Array.from(new Float32Array(read.getMappedRange().slice(0)));read.unmap();
  const error=await device.popErrorScope();if(error)throw Error(error.message);
  return {values,messages:compilation.messages.map(m=>({type:m.type,message:m.message})),adapter:{vendor:info.vendor,architecture:info.architecture,device:info.device,description:info.description,isFallbackAdapter:info.isFallbackAdapter}};
 }finally{for(const b of buffers)b.destroy();device.destroy();}
` +
          "})",
      )() as (packet: { shader: string; values: number[] }) => Promise<{
        values: number[];
        messages: unknown[];
        adapter: unknown;
      }>;
      const result = await deadline(
        page.evaluate(execute, { shader, values: packed }),
        25000,
        "GPU compile/dispatch/readback",
      );
      assert.equal(result.values.length, 773 * 32);
      const events = { null: 0, reflection: 1, transmission: 2 };
      const numericFailures: unknown[] = [];
      const fieldFailures: Record<number, number> = {};
      const halfVectorDiagnostics: unknown[] = [];
      let finiteFields = 0;
      let maxScaledError = 0,
        maxDirectionError = 0;
      let worstField: unknown;
      let maxSampleQueryPdfDifference = 0;
      for (let i = 0; i < 773; i++) {
        const q = packed.slice(i * 20, i * 20 + 20),
          a = result.values.slice(i * 32, i * 32 + 32);
        const at = (offset: number) =>
          q.slice(offset, offset + 3) as unknown as DielectricVec3;
        const n = at(0),
          v = at(4),
          l = at(8),
          m: DielectricMaterial = {
            roughness: q[3],
            etaOutside: q[7],
            etaInside: q[11],
            tint: at(12),
            transport: q[15] === 1 ? "importance" : "radiance",
          };
        const s = sampleDielectric(n, v, m, at(16));
        if (i === 31 || i === 91) {
          halfVectorDiagnostics.push({
            i,
            cpuSample: s,
            gpuSamplePdf: a[7],
            gpuH: a.slice(24, 27),
            gpuV: a.slice(27, 30),
            knownHPdf: a[30],
            knownD: a[31],
            legacySumDOverKnownD: a[14],
            gpuNv: a[15],
            querySamplePdf: a[19],
          });
        }
        a.forEach((x, j) => {
          assert.ok(Number.isFinite(x), `GPU nonfinite ${i}:${j}`);
          finiteFields++;
        });
        assert.equal(a[12], events[s.event], `event packet ${i}`);
        assert.equal(a[13], Number(s.delta), `delta packet ${i}`);
        const gpuL = a.slice(4, 7) as unknown as DielectricVec3;
        // Sample density/weight use the original CPU sample; query f/PDF use the
        // GPU's rounded direction. These are distinct finite-precision contracts.
        const queried =
          s.event === "null"
            ? { f: [0, 0, 0] as const, pdf: 0 }
            : directSumOracle(n, v, gpuL, m);
        const f = queried.f,
          p = queried.pdf;
        const nl = Math.abs(dot(n, gpuL)) / Math.hypot(...n);
        const queryReference = directSumOracle(n, v, l, m);
        const expected = [
          ...queryReference.f,
          queryReference.pdf,
          ...s.direction,
          s.pdf,
          ...s.weight,
          s.eta,
          events[s.event],
          Number(s.delta),
          0,
          0,
          ...f,
          p,
          ...dielectricBeerAttenuation(m.tint!, 2, q[19]),
          dielectricFresnelCPU(1, m.etaInside / m.etaOutside),
          0,
          0,
          0,
          0,
          0,
          0,
          0,
          0,
        ];
        a.forEach((x, j) => {
          const error = Math.abs(x - expected[j]);
          if (j === 14 || j === 15 || j >= 24) return; // Additional half-vector diagnostics.
          if (j >= 4 && j <= 6)
            maxDirectionError = Math.max(maxDirectionError, error);
          const scaled = error / Math.max(1, Math.abs(expected[j]));
          if (scaled > maxScaledError) {
            maxScaledError = scaled;
            worstField = { i, field: j, actual: x, reference: expected[j] };
          }
          if (error > 2e-5 + 5e-4 * Math.abs(expected[j])) {
            fieldFailures[j] = (fieldFailures[j] ?? 0) + 1;
            numericFailures.push({
              i,
              field: j,
              x,
              reference: expected[j],
              error,
              relative: error / Math.max(1e-30, Math.abs(expected[j])),
              q,
            });
          }
        });
        if (s.event !== "null") close(Math.hypot(...gpuL), 1, 3e-5);
        if (s.event !== "null" && !s.delta) {
          maxSampleQueryPdfDifference = Math.max(
            maxSampleQueryPdfDifference,
            Math.abs(a[7] - a[19]) / Math.max(1, a[19]),
          );
          for (let c = 0; c < 3; c++) {
            const throughput = (a[16 + c] * nl) / a[19];
            close(a[8 + c], throughput, 2e-5 + 5e-4 * Math.abs(throughput));
          }
        }
      }
      t.diagnostic(
        JSON.stringify({
          backend: "hardware-webgpu",
          probe: backend,
          adapter: result.adapter,
          packets: 773,
          maxScaledError,
          packetSha256,
          maxDirectionError,
          worstField,
          maxSampleQueryPdfDifference,
          finiteFields,
          numericFailureCount: numericFailures.length,
          fieldFailures,
          halfVectorDiagnostics,
          firstFailures: numericFailures.slice(0, 8),
          compilation: result.messages,
          launchFailures: failures,
          scope: "isolated dielectric numeric readback; not M3 acceptance",
        }),
      );
      assert.equal(
        numericFailures.length,
        0,
        JSON.stringify({
          scope: "OPEN GPU f32 parity",
          count: numericFailures.length,
          first: numericFailures[0],
        }),
      );
    } finally {
      try {
        if (browserServer) {
          try {
            await deadline(browserServer.close(), 5000, "browser close");
          } catch {
            await deadline(browserServer.kill(), 5000, "browser kill");
          }
        }
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      }
    }
  },
);
