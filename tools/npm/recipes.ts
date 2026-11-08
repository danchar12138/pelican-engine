import { readFile } from "node:fs/promises";
import path from "node:path";

/** Curated, asset-free source games; documentation and installed copies derive from these files. */
const recipes = [
  { id: "pointer-3d", anchor: "pointer-3d", title: "Pointer-controlled 3D game", summary: "Move, aim, spawn and remove physical props, and restart a complete game loop." },
  { id: "orthographic-2d", anchor: "orthographic-raster", title: "Orthographic raster", summary: "Move simple 2D-positioned objects under an orthographic camera." },
  { id: "physics2d", anchor: "2d-rigid-bodies", title: "2D rigid bodies", summary: "Move an XY body in an independent 2D physics world." },
  { id: "physics2d-character", anchor: "2d-character", title: "2D character", summary: "Drive a kinematic character against 2D obstacles." },
  { id: "gamepad", anchor: "gamepad-input", title: "Gamepad input", summary: "Combine standard gamepad input with keyboard bindings." },
  { id: "dynamic-ui", anchor: "dynamic-ui", title: "Dynamic UI", summary: "Create and remove reusable menu slots." },
  { id: "inventory", anchor: "inventory", title: "Inventory", summary: "Move stackable items between a backpack and a chest." },
  { id: "quests", anchor: "quest-objectives", title: "Quest objectives", summary: "Advance objectives and grant a game-defined reward." },
  { id: "dialogue", anchor: "branching-dialogue", title: "Branching dialogue", summary: "Display a conversation and start a quest from a choice." },
  { id: "gameplay-loop", anchor: "composed-gameplay", title: "Composed gameplay", summary: "Combine quests, inventory, equipment, conditional dialogue, camera and saves." },
  { id: "localization", anchor: "localization", title: "Localization", summary: "Switch languages and format plural messages." },
  { id: "navigation-agents", anchor: "grid-navigation", title: "Grid navigation", summary: "Move two point agents and change an obstacle." },
  { id: "streaming-world", anchor: "static-world-chunks", title: "Static world chunks", summary: "Load static chunks and build or remove markers." },
] as const;
export const recipeIds: readonly string[] = recipes.map(recipe => recipe.id);
export async function readRecipe(root: string, id: string, installed = false): Promise<string> {
  if (!recipeIds.includes(id)) throw new Error("TC_RECIPE_ID: Unknown recipe; query capabilities for exact IDs.");
  if (installed) {
    const catalog = JSON.parse(await readFile(path.join(root, "docs/api/recipes.json"), "utf8"));
    const source = catalog.recipes.find((item: { id: string }) => item.id === id)?.source;
    if (typeof source !== "string") throw new Error("TC_RECIPE_MISSING: Installed recipe catalog is incomplete; reinstall the exact package version.");
    return source;
  }
  return readFile(path.join(root, "examples", id, "game.ts"), "utf8");
}
export async function recipeCatalog(root: string) {
  return { format: "pelican.recipes", version: 1, recipes: await Promise.all(recipes.map(async recipe => ({ ...recipe, entry: "game.ts", source: await readRecipe(root, recipe.id) }))) };
}

export async function renderRecipes(root: string): Promise<string> {
  const lines = [
    "# Game-author recipes",
    "",
    "> Implementation recipes, not blanket runtime acceptance. Query `pelican recipe --id <id>` for machine-readable source or create a project with `pelican create --template <id>`.",
    "",
    "Each recipe is a complete asset-free `game.ts` using only `pelican-engine`.",
    "In a new installed game directory, create a minimal project with `npx --no-install pelican create --template minimal`, then replace its generated `game.ts` with one recipe. Back up any existing game work before replacing it. Use `npx --no-install pelican dev` or `npx --no-install pelican build` afterward.",
    "",
    "Game development uses the installed npm package. No engine checkout or source ZIP is required.",
    "",
    "Recipes are independent; use one at a time and adapt IDs, input, UI and rules to the game. Their feature limitations remain in `docs/npm/GAME-AUTHOR.md`.",
    "",
    "## Recipes",
    "",
    ...recipes.map(item => `- [${item.title}](#${item.anchor}) — ${item.summary}`),
    "",
  ];
  for (const item of recipes) {
    const source = (await readFile(path.join(root, "examples", item.id, "game.ts"), "utf8")).replace(/\r\n/g, "\n").trimEnd();
    lines.push(`## ${item.title}`, "", item.summary, "",
      `Contributor fixture: \`examples/${item.id}/game.ts\`.`, "", "````ts", source, "````", "");
  }
  return lines.join("\n");
}
