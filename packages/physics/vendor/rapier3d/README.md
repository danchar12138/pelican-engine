# Patched Rapier 3D Runtime

This private engine component is built from Dimforge Rapier commit
`b716d375efc0201003f0cd9ef7168eee0b62c177` (JS bindings 0.21.0).
It is not a separate npm SDK. Apache-2.0 licensing is preserved in `LICENSE`.

`bootstrap-before-observations.patch` moves persistent-island bootstrapping
before removal resolution and sleep-observation collection. Updating island IDs
after collecting observations allowed a first positive step to index stale IDs
after a zero-time topology change. The patch changes the Rust implementation;
it does not delay entity removal, advance hidden simulation time, skip collisions
or replace the native world with visible transforms.

The checked-in `runtime.mjs` contains the full upstream 3D TypeScript bindings
and matching release WASM, not the historical instrumented test adapter.
`build.json` records the pinned input and resulting artifact digests. Normal
engine and npm builds use the same checked-in artifact and need no Rust tools.

Each production physics world and replay candidate gets a fresh JS binding
closure and WebAssembly memory. Only the immutable compiled module is cached.
Shapes, rays, event queues and joint descriptors are created by their owning
world's binding, never transferred between native instances. This requires no
Worker, SharedArrayBuffer, COOP/COEP headers or new player environment setting.

## Rebuild

Maintainers need the pinned source checkout, its locked build dependencies,
Rust with the `wasm32-unknown-unknown` target, wasm-bindgen 0.2.130 and the
upstream `bindings/typescript/rapier-compat` npm build dependencies.
Apply the patch in that source checkout, then run from the engine root:

```sh
node tools/native/build-rapier.mjs <rapier-source-directory> <wasm-bindgen-executable>
```

Set `CARGO_PROFILE_RELEASE_DEBUG=0` and
`CARGO_PROFILE_RELEASE_STRIP=debuginfo` for a release artifact without debug
symbols. `CARGO_TARGET_DIR` may select an external build cache. The builder
compiles and bundles only; it does not run physics scenes or tests.

## Current Boundary

This is a compile-only integration. Native behavior, old v3 byte compatibility,
malicious history handling, long-running memory use and browser integration have
not been validated for this build. Separate native memory isolates a candidate's
Rust allocator/borrow state from the live world, but is not a security sandbox:
history still runs synchronously with bounded input counts and can consume time
and memory. Failed native frees are reported; collection of an abandoned instance
is controlled by the JS/WebAssembly host and is not a measured leak-free guarantee.
Do not treat the historical lab results as acceptance of this artifact.
