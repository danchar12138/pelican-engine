# Postprocess CPU Ownership

`src/postprocess.ts` owns CPU state for ordered compiler `PostProcessIR`
definitions. `createPostProcessOwner(definitions = [])` returns `service`,
`states`, `historyRevisions`, `snapshot`, `validateSnapshot`, `restore`,
`dispose`, and `inspect`. No renderer, GPU resource, frame, or tick is owned here.

The gameplay service is `RenderService.effects`: `configure(id, { enabled })`,
`state(id)`, `setParameter(id, name, value)`, and `resetHistory(id?)`.
Configuration accepts exactly one boolean `enabled` field. Parameters reuse the
material-parameter owner for all five graph types, strict finite-f32 validation,
dense vectors, and detached values. Invalid operations leave state, revisions,
and history requests unchanged. Returned states and history records are detached
and frozen; snapshots are detached mutable plain data.

## History

Each declared pass starts at history revision zero. The renderer-private
`PostProcessOwnerView` exposes ordered states and per-pass history revisions.

- Changing enabled state bumps **all** history revisions, including disabled
  passes, to invalidate dependent feedback. Reapplying the same flag is a no-op.
- Parameter changes do not clear history. Gameplay may explicitly reset it.
- `resetHistory(id)` validates the ID and bumps only that pass;
  `resetHistory()` bumps all passes.
- Every successful restore bumps all history revisions, even if semantic CPU
  state did not change. Validation alone never bumps revisions.

Revisions are clear requests, not GPU image snapshots. The renderer must observe
them and clear its images; actual history storage, disabled-pass history freeze,
successful-presentation advancement, and device/mode rebuilds are renderer work.
The CPU owner does not reset trace accumulation or other game state.

## Snapshots

Nonempty owners emit version 1 `{ version, definitions, states }`. Definitions
bind the ordered pass IDs, initial enabled flags, and complete compiled graphs,
including parameter declarations/defaults and channel dependencies. Source
locations are excluded. Record keys and parameter declarations are canonicalized;
pass order and graph node order remain significant. Graph structure is compiler
validated and cannot be replaced through the service. Current enabled flags and
parameter values are semantic state; inspection counters, history revisions,
and GPU images are deliberately absent.

Preflight checks the entire snapshot before changing any CPU state or history
revision. Missing, extra, duplicate, reordered, foreign, malformed, or non-f32
state is rejected. Only snapshots for identical canonical definitions restore.
Empty owners emit `undefined` and only accept `undefined` on validation/restore.
Disposal is idempotent; all other operations reject after disposal.

## Render Integration

`createRenderSettingsDriver(initial, materials, capabilities, postProcesses?)`
preserves the first three arguments. Its `.postProcesses` is the private CPU
owner and `.service.effects` is that owner's gameplay service. Render plugin
snapshots include `postProcesses` only for nonempty definitions, preserving the
legacy snapshot shape otherwise. Restore preflights render settings, material
parameters, and postprocess state before applying changes. Both plugin and driver
disposal dispose the owner, including retained effects-service references.

Diagnostics include a stable code, pass/parameter context and `Repair:` advice:
`TC_POSTPROCESS_DEFINITION`, `TC_POSTPROCESS_ID`, `TC_POSTPROCESS_CONFIGURE`,
`TC_POSTPROCESS_PARAMETER`, `TC_POSTPROCESS_PARAMETER_VALUE`,
`TC_POSTPROCESS_SNAPSHOT`, and `TC_POSTPROCESS_DISPOSED`.

Focused coverage: `npx tsx --test tests/postprocess-owner.test.ts
tests/render-settings.test.ts tests/material-parameters.test.ts`.
This CPU work does not establish GPU, browser, or complete M3 acceptance.
