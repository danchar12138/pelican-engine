# Whole-Model Material Overrides

This is a private renderer adapter contract. Games use the existing
`ModelDefinition.material?: MaterialDefinition | string`; no Three.js, SDK
handle, GPU object, or new public export is introduced.

## Definition and Resolution

An omitted `material` leaves the decoded GLTF materials and textures intact.
An explicit override replaces every mesh's material, including every slot in a
material array, with the exact resolved material object. It is not a per-slot
merge and does not copy any GLTF material properties or textures onto the
override. Geometry, source node transforms, skinning, morph targets, animation
clips, and per-instance skeleton/morph state are otherwise unchanged.

`register` and `instantiate` normalize either a string ID or a definition with
`kind: "material"` to its non-empty string ID. Invalid values fail with
`TC_MODEL_INVALID_MATERIAL`. The normalized definition keeps only that ID, so
later mutation of an input material definition cannot change the registration.
The equivalent string and definition forms compare equally; changing the ID
for a known entity fails with `TC_MODEL_DEFINITION_CONFLICT`.

The renderer supplies `ModelLibraryOptions.material?: (id: string) =>
THREE.Material | undefined`. Registration and template preparation do not call
this resolver: browser startup can prepare templates and register models before
the game-content material map is populated. For example, private integration
can provide `{ material: (id) => materials.get(id) }` over that same map.

Each new instance resolves its override once, before cloning the template or
its private skeleton resources. A missing resolver or unresolved ID fails with
`TC_MODEL_MATERIAL_MISSING`, including the entity and material IDs and a repair
hint. A resolver exception also occurs before cloning. An omitted override
never invokes the resolver.

`attach`, `reconcile`, and snapshot `restore` recreate instances from the same
retained normalized definitions and resolve their IDs again at creation time.
Existing instances keep their resolved material identity; they are not rebound
on every tick or reconcile. Snapshot format/version are unchanged: material
definitions belong to the authored registry, not the animation snapshot.
Cold-host restore must register the authored definitions first.

## Ownership and Failures

Override materials and their textures are borrowed from game content. Instance
removal and library disposal never dispose them or add them to the library's
owned resource counts. Their owner remains responsible for their lifetime.
Decoded template materials and textures remain owned by the library, even when
all instances override them, and are disposed normally with the templates.

Failed direct instantiation does not publish an instance or a new definition.
If a later staged instance fails during reconciliation or restore, the existing
staging rollback releases previously cloned skeletons and leaves the active
instances and parent attachments unchanged. Authored registrations remain
available for retry after game materials become ready.

## Focused Verification

`tests/model-material.test.ts` generates a real two-primitive GLB in memory
using glTF Transform, with distinct asset materials, one joint, a morph target,
and an animation. CPU tests use the actual Three.js loader, skeleton clone,
node material, and mixer. They check default materials, override identity on
all primitives and array slots, skin/morph animation, deferred resolution,
canonical definitions, reconstruction, stable missing-material diagnostics,
throwing resolvers, staging rollback, and borrowed-versus-owned disposal.
The texture-ownership check attaches CPU DataTextures to decoded materials;
it does not exercise browser image decoding.

Run the affected CPU suites:

```powershell
node --import tsx --test tests/model-material.test.ts tests/models.test.ts
```

The opt-in browser test in `models.test.ts` stays disabled by default. This
change does not establish GPU shader, pixel, performance, full M3, packaging,
or release acceptance. Consolidated source typechecks belong to the main
integration work.
