import { lstat, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual as equal } from "node:util";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";
import { decode } from "fast-png";
import { sourceFingerprint } from "./source-fingerprint.ts";

// This verifier checks reported fallback and recovery consistency, not execution provenance.
export async function verifyBackendEvidence(directory: string, sourceRoot: string) {
  const issues: string[] = [];
  const check = (ok: unknown, message: string) => { if (!ok) issues.push(message); };
  const boundedRead = async (name: string): Promise<Buffer> => {
    const root = await realpath(directory), file = path.join(root, name), target = await realpath(file);
    const relative = path.relative(root, target), stat = await lstat(file);
    if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) || !stat.isFile() || stat.size > 4 * 1024 * 1024) throw Error("unsafe or oversized evidence");
    const bytes = await readFile(file);
    if (bytes.length > 4 * 1024 * 1024) throw Error("oversized evidence");
    return bytes;
  };
  const sameAdapter = (a: any, b: any): boolean => {
    const valid = (v: any) => v && v.isFallbackAdapter === false && typeof v.vendor === "string" && v.vendor.trim().length > 0 && typeof v.architecture === "string" && !/swiftshader|llvmpipe|software|warp/i.test(`${v.vendor} ${v.architecture}`) && Array.isArray(v.features) && v.features.every((feature: unknown) => typeof feature === "string" && feature.length > 0) && new Set(v.features).size === v.features.length;
    return !!valid(a) && !!valid(b) && a.vendor === b.vendor && a.architecture === b.architecture && equal([...a.features].sort(), [...b.features].sort());
  };
  const json = async (name: string): Promise<any> => {
    try { return JSON.parse((await boundedRead(name)).toString("utf8")) ?? {}; }
    catch { issues.push(`${name}: missing or invalid JSON`); return {}; }
  };
  const image = async (name: string, expected: any) => {
    try {
      const bytes = await boundedRead(name);
      if (bytes.length > 4 * 1024 * 1024 || bytes.length < 45 || !bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) || bytes.readUInt32BE(8) !== 13 || bytes.toString("ascii", 12, 16) !== "IHDR" || bytes.readUInt32BE(16) !== 640 || bytes.readUInt32BE(20) !== 360 || bytes[24] !== 8 || ![2,6].includes(bytes[25]) || bytes[28] !== 0) throw Error("unsupported PNG");
      const idat: Buffer[] = []; let offset = 8, ended = false;
      while (offset + 12 <= bytes.length) {
        const length = bytes.readUInt32BE(offset), next = offset + 12 + length;
        if (next > bytes.length) throw Error("truncated PNG");
        const type = bytes.toString("ascii", offset + 4, offset + 8);
        if (["iCCP", "acTL", "tRNS"].includes(type)) throw Error("unsupported PNG chunk");
        if (type === "IDAT") idat.push(bytes.subarray(offset + 8, offset + 8 + length));
        if (type === "IEND") { if (length || next !== bytes.length) throw Error("invalid IEND"); ended = true; break; }
        offset = next;
      }
      if (!ended || !idat.length) throw Error("missing PNG data");
      const expectedSize = (640 * (bytes[25] === 2 ? 3 : 4) + 1) * 360;
      if (inflateSync(Buffer.concat(idat), { maxOutputLength: expectedSize + 1 }).length !== expectedSize) throw Error("invalid PNG size");
      const png = decode(bytes, { checkCrc: true });
      if (png.depth !== 8 || png.channels < 3) throw Error("unsupported PNG");
      let nonBlack = 0; const colors = new Set<number>();
      for (let i = 0; i < png.width * png.height; i += 4) {
        const p = i * png.channels, d = png.data;
        if (d[p] + d[p + 1] + d[p + 2] > 12) nonBlack++;
        colors.add((d[p] >> 3) * 1024 + (d[p + 1] >> 3) * 32 + (d[p + 2] >> 3));
      }
      const pixels = { width: png.width, height: png.height, colors: colors.size, nonBlack };
      check(png.width > 0 && png.height > 0 && colors.size > 20 && nonBlack > 1000, `${name}: blank image`);
      if (expected !== undefined) check(equal(pixels, expected), `${name}: metrics mismatch`);
    } catch { issues.push(`${name}: missing, invalid or unsupported PNG`); }
  };
  const resources = (r: any, label: string) => {
    const o = r?.owned, entries = r?.entries, counters = r?.counters;
    check(r?.disposed === false && Array.isArray(entries) && entries.length > 0 && o?.entries === entries.length && o?.loaded === entries.length && o?.pending === 0 && o?.inFlightLoads === 0 && o?.inFlightDisposals === 0 && entries.every((e: any) => e?.state === "loaded" && Number.isSafeInteger(e.refCount) && e.refCount > 0 && typeof e.key === "string" && typeof e.type === "string") && o?.references === entries.reduce((n: number, e: any) => n + (Number.isSafeInteger(e?.refCount) ? e.refCount : 0), 0) && Number.isSafeInteger(counters?.disposalsCompleted) && counters?.disposalsFailed === 0, `${label}: invalid resources`);
  };
  const stable = (a: any, b: any, backend: string, mode: string, label: string) => {
    check(a?.backend === backend && b?.backend === backend && a?.ready === true && b?.ready === true && a?.mode === mode && b?.mode === mode && Number.isSafeInteger(a?.tick) && a.tick === b?.tick && Array.isArray(a?.runtime?.records) && a.runtime.records.length > 0 && equal(a.runtime.records, b?.runtime?.records), `${label}: state preservation`);
    resources(a?.resources, `${label} before`); resources(b?.resources, `${label} after`);
    check(a?.resources?.owned != null && equal(a.resources.owned, b?.resources?.owned) && equal(a.resources.entries, b?.resources?.entries), `${label}: resource preservation`);
  };
  const recovery = (a: any, b: any, backend: string, mode: string, label: string) => {
    stable(a, b, backend, mode, label);
    const x = a?.rendering?.gpuRecovery, y = b?.rendering?.gpuRecovery;
    const prior = Array.isArray(x?.events) ? x.events : [], events = Array.isArray(y?.events) ? y.events : [];
    const delta = events.slice(prior.length);
    check(x?.active === false && y?.active === false && Number.isSafeInteger(x?.count) && y?.count === x.count + 1 && Array.isArray(x?.events) && Array.isArray(y?.events) && equal(events.slice(0, prior.length), prior) && delta.length >= 2 && delta[0]?.phase === "lost" && delta.at(-1)?.phase === "restored" && delta.every((e: any) => e?.tick === a?.tick && typeof e?.reason === "string" && e.reason.length > 0) && (backend === "WebGLBackend" ? /TC_RENDER_CONTEXT_LOST/.test(delta[0]?.reason ?? "") && /WebGL2/.test(delta.at(-1)?.reason ?? "") : /device/i.test(delta[0]?.reason ?? "") && /WebGPU/i.test(delta.at(-1)?.reason ?? "")), `${label}: recovery events`);
  };
  const report = await json("report.json"), raw = await json("webgpu/recovery.json");
  let source = "";
  try { source = (await sourceFingerprint(sourceRoot)).sha256; }
  catch { issues.push("source: cannot fingerprint source tree"); }
  check(!!source && report.source?.sha256 === source, "source: fingerprint mismatch");
  check(!!source && report.sourceFinal?.sha256 === source, "source: final fingerprint missing or mismatched");
  for (const failure of ["missing-api", "null-adapter", "rejected-adapter"]) {
  const cases = Array.isArray(report.cases) ? report.cases.filter((v: any) => v?.failure === failure) : [];
  check(cases.length === 1, `${failure}: expected exactly one case`);
  const c = cases[0] ?? {}, before = c.before ?? {}, after = c.after ?? {};
  check(Number.isSafeInteger(c.adapterRequests) && (failure === "missing-api" ? c.adapterRequests === 0 : c.adapterRequests > 0), `${failure}: adapter injection not observed`);
  check(before.backend === "WebGLBackend" && after.backend === "WebGLBackend" && before.ready === true && after.ready === true && before.mode === "raster" && after.mode === "raster" && Number.isSafeInteger(before.tick) && after.tick === before.tick + 2, `${failure}: backend/mode/tick mismatch`);
  check(before.rendering?.settings != null && equal(before.rendering.settings, after.rendering?.settings), `${failure}: settings changed`);
  const replies = c.modeReplies;
  check(Array.isArray(replies) && replies.length === 2, `${failure}: missing mode replies`);
  for (const [i, mode] of ["path", "hybrid"].entries()) {
    const entry = replies?.[i], reply = entry?.reply;
    check(entry?.mode === mode && reply?.status === "failed" && reply?.data === null && Array.isArray(reply.diagnostics) && reply.diagnostics.some((d: any) => d?.code === "TC_RENDER_MODE_UNAVAILABLE" && d?.severity === "error") && entry.after?.mode === "raster" && entry.after?.backend === "WebGLBackend" && entry.after?.tick === before.tick && equal(entry.after?.runtime?.records, before.runtime?.records) && equal(entry.after?.rendering?.settings, before.rendering?.settings), `${failure}: ${mode} rejection`);
    stable(before, entry?.after, "WebGLBackend", "raster", `${failure} ${mode} rejection`);
  }
  check(equal(c.codes, ["TC_RENDER_MODE_UNAVAILABLE", "TC_RENDER_MODE_UNAVAILABLE", "TC_RENDER_COMPUTE_UNAVAILABLE", "TC_RENDER_COMPUTE_UNAVAILABLE"]), `${failure}: rejection codes mismatch`);
  check(typeof c.status === "string" && /WebGL2/.test(c.status) && c.identity?.unmasked === true && typeof c.identity?.renderer === "string" && c.identity.renderer.trim().length > 0 && !/swiftshader|llvmpipe|software/i.test(c.identity.renderer), `${failure}: renderer identity/status`);
  await image(`${failure}.png`, c.pixels); await image(`${failure}-restored.png`, undefined);
  const recoveries = Array.isArray(c.recoveries) ? c.recoveries : [];
  check(recoveries.length === 2, `${failure}: expected two recoveries`);
  for (const [i, item] of recoveries.entries()) {
    recovery(item?.before, item?.after, "WebGLBackend", "raster", `${failure} recovery ${i + 1}`);
    if (i === 0) stable(after, item?.before, "WebGLBackend", "raster", `${failure} pre-recovery`);
    else check(equal(recoveries[i - 1]?.after?.rendering?.gpuRecovery, item?.before?.rendering?.gpuRecovery), `${failure}: discontinuous recovery history`);
  }
  const a = c.lifecycle?.before, b = c.lifecycle?.after, reloads = c.lifecycle?.reloads, t = c.teardown, tr = t?.resources;
  resources(a, "reload before"); resources(b, "reload after");
  check(Array.isArray(reloads) && reloads.length === 3 && equal(reloads.at(-1), b), `${failure}: reload observations`);
  let previous = a;
  for (const [i, r] of (Array.isArray(reloads) ? reloads : []).entries()) {
    resources(r, `reload ${i + 1}`);
    check(equal(previous?.owned, r?.owned) && Number.isSafeInteger(previous?.counters?.disposalsCompleted) && r?.counters?.disposalsCompleted > previous.counters.disposalsCompleted, `reload ${i + 1}: ownership/disposal`);
    previous = r;
  }
  check(t?.ready === false && t?.contextLost === true && t?.canvases === 0 && tr?.disposed === true && tr?.owned?.entries === 0 && tr?.owned?.references === 0 && Array.isArray(tr?.entries) && tr.entries.length === 0 && tr?.counters?.disposalsFailed === 0 && Number.isSafeInteger(b?.counters?.disposalsCompleted) && tr?.counters?.disposalsCompleted >= b.counters.disposalsCompleted, `${failure}: teardown mismatch`);
  check(Array.isArray(c.errors) && c.errors.length === 0, `${failure}: browser errors`);
  }
  const unavailable = Array.isArray(report.cases) ? report.cases.filter((v: any) => v?.failure === "no-graphics-backend") : [];
  check(unavailable.length === 1, "no-graphics-backend: expected exactly one case");
  const failure = unavailable[0];
  check(typeof failure?.failureDetail === "string" && /TC_RENDER_BACKEND_UNAVAILABLE/.test(failure.failureDetail) && (failure.ready === null || failure.ready === "false") && failure.backend === null && Number.isSafeInteger(failure.webgl2Requests) && failure.webgl2Requests > 0, "no-graphics-backend: missing startup failure observation");
  const gpu = report.webgpu ?? {}, p = raw.pathRecovery ?? {}, repetitions = Array.isArray(raw.repetitions) ? raw.repetitions : [];
  recovery(p.before, p.after, "WebGPUBackend", "path", "webgpu path");
  const adapter = p.before?.adapter;
  check(sameAdapter(adapter, p.after?.adapter), "webgpu: actual device adapter identity/fallback");
  check(raw.before?.tick === p.before?.tick && raw.before?.mode === p.before?.mode && equal(raw.before?.records, p.before?.runtime?.records) && raw.after?.tick === p.after?.tick && raw.after?.mode === p.after?.mode && equal(raw.after?.records, p.after?.runtime?.records) && equal(raw.after?.recovery, p.after?.rendering?.gpuRecovery), "webgpu: path summary mismatch");
  check(gpu.tick === raw.after?.tick && equal(gpu.recovery, raw.after?.recovery) && equal(gpu.pixels, raw.pixels) && equal(gpu.repetitions, raw.repetitions) && equal(gpu.errors, raw.errors), "webgpu: summary disagrees with recovery.json");
  check(raw.pixels?.backend === "webgpu" && raw.pixels?.finite === true && Number.isFinite(raw.pixels?.nonBlack) && raw.pixels.nonBlack > 10000 && Number.isFinite(raw.pixels?.maximum) && raw.pixels.maximum > 0, "webgpu: invalid readback pixels");
  const capture = raw.capture ?? {};
  stable(capture.before, capture.after, "WebGPUBackend", "path", "webgpu capture");
  check(sameAdapter(capture.before?.adapter, adapter) && capture.before?.tick === p.after?.tick && equal(capture.before?.runtime?.records, p.after?.runtime?.records) && equal(capture.before?.rendering?.gpuRecovery, p.after?.rendering?.gpuRecovery), "webgpu: capture not tied to recovery");
  check(capture.pixels != null, "webgpu: missing screenshot metrics");
  await image("webgpu/recovered-path.png", capture.pixels);
  check(repetitions.length === 2 && repetitions[0]?.mode === "hybrid" && repetitions[1]?.mode === "raster", "webgpu: missing recovery modes");
  let previousGpu = p.after;
  for (const item of repetitions) {
    recovery(item?.before, item?.after, "WebGPUBackend", item?.mode, `webgpu ${item?.mode}`);
    check(equal(item?.recovery, item?.after?.rendering?.gpuRecovery) && equal(previousGpu?.rendering?.gpuRecovery, item?.before?.rendering?.gpuRecovery) && previousGpu?.tick === item?.before?.tick && equal(previousGpu?.runtime?.records, item?.before?.runtime?.records) && equal(previousGpu?.resources?.owned, item?.before?.resources?.owned) && sameAdapter(adapter, item?.before?.adapter) && sameAdapter(adapter, item?.after?.adapter), `webgpu ${item?.mode}: history/adapter mismatch`);
    previousGpu = item?.after;
  }
  check(Array.isArray(raw.errors) && raw.errors.length === 0, "webgpu: browser errors");
  try { check((await sourceFingerprint(sourceRoot)).sha256 === source, "source: changed during verification"); }
  catch { issues.push("source: cannot recheck source tree"); }
  return { accepted: issues.length === 0, formalMilestoneAccepted: false as const, releaseAllowed: false as const, issues, limitations: "Only reported WebGL fallback and WebGPU recovery consistency; compute rejection details and execution provenance are not independently authenticated. Not formal M3 acceptance." };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const value = (name: string) => { const i = args.indexOf(name); if (i < 0 || !args[i + 1] || args[i + 1].startsWith("--")) throw new Error(`Missing ${name}`); return args[i + 1]; };
  try {
    const result = await verifyBackendEvidence(value("--evidence-root"), value("--source-root"));
    if (args.includes("--output")) await writeFile(value("--output"), JSON.stringify(result, null, 2) + "\n", { flag: "wx" });
    console.log(JSON.stringify(result, null, 2));
    if (!result.accepted) process.exitCode = 1;
  } catch (error) { console.error(error); process.exitCode = 1; }
}
