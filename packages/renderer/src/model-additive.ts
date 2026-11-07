import * as THREE from "three/webgpu";
import type { AdditiveAnimationOptions } from "../../sdk/src/index.ts";

export interface AdditiveConfiguration {
  bones?: string[];
  includeChildren: boolean;
  weight: number;
  speed: number;
  loop: boolean;
  startAt: number;
  referenceTime: number;
}

type InterpolatedTrack = THREE.KeyframeTrack & {
  createInterpolant: (() => { evaluate(time: number): ArrayLike<number> }) & {
    isInterpolantFactoryMethodGLTFCubicSpline?: boolean;
  };
};

function fail(code: string, detail: string): never {
  throw new Error(`TC_MODEL_LAYER_${code}: ${detail}`);
}

function boneNames(root: THREE.Object3D): Map<string, THREE.Bone[]> {
  const result = new Map<string, THREE.Bone[]>();
  root.traverse(object => {
    if (!(object instanceof THREE.Bone) || !object.name) return;
    const matches = result.get(object.name) ?? [];
    matches.push(object);
    result.set(object.name, matches);
  });
  return result;
}

export function listAdditiveBones(root: THREE.Object3D): string[] {
  return [...boneNames(root)].filter(([, bones]) => bones.length === 1)
    .map(([name]) => name).sort();
}

function trackBone(root: THREE.Object3D, track: THREE.KeyframeTrack): THREE.Bone | null {
  let path: ReturnType<typeof THREE.PropertyBinding.parseTrackName>;
  try { path = THREE.PropertyBinding.parseTrackName(track.name); }
  catch { return fail("TRACK", `Cannot parse track '${track.name}'; re-export the animation.`); }
  if (!["position", "quaternion", "scale"].includes(path.propertyName) || path.propertyIndex) return null;
  const node = THREE.PropertyBinding.findNode(root, path.nodeName) as THREE.Object3D | null;
  if (path.objectName === "bones") {
    const skeleton = (node as THREE.SkinnedMesh | null)?.skeleton;
    if (!skeleton) return null;
    const bone = skeleton.bones.find(item => item.name === path.objectIndex) ??
      (/^(0|[1-9]\d*)$/.test(path.objectIndex ?? "") ? skeleton.bones[Number(path.objectIndex)] : undefined);
    return bone ?? null;
  }
  return !path.objectName && node instanceof THREE.Bone ? node : null;
}

/** Validate and detach input before changing an instance's mixer. */
export function additiveConfiguration(input: AdditiveAnimationOptions | undefined, duration: number): AdditiveConfiguration {
  if (input !== undefined && (!input || typeof input !== "object" || Array.isArray(input) ||
      Object.keys(input).some(key => !["bones", "includeChildren", "weight", "speed", "loop", "startAt", "referenceTime"].includes(key))))
    return fail("OPTIONS", "Use the documented additive layer options.");
  const value = input ?? {};
  if (!Number.isFinite(duration) || duration <= 0) return fail("CLIP", "The source clip must have a positive finite duration.");
  const weight = value.weight ?? 1, speed = value.speed ?? 1, loop = value.loop ?? true;
  const startAt = value.startAt ?? (speed < 0 ? duration : 0), referenceTime = value.referenceTime ?? 0;
  const includeChildren = value.includeChildren ?? true;
  if (!Number.isFinite(weight) || weight < 0 || weight > 1 || !Number.isFinite(speed) || Math.abs(speed) > 1000 ||
      typeof loop !== "boolean" || typeof includeChildren !== "boolean" || !Number.isFinite(startAt) || startAt < 0 || startAt > duration ||
      !Number.isFinite(referenceTime) || referenceTime < 0 || referenceTime > duration)
    return fail("OPTIONS", "Weight must be in [0,1], speed in [-1000,1000], and times within the clip.");
  if (value.bones !== undefined && (!Array.isArray(value.bones) || value.bones.length < 1 || value.bones.length > 256 ||
      value.bones.some(name => typeof name !== "string" || !name.trim() || name.length > 256) || new Set(value.bones).size !== value.bones.length))
    return fail("BONES", "Provide 1..256 distinct nonempty bone names, or omit bones for all bone tracks.");
  return { ...(value.bones ? { bones: [...value.bones] } : {}), includeChildren, weight, speed, loop, startAt, referenceTime };
}

/** Builds a private additive clip; original model clips remain unchanged. */
export function createAdditiveClip(root: THREE.Object3D, source: THREE.AnimationClip, config: AdditiveConfiguration): THREE.AnimationClip {
  const names = boneNames(root), selected = new Set<THREE.Bone>();
  if (config.bones) {
    for (const name of config.bones) {
      const matches = names.get(name);
      if (!matches || matches.length !== 1) return fail("BONES", `Bone '${name}' is missing or ambiguous; inspect animation.bones().`);
      if (config.includeChildren) matches[0].traverse(object => { if (object instanceof THREE.Bone) selected.add(object); });
      else selected.add(matches[0]);
    }
  } else for (const matches of names.values()) for (const bone of matches) selected.add(bone);
  for (const bone of selected)
    if (bone.name && (names.get(bone.name)?.length ?? 0) > 1)
      return fail("BONES", `Bone '${bone.name}' is ambiguous; rename duplicate bones in the model.`);
  const tracks = source.tracks.filter(track => {
    const bone = trackBone(root, track);
    return bone !== null && selected.has(bone);
  });
  if (!tracks.length) return fail("TRACK", `Clip '${source.name}' has no bone transform tracks in the requested mask.`);
  if (new Set(tracks.map(track => track.name)).size !== tracks.length)
    return fail("TRACK", `Clip '${source.name}' has duplicate bone tracks; re-export it.`);
  const target = new THREE.AnimationClip(source.name, source.duration, tracks.map(track => track.clone()));
  THREE.AnimationUtils.makeClipAdditive(target, config.referenceTime * 30, source, 30);
  // Three converts spline quaternion values but not their tangent quaternions.
  for (const track of target.tracks) {
    const factory = (track as InterpolatedTrack).createInterpolant;
    if (track.ValueTypeName !== "quaternion" || !factory.isInterpolantFactoryMethodGLTFCubicSpline) continue;
    const original = tracks.find(item => item.name === track.name)!;
    const reference = (original as InterpolatedTrack).createInterpolant().evaluate(config.referenceTime);
    const inverse = new THREE.Quaternion().fromArray(reference).normalize().conjugate();
    const tangent = new THREE.Quaternion();
    for (let frame = 0; frame < track.times.length; frame++) for (const part of [0, 8]) {
      const offset = frame * 12 + part;
      tangent.set(track.values[offset], track.values[offset + 1], track.values[offset + 2], track.values[offset + 3]);
      tangent.premultiply(inverse);
      track.values[offset] = tangent.x; track.values[offset + 1] = tangent.y;
      track.values[offset + 2] = tangent.z; track.values[offset + 3] = tangent.w;
    }
  }
  return target;
}
