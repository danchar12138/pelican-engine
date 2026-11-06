import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import {
  BSDF_MIN_ROUGHNESS,
  BSDF_SHADER,
  bsdfPdf,
  evaluateBsdf,
  sampleBsdf,
  type BsdfVec3,
} from "../packages/renderer/src/bsdf.ts";

const N: BsdfVec3 = [0, 0, 1];
const WHITE: BsdfVec3 = [1, 1, 1];
const BASE: BsdfVec3 = [0.83, 0.41, 0.09];
const SEEDS = [0x12345678, 0xcafebabe, 0x9e3779b9];
const dot = (a: BsdfVec3, b: BsdfVec3) =>
  a.reduce((s, x, i) => s + x * b[i], 0);
const viewAt = (z: number): BsdfVec3 => [
  Math.sqrt(Math.max(0, 1 - z * z)),
  0,
  z,
];
function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x100000000;
  };
}
const random3 = (next: () => number): BsdfVec3 => [next(), next(), next()];
const close = (a: number, b: number, tolerance = 1e-10) =>
  assert.ok(
    Math.abs(a - b) <= tolerance * Math.max(1, Math.abs(a), Math.abs(b)),
    `${a} != ${b}`,
  );
function close3(a: BsdfVec3, b: BsdfVec3, tolerance = 1e-10): void {
  a.forEach((x, i) => close(x, b[i], tolerance));
}
function hemisphere(z: number, phi: number): BsdfVec3 {
  const r = Math.sqrt(Math.max(0, 1 - z * z));
  return [r * Math.cos(phi), r * Math.sin(phi), z];
}
function integral(
  v: BsdfVec3,
  base: BsdfVec3,
  r: number,
  m: number,
  bins = 160,
): { energy: number[]; mass: number; moments: number[] } {
  const energy = [0, 0, 0],
    moments = [0, 0, 0];
  let mass = 0;
  const area = (2 * Math.PI) / (bins * bins * 2);
  for (let zi = 0; zi < bins; zi++) {
    const z = (zi + 0.5) / bins;
    for (let pi = 0; pi < bins * 2; pi++) {
      const l = hemisphere(z, ((pi + 0.5) * 2 * Math.PI) / (bins * 2));
      const f = evaluateBsdf(N, v, l, base, r, m),
        p = bsdfPdf(N, v, l, base, r, m);
      for (let c = 0; c < 3; c++) {
        energy[c] += f[c] * z * area;
        moments[c] += p * l[c] * area;
      }
      mass += p * area;
    }
  }
  return { energy, mass, moments };
}

test("fixed shader contract is binding-free and all helper functions are bsdf-prefixed", () => {
  assert.equal(typeof BSDF_SHADER, "string");
  assert.doesNotMatch(
    BSDF_SHADER,
    /@(?:group|binding|compute|fragment|vertex)/,
  );
  for (const [, name] of BSDF_SHADER.matchAll(/\bfn\s+(\w+)/g))
    assert.match(name, /^bsdf/);
  for (const name of ["bsdfEvaluate", "bsdfPdf", "bsdfSample"])
    assert.match(BSDF_SHADER, new RegExp(`fn ${name}\\(`));
  assert.match(BSDF_SHADER, /struct BsdfSample/);
});

test("normal-incidence closed form: f is not multiplied by cosine, incident light or extra pi", () => {
  for (const m of [0, 0.37, 1])
    for (const r of [0, 0.2, 0.6, 1]) {
      const alpha = Math.max(BSDF_MIN_ROUGHNESS, r) ** 2;
      const expected = BASE.map((c) => {
        const f0 = 0.04 * (1 - m) + c * m;
        return (
          f0 / (4 * Math.PI * alpha * alpha) +
          (c * (1 - m) * (1 - f0) ** 2) / Math.PI
        );
      }) as unknown as BsdfVec3;
      close3(evaluateBsdf(N, N, N, BASE, r, m), expected);
    }
  const l = viewAt(0.42),
    v = viewAt(0.8);
  // Independent reference using Three's scalar D and correlated V expressions.
  const h0 = v.map((x, i) => x + l[i]),
    length = Math.hypot(...h0);
  const h = h0.map((x) => x / length) as unknown as BsdfVec3;
  const alpha = 0.65 ** 2,
    a2 = alpha * alpha;
  const d = a2 / (Math.PI * (1 + (a2 - 1) * h[2] ** 2) ** 2);
  const visibility =
    0.5 /
    (l[2] * Math.sqrt(a2 + (1 - a2) * v[2] ** 2) +
      v[2] * Math.sqrt(a2 + (1 - a2) * l[2] ** 2));
  close3(
    evaluateBsdf(N, v, l, BASE, 0.65, 1),
    BASE.map(
      (f0) => (f0 + (1 - f0) * (1 - dot(v, h)) ** 5) * d * visibility,
    ) as unknown as BsdfVec3,
  );
});

