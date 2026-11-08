import * as THREE from "three/webgpu";
import { clone as cloneSkeleton, retargetClip } from "three/addons/utils/SkeletonUtils.js";
import type { AnimationRetargetDefinition } from "../../sdk/src/index.ts";

const fail = (code: string, detail: string): never => { throw new Error(`TC_MODEL_RETARGET_${code}: ${detail}`); };
const name = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0 && value.length <= 256;
export function retargetDefinition(input: AnimationRetargetDefinition): AnimationRetargetDefinition {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(key => !["name", "sourceAsset", "sourceClip", "bones", "hip", "scale", "fps"].includes(key)) ||
      !name(input.name) || !name(input.sourceAsset) || !name(input.sourceClip) || !name(input.hip) || !input.bones || typeof input.bones !== "object" || Array.isArray(input.bones)) return fail("DEFINITION", "Provide clip/asset/hip names and an explicit bone map.");
  const bones = Object.entries(input.bones), scale = input.scale ?? 1, fps = input.fps ?? 30;
  if (!bones.length || bones.length > 512 || bones.some(([target, source]) => !name(target) || !name(source)) ||
      new Set(bones.map(([, source]) => source)).size !== bones.length || !bones.some(([, source]) => source === input.hip) ||
      !Number.isFinite(scale) || scale < 0.001 || scale > 1000 || !Number.isFinite(fps) || fps < 1 || fps > 120) return fail("DEFINITION", "Map 1..512 distinct bones including the source hip; scale must be [0.001,1000], fps [1,120].");
  return { name: input.name, sourceAsset: input.sourceAsset, sourceClip: input.sourceClip, bones: Object.fromEntries(bones), hip: input.hip, scale, fps };
}
function skeleton(root: THREE.Object3D): THREE.SkinnedMesh {
  const meshes: THREE.SkinnedMesh[] = [];
  root.traverse(node => { if (node instanceof THREE.SkinnedMesh && !meshes.some(mesh => mesh.skeleton.bones.length === node.skeleton.bones.length && mesh.skeleton.bones.every((bone, i) => bone === node.skeleton.bones[i]))) meshes.push(node); });
  if (meshes.length !== 1) return fail("SKELETON", "Retargeting requires one unambiguous skeleton per model; split multi-rig assets.");
  return meshes[0];
}
function uniqueBones(root: THREE.Object3D): Map<string, THREE.Bone> {
  const bones = new Map<string, THREE.Bone>();
  root.traverse(node => {
    if (!(node instanceof THREE.Bone)) return;
    if (!name(node.name) || bones.has(node.name)) return fail("BONE", "Bone names must be unique and nonempty.");
    bones.set(node.name, node);
  });
  return bones;
}

/** Sample only isolated skeleton clones; live/template poses and GPU assets are borrowed. */
export function createRetargetedClip(targetRoot: THREE.Object3D, sourceRoot: THREE.Object3D, sourceClip: THREE.AnimationClip, raw: AnimationRetargetDefinition): THREE.AnimationClip {
  const definition = retargetDefinition(raw), frames = Math.round(sourceClip.duration * definition.fps!);
  if (!Number.isFinite(sourceClip.duration) || sourceClip.duration <= 0 || frames < 2 || frames * Object.keys(definition.bones).length > 2000000) return fail("CAPACITY", "Clip sampling must contain at least two frames and at most 2000000 bone frames.");
  const target = cloneSkeleton(targetRoot), source = cloneSkeleton(sourceRoot), owned = new Set<THREE.Skeleton>();
  for (const root of [target, source]) root.traverse(node => { if (node instanceof THREE.SkinnedMesh) owned.add(node.skeleton); });
  try {
    const targetMesh = skeleton(target), sourceMesh = skeleton(source), targetBones = uniqueBones(target), sourceBones = uniqueBones(source);
    targetMesh.skeleton.pose(); sourceMesh.skeleton.pose(); target.updateMatrixWorld(true); source.updateMatrixWorld(true);
    const offsets: Record<string, THREE.Matrix4> = Object.create(null);
    for (const [targetName, sourceName] of Object.entries(definition.bones)) {
      const a = targetBones.get(targetName), b = sourceBones.get(sourceName);
      if (!a || !b || !targetMesh.skeleton.bones.includes(a) || !sourceMesh.skeleton.bones.includes(b)) return fail("BONE", `Missing mapped bone '${targetName}' or '${sourceName}'.`);
      const correction = b.getWorldQuaternion(new THREE.Quaternion()).invert().multiply(a.getWorldQuaternion(new THREE.Quaternion()));
      offsets[targetName] = new THREE.Matrix4().makeRotationFromQuaternion(correction);
    }
    const hipTarget = Object.entries(definition.bones).find(([, sourceName]) => sourceName === definition.hip)![0];
    const hipPosition = targetBones.get(hipTarget)!.getWorldPosition(new THREE.Vector3()).multiplyScalar(1 / definition.scale!).sub(sourceBones.get(definition.hip)!.getWorldPosition(new THREE.Vector3()));
    const clip = sourceClip.clone();
    clip.tracks = clip.tracks.filter(track => {
      const parsed = THREE.PropertyBinding.parseTrackName(track.name), bone = parsed.objectName === "bones" ? String(parsed.objectIndex) : parsed.nodeName;
      return sourceBones.has(bone) && ["position", "quaternion", "scale"].includes(parsed.propertyName);
    });
    if (!clip.tracks.length) return fail("TRACKS", "Source clip contains no named bone transform tracks.");
    const options: NonNullable<Parameters<typeof retargetClip>[3]> & { localOffsets: Record<string, THREE.Matrix4>; preserveBonePositions: boolean } = {
      names: Object.assign(Object.create(null), definition.bones), hip: definition.hip, scale: definition.scale, fps: definition.fps,
      hipPosition, localOffsets: offsets, preserveBonePositions: true, preserveBoneMatrix: false, useTargetMatrix: true,
    };
    const result = retargetClip(targetMesh, sourceMesh, clip, options);
    result.name = definition.name;
    result.tracks = result.tracks.filter(track => Object.hasOwn(definition.bones, String(THREE.PropertyBinding.parseTrackName(track.name).objectIndex)));
    for (const track of result.tracks) {
      const parsed = THREE.PropertyBinding.parseTrackName(track.name), bone = String(parsed.objectIndex);
      if (!targetBones.has(bone) || !Object.hasOwn(definition.bones, bone)) return fail("TRACKS", `Unexpected retargeted bone '${bone}'.`);
      track.name = `${bone}.${parsed.propertyName}`;
      if (Array.from(track.values).some(value => !Number.isFinite(value))) return fail("NUMERIC", `Nonfinite retargeted track '${track.name}'.`);
    }
    if (!result.tracks.length || !Number.isFinite(result.duration) || result.duration <= 0) return fail("TRACKS", "Retargeting produced no usable animation.");
    return result;
  } finally { for (const skeleton of owned) skeleton.dispose(); }
}
