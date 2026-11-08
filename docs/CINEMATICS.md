# Cinematic Sequences

`ctx.cinematics` is a fixed-time, code-authored director. It controls camera
poses, entity trajectories, skeletal clips, sound cues, subtitles, transitions
and event markers through the same public `pelican-engine` API used by games.
There is no editor or online service requirement.

## First Sequence

Define once, then play from a game system:

```ts
ctx.cinematics.define({
  id: "intro",
  duration: 4,
  onFinish: "restore",
  tracks: [
    {
      kind: "camera",
      position: [
        { time: 0, value: [0, 2, 6] },
        { time: 4, value: [3, 1.5, 4] },
      ],
      target: [
        { time: 0, value: [0, 1, 0] },
        { time: 4, value: [0, 1, 0] },
      ],
      interpolation: "linear",
    },
    { kind: "subtitle", start: 0.5, end: 3, speaker: "Guide", text: "The gate is open." },
    {
      kind: "transition",
      color: "#000000",
      opacity: [
        { time: 0, value: 1 },
        { time: 0.5, value: 0 },
        { time: 3.5, value: 0 },
        { time: 4, value: 1 },
      ],
    },
  ],
  markers: [{ id: "gate-open", time: 2, payload: { gate: "north" } }],
});
ctx.cinematics.play("intro");
```

Key times use sequence seconds, not frame numbers. Vector channels support
linear, smooth and step interpolation. Quaternion channels use slerp or step;
smooth selects slerp for rotations. Interpolation is provided by Three.js
keyframe interpolants without exposing its objects to game code.

One sequence owns the director at a time. `list()` returns defined IDs;
`undefine(id)` requires that the sequence is inactive. `state()` returns the
active ID, time, cycle, speed, status and diagnostic. `presentation()` returns
detached subtitle and transition data. The browser renderer displays them above
the game canvas, using text content rather than HTML insertion.

## Actors And Animation

A transform track contains `entity`, optional `position` keys and optional
`rotation` quaternion keys. It binds a live non-physical root or 3D character.
Direct rigid-body and 2D-body trajectory control is rejected rather than silently
teleporting a simulated body every frame.

Normal character trajectory playback submits displacement to the character
controller, preserving blocking collisions. The scripted vertical trajectory
cancels the character's ordinary gravity contribution for that tick. A blocked
character may not reach the authored point. Explicit timeline seeks relocate a
physical binding through `physics.teleport`, updating native queries and World
state together. `physics.teleport(entity, patch, { resetVelocity })` is also a
public discontinuous relocation command, with recorded reconstruction history.

```ts
// Add these to a sequence's tracks after declaring and preparing the model.
const tracks = [
  { kind: "animation", entity: "actor", clip: "Walk", start: 0, end: 4, loop: true },
  {
    kind: "transform", entity: "actor",
    position: [
      { time: 0, value: [0, 0, 0] },
      { time: 4, value: [0, 0, 3] },
    ],
  },
] as const;
```

Skeletal intervals may not overlap on the same entity. Gaps hold the preceding
clip pose; before the first interval the captured pose is held. `sourceStart`
and signed `speed` select source-clip time, and `loop` controls clip wrapping.
Seeking samples poses without generating locomotion or replaying old markers.

For authored locomotion instead of an entity trajectory, configure the actor's
root motion with `mode: "apply"` and set `rootMotion: true` on its animation
track. Ordinary animation tracks do not generate root motion by default. A
transform track and root-motion locomotion cannot both own the same actor.
See [Skeletal Animation](ANIMATION.md) for extraction and IK details.

The director captures base/blend/additive/IK/root-motion state before taking
animation ownership. Ordinary animation mutators report
`TC_MODEL_CINEMATIC_OWNER` while that actor is controlled. The production model
system consumes timeline-generated locomotion before native physics. Game input
systems should also yield ordinary movement while `cinematics.state().id` is
non-null; the director does not disable unrelated game input or world simulation.

## Sound And Subtitles

