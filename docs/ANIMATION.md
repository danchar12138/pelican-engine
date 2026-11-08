# Skeletal Animation

The public `ctx.animation` service owns clip playback, blending, additive layers,
IK, generated retargeted clips and root-motion extraction. Games use bone and
asset names, not Three.js skeletons or mixer objects.

## Inverse Kinematics

```ts
ctx.animation.setIK("actor", {
  id: "left-leg",
  effector: "LeftFoot",
  chain: ["LeftLowerLeg", "LeftUpperLeg"],
  target: [-0.15, 0.1, 0],
  pole: [-0.4, 0.7, 0.8],
  orientation: [0, 0, 0, 1],
  orientationWeight: 0.8,
  weight: 1,
  iterations: 12,
  maxAngle: Math.PI / 6,
  jointLimits: [{
    bone: "LeftLowerLeg",
    rotationMin: [-Math.PI, 0, 0],
    rotationMax: [0, 0, 0],
    hingeAxis: [1, 0, 0],
  }],
});
```

Targets, poles and effector orientation use model-root coordinates, before the
model's authored offset/scale/rotation and the entity transform. Chains list
immediate parents starting at the effector. Bone names must be unique and all
links must belong to one skinned mesh. `animation.bones(entity)` lists names.

Each chain supports local XYZ rotation bounds, normalized hinge axes, disabled
links, iteration/step limits, weight and optional effector orientation blending.
A pole controls the bend plane of a two-link limb. Disabled links prevent the
pole correction from changing that limb. The CCD solver and its constraints run
over the mixed base/additive pose; IK is not accumulated into the next tick's
base pose. Multiple chains run in stable ID order and snapshots retain their
definitions.

These are skeletal kinematic constraints, not physical joints. Overlapping chains
can affect each other's targets. Games supply targets and poles; the grounding
controller below can coordinate the feet and body after native physics.

## Grounding and Body Adjustment

Create both leg IK chains first, then enable grounding using their IDs:

```ts
ctx.animation.setGrounding("actor", {
  body: "Hips",
  chains: ["left-leg", "right-leg"],
  probeUp: 0.5,
  probeDown: 1,
  soleOffset: 0.03,
  maxBodyOffset: 0.35,
  response: 16,
  plantDistance: 0.2,
  minGroundNormalY: 0.5,
});
const stance = ctx.animation.grounding("actor");
const movement = ctx.animation.motionFeedback("actor");
```

The body must be a uniquely named ancestor of the selected effectors. Up to eight
existing chains share a bounded vertical body correction. Downward production
physics queries include editable terrain, ignore the actor and triggers, and
orient effectors to contact normals. Stance anchors on live entities use support
local coordinates; generation changes detach the reference instead of inheriting
the replacement's identity. World Y is up; probe distances, offsets and planting
distance are world units. Response is an exponential per-second adjustment rate.

The final body and IK pose is evaluated after physics, without advancing the
animation mixer a second time. Ordinary character root-motion playback uses the
actual horizontal displacement along its requested direction to scale this
tick's action-time interval. `motionFeedback` exposes requested/actual world
displacement and a stride scale in [0,1]. Cinematic ownership preserves timeline
time instead of applying ordinary locomotion retiming.

Snapshots retain grounding definitions, body offset, targets, normals, support
anchors and movement feedback. Restore reapplies the saved pose without stepping
physics or sampling new ground. Disable with `setGrounding(entity, null)` before
removing a participating IK chain or separating a planted cross-chunk dependency.
This is a coordinated kinematic controller, not dynamic center-of-mass balance,
ragdoll control or an arbitrary-gravity controller. Grounded entities must be roots.

## Retargeting

```ts
ctx.animation.retarget("actor", {
  name: "imported-walk",
  sourceAsset: "source-character",
  sourceClip: "Walk",
  hip: "SourceHips",
  scale: 1,
  fps: 30,
  bones: {
    Hips: "SourceHips",
    Spine: "SourceSpine",
    LeftUpperLeg: "SourceLeftUpperLeg",
    LeftLowerLeg: "SourceLeftLowerLeg",
    LeftFoot: "SourceLeftFoot",
  },
});
ctx.animation.play("actor", "imported-walk");
```

The source model must be a declared, prepared model asset. `bones` maps target
names to source names, including the source hip. The engine samples isolated
skeleton clones through Three.js SkeletonUtils, applies bind-pose orientation
offsets and scales hip translation relative to the target bind position. It does
not modify source/template/live skeletons during clip generation.

Generated clips participate in ordinary playback, fades, blends, additive masks
and root motion. Names cannot replace authored or existing generated clips.
`retargetedClips(entity)` returns their descriptors.
`removeRetargetedClip(entity, name)` removes an unused generated clip; a clip
still present in base/fade/additive playback is rejected.

Each model currently needs one unambiguous skeleton. Mapping supports 1..512
distinct bones; sampling supports 1..120 FPS and at most 2,000,000 bone frames
per generated clip. At least two frames are required. A model may retain at most
64 generated clips. Generation is synchronous CPU work and its cost is unmeasured.
Snapshots retain source/mapping descriptors and regenerate clips from already
prepared assets; snapshots cannot fetch arbitrary new assets or inject raw tracks.

## Root Motion

```ts
ctx.animation.setRootMotion("actor", {
  bone: "Root",
  axes: [true, false, true],
  rotation: "yaw",
  mode: "apply",
});
```

Root motion samples the clip's own interpolants. Repeated clips accumulate a
rigid cycle transform across loop boundaries, including reverse playback and
multiple loops within a tick. Base, fade, blend and additive action weights
contribute to motion. Translation channels and yaw/full rotation are removed
from the visual root bone before IK, avoiding double application.

The root must be a uniquely named top-level skeleton bone. Clips that also
animate that bone's ancestors are rejected; bake locomotion onto the chosen root
bone. Its ancestors need positive uniform scale. Position channels use the root
bone's parent frame; returned deltas use model-root coordinates. Large per-tick
intervals crossing more than 1024 cycles fail explicitly.

`apply` is supported for non-physical root entities and character controllers
with positive uniform entity scale. Model offset, rotation, scale and pivot are
included when converting motion to the entity frame. Character displacement
goes through `physics.moveCharacter`, so blocking collision may limit motion;
there is no silent teleport around a blocker. Direct rigid-body application is
rejected. Use extraction to implement a game's own physical movement policy:

```ts
ctx.animation.setRootMotion("actor", { bone: "Root", mode: "extract" });
const motion = ctx.animation.consumeRootMotion("actor");
```

`rootMotion(entity)` inspects configuration and pending movement without
consuming it. `consumeRootMotion(entity)` returns and clears that pending rigid
delta. Disabling the feature uses `setRootMotion(entity, null)`. Seek and pose
refresh do not generate locomotion; paused models do not advance it. Pending
movement is part of the model snapshot.

Production model evaluation runs in the physics phase before the native physics
system. Base game updates can choose clips first, and applied character motion
is available to that same native tick. Games consuming extracted movement can
read it in `postPhysics`; consuming it in an earlier phase reads the preceding
evaluation's accumulated movement.

## Verification

Use the installed SDK signatures and capability catalog for the current contract.
Validate clip/skeleton compatibility, blocking movement, snapshot restoration and
cleanup with the game's actual assets. Repository tests cover specific cases,
not every skeleton, animation or device. Director integration is described in
[Cinematic Sequences](CINEMATICS.md).
