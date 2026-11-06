import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { encode } from "fast-png";

// Synthetic verifier input, not a record of a GPU execution.
export async function writeAuditBackend(dir: string, source: unknown) {
  await mkdir(path.join(dir, "webgpu"), { recursive: true });
  const width = 640, height = 360, data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) data.set([(i % width) % 256, Math.floor(i / width) % 256, (i % 64) * 4, 255], i * 4);
  const png = encode({ width, height, data, channels: 4, depth: 8 });
  let nonBlack = 0; const colors = new Set<number>();
  for (let i = 0; i < width * height; i += 4) {
    const p = i * 4;
    if (data[p] + data[p + 1] + data[p + 2] > 12) nonBlack++;
    colors.add((data[p] >> 3) * 1024 + (data[p + 1] >> 3) * 32 + (data[p + 2] >> 3));
  }
  const pixels = { width, height, colors: colors.size, nonBlack };
  const resources = (disposalsCompleted = 0) => ({ disposed: false, owned: { entries: 1, loaded: 1, pending: 0, references: 1, inFlightLoads: 0, inFlightDisposals: 0 }, entries: [{ type: "json", key: "scene", state: "loaded", refCount: 1 }], counters: { disposalsCompleted, disposalsFailed: 0 } });
  const start = { active: false, count: 0, events: [] as { phase: string; tick: number; reason: string }[] };
  const state = (backend: string, mode: string, tick: number, recovery = start) => ({ backend, mode, tick, ready: true, runtime: { records: [{ id: "scene" }] }, resources: resources(), rendering: { settings: {}, gpuRecovery: structuredClone(recovery) } });
  const recovered = (before: ReturnType<typeof state>, gpu: boolean) => {
    const after = structuredClone(before), prior = before.rendering.gpuRecovery;
    after.rendering.gpuRecovery = { active: false, count: prior.count + 1, events: [...prior.events, { phase: "lost", tick: before.tick, reason: gpu ? "device lost" : "TC_RENDER_CONTEXT_LOST" }, { phase: "restored", tick: before.tick, reason: gpu ? "WebGPU restored" : "WebGL2 restored" }] };
    return after;
  };
  const before = state("WebGLBackend", "raster", 4), after = state("WebGLBackend", "raster", 6);
  const first = recovered(after, false), second = recovered(first, false);
  const reloads = [1, 2, 3].map(resources);
  const base = {
    before, after, codes: ["TC_RENDER_MODE_UNAVAILABLE", "TC_RENDER_MODE_UNAVAILABLE", "TC_RENDER_COMPUTE_UNAVAILABLE", "TC_RENDER_COMPUTE_UNAVAILABLE"],
    status: "WebGL2", identity: { unmasked: true, renderer: "test hardware" }, pixels,
    modeReplies: ["path", "hybrid"].map(mode => ({ mode, reply: { status: "failed", data: null, diagnostics: [{ code: "TC_RENDER_MODE_UNAVAILABLE", severity: "error" }] }, after: structuredClone(before) })),
    recoveries: [{ before: after, after: first }, { before: first, after: second }],
    lifecycle: { before: resources(), after: reloads[2], reloads },
    teardown: { ready: false, contextLost: true, canvases: 0, resources: { disposed: true, owned: { entries: 0, references: 0 }, entries: [], counters: { disposalsCompleted: 3, disposalsFailed: 0 } } }, errors: [],
  };
  const cases = ["missing-api", "null-adapter", "rejected-adapter"].map((failure, i) => ({ ...structuredClone(base), failure, adapterRequests: i ? 1 : 0 }));
  for (const c of cases) for (const suffix of ["", "-restored"]) await writeFile(path.join(dir, `${c.failure}${suffix}.png`), png);
  const adapter = { vendor: "test-hardware", architecture: "test", isFallbackAdapter: false, features: [] };
  const gpuBefore = { ...state("WebGPUBackend", "path", 4), adapter };
  const gpuAfter = { ...recovered(gpuBefore, true), adapter };
  let previous = gpuAfter;
  const repetitions = ["hybrid", "raster"].map(mode => {
    const before = { ...structuredClone(previous), mode }, after = { ...recovered(before, true), adapter };
    previous = after;
    return { mode, before, after, recovery: after.rendering.gpuRecovery };
  });
  const raw = { before: { tick: 4, mode: "path", records: gpuBefore.runtime.records }, after: { tick: 4, mode: "path", records: gpuAfter.runtime.records, recovery: gpuAfter.rendering.gpuRecovery }, pathRecovery: { before: gpuBefore, after: gpuAfter }, capture: { before: gpuAfter, after: structuredClone(gpuAfter), pixels }, repetitions, pixels: { backend: "webgpu", finite: true, nonBlack: 20000, maximum: 1 }, errors: [] };
  const report = { source, sourceFinal: structuredClone(source), cases: [...cases, { failure: "no-graphics-backend", failureDetail: "TC_RENDER_BACKEND_UNAVAILABLE", ready: null, backend: null, webgl2Requests: 1 }], webgpu: { tick: raw.after.tick, recovery: raw.after.recovery, pixels: raw.pixels, repetitions, errors: [] } };
  await writeFile(path.join(dir, "webgpu/recovered-path.png"), png);
  await writeFile(path.join(dir, "webgpu/recovery.json"), JSON.stringify(raw));
  await writeFile(path.join(dir, "report.json"), JSON.stringify(report));
  return { dir, report, raw };
}
