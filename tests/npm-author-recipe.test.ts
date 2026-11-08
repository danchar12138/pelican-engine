import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compileProject } from "../packages/compiler/src/index.ts";
import { SDK_VERSION } from "../packages/sdk/src/index.ts";

test("author instructions describe actual browser keys and isolate npm installs", async () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const author = await readFile(path.join(root, "docs/npm/GAME-AUTHOR.md"), "utf8");
  const distribution = await readFile(path.join(root, "docs/npm/DISTRIBUTION.md"), "utf8");
  assert.match(author, /KeyboardEvent\.key/);
  assert.match(author, /"w", "W", "ArrowUp"/);
  assert.match(author, /not `"KeyW"`/);
  assert.match(distribution, /npm --prefix \. (?:i -D|install --save-dev --save-exact) pelican-engine/);
  assert.match(distribution, /parent/);
  assert.equal((author.match(/Use `ctx\.audio\.fadeBus/g) ?? []).length, 1);
});

test("shared game-author documentation contains a self-contained compilable rendering recipe", async t => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const document = await readFile(path.join(root, "docs/npm/GAME-AUTHOR.md"), "utf8");
  const block = /<!-- standalone-render-recipe:start -->\s*```ts\s*([\s\S]*?)\s*```\s*<!-- standalone-render-recipe:end -->/.exec(document);
  assert.ok(block, "The author recipe must stay uniquely extractable.");
  assert.equal((document.match(/<!-- standalone-render-recipe:start -->/g) ?? []).length, 1);
  const directory = await mkdtemp(path.join(tmpdir(), "pelican-author-recipe-"));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(tmpdir()));
    assert.ok(path.basename(directory).startsWith("pelican-author-recipe-"));
    await rm(directory, { recursive: true, force: true });
  });
  await writeFile(path.join(directory, "game.ts"), block[1] + "\n");
  await writeFile(path.join(directory, "pelican.project.json"), JSON.stringify({ engineVersion: SDK_VERSION }));
  const result = await compileProject({ engineRoot: root, projectRoot: directory, outDir: path.join(directory, ".pelican/generated") });
  assert.equal(result.success, true, JSON.stringify(result.diagnostics));
  assert.equal(result.ir?.gameId, "render-recipe");
  assert.equal(result.ir?.materials[0].specularIntensity, 0.7);
  assert.equal(result.ir?.materials[0].specularColor, "#ffb080");
  assert.equal(result.ir?.assets.length, 0);
});
