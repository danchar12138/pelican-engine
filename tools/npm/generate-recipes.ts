import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderRecipes } from "./recipes.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
await writeFile(path.join(root, "docs/npm/RECIPES.md"), await renderRecipes(root), "utf8");
