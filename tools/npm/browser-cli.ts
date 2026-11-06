import { createRequire } from "node:module";
import path from "node:path";

export function playwrightCli(engineRoot: string): string {
  const require = createRequire(path.join(engineRoot, "package.json"));
  return path.join(path.dirname(require.resolve("playwright/package.json")), "cli.js");
}
