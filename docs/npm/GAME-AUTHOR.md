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

`ctx.physics.setGravity([0, -9.81, 0])` changes gravity for the 3D rigid-body
world and wakes dynamic bodies; `ctx.physics.gravity()` returns the current
value. The change is recorded in physics history and restored with the host
snapshot. Character controllers use their own configured downward gravity;
2D physics, cloth, rope, fluids and soft bodies have separate gravity settings.
Gravity changes, wake behavior and snapshot replay remain unverified, and this
does not fix the known 3D first-step removal defect.
For an individual dynamic rigid body, `ctx.physics.setGravityScale("body", 0)`
disables world gravity on that body; negative values reverse its direction.
`gravityScale("body")` reads the multiplier. The supported range is
[-1000, 1000], and setting it wakes the body and records an operation in the
physics snapshot history. Fixed, kinematic and character bodies are rejected.
The value does not affect other simulation services. Behavior and snapshot
replay are unverified; existing history-replay risks remain open.

The 3D adapter now uses a private full Rapier build with a native
persistent-island bootstrap-order patch. It no longer rejects initial body
removal based on deletion order or requires waiting for a positive-time step.
Structural preflight still rejects inconsistent lifecycle identities, body types
and tick counts before candidate reconstruction. These checks do not authenticate
snapshots or prove arbitrary histories safe. Native first-step behavior, legacy
compatibility and failure recovery have not been runtime-validated for this build.

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

`ctx.physics.castShape({ shape: "sphere", radius: 0.25 }, start, displacement)`
sweeps a sphere through the current 3D physics query state. Box
`{ shape: "box", halfExtents: [x, y, z] }` and local-Y capsule
`{ shape: "capsule", halfHeight, radius }` are also supported. Optional XYZ
rotation and the same exclude/trigger filters follow the displacement argument.
The first hit returns its entity, travel fraction and distance, plus the hit
collider's world-space point and outward normal; a starting overlap reports
fraction zero. Use overlap queries for zero displacement. This query does not
move a body or resolve collisions and has not been runtime-validated.

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
For a live entity with a scene or prefab light, `ctx.lights.set("lamp", {
intensity: 4, color: [1, 0.5, 0.2], visible: true })` changes its runtime
appearance. Colors are linear RGB in [0,1]; directional and spot lights also
accept a world-space `target`. Patches merge with existing overrides, and
`ctx.lights.reset("lamp")` restores authored values. Overrides are saved in
snapshots and removed when the entity is destroyed; an entity with a reused ID
does not inherit them. Embedded model lights are not exposed by this API.
Raster, tracing, lifecycle and snapshot behavior remain unverified.
Direct light tracing respects light and mesh `castShadow` and mesh
`receiveShadow` settings. Indirect rays still interact with visible geometry;
this distinction and cross-mode shadow behavior have not been runtime-validated.

Use `ctx.render.setMaterialSurface("material-id", { color: [0.2, 0.5, 1],
roughness: 0.4, emissive: [0.1, 0.2, 0.5], emissiveIntensity: 2 })` to
update declared material channels at runtime. Colors use linear RGB in [0,1];
roughness and metalness use [0,1], and emissive intensity uses [0,65536].
Patches merge; `materialSurface(id)` returns current overrides and
`resetMaterialSurface(id)` restores authored values. A material graph owns its
declared channel and cannot be overridden this way: change its graph parameters
instead. Overrides affect every object sharing the material and are saved in
snapshots. Raster, path/hybrid capture and restoration remain unverified.
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

Use `ctx.animation.blend("actor", "walk", "run", 0.4)` to play two distinct
complete clips together, then `ctx.animation.setBlendWeight("actor", 0.7)` to
adjust the second clip's contribution without restarting. Both clips loop at
normal speed when blending starts. `pause` and `resume` affect both; `seek` and
`setSpeed` affect the first clip. Calling `play` exits blend mode, and blend
state is included in snapshots. This uses normal full-clip blending, not
automatic phase synchronization or root-motion correction. Animation and
snapshot behavior have not been runtime-validated.

Call `ctx.animation.synchronizeBlend("actor")` to align the second clip to
the first clip's normalized time without changing their weights or speeds.
Both clips must have positive finite durations. This is a one-time alignment;
clips with different durations or speeds drift again unless the game aligns
them as needed. Playback, phase continuity and snapshots are unverified.

Use `ctx.animation.bones("actor")` to discover uniquely named model bones.
An additive layer applies the selected clip's change relative to its reference
pose, on top of `play` or `blend`:

```ts
ctx.animation.play("actor", "walk");
ctx.animation.playAdditive("actor", "aim", "raise-arm", {
  bones: ["Spine"],
  includeChildren: true,
  weight: 0.7,
  referenceTime: 0,
});
ctx.animation.setAdditiveWeight("actor", "aim", 0.4);
const layers = ctx.animation.additiveLayers("actor");
ctx.animation.stopAdditive("actor", "aim");
```

Bone names must be unique in the model. Omit `bones` to use all bone transform
tracks; explicit masks include descendants by default. The layer is additive,
not an override: author the reference time as a suitable neutral pose. Each
model supports up to 16 named layers. `loop`, `speed` and `startAt` control
layer playback; `pause` and `resume` affect the entire model, while `seek` and
`setSpeed` change the base clip only. Playing a new base clip does not remove
layers. Snapshots retain layers and their playback state; older snapshots have
no layers. Additive layers alone do not provide retargeting, root-motion correction or a
complete animation state machine. Playback, interpolation, snapshots and
rendering have not been runtime-validated.

Use a CCD inverse-kinematics chain to aim an effector at a model-local target:

```ts
ctx.animation.setIK("actor", {
  id: "hand-reach",
  effector: "Hand",
  chain: ["Forearm", "UpperArm"],
  target: [0.4, 1.2, 0.3],
  iterations: 8,
  weight: 1,
});
ctx.animation.setIKTarget("actor", "hand-reach", [0.5, 1.1, 0.3]);
const chains = ctx.animation.ikChains("actor");
ctx.animation.removeIK("actor", "hand-reach");
```

