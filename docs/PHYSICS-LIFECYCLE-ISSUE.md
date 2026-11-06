# Physics Lifecycle Issue

**Status: open; not fixed or validated in the current package.**

Removing certain rigid bodies before the physics world has completed its first normal time step can make the locked Rapier runtime trap during the first later step. The exact reproduction depends on body types and initial island/contact topology. Existing reports include process termination, not only a catchable application error.

## Required behavior

- Body removal remains immediate for public queries and raycasts.
- A later simulation step does not trap or silently skip collision, impulse, sleep, or event processing.
- Snapshot/history recovery preserves existing version-3 snapshot semantics; existing fixtures must not be rewritten to make a candidate pass.
- Untrusted history must not be replayed optimistically in the active WASM instance.
- Creation, removal, same-ID respawn, characters, joints, contacts, rollback, and disposal must preserve their established contracts.

## Investigation boundary

Historical reproductions and candidate experiments are retained in the original issue records and local archived work. Some candidates alter native world reconstruction or snapshot bytes and have known compatibility gaps. They are not fixes and must not be merged wholesale. The production Rapier dependency has not been replaced.

Project policy currently permits compilation/build only and prohibits runtime, browser, GPU, test, performance, and other verification. Therefore this issue remains open until implementation and the required verification are authorized and completed.
