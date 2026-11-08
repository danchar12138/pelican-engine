import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  symlink,
  rm,
  access,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

test("generated cleanup previews sizes, preserves sources and never follows junctions", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "pelican-clean-"));
  try {
    const root = path.join(directory, "engine"),
      outside = path.join(directory, "outside");
    await mkdir(path.join(root, ".pelican"), { recursive: true });
    await mkdir(path.join(root, "examples/game/.pelican"), { recursive: true });
    await mkdir(outside);
    await writeFile(path.join(outside, "keep.txt"), "important");
    await writeFile(path.join(root, ".pelican/cache"), "cache");
    await writeFile(path.join(root, "examples/game/game.ts"), "source");
    await writeFile(
      path.join(root, "examples/game/.pelican/cache"),
      "generated",
    );
    await symlink(
      outside,
      path.join(root, ".pelican/link"),
      process.platform === "win32" ? "junction" : "dir",
    );
    // @ts-expect-error Node-only maintenance entry is JavaScript.
    const { cleanGenerated } = await import("../tools/clean.mjs");
    const preview = await cleanGenerated(root);
    assert.equal(preview.files, 2);
    assert.equal(preview.links, 1);
    assert.equal(preview.bytes, 14);
    await access(path.join(root, ".pelican/cache"));
    const result = await cleanGenerated(root, { apply: true });
    assert.equal(result.files, 2);
    assert.equal(
      await readFile(path.join(outside, "keep.txt"), "utf8"),
      "important",
    );
    assert.equal(
      await readFile(path.join(root, "examples/game/game.ts"), "utf8"),
      "source",
    );
    await assert.rejects(access(path.join(root, ".pelican")));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