Chain names are unique model bones ordered from the effector's immediate parent
upwards; all must belong to one skinned mesh. Targets use the loaded model
root's local coordinates. Up to 16 chains per model can be active, evaluated in
ID order after base and additive animation. `weight` blends the solved pose;
`iterations` controls CCD iterations and optional `maxAngle` limits each joint
update in radians. IK continues to apply while clip playback is paused; use
`removeIK` to remove its influence. Snapshots retain the definitions and targets.
This does not provide automatic ground contact, physical joint constraints,
retargeting, root motion or a full-body solver. IK, animation interaction,
snapshot restoration and rendered poses have not been runtime-validated.

Audio voices returned by `ctx.audio.play(soundId, options)` can be paused and
resumed with `ctx.audio.pause(voice)` and `ctx.audio.resume(voice)`. Both are
idempotent; a valid unknown voice is a no-op. Playback position follows fixed
simulation ticks, including while browser audio is locked. Paused time does not
advance the voice. Snapshots restore playback intent and logical position, not
the browser's internal audio processing state.

Use `ctx.audio.setVoiceVolume(voice, 0.5)` to change one voice without changing
its bus or master volume. `ctx.audio.voice(voice)` returns detached logical
state, including pause and routing, or `null` for an unknown or reclaimed voice.
An unknown valid ID is a no-op for `setVoiceVolume`; the gain must still be in
0–1. Voice state is included in snapshots. Browser playback, audio-device
locking and restoration are unverified; logical state is not proof of audibility.
Compiled WAV assets carry duration metadata for fixed-tick reclamation of
non-looping voices. For looping voices or legacy assets without duration,
`ctx.audio.play("sound", { loop: true, maxDuration: 10 })` limits active
playback to at most 10 fixed-clock seconds. The limit accepts positive seconds
up to 86400, excludes paused time, and is saved in snapshots. With no limit,
explicitly stop looping or unknown-duration voices when no longer needed.
Timing and restoration remain unverified.

Use `ctx.audio.setReverb({ wet: 0.25, decay: 1.5, preDelay: 0.02 })` to add
global convolution reverb after the master mix. `wet` is between 0 and 1,
`decay` is 0.1 to 4 seconds, and `preDelay` is 0 to 0.2 seconds. Set wet to 0
to bypass it. This uses a generated impulse response, affects all buses and is
not a room/occlusion model. Changes may interrupt the reverb tail. Settings are
saved in snapshots, but Web Audio processing state is not. Node or buffer
creation failures emit `TC_AUDIO_REVERB` and fall back to dry audio; change the
settings or restart the scene to retry. Audio behavior is runtime-unverified.

For a spatial voice, `ctx.audio.play("sound", { entity: "source", occlusion: true })`
enables basic direct-path occlusion using the 3D physics world. It requires a
live entity and the 3D physics service. Each simulation tick the renderer casts
between the listener and source, excluding the source, the followed camera
entity and triggers. A blocking collider reduces gain and applies a low-pass
filter; a missing source or failed query mutes the voice and reports a
diagnostic. This is not diffraction, reverb or full acoustic simulation.
Configuration is saved in snapshots; audio output and restoration have not
been runtime-validated.

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

### Gamepad input

Gameplay can use the first connected standard-mapped gamepad without receiving
browser or native gamepad objects. UI navigation owns the gamepad by default;
call `ctx.input.setGamepadMode("game")` to route it to gameplay, and switch back
to `"ui"` for menu navigation. Re-entering UI mode suppresses already-held
navigation edges until a fresh press. A focused text input, IME composition,
background page or window blur suppresses gameplay gamepad input.

Declare digital bindings alongside keyboard keys, for example:

```ts
input: { jump: [" ", "gamepad:button:0"], left: ["ArrowLeft", "gamepad:axis:0:negative"] }
```

Buttons 0–31 and axes 0–7 are available through reserved keys
`gamepad:button:N` and `gamepad:axis:N:negative` / `positive`. Digital edges use
0.55 press and 0.45 release thresholds. `ctx.input.gamepad()` returns detached
availability, connection, browser index, analog axes and buttons; values are
quantized to 0.001. Axis deadzone defaults to 0.15 and can be changed with
`setGamepadDeadzone` in [0, 0.95]; changes apply with the next input sample.
Input samples enter the fixed-tick event
stream and state snapshots; runtime recording/replay behavior remains
unverified. Use `gamepad()` for analog movement and the regular action methods
for digital bindings. See the asset-free `examples/gamepad` or installed recipe.

This initial implementation selects one standard-mapped pad; nonstandard
mappings, multiple-player assignment, haptics and complete controller support
remain open. Browser availability, physical hardware, UI focus, disconnect,
recording and restoration have not been runtime-validated.

### 2D rigid bodies

Enable an independent XY physics world with `physics2d: { gravity: [0, -9.81] }`
on the scene. In a system that declares `Transform` reads, bind live root
entities to 2D bodies using `ctx.physics2d`:

```ts
ctx.physics2d.create({ id: "floor-body", entity: "floor", type: "fixed",
  collider: { shape: "box", halfExtents: [4, 0.25] } });
ctx.physics2d.create({ id: "hero-body", entity: "hero", type: "dynamic",
  collider: { shape: "circle", radius: 0.45 }, mass: 1 });
ctx.physics2d.applyImpulse("hero-body", [0, 5]);
```

