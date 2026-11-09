import {engineTasks} from "../../packages/sdk/src/index.ts";
import { createHash } from "node:crypto";
import { lstat, mkdir, writeFile } from "node:fs/promises";
import { recipeAcceptance } from "../recipe-acceptance.ts";
import { readFile } from "node:fs/promises";
import path from "node:path";

/** Curated source games with bounded licensed assets; documentation and installed copies derive from these files. */
const recipes = [
  {id:"model-animation",anchor:"model-animation",title:"Model slots and animated assets",summary:"Import a licensed local GLB, bind exact material slots and run its named animation clip."},
  {id:"audio-interaction",anchor:"audio-interaction",title:"Audio with real interaction unlock",summary:"Play and stop a licensed local tone through a real browser button; verify the audio device and logical voices."},
  { id: "npm-geometry", anchor: "npm-geometry", title: "Third-party geometry without replacing the renderer", summary: "Use an ordinary npm mesh generator, keep indexed positions/normals/UVs and transfer plain data into managed geometry." },
  { id: "startup-feedback", anchor: "startup-feedback", title: "Loading events and custom npm UI", summary: "Observe startup outside runtime setup, keep engine ownership intact and clean up external UI with an AbortSignal." },
  { id: "render-quality", anchor: "render-quality", title: "High/path default, quality switching and preparation", summary: "Select path/hybrid/raster tiers through public services, prepare tracing before switching and inspect readiness without reloading gameplay." },
  { id: "npm-component", anchor: "npm-component", title: "Instance-local npm dependency context", summary: "Pass browser resources and a real npm compression codec from setup to systems without globals or JSON dependency objects." },
  { id: "dynamic-texture", anchor: "dynamic-texture", title: "Dynamic PNG to managed texture", summary: "Fetch bounded bytes, decode with a game-owned npm codec, validate decoded size and publish a managed texture with save/restore." },
  { id: "third-person", anchor: "third-person", title: "Jump, follow camera and save/load", summary: "A complete physical character game with grounded jumps, follow camera, instance state and local saves." },
  { id: "dynamic-resources", anchor: "dynamic-resources", title: "Dynamic validated JSON to managed rendering", summary: "Fetch bounded cancellable data, validate it, publish on fixed ticks and preserve it in saves." },
  { id: "external-adapters", anchor: "external-adapters", title: "Workers, transports and managed resources", summary: "Bridge standard module Workers and optional WebSocket messages into fixed-tick systems and versioned rendering resources." },
  { id: "runtime-lifecycle", anchor: "runtime-lifecycle", title: "Per-instance runtime and browser dependencies", summary: "Initialize a browser-only npm module, own resources and save/restore instance-local state." },
  { id: "managed-rendering", anchor: "managed-rendering", title: "Managed geometry and rendering extension", summary: "Build an indexed mesh from arrays and compose a versioned postprocess extension." },
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
const extraFiles: Readonly<Record<string, readonly string[]>> = { "runtime-lifecycle": ["browser-counter.ts"], "external-adapters": ["palette-client.ts", "palette-worker.ts", "socket-client.ts"] };
export async function readRecipeFiles(root: string, id: string, installed = false): Promise<Record<string, string>> {
  if (!recipeIds.includes(id)) throw new Error("TC_RECIPE_ID: Unknown recipe; query capabilities for exact IDs.");
  if (installed) {
    const catalog = JSON.parse(await readFile(path.join(root, "docs/api/recipes.json"), "utf8"));
    return catalog.recipes.find((item: { id: string }) => item.id === id)?.files ?? {};
  }
  return Object.fromEntries(await Promise.all((extraFiles[id] ?? []).map(async file => [file, await readFile(path.join(root, "examples", id, file), "utf8")])));
}
export function recipeDependencies(id: string): Record<string, string> {
  if (id === "npm-geometry") return { three: "0.187.0", "@types/three": "0.187.0" };
  if (["runtime-lifecycle", "npm-component"].includes(id)) return { fflate: "0.8.3" };
  if (id === "dynamic-texture") return { "fast-png": "8.0.0" };
  return {};
}
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
  return { format: "pelican.recipes", version: 1, recipes: await Promise.all(recipes.map(async recipe => ({ ...recipe, entry: "game.ts", source: await readRecipe(root, recipe.id), files: await readRecipeFiles(root, recipe.id), dependencies: recipeDependencies(recipe.id), assets: await readRecipeAssets(root,recipe.id), verification: recipeVerification(recipe.id) }))) };
}

