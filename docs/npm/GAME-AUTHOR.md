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

`ctx.physics.overlapSphere(center, radius, options)` finds live physics entities
overlapping a world-space sphere. Results are sorted entity IDs; triggers are
excluded unless `includeTriggers: true` is specified. This query uses the current
physics query state and has not been runtime-validated.
Newly created physics entities enter the query state at the physics phase;
destroyed entities are filtered from results before that synchronization.
`ctx.physics.overlapBox(center, halfExtents, rotation, options)` uses the same
filters for an oriented box; `rotation` is an optional XYZ Euler vector in
radians. The box query is also runtime-unverified.
`ctx.physics.overlapCapsule(center, halfHeight, radius, rotation, options)` uses
the same filters with a local-Y capsule; half-height excludes its rounded ends.
It has not been runtime-validated.

Models using `KHR_animation_pointer` animation channels are currently rejected
with `TC_MODEL_EXTENSION_UNSUPPORTED`; pointer-driven material animation is not
implemented. A merely declared optional extension without such a channel does
not cause this runtime rejection.

Set `environment.backgroundTexture` to a declared texture asset to display an
equirectangular panorama. `backgroundRotation` sets its horizontal angle in radians
and `backgroundIntensity` controls its brightness. It replaces the visible background
color but does not provide environment lighting. PNG and JPEG follow the texture asset's color-space
setting. Raster, path, hybrid and device-recovery behavior are not runtime-validated.

Set `environment.lightingTexture` to a declared equirectangular texture asset
for image-based lighting. `lightingRotation` sets its horizontal rotation in
radians and `lightingIntensity` scales the lighting. This option cannot be
combined with the `lighting` preset. Background and lighting textures are
independent; use the same asset for both when desired. Radiance RGBE `.hdr`
textures are loaded as linear float data; PNG/JPEG remain supported. RGBE import,
rendering, use in controlled compute and device recovery have not been runtime-validated.
HDR textures require float32 linear filtering on the selected backend. If it is
unavailable, loading reports `TC_HDR_FILTER_UNAVAILABLE` instead of silently
switching to nearest filtering. This check applies to HDR assets directly referenced
by the scene background, environment lighting, materials or postprocessing graphs;
an otherwise unused HDR asset does not require the filtering capability.

GLB `KHR_materials_unlit` materials use their base color and texture without
lighting; they do not emit light into the scene. Import, optimization and
raster/path/hybrid behavior for this addition have not been runtime-validated.
Ambient occlusion maps on other unlit materials are not supported by the tracer.

Embedded GLB `KHR_lights_punctual` directional, point and spot lights are
imported with their node transforms. Set `model.embeddedLights: false` to disable
them or `model.embeddedLightShadows: true` to enable their shadows; defaults are
true and false respectively. Their import, optimization and rendering are not
runtime-validated under the current build-only policy.

Scene lights support `kind: "spot"` with a world-space `target`, cone half-angle
in radians (`angle`) and edge softness (`penumbra`, 0 to 1). Point and spot
lights accept a cutoff `distance` (0 means unlimited) and a `decay` exponent
(default 2). Keep the target distinct from the light position. Raster, path and
hybrid behavior has not been runtime-validated.
Direct light tracing respects light and mesh `castShadow` and mesh
`receiveShadow` settings. Indirect rays still interact with visible geometry;
this distinction and cross-mode shadow behavior have not been runtime-validated.
Static definitions support constants such as `Math.PI` and the pure functions
`Math.abs`, `acos`, `asin`, `atan`, `atan2`, `ceil`, `cos`, `floor`, `pow`,
`round`, `sin`, `sqrt` and `tan` with finite static numeric arguments. Other
function calls are not evaluated when compiling scene declarations.

