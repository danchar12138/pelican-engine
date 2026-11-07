import { readFile } from "node:fs/promises";
import path from "node:path";

/** Curated, asset-free source games; documentation and installed copies derive from these files. */
const recipes = [
  { id: "orthographic-2d", anchor: "orthographic-raster", title: "Orthographic raster", summary: "Move simple 2D-positioned objects under an orthographic camera." },
  { id: "physics2d", anchor: "2d-rigid-bodies", title: "2D rigid bodies", summary: "Move an XY body in an independent 2D physics world." },
  { id: "physics2d-character", anchor: "2d-character", title: "2D character", summary: "Drive a kinematic character against 2D obstacles." },
  { id: "gamepad", anchor: "gamepad-input", title: "Gamepad input", summary: "Combine standard gamepad input with keyboard bindings." },
  { id: "dynamic-ui", anchor: "dynamic-ui", title: "Dynamic UI", summary: "Create and remove reusable menu slots." },
  { id: "inventory", anchor: "inventory", title: "Inventory", summary: "Move stackable items between a backpack and a chest." },
  { id: "quests", anchor: "quest-objectives", title: "Quest objectives", summary: "Advance objectives and grant a game-defined reward." },
  { id: "dialogue", anchor: "branching-dialogue", title: "Branching dialogue", summary: "Display a conversation and start a quest from a choice." },
  { id: "localization", anchor: "localization", title: "Localization", summary: "Switch languages and format plural messages." },
  { id: "navigation-agents", anchor: "grid-navigation", title: "Grid navigation", summary: "Move two point agents and change an obstacle." },
  { id: "streaming-world", anchor: "static-world-chunks", title: "Static world chunks", summary: "Load static chunks and build or remove markers." },
] as const;

export async function renderRecipes(root: string): Promise<string> {
  const lines = [
    "# Game-author recipes",
    "",
    "> These are development-stage examples. Runtime behavior, hardware, input and snapshot restoration remain unverified under the current build-only policy.",
    "",
    "Each recipe is a complete asset-free `game.ts` using only `pelican-engine`.",
    "In a new installed game directory, create a minimal project with `npx --no-install pelican create --template minimal`, then replace its generated `game.ts` with one recipe. Back up any existing game work before replacing it. Use `npx --no-install pelican dev` or `npx --no-install pelican build` afterward.",
    "",
    "For a source checkout or ZIP, use the same code and the engine CLI with the project directory; the corresponding editable originals are under `examples/`. The npm package includes this documentation, not those example directories or game assets.",
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
      `Source checkout: \`examples/${item.id}/game.ts\`.`, "", "````ts", source, "````", "");
  }
  return lines.join("\n");
}
