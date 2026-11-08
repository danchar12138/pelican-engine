import { lstat, readdir, rmdir, unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Deliberately narrow generated-output allowlist. Never traverses a link. */
export async function cleanGenerated(root, { apply = false } = {}) {
  root = path.resolve(root);
  const targets = [
    ".pelican",
    ".threecat",
    "dist",
    "release",
    "evidence",
    "playwright-report",
    "test-results",
    "public/generated",
    "docs/api",
    "docs/npm/RECIPES.md",
  ];
  for (const parent of ["examples", "experiments"]) {
    for (const entry of await readdir(path.join(root, parent), {
      withFileTypes: true,
    }).catch(() => [])) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      targets.push(
        `${parent}/${entry.name}/.pelican`,
        `${parent}/${entry.name}/dist`,
      );
    }
  }
  const report = {
    apply,
    files: 0,
    bytes: 0,
    links: 0,
    directories: 0,
    targets: [],
  };
  async function visit(file) {
    const relative = path.relative(root, file);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative))
      throw new Error("TC_CLEAN_PATH: Refusing an escaped output path.");
    const info = await lstat(file).catch((error) => {
      if (error.code === "ENOENT") return;
      throw error;
    });
    if (!info) return;
    if (info.isSymbolicLink()) {
      report.links++;
      if (apply) {
        // Windows junctions are directory reparse points: remove the link itself.
        if (process.platform === "win32" && info.isDirectory())
          await rmdir(file);
        else
          await unlink(file).catch(async (error) => {
            if (process.platform === "win32" && error.code === "EPERM")
              await rmdir(file);
            else throw error;
          });
      }
    } else if (info.isDirectory()) {
      for (const name of await readdir(file))
        await visit(path.join(file, name));
      report.directories++;
      if (apply) await rmdir(file);
    } else {
      report.files++;
      report.bytes += info.size;
      if (apply) await unlink(file);
    }
  }
  for (const target of targets) {
    const file = path.resolve(root, target);
    // Parent components must also be ordinary directories. In particular a
    // junction under examples must never redirect generated-output removal.
    let safe = true;
    for (
      let parent = path.dirname(file);
      parent !== root;
      parent = path.dirname(parent)
    ) {
      if (parent === path.dirname(parent))
        throw new Error("TC_CLEAN_PATH: Invalid root.");
      const entry = await lstat(parent).catch(() => undefined);
      if (entry?.isSymbolicLink()) {
        safe = false;
        break;
      }
    }
    if (!safe) continue;
    if (await lstat(file).catch(() => undefined)) {
      report.targets.push(target);
      await visit(file);
    }
  }
  return report;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  if (process.argv.slice(2).some((argument) => argument !== "--apply"))
    throw new Error("Usage: npm run clean [-- --apply]. Default is a dry run.");
  console.log(
    JSON.stringify(
      await cleanGenerated(fileURLToPath(new URL("../", import.meta.url)), {
        apply: process.argv.includes("--apply"),
      }),
      null,
      2,
    ),
  );
}
