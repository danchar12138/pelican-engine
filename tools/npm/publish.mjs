import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
const root = fileURLToPath(new URL("../../", import.meta.url));
const { version } = JSON.parse(
  readFileSync(path.join(root, "package.json"), "utf8"),
);
if (!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(version))
  throw new Error("TC_NPM_VERSION: Invalid staged package version.");
// npm provides the current JS CLI path, avoiding cmd.exe or a PowerShell dependency.
const cli = process.env.npm_execpath;
if (!cli) throw new Error("TC_NPM_CLI: Run npm run release:publish.");
const result = spawnSync(
  process.execPath,
  [
    cli,
    "publish",
    path.join(root, ".pelican/npm/artifacts", `pelican-engine-${version}.tgz`),
    "--access",
    "public",
    "--tag",
    "latest",
  ],
  { cwd: root, stdio: "inherit", windowsHide: true },
);
if (result.error) console.error(result.error.message);
process.exitCode = result.status ?? 1;
