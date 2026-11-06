import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { sourceFingerprint } from "../tools/source-fingerprint.ts";
import { executeMaterialGraphComponent } from "../tools/m3-material-graph-component.ts";
import type { runMaterialGraphGpuProbe } from "../tools/m3-material-graph-gpu-probe.ts";

const oracle = (times: number[]) => times.flatMap((time, i) => {
  const t = Math.max(0, Math.min(1, time)), a = .8 * t, d = a < .3 ? 1 : 0;
  const v = [a, t, a, d, ...(i ? [4, 5, 6] : [1, 2, 3]), d];
  return [...v, ...v];
});
const expected = [oracle([.25, .75]), oracle([1.5, -.25])];
const report = () => ({ passed: true, backend: "webgpu", adapter: { isFallbackAdapter: false }, triangles: 4,
  expected: structuredClone(expected), actual: structuredClone(expected), limitations: [] as string[] });

test("component executes its runner, validates both readbacks and freezes source", async t => {
  const temp = await mkdtemp(path.join(tmpdir(), "m3-component-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const root = path.join(temp, "src"), output = path.join(temp, "out");
  await mkdir(root); await writeFile(path.join(root, "file.ts"), "original");
  const identity = (await sourceFingerprint(root)).sha256;
  let calls = 0;
  const run: typeof runMaterialGraphGpuProbe = async callback => { calls++; const r = report(); await callback?.({ backend: r.backend, adapter: r.adapter, triangles: r.triangles, expected: r.expected, actual: r.actual }); return r; };
  const result = await executeMaterialGraphComponent(root, output, identity, run);
  assert.equal(calls, 1); assert.equal(result.formalMilestoneAccepted, false);
  assert.equal(JSON.parse(await readFile(path.join(output, "material-graph-raw.json"), "utf8")).actual.length, 2);
  const corrupt: typeof runMaterialGraphGpuProbe = async callback => { const r = report(); r.actual[1][0] = 0; await callback?.({ backend: r.backend, adapter: r.adapter, triangles: r.triangles, expected: r.expected, actual: r.actual }); return r; };
  await assert.rejects(executeMaterialGraphComponent(root, path.join(temp, "corrupt"), identity, corrupt), /actual\[1\]\[0\]/);
  const mismatch: typeof runMaterialGraphGpuProbe = async callback => {
    const r = report(); await callback?.({ backend: r.backend, adapter: r.adapter, triangles: r.triangles, expected: r.expected, actual: structuredClone(r.actual) });
    r.actual[0][0] = 42; return r;
  };
  await assert.rejects(executeMaterialGraphComponent(root, path.join(temp, "mismatch"), identity, mismatch), /differs from raw/);
  const drift: typeof runMaterialGraphGpuProbe = async callback => { const r = report(); await callback?.({ backend: r.backend, adapter: r.adapter, triangles: r.triangles, expected: r.expected, actual: r.actual }); await writeFile(path.join(root, "file.ts"), "changed"); return r; };
  await assert.rejects(executeMaterialGraphComponent(root, path.join(temp, "drift"), identity, drift), /sourceIdentity/);
  const failure: typeof runMaterialGraphGpuProbe = async callback => { await callback?.(report()); throw Error("GPU assertion failed"); };
  await assert.rejects(executeMaterialGraphComponent(root, path.join(temp, "failure"), identity, failure), /GPU assertion failed/);
  assert.equal(JSON.parse(await readFile(path.join(temp, "failure", "material-graph-raw.json"), "utf8")).actual.length, 2);
  await assert.rejects(executeMaterialGraphComponent(root, output, identity, run), /EEXIST/);
});
