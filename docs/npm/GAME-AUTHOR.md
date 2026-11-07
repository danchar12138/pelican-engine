# Pelican Engine Game Author

For an installed game, start in an empty directory with `npm --prefix . install
--save-dev --save-exact pelican-engine`, then run `npx pelican dev`. The CLI
generates the minimal starter when the directory is eligible and preserves existing
game files. See `docs/GETTING-STARTED.md` in the package for npm and source
workflows. Commands use common Node/npm syntax; the currently supported development
environment is Windows, while player support depends on actual browser capabilities.

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

The installed package includes `docs/GRAPHICS-GUIDE.md` and
`docs/RENDER-BACKENDS.md`. The source checkout's `docs/STATUS.md` summarizes
current engine capabilities and gaps. Its `examples/`, engine `packages/`, and
`npm run probe:*` references are maintainer references available only in a source checkout; the npm package
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
GLB `KHR_materials_emissive_strength` factors are accepted and retained by
asset optimization; their runtime rendering behavior remains unverified.
GLB material textures may use `KHR_texture_transform` offset, rotation, scale
and UV-set override. General material slots support UV0 and UV1; specular
texture slots remain limited to UV0. This addition is not runtime-validated.
Imported opaque GLB materials support `KHR_materials_specular` intensity and
color textures with `TEXCOORD_0`. Positive transmission combined with specular
textures or non-default specular remains unsupported. The tracer rejects PNG
color maps with ICC profiles. Low-bit-depth grayscale and indexed Adam7 PNGs
are decoded with explicit pass/filter validation. For 16-bit PNG,
supported color chunks are gAMA 45455 or 100000, standard sRGB cHRM, sRGB
intent 0, and cICP [1,13,0,1]; other values are diagnosed. Use supported PNG
or JPEG and retain diagnostics rather than silently changing material semantics.

Use `ctx.animation.play(entity, clip, { startAt: seconds, speed, loop, fade })`
to begin a model clip at a local time within its duration. Negative playback
speed starts at the clip end when `startAt` is omitted; positive speed defaults
to the beginning. Clip timing, fades and snapshot restoration remain unverified
at runtime under the current build-only policy.

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

Use `ctx.navigation.setBlockedBatch(id, updates)` to change multiple cells in
one grid. Each update has `{ cell: { x, y }, blocked: boolean }`. The service
validates every entry before changing the grid; a bad entry rejects the whole
batch, and the last update wins if a cell appears more than once. Entity and
transform changes are separate from this grid-only batch. This API is new and
has not been runtime or browser validated under the current project policy.

Grid definitions may include `costs: [{ cell: { x, y }, cost }]` to assign the
cost of entering a cell. Unlisted cells cost 1; costs must be between 1 and
1,000,000. `ctx.navigation.setCostsBatch(id, updates)` changes costs together,
and `getCost` reads the current value. Setting a cost to 1 removes its override.
Pathfinding minimizes the sum of entered-cell costs, and snapshots include the
overrides. Weighted routing remains unverified at runtime.

### Development-stage rope particles

`ctx.ropes.create({ id, points, mass, autoStep: true })` creates a CPU particle
rope that advances once after each physics phase, before `postPhysics` systems.
Set anchors, forces and sampled colliders in `prePhysics`; read positions in
`postPhysics`. Without `autoStep`, the rope remains manually stepped with
`ctx.ropes.step(id)`; calling `step` for an automatic rope returns
`TC_ROPE_AUTO_STEP` instead of advancing twice. An automatic rope created during
`prePhysics` advances in that tick. The first particle is pinned by default;
`anchors: []` creates a free rope. `setAnchor`, `releaseAnchor`, `applyForce`
(next tick only), `applyImpulse`, `inspect`, and `destroy` manage it.

`setColliders` accepts sampled planes and spheres; contacts affect only rope
particles, not rigid bodies. Host snapshots include the rope definition, mode
and state. If advancing an automatic rope fails, the engine attempts to restore
all earlier automatic ropes from that phase; the host tick may still have other
partial changes and must be recovered from a known-good checkpoint. The source
checkout includes `examples/rope-particles`.

