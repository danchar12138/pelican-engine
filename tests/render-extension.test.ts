import test from "node:test";
import assert from "node:assert/strict";
import {
  defineGame,
  defineScene,
  defineSystem,
  defineRenderExtension,
  definePostProcess,
  instantiateGame,
  SDK_VERSION,
} from "../packages/sdk/src/index.ts";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { compileProject } from "../packages/compiler/src/index.ts";

test("managed render extensions compose resources, save state and reverse cleanup", async () => {
  const cleanup: string[] = [];
  let value = 0;
  const extension = defineRenderExtension({
    id: "plugin",
    version: "1",
    systems: [defineSystem({ id: "plugin:update", phase: "presentation" })],
    postProcesses: [
      definePostProcess({
        id: "tint",
        graph: {
          nodes: [{ id: "out", op: "vec4", value: [1, 1, 1, 1] }],
          output: "out",
        },
      }),
    ],
    create(scope) {
      scope.defer(() => cleanup.push("resource"));
      return {
        systems: {
          "plugin:update"() {
            value++;
          },
        },
        snapshot: () => ({ value }),
        validateSnapshot(data) {
          if (
            !data ||
            typeof data !== "object" ||
            Array.isArray(data) ||
            typeof (data as Record<string, unknown>).value !== "number"
          )
            throw new Error("invalid");
        },
        restore(data) {
          value = (data as { value: number }).value;
        },
        dispose() {
          cleanup.push("plugin");
        },
      };
    },
  });
  const game = defineGame({
    id: "extension",
    extensions: [extension],
    scene: defineScene({ id: "main", entities: [] }),
  });
  assert.equal(game.postProcesses![0].id, "tint");
  assert.equal(game.systems![0].id, "plugin:update");
  const instance = instantiateGame(game, {} as never);
  await instance.ready;
  instance.update(1 / 60);
  const saved = instance.snapshot!();
  instance.update(1 / 60);
  assert.equal(value, 2);
  instance.restore!(saved);
  assert.equal(value, 1);
  instance.dispose();
  instance.dispose();
  assert.deepEqual(cleanup, ["plugin", "resource"]);
  assert.throws(
    () => defineGame({ ...game, extensions: [extension, extension] }),
    /TC_RENDER_EXTENSION_CONTRACT/,
  );
});

test("failed extension initialization releases prior ownership and rejects API versions", async () => {
  let disposed = 0;
  const a = defineRenderExtension({
    id: "a",
    version: "1",
    create: () => ({
      dispose() {
        disposed++;
      },
    }),
  });
  const b = defineRenderExtension({
    id: "b",
    version: "1",
    create() {
      throw new Error("failed");
    },
  });
  const instance = instantiateGame(
    defineGame({
      id: "bad",
      extensions: [a, b],
      scene: defineScene({ id: "main", entities: [] }),
    }),
    {} as never,
  );
  await assert.rejects(instance.ready!, /TC_GAME_RUNTIME_INIT/);
  assert.equal(disposed, 1);
  assert.throws(
    () =>
      defineGame({
        id: "bad",
        scene: defineScene({ id: "main", entities: [] }),
        extensions: [{ ...a, apiVersion: 2 } as never],
      }),
    /TC_RENDER_EXTENSION_CONTRACT/,
  );
});

test("npm-compatible extension declarations compile through the ordinary content and graph validation", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pelican-render-extension-"));
  try {
    await writeFile(
      path.join(root, "pelican.project.json"),
      JSON.stringify({ engineVersion: SDK_VERSION, content: "typescript" }),
    );
    await writeFile(
      path.join(root, "game.ts"),
      `import {defineGame,defineScene,defineRenderExtension,defineSystem,definePostProcess} from 'pelican-engine';
      const effect=definePostProcess({id:'effect',graph:{nodes:[{id:'uv',op:'input',name:'uv'},{id:'color',op:'sampleFrame',inputs:['uv'],channel:'scene.color'}],output:'color'}});
      const extension=defineRenderExtension({id:'example',version:'1',systems:[defineSystem({id:'effect-update'})],postProcesses:[effect],create(scope){scope.defer(()=>{});return{systems:{'effect-update'(ctx){ctx.render.effects.configure('effect',{enabled:true});}}};}});
      export default defineGame({id:'game',extensions:[extension],scene:defineScene({id:'main',entities:[]})});`,
    );
    const result = await compileProject({
      projectRoot: root,
      engineRoot: process.cwd(),
      outDir: path.join(root, "out"),
    });
    assert.equal(result.success, true, JSON.stringify(result.diagnostics));
    assert.equal(result.ir!.postProcesses![0].id, "effect");
    assert.equal(result.ir!.systems[0].id, "effect-update");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