test("finite clamp, linear albedo validation, independent random domain and zero vectors", () => {
  close3(
    evaluateBsdf(N, N, N, BASE, -10, 3),
    evaluateBsdf(N, N, N, BASE, BSDF_MIN_ROUGHNESS, 1),
  );
  close3(
    evaluateBsdf(N, N, N, BASE, 10, -3),
    evaluateBsdf(N, N, N, BASE, 1, 0),
  );
  close3(
    evaluateBsdf([0, 0, 1e30], [0, 0, 1e-30], [0, 0, 7], BASE, 0.4, 0.3),
    evaluateBsdf(N, N, N, BASE, 0.4, 0.3),
  );
  for (const bad of [
    NaN,
    Infinity,
    -Infinity,
    Number.MAX_VALUE,
    Number.MIN_VALUE,
  ]) {
    for (const op of [evaluateBsdf, bsdfPdf]) {
      assert.throws(() => op([bad, 0, 1], N, N, BASE, 0.5, 0), /TC_BSDF_INPUT/);
      assert.throws(() => op(N, [bad, 0, 1], N, BASE, 0.5, 0), /TC_BSDF_INPUT/);
      assert.throws(() => op(N, N, [bad, 0, 1], BASE, 0.5, 0), /TC_BSDF_INPUT/);
      assert.throws(() => op(N, N, N, [bad, 0, 1], 0.5, 0), /TC_BSDF_INPUT/);
      assert.throws(() => op(N, N, N, BASE, bad, 0), /TC_BSDF_INPUT/);
      assert.throws(() => op(N, N, N, BASE, 0.5, bad), /TC_BSDF_INPUT/);
    }
    assert.throws(
      () => sampleBsdf(N, N, BASE, 0.5, 0, [bad, 0, 0]),
      /TC_BSDF_INPUT/,
    );
    assert.throws(
      () => sampleBsdf(N, N, BASE, bad, 0, [0, 0, 0]),
      /TC_BSDF_INPUT/,
    );
    assert.throws(
      () => sampleBsdf(N, N, BASE, 0.5, bad, [0, 0, 0]),
      /TC_BSDF_INPUT/,
    );
  }
  for (const base of [
    [1.01, 0, 0],
    [-0.001, 0, 0],
  ] as BsdfVec3[]) {
    assert.throws(() => evaluateBsdf(N, N, N, base, 0.5, 0), /albedo/);
    assert.throws(() => bsdfPdf(N, N, N, base, 0.5, 0), /albedo/);
    assert.throws(() => sampleBsdf(N, N, base, 0.5, 0, [0, 0, 0]), /albedo/);
  }
  for (const u of [
    [1, 0, 0],
    [0, -0.1, 0],
    [0, 0, 1],
  ] as BsdfVec3[])
    assert.throws(() => sampleBsdf(N, N, BASE, 0.5, 0, u), /random/);
  const zero = { direction: [0, 0, 0], weight: [0, 0, 0], pdf: 0 };
  for (const v of [
    [0, 0, 0],
    [0, 0, -1],
    [1, 0, 0],
  ] as BsdfVec3[]) {
    assert.deepEqual(sampleBsdf(N, v, BASE, 0.3, 0.5, [0.2, 0.4, 0.6]), zero);
    assert.deepEqual(evaluateBsdf(N, v, N, BASE, 0.3, 0.5), [0, 0, 0]);
    assert.equal(bsdfPdf(N, v, N, BASE, 0.3, 0.5), 0);
    assert.deepEqual(evaluateBsdf(N, N, v, BASE, 0.3, 0.5), [0, 0, 0]);
    assert.equal(bsdfPdf(N, N, v, BASE, 0.3, 0.5), 0);
  }
  assert.deepEqual(
    sampleBsdf([0, 0, 0], N, BASE, 0.4, 0, [0.2, 0.4, 0.6]),
    zero,
  );
  assert.deepEqual(evaluateBsdf([0, 0, 0], N, N, BASE, 0.4, 0), [0, 0, 0]);
  assert.equal(bsdfPdf([0, 0, 0], N, N, BASE, 0.4, 0), 0);
  assert.throws(
    () => evaluateBsdf(N, N, N, new Array(3) as unknown as BsdfVec3, 0.5, 0),
    /TC_BSDF_INPUT/,
  );
  // Rough alpha=1, normal view: exactly half the VNDF reflections are below N.
  assert.deepEqual(sampleBsdf(N, N, WHITE, 1, 1, [0.1, 0.75, 0.2]), zero);
});

