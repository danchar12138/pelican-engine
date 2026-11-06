# Managed Compute Owner

`src/compute-service.ts` is the CPU state/lifecycle owner for the frozen private
`src/compute-contract.ts` boundary. It does not evaluate graphs or provide a CPU
fallback. The renderer supplies the real WebGPU executor separately.

Managed rgba32float textures share this lifecycle with strict kind separation;
see `COMPUTE-TEXTURES.md`. Public texture services use opaque texture handles,
and dispatch texture bindings carry exact shape/revision data privately.

## Integration

`createComputeDriver(options)` returns `service`, `factory`, `flush`,
`replaceExecutor`, `dispose`, and `inspect`. Register `factory` with the existing
Host plugin lifecycle. Its ID is `$engine.compute`, version `1`, and its service
is `compute`. The plugin exposes `settle: flush` for asynchronous host stepping
and replay. Host/browser integration owns calling settle after each fixed tick
and awaiting it before the next tick. Synchronous replay must not bypass settle.

An empty kernel list with no executor is supported, including snapshots,
restore, settle, inspect, and idempotent disposal, without querying capabilities
or allocating GPU resources. Buffer management is CPU-only on every backend.
Dispatch alone requires `backend: "webgpu"`, `compute: true`, and an executor.
The browser supplies simulation time through `options.time`; standalone owners
default to zero, never wall-clock time. Explicit dispatch time overrides it.

`tasks()` returns detached `{ handle, state }` records. Games can release terminal
tasks without closure-held task handles and resolve buffers by stable name each
tick. The service is declared by the same public SDK in both repository and npm
channels; Host `stepAsync` and `replayAsync` await `RuntimePlugin.settle` boundaries.

## Buffers And Execution

- Buffers support float, vec2, vec3, vec4, and bool. Numeric values follow the SDK
  finite-f32-representable validation contract, not implicit JS coercion or
  eager rounding. Create/write/read data is detached; internal vectors are frozen.
- Names are unique. Handles contain owner/index/generation; slot reuse increments
  generation. Executor resource keys contain all three identity components.
- Revisions start at zero and increment on nonempty writes and successful
  dispatch commits. They are cache metadata, not semantic snapshot state.
- Writes preflight all values and range bounds. Read returns the last committed
  values, including while queued/running work exists. Failed/cancelled work
  neither changes output nor increments its revision.
- Dispatch validates the declared kernel ID, all and only declared bindings,
  input types, output type/count, parameter names/types/defaults, finite time,
  and coarse capabilities before queuing. A definition reference selects the
  immutable compiled kernel by ID; it cannot supply replacement graph code.
- Ordinary buffer inputs, their revisions, parameters, and time are captured at
  dispatch. Same-buffer input/output is allowed. Multiple same-tick ordinary
  bindings read their original snapshots. Explicit `{ task: predecessor }`
  bindings resolve that task's exact successful output before execution;
  `after` provides ordering only. See `COMPUTE-DEPENDENCIES.md`.
- All involved buffers are busy to write/release until every referencing task
  terminates. Dispatches execute FIFO only during flush. Concurrent flush calls
  share completion. Executor results must be dense arrays of exactly the declared
  count/type, with all finite components, before one atomic CPU commit.
- Tasks transition queued/running to succeeded/failed/cancelled. Cancellation is
  idempotent, aborts the executor signal, unlocks buffers, and does not wait on an
  uncooperative executor. Late resolve/reject is observed but cannot commit.
  Only terminal tasks without unfinished consumers may be released. Terminal
  tasks drop dispatch inputs but retain successful output versions until release,
  source release, restore, or executor invalidation.

## Recovery And Snapshots

Snapshot, validation, and restore require no unfinished tasks. Version 1 stores
canonical kernel definitions (excluding source locations) and live buffers
sorted by ID, each containing only `id`, `type`, `count`, and committed `data`.
It excludes task traces, handles, owner identities, and GPU cache revisions.
Definitions bind graph content, types, counts, workgroup sizes, bindings, and
parameter defaults; record key order and original kernel order do not matter.

Restore preflights the entire payload before touching live state. Success
rebuilds buffers under a new owner identity, resets revisions, clears terminal
task history, and releases old executor resource keys. All previous buffer/task
handles are invalid; use `resolve(id)` again. Independent snapshots and restored
values do not alias owner state. Canonical snapshots compare equal after an
unmodified restore even though identities and cache revisions change.

`replaceExecutor(undefined)` cancels unfinished work, disposes the previous
executor, and keeps committed CPU values, names, handles, and revisions. A later
replacement uploads those values through normal requests. Replacement/disposal
invalidates old asynchronous continuations. Reusing the same executor releases
its old keys instead of disposing it. Cleanup exceptions are contained and
counted in `inspect().cleanupErrors` so cleanup cannot partially break restore.

## Evidence And Boundaries

Focused tests use a controllable private executor, not GPU emulation evidence.
The owner imposes JS array/count validity, not the historical 65536 limit. The
private capabilities callback exposes no adapter limits, so real storage sizes,
workgroup limits, shader bounds/non-finite diagnostics, GPU allocation cleanup,
and device-loss behavior remain the executor's responsibility. Executor validation
must occur before GPU submission; this owner cannot query adapter limits before
queuing through the frozen contract. Extremely large CPU allocations remain
subject to available host memory. A bounded public game integration now verifies
tick feedback, snapshot/restore, replay, native input and device reconstruction;
these results do not constitute complete CAP-17/M3 acceptance.
