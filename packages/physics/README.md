# Rapier 3D runtime plugin

This document describes the 3D plugin. An opt-in independent 2D rigid-body
service is documented in `docs/npm/GAME-AUTHOR.md`; its behavior and snapshot
reconstruction are not runtime-validated.

Await `createPhysicsFactory()` before constructing a `RuntimeHost`. Initialization and the returned factory are shared across concurrent and subsequent calls. `initPhysics` is an alias; synchronous `createFactory()` requires initialization to have completed. Pass the factory through Host's `plugins` option. Gameplay accesses `ctx.physics` inside scheduled systems; the plugin owns all Rapier objects.

## Movement and transforms

- The physics system consumes the scheduler's fixed dt (supported range: 0.000001?1 seconds). It never reads wall time. Query structures are built with a zero-duration native step before the first movement; changed scene transforms refresh those structures before character collision queries.
- `moveCharacter(id, displacement)` accumulates **world-space XYZ displacement for the next physics step**, including Y, then clears it. It resolves the complete displacement against solids. Triggers never obstruct characters.
- `setVelocity` accepts all three axes for dynamic bodies and characters. For characters, X/Z are persistent requested movement speeds; Y replaces vertical speed and then integrates character gravity. A positive Y initiates a jump. `velocity` returns those persistent X/Z speeds and the current integrated Y speed; movement may be limited by obstacles. For dynamic bodies it returns the actual native linear velocity. `moveCharacter` adds displacement independently of this velocity.
- `CharacterDefinition.speed` and `jumpSpeed` describe gameplay controls. Gameplay multiplies speed by fixed dt and explicitly calls `setVelocity` to jump; the plugin does not synthesize input or auto-jump. Character gravity defaults to 9.81; a downward movement probe maintains stable grounding. Upward speed clears when blocked by a ceiling. Rapier 0.21 can exhaust its KCC collision-iteration budget at zero-time floor/kinematic contacts. Only when that budget is exhausted and requested motion makes no progress, a bounded native capsule cast/slide recovery resolves the displacement against all blocking solids. Tangential/outward touching surfaces are excluded only for the remainder of that straight sweep; opposing obstacles remain queried. Tests cover retreat, opened gates, platform edges/support removal, thin walls, corners and deterministic replay. Normal KCC steps keep autostep/slope/snap behavior.
- `impulse` requires a dynamic body, uses its configured total mass, and wakes it. Dynamic bodies enable CCD. Native collision/trigger start and end events use `{ a, b }` entity IDs. Character contact with solids is resolved with the controller's gap, so a blocking controller contact need not produce a native overlap event; use `grounded` for support detection.
- Transform edits are consumed before the next physical step. Fixed, dynamic and kinematic body position/rotation edits are explicit teleports. Rigid rotations use XYZ Euler order. Boxes support positive nonuniform scale; sphere/capsule scale must be uniform. Collider offsets scale with the entity. Configured mass remains the total mass when scale changes.
- Characters accept **yaw only**, with unit scale. Gameplay can set `rotation: [0, yaw, 0]`; the body synchronizes to it and the scene preserves that yaw. Character pitch, roll, scale, nonpositive scale and all parented physics entities fail with stable `TC_PHYSICS_*` diagnostics. These configurations are never silently approximated.
- Destroyed entities are excluded from services and rays immediately. At the next physics step their native bodies/controllers and contact pairs are removed; active native pairs emit an end event. Entity handles distinguish generations: an ID reused after destruction removes the old body and creates a new one with zero velocity, no pending character movement, and no inherited contacts.

## Runtime prefab instances

Spawn compiled physics prefabs through Host: `ctx.entities.spawn({ id: "falling-crate-1", prefab: "falling-crate", transform: { position: [0, 4, 0] } })`. Host merges compiled transform/component defaults and queues the entity. At the next physics phase after that command commits, the plugin discovers its World record and creates its rigid body or character **in the existing native world**. A spawn committed after physics is first simulated on the following tick. Services become available after this discovery; a prePhysics system on that first tick must wait until postPhysics to address the new body.

