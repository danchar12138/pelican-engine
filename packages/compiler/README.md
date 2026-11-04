# @threecat/compiler (M1 foundation, M2 content extensions)

The formal compiler implementation lives in `src/`. It has no implementation dependency on `experiments/`.
The old experimental TypeScript entry points reexport this package for M0 source API compatibility.
This source package uses the repository's locked TypeScript/Vite toolchain, not a separate install or registry release.

```ts
import {
  compileProject,
  SYSTEM_PHASES,
} from "./packages/compiler/src/index.ts";
import type { SceneIR, SystemIR } from "./packages/compiler/src/types.ts";
```

## Compilation contract

`compileProject({ projectRoot, outDir, engineRoot? })` retains the M0 result shape:
`{ success, diagnostics, report, ir? }`. Paths are resolved without Git metadata.
The default engine root is derived from the formal package location, not the current working directory.
The compiler parses/typechecks source, statically extracts declarations, validates them, and bundles executable gameplay.
It never imports or evaluates a game module at build time. Unsupported syntax is diagnosed, not executed.

The existing static subset, graph validation, entities, assets, original-source diagnostics,
standalone `game.js`, embedded source map, failed-build preservation, and whole-project cache remain available.
The compiler remains a constrained TypeScript declaration compiler, not an arbitrary compile-time evaluator.
The historical M0 contract is retained in `M0-CONTRACT.md`; the rules below supersede its update-only/version notes.

## System IR

`SceneIR.version` remains `1`: the extension preserves existing fields and default `update` behavior.
`SystemIR` contains `id`, `phase`, `source` and optional `before`, `after`, `reads`, `writes`, `structural`.
Phases are reexported from the public SDK, in this order:
`input`, `prePhysics`, `physics`, `postPhysics`, `update`, `presentation`.

- IR preserves declaration order; the runtime host owns dependency ordering and execution.
- `before`/`after` reference active system IDs. Duplicate IDs, unknown references, cycles/self edges,
  and dependencies reversing phase order are compile errors.
- `reads`/`writes` contain declared component IDs or the built-in `Transform` ID.
  Unknown components, duplicate entries, malformed lists and unknown system properties are errors.
- An omitted access field retains legacy unrestricted behavior for that field. Explicit `[]` grants nothing.
  Omitted `structural` retains legacy behavior; explicit `false` denies structural commands.
  The compiler does not fill omitted fields with empty lists or falsely infer complete access permissions.
- Actual function syntax is required for `run`. Async/generator functions and inferred Promise/thenable returns
  are rejected. Runtime checks remain necessary for behavior hidden by unsafe type assertions or indirect calls.
- `source` maps to the original declaration; field diagnostics retain the original initializer location,
  including declarations in imported local source modules. Type-only and dynamic module references obey the same
  public SDK/project-local boundary as ordinary imports.
- Bundled `instantiateGame` delegates to the SDK's optional `host.runGameSystems(systems, dt)` hook.
  Its legacy facade fallback remains available; it does not emulate the M1 scheduler or runtime services.

## Version and path locks

`threecat.project.json` accepts `entry`, `engineVersion`, and `engine: { version?, path? }`.
Each supplied version must exactly equal `SDK_VERSION`, including prerelease identifiers.
Ranges, conflicting declarations and old `0.0.1-m0.0` locks fail with `TC_ENGINE_VERSION_MISMATCH`
and explicit migration advice. A manifest-less/unlocked legacy project still builds with
`TC_ENGINE_VERSION_UNLOCKED`; new projects should lock their version.

The selected engine SDK version is read from its AST without executing that SDK. A compiler/SDK mismatch fails
with `TC_ENGINE_SDK_VERSION`. When `engine.path` is present, it resolves from the project root and must identify
the selected engine root. Relative, absolute cross-drive and UNC paths are accepted; real paths are compared
case-insensitively on Windows. A mismatch or missing target produces `TC_ENGINE_PATH_MISMATCH`.

Artifacts use the imported `SDK_VERSION`, not a hardcoded M0 version. `version.json` includes `engineVersion`,
`sdkVersion`, `compilerVersion` (TypeScript tool version, retained for compatibility), `irVersion`,
`systemMetadataVersion: 1` and `schemaHash`. This package does not generate the public API catalog.

## Hashes and maps

Cache inputs include compiler/SDK sources, runtime/schema package TypeScript/JSON files,
project source/type declarations, the project manifest, assets and installed tool versions.
Runtime/schema packages still under generation may be absent: `TC_ENGINE_INPUT_MISSING` explains this;
later additions, edits and removals invalidate cache. Hashing does not import runtime/schema modules.
This remains whole-project reuse, not a claim of per-stage incremental execution or live state migration.

Windows cross-drive SDK maps use stable `threecat-sdk/...` names. Source roots are applied before normalization
and then cleared; source content is embedded. Unexpected cross-drive non-SDK sources fail explicitly.
Vite's temporary production `NODE_ENV` transaction is serialized and restored on success/failure.

## M2 assets and content

The public SDK is the definition source for additional scenes, model/rigid-body/character declarations, input bindings, basic UI, audio and camera following. The compiler resolves the same entity/default rules for every scene and preserves prefab identity for runtime instances. Model offset/rotation and shadow properties survive IR; signed scene gravity and downward character-gravity magnitude are distinct. Keyboard bindings accept literal Space.

Assets support `model`, `texture`, `audio` and `binary`. The offline asset inspector validates supported file bytes before copying, writes actual metadata into `ir.assets[].metadata`, validates authored animation clip names and emits source-position diagnostics for malformed content. Both inspection and final output copying verify the content hash so a changing source cannot silently produce inconsistent IR. Unsupported formats/extensions are diagnosed rather than approximated. Inspection limits are documented in `packages/assets/README.md`.

Optional source/license/attribution fields remain verbatim declarations. `asset-notices.json` accompanies the bundle, preserving undeclared licenses as null and issuing `TC_ASSET_LICENSE_UNDECLARED` warnings. These declarations are not a legal-rights verification service. Explicit lossless `optimize` preprocessing creates a new GLB, and the author adopts it by changing the declared path; ordinary compilation never mutates source assets.

Asset-package sources and compiler package metadata participate in cache invalidation. Whole-project reuse remains the current policy. A compatible-schema report is update guidance, not a promise of live state migration: the development server still performs a cold reload.

## Validation

```powershell
node --import tsx --test tests/compiler.test.ts tests/source-map.test.ts
```

These tests cover actual emitted gameplay, M0 compatibility, M1 metadata/scheduler handoff, version/path locks,
cache invalidation, API boundaries, diagnostics, relocation, environment restoration and source maps.
They do not constitute renderer, GPU, runtime scheduler or full-engine acceptance.
