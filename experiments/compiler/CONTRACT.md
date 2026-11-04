# Compiler compatibility entry

The formal implementation is [packages/compiler/src](../../packages/compiler/src/index.ts).
All experimental TypeScript files are compatibility reexports only.

See the [M1 compiler contract](../../packages/compiler/README.md) for system metadata,
version/path locks, source maps and cache behavior.
The original [M0 contract](../../packages/compiler/M0-CONTRACT.md) is retained for historical context;
its update-only and M0-version notes are superseded by the M1 contract.

`compileProject`, `SceneIR`, and the other existing exported symbols remain accessible from these old paths.
