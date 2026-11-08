import * as THREE from "three/webgpu";
import { clone as cloneSkeleton } from "three/addons/utils/SkeletonUtils.js";
import type { AnimationRootMotionDefinition, AnimationRootMotionDelta, AnimationRootMotionState } from "../../sdk/src/index.ts";

type Track = THREE.KeyframeTrack & { createInterpolant(): THREE.Interpolant };
export interface RootMotionSample { clip: THREE.AnimationClip; action: THREE.AnimationAction }
const fail = (code: string, detail: string): never => { throw new Error(`TC_MODEL_ROOT_MOTION_${code}: ${detail}`); };
const identity = (): AnimationRootMotionDelta => ({ translation: [0, 0, 0], rotation: [0, 0, 0, 1] });
function bone(root: THREE.Object3D, name: string): THREE.Bone {
  const found: THREE.Bone[] = [];
  root.traverse(node => { if (node instanceof THREE.Bone && node.name === name) found.push(node); });
  if (found.length !== 1) return fail("BONE", `Root bone '${name}' is missing or ambiguous.`);
  for (let parent = found[0].parent; parent && parent !== root; parent = parent.parent) if (parent instanceof THREE.Bone) return fail("BONE", "Root motion must select a top-level skeleton bone.");
  return found[0];
}
function definition(value: AnimationRootMotionDefinition): Omit<AnimationRootMotionState, "pending"> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !["bone", "axes", "rotation", "mode"].includes(key)) || typeof value.bone !== "string" || !value.bone.trim() || value.bone.length > 256) return fail("DEFINITION", "Provide a named root bone and supported root-motion options.");
  const axes = value.axes ?? [true, false, true], rotation = value.rotation ?? "yaw", mode = value.mode ?? "extract";
  if (!Array.isArray(axes) || axes.length !== 3 || !Array.from(axes).every(v => typeof v === "boolean") || !["none", "yaw", "full"].includes(rotation) || !["extract", "apply"].includes(mode)) return fail("DEFINITION", "Use three boolean axes and supported rotation/movement modes.");
  return { bone: value.bone, axes: [axes[0], axes[1], axes[2]], rotation, mode };
}
function pending(value: AnimationRootMotionDelta): AnimationRootMotionDelta {
  if (!value || !Array.isArray(value.translation) || value.translation.length !== 3 || !Array.from(value.translation).every(v => Number.isFinite(v) && Math.abs(v) <= 1e6) ||
      !Array.isArray(value.rotation) || value.rotation.length !== 4 || !Array.from(value.rotation).every(Number.isFinite) || Math.abs(Math.hypot(...value.rotation) - 1) > 1e-6) return fail("SNAPSHOT", "Pending motion requires a bounded finite translation and normalized quaternion.");
  return { translation: [value.translation[0], value.translation[1], value.translation[2]], rotation: [value.rotation[0], value.rotation[1], value.rotation[2], value.rotation[3]] };
}
function power(value: THREE.Matrix4, count: number): THREE.Matrix4 {
  if (!Number.isSafeInteger(count) || Math.abs(count) > 1024) return fail("CAPACITY", "A root-motion interval may cross at most 1024 loops; reduce the fixed timestep or speed.");
  let base = count < 0 ? value.clone().invert() : value.clone(), exponent = Math.abs(count);
  const result = new THREE.Matrix4();
  while (exponent > 0) { if (exponent & 1) result.multiply(base); exponent = Math.floor(exponent / 2); if (exponent) base.multiply(base); }
  return result;
}

