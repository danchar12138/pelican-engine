import assert from "node:assert/strict";
import test from "node:test";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { npmCommand } from "../tools/doctor.ts";
import { SDK_VERSION } from "../packages/sdk/src/index.ts";

// npm run distribution:pack, then set PELICAN_RUNTIME_TARBALL to the resulting tgz.
test("installed npm tarball builds the real browser recipe and executes author state without source aliases", {
  skip: !process.env.PELICAN_RUNTIME_TARBALL, timeout: 180000,
}, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pelican-lifecycle-install-"));
  try {
    const npm = npmCommand(process.cwd()); assert.ok(npm);
    await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "lifecycle-author", private: true, type: "module" }));
    await promisify(execFile)(npm.file, [...npm.prefix, "--prefix", root, "install", "--prefer-offline", "--ignore-scripts", "--no-audit", "--no-fund",
      path.resolve(process.env.PELICAN_RUNTIME_TARBALL!), "fflate@0.8.3"], {
      cwd: root, timeout: 120000, windowsHide: true, maxBuffer: 4 * 1024 * 1024,
    });
    await writeFile(path.join(root, "pelican.project.json"), JSON.stringify({ engineVersion: SDK_VERSION, content: "typescript" }));
    await cp(path.resolve("examples/runtime-lifecycle/game.ts"), path.join(root, "game.ts"));
    await cp(path.resolve("examples/runtime-lifecycle/browser-counter.ts"), path.join(root, "browser-counter.ts"));
    const stateSource = `
import {defineGame,defineScene,defineSystem} from 'pelican-engine';
export default defineGame({id:'installed',scene:defineScene({id:'s',entities:[]}),systems:[defineSystem({id:'tick'})],runtime:{version:'1',async create(){
 let ticks=0;return {systems:{tick(){ticks++;}},snapshot:()=>({ticks}),validateSnapshot(){},restore(value){ticks=(value as {ticks:number}).ticks;}};
}}});
`;
    // Native bundler libraries stay loaded until process exit on Windows. Own them in a child
    // so the independent installation can be removed after the actual probe completes.
    const probe = path.join(root, "probe.mjs");
    await writeFile(probe, `
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {compileProject} from './node_modules/pelican-engine/lib/compiler/index.js';
import {RuntimeHost} from './node_modules/pelican-engine/lib/runtime/host.js';
const root=process.cwd();
const recipe=await compileProject({projectRoot:root,outDir:'out'});
assert.equal(recipe.success,true,JSON.stringify(recipe.diagnostics));
const code=await readFile(path.join(root,'out/game.js'),'utf8');
assert.ok(!code.includes('packages/sdk/src'));
assert.ok((await import(pathToFileURL(path.join(root,'out/game.js')).href)).createGame);
await writeFile(path.join(root,'game.ts'),${JSON.stringify(stateSource)});
const compiler={compileProject};
    const state = await compiler.compileProject({ projectRoot: root, outDir: "state" });
    assert.equal(state.success, true, JSON.stringify(state.diagnostics));
    const module = await import(pathToFileURL(path.join(root, "state/game.js")).href);
    const a = new RuntimeHost(state.ir), b = new RuntimeHost(state.ir);
    try {
      a.attach(module.createGame(a.facade)); b.attach(module.createGame(b.facade));
      await a.stepAsync(3); await b.stepAsync(1);
      const checkpoint = a.snapshot(); await a.stepAsync(2); a.restore(checkpoint);
      assert.deepEqual(a.snapshot().runtime.payload, { ticks: 3 });
      assert.deepEqual(b.snapshot().runtime.payload, { ticks: 1 });
      a.startRecording(); await a.stepAsync(2); const trace = a.stopRecording();
      assert.equal((await a.replayAsync(trace)).status, "passed");
    } finally { a.dispose(); b.dispose(); }
`);
    await promisify(execFile)(process.execPath, [probe], {
      cwd: root, timeout: 120000, windowsHide: true, maxBuffer: 4 * 1024 * 1024,
    });
  } finally {
    assert.equal(path.dirname(path.resolve(root)).toLowerCase(), path.resolve(tmpdir()).toLowerCase());
    await rm(root, { recursive: true, force: true });
  }
});