```ts
{ id: "lamp", transform: { position: [2, 4, 3] },
  light: { kind: "spot", target: [0, 0, 0], intensity: 40,
    angle: Math.PI / 4, penumbra: 0.25, castShadow: true } }
```

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
and UV-set override. Material slots, including specular textures, support UV0
and UV1. Specular UV1 and texture transforms are not runtime-validated.
Imported opaque GLB materials support `KHR_materials_specular` intensity and
color textures with `TEXCOORD_0` or `TEXCOORD_1`. Positive transmission combined with specular
textures or non-default specular remains unsupported. The tracer rejects PNG
color maps with ICC profiles. Low-bit-depth grayscale and indexed Adam7 PNGs
are decoded with explicit pass/filter validation. For 16-bit PNG,
supported color chunks are gAMA 45455 or 100000, standard sRGB cHRM, sRGB
intent 0, and cICP [1,13,0,1]; other values are diagnosed. The tracer currently
reduces 16-bit PNG samples to 8-bit RGBA, so it does not retain their full
precision. Use supported PNG or JPEG and retain diagnostics rather than silently
changing material semantics.

Use `ctx.animation.play(entity, clip, { startAt: seconds, speed, loop, fade })`
to begin a model clip at a local time within its duration. Negative playback
speed starts at the clip end when `startAt` is omitted; positive speed defaults
to the beginning. `ctx.animation.clips(entity)` lists available clip names and
durations. Use `pause(entity)` and `resume(entity)` to suspend or continue all
of a model's active clips and cross-fades, `seek(entity, seconds)` to move the
current clip, and `setSpeed(entity, speed)` to change its speed. A paused model
stays paused when `play` starts a new clip; call `resume` to continue. Seek and
speed control require a current clip; seek does not resume a finished clip.
Snapshots retain suspension, and older snapshots without it resume normally.
Clip timing, fades, controls and snapshot restoration remain unverified at
runtime under the current build-only policy.

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

### Localized text

Register game-authored dictionaries with `ctx.i18n`, choose an active locale,
and optionally choose one explicitly registered fallback:

```ts
ctx.i18n.define("en-US", { greeting: "Hello, {name}!", items: { one: "{count} item", other: "{count} items" } });
ctx.i18n.define("zh-CN", { greeting: "你好，{name}！", items: { other: "{count} 件物品" } });
ctx.i18n.setFallback("en-US");
ctx.i18n.setLocale("zh-CN");
ctx.ui.setText("label", ctx.i18n.text("greeting", { name: "鹈鹕" }));
```

`text` searches the active catalog and then the configured fallback; missing
keys or variables return stable diagnostics rather than a silent placeholder.
Variables may be strings, finite numbers or booleans; use `{{` and `}}` for
literal braces. Plural messages require a numeric `count` and use the matched
catalog locale's `Intl.PluralRules`; `other` is required. `number(value)` uses
the active locale's `Intl.NumberFormat`. If the player's Intl implementation
cannot provide a requested capability, the service reports it explicitly.
`inspect` lists registered locales; `setLocale(null)` clears the active locale,
and `setFallback(null)` clears fallback. A catalog in use cannot be removed.
Locale definitions and selection are included in snapshots.

This is a basic dictionary/placeholder/plural service, not automatic
translation, full ICU message syntax, date formatting or automatic UI binding:
game systems update UI text after language changes. Up to 32 catalogs and
4096 keys per catalog are supported, with total text and message limits. Runtime
formatting, font coverage, browser IME and snapshot behavior have not been
validated. See `examples/localization` for language switching.

### Branching dialogue

Define a graph of text nodes and start a named session. A node either has a
linear `next` or choices; an omitted or null successor completes the session
when advanced or chosen:

```ts
ctx.dialogue.define({ id: "guide", start: "hello", nodes: [
  { id: "hello", speaker: "Guide", text: "Can you help?", choices: [
    { id: "yes", text: "Yes", next: "thanks" },
    { id: "no", text: "Not now" },
  ] },
  { id: "thanks", speaker: "Guide", text: "Thank you." },
] });
ctx.dialogue.start("talk", "guide");
const session = ctx.dialogue.inspect("talk");
// Game UI displays session.node; selecting Yes calls ctx.dialogue.choose("talk", "yes").
```

Use `advance` for a node without choices, `choose` for a listed choice,
`cancel` to end an active session, and `close` to remove any session. A session
must be closed before reusing its ID or undefining its dialogue. Graph edges
must reference defined nodes; loops are allowed. The game decides which choices
to display and applies quest, inventory and other consequences itself; those
operations are not a shared transaction. `inspect` and `list` return detached
state. Definitions and session progress are included in host snapshots; older
snapshots have an empty dialogue service.