Bodies may be fixed, dynamic or position-based kinematic; box and circle
colliders support offsets, friction, restitution and sensors; capsules use a
local-Y half-height plus radius. Fixed bodies may
also use a compound of up to 2048 boxes; an empty compound has no collider.
`setCollider` replaces a fixed body's collider and invalidates pending queries;
contact event continuity is not preserved. A native replacement failure reports
`partialState=true`; restore a known-good host checkpoint. Dynamic bodies
support linear/angular velocity, impulses and optional continuous collision
detection. Entity X/Y and Z-axis rotation are synchronized at the physics fixed
step; Z position is preserved. Kinematic movement is supplied by changing the
entity transform. Bodies require root entities with unit scale and no X/Y
rotation; an entity cannot simultaneously own a 3D rigid body or character.
Up to 512 bodies are supported. Destroy a body explicitly or remove its entity.

Collision and sensor events use `physics2d.collision.started/ended` and
`physics2d.trigger.started/ended` with body and entity IDs. Events after removal
or snapshot restore do not promise uninterrupted contact lifecycle. `raycast`
queries the last completed 2D physics step and requires another step after body
creation, removal or restore; pending transform edits are not reflected. Its
optional `exclude` list contains body IDs, and sensors are excluded unless
`includeSensors: true` is specified.

`ctx.physics2d.overlapCircle([0, 0], 2, { includeSensors: true })` and
`ctx.physics2d.overlapBox([0, 0], [1, 0.5], angle)` return sorted body IDs
for a circle or rotated box. They share the ray query's last-completed-step,
body exclusion and sensor rules. Native query failure requires restoring a
known-good checkpoint. Query results and recovery are runtime-unverified.

For one-way character movement, create a non-sensor kinematic body, attach a
controller, and submit world-space XY displacement for a later fixed step:

```ts
ctx.physics2d.attachCharacter("character-body", { offset: 0.01, snapToGround: 0.08 });
ctx.physics2d.moveCharacter("character-body", [horizontalDelta, verticalDelta]);
const state = ctx.physics2d.characterState("character-body");
```

`grounded` and `movement` describe the last computed movement; `deferred`
means query structures must first be refreshed by a normal physics step. Pending
requests accumulate while deferred. Creation/removal/collider replacement and
explicit transform teleports can cause this delay; no artificial time step is
used. The game supplies gravity and jump displacement explicitly, including a
small downward movement when using ground snapping. Sensors do not block the
controller, and dynamic obstacles are not pushed by it. Multiple moving
characters/platforms are not a fully coupled crowd or continuous solver.
`detachCharacter` removes the controller; body removal also removes it.
Character options and pending movement are stored in snapshots, but native
controller caches are rebuilt. Runtime, grounding and restore behavior are
unverified. See `examples/physics2d-character` or its installed recipe.

Create a 2D fixed, revolute, rope or spring joint between existing body IDs:

```ts
ctx.physics2d.createJoint({ id: "hinge", kind: "revolute", bodyA: "pivot-body", bodyB: "arm-body", anchorB: [0, 0.9] });
```

Anchors are body-local; connected-body contacts default to disabled. Use
`inspectJoint`, `listJoints` and `destroyJoint`; removing a body removes its
attached joints. Up to 512 joints are supported. Native operation failures
mark the 2D owner faulted: further operations are rejected until a known-good
host checkpoint is restored or the scene is restarted. A failed recovery may
itself leave partial state.

Snapshots save validated body and joint definitions, then reconstruct a new 2D
world; they do **not** use native snapshot deserialization. Solver warm-start
and contact caches, kinematic velocity and exact deterministic continuation are
not preserved. Joint limits/motors, full character/platform interaction,
automatic tilemap collider bindings, 2D/3D coupling and complete 2D physics are
not included. Runtime, collision, events, queries,
resource cleanup and restoration have not been validated; the known separate
3D first-step deletion issue remains open. See the asset-free
`examples/physics2d` or the corresponding installed recipe.

### Tile maps

`ctx.tilemaps` creates entity-bound tile grids using a declared textured
material. Cell values are zero-based atlas frame indices or `null` for empty;
indices and cells are row-major, left to right and top to bottom. The map lies
in the bound entity's local XY plane: `offset` is its top-left corner and rows
extend toward negative Y.

```ts
ctx.tilemaps.create({ id: "ground", entity: "map-root", material: "tiles",
  width: 10, height: 6, tileSize: [1, 1], offset: [-5, 3], columns: 2, rows: 2 });
ctx.tilemaps.setTiles("ground", [{ x: 0, y: 0, frame: 1 }, { x: 1, y: 0, frame: 2 }]);
```

The material must be declared with a texture; the entity must already be live.
`getTile` reads one cell, `setTile` changes one, and `setTiles` validates a
batch before applying it. `inspect` returns detached full map data. Presentation
uses 32×32 chunks and rebuilds changed chunks; `visuals`/`readChunk` expose
detached chunk information, whose tokens and revisions are presentation hints
rather than persistent identities. Destroying the entity invalidates its map;
a replacement with the same ID is not silently rebound. Host snapshots preserve
the map and cells.

Loop atlas frames for all cells using a tile with
`ctx.tilemaps.setAnimations("ground", [{ tile: 1, frames: [1, 2, 3], fps: 6 }])`.
Animations can also be supplied in `create`; replacing them restarts playback.
They advance on fixed simulation steps and their phases are saved in snapshots.
`getTile`, navigation and collision retain the original tile index, while
`readChunk` supplies the current visual frame. At most 256 animations and 256
frames per animation are supported; animated chunks are rebuilt when their
visible frame changes, which can be costly for large or fast-changing maps.

Maps are bounded to 512 per dimension, 65536 cells per map, 64 maps and 262144
cells overall; each update batch has at most 4096 distinct cells. Atlas
filtering may sample neighboring frames, so provide suitable padding.
`syncNavigation(id, grid, { blockedFrames, origin?, emptyBlocked? })` projects
the map's current frames into an existing navigation grid. It **overwrites all
blocked states in the mapped rectangle**: use a dedicated grid or an exclusively
controlled region. `setTilesAndSyncNavigation` updates specified cells and their
mapped navigation cells together, attempting rollback on failure; a rollback
failure reports `partialState=true` and requires a known-good host checkpoint.
The mapping is explicit, not a persistent binding: repeat a full synchronization
when using plain `setTiles` or changing the rules, and clean up the old grid
region when changing origin or removing a map. It maps indices only, not entity
transforms.

