import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function compilerLayout(url: string, selectedRoot?: string) {
  const compiled = url.endsWith("/lib/compiler/index.js");
  const root = selectedRoot
    ? path.resolve(selectedRoot)
    : fileURLToPath(new URL(compiled ? "../../" : "../../../", url));
  const installed = existsSync(path.join(root, "distribution.json"));
  const sdk = path.join(
    root,
    installed ? "lib/sdk/index.js" : "packages/sdk/src/index.ts",
  );
  return {
    root,
    installed,
    sdk,
    types: installed ? sdk.replace(/\.js$/, ".d.ts") : sdk,
  };
}
