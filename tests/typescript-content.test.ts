import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { compileProject } from "../packages/compiler/src/index.ts";
import { SDK_VERSION } from "../packages/sdk/src/index.ts";
import { RuntimeHost } from "../packages/runtime/src/host.ts";

async function fixture(
  run: (
    root: string,
    compile: (
      source: string,
      extra?: object,
    ) => ReturnType<typeof compileProject>,
  ) => Promise<void>,
) {
  const root = await mkdtemp(path.join(tmpdir(), "pelican-typescript-"));
  try {
    await run(root, async (source, extra = {}) => {
      await writeFile(path.join(root, "game.ts"), source);
      await writeFile(
        path.join(root, "pelican.project.json"),
        JSON.stringify({
          engineVersion: SDK_VERSION,
          content: "typescript",
          ...extra,
        }),
      );
      return compileProject({
        projectRoot: root,
        engineRoot: process.cwd(),
        outDir: path.join(root, "out"),
      });
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
const imports = `import {defineGame,defineScene,defineMaterial,defineComponent,defineSystem} from "pelican-engine";`;
const empty = `export default defineGame({id:'game',scene:defineScene({id:'main',entities:[]})});`;

test("ordinary TypeScript builds classes, loops, mutation, closures and npm dependencies without an allowlist", async () =>
  fixture(async (root, compile) => {
    const library = path.join(root, "node_modules/grid-math");
    await mkdir(library, { recursive: true });
    await writeFile(
      path.join(library, "package.json"),
      JSON.stringify({
        name: "grid-math",
        version: "1.0.0",
        type: "module",
        exports: { types: "./index.d.ts", import: "./index.js" },
      }),
    );
    await writeFile(
      path.join(library, "index.d.ts"),
      "export function offset(n:number):number;",
    );
    await writeFile(
      path.join(library, "index.js"),
      "export const offset=n=>n*2;",
    );
    const source =
      imports +
      `import{offset}from'grid-math';
    class Grid { build() { const result: {id:string;transform:{position:[number,number,number]}}[] = []; for (let i=0;i<4;i++) result.push({id:'e'+i, transform:{position:[offset(i),0,0]}}); return result; } }
    const Counter=defineComponent({id:'Counter',schema:{value:{type:'number',default:0}}});
    let count=0;
    const logic=defineSystem({id:'logic',run(ctx){count+=offset(1);ctx.setComponent('e0',Counter,{value:count});}});
    const entities=new Grid().build().map(e=>({...e,components:[{component:Counter}]}));
    export default defineGame({id:'game',components:[Counter],systems:[logic],scene:defineScene({id:'main',entities})});`;
    const result = await compile(source);
    assert.equal(result.success, true, JSON.stringify(result.diagnostics));
    assert.deepEqual(
      result.ir!.scene.entities.map((e) => e.transform.position[0]),
      [0, 2, 4, 6],
    );
    assert.ok(
      result.report.inputs.some(
        (input) => input.path === "node_modules/grid-math/index.js",
      ),
    );
    const host = new RuntimeHost(result.ir!);
    try {
      const module = await import(
        pathToFileURL(path.join(root, "out/game.js")).href
      );
      host.attach(module.createGame(host.facade));
      host.step();
      host.step();
      assert.equal(host.world.getComponent("e0", "Counter").value, 4);
    } finally {
      host.dispose();
    }
    const cached = await compileProject({
      projectRoot: root,
      engineRoot: process.cwd(),
      outDir: path.join(root, "out"),
    });
    assert.equal(cached.success, true);
    assert.equal(cached.report.incremental.cacheHit, true);
    await writeFile(
      path.join(library, "other.js"),
      "export const offset=n=>n*3;",
    );
    const metadata = JSON.parse(
      await readFile(path.join(library, "package.json"), "utf8"),
    );
    metadata.exports.import = "./other.js";
    await writeFile(
      path.join(library, "package.json"),
      JSON.stringify(metadata),
    );
    const changed = await compile(source);
    assert.equal(changed.success, true, JSON.stringify(changed.diagnostics));
    assert.equal(changed.report.incremental.cacheHit, false);
    assert.equal(changed.ir!.scene.entities[3].transform.position[0], 9);
  }));

test("content failures are bounded and the next compile recovers", async () =>
  fixture(async (_root, compile) => {
    const hung = await compile(imports + `while(true) {} ` + empty, {
      contentTimeoutMs: 200,
    });
    assert.equal(hung.success, false);
    assert.ok(hung.diagnostics.some((d) => d.code === "TC_CONTENT_TIMEOUT"));
    const thrown = await compile(
      imports + `throw new Error('construction failed');` + empty,
    );
    assert.equal(thrown.success, false);
    assert.ok(
      thrown.diagnostics.some((d) => d.code === "TC_CONTENT_EXECUTION"),
    );
    const good = await compile(imports + empty);
    assert.equal(good.success, true, JSON.stringify(good.diagnostics));
  }));

test("normalization still rejects invalid resources and reports source locations", async () =>
  fixture(async (_root, compile) => {
    const duplicate = await compile(
      imports +
        `
const a=defineMaterial({id:'same',color:'#ffffff'});
const b=defineMaterial({id:'same',color:'#000000'});` +
        empty,
    );
    assert.equal(duplicate.success, false);
    const diagnostic = duplicate.diagnostics.find(
      (d) => d.code === "TC_DUPLICATE_ID",
    );
    assert.ok(diagnostic?.source);
    assert.equal(diagnostic.source.file, "game.ts");
    assert.equal(diagnostic.source.line, 3);
    const asyncSystem = await compile(
      imports + `const s=defineSystem({id:'async',async run(){}});` + empty,
    );
    assert.equal(asyncSystem.success, false);
    assert.ok(
      asyncSystem.diagnostics.some((d) => d.code === "TC_SYSTEM_ASYNC"),
    );
    const thenable = await compile(
      imports +
        `const s=defineSystem({id:'promise',run:()=>Promise.resolve()});` +
        empty,
    );
    assert.equal(thenable.success, false);
    assert.ok(thenable.diagnostics.some((d) => d.code === "TC_SYSTEM_ASYNC"));
    const instance = await compile(
      imports +
        `class Bad {kind='game' as const;id='game';scene=defineScene({id:'main',entities:[]});} export default new Bad();`,
    );
    assert.equal(instance.success, false);
    assert.ok(instance.diagnostics.some((d) => d.code === "TC_CONTENT_VALUE"));
  }));

test("TypeScript errors prevent construction and old static projects keep their nonexecuting policy", async () =>
  fixture(async (root, compile) => {
    const type = await compile(imports + `const invalid:number='no';` + empty);
    assert.equal(type.success, false);
    assert.ok(type.diagnostics.some((d) => d.code.startsWith("TC_TS_")));
    const legacy = await compile(
      imports + `let n=0;for(let i=0;i<3;i++)n++;` + empty,
      { content: "static" },
    );
    assert.equal(legacy.success, false);
    assert.ok(legacy.diagnostics.some((d) => d.code.startsWith("TC_STATIC")));
    const config = await compile(imports + empty, { content: "typo" });
    assert.equal(config.success, false);
    assert.ok(config.diagnostics.some((d) => d.code === "TC_PROJECT_CONFIG"));
  }));

test("workspace-hoisted dependencies and their type declarations invalidate independently", async () =>
  fixture(async (root) => {
    const project = path.join(root, "game"),
      dependency = path.join(root, "node_modules/hoisted-math");
    await mkdir(project);
    await mkdir(dependency, { recursive: true });
    await writeFile(
      path.join(dependency, "package.json"),
      JSON.stringify({
        name: "hoisted-math",
        version: "1.0.0",
        type: "module",
        exports: { types: "./index.d.ts", import: "./index.js" },
      }),
    );
    await writeFile(
      path.join(dependency, "index.js"),
      "export const offset=n=>n*2;",
    );
    await writeFile(
      path.join(dependency, "index.d.ts"),
      "export function offset(n:number):number;",
    );
    await writeFile(
      path.join(project, "pelican.project.json"),
      JSON.stringify({ engineVersion: SDK_VERSION, content: "typescript" }),
    );
    await writeFile(
      path.join(project, "game.ts"),
      imports +
        `import{offset}from'hoisted-math'; const x:number=offset(2); export default defineGame({id:'game',scene:defineScene({id:'main',entities:[{id:'item',transform:{position:[x,0,0]}}]})});`,
    );
    const compile = () =>
      compileProject({
        projectRoot: project,
        engineRoot: process.cwd(),
        outDir: path.join(project, "out"),
      });
    const first = await compile();
    assert.equal(first.success, true, JSON.stringify(first.diagnostics));
    assert.ok(
      first.report.inputs.some(
        (input) => input.path === "../node_modules/hoisted-math/index.js",
      ),
    );
    assert.ok(
      first.report.inputs.some(
        (input) => input.path === "../node_modules/hoisted-math/index.d.ts",
      ),
    );
    assert.equal((await compile()).report.incremental.cacheHit, true);
    await writeFile(
      path.join(dependency, "index.d.ts"),
      "export function offset(n:number):string;",
    );
    const changed = await compile();
    assert.equal(changed.success, false);
    assert.ok(changed.diagnostics.some((d) => d.code === "TC_TS_2322"));
  }));