Audio tracks select a declared `sound`, `start`, `end`, optional `sourceStart`,
`rate`, `volume`, `loop`, spatial `entity`, `bus`, `priority` and `occlusion`.
Sequence speed multiplies source rate. Each cue owns only the voice it creates;
stopping or branching does not stop unrelated game voices. Normal audio priority
and global voice-capacity rules still apply.

Audio source positioning and rates are also public:

```ts
const voice = ctx.audio.play("narration", { offset: 1, playbackRate: 1 });
ctx.audio.seek(voice, 2.5);
ctx.audio.setPlaybackRate(voice, 1.25);
const sourceSeconds = ctx.audio.voice(voice)?.position;
```

Position/rate changes retain the current source cursor and do not reset elapsed
`maxDuration` accounting. Pausing freezes the source cursor. Renderer voice
revisions recreate a buffer source at its logical position; playback rate is
applied to Web Audio. Browser gesture requirements remain in force.

Subtitle tracks select either literal `text` or localization `key`, with optional
`variables` and `speaker`. They use half-open `[start,end)` intervals. Locale
changes resolve through the existing localization service. Up to four subtitles
may be active together. The owned overlay wraps text and exposes it as a polite
live region; it does not overwrite authored game UI elements.

The optional transition track interpolates opacity in `[0,1]` over a six-digit
hex color. It is a screen overlay, not a change to scene lighting or tracing.
Its lifetime is the current gameplay presentation; persistent fades spanning
asynchronous scene replacement are not implemented by this owner.

## Branch, Pause And Skip

`pause()` freezes director time and its voices, not the world. `resume()` resumes
that clock. `setSpeed(speed)` supports positive multipliers subject to the audio
rate range. `seek(time)` samples a new point without firing skipped markers;
use `stop()` to release control or seek to the sequence end for a final pose.

Markers emit `cinematic.marker` with sequence, marker ID, time, cycle and payload.
Game code can handle a marker in `postPhysics`, pause for a dialogue choice, and
call `play("chosen-branch")` to select the next sequence. Starting a new sequence
releases the preceding sequence's bindings first. Branch decisions are ordinary
game code, not an embedded scripting language or runtime AI.

The director also emits `cinematic.started`, `cinematic.completed`,
`cinematic.stopped` and `cinematic.bindingLost`. Markers at an interval end fire
once, and loop-start markers fire once per new cycle. Seeking does not replay
them. Keyed actor motion and subtitles are sampled from the selected sequence.

`onFinish: "restore"` releases control on the following fixed tick after the
final pose; `"hold"` retains control until `stop()` or another `play()`.
By default `stop()` restores captured animation and camera control, resumes the
captured character velocity, and leaves actor positions at the performed result.
Use `stop({ restoreTransforms: true })` to explicitly restore controlled actor
transforms. Audio-only spatial bindings are never moved by that option.

## Snapshots And Limits

Snapshots retain definitions, director time/status, captured actor state, camera
control and owned voice IDs. Preflight checks World bindings, model baselines,
held animation, audio cue ownership/rates, 2D-body conflicts and the sampled
camera pose before host mutation. Successful restoration reclaims animation
ownership before returning to game code. A removed/replaced binding is not
silently rebound to a new entity with the same ID.

An ordinary fixed-tick binding loss stops the sequence and releases its other
owners. Saving while a binding is stale reports a diagnostic until the director
advances or is stopped. A partial operation failure faults the director; recover
a known-good host checkpoint or restart the scene. A partial native failure also
faults the physics owner. These are recovery mechanisms, not verified safety
or process/memory isolation guarantees for all owners.

Current bounds are 128 definitions, 256 tracks per definition, 4096 keys per
channel, 4096 markers, 32 simultaneous sequence voices, four simultaneous
subtitles and at most 256 sequence wraps per fixed tick. Sequence duration and
source offsets/intervals are bounded to one day. Combined audio rates stay in
`[0.01,16]`. Normal root-motion loop and numeric limits also apply.

This development implementation has only been compiled and built. Rendering,
caption layout/accessibility, sound output, audio/video alignment, branching,
character blocking, snapshots, cleanup and failure recovery have not been run
or validated. Full engine 1.0 integration and acceptance are still unfinished.
