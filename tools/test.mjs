import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
const files = readdirSync(new URL("../tests/", import.meta.url))
  .filter((name) => name.endsWith(".test.ts"))
  .sort()
  .map((name) => `tests/${name}`);
const result = spawnSync(
  process.execPath,
  [
    "--import",
    "tsx",
    "--test",
    "--test-concurrency=1",
    "--test-timeout=120000",
    ...files,
    ...process.argv.slice(2),
  ],
  { stdio: "inherit", windowsHide: true },
);
if (result.error) console.error(result.error.message);
process.exitCode = result.status ?? 1;
