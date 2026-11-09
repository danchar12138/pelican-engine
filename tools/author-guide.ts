import { readFile } from "node:fs/promises";
import path from "node:path";
import { SDK_VERSION, engineCapabilities, engineTasks } from "../packages/sdk/src/index.ts";
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
      ? page.map(({ id, description, aliases, implementation, backends, recipes }) => ({
          id,
          description,
          aliases,
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
  const parsed = options(args, ["--goal", "--limit", "--offset"], ["--tasks"], "TC_GUIDE_QUERY");
  const goal = String(parsed.get("--goal") ?? "");
  let tasks = goal ? engineTasks(goal) : parsed.has("--tasks") ? engineTasks() : [];
  const offset=Number(parsed.get("--offset")??0),limit=Number(parsed.get("--limit")??8);
  if(!Number.isSafeInteger(offset)||offset<0||offset>100000||!Number.isInteger(limit)||limit<1||limit>100)throw new Error("TC_GUIDE_QUERY: Use --limit 1..100 and --offset 0..100000.");
  const totalTasks=tasks.length;
  if(parsed.has("--tasks"))tasks=tasks.slice(offset,offset+limit);
  let features: ReturnType<typeof engineCapabilities> = [];
  let failure: { code: string; message: string } | undefined;
  if (goal) {
    try { features = engineCapabilities(goal); }
    catch (error) {
      if (String(error).includes("TC_CAPABILITY_UNSUPPORTED")) throw error;
      if (!String(error).includes("TC_CAPABILITY_UNKNOWN")) throw error;
      if (!tasks.length) failure = { code: "TC_TASK_UNKNOWN", message: `No task matched '${goal}'. Candidates below are navigation choices, not claims of support.` };
    }
    const ids = new Set(features.map(feature => feature.id));
    for (const id of tasks.flatMap(task => task.features))
      if (!ids.has(id)) { features.push(...engineCapabilities(id)); ids.add(id); }
  }
  const recipes = [...new Set([...tasks.flatMap(task => task.recipes), ...features.flatMap((feature) => feature.recipes)])];
  const taskCatalog = engineTasks();
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
        "defineGameRuntime declares systems once with isolated JSON state/save hooks. setup can return a typed per-instance dependency context for systems; it is not saved. Or use runtime.create. scope.own/listen/cleanup/defer and signal manage lifetime.",
      state:
        "Use components or versioned snapshot/validateSnapshot/restore hooks for saved state. Third-party objects and closures are not saved automatically.",
      extensions:
        "Compose gameplay/npm freely. Worker/WebSocket/generic adapters bridge owned/borrowed endpoints. loadRuntimeJSON/loadRuntimeBytes prepare bounded data for npm codecs and managed textures. Validate decoded-size budgets. Managed rendering retains resource checks; gameplay services are optional.",
      boundary:
        "Private Three.js/GPU/WASM objects are not a stable ownership contract. Node-only dependencies belong in asset/build tooling. Synchronous system callbacks must not block or return promises.",
    },
    discovery: {
      status: failure ? "unrecognized" : goal ? "matched" : "catalog",
      ...(failure ? { failure } : {}),
      tasks,
      ...(parsed.has("--tasks") ? {paging:{offset,limit,total:totalTasks,truncated:offset+tasks.length<totalTasks,next:offset+tasks.length<totalTasks?`pelican guide --tasks --limit ${limit} --offset ${offset+tasks.length}`:null}}:{}),
      ...(!goal || failure ? {
        candidates: taskCatalog.slice(0, 8).map(({ id, title }) => ({ id, title, query: `pelican guide --goal ${id}` })),
        catalog: { total: taskCatalog.length, truncated: taskCatalog.length > 8, query: "pelican guide --tasks --limit 8 --offset 0" },
      } : {}),
      features: features.map(({ id, description, aliases, implementation, backends, symbols, limits }) => ({
        id,
        description,
        aliases,
        implementation,
        backends,
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
        ? [...new Set([...tasks.flatMap(task => task.methods), ...features.flatMap((feature) => feature.symbols)])]
            .slice(0, 6)
            .map((symbol) => `pelican api --symbol ${symbol}`)
        : [
            "pelican guide --goal 存档",
            "pelican guide --goal npm",
            "pelican capabilities --summary --limit 8",
          ],
      recovery:
        "An unknown query does not prove a missing capability. Use task candidates, the owning service and exact Type.member. Report the concrete gap; do not silently remove a requested feature.",
      ...(goal ? { coverage: "Matched intents only, not proof that every clause is supported. Feature-derived tasks preserve original backend/implementation limits; recipes may be absent." } : {}),
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

/** Only reads two bounded project manifests; never compiles or walks source. */
export async function compactAuthorGuide(args: readonly string[], projectRoot: string) {
  const goalIndex=args.indexOf("--goal");
  if(goalIndex>=0 && Buffer.byteLength(args[goalIndex+1]??"")>160)throw new Error("TC_GUIDE_QUERY: Compact goals must fit 160 UTF-8 bytes; use a short task ID or full guide.");
  const full = authorGuide(args);
  if (full.goal && Buffer.byteLength(full.goal) > 160) throw new Error("TC_GUIDE_QUERY: Compact goals must fit 160 UTF-8 bytes; use a short task ID or full guide.");
  const read = async (name: string) => {
    try { const bytes = await readFile(path.join(projectRoot, name));
      if (bytes.length > 65536) return { status: "unavailable", reason: "manifest exceeds 64 KiB" };
      return { status: "available", value: JSON.parse(bytes.toString("utf8")) };
    } catch (error) { return { status: (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unavailable" }; }
  };
  const [project, pkg] = await Promise.all([read("pelican.project.json"), read("package.json")]);
  const task = full.discovery.tasks[0];
  const feature = full.discovery.features[0];
  const entry=project.value?.entry;
  const requirement=pkg.value?.dependencies?.["pelican-engine"]??pkg.value?.devDependencies?.["pelican-engine"];
  return {
    format: full.format, detail: "compact", engineVersion: SDK_VERSION,
    project: { manifest: project.status, package: pkg.status, entry: typeof entry === "string" && Buffer.byteLength(entry)<=120 ? entry : null,
      entryStatus:typeof entry!=="string"?"unavailable":Buffer.byteLength(entry)>120?"truncated; read pelican.project.json":"available",
      engine:typeof requirement==="string"&&Buffer.byteLength(requirement)<=80?requirement:null,
      engineStatus:typeof requirement!=="string"?"unavailable":Buffer.byteLength(requirement)>80?"truncated; read package.json":"available" },
    discovery: { status: full.discovery.status,
      tasks: full.discovery.tasks.slice(0,1).map(t => ({ id:t.id, description:t.title, aliases:t.aliases?.slice(0,2) })),
      capabilities: full.discovery.features.slice(0,2).map(f => ({ id:f.id, implementation:f.implementation, query:"pelican capabilities --feature "+f.id })),
      recipes: full.discovery.recipes.slice(0,1).map(r => ({id:r.id, query:r.query})),
      ...(full.discovery.status === "unrecognized" || !task ? { candidates: engineTasks().slice(0,2).map(t => ({kind:"navigation",id:t.id,query:"pelican guide --compact --goal "+t.id})) } : {}),
    },
    next: task?.methods[0] ? "pelican api --symbol " + task.methods[0] : feature?.symbols[0] ? "pelican api --symbol "+feature.symbols[0] : "pelican capabilities --summary --limit 5",
    truncated: true,
    continuation: "pelican guide" + (full.goal ? " --goal " + JSON.stringify(full.goal) : ""),
    continuationArgs:full.goal?["guide","--goal",full.goal]:["guide"],
    limits: "Compact navigation omits full task/feature constraints. Read continuation and capability limits before implementation. Unknown queries are not unsupported. Use ordinary TS/npm; own external resources. check/build are not runtime acceptance.",
  };
}
