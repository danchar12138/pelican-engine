# GLB Models and Animation Adapter

This module is private to the renderer. It uses the pinned Three.js 0.187
GLTFLoader, SkeletonUtils.clone, and AnimationMixer. These objects are not game
SDK objects. This adapter has independent tests; main browser rendering and
runtime integration remain separate acceptance work.

```ts
const models = createModelLibrary({
  hero: "/assets/hero.glb",
  bottle: "/assets/bottle.glb",
});
await models.prepare(["hero", "bottle"], { signal });
const player = models.instantiate(
  "player",
  {
    asset: "hero",
    scale: 1.25,
    offset: [0, 0.1, 0],
    rotation: [0, Math.PI, 0],
    animation: { clip: "Idle", loop: true },
  },
  sceneRoot,
);
models.animation.play("player", "Run", { fade: 0.15, speed: 1.1 });
models.tick(fixedPresentationDelta);
const saved = JSON.parse(JSON.stringify(models.snapshot()));
models.restore(saved);
player.dispose();
await models.dispose();
```

## Preparation and cancellation

The constructor accepts an asset-id-to-URL record or manifest entries with
`id` and `path`/`url`. `prepare` accepts registered ids, SDK AssetDefinition
values, or manifest entries. URLs resolve against `options.baseURL`, or the
module URL when no base is supplied. Asset ids have immutable URLs within a
library; conflicting registrations fail with `TC_MODEL_ASSET_CONFLICT`.
Request validation completes before registrations change or fetching starts.

Concurrent preparation shares one fetch/decode per asset id. Cancelling one
caller rejects that caller promptly with `TC_MODEL_CANCELLED` while other
callers keep waiting. When the last caller cancels, the shared fetch signal is
aborted and the abandoned entry no longer blocks a new attempt. A stale result
cannot replace a newer template. An already aborted signal rejects even for
cached assets and empty requests, without registering assets or fetching.

Successful templates stay cached until library disposal. A request spanning
several assets is not a transaction: another successful asset remains cached
when one asset fails. Failed entries can be retried; concurrent retries share
a new attempt. HTTP, parse, and validation failures include
`TC_MODEL_LOAD_FAILED` and the asset id.

Only embedded buffers/images and data URIs are supported. Relative or absolute
external buffer/image URIs fail with `TC_MODEL_EXTERNAL_URI_UNSUPPORTED`:
GLTFLoader's subordinate requests would bypass the injected fetch and its
signal. Embed those resources before loading. Unrecognized required glTF
extensions fail with `TC_MODEL_EXTENSION_UNSUPPORTED`. No Draco, Meshopt, or
KTX2 decoder is configured here; assets requiring those decoders fail rather
than claiming successful decoding. Failed texture decoding raises
`TC_MODEL_TEXTURE_FAILED` rather than accepting GLTFLoader's null-texture
fallback.

## Ownership and transforms

Instances clone the default scene, own their skeletons, bone textures, morph
influence arrays, and mixers, and share template geometry/materials/textures.
Shared resources and inverse bind matrices must be treated as immutable.
Removing an instance stops and uncaches all its actions, detaches its wrapper,
and disposes only its private skeleton resources. Instance disposal is
idempotent; an old handle cannot remove a replacement with the same entity id.
Invalid initial playback rolls back the instance and its parent attachment.

The wrapper applies `T(offset) * R_XYZ(rotation) * S(scale)` relative to its
parent. Rotation values are radians; scale is a finite positive scalar;
offset/rotation must each have three finite numbers. Source node transforms,
animated bone transforms, and inverse bind matrices remain unchanged. Offsets
are therefore not multiplied by the model's scale. Entity transforms belong
to the parent supplied by integration.

**Compiler integration gap:** the current SceneIR model type and
`packages/compiler/src/normalize.ts` retain asset/scale/animation only.
They currently drop the public ModelDefinition offset/rotation values. The
adapter implements those fields when supplied directly; the compiler and
browser integration must carry them through before claiming SDK-to-renderer
support. The compiler in this reviewed worktree also restricts animation speed to positive
values; direct adapter playback permits any finite speed.

Library disposal aborts all loads, including abandoned attempts, removes
instances, waits for decodes and sibling dependencies to settle, and releases
all decoded scenes/resources, including non-default scenes. Shared geometries,
materials, textures, skeletons, and ImageBitmaps are released once within each
load's ownership pool. Failed embedded-image blob URLs are revoked as well.
Concurrent disposal calls wait for the same cleanup. Decoding is not
interruptible; cancellation prevents publication and releases the eventual
result. A custom fetch that ignores abort and never settles can keep disposal
pending. The adapter cannot forcibly terminate foreign I/O.