The service permits 512 dialogue definitions, 256 nodes per graph, 16 choices
per node and 128 concurrent sessions, with additional total node, choice and
text budgets. This is a basic branching text-state system, not a dialogue
editor, voice/lip-sync, localization system or automatic condition/reward
engine. Runtime behavior and snapshot restoration have not been validated.
`examples/dialogue` connects a conversation to a quest through game code.

### Quest objectives

`ctx.quests` tracks game-defined objectives and prerequisites. The game
chooses which events advance an objective; no particular combat, collection or
dialogue rules are imposed:

```ts
ctx.quests.define({ id: "gather", title: "Gather supplies", objectives: [
  { id: "herbs", label: "Collect herbs", target: 3 },
] });
ctx.quests.start("gather");
ctx.quests.advance("gather", "herbs", 1);
const quest = ctx.quests.inspect("gather");
```

Objectives accept positive integer increments and clamp at their target.
`advanceBatch` applies distinct objective updates together or leaves progress
unchanged on an invalid update. Quests complete automatically by default once
all objectives reach their targets; set `autoComplete: false` and call
`complete` for an explicit completion step. `fail` changes an active quest to
failed, and `reset` explicitly clears progress and returns it to inactive.
`inspect` and `list` return detached state. Prerequisites are checked at start;
forward references are allowed, but missing, incomplete or cyclic dependencies
cannot start. Resetting a prerequisite later does not cancel an already-started
quest.

Up to 1024 quests, 64 objectives per quest and 16 prerequisites per quest are
supported. Definitions, status and progress are saved in host snapshots; older
snapshots start with no quests. The game must grant rewards and update UI itself;
quest and inventory operations are not a shared transaction. This is a basic
objective tracker, not dialogue graphs, quest scripting, automatic gameplay
event matching or a complete journal. Runtime behavior and snapshot restoration
have not been validated. `examples/quests` shows manual progress and a reward.

### Inventory and item stacks

`ctx.inventory` supplies bounded, game-defined item containers without exposing
engine internals. Define an item once, create a container with an explicit owner
label, then add or transfer complete amounts:

```ts
ctx.inventory.defineItem({ id: "potion", label: "Potion", maxStack: 5, tags: ["consumable"] });
ctx.inventory.create({ id: "backpack", owner: "player", capacity: 12 });
ctx.inventory.add("backpack", "potion", 3);
const bag = ctx.inventory.inspect("backpack"); // detached slots, each a stack or null
```

`add` fills existing stacks first, then empty slots; `remove` consumes in slot
order. `transfer(from, to, item, count)` moves the requested amount atomically,
and `moveSlot(id, from, to, count?)` splits, merges or swaps stacks within a
container. Capacity, insufficient quantity and invalid slot errors leave the
involved containers unchanged. `count`, `getItem` and `listItems` read state;
`destroy` discards a container and its contents, and `destroyOwner` discards
all containers with that explicit label. Owners do not track entity lifetime.
An item definition cannot be removed while any container holds it.

The service supports up to 4096 item definitions, 512 containers, 256 slots
per container and 65536 slots overall; each stack holds at most 1,000,000 of an
item. Definitions, slots and owners are included in host snapshots; older
snapshots have an empty inventory service. This is a basic stack/container
module, not equipment slots, item instances with durability/metadata, crafting,
loot, weight or a ready-made inventory UI. Behavior and snapshot restoration
have not been runtime-validated. The source example `examples/inventory`
shows a backpack and chest.

### Dynamic game UI

Declare persistent controls in `game.ui` and use `ctx.ui.create` for dynamic
text, bars, buttons or inputs. `create` accepts the same element definition
fields as `game.ui` and returns a generation number. Use `ctx.ui.get(id)` to
read detached state, `ctx.ui.setLayout(id, { x, y, width, color, anchor })` to
change layout atomically, and `ctx.ui.remove(id)` to remove a dynamic control.
Authored controls cannot be removed; use `setVisible` instead. Up to 512
dynamic elements may exist at once. Dynamic world labels must refer to a live
entity when created. Center-anchored and world-space controls use x/y as pixel
offsets. UI state, layout, generation counters and dynamic elements are saved
in host snapshots; old snapshots without dynamic elements remain accepted.

