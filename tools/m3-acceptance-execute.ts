import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, readdir, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { npmCommand } from "./doctor.ts";
import { sourceFingerprint } from "./source-fingerprint.ts";

type Step = { id: string; args: string[]; artifacts?: string };
type Result = { exitCode: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string; error?: string; stdoutTruncated?: boolean; stderrTruncated?: boolean; stdoutBytes?: number; stderrBytes?: number };
type Runner = (step: Step, root: string) => Promise<Result>;
const hardwareEnv = {
  PELICAN_BSDF_GPU: "1", PELICAN_DENOISER_GPU: "1", PELICAN_DIELECTRIC_GPU: "1",
  PELICAN_ENVIRONMENT_GPU: "1", PELICAN_MODEL_BROWSER: "1", PELICAN_TEXTURE_BROWSER: "1",
};
const steps: Step[] = [
  { id: "test", args: ["test"] },
  { id: "distribution-test", args: ["run", "distribution:test"] },
  { id: "m3-probe", args: ["run", "probe:m3"], artifacts: ".pelican/m3-probes" },
  { id: "backend-probe", args: ["run", "probe:backends"], artifacts: ".pelican/backend-probes" },
  { id: "package-pack", args: ["run", "distribution:pack"], artifacts: ".pelican/npm/artifacts" },
  { id: "package-smoke", args: ["run", "distribution:smoke", "--", "--gpu"], artifacts: ".pelican/npm/artifacts" },
];
const LOG_LIMIT = 4 * 1024 * 1024;
export class BoundedLog {
  total = 0;
  head = Buffer.alloc(0);
  tail = Buffer.alloc(0);
  add(chunk: Buffer) {
    this.total += chunk.length;
    const headRemaining = LOG_LIMIT / 2 - this.head.length;
    if (headRemaining > 0) {
      this.head = Buffer.concat([this.head, chunk.subarray(0, headRemaining)]);
      chunk = chunk.subarray(headRemaining);
    }
    if (chunk.length) this.tail = Buffer.concat([this.tail, chunk]).subarray(-LOG_LIMIT / 2);
  }
  get truncated() { return this.total > LOG_LIMIT; }
  text() { return Buffer.concat([this.head, this.tail]).toString("utf8"); }
}
const realRunner: Runner = async (step, root) => {
  const npm = npmCommand(root);
  if (!npm) return { exitCode: null, signal: null, stdout: "", stderr: "", error: "npm CLI not found" };
  return new Promise(resolve => {
    const child = spawn(npm.file, [...npm.prefix, ...step.args], { cwd: root, env: { ...process.env, ...hardwareEnv, NO_COLOR: "1", FORCE_COLOR: "0" }, stdio: ["ignore", "pipe", "pipe"] });
    const out = new BoundedLog(), err = new BoundedLog();
    let error: string | undefined;
    child.stdout.on("data", (chunk: Buffer) => out.add(chunk));
    child.stderr.on("data", (chunk: Buffer) => err.add(chunk));
    child.on("error", e => { error = String(e); });
    child.on("close", (exitCode, signal) => resolve({ exitCode, signal, stdout: out.text(), stderr: err.text(), stdoutBytes: out.total, stderrBytes: err.total, stdoutTruncated: out.truncated, stderrTruncated: err.truncated, error }));
  });
};
async function entries(root: string, dir: string): Promise<string[]> {
  try { return await readdir(path.join(root, dir)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
}
async function exists(file: string) {
  try { await lstat(file); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}
async function guardStaging(root: string) {
  for (const name of ["package", "artifacts"]) {
    if (await exists(path.join(root, ".pelican/npm", name))) throw new Error(`Existing npm ${name}; use a fresh isolated candidate`);
  }
}
async function sha256(file: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}
function skips(result: Result) {
  const text = `${result.stdout}\n${result.stderr}`;
  const lines = text.split(/\r?\n/).filter(line => /(?:#\s*SKIP\b|^\s*[﹣⏭]\s)/i.test(line));
  const summaries = [...text.matchAll(/(?:^|\n)\s*(?:ℹ\s*)?(?:#\s*)?skipped\s+(\d+)/gi)];
  const count = summaries.length ? Number(summaries.at(-1)![1]) : null;
  return { count, lines, complete: !result.stdoutTruncated && !result.stderrTruncated && count !== null && lines.length === count };
}
export async function executeM3(root: string, runner: Runner = realRunner, options: { isolatedCandidate?: boolean; hardware?: boolean } = {}) {
  if (!options.isolatedCandidate || !options.hardware) throw new Error("Explicit isolated candidate and hardware opt-in required");
  root = await realpath(root);
  const pelican = path.join(root, ".pelican");
  if (await exists(pelican) && (await lstat(pelican)).isSymbolicLink()) throw new Error(".pelican must not be a symlink");
  for (const directory of [path.join(pelican, "npm"), path.join(pelican, "m3-execution")]) {
    if (await exists(directory) && (await lstat(directory)).isSymbolicLink()) throw new Error(`${directory} must not be a symlink`);
  }
  await guardStaging(root);
  const base = path.join(pelican, "m3-execution");
  await mkdir(base, { recursive: true });
  const lock = path.join(base, "lock");
  await mkdir(lock);
  try {
    const output = path.join(base, `${Date.now()}-${process.pid}`);
    await mkdir(output);
    const before = await sourceFingerprint(root);
    await writeFile(path.join(output, "source-before.json"), JSON.stringify(before, null, 2));
    const results: (Omit<Result, "stdout" | "stderr"> & { id: string; args: string[]; startedAt: string; endedAt: string; artifacts: { path: string; sha256?: string; sha256File?: string }[]; artifactDiscovery?: string; skipped?: ReturnType<typeof skips> })[] = [];
    let failure: string | null = null;
    try {
      for (const step of steps) {
        if (step.id === "package-pack") await guardStaging(root);
        const previous = step.artifacts ? new Set(await entries(root, step.artifacts)) : undefined;
        const startedAt = new Date().toISOString();
        let result: Result;
        try { result = await runner(step, root); }
        catch (error) { result = { exitCode: null, signal: null, stdout: "", stderr: "", error: String(error) }; }
        const endedAt = new Date().toISOString();
        await writeFile(path.join(output, `${step.id}.stdout.log`), result.stdout);
        await writeFile(path.join(output, `${step.id}.stderr.log`), result.stderr);
        const { stdout, stderr, ...metadata } = result;
        const record: typeof results[number] = { id: step.id, args: step.args, startedAt, endedAt, ...metadata, artifacts: [] };
        if (step.id === "test" || step.id === "distribution-test") record.skipped = skips(result);
        results.push(record);
        if (step.artifacts && previous) {
          for (const name of await entries(root, step.artifacts)) {
            if (previous.has(name)) continue;
            const file = path.join(root, step.artifacts, name);
            const info = await lstat(file);
            if (info.isSymbolicLink()) throw new Error(`Unexpected artifact symlink: ${file}`);
            const key = info.isDirectory() ? path.join(file, step.id === "m3-probe" ? "development-report.json" : "report.json") : file;
            record.artifacts.push({ path: file, ...(await exists(key) && (await lstat(key)).isFile() ? { sha256: await sha256(key), sha256File: key } : {}) });
          }
          record.artifactDiscovery = !record.artifacts.length ? "missing-new-artifact" : record.artifacts.some(artifact => !artifact.sha256) ? "missing-key-report" : "recorded";
        }
        if (result.exitCode !== 0 || result.signal || result.error) { failure = `${step.id} failed`; break; }
        if (result.stdoutTruncated || result.stderrTruncated) { failure = `${step.id} log limit exceeded`; break; }
        if ((await sourceFingerprint(root)).sha256 !== before.sha256) { failure = `source changed after ${step.id}`; break; }
      }
    } catch (error) { failure = `executor error: ${String(error)}`; }
    const after = await sourceFingerprint(root);
    await writeFile(path.join(output, "source-after.json"), JSON.stringify(after, null, 2));
    if (after.sha256 !== before.sha256) failure ??= "source changed";
    const report = {
      scope: "execution record, not formal acceptance", status: failure ? "failed" : "executed",
      failure, formalMilestoneAccepted: false, releaseAuthorized: false,
      sourceBefore: before.sha256, sourceAfter: after.sha256, hardwareOptIn: hardwareEnv,
      steps: results, omitted: steps.slice(results.length).map(step => step.id),
      limitations: [
        "Independent AI workflow and full independent image, quality, material, compatibility and resource matrices are not covered.",
        "Exits do not prove all tests ran; inspect skipped counts and lines. Incomplete skip parsing is unknown, not zero skips.",
        "Public registry verification is deferred until after actual publication; this does not authorize release.",
        "Artifact directories remain in place; their sha256 is the named report file digest, not a directory digest.",
        "The lock only serializes this executor in this workspace; operators must ensure exclusive GPU access across all processes.",
      ],
    };
    await writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
    return { output, report };
  } finally { await rm(lock, { recursive: true }); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 2 || !args.includes("--isolated-candidate") || !args.includes("--hardware")) throw new Error("Use --isolated-candidate --hardware");
    const { output, report } = await executeM3(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."), realRunner, { isolatedCandidate: true, hardware: true });
    console.log(JSON.stringify({ output, ...report }, null, 2));
    if (report.status !== "executed") process.exitCode = 1;
  } catch (error) { console.error(String(error)); process.exitCode = 1; }
}