test("black albedo removes diffuse without discarding dielectric or grazing metal reflection", () => {
  const black: BsdfVec3 = [0, 0, 0];
  assert.ok(evaluateBsdf(N, N, N, black, 0.5, 0)[0] > 0);
  close3(evaluateBsdf(N, N, N, black, 0.5, 1), black);
  const v = viewAt(0.03),
    l: BsdfVec3 = [-v[0], 0, v[2]];
  assert.ok(evaluateBsdf(N, v, l, black, 0.5, 1)[0] > 0);
  for (const m of [0, 0.5, 1]) {
    const a = sampleBsdf(N, v, black, 0.6, m, [0, 0.3, 0.7]);
    const b = sampleBsdf(N, v, black, 0.6, m, [0.999, 0.3, 0.7]);
    assert.deepEqual(a, b, "no diffuse energy means specular-only proposal");
    assert.ok([...a.direction, ...a.weight, a.pdf].every(Number.isFinite));
  }
});

test("Helmholtz reciprocity for dielectric, mixed metal and conductor across independent seeds", () => {
  for (const seed of SEEDS) {
    const next = rng(seed);
    for (let i = 0; i < 1800; i++) {
      const v = hemisphere(next(), 2 * Math.PI * next()),
        l = hemisphere(next(), 2 * Math.PI * next());
      const r = next(),
        m = [0, 0.46, 1][i % 3],
        base = random3(next);
      close3(
        evaluateBsdf(N, v, l, base, r, m),
        evaluateBsdf(N, l, v, base, r, m),
        2e-10,
      );
    }
  }
});

test("grazing, near-opposite and tiny positive hemispheres remain finite", () => {
  for (const z of [1e-30, 1e-12, 1e-7, 0.001, 0.05, 1]) {
    const v = viewAt(z),
      l: BsdfVec3 = [-v[0], 0, z];
    for (const r of [0, 0.05, 0.5, 1])
      for (const m of [0, 0.5, 1]) {
        const f = evaluateBsdf(N, v, l, BASE, r, m),
          p = bsdfPdf(N, v, l, BASE, r, m);
        assert.ok([...f, p].every((x) => Number.isFinite(x) && x >= 0));
        for (const u of [
          [0, 0, 0],
          [0.9, 1 - 2 ** -24, 0.5],
          [0.4, 0.4, 0.8],
        ] as BsdfVec3[]) {
          const s = sampleBsdf(N, v, BASE, r, m, u);
          assert.ok(
            [...s.direction, ...s.weight, s.pdf].every(Number.isFinite),
          );
          if (s.pdf > 0) {
            close(dot(s.direction, s.direction), 1);
            assert.ok(dot(N, s.direction) > 0);
            close(s.pdf, bsdfPdf(N, v, s.direction, BASE, r, m));
          }
        }
      }
  }
});