Dynamic `ui.text`, `ui.submit` and `ui.activate` event payloads include the
control's `generation`. A removed and recreated ID gets a new generation;
ignore an event whose generation no longer matches the current control. The
engine ignores stale dynamic text updates, but gameplay code must filter submit
and activation events itself. Static controls keep their existing payload
shapes. See `examples/dynamic-ui` for a small reusable-slot menu. This is a
basic runtime UI increment, not a full layout, localization or accessibility
system; rendering, input and snapshot behavior have not been runtime-validated.

### Static world chunk residency

`ctx.streaming` can materialize predefined static prefab entities around a
world-space focus. Define each chunk once, then update the focus in a game
system; transitions occur at the update phase's structural commit boundary:

```ts
ctx.streaming.configure({ chunkSize: 32, loadRadius: 1, unloadRadius: 2, maxChangesPerTick: 4 });
ctx.streaming.defineChunk({
  x: 0, z: 0,
  entities: [{ id: "tree-0", prefab: "tree", transform: { position: [2, 0, 3] } }],
});
ctx.streaming.setFocus(ctx.entities.getTransform("player").position);
```

Chunk coordinates use floor(position / chunkSize) on X/Z; entity transforms are
absolute world coordinates, not offsets from the chunk. `defineChunk` requires
unique entity IDs and declared prefabs. Only root entities without characters
or moving rigid bodies are accepted. A fixed body is allowed. Each chunk may
hold at most 512 entities; the service permits up to 4096 chunks and 65536
entities in total. `inspect()` reports residency, and `setFocus(null)` freezes
residency changes. Load/unload uses Chebyshev distance and hysteresis; a bounded
number of chunks change per fixed tick. Load/unload is not immediate.

Use `ctx.streaming.addEntity(x, z, { id, prefab, transform })` to build a root
in a defined chunk, or `ctx.streaming.removeEntity(x, z, id)` to remove one.
Inactive chunk edits update stored data immediately. Edits to an active chunk
are queued for a later update boundary, at most 64 entity edits per fixed tick;
up to 4096 can be queued. `getChunk(x, z)` returns detached committed entity
data and pending edit identifiers. Removing an entity whose addition is still
queued cancels that addition. A queued removal reserves its ID until applied.
Edits still proceed when focus is null; automatic residency changes do not.
Pending edits are included in host snapshots. The source example
`examples/streaming-world` uses B and X for building and removing a marker.

On unload, surviving roots retain their world transform and components; roots
already destroyed by the game stay destroyed. Reusing a live chunk-owned ID is
rejected, and attached child entities must be removed before unloading. Host
snapshots include chunk data and residency. Asset downloads/residency, dynamic
body velocities, animation playback, cross-system transactions, navigation
updates, terrain and precision rebasing are **not** streamed by this service.
Models and physics are recreated through existing systems; expect one or more
phase/tick boundaries before all systems reflect a change. If another system's
structural commands cause a failed tick, restore a known-good host checkpoint.
This implementation and its save/restore behavior have not been runtime-validated.

For orthogonal grid routing, game systems may call `ctx.navigation.createGrid`
with `{ id, owner, width, height }`, then `setBlocked(id, { x, y }, true)` and
`findPath(id, start, end)`. Paths contain both endpoints; `destroyGrid` and
`destroyOwner` release grids. The default 65,536-cell `searchCellBudget` limits
distinct cells considered per query; set it explicitly when needed. Budget
exhaustion returns `TC_NAVIGATION_CAPACITY`, not an unreachable result. Owners
are explicit strings, not entities. This is a development-stage grid service,
not continuous-world, flying or underwater navigation.

Pass `{ allowDiagonal: true }` as the fourth `findPath` argument to allow eight
movement directions. A diagonal cannot cross a corner if either adjacent
orthogonal cell is blocked. Orthogonal steps cost the entered cell's cost;
diagonal steps cost that amount multiplied by the square root of two. The
search uses an octile lower-bound heuristic and still enforces the same search
budget. This option changes only that search, not the grid or snapshot, and has
not been runtime-validated.