For explicit 2D tile collision, create a fixed `physics2d` body bound to the same
root entity, initially with `{ shape: "compound", parts: [] }`, then call
`ctx.tilemaps.syncPhysics2D("ground", "ground-body", { solidFrames: [2] })`.
The service merges adjacent solid cells into at most 2048 box parts and replaces
that body's collider; the body must not be shared with other collision content.
`setTilesAndSyncPhysics2D` stages tile edits and replaces the collider together.
The mapping is not persistent: plain tile edits require another explicit sync,
and deleting a map does not remove its body. Collider replacement loses contact
event continuity and ray queries require another physics step. If native
replacement reports `partialState=true`, restore a known-good host checkpoint.
To edit the map and synchronize both navigation and a fixed 2D collider in
one operation, use:

```ts
ctx.tilemaps.setTilesAndSyncWorld("ground", [{ x: 2, y: 1, frame: 2 }], {
  grid: "level", navigation: { blockedFrames: [2] },
  body: "ground-body", physics: { solidFrames: [2] },
});
```

This plans all changes first, overwrites the entire mapped navigation rectangle
and replaces the collider before committing tile cells. It does not install a
persistent binding: later plain tile edits still require synchronization. The
navigation grid and map transforms must be aligned by game code. Collider
replacement breaks contact-event continuity and ray queries update after the
next physics step. A native or post-replacement failure reports
`partialState=true`; even if navigation rollback was attempted, restore a
known-good host checkpoint. This is not a transactional rollback of native
physics history or already queued agent replans. Runtime behavior is unverified.

Automatic streaming and a visual editor are not included.
Rendering, collision, synchronization, rollback, snapshots, memory use and
perspective and orthographic tracing are unverified. A source checkout
includes `examples/tilemap` and its MIT demonstration texture; npm games
provide their own assets.

### Sprite atlases

Use a declared texture and material for an entity-bound sprite plane. Set
`transparent: true` on the material when the texture's alpha should blend; for
hard cutouts, use `alphaTest` instead. Material and texture remain shared, while
each sprite has its own plane and atlas frame:

```ts
const sheet = defineAsset({ id: "sheet", path: "assets/atlas.png", type: "texture", license: "MIT" });
const spriteMaterial = defineMaterial({ id: "sprite-material", texture: sheet, transparent: true });
// Register the asset and material in defineGame, and create a live "hero" entity.
ctx.sprites.create({ id: "hero-sprite", entity: "hero", material: "sprite-material",
  size: [2, 2], columns: 4, rows: 1,
  animation: { first: 0, last: 3, fps: 6, loop: true } });
```

Atlas frames are zero-based, left to right and top to bottom. `size` and
`offset` are in the bound entity's local XY plane. `play` restarts a current or
new animation; `pause`/`resume` preserve its fractional timing, and `setFrame`
selects a frame and pauses. Non-looping animation retains the last frame and
reports `completed`. `inspect` and `visuals` return detached data. The sprite
is removed when its entity handle becomes invalid; a replacement entity with
the same ID is not silently rebound. State is included in host snapshots.

Sprites use declared, lit materials; independent per-sprite tint, automatic
billboarding, 2D physics and asset generation are not included. Tile maps use
the separate `ctx.tilemaps` service.
Atlas filtering can sample neighboring frames, so authors should provide
suitable padding; transparent sprite ordering follows the renderer's material
sorting. Animation advances on fixed ticks, so frame rates above the tick rate
can skip frames. Up to 1024 sprites and 4096 atlas frames per sprite are
supported. Raster, transparency, animation, resource lifecycle, snapshots and
perspective and orthographic tracing have not been runtime-validated. A source checkout includes `examples/sprite-atlas` and its
MIT example texture. The npm package does not include that game asset; provide
your own texture there.

### Orthographic camera

For a code-driven camera pose or basic cutscene, call
`ctx.camera.setPose([0, 3, 8], [0, 1, 0])`, then
`ctx.camera.moveTo([4, 3, 6], [0, 1, 0], 2)` to interpolate position and
target over two fixed-tick seconds. A transition requires manual pose mode;
it replaces any prior transition and rejects paths that pass through the
target. `ctx.camera.follow(entity)` switches back to entity following, while
`ctx.camera.reset()` restores the scene-authored pose. Manual poses and active
transitions are stored in snapshots. This is not a timeline editor, collision
avoidance or a full cinematic system; rendering and restoration are unverified.

A scene can use an orthographic camera for 2D-positioned or 2.5D content:

```ts
camera: { position: [0, 0, 10], target: [0, 0, 0], projection: "orthographic", orthographicSize: 8 }
```

`orthographicSize` is the vertical visible span in world units; width follows the
render viewport aspect. Perspective remains the default. `fov` is only accepted
for perspective cameras; `orthographicSize` only for orthographic cameras.
On WebGPU, normal game scenes have development-stage orthographic hybrid and
path tracing. Each primary sample initializes its medium stack at the near plane
using the captured closed-shell hierarchy. Either consistent global winding is
accepted, including mirrored transforms. Shells using alpha filtering report
`TC_TRACE_ORTHOGRAPHIC_MEDIA_UNSUPPORTED`. The current catalog also requires
closed, non-intersecting or strictly nested volumes; camera samples near shell
boundaries or with ambiguous classification report `TC_TRACE_MEDIUM_STATE`.
There is no silent fallback. The historical M0 tracing sidecar remains
perspective-only, and WebGL2 remains raster-only. Medium classification, GPU
cost, camera rays, jitter, motion reprojection, clipping and hardware behavior
have not been runtime-validated. Perspective tracing also uses per-ray near-plane
classification when a conservative camera-near region meets a volume bound;
alpha-filtered volume shells in that case report `TC_TRACE_NEAR_MEDIA_UNSUPPORTED`.
The conservative region can trigger extra GPU work even when no ray crosses a
shell. The example `examples/orthographic-2d` and the installed recipe use simple 3D primitives
positioned on a plane; it does not itself demonstrate sprite animation or tile
maps. The camera is not 2D physics or a complete 2D engine. Rendering, WebGL2 fallback, world UI projection and input
have not been runtime-validated.

