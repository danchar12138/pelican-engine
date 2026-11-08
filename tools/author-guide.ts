import { SDK_VERSION, engineCapabilities } from "../packages/sdk/src/index.ts";
import { recipeIds, recipeDependencies } from "./npm/recipes.ts";

function options(
  args: readonly string[],
  values: readonly string[],
  flags: readonly string[],
  code: string,
) {
  const result = new Map<string, string | true>();
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (result.has(key) || (!values.includes(key) && !flags.includes(key)))
      throw new Error(
        `${code}: Unexpected or duplicate '${key}'. Read pelican --help for accepted options.`,
      );
    if (flags.includes(key)) result.set(key, true);
    else {
      const value = args[++i];
      if (!value?.trim() || value.startsWith("--"))
        throw new Error(`${code}: Supply a nonempty value after '${key}'.`);
      result.set(key, value);
    }
  }
  return result;
}

/** Opt-in summaries preserve the existing full capability response for 1.x clients. */
export function queryCapabilities(args: readonly string[]) {
  const parsed = options(
    args,
    ["--feature", "--limit", "--offset"],
    ["--summary"],
    "TC_CAPABILITY_QUERY",
  );
  const limitText = parsed.get("--limit"),
    offsetText = parsed.get("--offset");
  const requestedLimit =
    limitText === undefined ? undefined : Number(limitText);
  const offset = offsetText === undefined ? 0 : Number(offsetText);
  if (
    (requestedLimit !== undefined &&
      (!Number.isSafeInteger(requestedLimit) ||
        requestedLimit < 1 ||
        requestedLimit > 100)) ||
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    offset > 100000
  )
    throw new Error(
      "TC_CAPABILITY_QUERY: Use --limit 1..100 and --offset 0..100000.",
    );
  const features = engineCapabilities(String(parsed.get("--feature") ?? ""));
  const limit = requestedLimit ?? features.length;
  const page = features.slice(offset, offset + limit);
  return {
    engineVersion: SDK_VERSION,
    format: "pelican.capabilities",
    total: features.length,
    truncated: offset + page.length < features.length,
    ...(parsed.has("--limit") || parsed.has("--offset")
      ? {
          offset,
          limit,
          nextOffset:
            offset + page.length < features.length
              ? offset + page.length
              : null,
        }
      : {}),
    ...(parsed.has("--summary") ? { detail: "summary" } : {}),
    features: parsed.has("--summary")
      ? page.map(({ id, description, implementation, backends, recipes }) => ({
          id,
          description,
          implementation,
          backends,
          recipes,
          query: `pelican capabilities --feature ${id}`,
        }))
      : page,
    runtimeProbe: "inspect",
    recipes: recipeIds,
    acceptance:
      "Implementation metadata only; runtime/backend/hardware evidence is separate.",
  };
}

/** Small, installed-package-only starting context. Exact contracts stay in SDK/API metadata. */
export function authorGuide(args: readonly string[]) {
  const parsed = options(args, ["--goal"], [], "TC_GUIDE_QUERY");
  const goal = String(parsed.get("--goal") ?? "");
  const features = goal ? engineCapabilities(goal) : [];
  const recipes = [...new Set(features.flatMap((feature) => feature.recipes))];
  return {
    format: "pelican.author-guide",
    version: 1,
    engineVersion: SDK_VERSION,
    goal: goal || null,
    entry: "pelican-engine",
    workflow: [
      "npx --no-install pelican create --template minimal",
      "npx --no-install pelican capabilities --summary",
      "npx --no-install pelican api --search <goal> --member --limit 5",
      "npx --no-install pelican recipe --id <recipe-id>",
      "npx --no-install pelican check",
      "npx --no-install pelican dev",
      "npx --no-install pelican build",
    ],
    creation:
      "create is for an empty game directory; dev scaffolds an eligible empty npm workspace. Preserve existing game files.",
    authoring: {
      language:
        "Ordinary TypeScript: functions, classes, loops, local modules and browser-compatible npm packages. Not a mandatory engine DSL.",
      dependencies:
        "Install dependencies in the game package.json. No algorithm dependency approval list in content: typescript. Legacy static mode is optional compatibility.",
      lifecycle:
        "Declare system IDs in game.systems. Load browser-only modules in runtime.create; own(resource, release) adapts ordinary objects, listen scopes EventTarget subscriptions, defer handles cleanup and signal cancels initialization.",
      state:
        "Use components or versioned snapshot/validateSnapshot/restore hooks for saved state. Third-party objects and closures are not saved automatically.",
      extensions:
        "Compose your own gameplay/npm modules with engine services. createRuntimeAdapter bridges Worker/WebSocket clients through bounded queues with explicit owned/borrowed endpoints. Managed geometry/PBR/buffers/textures and defineRenderExtension retain resource checks. Built-in gameplay services are optional.",
      boundary:
        "Private Three.js/GPU/WASM objects are not a stable ownership contract. Node-only dependencies belong in asset/build tooling. Synchronous system callbacks must not block or return promises.",
    },
    discovery: {
      features: features.map(({ id, implementation, symbols, limits }) => ({
        id,
        implementation,
        symbols,
        limits,
      })),
      recipes: recipes.map((id) => ({
        id,
        dependencies: recipeDependencies(id),
        create: `pelican create --template ${id}`,
        query: `pelican recipe --id ${id}`,
      })),
      next: features.length
        ? [...new Set(features.flatMap((feature) => feature.symbols))]
            .slice(0, 6)
            .map((symbol) => `pelican api --symbol ${symbol}`)
        : [
            "pelican guide --goal 存档",
            "pelican guide --goal npm",
            "pelican capabilities --summary --limit 8",
          ],
      recovery:
        "An unknown query does not prove a missing capability. Try aliases, a shorter goal, the owning service and exact Type.member. Report the concrete gap; do not silently remove a requested feature.",
    },
    verification:
      "check/build do not prove behavior. Run the game, inspect diagnostics and use step/input/capture. automation=1 pauses intentionally; use step/resume, not desktop Enter. Test instance cleanup and save/load when using external state.",
    docs: [
      "docs/npm/GAME-AUTHOR.md",
      "docs/npm/INTEGRATIONS.md",
      "docs/api/index.json",
      "lib/sdk/index.d.ts",
      "llms.txt",
    ],
  };
}