`inspect()` counts adapter-owned resource objects, including decoded
non-default scenes and private instance skeletons. Counts do not measure GPU,
driver, browser, or process memory and do not prove the absence of GPU leaks.

## Animation and snapshots

The owner calls `tick(dt)` exactly once per presentation phase, before drawing
and before extracting dynamic geometry. The draw path must not advance it
again. Delta time must be finite and nonnegative. Clip names are case-sensitive
GLTFLoader names; unnamed animations use `animation_<index>`. Duplicate names
and zero/nonfinite clip durations are explicitly rejected. Clips must have
unique names and positive duration; unsupported clips are not silently dropped.

Playback starts/restarts a clip at time zero. Speed scales clip time (including
zero and reverse speed); fades advance in presentation seconds independently
of playback speed. Repeat wraps at clip duration; LoopOnce clamps the end pose
and reports `playing: false` when finished. A reverse LoopOnce also starts at
zero, so it immediately clamps at the beginning. A positive fade blends from
each outgoing action's current effective weight to zero and from zero to one
for the incoming action. This also defines interrupted fades; replaying the
same clip restarts it. A zero fade removes previous action influence and sets
full weight immediately. Outgoing actions stop when their fade completes.

Snapshots use `format: "pelican.models", version: 2`. They include entity
and asset ids, current clip, action time, speed, repeat mode, playing/paused
state, effective weight, and each fade's source/target weight, duration, and
elapsed seconds. The adapter owns fade envelopes instead of depending on
Three.js private interpolant fields. Restore evaluates the saved pose and
continues pending fades on subsequent ticks. Completed non-looping poses and
zero-speed actions remain distinct from paused playback.

Version 1 snapshots are rejected: they cannot recover the remaining fade
trajectory. Every saved entity must have a registered definition referring to
the same asset and available clips; the current active set may differ.
Validation checks every saved entity, action, time bound, and fade before
mutating any mixer or creating/removing any instance. Malformed values raise `TC_MODEL_INVALID_SNAPSHOT` and leave all
poses/actions untouched. Restore copies the data, so later caller mutations do
not alter playback. References and GPU resources are never serialized.

## Host restore and changing active entities

Definition registration and active instances have separate lifetimes. After
preparation, register all authored model definitions before plugin snapshot
validation, or instantiate them normally (which registers automatically).
`remove(id)` disposes the active instance but retains its known definition and
last parent until library disposal. Definitions are copied and immutable for
each id in a library; changes fail with `TC_MODEL_DEFINITION_CONFLICT`. Use a
new library when changing authored content. The registry is per library, so a
cold host must register the matching scene's definitions too.

| Method                              | Contract                                                                                                                                                                                                                                                             |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `register(id, definition, parent?)` | Validate and remember a prepared definition without creating an instance. Does not restart or reparent a live instance.                                                                                                                                              |
| `get(id)`                           | Return the current active ModelInstance handle, or undefined.                                                                                                                                                                                                        |
| `attach(id, parent)`                | Reparent an existing instance without restarting its animation. If missing, recreate it from the known definition, starting its authored initial playback. Remember the new parent.                                                                                  |
| `reconcile(activeIds, parent?)`     | Require known, unique ids; create missing instances, remove extra instances, and return handles in input order. Retain existing animation progress. Missing instances use remembered parents; an explicit parent reparents all requested instances.                  |
| `restore(snapshot)`                 | Treat the saved animation-entry ids as the complete saved active model set, including instances without a selected clip. Recreate missing instances, restore all saved actions/fades, and remove extra active instances. An empty list removes all active instances. |

`validateSnapshot` is pure with respect to active instances: it validates
against the registry/templates, so it works before the Host restores its world.
A saved subset is valid even when a cold host initially instantiated all
authored models. Unknown definitions fail explicitly with
`TC_MODEL_INVALID_SNAPSHOT: TC_MODEL_DEFINITION_MISSING`; missing clips,
incompatible assets, and malformed actions also reject. Saved playback is
never silently skipped. Missing instances are built before committing active
set changes; failed construction releases any staged instances.