New ropes resolve discrete sphere overlaps along segment interiors as well as at
particles. Corrections are distributed to movable endpoints; a segment with two
fixed anchors cannot move. `ctx.ropes.inspect(id).segmentContacts` reports the
segment index, closest-point fraction and reaction impulses. Set
`segmentCollisions: false` to retain particle-only behavior. Historical rope
solver snapshots without this field retain particle-only behavior when migrated;
`inspect(id).segmentCollisions` reports the active mode. Normal Host snapshot
engine-version restrictions still apply. Plane contacts use particle endpoints.
The segment index names its first particle; `fraction` runs toward the next.
Work increases with segment, sphere, substep and iteration counts. This does not
provide continuous collision detection; the segment solver and snapshot migration
have not been runtime validated.

New ropes also resolve discrete self-contact between non-adjacent segments using
sweep-and-prune and endpoint projection. `inspect(id).selfContacts` reports
segment indices, closest-point fractions and maximum overlap; `selfCollisions`
reports the active mode. Set `selfCollisions: false` to disable it. Adjacent
segments and collisions between separate ropes are not handled. Immovable anchored
endpoints stay fixed, and contacts introduced by corrections can wait until the
next iteration. Dense overlap can approach quadratic work. Snapshots from before
this feature retain the disabled mode when migrated; invalid or duplicate self
contacts are rejected atomically; Host engine-version rules still apply. This is unverified discrete contact, not a guarantee against
penetration, continuous collision, friction or full rope physics. The source
checkout includes `examples/rope-self`.

For optional visual presentation, declare a material in `defineGame({ materials:
[...] })` and create the rope with `visual: { material: "your-material-id" }`.
The renderer draws capped cylindrical instances between consecutive simulated
particles and updates their transforms as the rope moves. `radius` defaults to
the particle collision radius (or 0.025); `radialSegments` defaults to 8 and
accepts 3–32. `castShadow` and `receiveShadow` default to true. A collapsed
zero-length segment has no visible surface. `ctx.ropes.visuals()` returns
detached descriptions, not renderer objects. Visual configuration is included
in the rope snapshot and is disposed with the owning content.

This is segmented geometry with overlapping caps, not a continuous deformable
tube. Large ropes may be expensive. Raster, ray-traced modes, GPU resource
lifecycle and snapshot restoration have not been runtime validated.

To bind a rope to existing dynamic sphere bodies, create it with `autoStep: true`
and `bodyColliders: [{ id: "rope-collider-id", entity: "body-id" }]`. After the
rigid-body physics phase, the host samples each bound sphere's actual collider
center, radius, velocity and effective inverse mass/inertia, then steps the rope
and applies the resulting normal contact impulse to the body. At detected overlaps,
particle and virtual body corrections share effective mass and address closing
normal velocity; contacts are not predicted before overlap.
The actual body's displacement responds on the next body step. Bindings require live dynamic non-trigger spheres and unique
collider ids and body entities within each rope. Do not use a bound collider id
in `setColliders`; its manual planes and spheres remain separate. A destroyed body
is unbound at the next automatic step, and a new entity with the same id is not
implicitly rebound. Bindings are saved with Host snapshots.

Do not manually apply the same contact's reaction when using a body binding: the
host already applies it. A native failure can still leave the host tick partially
changed, so restore a known-good checkpoint. This is an approximate split-step
solver: virtual positions use a first-order update and the real body moves on its
next step. Ropes are processed sequentially, without globally coupled substeps;
friction, restitution and continuous collision are not included. Penetration
correction can inject energy; stability, conservation, runtime and snapshot
compatibility have not been validated.

For each latest-tick contact, `reactionImpulse` and `reactionAngularImpulse`
report the opposite impulse produced by the particle's contact response,
and its moment about the world origin. These optional fields are absent when
restoring older contact snapshots. Contacts from unbound manual colliders do not
automatically act on a rigid body.
For an explicitly mapped dynamic body, game code can read its actual world center
of mass via `ctx.physics.centerOfMass(id)`, apply the linear impulse, and apply
`reactionAngularImpulse - centerOfMass × reactionImpulse` as torque impulse.
For manual coupling, include both `contacts` and `segmentContacts` and apply each
contact at most once for its `tick`; repeated `inspect` calls return the same contacts. The source checkout's `examples/rope-reaction` uses the
automatic binding instead.