### Self-contained game recipes

`pelican create` defaults to the same minimal starter and current working
directory in the installed package and source checkout. Pass `--project` to
choose another directory; existing project files are never overwritten. The
historical `m2` template remains source-only because its sample assets are not
part of the npm package; it is not a cross-channel capability claim.

`docs/npm/RECIPES.md` contains complete asset-free `game.ts` recipes for
orthographic raster, 2D rigid bodies, gamepad input, UI, inventory, quests, dialogue, localization, navigation and static chunks. The `composed-gameplay` recipe combines inventory, equipment, a quest, gated dialogue, a manual camera and saves using the public API. Cross-service game operations are not automatically transactional; restore a known-good save if a later operation fails after an earlier one succeeded. All recipe behavior remains runtime-unverified.
The installed package includes this document, not the source checkout's
`examples/` directories. In a repository or ZIP those paths are editable
originals; the packaged recipes are generated from the same files at distribution
build time. Back up existing game work before replacing `game.ts` with a recipe.
These development-stage recipes have not been runtime-validated.

### Localized text

Register game-authored dictionaries with `ctx.i18n`, choose an active locale,
and optionally choose one explicitly registered fallback:

```ts
ctx.i18n.define("en-US", { greeting: "Hello, {name}!", items: { one: "{count} item", other: "{count} items" } });
ctx.i18n.define("zh-CN", { greeting: "你好，{name}！", items: { other: "{count} 件物品" } });
ctx.i18n.setFallback("en-US");
ctx.i18n.setLocale("zh-CN");
ctx.ui.bindText("label", "greeting", { name: "鹈鹕" });
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

`bindText` connects a text or button control to a key and fixed variables;
changing the locale changes its displayed text and `ui.get` result. Call it
again to update variables. `unbindText` retains the current resolved text;
`setText` replaces the binding. Bindings are saved with UI state and are
removed when a dynamic control is removed. Input fields cannot be bound, so
switching language does not overwrite player input. Missing keys or variables
after a locale change produce a `TC_UI_LOCALIZATION` diagnostic; use a
fallback catalog or `setText` to recover.

This is a basic dictionary/placeholder/plural service, not automatic
translation, full ICU message syntax or date formatting. Up to 32 catalogs and
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
    { id: "yes", text: "Yes", next: "thanks", when: { variable: "ready", equals: true } },
    { id: "no", text: "Not now" },
  ] },
  { id: "thanks", speaker: "Guide", text: "Thank you." },
] });
ctx.dialogue.start("talk", "guide");
ctx.dialogue.setVariable("talk", "ready", true);
const session = ctx.dialogue.inspect("talk");
// Game UI displays session.node; selecting Yes calls ctx.dialogue.choose("talk", "yes").
```

Use `advance` for a node without choices, `choose` for a listed choice,
`cancel` to end an active session, and `close` to remove any session. A session
must be closed before reusing its ID or undefining its dialogue. Graph edges
must reference defined nodes; loops are allowed. A choice's optional `when`
requires an existing session variable to equal its scalar value. `inspect`
includes an `enabled` flag for every choice; `choose` rejects disabled choices.
Use `setVariable(session, key, null)` to remove a variable. Up to 64 variables
per session are saved with progress; older snapshots start with none. If every
choice is disabled, update a variable or cancel the session. Game code maps
quest or inventory state into variables and applies consequences itself; those
operations are not a shared transaction. `inspect` and `list` return detached
state. Definitions and session progress are included in host snapshots; older
snapshots have an empty dialogue service.

The service permits 512 dialogue definitions, 256 nodes per graph, 16 choices
per node and 128 concurrent sessions, with additional total node, choice and
text budgets. This is a basic branching text-state system, not a dialogue
editor, voice/lip-sync, localization system or automatic quest/reward
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
An item definition cannot be removed while a container or equipment slot holds it.

```ts
ctx.inventory.defineItem({ id: "sword", tags: ["weapon"] });
ctx.inventory.add("backpack", "sword", 1);
ctx.inventory.createEquipment("gear", "player", [{ id: "hand", requiredTag: "weapon" }]);
ctx.inventory.equip("gear", "hand", "backpack", "sword");
ctx.inventory.unequip("gear", "hand", "backpack");
```

Equipment slots hold one item and can require a tag. The inventory and
equipment must share an owner. Equipping a replacement returns the previous
item to the inventory atomically; a full inventory leaves both unchanged.
`inspectEquipment` returns detached state, and `destroyEquipment` requires
empty slots. `destroyOwner` discards that owner's equipment and inventories.
Equipment state is saved in snapshots; older snapshots start with no equipment.

The service supports up to 4096 item definitions, 512 containers, 256 slots
per container and 65536 slots overall; each stack holds at most 1,000,000 of an
item. Definitions, slots and owners are included in host snapshots; older
snapshots have an empty inventory service. This is a basic stack/container
module, not item instances with durability/metadata, crafting,
loot, weight or a ready-made inventory UI. Behavior and snapshot restoration
have not been runtime-validated. The source example `examples/inventory`
shows a backpack and chest.

### Dynamic game UI

Input values are limited to 4096 UTF-16 code units. Authored and
`setText` values above that limit produce `TC_UI_VALUE`; browser input and
IME commits are constrained before `ui.text` or `ui.submit` is emitted. IME,
clipboard and browser behavior remain unverified under the build-only policy.