Content resolves through the shared `resolveEntityDefinition` helper: authored identity takes precedence when no different prefab is explicitly requested; otherwise the compiled prefab supplies the definition. Plain runtime entities without a physics declaration acquire no body. Unknown prefab identities diagnose `TC_PREFAB_MISSING`. Runtime records supply the instance transform and parent; they cannot supply arbitrary collider, body, or character definitions. The same parent, scale, rotation, mass, fixed-step, collision, trigger and ray rules apply to initial and spawned entities.

The internal physics system leaves its read list unbounded because `World.records()` requires read access to every registered component, including components unrelated to physics. Its write list remains limited to `Transform`. Game system permissions are unchanged.

## Rays

`raycast(origin, direction, maxDistance, options?)` normalizes the nonzero direction and returns the nearest valid hit in world units, including when called before the first physics tick. The optional fourth argument is `{ exclude?: readonly string[]; includeTriggers?: boolean }`. Triggers are **excluded by default**; set `includeTriggers: true` to include them. Camera collision can pass `{ exclude: [playerId] }`. Excluded entities, sensors and dead entities are filtered inside Rapier's native query so they cannot hide a valid wall behind them. Malformed vectors, distances or options fail explicitly. The package exports `PhysicsServiceWithQueries` as a local extension while the SDK fourth-argument signature is integrated separately.

## Snapshots and ownership

Plugin version 3 uses a JSON snapshot with immutable authored/prefab catalog and gravity identity, checked operation history, native state bytes for comparison, and entity/handle, character, active-pair and live-binding headers. Versions 1 and 2 are explicitly incompatible.

Validation creates an isolated world and replays finite, validated operations from the scene. Each step records explicit removals, creations and the complete active transform frame. Creation records contain only instance ID, optional compiled prefab ID and transform; replay resolves the immutable catalog again and rejects unknown/nonphysics identities, duplicate declarations and inline body definitions. A same-ID replacement records removal before creation. It compares every native byte and the full state header against the reconstruction. This proves entity uniqueness, collider/body correspondence, character mapping and immutable configuration, finite state, and valid contact pairs. **Externally supplied bytes are never passed to native deserialization**, including for otherwise valid snapshots. Empty/truncated/modified bytes, duplicate IDs/handles, inconsistent pairs and characters, malformed history and mismatched scenes are rejected before replacing the live world. Snapshot data must be plain finite JSON; getters and custom object prototypes are rejected.

Restore swaps in the verified world and synchronizes bound live transforms. The saved binding list preserves the boundary where World has already destroyed or replaced an entity but its native body awaits the next physics phase. It prevents cold restore from binding that old body to a new same-ID generation. Optional `validateWorld` preflights bound IDs and resolved prefab/physics identity against the saved World before Host changes live state; unbound pending creations remain valid. It works in a fresh Host with the same scene and native version, including JSON save/load before spawn, after spawn commit but before physics discovery, and after simulation. Host replay can replace World handles after plugin restoration; references are rebound on the next system/service access. Test coverage compares future native bytes, scene transforms and Host recording replay, rather than only checking successful deserialization.

Reconstruction is O(recorded operations), and snapshot size grows with scene duration. A scene is currently limited to **100,000 recorded operations** (physics steps (including lifecycle declarations) plus movement/velocity/impulse calls) and 64 MiB native state bytes per accepted snapshot. Exceeding the operation limit emits `TC_PHYSICS_HISTORY_LIMIT`; scene transition starts a new history. Constant-size, long-session checkpoints remain future work; raw native-byte restore is deliberately unavailable. Vector magnitudes and scalar values are bounded to avoid overflow in native conversion; diagnostics report the accepted range.

The world owns character controllers. Explicit removal uses `world.removeCharacterController`; disposal frees the event queue and world once, and repeated disposal is harmless. Failed construction, isolated validation and failed replay free all acquired native objects. All plugin operations after disposal diagnose `TC_PHYSICS_DISPOSED`.

## Verification

Run from the repository root:

```powershell
npm exec -- tsx --test tests/physics.test.ts tests/runtime-host.test.ts tests/rigidbody.test.ts
npm run typecheck
npm exec -- prettier --check packages/physics/index.ts packages/physics/README.md tests/physics.test.ts
```

The tests use real Rapier WASM, a real World/plugin context, and real RuntimeHost game systems. Browser integration belongs to the main integration task.
