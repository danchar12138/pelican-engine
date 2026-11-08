# Physics Lifecycle Issue

**Status: native patch integrated; behavior and complete recovery safety unverified.**

Removing certain rigid bodies before the physics world has completed its first normal time step can make the locked Rapier runtime trap during the first later step. The exact reproduction depends on body types and initial island/contact topology. Existing reports include process termination, not only a catchable application error.

## Required behavior

- Body removal remains immediate for public queries and raycasts.
- A later simulation step does not trap or silently skip collision, impulse, sleep, or event processing.
- Snapshot/history recovery preserves existing version-3 snapshot semantics; existing fixtures must not be rewritten to make a candidate pass.
- Untrusted history must not be replayed optimistically in the active WASM instance.
- Creation, removal, same-ID respawn, characters, joints, contacts, rollback, and disposal must preserve their established contracts.

## Investigation boundary

The production 3D adapter now uses a full release build from pinned upstream
source plus the persistent-island bootstrap-order patch. The matching JS/WASM
artifact, source patch, original license and build provenance are included in
the engine and npm package. It is not the instrumented historical lab adapter.
Live initial-removal and deletion-order replay guards have been removed.

This implements the identified native initialization-order correction but does
not prove all history safe. Candidate reconstruction still shares the owner's
WASM module; arbitrary trap isolation and native resource recovery remain open.
The old v3 fixtures are unchanged. Historical reports do not validate this build.

Project policy currently permits compilation/build only and prohibits runtime, browser, GPU, test, performance, and other verification. Therefore this issue remains open until implementation and the required verification are authorized and completed.