Buttons and inputs accept `enabled: false`, and game code can change this with
`ctx.ui.setEnabled(id, boolean)` without hiding the control. Disabled controls
cannot receive keyboard or gamepad focus, activation or text input; disabling
an input during composition discards its uncommitted composition. Set an
accessible name with `ariaLabel` or `ctx.ui.setAriaLabel(id, label)`; pass
`null` to clear it. Input and progress controls fall back to their ID, and
buttons without an explicit label use their visible text. These fields persist
in UI snapshots. Queued gameplay events should still be checked against the
current control state. Screen readers, IME and focus behavior are unverified.

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
basic runtime UI increment, not a full layout or accessibility
system; rendering, input and snapshot behavior have not been runtime-validated.

### Static world chunk residency

`ctx.streaming` can materialize predefined static prefab entities around a
world-space focus. Define each chunk once, then choose a fixed position or
follow a root entity; transitions occur at the update phase's structural commit boundary:

```ts
ctx.streaming.configure({ chunkSize: 32, loadRadius: 1, unloadRadius: 2, maxChangesPerTick: 4 });
ctx.streaming.defineChunk({
  x: 0, z: 0,
  entities: [{ id: "tree-0", prefab: "tree", transform: { position: [2, 0, 3] } }],
});
ctx.streaming.followFocus("player");
```

Chunk coordinates use floor(position / chunkSize) on X/Z; entity transforms are
absolute world coordinates, not offsets from the chunk. `defineChunk` requires
unique entity IDs and declared prefabs. Only root entities without characters
or moving rigid bodies are accepted. A fixed body is allowed. Each chunk may
hold at most 512 entities; the service permits up to 4096 chunks and 65536
entities in total. `inspect()` reports residency, and `setFocus(null)` freezes
residency changes. Load/unload uses Chebyshev distance and hysteresis; a bounded
number of chunks change per fixed tick. Load/unload is not immediate.
`followFocus` samples the root entity at each update. `inspect()` reports the
last focus, entity and `manual`, `following`, `invalid` or `missing` status.
If the entity is parented or leaves the supported coordinate range, residency
pauses until it becomes valid; if destroyed, it remains `missing` and does not
attach to a replacement ID. Call `followFocus` again to bind a replacement,
or `setFocus` to switch to manual mode. Following state is saved in snapshots.
Entity following, residency and restoration are not runtime-validated.

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

By default the grid origin is the X/Z corner of cell (0,0), grid `y` maps to
world Z, and increasing rows use the positive world axis. For 2D-positioned
entities, use `plane: "xy"`; `rowDirection: "negative"` matches tile maps whose
rows extend downward. An agent moves toward cell centers on fixed ticks and
preserves the coordinate perpendicular to its chosen plane. Its grid uses square
cells and axis-aligned world coordinates; rotated or nonuniform tile maps need
game-defined mapping.
`inspectAgent(id)` and `listAgents()` return detached status and path data;
statuses include planning, moving, arrived, blocked and missing. Grid obstacle
or cost updates queue a new search; at most eight agents replan per tick, in
round-robin order. An unreachable, blocked, out-of-grid or search-budget result
sets a stable error code. Update the grid or call `setAgentTarget` again to retry.
`stopAgent` clears the target, and `destroyAgent` releases the binding. Remove
agents before destroying their grid. A destroyed entity leaves a `missing`
agent: destroy and recreate the agent to bind a replacement with the same ID.

`ctx.navigation.followAgentTarget("guard-nav", "player")` follows a different
live root entity on the same grid. The target's position is sampled each fixed
tick and a new path is requested only when its cell changes. If it leaves the
grid or becomes parented, the agent blocks and retries when it returns. If the
target is destroyed, the binding is removed and an error is recorded; a new
entity with the same ID is not automatically followed. Use `stopAgent` or
`setAgentTarget` to replace the follow command. Follow state is included in
snapshots, but movement and restore behavior remain unverified.

Set `avoidAgents: true` on participating agents to reserve occupied and
next-route grid cells within each fixed tick. An agent whose next cell is
reserved enters `waiting` and retries on subsequent ticks; processing priority
rotates. Reservations apply only to opted-in agents with exactly the same grid,
origin, plane, row direction and cell size. After 30 waiting ticks at a cell
center, an agent attempts a new path around the current occupied cells, subject
to the shared eight-search-per-tick budget. A blocked destination or failed
search leaves it waiting and eligible to retry. Reservations do not prevent
crossings between cells, resolve existing overlaps or guarantee deadlock
resolution; agents in a one-cell corridor can still wait indefinitely. This is
not continuous crowd avoidance or physics collision. Waiting state and the
retry counter are saved; movement and restoration are unverified.

For game-driven alternate routes, `ctx.navigation.findPath("level", start,
end, { blocked: occupiedCells, allowDiagonal: true })` accepts up to 4096
additional blocked cells for that search. They do not change the grid or queue
agent replanning. Start or destination in the combined blocked set reports
`TC_NAVIGATION_BLOCKED`; diagonal corner rules also use the temporary cells.
Automatic agent rerouting uses occupied cells from its own matching group;
both mechanisms remain runtime-unverified.

At most 128 agents are supported, with at most 65,536 cells per resulting path
and 64 traversed segments per agent per tick; excess per-tick travel is not
carried forward. Agent paths, queued replanning and targets are included in host
snapshots. Movement owns the root transform; do not simultaneously control that
transform from another system. Agents reject entities bound to 2D or 3D
physics. This is point-agent grid movement, not a physics character, collision response, crowd avoidance, flying, continuous-world
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

`setColliders` accepts sampled planes, spheres and oriented boxes; contacts affect only rope
particles, not rigid bodies. Host snapshots include the rope definition, mode
and state. If advancing an automatic rope fails, the engine attempts to restore
all earlier automatic ropes from that phase; the host tick may still have other
partial changes and must be recovered from a known-good checkpoint. The source
checkout includes `examples/rope-particles`.