test("rotated frame invariance and exact full-mixture weight on BOTH sampled lobes", () => {
  const rotate = (v: BsdfVec3): BsdfVec3 => [
    0.6 * v[0] + 0.8 * v[2],
    v[1],
    -0.8 * v[0] + 0.6 * v[2],
  ];
  for (const seed of SEEDS) {
    const next = rng(seed),
      v = viewAt(0.36);
    for (let i = 0; i < 2000; i++) {
      const u: BsdfVec3 = [i % 2 === 0 ? 0 : 0.9999, next(), next()];
      const s = sampleBsdf(N, v, BASE, 0.63, 0.25, u);
      if (s.pdf === 0) continue;
      const f = evaluateBsdf(N, v, s.direction, BASE, 0.63, 0.25);
      close(s.pdf, bsdfPdf(N, v, s.direction, BASE, 0.63, 0.25));
      close3(
        s.weight,
        f.map((x) => (x * s.direction[2]) / s.pdf) as unknown as BsdfVec3,
      );
      close3(
        evaluateBsdf(
          rotate(N),
          rotate(v),
          rotate(s.direction),
          BASE,
          0.63,
          0.25,
        ),
        f,
      );
      close(
        bsdfPdf(rotate(N), rotate(v), rotate(s.direction), BASE, 0.63, 0.25),
        s.pdf,
      );
      const rotated = sampleBsdf(
        rotate(N),
        rotate(v),
        BASE,
        0.63,
        0.25,
        random3(next),
      );
      if (rotated.pdf > 0) {
        const nl = dot(rotate(N), rotated.direction);
        assert.ok(nl > 0);
        close3(
          rotated.weight,
          evaluateBsdf(
            rotate(N),
            rotate(v),
            rotated.direction,
            BASE,
            0.63,
            0.25,
          ).map((x) => (x * nl) / rotated.pdf) as unknown as BsdfVec3,
        );
      }
    }
  }
});

test("rough unit conductor has independent analytic energy 1-ln(2) and upper PDF mass 1/2", () => {
  const result = integral(N, WHITE, 1, 1);
  result.energy.forEach((x) => close(x, 1 - Math.log(2), 2e-6));
  close(result.mass, 0.5, 1e-11);
  for (const seed of SEEDS) {
    const next = rng(seed);
    let mean = 0,
      valid = 0;
    const count = 18000;
    for (let i = 0; i < count; i++) {
      const s = sampleBsdf(N, N, WHITE, 1, 1, random3(next));
      mean += s.weight[0] / count;
      if (s.pdf > 0) valid++;
    }
    close(mean, 1 - Math.log(2), 0.009);
    close(valid / count, 0.5, 0.012);
  }
});

test("hemisphere PDF plus null-event mass, angular moments and nonconstant radiance are unbiased", () => {
  const cases = [
    { r: 0.48, m: 0, z: 1 },
    { r: 0.75, m: 0.43, z: 0.3 },
    { r: 1, m: 1, z: 0.08 },
  ];
  for (const { r, m, z } of cases) {
    const v = viewAt(z),
      reference = integral(v, BASE, r, m);
    assert.ok(reference.mass > 0 && reference.mass <= 1.001);
    // Independently integrate a directional incident field, not just a white furnace.
    const bins = 120,
      expected = [0, 0, 0];
    for (let zi = 0; zi < bins; zi++)
      for (let pi = 0; pi < 2 * bins; pi++) {
        const l = hemisphere((zi + 0.5) / bins, ((pi + 0.5) * Math.PI) / bins);
        const radiance = 0.2 + 0.8 * l[0] ** 2 + 0.3 * l[2];
        const f = evaluateBsdf(N, v, l, BASE, r, m);
        f.forEach(
          (x, c) =>
            (expected[c] += (x * l[2] * radiance * Math.PI) / (bins * bins)),
        );
      }
    for (const seed of SEEDS) {
      const next = rng(seed),
        count = 24000,
        energy = [0, 0, 0],
        lit = [0, 0, 0],
        moments = [0, 0, 0];
      let valid = 0;
      for (let i = 0; i < count; i++) {
        const s = sampleBsdf(N, v, BASE, r, m, random3(next));
        if (s.pdf === 0) continue;
        valid++;
        const radiance = 0.2 + 0.8 * s.direction[0] ** 2 + 0.3 * s.direction[2];
        for (let c = 0; c < 3; c++) {
          energy[c] += s.weight[c] / count;
          lit[c] += (s.weight[c] * radiance) / count;
          moments[c] += s.direction[c] / count;
        }
      }
      close(valid / count, reference.mass, 0.014);
      moments.forEach((x, c) => close(x, reference.moments[c], 0.017));
      energy.forEach((x, c) => close(x, reference.energy[c], 0.018));
      lit.forEach((x, c) => close(x, expected[c], 0.016));
    }
  }
});