### Grid-following agents

A game can ask the engine to move a root entity without a rigid body or
character controller along a grid path:

```ts
ctx.navigation.createGrid({ id: "level", owner: "scene", width: 8, height: 8 });
ctx.navigation.createAgent({ id: "guard-nav", entity: "guard", grid: "level",
  origin: [-4, -4], cellSize: 1, speed: 2, allowDiagonal: true });
ctx.navigation.setAgentTarget("guard-nav", { x: 7, y: 7 });
```

The grid origin is the X/Z lower corner of cell (0,0); grid `y` maps to world
Z. An agent moves toward cell centers on fixed ticks and preserves its height.
`inspectAgent(id)` and `listAgents()` return detached status and path data;
statuses include planning, moving, arrived, blocked and missing. Grid obstacle
or cost updates queue a new search; at most eight agents replan per tick, in
round-robin order. An unreachable, blocked, out-of-grid or search-budget result
sets a stable error code. Update the grid or call `setAgentTarget` again to retry.
`stopAgent` clears the target, and `destroyAgent` releases the binding. Remove
agents before destroying their grid. A destroyed entity leaves a `missing`
agent: destroy and recreate the agent to bind a replacement with the same ID.

At most 128 agents are supported, with at most 65,536 cells per resulting path
and 64 traversed segments per agent per tick; excess per-tick travel is not
carried forward. Agent paths, queued replanning and targets are included in host
snapshots. Movement owns the root transform; do not simultaneously control that
transform from another system. This is point-agent grid movement, not a physics
character, collision response, crowd avoidance, flying, continuous-world
navigation or automatic geometry-to-obstacle synchronization. Runtime movement,
replanning and snapshot restoration are unverified. The repository example
`examples/navigation-agents` illustrates two agents and a changing obstacle.

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

### Rigid-body first-step limitation

Until the first physics step has completed, keep dynamic, kinematic and character bodies alive. The live physics path now conservatively rejects their removal with `TC_PHYSICS_FIRST_STEP_REMOVAL` rather than passing it to the native solver. Delay destruction until after the first completed physics step. This guard may reject otherwise valid operations; it is not a complete fix, does not protect historical snapshot replay, and has not been runtime-validated.

### Development-stage CPU fluid

Use `ctx.fluid.create({ id, autoStep: true, visual: { material: "material-id" } })` for the bounded CPU WCSPH development service. It supports fixed-step integration, inspection, snapshots, explicit particle impulses, and optional instanced particle presentation. It is not a full fluid-world system: GPU solving, surface/volume collisions, fluid-rigid reaction, spray, viscosity calibration, stability and performance are not verified. The source checkout includes `examples/fluid-basin`.

The optional `visual.radius` overrides the rendered particle radius without changing the solver's collision radius. When omitted, each particle's solver radius is used. This presentation remains unverified at runtime.

An optional `particleGrid: [width, height, depth]` chooses the initial fluid
lattice dimensions. Each dimension is an integer from 1 to 8, for at most 512
particles; the default is `[4, 4, 4]`. Particle spacing and solver parameters
remain those of the reference model. Its CPU neighbor search uses spatial buckets;
dense clusters can still approach quadratic work, so larger grids can be
substantially more expensive. Runtime, stability and
performance for configurable grids have not been validated.

Fluid and soft-body definitions accept `origin: [x, y, z]` to translate the
reference particles and their fixed container into world space. Components must
be finite and in `[-100, 100]`. The default is `[0, 0, 0]`; an explicitly
configured `bodyPosition` and bound rigid bodies remain in world coordinates.
This positions the bounded reference simulation, not a general fluid volume or
arbitrary soft-body mesh. Runtime and snapshot behavior remain unverified.

Set `container: { min: [x, y, z], max: [x, y, z] }` to change the axis-aligned
reference container relative to `origin`. Each coordinate must be in `[-100, 100]`
and each span must exceed 0.5 units. The default bounds remain `[-1.35, -1.05,
-1.1]` to `[1.35, 1.65, 1.1]`. These are reference-solver walls, not colliders
in the physics world; bound rigid bodies are not confined by them. This feature
and its snapshot behavior have not been runtime-validated.