For example, `ctx.ropes.setColliders("rope", [{ kind: "box", id: "wall",
center: [0, 1, 0], halfExtents: [0.5, 1, 2], rotation: [0, 0, 0.4] }])` replaces the rope's manually
sampled obstacles with a world-space box. Rotation is optional XYZ Euler radians.
`ctx.cloth.setColliders` accepts the
same shape. Rope boxes resolve individual particles and, when enabled, segment
interiors; cloth boxes resolve particles and sampled triangle points when
`surfaceCollisions` is enabled. Contacts
are discrete and may tunnel during fast motion. Boxes are static
samples: update them explicitly when geometry moves; they do not update rigid
bodies or transfer reactions to them. The colliders are included in simulation
snapshots. Contact behavior and snapshot restoration have not been runtime-validated.

New ropes resolve discrete sphere and oriented-box overlaps along segment interiors as well as at
particles. Corrections are distributed to movable endpoints; a segment with two
fixed anchors cannot move. `ctx.ropes.inspect(id).segmentContacts` reports the
segment index, closest-point fraction and reaction impulses. Set
`segmentCollisions: false` to retain particle-only behavior. Historical rope
solver snapshots without this field retain particle-only behavior when migrated;
`inspect(id).segmentCollisions` reports the active mode. Normal Host snapshot
engine-version restrictions still apply. Plane contacts use particle endpoints.
The segment index names its first particle; `fraction` runs toward the next.
Work increases with segment, collider, substep and iteration counts. This does not
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

To bind a rope to existing dynamic sphere or box bodies, create it with `autoStep: true`
and `bodyColliders: [{ id: "rope-collider-id", entity: "body-id" }]`. After the
rigid-body physics phase, the host samples each bound collider's actual center,
shape, orientation, velocity and effective inverse mass/inertia, then steps the rope
and applies the resulting normal contact impulse to the body. At detected overlaps,
particle and virtual body corrections share effective mass and address closing
normal velocity; contacts are not predicted before overlap.
The actual body's displacement responds on the next body step. Bindings require live dynamic non-trigger spheres or boxes and unique
collider ids and body entities within each rope. Do not use a bound collider id
in `setColliders`; its manual colliders remain separate. A destroyed body
is unbound at the next automatic step, and a new entity with the same id is not
implicitly rebound. Bindings are saved with Host snapshots.

To connect a rope particle to a dynamic body rather than only collide with it,
use a body attachment:

```ts
ctx.ropes.create({
  id: "lift-rope",
  autoStep: true,
  points: [[0, 3, 0], [0, 2, 0], [0, 1, 0]],
  mass: 0.1,
  anchors: [{ index: 0, position: [0, 3, 0] }],
  bodyAttachments: [{ index: 2, entity: "load", localPoint: [0, 0.5, 0] }],
});
ctx.ropes.bodyAttachments("lift-rope");
ctx.ropes.detachBody("lift-rope", 2);
ctx.ropes.attachBody("lift-rope", { index: 2, entity: "load", localPoint: [0, 0.5, 0] });
```

The target must be a live dynamic non-trigger sphere or box. `localPoint` is
measured in metres in the rigid body's local frame; entity scale is not applied
again. Each attachment constrains one particle in both directions using sampled
body mass, inertia and velocity. Resulting impulses are applied after the rope
pass, so body displacement follows on the next physics step. Start the particle
near its body-local attachment point; a large initial gap can generate a large
corrective impulse. If an attachment
uses particle 0 and `anchors` is omitted, the usual default fixed anchor is not
created. A particle cannot be both statically anchored and body-attached; release
the static anchor before attaching it. Up to 64 attachments per rope are allowed.

When the same body is also a `bodyColliders` binding, its attached particle and
adjacent segments skip contact with that body; other segments still collide.
A destroyed body detaches at the next automatic step and is not rebound to a
new entity with the same ID. A snapshot attempted before that step rejects the
stale attachment; otherwise attachment definitions are saved with the rope.
The split-step constraint, native impulses, angular response, stability and
snapshot recovery are unverified. This does not provide continuous collision,
tearing, friction or a unified simultaneous solve across all simulations.

Do not manually apply the same contact's reaction when using a body binding: the
host already applies it. A native failure can still leave the host tick partially
changed, so restore a known-good checkpoint. This is an approximate split-step
solver: virtual positions use a first-order update and the real body moves on its
next step. For a box, the virtual center responds during the split step while
its sampled orientation remains fixed until the next physics step. Ropes are
processed sequentially, without globally coupled substeps;
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

An automatic soft body can bind one live dynamic, non-trigger sphere or box with `bodyColliders: [{ id: "collider-id", entity: "body-id" }]`. The collider is sampled after physics before each soft-body step. Set `bodyReactions: true` to use approximate split-step effective-mass contact and submit reaction impulses through the physics bridge; it is delayed and not a complete coupled simulation. Destroyed bindings fail the owning step rather than silently becoming a different collider.

Set `selfCollisions: true` when creating a soft body to enable discrete
particle-pair separation for particles that do not share a tetrahedral edge.
`inspect(id).contacts.selfContactCorrections` counts cumulative solver
projections, not unique collision events. The option and counter are retained
in snapshots; older snapshots default to disabled. This bounded CPU pass is
quadratic in particle count per solver iteration. It is not continuous
collision detection, triangle/edge contact, tearing or a guarantee against
self-intersection; runtime stability, cost and restoration are unverified.

Fluid and soft-body bindings retain an entity-generation handle. Destroying a bound entity invalidates the binding even if another entity later uses the same ID; destroy and recreate the simulation to bind the replacement. A snapshot with a stale binding is rejected, and restore requires a matching dynamic, non-trigger sphere or box in both world and physics state. These lifecycle paths are not runtime-validated.

Soft-body surface UVs use the initial particle positions and remain fixed as the body deforms; they are not recalculated from the current pose.

