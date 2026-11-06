# Pelican Engine Game Author

Your workspace is the game project. Use the public `pelican-engine` API and local
game modules. Do not modify engine internals or `node_modules`, import Three.js,
TSL, GPU devices, physics-library objects, compiler internals or Node APIs into
game code. Engine research, hardware acceptance, evidence and publishing tasks
are not part of game authoring.

Read the API reference at `docs/api/REFERENCE.md` and machine-readable symbols at
`docs/api/index.json` under the engine/package directory. Installed declarations
are `lib/sdk/index.d.ts`. `pelican api` discovers the index;
`pelican api --symbol defineGame` returns exact, case-sensitive public signatures
as JSON in both source and npm distributions. `pelican help`
lists the JSON CLI protocol. `docs/CAPABILITIES.md` records implemented scope and
limitations. The longer `docs/AI-WORKFLOW.md` is shared design context, not an
instruction to run source-only engine acceptance tasks.

The shared `docs/M3-USAGE.md` describes the current rendering and compute
contracts. Its `examples/`, engine `packages/`, and `npm run probe:*` references
are maintainer references available only in a source checkout; the npm package
intentionally contains no example projects, game assets, or engine source. Use
the same public declarations in your own game project and validate them with the
installed `pelican` commands. Do not try to import an internal compiled module.

Models using `KHR_animation_pointer` animation channels are currently rejected
with `TC_MODEL_EXTENSION_UNSUPPORTED`; pointer-driven material animation is not
implemented. A merely declared optional extension without such a channel does
not cause this runtime rejection.

## Standalone Rendering Recipe

The following complete asset-free `game.ts` works with either distribution and
exercises the public opaque-IOR and specular material controls:

<!-- standalone-render-recipe:start -->
```ts
import { defineGame, defineMaterial, defineScene } from "pelican-engine";

const material = defineMaterial({
  id: "paint",
  color: "#303030",
  roughness: 0.35,
  metalness: 0,
  ior: 1.5,
  specularIntensity: 0.7,
  specularColor: "#ffb080",
});

export default defineGame({
  id: "render-recipe",
  scene: defineScene({
    id: "main",
    camera: { position: [0, 1, 5], target: [0, 0, 0], fov: 45 },
    environment: { background: "#17212a", ambientIntensity: 0.4 },
    entities: [
      { id: "object", mesh: { geometry: { kind: "box" }, material } },
      { id: "light", transform: { position: [2, 4, 5] },
        light: { kind: "directional", intensity: 3 } },
    ],
  }),
});
```
<!-- standalone-render-recipe:end -->

Use `npx --no-install pelican check` and `npx --no-install pelican dev` in an
installed project, then `npx --no-install pelican build`. A repository-based
project uses the same source and equivalent engine CLI commands listed below.
Imported opaque GLB materials support `KHR_materials_specular` intensity and
color textures with `TEXCOORD_0`. Positive transmission combined with specular
textures or non-default specular remains unsupported. The tracer rejects PNG
color maps with ICC profiles. Low-bit-depth grayscale and indexed Adam7 PNGs
are decoded with explicit pass/filter validation. For 16-bit PNG,
supported color chunks are gAMA 45455 or 100000, standard sRGB cHRM, sRGB
intent 0, and cICP [1,13,0,1]; other values are diagnosed. Use supported PNG
or JPEG and retain diagnostics rather than silently changing material semantics.

Audio voices returned by `ctx.audio.play(soundId, options)` can be paused and
resumed with `ctx.audio.pause(voice)` and `ctx.audio.resume(voice)`. Both are
idempotent; a valid unknown voice is a no-op. Playback position follows fixed
simulation ticks, including while browser audio is locked. Paused time does not
advance the voice. Snapshots restore playback intent and logical position, not
the browser's internal audio processing state.