Manual fluid and soft-body `step` calls attempt to restore the pre-call solver snapshot if stepping fails. If restoration also fails, the diagnostic reports `partialState=true`; a host-level checkpoint may still be needed for other systems. This rollback path has not been runtime-validated.

Use `ctx.fluid.setGravity(id, [0, -9.81, 0])` or `ctx.softBodies.setGravity(id, [0, 0, 0])` to change gravity for subsequent steps. Each component must be finite and in `[-100,100]`; `inspect(id).gravity` reports the current value and snapshots retain it. This behavior has not been runtime-validated.

`ctx.ropes.setGravity(id, gravity)` and `ctx.cloth.setGravity(id, gravity)` provide the same control for ropes and cloth; their component limit is `1e6`. Inspection and snapshots retain the current value. These changes are not runtime-validated.

`ctx.ropes.applyImpulses(id, [{ index, impulse }])` and `ctx.cloth.applyImpulses` update distinct particle velocities atomically; invalid indices, duplicate targets or anchors reject the batch. Runtime behavior remains unverified.
`ctx.ropes.setAnchors(id, [{ index, position }])` and `ctx.cloth.setAnchors` pin or move multiple points after checking the entire input; unspecified anchors remain unchanged. Runtime behavior is unverified.
Use `ctx.ropes.nearestParticle(id, position, maxDistance)` or `ctx.cloth.nearestParticle(...)` to find an indexed particle centre in world space; a miss returns `null`. This is a linear scan and has not been runtime-validated.

`ctx.fluid.applyImpulses(id, [{ particle, impulse }])` and `ctx.softBodies.applyImpulses` apply up to 512 distinct target impulses as a single operation. Fluid particle IDs come from `inspect(id).particles`; soft-body `inspect(id).particleIds` aligns with `positions`. Both inspection results expose a detached `velocities` array aligned with their particle order. Invalid batches are rejected before velocities change. This interaction and snapshot behavior remain runtime-unverified.

For a force rather than an instantaneous impulse, use `ctx.fluid.applyForce(id, particle, force)` or `ctx.softBodies.applyForce`. It accumulates for exactly the next fixed tick, across its substeps, and is included in snapshots until consumed. `applyForces` accepts up to 512 distinct particles atomically; each component and its accumulated value must remain in `[-100,100]` newtons. Runtime and restore behavior are unverified.

Use `ctx.fluid.nearestParticle(id, position, maxDistance)` or `ctx.softBodies.nearestParticle(...)` to locate a particle centre in world space before applying an impulse. A miss returns `null`; the search is a linear scan of the simulation's bounded particles. This behavior has not been runtime-validated.

### Development-stage tetrahedral soft body

Use `ctx.softBodies.create({ id, autoStep: true, visual: { material: "material-id" } })` for the bounded CPU tetrahedral soft-body service. The built-in reference scene provides a small deformable solid with fixed-step scheduling, inspection, snapshots, particle impulses and dynamic surface presentation. Use `ctx.softBodies.step` for manual stepping, and `inspect`, `visuals` or `destroy` for lifecycle management. This service does not provide complete soft-body physics, cloth materials, tearing, continuous collision, GPU solving or rigid-body coupling; runtime, stability, performance, rendering and snapshot compatibility remain unverified.

An automatic soft body can bind one live dynamic sphere with `bodyColliders: [{ id: "sphere-id", entity: "body-id" }]`. The sphere is sampled after physics before each soft-body step. Set `bodyReactions: true` to submit approximate contact impulses back through the physics bridge; this is delayed and projection-derived, not complete mass-coupled rigid-body simulation. Destroyed bindings fail the owning step rather than silently becoming a different collider.

Fluid and soft-body bindings retain an entity-generation handle. Destroying a bound entity invalidates the binding even if another entity later uses the same ID; destroy and recreate the simulation to bind the replacement. A snapshot with a stale binding is rejected, and restore requires a matching dynamic sphere in both world and physics state. These lifecycle paths are not runtime-validated.