This sampled, manually applied reaction is delayed and uses positional correction,
not a coupled contact solver: it omits body velocity/effective mass, friction and
continuous collision. Applying the linear and angular impulses uses separate
operations and is not transactional if a tick fails; recover from a known-good
checkpoint. It must not be represented as complete two-way rigid-body interaction.

This is an unverified development-stage increment, not complete rope physics:
the optional segmented visual does not provide a continuous deformable rope mesh,
general rigid-body coupling, continuous collision, cross-rope collision, or tearing. Plane normals must be unit length; `offset` is the signed
normal distance from the origin. Host intervals must be between 1/1000 and
1/30 seconds inclusive.

### Development-stage CPU fluid

Use `ctx.fluid.create({ id, autoStep: true, visual: { material: "material-id" } })` for the bounded CPU WCSPH development service. It supports fixed-step integration, inspection, snapshots, explicit particle impulses, and optional instanced particle presentation. It is not a full fluid-world system: GPU solving, surface/volume collisions, fluid-rigid reaction, spray, viscosity calibration, stability and performance are not verified. The source checkout includes `examples/fluid-basin`.

The optional `visual.radius` overrides the rendered particle radius without changing the solver's collision radius. When omitted, each particle's solver radius is used. This presentation remains unverified at runtime.

Fluid and soft-body definitions accept `origin: [x, y, z]` to translate the
reference particles and their fixed container into world space. Components must
be finite and in `[-100, 100]`. The default is `[0, 0, 0]`; an explicitly
configured `bodyPosition` and bound rigid bodies remain in world coordinates.
This positions the bounded reference simulation, not a general fluid volume or
arbitrary soft-body mesh. Runtime and snapshot behavior remain unverified.

Manual fluid and soft-body `step` calls attempt to restore the pre-call solver snapshot if stepping fails. If restoration also fails, the diagnostic reports `partialState=true`; a host-level checkpoint may still be needed for other systems. This rollback path has not been runtime-validated.

### Development-stage tetrahedral soft body

Use `ctx.softBodies.create({ id, autoStep: true, visual: { material: "material-id" } })` for the bounded CPU tetrahedral soft-body service. The built-in reference scene provides a small deformable solid with fixed-step scheduling, inspection, snapshots, particle impulses and dynamic surface presentation. Use `ctx.softBodies.step` for manual stepping, and `inspect`, `visuals` or `destroy` for lifecycle management. This service does not provide complete soft-body physics, cloth materials, tearing, continuous collision, GPU solving or rigid-body coupling; runtime, stability, performance, rendering and snapshot compatibility remain unverified.

An automatic soft body can bind one live dynamic sphere with `bodyColliders: [{ id: "sphere-id", entity: "body-id" }]`. The sphere is sampled after physics before each soft-body step. Set `bodyReactions: true` to submit approximate contact impulses back through the physics bridge; this is delayed and projection-derived, not complete mass-coupled rigid-body simulation. Destroyed bindings fail the owning step rather than silently becoming a different collider.

Fluid and soft-body bindings retain an entity-generation handle. Destroying a bound entity invalidates the binding even if another entity later uses the same ID; destroy and recreate the simulation to bind the replacement. A snapshot with a stale binding is rejected, and restore requires a matching dynamic sphere in both world and physics state. These lifecycle paths are not runtime-validated.

Soft-body surface UVs use the initial particle positions and remain fixed as the body deforms; they are not recalculated from the current pose.

For bound fluid and soft-body simulations, the reference solvers sample the sphere's center, linear velocity and collider radius after each physics step. During the simulation step the sampled sphere is treated as a fixed-position obstacle: it is not advanced by reference-scene gravity or clamped to the reference container. Optional reactions are projection-derived and applied at the rigid body's center of mass without contact torque; this is not mass- or inertia-coupled contact, and sampled velocity does not provide velocity-dependent friction. Contact counters are cumulative, and this approximate behavior has not been runtime-validated.

### Development-stage triangular cloth