export function createRootMotion(root: THREE.Object3D, value: AnimationRootMotionDefinition, saved = identity()) {
  const config = definition(value), selected = bone(root, config.bone), clone = cloneSkeleton(root), owned = new Set<THREE.Skeleton>();
  const ancestors = new Set<string>();
  for (let node = selected.parent; node; node = node.parent) { ancestors.add(node.name); if (node === root) break; }
  clone.traverse(node => { if (node instanceof THREE.SkinnedMesh) owned.add(node.skeleton); });
  let restPosition: THREE.Vector3, restRotation: THREE.Quaternion, parentLinear: THREE.Matrix3, parentRotation: THREE.Quaternion;
  try {
    for (const skeleton of owned) skeleton.pose(); clone.updateMatrixWorld(true);
    const reference = bone(clone, config.bone);
    restPosition = reference.position.clone(); restRotation = reference.quaternion.clone();
    const parent = new THREE.Matrix4().copy(clone.matrixWorld).invert().multiply(reference.parent?.matrixWorld ?? new THREE.Matrix4());
    const scale = new THREE.Vector3(); parentRotation = new THREE.Quaternion(); parent.decompose(new THREE.Vector3(), parentRotation, scale);
    if (Math.min(scale.x, scale.y, scale.z) <= 0 || Math.max(scale.x, scale.y, scale.z) - Math.min(scale.x, scale.y, scale.z) > 1e-6) return fail("SCALE", "Root-bone ancestors need positive uniform scale for rigid root-motion extraction.");
    parentLinear = new THREE.Matrix3().setFromMatrix4(parent);
  } finally { for (const skeleton of owned) skeleton.dispose(); }
  let accumulated = pending(saved);
  const samplers = new WeakMap<THREE.AnimationClip, (time: number) => THREE.Matrix4>();
  const sampler = (clip: THREE.AnimationClip) => {
    const previous = samplers.get(clip); if (previous) return previous;
    const tracks = new Map<string, THREE.Interpolant>();
    for (const track of clip.tracks) {
      const parsed = THREE.PropertyBinding.parseTrackName(track.name);
      const name = parsed.objectName === "bones" ? parsed.objectIndex : parsed.nodeName;
      if (ancestors.has(name) && ["position", "quaternion", "scale"].includes(parsed.propertyName)) return fail("ANCESTOR", `Clip '${clip.name}' also animates a root-bone ancestor; bake locomotion onto one top-level bone.`);
      if (name !== selected.name || !["position", "quaternion"].includes(parsed.propertyName)) continue;
      if (tracks.has(parsed.propertyName)) return fail("TRACK", `Duplicate root transform track in '${clip.name}'.`);
      tracks.set(parsed.propertyName, (track as Track).createInterpolant());
    }
    const sample = (time: number) => {
      const position = tracks.get("position")?.evaluate(time), rotation = tracks.get("quaternion")?.evaluate(time);
      const p = position ? new THREE.Vector3().fromArray(position) : restPosition.clone(), q = rotation ? new THREE.Quaternion().fromArray(rotation) : restRotation.clone();
      if (![...p.toArray(), ...q.toArray()].every(Number.isFinite) || q.lengthSq() < 1e-20) return fail("NUMERIC", `Invalid root track in '${clip.name}'.`);
      return new THREE.Matrix4().compose(p, q.normalize(), new THREE.Vector3(1, 1, 1));
    };
    samplers.set(clip, sample); return sample;
  };
  const relative = (clip: THREE.AnimationClip, time: number, repeat: boolean) => {
    if (!Number.isFinite(clip.duration) || clip.duration <= 0) return fail("CLIP", "Root motion requires a positive clip duration.");
    const sample = sampler(clip), firstInverse = sample(0).invert();
    if (!repeat) return firstInverse.multiply(sample(Math.max(0, Math.min(clip.duration, time))));
    const loops = Math.floor(time / clip.duration), local = time - loops * clip.duration;
    const cycle = firstInverse.clone().multiply(sample(clip.duration));
    return power(cycle, loops).multiply(firstInverse).multiply(sample(local));
  };
  return {
    definition: config,
    advance(samples: readonly RootMotionSample[], dt: number) {
      if (!Number.isFinite(dt) || dt < 0) return fail("DT", "Root-motion duration must be finite and nonnegative.");
      if (dt === 0) return;
      const translation = new THREE.Vector3(), rotation = new THREE.Quaternion();
      for (const { clip, action } of samples) {
        if (!action.enabled || action.paused || !action.isRunning()) continue;
        const weight = action.getEffectiveWeight(); if (weight <= 0) continue;
        const time = action.time, next = time + dt * action.getEffectiveTimeScale(), repeat = action.loop === THREE.LoopRepeat;
        const delta = relative(clip, time, repeat).invert().multiply(relative(clip, next, repeat));
        const move = new THREE.Vector3(), turn = new THREE.Quaternion(); delta.decompose(move, turn, new THREE.Vector3());
        move.applyQuaternion(restRotation);
        for (let axis = 0; axis < 3; axis++) if (!config.axes[axis]) move.setComponent(axis, 0);
        translation.addScaledVector(move.applyMatrix3(parentLinear), weight);
        if (config.rotation !== "none") {
          if (config.rotation === "yaw") { const yaw = new THREE.Euler().setFromQuaternion(turn, "YXZ").y; turn.setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw); }
          const basis = parentRotation.clone().multiply(restRotation);
          turn.premultiply(basis).multiply(basis.clone().invert());
          rotation.multiply(new THREE.Quaternion().slerp(turn, weight));
        }
      }
      const before = new THREE.Quaternion(...accumulated.rotation), nextTranslation = new THREE.Vector3(...accumulated.translation).add(translation.applyQuaternion(before));
      const nextRotation = before.multiply(rotation).normalize();
      accumulated = pending({ translation: nextTranslation.toArray(), rotation: nextRotation.toArray() });
    },
    strip() {
      for (let axis = 0; axis < 3; axis++) if (config.axes[axis]) selected.position.setComponent(axis, restPosition.getComponent(axis));
      if (config.rotation === "full") selected.quaternion.copy(restRotation);
      else if (config.rotation === "yaw") {
        const relative = restRotation.clone().invert().multiply(selected.quaternion), yaw = new THREE.Euler().setFromQuaternion(relative, "YXZ").y;
        selected.quaternion.copy(restRotation).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -yaw)).multiply(relative).normalize();
      }
    },
    snapshot(): AnimationRootMotionState { return { ...config, axes: [...config.axes], pending: pending(accumulated) }; },
    consume(): AnimationRootMotionDelta { const result = pending(accumulated); accumulated = identity(); return result; },
  };
}
export type ModelRootMotion = ReturnType<typeof createRootMotion>;
