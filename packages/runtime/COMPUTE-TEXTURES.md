# Compute texture owner

`createComputeDriver` owns buffers and linear rgba32float textures in one logical
ID/index/generation space. Internal records retain `type: vec4`, `count: width *
height`, immutable `texture: { width, height }`, revision and frozen CPU values.
Public texture handles add `kind: texture`; exact handle validation and the live
record kind prevent mixing buffer and texture APIs, bindings and task results.

Texture writes validate a dense Vec4 array and the complete optional rectangle
before changing any row or revision. Busy sources cannot be written or released.
Create/read/write/description data remains detached; the owner does not run
shaders or upload GPU resources.

Named texture inputs are captured at dispatch or reference a predecessor's exact
successful texture result. Both participate in ordinary task dependencies,
source busy references, cancellation and retained revisions. Ordinary dispatch
descriptors carry the private `captured: true` marker so a later executor can
restore an unuploaded old CPU checkpoint after a pure producer overwrites it.
Task-result descriptors and renderer resources omit that marker; exact GPU
history is required for old computed results.

Requests contain separate `inputs` and `textures`; texture outputs carry shape
metadata. A successful executor result is validated once and committed at one
revision before the owning record and exact task result publish. The executor
owns the paired GPU storage texture and packed buffer. The owner collects current
and unreleased task revisions using the same key/revision list for both kinds.

Version-1 snapshots keep the legacy buffer entry shape and add optional texture
dimensions for texture entries. They contain no tasks or GPU resources. Restore
preflights exact fields, shape/type/count/data and unique IDs before invalidating
old generations. `resource(id)` accepts only buffers; `textureResource(id)` is the
private detached texture descriptor for future render bridges. Render buffer
peer validation rejects texture entries used as ordinary buffers.

Executor replacement cancels unfinished chains, drops private result references
and preserves committed CPU texture values. Old task statuses remain inspectable
but cannot resurrect old GPU texture versions. Restore/disposal and late results
follow the existing dependency epoch rules.

Focused owner tests inject an executor and establish CPU ownership only. The real
hardware chain and scope are recorded in `docs/tasks/M3-COMPUTE-TEXTURES.md`.