test("Monte Carlo white-furnace energy: metals, dielectrics, mixed materials, roughness and grazing views", (t) => {
  let worst = 0;
  for (const base of [WHITE, BASE])
    for (const m of [0, 0.5, 1])
      for (const r of [BSDF_MIN_ROUGHNESS, 0.15, 0.45, 0.75, 1])
        for (const z of [0.0001, 0.03, 0.3, 1])
          for (const seed of SEEDS) {
            const next = rng(seed),
              count = 3000,
              sum = [0, 0, 0],
              squares = [0, 0, 0];
            for (let i = 0; i < count; i++) {
              const s = sampleBsdf(N, viewAt(z), base, r, m, random3(next));
              s.weight.forEach((x, c) => {
                assert.ok(Number.isFinite(x) && x >= 0);
                sum[c] += x;
                squares[c] += x * x;
              });
            }
            for (let c = 0; c < 3; c++) {
              const mean = sum[c] / count;
              const stderr = Math.sqrt(
                Math.max(0, squares[c] / count - mean * mean) / count,
              );
              worst = Math.max(worst, mean);
              assert.ok(
                mean <= 1 + 6 * stderr + 0.003,
                JSON.stringify({ base, m, r, z, seed, c, mean, stderr }),
              );
            }
          }
  t.diagnostic(
    `CPU white furnace: 360 seeded material/view cases, 1,080,000 samples; maximum mean=${worst}`,
  );
});

