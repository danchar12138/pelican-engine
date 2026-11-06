# Render texture owner integration

`src/render-textures.ts` exports `createRenderTextureOwner`, `RenderTextureSnapshot`, and `RenderTexturePeerSnapshots`. The owner accepts material or pass definitions and the existing private `RenderTextureProvider`; it imports no renderer or native GPU objects.

- `service.bind/unbind/state` uses SDK texture handles and logical references `{ id, width, height, format: "rgba32float" }`. `describeTexture` results may include `revision`, which is excluded from references.
- `resources(target)` resolves current keys/revisions and returns detached, deeply frozen `ComputeExecutionInput` descriptors, including `texture: { width, height }` and finite f32 vec4 values. It checks all missing slots before reading any resources.
- Snapshot version 1 contains sorted declarations and bindings. Declarations normalize samplers to `linear/clamp/clamp`, retain optional dimension constraints, and exclude initial texture IDs. Materials/passes with no slots are omitted; an owner with no slots snapshots to `undefined`.
- Bound dimensions remain fixed until explicit rebinding. An unconstrained slot can rebind to a resized texture; declared width/height constraints still apply.
- `validateSnapshot` checks local declarations/references without querying live compute resources. `validatePeerSnapshot` additionally checks bound logical IDs against compute snapshot texture metadata, vec4 values, dimensions and counts. Ordinary buffers cannot satisfy a texture reference.
- `restore` publishes logical pins without requiring the resources to exist yet, supporting render-before-compute restore after host peer preflight. Revision advances only when bindings change; initial bindings start at revision zero. Disposal is idempotent and releases pins without destroying compute resources.

The main render-settings integration must supply separate scoped providers for material textures and effect textures, alongside the two buffer scopes. Each `setPins(ids)` receives this owner's complete sorted unique logical ID set, not deltas. Merge all four groups before publishing compute pins, and preflight all owner/peer snapshots before atomic restore. This module intentionally does not implement the four-group coordinator. Provider pin failures trigger a best-effort restoration of the prior pin set before owner state changes; providers should reject atomically.

Validation run: `node --import tsx --test tests/render-textures.test.ts` — 17 passed. Includes a real compute owner CPU integration for pins, writes, fresh identities after restoration and texture/buffer separation. No full suite, typecheck, GPU or installation checks were run.
