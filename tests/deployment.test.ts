import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  cp,
  mkdir,
  writeFile,
  readFile,
  readdir,
  rm,
} from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { serveDist } from "../tools/static-server.ts";
const exec = promisify(execFile),
  root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
async function temporary(t: { after(fn: () => Promise<void>): void }) {
  const directory = await mkdtemp(path.join(tmpdir(), "pelican deploy 中文 "));
  t.after(async () => {
    assert.equal(
      path.dirname(path.resolve(directory)).toLowerCase(),
      path.resolve(tmpdir()).toLowerCase(),
    );
    assert.ok(path.basename(directory).startsWith("pelican deploy "));
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}
test("production build strips developer control even when parent NODE_ENV is development", async (t) => {
  const directory = await temporary(t);
  await cp(path.join(root, "examples/m0"), directory, {
    recursive: true,
    filter: (source) =>
      !source.split(path.sep).some((s) => s === ".pelican" || s === "dist"),
  });
  const result = await exec(
    process.execPath,
    [
      path.join(root, "node_modules/tsx/dist/cli.mjs"),
      path.join(root, "tools/cli.ts"),
      "build",
      "--project",
      directory,
    ],
    {
      cwd: root,
      env: { ...process.env, NODE_ENV: "development" },
      timeout: 60000,
      maxBuffer: 4e6,
    },
  );
  assert.equal(JSON.parse(result.stdout).status, "succeeded");
  const assets = await readdir(path.join(directory, "dist/assets"));
  const js = (
    await Promise.all(
      assets
        .filter((n) => n.endsWith(".js"))
        .map((n) => readFile(path.join(directory, "dist/assets", n), "utf8")),
    )
  ).join("\n");
  assert.ok(!js.includes(".__pelican="));
  assert.ok(!js.includes(".__pelicanFailure="));
  assert.ok(js.includes("document.baseURI"));
  assert.ok(!js.includes("<engine>"));
  const ir = JSON.parse(
    await readFile(
      path.join(directory, "dist/generated/scene.ir.json"),
      "utf8",
    ),
  );
  assert.equal(ir.gameId, "m0-game");
  assert.ok(
    (
      await readFile(path.join(directory, "dist/THREE-LICENSE.txt"), "utf8")
    ).includes("MIT"),
  );
  for (const name of ["FAST-PNG", "FFLATE", "IOBUFFER", "NGRAPH.PATH"])
    assert.match(await readFile(path.join(directory, `dist/${name}-LICENSE.txt`), "utf8"), /MIT/i);
});
test("standalone static server supports a deployment subpath without SPA-faking missing resources", async (t) => {
  const directory = await temporary(t);
  await writeFile(
    path.join(directory, "index.html"),
    "<title>standalone</title>",
  );
  await mkdir(path.join(directory, "generated"));
  await writeFile(
    path.join(directory, "generated/game.js"),
    "export const state=1;",
  );
  const server = await serveDist(directory, 0, "/nested/game/");
  t.after(() => server.close());
  assert.equal(
    await (await fetch(server.url)).text(),
    "<title>standalone</title>",
  );
  const module = await fetch(server.url + "generated/game.js");
  assert.equal(module.status, 200);
  assert.match(module.headers.get("content-type") ?? "", /javascript/);
  assert.equal((await fetch(server.url + "missing.js")).status, 404);
  assert.equal((await fetch(new URL("/outside", server.url))).status, 404);
});