test(
  "hardware WebGPU compile/packet/readback parity (not a CPU proof)",
  {
    skip:
      process.env.PELICAN_BSDF_GPU !== "1"
        ? "GPU not requested; CPU tests are NOT evidence of GPU correctness. Set PELICAN_BSDF_GPU=1."
        : false,
    timeout: 90000,
  },
  async (t) => {
    const { chromium } = await import("playwright");
    const server = createServer((_request, response) => {
      response.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      });
      response.end("<!doctype html><title>BSDF hardware probe</title>");
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
    try {
      try {
        browser = await chromium.launch({
          headless: true,
          channel: "chromium",
          timeout: 20000,
          args: ["--use-angle=d3d11"],
        });
      } catch (error) {
        t.skip(
          `Hardware WebGPU unavailable: browser launch failed: ${String(error)}. No GPU proof.`,
        );
        return;
      }
      const page = await browser.newPage();
      const address = server.address();
      assert.ok(address && typeof address === "object");
      await page.goto(`http://127.0.0.1:${address.port}`, {
        waitUntil: "load",
        timeout: 15000,
      });
      const values: number[] = [];
      const gpuRandom = SEEDS.map(rng);
      for (let i = 0; i < 768; i++) {
        const next = gpuRandom[i % gpuRandom.length];
        const n: BsdfVec3 = i % 3 === 0 ? [0.8, 0, 0.6] : N;
        const rotate = (v: BsdfVec3): BsdfVec3 =>
          n === N
            ? v
            : [0.6 * v[0] + 0.8 * v[2], v[1], -0.8 * v[0] + 0.6 * v[2]];
        const z = [1, 0.5, 0.03, 0.0001][i % 4];
        const v = rotate(viewAt(z));
        const l =
          i % 5 === 0
            ? rotate([-Math.sqrt(1 - z * z), 0, z])
            : rotate(hemisphere(next(), next() * 2 * Math.PI));
        const r = [-0.1, 0.045, 0.25, 0.65, 1, 2][i % 6],
          m = [-0.5, 0, 0.5, 1, 2][i % 5];
        values.push(
          ...n,
          r,
          ...v,
          m,
          ...l,
          0,
          ...(i % 7 === 0 ? WHITE : BASE),
          0,
          ...random3(next),
          0,
        );
      }
      // Explicit zero/opposite inputs, null VNDF events and exact random endpoints.
      for (const v of [N, [0, 0, -1], [0, 0, 0]] as BsdfVec3[])
        values.push(...N, 1, ...v, 1, ...N, 0, ...WHITE, 0, 0, 0.75, 0.2, 0);
      for (const u of [
        [0, 0, 0],
        [0.9999, 1 - 2 ** -24, 0.5],
      ] as BsdfVec3[])
        values.push(...N, 0, ...N, 0, ...N, 0, ...BASE, 0, ...u, 0);
      const packed = Array.from(new Float32Array(values));
      const shader =
        BSDF_SHADER +
        String.raw`
struct BsdfProbeQuery {normalRoughness:vec4f,viewMetalness:vec4f,light:vec4f,base:vec4f,random:vec4f,}
@group(0) @binding(0) var<storage,read> bsdfProbeQueries:array<BsdfProbeQuery>;
@group(0) @binding(1) var<storage,read_write> bsdfProbeResults:array<vec4f>;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id:vec3u) {
 if(id.x>=arrayLength(&bsdfProbeQueries)){return;}
 let q=bsdfProbeQueries[id.x];let n=q.normalRoughness.xyz;let v=q.viewMetalness.xyz;
 let r=q.normalRoughness.w;let m=q.viewMetalness.w;let base=q.base.xyz;
 let s=bsdfSample(n,v,base,r,m,q.random.xyz);let offset=id.x*4u;
 bsdfProbeResults[offset]=vec4f(bsdfEvaluate(n,v,q.light.xyz,base,r,m),bsdfPdf(n,v,q.light.xyz,base,r,m));
 bsdfProbeResults[offset+1u]=vec4f(s.direction,s.pdf);
 bsdfProbeResults[offset+2u]=vec4f(s.weight,0);
 bsdfProbeResults[offset+3u]=vec4f(bsdfEvaluate(n,v,s.direction,base,r,m),bsdfPdf(n,v,s.direction,base,r,m));
}`;
      // String execution keeps the browser function independent of tsx helper closures.
      const execute = new Function(
        "return (" +
          String.raw`
async (packet) => {
 if(!navigator.gpu)return {skip:'navigator.gpu unavailable'};
 const adapter=await navigator.gpu.requestAdapter({powerPreference:'high-performance',forceFallbackAdapter:false});
 if(!adapter)return {skip:'no WebGPU adapter'};
 const info=adapter.info;
 const description=[info.vendor,info.architecture,info.device,info.description].join(' ');
 if(info.isFallbackAdapter!==false||/swiftshader|llvmpipe|software|lavapipe|microsoft basic|\bwarp\b/i.test(description))
  return {skip:'hardware adapter not verified: '+description};
 let device;
 try {device=await adapter.requestDevice();}
 catch(error){return {skip:'hardware device unavailable: '+String(error)};}
 const buffers=[];
 try {
  device.pushErrorScope('validation');
  const input=device.createBuffer({size:packet.values.length*4,usage:GPUBufferUsage.STORAGE,mappedAtCreation:true});
  buffers.push(input);new Float32Array(input.getMappedRange()).set(packet.values);input.unmap();
  const size=packet.values.length/20*64;
  const output=device.createBuffer({size,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC});buffers.push(output);
  const read=device.createBuffer({size,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});buffers.push(read);
  const module=device.createShaderModule({code:packet.shader});
  const compilation=await module.getCompilationInfo();
  const errors=compilation.messages.filter(m=>m.type==='error');
  if(errors.length)throw Error(JSON.stringify(errors.map(m=>({line:m.lineNum,message:m.message}))));
  const pipeline=await device.createComputePipelineAsync({layout:'auto',compute:{module,entryPoint:'main'}});
  const group=device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[input,output].map((buffer,binding)=>({binding,resource:{buffer}}))});
  const encoder=device.createCommandEncoder();const pass=encoder.beginComputePass();
  pass.setPipeline(pipeline);pass.setBindGroup(0,group);pass.dispatchWorkgroups(Math.ceil(packet.values.length/20/64));pass.end();
  encoder.copyBufferToBuffer(output,0,read,0,size);device.queue.submit([encoder.finish()]);
  await read.mapAsync(GPUMapMode.READ);const values=Array.from(new Float32Array(read.getMappedRange().slice(0)));read.unmap();
  const error=await device.popErrorScope();if(error)throw Error(error.message);
  return {values,adapter:{vendor:info.vendor,architecture:info.architecture,device:info.device,description:info.description,isFallbackAdapter:info.isFallbackAdapter},messages:compilation.messages.map(m=>({type:m.type,message:m.message}))};
 } finally {for(const buffer of buffers)buffer.destroy();device.destroy();}
}
` +
          ")",
      )() as (packet: { shader: string; values: number[] }) => Promise<{
        skip?: string;
        values?: number[];
        adapter?: unknown;
        messages?: unknown[];
      }>;
      const result = await page.evaluate(execute, { shader, values: packed });
      if (result.skip) {
        t.skip(`${result.skip}. GPU probe skipped, not CPU proof.`);
        return;
      }
      assert.ok(result.values);
      assert.equal(result.values.length, (packed.length / 20) * 16);
      let maxRelativeError = 0;
      for (let i = 0; i < packed.length / 20; i++) {
        const q = packed.slice(i * 20, i * 20 + 20);
        const vec = (offset: number) =>
          q.slice(offset, offset + 3) as unknown as BsdfVec3;
        const n = vec(0),
          v = vec(4),
          l = vec(8),
          base = vec(12),
          u = vec(16),
          r = q[3],
          m = q[7];
        const s = sampleBsdf(n, v, base, r, m, u);
        const actual: number[] = result.values.slice(i * 16, i * 16 + 16);
        const gpuDirection = actual.slice(4, 7) as unknown as BsdfVec3;
        const sampledF = evaluateBsdf(n, v, gpuDirection, base, r, m);
        const sampledPdf = bsdfPdf(n, v, gpuDirection, base, r, m);
        const nlReference = Math.max(
          0,
          dot(n, gpuDirection) / Math.hypot(...n),
        );
        // Compare the mapping's direction separately. At near-opposite grazing,
        // one f32 ULP of L can move a narrow half-vector peak appreciably.
        const expected = [
          ...evaluateBsdf(n, v, l, base, r, m),
          bsdfPdf(n, v, l, base, r, m),
          ...s.direction,
          sampledPdf,
          ...sampledF.map((f) =>
            sampledPdf > 0 ? (f * nlReference) / sampledPdf : 0,
          ),
          0,
          ...sampledF,
          sampledPdf,
        ];
        assert.equal(
          actual[7] > 0,
          s.pdf > 0,
          `GPU sample validity mismatch at query ${i}`,
        );
        actual.forEach((x, field) => {
          assert.ok(Number.isFinite(x), `nonfinite GPU output ${i}:${field}`);
          const reference = expected[field],
            error = Math.abs(x - reference);
          maxRelativeError = Math.max(
            maxRelativeError,
            error / Math.max(1, Math.abs(reference)),
          );
          assert.ok(
            error <= 2e-5 + 5e-4 * Math.abs(reference),
            JSON.stringify({ i, field, x, reference, error, q }),
          );
        });
        if (actual[7] > 0) {
          const direction = actual.slice(4, 7) as unknown as BsdfVec3;
          const normalLength = Math.hypot(...n),
            nl = dot(n, direction) / normalLength;
          assert.ok(nl > 0);
          close(Math.hypot(...direction), 1, 3e-5);
          close(actual[15], actual[7], 3e-4);
          for (let c = 0; c < 3; c++)
            close(actual[8 + c], (actual[12 + c] * nl) / actual[7], 3e-4);
        }
      }
      t.diagnostic(
        JSON.stringify({
          backend: "hardware-webgpu",
          adapter: result.adapter,
          packets: packed.length / 20,
          maxRelativeError,
          compilation: result.messages,
          scope: "BSDF numeric readback only; not an M3/PT/hybrid acceptance",
        }),
      );
    } finally {
      try {
        await browser?.close();
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      }
    }
  },
);