export async function renderRecipes(root: string): Promise<string> {
  const lines = [
    "# Game-author recipes",
    "",
    "> Implementation recipes, not blanket runtime acceptance. Query `pelican recipe --id <id>` for machine-readable source or create a project with `pelican create --template <id>`.",
    "",
    "Recipes return complete game source, integrity-checked licensed small assets, helper files and explicit npm dependencies. Rendering uses pelican-engine; algorithm packages are ordinary game dependencies.",
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
    for (const [file, text] of Object.entries(await readRecipeFiles(root, item.id)))
      lines.push(`Helper: \`${file}\``, "", "````ts", text.trimEnd(), "````", "");
    const verification = recipeVerification(item.id);
    lines.push("Edit: " + verification.edit, "", "Boundary: " + verification.boundary, "", "Verification: " + verification.command + " ? " + verification.acceptance, "");
    for(const asset of await readRecipeAssets(root,item.id)) lines.push("Asset: " + asset.path + " (" + asset.bytes + " bytes, " + asset.license + "; SHA-256 " + asset.sha256 + "). Copied by create; base64 bytes returned by recipe.", "");
    const dependencies = recipeDependencies(item.id);
    if (Object.keys(dependencies).length)
      lines.push("Install in the game workspace:", "", "```sh", "npm install --save-exact " + Object.entries(dependencies).map(([name, version]) => `${name}@${version}`).join(" "), "```", "");
  }
  return lines.join("\n");
}

export interface RecipeAsset { path:string;base64:string;bytes:number;sha256:string;license:string }
const assetFiles: Readonly<Record<string, readonly string[]>> = {"model-animation":["panel.glb","LICENSE.txt"],"audio-interaction":["tone.wav","LICENSE.txt"]};
export function validateRecipeAssets(assets: readonly RecipeAsset[]) {
  if(assets.length>8 || new Set(assets.map(a=>a.path)).size!==assets.length)throw new Error("TC_RECIPE_ASSET: Duplicate or excessive assets.");
  let total=0;
  return assets.map(asset=>{
    if(!/^assets\/[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(asset.path) || !asset.license || asset.base64.length>350000)throw new Error("TC_RECIPE_ASSET_PATH: Expected a licensed flat assets/ file.");
    const data=Buffer.from(asset.base64,"base64");total+=data.length;
    if(data.length>262144 || total>524288 || data.length!==asset.bytes || createHash("sha256").update(data).digest("hex")!==asset.sha256)throw new Error("TC_RECIPE_ASSET_INTEGRITY: Size or SHA-256 mismatch.");
    return {path:asset.path,data};
  });
}
export async function readRecipeAssets(root:string,id:string,installed=false):Promise<RecipeAsset[]> {
  if(!recipeIds.includes(id))throw new Error("TC_RECIPE_ID: Unknown recipe.");
  const assets:RecipeAsset[]=installed ? JSON.parse(await readFile(path.join(root,"docs/api/recipes.json"),"utf8")).recipes.find((r:{id:string})=>r.id===id)?.assets ?? [] : await Promise.all((assetFiles[id]??[]).map(async file=>{
    const bytes=await readFile(path.join(root,"examples",id,"assets",file));
    return {path:"assets/"+file,base64:bytes.toString("base64"),bytes:bytes.length,sha256:createHash("sha256").update(bytes).digest("hex"),license:"CC0-1.0"};
  }));
  if(assets.length!==(assetFiles[id]??[]).length || assets.some(asset=>!(assetFiles[id]??[]).includes(path.basename(asset.path))))throw new Error("TC_RECIPE_ASSET_INTEGRITY: Required recipe assets are missing or unexpected; reinstall the complete package.");
  validateRecipeAssets(assets);return assets;
}
export async function prepareRecipeAssetCopy(root:string, assets:readonly RecipeAsset[]) {
  const files=validateRecipeAssets(assets);
  if(!files.length)return async()=>{};
  const directory=path.join(root,"assets");const stat=await lstat(directory).catch((error:NodeJS.ErrnoException)=>{if(error.code!=="ENOENT")throw error;return undefined;});
  if(stat && (!stat.isDirectory() || stat.isSymbolicLink()))throw new Error("TC_RECIPE_ASSET_PATH: assets must be a real project-local directory.");
  for(const file of files)if(await lstat(path.join(root,file.path)).catch((error:NodeJS.ErrnoException)=>{if(error.code!=="ENOENT")throw error;return undefined;}))throw new Error("TC_CREATE_EXISTS: Recipe asset already exists; no files were overwritten.");
  return async()=>{await mkdir(directory,{recursive:true});const current=await lstat(directory);if(!current.isDirectory()||current.isSymbolicLink())throw new Error("TC_RECIPE_ASSET_PATH: Asset directory changed.");for(const file of files)await writeFile(path.join(root,file.path),file.data,{flag:"wx"});};
}
export function recipeVerification(id:string) {
 const related=engineTasks().filter(t=>t.recipes.includes(id));
 return {goal:recipes.find(r=>r.id===id)?.summary??null,taskLimits:[...new Set(related.flatMap(t=>t.limits))],scope:recipeAcceptance(id)?"recipe-acceptance":"project-smoke",command:recipeAcceptance(id)?"pelican verify --recipe "+id:"pelican verify",
   edit:"Change IDs, controls, data URLs and material/asset names in the returned complete files; install listed dependencies in this game project.",
   boundary:"Browser-compatible npm only at runtime. WebGPU required for tracing, managed compute/buffer graphs. Explicit ownership, cancellation and checkpoint hooks govern external resources.",
   acceptance:recipeAcceptance(id)?"Executes the shared contributor/author assertions for this original recipe; modified game specifications require author assertions.":"Three fixed ticks, ready state and no runtime errors only. This recipe has no dedicated gameplay acceptance yet."};
}
