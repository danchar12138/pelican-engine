import { lstat, mkdir, mkdtemp, realpath, rename } from "node:fs/promises";
import path from "node:path";

/** Windows AV/indexing and filesystem watchers can temporarily deny a directory
 * rename. Retrying does not remove either tree or bypass the caller's identity checks. */
export async function renameBuildDirectory(from: string, to: string, move = rename,
  wait: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms))) {
  for (let attempt = 0; ; attempt++) {
    try { await move(from, to); return; }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (process.platform !== "win32" || !["EPERM", "EACCES", "EBUSY"].includes(code ?? "") || attempt >= 11) throw error;
      await wait(Math.min(25 * 2 ** attempt, 500));
    }
  }
}

const fail = (code: string, message: string): never => { throw new Error(`TC_BUILD_${code}: ${message}`); };
const samePath = (a: string, b: string) => process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
const inside = (parent: string, child: string) => {
  const relative = path.relative(parent, child);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};
async function maybeStat(target: string) {
  try { return await lstat(target); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}
async function directDirectory(parent: string, child: string): Promise<string> {
  const info = await lstat(child);
  if (!info.isDirectory() || info.isSymbolicLink()) return fail("PATH", `Build directory '${child}' must be a real directory, not a link.`);
  const resolved = await realpath(child);
  if (!inside(parent, resolved) || !samePath(path.dirname(resolved), parent)) return fail("PATH", `Build directory '${child}' must resolve directly inside its intended parent.`);
  return resolved;
}

/** Stage on the output filesystem and preserve any previous dist before replacement. */
export async function createBuildOutput(output: string) {
  const requested = path.resolve(output);
  if (path.basename(requested) !== "dist") return fail("PATH", "Build output must be the project's dist directory.");
  const parent = await realpath(path.dirname(requested));
  const destination = path.join(parent, "dist");
  const cache = path.join(parent, ".pelican");
  try { await mkdir(cache); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const cacheRoot = await directDirectory(parent, cache);
  const parentInfo = await lstat(parent), cacheInfo = await lstat(cacheRoot);
  if (parentInfo.dev !== cacheInfo.dev) return fail("PATH", "Build staging and dist must be on the same filesystem.");
  const initial = await maybeStat(destination);
  if (initial && (!initial.isDirectory() || initial.isSymbolicLink()))
    return fail("SYMLINK", "dist must be a real directory, not a file or link; choose a safe project directory.");
  const staging = await mkdtemp(path.join(cacheRoot, "dist-stage-"));
  const stageRoot = await directDirectory(cacheRoot, staging);
  const stageIdentity = await lstat(stageRoot);
  let used = false;
  return {
    staging: stageRoot,
    async commit(): Promise<{ backup: string | null }> {
      if (used) return fail("STATE", "A staged build can only be committed once.");
      used = true;
      const currentStage = await lstat(stageRoot);
      const resolvedStage = await directDirectory(cacheRoot, stageRoot);
      if (!samePath(resolvedStage, stageRoot) || (stageIdentity.ino && (currentStage.ino !== stageIdentity.ino || currentStage.dev !== stageIdentity.dev)))
        return fail("CHANGED", `Build staging changed before commit; partial files remain at '${stageRoot}'.`);
      const previous = await maybeStat(destination);
      if (previous && (!previous.isDirectory() || previous.isSymbolicLink()))
        return fail("SYMLINK", `dist became a file or link; partial files remain at '${stageRoot}'.`);
      if (previous && !samePath(await realpath(destination), destination))
        return fail("PATH", `dist no longer resolves directly in the output parent; partial files remain at '${stageRoot}'.`);
      if ((!initial && previous) || (initial && !previous) ||
          (initial?.ino && previous && (initial.ino !== previous.ino || initial.dev !== previous.dev)))
        return fail("CHANGED", `dist changed while building; it was not replaced. Partial files remain at '${stageRoot}'.`);
      let backup: string | null = null;
      if (previous) {
        const directory = await mkdtemp(path.join(cacheRoot, "dist-backup-"));
        const backupRoot = await directDirectory(cacheRoot, directory);
        backup = path.join(backupRoot, "dist");
        if (!inside(cacheRoot, backup) || await maybeStat(backup)) return fail("PATH", "Backup destination must be a new path inside the workspace cache.");
        const finalCheck = await maybeStat(destination);
        if (!finalCheck || finalCheck.isSymbolicLink() || !finalCheck.isDirectory() ||
            (previous.ino && (finalCheck.ino !== previous.ino || finalCheck.dev !== previous.dev)))
          return fail("CHANGED", `dist changed before backup; it was not replaced. Partial files remain at '${stageRoot}'.`);
        if (!samePath(await realpath(destination), destination) || !samePath(await directDirectory(cacheRoot, backupRoot), backupRoot))
          return fail("PATH", `Build paths changed before backup; staged output remains at '${stageRoot}'.`);
        try { await renameBuildDirectory(destination, backup); }
        catch (error) {
          throw new AggregateError([error], `TC_BUILD_BACKUP: Could not confirm preservation of the previous dist. Inspect '${destination}' and '${backup}'; staged output remains at '${stageRoot}'.`);
        }
      }
      try {
        if (await maybeStat(destination)) return fail("CHANGED", `Another dist appeared before commit. Previous output is retained at '${backup ?? "none"}'; staged output is '${stageRoot}'.`);
        if (!samePath(await directDirectory(cacheRoot, stageRoot), stageRoot) || !samePath(await realpath(path.dirname(destination)), parent))
          return fail("PATH", `Build paths changed before commit; staged output remains at '${stageRoot}'.`);
        const finalStage = await lstat(stageRoot);
        if (stageIdentity.ino && (finalStage.ino !== stageIdentity.ino || finalStage.dev !== stageIdentity.dev))
          return fail("CHANGED", `Build staging changed before commit; inspect '${stageRoot}'.`);
        await renameBuildDirectory(stageRoot, destination);
      } catch (error) {
        let restored = false, targetAbsent = false;
        try { targetAbsent = !(await maybeStat(destination)); } catch { /* Preserve both paths if the destination cannot be inspected. */ }
        if (backup && targetAbsent) {
          try {
            const saved = await lstat(backup), resolved = await realpath(backup);
            if (saved.isDirectory() && !saved.isSymbolicLink() && inside(cacheRoot, resolved) && samePath(resolved, backup) &&
                samePath(await realpath(path.dirname(destination)), parent)) {
              await renameBuildDirectory(backup, destination); restored = true;
            }
          } catch { /* Preserve both paths for manual recovery. */ }
        }
        const detail = error && typeof error === "object" && "code" in error && typeof error.code === "string"
          ? error.code : error instanceof Error ? error.message : "unknown failure";
        throw new AggregateError([error], `TC_BUILD_COMMIT: Could not install staged dist (${detail}). ${restored ? "Previous dist was restored." : `Previous output remains at '${backup ?? "none"}'.`} Staged output remains at '${stageRoot}'; inspect paths before retrying.`);
      }
      return { backup };
    },
  };
}
