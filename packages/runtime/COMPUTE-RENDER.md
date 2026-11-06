# Compute resources for render peers

The CPU owner in `src/compute-service.ts` implements the frozen private
`src/compute-contract.ts` boundary. The returned driver supplies two engine-only
methods in addition to its existing service and lifecycle methods:

- `resource(id: string): ComputeExecutionInput` returns exactly
  `{ key, type, revision, values }` for the last committed CPU checkpoint. Each
  call detaches and deeply freezes its plain data, including vector components.
  It exposes no executor, GPU resource, handle, or mutable owner state. Keys
  remain `compute:<owner>:<index>:<generation>` and survive CPU writes and
  executor replacement. Slot reuse changes the generation; restore changes the
  owner and resets checkpoint revisions to zero.
- `setRenderPins(ids: readonly string[]): void` replaces the complete multiset
  of logical render references. Duplicate IDs count as independent references;
  replacing two occurrences with one still pins the buffer. The driver stores
  a private count per ID, validates the entire dense plain array of nonempty
  strings before changing counts, and retains no caller array. Invalid input
  raises `TC_COMPUTE_BUFFER_NAME` and leaves the previous references intact.

These methods do not appear on the public `ComputeService`.
`describeBuffer` continues returning only `{ id, type, count, revision }`.
`readBuffer` remains a detached CPU read and ordinary writes remain subject to
unfinished-task locks. Reading a resource during work returns the previous
committed checkpoint.

The render peer supplies logical IDs from all active bindings whenever its
bindings change. A pinned public `releaseBuffer` raises
`TC_COMPUTE_BUFFER_IN_USE` before removing any name, recycling any index, or
calling executor release, including when that buffer also has unfinished work.
Unbinding every reference permits the existing busy/handle checks and release
behavior. Pinning does not stop compute dispatch or explicit writes to an idle
buffer.

Pins deliberately accept IDs that are not currently present. Host owns cross
plugin preflight; after that succeeds, render may restore its references before
compute restores the matching buffers. Compute restore preserves these logical
counts while replacing physical identities. Neither pin counts nor physical
keys enter compute snapshots. Render must resolve each logical ID again after
restore. Dispose clears pins with the other CPU registries. A subsequent
`setRenderPins([])` is safe for peer teardown; a nonempty set after disposal
raises `TC_COMPUTE_DISPOSED`.

`options.buffers` optionally supplies the SDK `ComputeBufferInput` definitions
used to establish checkpoints before the driver is returned. Definitions pass
through the same `createBuffer` validation, duplicate-name, finite-value,
count, copying, and default-zero rules as runtime creation. All five graph
types are supported without an executor or capability query. Absent or empty
definitions work with empty kernels and no executor. Any construction failure
returns no driver; all partially built CPU state becomes unreachable, and the
transferred executor is disposed once if present. A disposal failure cannot
replace the original construction/validation error. Initial creation starts no
executor work and allocates no GPU objects.

Dispatch captures immutable input values and revisions immediately. Multiple
dispatches in one tick therefore preserve their original inputs even when
later FIFO executions follow an earlier output commit. Output requests contain
`retain: true` only if the dispatch executor has a callable `commit` hook;
executors without it keep the original `{ key, type, count }` output shape.
The runner publishes a task in this order:

1. Await the executor result while racing cancellation. Observe late promise
   rejection even when an executor ignores abort.
2. Check task activity and epoch, validate every result value and the exact
   output count, and check activity again before publication.
3. Call `runner.commit(key, output.revision + 1)` when implemented. CPU values
   and revision still describe the previous checkpoint during this call.
4. If still active, publish the complete validated CPU array and next revision,
   mark success, and release task locks.
5. Always invoke `runner.discard?.(key)` in `finally` for every execution that
   started, including cancellation, stale epochs, malformed results, thrown
   execution/publication, and success. Discard must be idempotent and safe
   after commit, release, or executor disposal. Cancelled queued work never
   starts an executor candidate and needs no discard.

A thrown commit fails the task and preserves the old CPU values/revision.
Invalid output fails with `TC_COMPUTE_RESULT` before commit. Cancellation,
executor replacement, and disposal invalidate publication and release busy
locks without waiting for an uncooperative executor. Generation keys keep late
work separate from a reused slot. The executor remains responsible for respecting
abort and cleaning any native work that finishes after cancellation.

After the FIFO drains, including an initially empty flush, the current executor
receives `collect?.([{ key, revision }, ...])` with every currently live CPU
buffer and its current committed revision. Missing logical pin targets are not
resources. Collection occurs after all captured input versions have finished;
calling it between tasks would invalidate same-tick reads. Disposal skips
collection; executor replacement collects using the new executor and current
CPU checkpoints.

Discard, collect, release, and executor disposal are cleanup operations. Their
exceptions increment `inspect().cleanupErrors`. In particular, a failed collect
leaves already committed tasks succeeded and lets `flush` resolve; callers can
observe the cleanup failure through the counter. A later flush attempts
collection again. Cleanup failures cannot replace result validation or commit
failure diagnostics. The counter is cumulative for the driver's lifetime.

Focused Windows CPU verification:

```powershell
node_modules/.bin/tsx.cmd --test tests/compute-render-owner.test.ts tests/compute-service.test.ts
```

This covers initial definitions, private resource isolation, logical references,
restore, publication ordering/failures, discard and collect behavior, FIFO
snapshots, cancellation, stale epochs, late promises, and slot reuse. It does
not establish GPU residency/copy correctness or Host/render integration; those
remain the responsibility of the integrating peers and their scoped checks.
No full M3, GPU, performance, installation, or package validation is implied.