Browser integration should use the current world to determine live model ids,
not the complete authored id list. At a command-commit boundary, reconcile
those live model ids, then use `attach` with each entity's current view parent.
Use `get` to replace old cached handles/nodes after restoring; a removed handle
continues to refer only to its original instance. If a remembered entity view
parent was detached, reattach to the replacement view before drawing.

```ts
// After prepare, before Host plugin validation:
for (const [id, definition] of authoredModels) models.register(id, definition);

// Plugin methods can delegate directly, including during Host rollback:
// snapshot: () => models.snapshot()
// validateSnapshot: value => { models.validateSnapshot(value); }
// restore: value => models.restore(value)
// Use a plugin version compatible with model snapshot format 2.

function syncModelViews(liveModelIds: readonly string[]) {
  models.reconcile(liveModelIds);
  for (const id of liveModelIds) {
    const current = models.attach(id, currentEntityView(id));
    modelViews.set(id, current); // update stale model references
  }
  for (const id of modelViews.keys())
    if (!models.get(id)) modelViews.delete(id);
}

try {
  host.restore(savedHost);
} finally {
  // Also refresh after Host rollback: recreation can change instance identity.
  syncModelViews(liveModelIdsFromRestoredWorld());
}
```

The browser owns consistency between the world's saved live model entities and
the plugin's saved active model ids. Synchronize model membership before taking
a Host snapshot, and do not revive deleted models by reconciling every authored
id afterward. The adapter has no world reference and cannot detect a mismatch
between independently modified world/plugin snapshots. Newly introduced model
ids need explicit registration; the current public runtime SpawnInput does not
carry a model definition. Plain spawned entities need no model registration and
must not be passed to model reconciliation. Entity ids do not encode ECS handle
generations, so registration alone must not decide whether a reused world id
should have a model. The browser must make that membership decision.

## Tracer boundary and acceptance evidence

GLTFLoader material/color-space handling is preserved for raster integration.
This adapter does not select a rendering mode or automatically hide models
from tracing. It cannot provide a runtime diagnostic for a mode switch in the
separate browser adapter.

| Area                 | Current boundary                                                                                                                                                                                                                                                                                                            |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Geometry extraction  | `extractTriangles` reads current skinned/morphed vertex positions and world transforms. A test verifies actual animated triangle coordinates with model offset, rotation, and scale.                                                                                                                                        |
| Traced materials     | The current extractor takes the first material's uniform color, scalar roughness, and simplified emissive intensity. It ignores texture sampling, UVs, normal maps, vertex colors, material groups, alpha/transparency, metalness, transmission, and other glTF material extensions. The tracer uses triangle face normals. |
| Dynamic updates      | The adapter ticks poses only. Extraction, BVH rebuild/upload, accumulation invalidation, and raster/hybrid/path mode switching need separate integration.                                                                                                                                                                   |
| Rendering acceptance | The embedded-asset probe verifies browser decoding, animation continuation, resource sharing, and disposal. It does not create a WebGPU renderer or establish visual correctness, GPU resource reclamation, or performance.                                                                                                 |

A textured WaterBottle or Fox therefore does **not** have faithful path-traced
material support in the current tracer. The integration must explicitly report
or reject unsupported model/material combinations when selecting hybrid/path
rendering. Rendering an untextured approximation without a diagnostic is not
acceptance. M3 material/dynamic tracing work and the user's main browser
integration remain open; no fallback is added here.

The focused tests use generated real GLBs for cancellation, lifecycle, sibling
parse failures, independent bones/morph influences, playback, JSON snapshot
continuation, atomic rejection, deleted-instance reconstruction, saved subsets,
cold-host reconstruction, and view reconciliation. The optional bounded Chromium probe reads
the repository's Fox and WaterBottle assets without rewriting them. It serves
modules from memory on `127.0.0.1` port 0, has launch/evaluation deadlines,
and closes its own browser/server in `finally`. It needs an existing local
Playwright Chromium installation and never starts the main development server.

```sh
# Include the independent embedded-texture browser probe.
node tools/run-with-env.mjs PELICAN_MODEL_BROWSER=1 -- node --import tsx --test tests/models.test.ts
node tools/run-with-env.mjs PELICAN_MODEL_BROWSER=1 -- node node_modules/typescript/bin/tsc --noEmit
node tools/run-with-env.mjs PELICAN_MODEL_BROWSER=1 -- node node_modules/prettier/bin/prettier.cjs --check packages/renderer/src/models.ts packages/renderer/MODELS.md tests/models.test.ts
```
