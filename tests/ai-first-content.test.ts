import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { compileProject } from "../packages/compiler/src/index.ts";
import { createWorld } from "../packages/runtime/src/world.ts";
import { cloneJsonValue } from "../packages/schema/src/json-value.ts";
import { SDK_VERSION, type ComponentData } from "../packages/sdk/src/index.ts";

async function compile(source: string) {
  const root = await mkdtemp(path.join(tmpdir(), "pelican-pure-content-"));
  try {
    await writeFile(path.join(root, "pelican.project.json"), JSON.stringify({ engineVersion: SDK_VERSION, entry: "game.ts" }));
    await writeFile(path.join(root, "game.ts"), source);
    return await compileProject({ projectRoot: root, engineRoot: process.cwd(), outDir: path.join(root, "generated") });
  } finally { await rm(root, { recursive: true, force: true }); }
}
const prefix = `import {defineGame,defineScene,defineComponent} from 'pelican-engine';`;
test("pure content helpers, maps, captured parameters and templates produce deterministic IR", async () => {
  const source = prefix + `
    const offset=5;
    function row(count:number, offset:number) {
      const entries=Array.from({length:count},(_,i)=>({id:\`cell-\${offset}-\${i}\`,transform:{position:[offset+i*2,0,0] as const}}));
      return entries.filter((_,i)=>i%2===0);
    }
    function layout(){return defineScene({id:'main',entities:row(6,10).concat(row(2,20))});}
    export default defineGame({id:'generated',scene:layout()});`;
  const a = await compile(source), b = await compile(source);
  assert.equal(a.success, true, JSON.stringify(a.diagnostics)); assert.equal(b.success, true);
  assert.deepEqual(a.ir, b.ir);
  assert.deepEqual(a.ir!.scene.entities.map(e => e.id), ["cell-10-0", "cell-10-2", "cell-10-4", "cell-20-0"]);
  assert.deepEqual(a.ir!.scene.entities[0].transform.position, [10, 0, 0]);
});
test("content rejects I/O, mutation, excessive allocation and recursion without executing source", async () => {
  for (const body of [
    `function build(){globalThis.__pelicanContentExecuted=true;return [];} const entities=build();`,
    `const entities=Array.from({length:100000000},(_,i)=>({id:'x'+i}));`,
    `function recurse():any{return recurse();} const entities=recurse();`,
    `function build(){let a=[];return a;} const entities=build();`,
  ]) {
    const result = await compile(prefix + body + `export default defineGame({id:'bad',scene:defineScene({id:'main',entities})});`);
    assert.equal(result.success, false); assert.ok(result.diagnostics.some(d => d.code.startsWith("TC_STATIC_")), JSON.stringify(result.diagnostics));
  }
  assert.equal((globalThis as Record<string, unknown>).__pelicanContentExecuted, undefined);
});
test("structured component state has detached defaults, reads, writes and restores", async () => {
  const result = await compile(prefix + `const State=defineComponent({id:'State',schema:{items:{type:'json',default:[{id:'a',tags:['rare']}]}}});export default defineGame({id:'json',components:[State],scene:defineScene({id:'main',entities:[{id:'owner',components:[{component:State}]}]})});`);
  assert.equal(result.success, true, JSON.stringify(result.diagnostics));
  const world = createWorld({ components: result.ir!.components, entities: result.ir!.scene.entities.map(e => ({ ...e, components: e.components as Record<string, ComponentData> })) });
  try {
    const first = world.getComponent("owner", "State");
    (first.items as { tags: string[] }[])[0].tags.push("modified");
    assert.deepEqual(world.getComponent("owner", "State").items, [{ id: "a", tags: ["rare"] }]);
    const snapshot = world.snapshot(); world.setComponent("owner", "State", { items: [1, null, { level: 2 }] });
    world.restore(snapshot); assert.deepEqual(world.getComponent("owner", "State").items, [{ id: "a", tags: ["rare"] }]);
    for (const bad of [NaN, undefined, new Date(), "x".repeat(65537), Object.defineProperty({}, "bad", { get() { throw Error("getter ran"); }, enumerable: true })]) assert.throws(() => cloneJsonValue(bad), /TC_STATE_JSON/);
    const cyclic: unknown[] = []; cyclic.push(cyclic); assert.throws(() => cloneJsonValue(cyclic), /TC_STATE_JSON/);
  } finally { world.dispose(); }
});
