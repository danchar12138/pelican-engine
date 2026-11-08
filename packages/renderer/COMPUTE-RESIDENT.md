# Renderer-private resident compute results

`createComputeExecutor(device)` implements the private runtime executor hooks and
`ComputeResidentSource` from `src/compute-view-contract.ts`. Native `GPUBuffer`
views stay inside the renderer. They are never public SDK values, serialized
state, or Three-owned attributes.

## Run, validate, then commit

With `output.retain` omitted or `false`, `run` keeps its existing behavior: return
CPU values, cache CPU inputs, and destroy all temporary dispatch/output/readback
buffers. A supplied retain value must be a boolean; explicit `undefined` remains
compatible with omitted optional fields.

With `output.retain: true`, the output stays temporary until shader compilation,
pipeline creation, dispatch, fault/readback decoding, all GPU error scopes, and
packed output validation succeed. The vec4 bytes must match the returned typed
CPU values, including bool encoding and unused lanes. Only then does the executor
remove that output buffer from temporary cleanup and record a pending candidate.
The candidate's packed bytes are independent of the returned CPU array.

A pending candidate is invisible to both renderer views and compute inputs.
After validating the CPU result, the runtime owner calls `commit(key, revision)`.
Commit requires the correct candidate key, a live un-aborted signal, unchanged
resource type/count, and a safe nonnegative integer revision greater than every
known revision for that resource and the revision captured when the run began.
It stages a new version map before publication. Commit performs **no GPU calls,
CPU uploads, GPU copies, or asynchronous validation**. The already validated
output buffer becomes the committed version.

There is at most one pending candidate per key. Starting another accepted run for
the same output replaces its uncommitted candidate. `discard(key)` is idempotent,
cancels active work involving that key, and destroys only its pending candidate.
An aborted pending signal also destroys the candidate. Successful commit removes
the pending signal listener; later discard or signal abort cannot destroy the
committed output. Invalid commits preserve the candidate and previous versions.

## Exact versions and CPU uploads

Every input descriptor is validated and packed into vec4 f32 storage before GPU
use. Logical keys preserve type and count until release. Exact revision matches
must have identical packed bits, including signed zero. Different JS numbers
that round to the same f32 are equivalent. Regressing to an unknown older revision
is rejected; exact retained history remains readable.

Both dispatch inputs and `resident(input)` first use the exact committed
key/revision, then the exact CPU input cache. Computed feedback therefore binds
the existing committed output buffer without `queue.writeBuffer`. A new dispatch
always has a separate output buffer and never overwrites a committed version.
Multiple committed versions remain alive for dispatches queued in the same tick
with previously captured input revisions.

`resident(input)` returns `{ buffer, type, count, revision }`. If no exact GPU
source exists, its CPU descriptor represents initialization, an explicit CPU
write, a restored checkpoint, or device reconstruction. The executor uploads that
snapshot once and caches it. A changed CPU snapshot stages a replacement cache
buffer; synchronous creation/upload failure leaves the previous cache intact.
Ordinary `run` cache updates preserve the established reuse/upload behavior.
CPU-uploaded storage uses `STORAGE | COPY_SRC | COPY_DST`, so either path can
supply renderer GPU copies. Committed compute output uses `STORAGE | COPY_SRC`.

The renderer borrows a view only while recording/submitting a GPU copy into
Three's separately owned, stable vec4 storage attribute. Do not retain a view
across collection, release, executor replacement, disposal, or device loss. Do
not hand executor-owned buffers to Three for ownership or destruction.

## Collection and ownership

After the entire compute flush finishes, the owner calls
`collect([{ key, revision }, ...])` with every live resource's current revision
and every unreleased successful task's exact output revision. Multiple revisions
for one key are valid; duplicate key/revision pairs are rejected. The owner
deduplicates shared current/task revisions before calling this hook.
The executor validates the complete list before mutation and rejects collection
during a dispatch. Collection destroys committed history other than the supplied
retained versions, removes absent/stale CPU input entries, and preserves exact
current CPU cache entries that have no committed replacement. This prevents
re-uploading unchanged initial inputs after every flush. Pending candidates are
left to commit/discard. Calling collect before queued consumers finish violates
the owner protocol, even between individual dispatches. Releasing terminal task
records collects obsolete versions when the executor is idle. Tasks still run
sequentially with per-node readback; this is not batched GPU-only execution.

`release(key)` cancels work involving the key and destroys its pending candidate,
all committed versions, and cached CPU input. Other keys remain owned.
`dispose()` and device loss cancel active work and destroy all keys and temporary
buffers. Every owned native buffer is destroyed once. Late compilation, pipeline,
map, or scope completion after cancellation/timeout/loss cannot allocate or
publish a candidate. A replacement executor recreates GPU inputs from validated
CPU checkpoints; physical GPU identity is never restored from serialized state.

## Diagnostics and focused validation

`inspect()` exposes current counts (`pendingCandidates`, `committedVersions`,
`cachedInputs`, `liveBuffers`, `cachedPipelines`), cached CPU-input bytes
(`cachedBytes`), committed GPU bytes (`residentBytes`), and cumulative counters:

- `retentions`: successfully validated outputs retained as candidates.
- `commits`: successful metadata promotions.
- `residentHits`: exact committed versions selected by a dispatch or renderer.
- `inputCacheHits`: exact CPU-uploaded cached snapshots reused by either path.
- `uploads`: total successful CPU data uploads, equal to `inputUploads` plus
  `checkpointUploads`; parameter and fault-buffer writes are excluded.
- `inputUploads`: normal dispatch input cache uploads.
- `checkpointUploads`: uploads initiated by `resident` for CPU descriptors.
- `allocations` and `dispatches`: cumulative native allocations and submissions
  of managed compute work. Renderer-owned attribute copies are outside executor
  ownership and must be counted by the renderer bridge.

The focused CPU fixtures in `tests/compute-resident.test.ts` exercise ownership,
metadata publication, exact packed snapshots/history, collection, upload paths,
validation, cancellation/timeouts, and cleanup. They inject readback and model
GPU commands; they do not evaluate WGSL or establish real GPU/rendering/performance
evidence. The existing 35 executor tests remain the compatibility baseline.

Project-local validation command:

```sh
.\node_modules\.bin\tsx.cmd --test tests/compute-executor.test.ts tests/compute-resident.test.ts
```

Real GPU numeric and compute-to-render integration, consolidated root typecheck,
full M3/performance matrices, and packaging remain with main integration under
D49. This private executor change does not constitute full M3 acceptance.