Declare a material in `defineGame({ materials: [...] })`, then use
`ctx.cloth.create({ id, points, triangles, mass, autoStep: true, visual: {
material: "material-id" } })`. Triangles reference particle indices and shared
edges must be manifold with consistent winding. Anchors are explicit; no particles
are pinned by default. Automatic cloth advances after the physics phase;
manual cloth uses `ctx.cloth.step`. Use `setAnchor`, `releaseAnchor`, `applyForce`
(next tick), `applyImpulse`, `setColliders`, `inspect`, and `destroy` to manage it.
The source checkout includes `examples/cloth-sheet`.

An automatic cloth may bind a live dynamic sphere with `bodyColliders: [{ id: "sphere-id", entity: "body-id" }]`. The plugin samples the real sphere after physics and uses it as a one-way moving obstacle. Set `bodyReactions: true` to submit approximate normal reaction impulses from
particle and triangle-surface contacts through the physics bridge. This changes
body velocity on the next physics step; it is delayed, projection-derived and
not mass-coupled with cloth velocity. The body receives no reaction when the
option is omitted. Destroyed bodies are removed on the next automatic step.
This is not complete cloth-rigid-body coupling.

Sampled planes use the triangle centroid for discrete surface projection; this is not continuous triangle-plane collision.

New cloth also resolves detected sphere overlaps against triangle surface interiors
using closest-point barycentric projection. `inspect(id).surfaceContacts` reports
the triangle and barycentric position. `surfaceCollisions` defaults to true for new
cloth and can be disabled. This is sphere-only discrete surface contact; planes
remain particle-only, and there is no edge/face continuous collision or rigid-body
reaction. Surface contact state is included in snapshots and invalid state is
rejected atomically. It has not been runtime or stability validated.

New cloth also resolves discrete self-contact between non-adjacent particles by
projecting movable particles apart; shared triangle edges are excluded.
`selfCollisions` defaults to true for new cloth and is reported by
`ctx.cloth.inspect(id)`. Set it to false for particle-only cloth. Self-contact
state is included in snapshots. This is particle self-contact, not triangle
interior/edge collision, continuous collision, friction or a guarantee against
penetration. It has not been runtime or stability validated.

The CPU solver uses edge distance constraints and an optional distance-based
bending approximation (`bending: true` by default). Sampled planes and spheres
only move cloth particles; they do not receive reactions. Contacts do not cover
triangle interiors or edges. There is no self-contact, cloth–rope interaction,
rigid-body coupling, tearing, friction or continuous collision. The optional
visual deforms the actual triangle mesh; UVs may be provided per particle or use a
planar projection. Use a double-sided material when both sides must be visible.
Collapsed or unrepresentable triangles return `TC_CLOTH_VISUAL_DEGENERATE` rather
than being silently replaced. Runtime, GPU, performance, stability and snapshot
compatibility have not been validated; this is not complete cloth physics.

Keyboard bindings use the browser's `KeyboardEvent.key` values, not physical
`KeyboardEvent.code` values. For example, use `input: { up: ["w", "W", "ArrowUp"],
restart: ["r", "R"] }`, not `"KeyW"` or `"KeyR"`. Letter case depends on the
actual keyboard event; Space is `" "`. Actions are read inside systems through
`ctx.input.held`, `pressed`, `released`, or `axis`. A mocked system test does not
establish browser bindings; real input requires separate verification when permitted.

## Work Loop

1. Inspect `pelican.project.json`, `game.ts`, asset declarations and the public API.
2. Make small game-only edits. Keep the exact engine version lock.
3. Follow the active project policy for running the game or checking gameplay.
4. Use `inspect`, `input`, `step`, `pause`, `resume`, `snapshot`, `restore`,
  `record`, `replay`, `status`, `cancel` and `reset-session` against the dev port
   when verification is permitted.
5. When verification is permitted, use capture and inspect results; preserve
   explicit failures rather than claiming success.
6. Run `build` and serve `dist/` over HTTP(S). Keep notices and license files.

The current engine project decision permits compilation and builds only, not
tests, browser/GPU runs, smoke or other validation. Historical instructions and
reports do not authorize those activities or establish that they passed for the
current source.

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
