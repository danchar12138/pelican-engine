# Compiler

Engine contributor implementation: TypeScript checking, trusted content construction or legacy static extraction, normalization, asset fingerprinting, incremental output, browser system bundling.

The public game-author entry is the npm package and `pelican` CLI. See [architecture](../../docs/ARCHITECTURE.md) and [npm authoring](../../docs/npm/GAME-AUTHOR.md). Source contracts live in `src/version.ts` and `src/types.ts`; SDK signatures live in `../sdk/src/index.ts`. Run `npm test` from the engine root for compiler behavior and boundary regressions.
