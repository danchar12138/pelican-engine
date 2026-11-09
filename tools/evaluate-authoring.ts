import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { npmCommand } from "./doctor.ts";

/** Prepare identical tasks in an installed npm workspace; the model is external. */
const args = process.argv.slice(2),
  index = args.indexOf("--package"),
  specifier = args[index + 1];
if (index < 0 || !specifier)
  throw new Error(
    "Usage: npm run evaluate:author -- --package <package@version|tarball> [--label <name>]",
  );
const root = fileURLToPath(new URL("../", import.meta.url)),
  npm = npmCommand(root)!;
const labelIndex = args.indexOf("--label"),
  label = labelIndex < 0 ? "author" : args[labelIndex + 1]!;
if (!/^[a-z0-9-]+$/.test(label))
  throw new Error("TC_EVAL_LABEL: Use lowercase letters, numbers and hyphens.");
const workspace = await mkdtemp(path.join(tmpdir(), `pelican-eval-${label}-`));
const selected = /\.tgz$/.test(specifier) ? path.resolve(specifier) : specifier;
const execute = promisify(execFile);
const coldStartBegan = Date.now();
await execute(
  npm.file,
  [
    ...npm.prefix,
    "--prefix",
    workspace,
    "install",
    "--save-dev",
    "--save-exact",
    "--no-audit",
    "--no-fund",
    selected,
    "fflate@0.8.3",
  ],
  { cwd: workspace, timeout: 120000, maxBuffer: 4000000, windowsHide: true },
);
const coldStartMs = Date.now() - coldStartBegan;
const installed = JSON.parse(
  await readFile(
    path.join(workspace, "node_modules/pelican-engine/package.json"),
    "utf8",
  ),
);
const recorder = `import {spawn} from 'node:child_process';import{appendFile,readFile}from'node:fs/promises';import path from'node:path';import{fileURLToPath}from'node:url';
const root=fileURLToPath(new URL('./',import.meta.url)),args=process.argv.slice(2),started=Date.now();let stdout='',stderr='';
const child=spawn(process.execPath,[path.join(root,'node_modules/pelican-engine/lib/tools/npm/entry.js'),...args],{cwd:root,stdio:['inherit','pipe','pipe'],windowsHide:true});
child.stdout.on('data',b=>{stdout+=b;process.stdout.write(b);});child.stderr.on('data',b=>{stderr+=b;process.stderr.write(b);});
child.on('error',e=>{stderr+=String(e);});
child.on('close',async code=>{let report;try{report=JSON.parse(stdout)}catch{}let batchOperations=null;if(args[0]==='batch'){try{const i=args.indexOf('--file'),body=JSON.parse(await readFile(path.resolve(root,args[i+1]),'utf8'));batchOperations=(Array.isArray(body)?body:body.commands).length;}catch{}}await appendFile(path.join(root,'commands.jsonl'),JSON.stringify({started,ended:Date.now(),args,exitCode:code,status:report?.status,batchOperations,batchCompletedOperations:report?.data?.completed??null,diagnostics:report?.diagnostics??report?.data?.diagnostics,stdoutBytes:Buffer.byteLength(stdout),stderrBytes:Buffer.byteLength(stderr)})+'\\n');process.exitCode=code??1;});
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>child.kill(signal));`;
await writeFile(path.join(workspace, "pelican-eval.mjs"), recorder);
const task = {
  format: "pelican.author-evaluation",
  version: 1,
  label,
  engineVersion: installed.version,
  workspace,
  kind: "external-ai-task-specification",
  coldStart: {npmInstallMs:coldStartMs, tokenUsage:null},
  environment: {platform:process.platform,node:process.version},
  targets: {status:"unverified",firstCompleteAcceptanceRate:.7,averageCliCalls:8,averageTokens:20000,faultFactCoverage:.8},
  objective:
    "Use only the installed pelican-engine public API in this workspace. Do not read/modify engine repository source or node_modules implementation. Engine package docs/types and JSON CLI queries are allowed. Do not substitute a separate renderer or change task acceptance to make it pass.",
  invocation:
    "Use node pelican-eval.mjs <CLI arguments> for all engine commands, including API discovery, to record failures and query cost. You may use ordinary npm dependencies declared by this project.",
  tasks: [
    {
      id: "collect",
      acceptance: [
        "Create game in ./collect using npm-installed CLI. A player controlled by keyboard and a clickable button collects a visible object and increments a count in UI.",
        "Use engine physics for a falling prop, and the installed fflate npm library for a real JSON encode/compress/decompress round-trip used in the gameplay.",
        "Save/load restores the collected count; rendering and UI remain usable after load. Build a production output.",
      ],
    },
    {
      id: "extension",
      acceptance: [
        "Create game in ./extension. Display a procedural indexed triangle mesh built from TS arrays with UVs and a normal/roughness/emissive texture workflow; do not replace it with a built-in box/sphere/plane.",
        "Load a browser-only module during per-instance initialization; it registers a resize listener and visible DOM marker. Scene reload disposes the prior listener and marker. Runtime local state belongs to one instance and restores through engine save/load.",
        "Use a reusable versioned managed rendering extension with a public postprocess graph and runtime controls. Build and demonstrate the public integration without reading engine source.",
      ],
    },
    {id:"character",acceptance:["Keyboard movement, one grounded jump, held-key behavior, follow camera, saved position and jump counter survive save/load."]},
    {id:"pointer",acceptance:["Canvas-local pointer aim and wheel, spawn/expiry and restart, keyboard release across restoration."]},
    {id:"quality",acceptance:["Raster default. Explicit hybrid/path tier controls, prewarm without advancing tick, repeated switches, native resolution, truthful unsupported-backend diagnostics."]},
    {id:"worker",acceptance:["Module Worker updates managed material visibly; bounded failures, cleanup on restart and saved state restore."]},
    {id:"texture",acceptance:["Decode bounded runtime image bytes with an npm codec; validate decoded allocation, visible colors, checkpoint and cleanup."]},
    {id:"dynamic-data",acceptance:["Fetch validated JSON, reject malformed input, publish on fixed ticks; expose fetch failure without freezing UI."]},
    {id:"loading",acceptance:["Visible startup feedback under slow download, exact failure and retry; replace with an author-owned DOM view and remove listeners."]},
    {id:"model",acceptance:["Import local GLB, discover and bind exact named material slots, play an existing clip; verify pixels and restored animation."]},
    {id:"audio",acceptance:["Real browser button unlocks an audio device, plays/stops logical voices and restores state; report audibility measurement separately."]},
    {id:"ui",acceptance:["Narrow-screen dynamic UI supports repeated add/remove, six-item boundary, stale generation and restored slots."]},
    {id:"iteration",acceptance:["Change compatible runtime logic without losing world/instance state; incompatible declaration reports explicit restart requirement."]},
    {id:"diagnostics",acceptance:["Inspect bounded observations and screenshot facts on fixed failure and healthy cases; distinguish facts from inferred causes."]},
  ],
  recording:
    "Before first check for each task, record an attempt. Keep the first failing outputs. At completion write evaluation.json containing per-task firstCheckSucceeded, corrections, apiQueries, elapsedWallMs, completion/unsupported details and exact evidence paths. Total trial time includes tool waits and is not model compute time. Do not claim completed browser interactions without executing them. A first full acceptance requires state, interaction and any necessary visual assertions together, not check success. Host may write host-evaluation.json with kind=external-ai, tokenUsage from actual host accounting (otherwise null), elapsedWallMs, and tasks [{id, attempts:[{passed,state,interaction,visual,evidence:[paths]}]}]. Do not fabricate these records.",
};
await writeFile(
  path.join(workspace, "TASK.json"),
  JSON.stringify(task, null, 2) + "\n",
);
await mkdir(path.join(root, ".pelican/evaluations"), { recursive: true });
await writeFile(
  path.join(root, ".pelican/evaluations", `${label}.json`),
  JSON.stringify(task, null, 2) + "\n",
);
console.log(
  JSON.stringify({
    workspace,
    label,
    engineVersion: installed.version,
    task: path.join(workspace, "TASK.json"),
    cli: path.join(workspace, "pelican-eval.mjs"),
  }),
);
