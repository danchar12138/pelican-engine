import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { compileProject } from "../packages/compiler/src/index.ts";
import { RuntimeHost } from "../packages/runtime/src/host.ts";
import { SDK_VERSION } from "../packages/sdk/src/index.ts";


test("author-approved runtime libraries bundle normally, invalidate cache and cannot execute as content", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pelican-library-")), library = path.join(root, "node_modules/@fixture/math");
  try {
    await mkdir(library, { recursive: true });
    await writeFile(path.join(root, "pelican.project.json"), JSON.stringify({ engineVersion: SDK_VERSION, libraries: ["@fixture/math"] }));
    await writeFile(path.join(library, "package.json"), JSON.stringify({ name: "@fixture/math", version: "1.0.0", type: "module", exports: { ".": { types: "./index.d.ts", import: "./index.js" } } }));
    await writeFile(path.join(library, "index.d.ts"), "export declare function add(a:number,b:number):number;");
    await writeFile(path.join(library, "index.js"), "export const add=(a,b)=>a+b;");
    const source = `import {defineGame,defineScene,defineComponent,defineSystem} from 'pelican-engine';import{add}from'@fixture/math';
      const Counter=defineComponent({id:'Counter',schema:{value:{type:'number',default:0}}});
      const run=defineSystem({id:'logic',run(ctx){ctx.setComponent('state',Counter,{value:add(2,3)});}});
      export default defineGame({id:'library',components:[Counter],systems:[run],scene:defineScene({id:'main',entities:[{id:'state',components:[{component:Counter}]}]})});`;
    await writeFile(path.join(root, "game.ts"), source);
    const compile = () => compileProject({ projectRoot: root, engineRoot: process.cwd(), outDir: path.join(root, "out") });
    const first = await compile(); assert.equal(first.success, true, JSON.stringify(first.diagnostics));
    assert.ok(first.report.inputs.some(input => input.path === "node_modules/@fixture/math/index.js"));
    const alias = path.join(root, "project-alias");
    await symlink(root, alias, process.platform === "win32" ? "junction" : "dir");
    try {
      const viaAlias = await compileProject({ projectRoot: alias, engineRoot: process.cwd(), outDir: path.join(root, "alias-out") });
      assert.equal(viaAlias.success, true, JSON.stringify(viaAlias.diagnostics));
      assert.deepEqual(viaAlias.ir, first.ir);
      assert.ok(viaAlias.report.inputs.some(input => input.path === "node_modules/@fixture/math/index.js"));
    } finally { await rm(alias); }
    const host = new RuntimeHost(first.ir!);
    try { const game = await import(pathToFileURL(path.join(root, "out/game.js")).href); host.attach(game.createGame(host.facade)); host.step(); assert.equal(host.world.getComponent("state", "Counter").value, 5); }
    finally { host.dispose(); }
    assert.equal((await compile()).report.incremental.cacheHit, true);
    await writeFile(path.join(library, "index.js"), "export const add=(a,b)=>a+b+1;");
    const changed = await compile(); assert.equal(changed.success, true); assert.equal(changed.report.incremental.cacheHit, false);
    await writeFile(path.join(root, "game.ts"), source.replace("default:0", "default:add(2,3)"));
    assert.equal((await compile()).success, false);
    for (const name of ["three", "@dimforge/rapier3d-compat", "fs"]) {
      await writeFile(path.join(root, "pelican.project.json"), JSON.stringify({ engineVersion: SDK_VERSION, libraries: [name] }));
      const result = await compile(); assert.equal(result.success, false); assert.ok(result.diagnostics.some(d => d.code === "TC_PROJECT_CONFIG"));
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
