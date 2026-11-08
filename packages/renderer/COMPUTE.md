# Managed Compute Executor

`src/compute-executor.ts` implements the frozen engine-private `ComputeExecutor`
contract on an engine-owned `GPUDevice`. It imports the typed WGSL lowerer directly,
not `graph.ts`, and never evaluates graphs on the CPU to supply dispatch results.
Only the runtime state owner commits returned values to its CPU mirrors.

## Representation And Validation

- Every input and temporary output is a storage array of padded `vec4f` values.
  Float uses x, bool uses x = 0 or 1, and vectors use their exact declared width.
  Returned arrays contain exactly the kernel count, with no padding components.
- Time and declared parameters occupy a separate uniform array of `vec4f` slots.
  Overrides must be declared, correctly typed, finite and representable as f32.
- Before creating GPU objects, requests are checked for identities, counts,
  workgroups, domains, binding names, input values, type metadata and actual device
  buffer, binding, uniform and dispatch limits. Counts are also bounded by 2^24 so
  every index and array length remains exactly representable by the graph's f32.
- Only arithmetic, time and index domains are accepted. `sampleTexture` and
  material inputs explicitly reject; there is no WebGL or CPU fallback.
- Read helpers check finite, integral, nonnegative, in-range indices before u32
  conversion and indexing. An atomic bit 1 records invalid reads. Readback rejects
  with `TC_COMPUTE_BOUNDS`, even if the shader internally returned a zero placeholder.
- Atomic bit 2 records nonfinite output components; decoding independently checks
  every padded component and rejects with `TC_COMPUTE_NONFINITE`. Bounds take
  precedence if both flags are present. The bounded hardware probe verifies
  runtime overflow diagnostics on the recorded adapter; this is not a claim
  that every untested shader backend handles nonfinite arithmetic identically.

## Ownership And Lifecycle

Named inputs are cached by logical key. Equal revisions require bit-identical
packed f32 contents; changed revisions upload again into the existing storage
buffer. Revisions cannot decrease. A key cannot change type or count until released.
Aliases must describe the same snapshot, and share one buffer/upload. Graph binding
metadata may list only reachable bindings; all kernel declarations still receive
validated explicit bind-group entries.

Compiled pipelines (including their shader/layout dependencies) are cached by the
complete generated trusted WGSL source. Dynamic parameter, time and input data
changes reuse the compiled pipeline. Shader compilation, asynchronous pipeline
creation and their GPU error scopes must succeed before publication, with an
active-request check preventing publication after abort, timeout or device loss.
Disposal and device loss drop all pipeline cache references. Input release does
not discard independently reusable compiled pipelines.

Every dispatch uses a separate temporary output, even when its key equals an input
key. Results are returned only after readback, fault checks and GPU error scopes
succeed. The executor never mutates request values. Failed dispatches evict their
used inputs, so a failed upload cannot look current on retry. Unused cache entries
remain owned until release, device loss or disposal.

The executor accepts one in-flight dispatch; concurrent calls reject with
`TC_COMPUTE_BUSY`. The runtime owner serializes its flush. Abort, a 10-second
deadline, active-resource release, disposal and device loss reject without waiting
for uncancellable GPU promises. Temporary/readback buffers are destroyed, and
active guards prevent late allocations or return of stale results. Scope pushes
and pops stay within synchronous sections to avoid interleaving another device
user's error-scope stack across awaits. One loss subscription serves the executor.

`release(key)` destroys a cached input and cancels work using that input/output key.
`dispose()` is idempotent, cancels active work and destroys cached inputs, without
destroying the caller-owned device. `inspect()` is renderer-private ownership
telemetry: cached inputs/bytes and pipelines, live buffers, cumulative allocations/uploads/
dispatches, activity and terminal state. It is not SDK API or performance evidence.

## Focused Verification

```sh
npx tsx --test tests/compute-executor.test.ts
npm run typecheck
```

CPU fixtures inject readback bytes rather than execute WGSL. They cover all five
types, packing, separate output, caching, aliases, revisions, preflight limits,
fault priorities, malformed requests, unsupported domains, GPU failures and late
promise behavior across abort, timeout, release, disposal and loss.

Only after the main agent grants the exclusive hardware slot:

```sh
npx tsx tools/managed-compute-gpu-probe.ts --exclusive-gpu --output .pelican/probes/managed-compute-gpu
```

Without the flag, the CLI refuses before starting a server or Chromium. A
serialized main runner can import `runManagedComputeGpuProbe(output: string)`;
the caller owns the exclusive GPU slot, and output is a directory receiving
`managed-compute-gpu.json`. Importing the module never starts GPU work. The
probe uses hardware Chromium WebGPU, rejects fallback/software adapter identities,
compiles graphs through the compiler and runs 20 tiny dispatches: three per type
for arithmetic/feedback/cache reuse, index/time, three invalid bounds cases and one
nonfinite result case. It checks release counts, writes the report and returns it
(the CLI also prints JSON to stdout), then
closes its browser/server/device. This is not M3, full integration, performance,
packaging or release acceptance. Run this only with exclusive GPU ownership;
the public game integration is the separate `npm run probe:compute` entry.
