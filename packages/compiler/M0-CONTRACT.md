# M0 compiler integration contract (implemented prototype, IR v1)

Entry: import { compileProject } from './experiments/compiler/index.ts'.
Signature: compileProject({ projectRoot, outDir, engineRoot? }): Promise<CompileResult>.
No Git required. Default entry is game.ts; optional pelican.project.json: { "entry": "game.ts" }.
Relative outDir is resolved against projectRoot; relative engineRoot against the caller cwd.
Diagnostics have code, severity, message, suggestion and source { file, line, column, length }; line/column are 1-based UTF-16 positions. Sources are project-relative.
The canonical typed IR and report definitions are in types.ts. Consumers must check success and IR version before loading artifacts.

## Outputs

- scene.ir.json: format=pelican.scene, version=1, engineVersion, gameId, scene, components, prefabs, materials, computes, systems, assets.
- scene.camera: position and target triples; fov is degrees; near/far are distances.
- scene.environment: background CSS color and ambientIntensity.
- scene.entities: resolved prefab data, id, optional parent, transform {position,rotation,scale}, components map, optional mesh and light.
- rotation is Euler XYZ in radians; parent relationships are local transforms.
- mesh.geometry: {kind:box,size?:[x,y,z]}, {kind:sphere,radius?,segments?}, {kind:plane,size?:[x,y]}; mesh.material references materials[].id.
- materials: id, color CSS string, roughness, metalness, optional graph, optional texture asset ID. Missing optional fields receive explicit compiler defaults.
- light: kind=directional|point, color, intensity, castShadow. Directional lights point toward the world origin in the M0 renderer contract; advanced targets are not implemented.
- assets: path is dist-relative assets/<id>-<basename>, sourcePath is project-relative, hash is SHA256.
- game.js: standalone browser ESM, named export createGame(engine); returns { update(dt), dispose() }.
- engine facade is SDK EngineFacade: getTransform, setTransform, getComponent, setComponent, query. Calls update(dt) execute actual TypeScript system logic; transform setters must update authoritative renderer/world state.
- game.js.map: source content embedded, project-relative source paths.
- build-report.json: diagnostics, content hashes, incremental hit/miss and schema/default change policy.
- version.json: format and engine/compiler/schema versions.

## Boundaries

The compiler uses TS 6.0.3 classic Compiler API and Vite build API. Source modules are parsed and typechecked, never imported/evaluated at build time. Only declaration calls imported from pelican-engine are statically evaluated. The M0 declaration subset allows literals, const references, arrays/objects, static spreads, finite arithmetic, and local named imports. Unsupported expressions produce errors instead of running code.

Graphs support float, vec3, time, add, multiply, sin. The compiler validates types, references and cycles and emits graph IR. Graph GPU execution is the renderer's responsibility; compiler acceptance alone is not GPU verification.

HotReload in reports is a recommended compatibility policy, not a live state migration implementation. Type/layout changes require restart; default changes retain existing component state and affect only newly created entities. M0 does not claim arbitrary hot replacement or storage migration.

A failed build returns success=false and writes a failure report; any previous successful artifacts remain explicitly stale and must not be loaded as the current build.

## Incremental and failure behavior

The M0 cache is a whole-project content-hash cache, not yet a per-stage incremental compiler. An unchanged valid build reuses typecheck, extraction, graph validation and JS bundle artifacts. A miss rebuilds the project. Keys include recorded source modules, local type declarations, asset bytes, SDK/compiler sources, TypeScript and Vite versions. Output hashes are checked before reuse. SDK and compiler path entries are relative; source maps include source contents and project-relative paths, supporting external directories and relocation without Git.

Corrupt caches rebuild safely. A failed build returns structured diagnostics and preserves existing successful JS instead of replacing it with invalid content. The failure report marks prior artifacts as stale. An unwritable output path returns TC_OUTPUT_WRITE.

Implemented tests: tests/compiler.test.ts (20 node:test cases). They execute compiled gameplay, reject top-level side effects and private imports, check original graph error coordinates, detect declaration/prefab/scene/graph cycles and missing resources, verify cache hits/invalidation, schema/default policies, assets, no-Git external projects, Chinese/space paths, relocation, corrupted caches and unwritable output.

Vite builds run with production mode and implicit .env loading disabled. The compiler restores the exact caller NODE_ENV in a finally block on success and failure, and serializes its own concurrent Vite builds. Regression tests cover absent, development, test and empty values, production branch elimination, a later Vite dev server retaining DEV=true, cache hits, and an actual bundler failure. This does not isolate unrelated concurrent host code from the temporary process environment while a build is active.