Declare `audioBuses: [{ id: "music", volume: 0.5 }]` in `defineGame`, route a
sound with `sounds: [{ id: "theme", asset: musicAsset, bus: "music" }]`, and
change its bus using `ctx.audio.busVolume("music", 0.25)`. A `play` call can
override the sound's bus with `{ bus: "music" }`. Bus, voice and master gains
multiply; `ctx.audio.volume` controls master gain. Unknown buses and gains
outside 0–1 return diagnostics. Games with no buses keep their existing routing.

Use `ctx.audio.fadeBus("music", 0, 1.5)` for a fixed-tick linear fade in
seconds. A new fade or `busVolume` replaces the previous fade. `play` accepts
an optional integer `priority` from 0 to 255; when the voice limit is full, a
new voice only replaces the earliest voice with a strictly lower priority.
Invalid priority or a non-winning full voice returns a stable diagnostic.

For orthogonal grid routing, game systems may call `ctx.navigation.createGrid`
with `{ id, owner, width, height }`, then `setBlocked(id, { x, y }, true)` and
`findPath(id, start, end)`. Paths contain both endpoints; `destroyGrid` and
`destroyOwner` release grids. The default 65,536-cell `searchCellBudget` limits
distinct cells considered per query; set it explicitly when needed. Budget
exhaustion returns `TC_NAVIGATION_CAPACITY`, not an unreachable result. Owners
are explicit strings, not entities. This is a development-stage grid service,
not continuous-world, flying or underwater navigation.

Keyboard bindings use the browser's `KeyboardEvent.key` values, not physical
`KeyboardEvent.code` values. For example, use `input: { up: ["w", "W", "ArrowUp"],
restart: ["r", "R"] }`, not `"KeyW"` or `"KeyR"`. Letter case depends on the
actual keyboard event; Space is `" "`. Actions are read inside systems through
`ctx.input.held`, `pressed`, `released`, or `axis`. Always exercise real keyboard
input in the browser; a mocked system test does not establish browser bindings.

## Work Loop

1. Inspect `pelican.project.json`, `game.ts`, asset declarations and the public API.
2. Make small game-only edits. Keep the exact engine version lock.
3. Run `pelican check`, then `pelican dev` and exercise actual gameplay.
4. Use `inspect`, `input`, `step`, `pause`, `resume`, `snapshot`, `restore`,
   `record`, `replay`, `status`, `cancel` and `reset-session` against the dev port.
5. Run `capture --live` against the dev port or a standalone `capture`, inspect
   the actual screenshot, and preserve explicit failures rather than claiming success.
6. Run `build` and serve `dist/` over HTTP(S). Keep notices and license files.

Installed package commands use `npx --no-install pelican <command>` from the game
directory. Repository commands use `node --import tsx <engine>/tools/cli.ts
<command> --project <game-directory>` with the same operations and protocol.
Both `create` commands generate a project `AGENTS.md` pointing to these same docs.
In a new installed workspace, `npm --prefix . i -D pelican-engine` followed by
`npx pelican dev` automatically creates that same minimal starter when no project
files exist. Existing games, manifests and author instructions are preserved.
The explicit prefix prevents npm from choosing a parent project when one exists.

Dependencies and Chromium must be installed before offline work. Once prepared,
checks/builds/dev/capture use local files and loopback only. `setup --offline`
never downloads a missing browser. In npm projects use `setup --install-browser`
once while online. No Git checkout, account, external AI service or source tree
is required to author an installed game.

Do not assume all render modes are supported. Use `engine.render.capabilities()`
to inspect the actual backend. WebGL2 fallback does not silently implement
compute-dependent path/hybrid features. Observe structured diagnostics and keep
the prior valid state on rejected operations. Hardware acceptance is separate
from a successful software-rendered or CPU-only run.

For project-version mismatches, migrate via public API, then explicitly update
the lock. For package integrity/dependency errors, reinstall one exact package
version. Never work around a diagnostic by importing an internal dependency.