`softBodyGrid: [width, height, depth]` sets the reference solid's tetrahedral
lattice dimensions. Each dimension is an integer from 2 to 5; the default is
`[3, 3, 3]`. This adjusts the built-in lattice, not an arbitrary imported mesh.
Runtime behavior, stability, rendering and snapshot restoration are unverified.

For bound fluid and soft-body simulations, the reference solvers sample a sphere's center and radius or a box's center, half-extents and XYZ rotation after each physics step. Without `bodyReactions`, the sampled collider is fixed during the simulation step. With reactions enabled, a temporary body shares contact projection using particle inverse mass and the sampled rigid body's effective inverse mass and world inverse inertia; it also considers relative normal velocity. Reactions update that temporary body's velocity and approximate position during the split step, then submit the accumulated linear and angular impulses to physics. Simulations of the same kind bound to one body share that temporary body in sorted order; fluid, soft body, rope and cloth remain separate passes. Box orientation stays fixed during each pass. The body is not advanced by reference-scene gravity or clamped to the reference container. `contacts.reactionImpulse` and the optional `contacts.reactionMoment` are cumulative; the latter is angular impulse about the world origin. This is discrete, delayed, approximate coupling, not continuous collision, friction, or a unified fully coupled solve. Runtime behavior, stability, performance and restoration have not been validated.

`ctx.fluid.setColliders(id, colliders)` and `ctx.softBodies.setColliders` replace up to 64 manual sphere, plane or box obstacles. A plane uses a unit `normal` and signed `offset`; its normal points toward the allowed half-space. A box uses world-space `center`, positive `halfExtents`, and optional XYZ Euler `rotation` in radians; omitting rotation preserves the axis-aligned behavior. Colliders affect particles discretely when `contacts` is enabled, do not receive reaction forces, and do not move rigid bodies. Their IDs must be distinct from bound body collider IDs. Snapshots retain the colliders and their rotation; behavior and restoration are not runtime-validated.

New snapshots retain sampled sphere radii or box half-extents and rotation for rollback and restoration. Older snapshots without these optional fields remain accepted and refresh the collider on the next automatic step. This compatibility and rollback behavior has not been runtime-validated.

### Development-stage triangular cloth

Declare a material in `defineGame({ materials: [...] })`, then use
`ctx.cloth.create({ id, points, triangles, mass, autoStep: true, visual: {
material: "material-id" } })`. Triangles reference particle indices and shared
edges must be manifold with consistent winding. Anchors are explicit; no particles
are pinned by default. Automatic cloth advances after the physics phase;
manual cloth uses `ctx.cloth.step`. Use `setAnchor`, `releaseAnchor`, `applyForce`
(next tick), `applyImpulse`, `setColliders`, `inspect`, and `destroy` to manage it.
The source checkout includes `examples/cloth-sheet`.

An automatic cloth may bind a live dynamic, non-trigger sphere or box with
`bodyColliders: [{ id: "collider-id", entity: "body-id" }]`. The plugin samples
the collider center, orientation and dimensions after physics and uses it as a
moving obstacle. A box can rotate; the cloth surface still uses the sampled
contact method described below. Bindings track entity lifetime, so replacing an
entity with the same ID does not silently attach the replacement. Set
`bodyReactions: true` to use split-step contact with a temporary rigid body.
Particle contacts use particle mass and the body's effective inverse mass and
inertia; sampled surface contacts use barycentric particle weights and exclude
anchors from the surface's effective inverse mass. The solver considers normal
relative velocity and submits accumulated impulses through the physics bridge.
Cloths sharing a body use the same temporary body in sorted cloth order; the
rigid body's actual pose advances in the next physics step. Box orientation
remains fixed within this split pass. The body receives no reaction when the
option is omitted. Destroyed bodies are removed on the next automatic step.
When no bindings remain, reactions are disabled. Do not reuse a bound collider
ID in `setColliders`. This is discrete, delayed and approximate, not continuous
collision, friction or a unified full coupling across solvers; sampling,
impulses, stability, performance and restoration have not been runtime-validated.

Automatic cloth steps stage reactions across all cloth entries before submitting
one body-sorted physics batch, so a later cloth solver failure does not commit
earlier cloth reactions. This staging and rollback behavior is unverified and
does not roll back other host systems. If a native reaction operation fails,
it reports `partialState=true` and the host tick faults; the engine does not
automatically replay physics history in that failure path. Restart the scene or
restore a known-good checkpoint, noting that the separately documented 3D
historical replay risk remains unresolved.

Sampled planes use the triangle centroid for discrete surface projection; this is not continuous triangle-plane collision.

New cloth also resolves detected sphere overlaps against triangle surface interiors
using closest-point barycentric projection. `inspect(id).surfaceContacts` reports
the triangle and barycentric position. `surfaceCollisions` defaults to true for new
cloth and can be disabled. Spheres use closest-point surface contact, planes use
centroid projection, and boxes sample triangle edges and projections of box
corners. The box samples do not guarantee detection of every surface contact;
there is no edge/face continuous collision or full rigid-body reaction. Surface
contact state is included in snapshots and invalid state is
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

If the apply report is unavailable, `npx --no-install pelican migrate
--list-backups` lists up to 1024 matching backup names, their current SHA-256
values and the current manifest hash. An unreadable, linked or oversized
candidate is reported without a hash; `totalMatches` and `truncated` indicate
whether more candidates exist. The hashes describe bytes read at listing time,
not proof of a backup's origin or correctness. Independently choose the intended
backup and compare it with any retained report before supplying the hashes to
`--restore`; a later file change causes restore to reject the supplied hashes.
Listing does not modify files or establish compatibility. This workflow has not
been runtime-validated.

**This only changes the project lock.** It does not update package dependencies,
rewrite game APIs, migrate saved games/replays or establish compatibility. The
new command and recovery path have not been runtime-validated. When validation
is authorized later, independently build and assess the migrated game. For
package integrity/dependency errors, reinstall one exact package version;
never work around a diagnostic by importing an internal dependency.
