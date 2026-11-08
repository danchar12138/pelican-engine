# Public SDK

`src/index.ts` is the single public type and factory contract. Generated declarations and API indexes derive from that source. Feature metadata lives in `src/capabilities.ts`.

Game authors install `pelican-engine` from npm in a separate workspace. Use `pelican capabilities`, `pelican api --search <query>` and `pelican recipe --id <id>` rather than cloning this contributor repository.

New projects use ordinary trusted TypeScript construction (`content: "typescript"`), including loops, classes, closures and browser-compatible npm packages. Existing manifests retain the nonexecuting `static` compatibility mode. Gameplay runs in synchronous systems; components and engine services participate in snapshots, while arbitrary module-local objects do not automatically acquire save/replay or disposal behavior.

For contributor architecture and extension boundaries see [architecture](../../docs/ARCHITECTURE.md). For installed game authoring see [the npm guide](../../docs/npm/GAME-AUTHOR.md). Signatures, graph operators and service methods come from source and generated CLI queries, not a second hand-maintained API inventory.