Soft-body surface UVs use the initial particle positions and remain fixed as the body deforms; they are not recalculated from the current pose.

`softBodyGrid: [width, height, depth]` sets the reference solid's tetrahedral
lattice dimensions. Each dimension is an integer from 2 to 5; the default is
`[3, 3, 3]`. This adjusts the built-in lattice, not an arbitrary imported mesh.
Runtime behavior, stability, rendering and snapshot restoration are unverified.

For bound fluid and soft-body simulations, the reference solvers sample the sphere's center, linear velocity and collider radius after each physics step. During the simulation step the sampled sphere is treated as a fixed-position obstacle: it is not advanced by reference-scene gravity or clamped to the reference container. Optional reactions are projection-derived and applied at the rigid body's center of mass without contact torque; this is not mass- or inertia-coupled contact, and sampled velocity does not provide velocity-dependent friction. Contact counters are cumulative, and this approximate behavior has not been runtime-validated.

`ctx.fluid.setColliders(id, colliders)` and `ctx.softBodies.setColliders` replace up to 64 manual sphere, plane or axis-aligned box obstacles. A plane uses a unit `normal` and signed `offset`; its normal points toward the allowed half-space. A box uses world-space `center` and positive `halfExtents`. Colliders affect particles discretely when `contacts` is enabled, do not receive reaction forces, and do not move rigid bodies. Their IDs must be distinct from bound body collider IDs. Snapshots retain the colliders; behavior and restoration are not runtime-validated.

New snapshots retain the sampled collider radius for rollback and restoration; older snapshots without that field remain accepted and refresh the collider on the next automatic step. This compatibility and rollback behavior has not been runtime-validated.

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

Content and model teardown attempt to release remaining resources even when an
individual cleanup fails. Diagnostics such as `TC_CONTENT_CLEANUP`,
`TC_CONTENT_DISPOSE`, `TC_MODEL_DISPOSE` and `TC_MODEL_LOAD_CLEANUP` indicate
that cleanup was incomplete; inspect the error causes and restart the scene if
needed. A failure after a scene replacement has committed does not guarantee
that the old scene was restored. These failure and release paths have not been
runtime-validated and do not prove the absence of leaks.

### Build output recovery

`pelican build` stages a new output before replacing `dist`. If a prior `dist`
exists, it is preserved under `.pelican/dist-backup-*/dist` and returned as
`previousOutput` in the build report. A failed staging or switch can leave a
partial stage or backup; inspect the reported paths before retrying or removing
anything. Do not run concurrent processes that mutate `dist`: recovery and
concurrency checks are best effort and have not been runtime-validated.

### Explicit project lock migration

`pelican migrate` produces a read-only plan for the current project's exact
engine lock. It reports the selected engine version, existing lock, manifest
hash and limitations. In an installed project, for example:

```sh
npx --no-install pelican migrate
npx --no-install pelican migrate --apply --from 0.5.1
```

Replace `0.5.1` with the exact `from` value in the plan; use `unlocked` for a
manifest without a version lock. Applying changes only the relevant JSON lock
strings or adds an `engineVersion` lock, preserving other manifest bytes. It
writes a uniquely named backup beside `pelican.project.json` when a change is
needed and reports the backup filename, `backupSha256` and new
`currentSha256`. An optional UTF-8 BOM is preserved. Conflicting version
fields, a mismatched `engine.path`, symlinked manifest or concurrent detected
change are rejected. Stop editors and dev servers before applying: the
concurrency guard is best effort, not a cross-process transaction.

To restore a reported backup, call `pelican migrate --restore BACKUP_FILENAME
--expect-current CURRENT_HASH --expect-backup BACKUP_HASH`, replacing the
capitalized values with the filename and hashes from the apply report. Restore
backs up the current manifest first and refuses changed hashes. Keep these
recovery files until the game owner decides they are no longer needed.

**This only changes the project lock.** It does not update package dependencies,
rewrite game APIs, migrate saved games/replays or establish compatibility. The
new command and recovery path have not been runtime-validated. When validation
is authorized later, independently build and assess the migrated game. For
package integrity/dependency errors, reinstall one exact package version;
never work around a diagnostic by importing an internal dependency.
