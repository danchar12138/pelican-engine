# Render buffer CPU owner

`src/render-buffers.ts` owns material storage-buffer slots behind the public
`render.buffers.bind(material, slot, handle)`, `unbind(material, slot)` and
`state(material)` service. It imports SDK types and the private
`RenderBufferProvider` contract; it owns no GPU resources.

The same owner also implements `render.effects.buffers` for postprocess pass
IDs. `createRenderSettingsDriver` keeps material and pass namespaces separate,
unions their logical pins, preflights both snapshots, and publishes the final
union once before restoring either owner. One namespace cannot unpin a resource
still referenced by the other. Provider failure rolls back pins before CPU state
changes. Postprocess snapshots use the optional `effectBufferBindings` field;
legacy snapshots with no slots retain their old shape.

## Construction and binding

`createRenderBufferOwner(materials = [], provider?)` accepts material IDs and
optional `MaterialBufferInput[]` declarations. Material IDs and slot names must
be unique within their respective scopes. Slots declare a graph type and may
specify an initial logical compute-buffer `buffer` ID and an exact `count`.
Counts use the compute owner's positive uint32 range. All five graph types are
supported by this CPU contract; renderer support is a separate concern.

The compute owner must exist before constructing an initially bound render
owner. Every initial ID is resolved through `provider.resource(id)` and checked
for type and count before any pins are published. A missing provider or invalid
initial resource fails construction with a render-buffer diagnostic. Slots
without initial IDs can remain unbound, including when no provider exists.

Public binds obtain a live logical reference through `provider.describe(handle)`.
The provider checks handle ownership/generation/liveness; the render owner
checks the declared material/slot, type and exact count. It copies only
`{ id, type, count }`. Handles and native resources never enter state or
snapshots. Invalid binds preserve bindings, revision and pins. Pin publication
happens before committing a changed binding; if the provider throws, the owner
attempts to restore the previous pins and retains its previous state.

Pins are sorted, unique logical IDs. `provider.setPins(ids)` replaces the single
render owner's complete pin set. Shared references remain pinned until their
last slot is unbound. The compute owner is responsible for refusing release of
pinned buffers. Repeating an identical bind, unbind or restore does not change
the revision.

## Frame resources

`owner.resources(material)` checks that every declared slot is bound, then
resolves each current logical ID through the provider. An unbound declared slot
throws `TC_RENDER_BUFFER_UNBOUND` when resources for that material are requested;
other materials and owner snapshots may remain unbound.

The returned read-only record contains detached `{ key, type, revision, values }`
descriptors, including detached vector elements. Each call resolves current
compute identities and revisions, so restored compute owners and rebuilt
resource keys are observed without retaining old handles. Current resources must
match the saved reference's type/count even when the slot has no explicit count.
This API exposes the CPU descriptor; it does not allocate, upload, copy or expose
native GPU buffers.

## Snapshot and restore contract

`owner.snapshot()` returns `undefined` when no material declares slots. Otherwise
its version-1 shape is:

```ts
{
  version: 1,
  definitions: [
    { id: "mesh", buffers: [{ name: "positions", type: "vec3", count: 2 }] }
  ],
  bindings: {
    mesh: { positions: { id: "simulation", type: "vec3", count: 2 } }
  }
}
```

Definitions and bindings use sorted material/slot names. Definitions omit
materials without slots, source locations, and initial `buffer` IDs. Initial IDs
are defaults, not snapshot identity: a checkpoint may legitimately refer to old
logical names. Every declared material with slots appears in `bindings`, but
unbound slots are omitted, so an entirely unbound material has `{}`. Snapshots
are detached mutable plain data.

- `validateSnapshot(value)` checks exact shape, version, canonical declarations,
  logical reference types/counts, and declared binding names. It accepts plain or
  null-prototype records and rejects accessors, hidden/symbol properties, sparse
  arrays and extra fields. It never consults live provider resources or mutates
  the owner/provider.
- `validatePeerSnapshot(value, peers)` additionally checks every bound reference
  against `peers["$engine.compute"].payload.buffers` by logical ID, type and count.
  It requires no compute peer when all snapshot slots are unbound. Ordinary
  compute snapshot validation remains the compute plugin's responsibility.
- `restore(value)` validates the whole buffer snapshot, publishes replacement
  logical pins, then commits detached bindings. It does not resolve resources.
  The provider must accept pins for valid names before those names exist in its
  current buffer table; restoration can precede compute checkpoint restoration.

The host must validate all plugin snapshots, then call every plugin's
`validatePeers(value, peers)`, before any restore/replay writes. Publish restored
render pins before restoring compute buffers. Once compute restores, frame
resource resolution obtains its new keys; pre-restore handles remain invalid.
A caller using the owner directly must perform both preflight steps itself.

## Render settings integration and disposal

`createRenderSettingsDriver(initial, materials, capabilities, postProcesses,
provider?)` appends the provider as its fifth argument. Its `.buffers` property
is the owner; `driver.service.buffers` is the public binding service. The render
plugin adds optional `bufferBindings` to its existing snapshot only when slots
exist, preserving the exact legacy no-buffer/effect snapshot shape. It implements
`validatePeers` and preflights settings, material parameters, postprocesses and
bindings before mutating any of them. Restoring pins happens before changing
those other owners or settings.

`owner.dispose()` unpins the provider before clearing its own state. The driver
unpins before disposing its other owners. Disposal is idempotent; retained
binding services, frame resources, snapshots, preflight, restore and inspection
calls then fail with `TC_RENDER_BUFFER_DISPOSED`. `inspect()` returns detached
material, slot, bound-reference, unique-pin and revision counts.

Errors carry stable `TC_RENDER_BUFFER_*` codes, entity/slot context, a `Repair:`
message and a `remediation` property. Codes distinguish definition, material,
slot, provider, reference, type, count, resource, unbound, snapshot, peer snapshot
and disposed failures.

## Focused verification (D49)

```sh
node_modules/.bin/tsx.cmd --test tests/render-buffers.test.ts tests/render-settings.test.ts tests/material-parameters.test.ts tests/postprocess-owner.test.ts
node_modules/.bin/tsc.cmd --ignoreConfig --noEmit --strict --target ES2023 --module ESNext --moduleResolution Bundler --allowImportingTsExtensions --skipLibCheck --types node,@webgpu/types --lib ES2023,DOM,DOM.Iterable packages/runtime/src/render-buffers.ts packages/runtime/src/render-settings.ts tests/render-buffers.test.ts
```

These are CPU ownership/contract checks. GPU copying, SDK/compiler/browser
integration, host restore/replay wiring and cross-host behavior belong to the
other integration owners; these checks do not claim GPU or full-M3 acceptance.
