import * as THREE from "three/webgpu";
import { CCDIKSolver } from "three/addons/animation/CCDIKSolver.js";
import type { AnimationIKDefinition, AnimationIKJointLimit, AnimationIKState, Vec3, Vec4 } from "../../sdk/src/index.ts";

function fail(code: string, detail: string): never {
  throw new Error(`TC_MODEL_IK_${code}: ${detail}`);
}
function name(value: unknown): value is string {
  return typeof value === "string" && !!value.trim() && value.length <= 256;
}
export function ikTarget(value: unknown): Vec3 {
  if (!Array.isArray(value) || value.length !== 3 ||
      ![0, 1, 2].every(index => typeof value[index] === "number" && Number.isFinite(value[index]) && Math.abs(value[index]) <= 1e6))
    return fail("TARGET", "Target needs three finite model-local coordinates in [-1e6,1e6].");
  return [value[0], value[1], value[2]];
}

interface PreparedIK {
  definition: AnimationIKState;
  mesh: THREE.SkinnedMesh;
  effector: THREE.Bone;
  links: THREE.Bone[];
}

/** Resolve an authored chain without changing the model or its skeleton. */
export function prepareModelIK(root: THREE.Object3D, input: AnimationIKDefinition): PreparedIK {
  if (!input || typeof input !== "object" || Array.isArray(input) ||
      Object.keys(input).some(key => !["id", "effector", "chain", "target", "iterations", "weight", "maxAngle", "jointLimits", "pole", "orientation", "orientationWeight"].includes(key)) ||
      !name(input.id) || input.id.length > 128 || !name(input.effector) || !Array.isArray(input.chain) ||
      input.chain.length < 1 || input.chain.length > 16 || !Array.from({ length: input.chain.length }, (_, index) => name(input.chain[index])).every(Boolean) ||
      new Set([input.effector, ...input.chain]).size !== input.chain.length + 1)
    return fail("DEFINITION", "Provide a unique ID, effector and 1..16 distinct parent bones.");
  const target = ikTarget(input.target), iterations = input.iterations ?? 8, weight = input.weight ?? 1;
  if (!Number.isSafeInteger(iterations) || iterations < 1 || iterations > 32 || !Number.isFinite(weight) || weight < 0 || weight > 1 ||
      (input.maxAngle !== undefined && (!Number.isFinite(input.maxAngle) || input.maxAngle <= 0 || input.maxAngle > Math.PI)))
    return fail("DEFINITION", "Iterations must be in [1,32], weight in [0,1], and maxAngle in (0,pi].");
  const jointLimits: AnimationIKJointLimit[] = [], limited = new Set<string>();
  if (input.jointLimits !== undefined) {
    if (!Array.isArray(input.jointLimits) || input.jointLimits.length > input.chain.length) return fail("LIMIT", "Limits must identify distinct chain bones.");
    for (const limit of input.jointLimits) {
      if (!limit || typeof limit !== "object" || Array.isArray(limit) || Object.keys(limit).some(key => !["bone", "enabled", "rotationMin", "rotationMax", "hingeAxis"].includes(key)) ||
          !input.chain.includes(limit.bone) || limited.has(limit.bone) || (limit.enabled !== undefined && typeof limit.enabled !== "boolean")) return fail("LIMIT", "Limits must identify distinct chain bones and supported fields.");
      const min = limit.rotationMin === undefined ? undefined : ikTarget(limit.rotationMin), max = limit.rotationMax === undefined ? undefined : ikTarget(limit.rotationMax);
      if ([...(min ?? []), ...(max ?? [])].some(value => Math.abs(value) > Math.PI) || (min && max && min.some((value, axis) => value > max[axis]))) return fail("LIMIT", "Euler bounds must be ordered within [-pi,pi].");
      const axis = limit.hingeAxis === undefined ? undefined : ikTarget(limit.hingeAxis);
      if (axis && Math.abs(Math.hypot(...axis) - 1) > 1e-6) return fail("LIMIT", "Hinge axis must be a unit vector.");
      limited.add(limit.bone); jointLimits.push({ bone: limit.bone, ...(limit.enabled === undefined ? {} : { enabled: limit.enabled }), ...(min ? { rotationMin: min } : {}), ...(max ? { rotationMax: max } : {}), ...(axis ? { hingeAxis: axis } : {}) });
    }
  }
  const pole = input.pole === undefined ? undefined : ikTarget(input.pole);
  if (pole && input.chain.length !== 2) return fail("POLE", "Pole targets require a two-link limb.");
  let orientation: Vec4 | undefined;
  if (input.orientation !== undefined) {
    const q = input.orientation;
    if (!Array.isArray(q) || q.length !== 4 || !Array.from(q).every(Number.isFinite) || Math.abs(Math.hypot(...q) - 1) > 1e-6) return fail("ORIENTATION", "Effector orientation must be a normalized quaternion.");
    orientation = [q[0], q[1], q[2], q[3]];
  }
  if (input.orientationWeight !== undefined && (!orientation || !Number.isFinite(input.orientationWeight) || input.orientationWeight < 0 || input.orientationWeight > 1)) return fail("ORIENTATION", "orientationWeight requires an orientation and must be in [0,1].");
  const names = new Map<string, THREE.Bone[]>(), meshes: THREE.SkinnedMesh[] = [];
  root.traverse(object => {
    if (object instanceof THREE.Bone && object.name) {
      const matches = names.get(object.name) ?? [];
      matches.push(object); names.set(object.name, matches);
    }
    if (object instanceof THREE.SkinnedMesh && object.skeleton) meshes.push(object);
  });
  const resolve = (id: string): THREE.Bone => {
    const matches = names.get(id);
    if (!matches || matches.length !== 1) return fail("BONE", `Bone '${id}' is missing or ambiguous; inspect animation.bones().`);
    return matches[0];
  };
  const effector = resolve(input.effector), links = input.chain.map(resolve);
  let child: THREE.Object3D = effector;
  for (const link of links) {
    if (child.parent !== link) return fail("CHAIN", `'${link.name}' must be the immediate parent of '${child.name}'.`);
    child = link;
  }
  const mesh = meshes.find(item => [effector, ...links].every(bone => item.skeleton.bones.includes(bone)));
  if (!mesh) return fail("CHAIN", "All chain bones must belong to the same skinned mesh.");
  return { definition: { id: input.id, effector: input.effector, chain: [...input.chain], target,
    iterations, weight, ...(input.maxAngle === undefined ? {} : { maxAngle: input.maxAngle }),
    ...(input.jointLimits === undefined ? {} : { jointLimits }), ...(pole ? { pole } : {}), ...(orientation ? { orientation, orientationWeight: input.orientationWeight ?? weight } : {}) }, mesh, effector, links };
}

export interface ModelIKRig {
  definition: AnimationIKState;
  links: readonly THREE.Bone[];
  solve(root: THREE.Object3D): void;
  dispose(): void;
}

export function createModelIK(root: THREE.Object3D, input: AnimationIKDefinition): ModelIKRig {
  const prepared = prepareModelIK(root, input), target = new THREE.Bone();
  const bones = [...prepared.mesh.skeleton.bones, target];
  // The proxy shares geometry/material but owns a private, never-rendered skeleton.
  const proxy = new THREE.SkinnedMesh(prepared.mesh.geometry, prepared.mesh.material);
  proxy.skeleton = new THREE.Skeleton(bones, bones.map(() => new THREE.Matrix4()));
  try {
    const solver = new CCDIKSolver(proxy, [{
      effector: bones.indexOf(prepared.effector), target: bones.length - 1,
      links: prepared.links.map(link => {
        const limit = prepared.definition.jointLimits?.find(item => item.bone === link.name);
        return { index: bones.indexOf(link), ...(limit?.enabled === undefined ? {} : { enabled: limit.enabled }),
          ...(limit?.rotationMin ? { rotationMin: new THREE.Vector3(...limit.rotationMin) } : {}), ...(limit?.rotationMax ? { rotationMax: new THREE.Vector3(...limit.rotationMax) } : {}),
          ...(limit?.hingeAxis ? { limitation: new THREE.Vector3(...limit.hingeAxis) } : {}) };
      }),
      iteration: prepared.definition.iterations, blendFactor: prepared.definition.weight,
      ...(prepared.definition.maxAngle === undefined ? {} : { maxAngle: prepared.definition.maxAngle }),
    }]);
    return {
      definition: prepared.definition,
      links: [...prepared.links, prepared.effector],
      solve(owner) {
        const position = new THREE.Vector3(...prepared.definition.target).applyMatrix4(owner.matrixWorld);
        target.matrixWorld.makeTranslation(position.x, position.y, position.z);
        solver.update();
        if (prepared.definition.pole && prepared.definition.weight > 0 && !prepared.definition.jointLimits?.some(limit => limit.enabled === false)) {
          const base = prepared.links[1], middle = prepared.links[0], origin = base.getWorldPosition(new THREE.Vector3());
          const axis = prepared.effector.getWorldPosition(new THREE.Vector3()).sub(origin);
          if (axis.lengthSq() > 1e-20) {
            axis.normalize();
            const bend = middle.getWorldPosition(new THREE.Vector3()).sub(origin), pole = new THREE.Vector3(...prepared.definition.pole).applyMatrix4(owner.matrixWorld).sub(origin);
            bend.addScaledVector(axis, -bend.dot(axis)); pole.addScaledVector(axis, -pole.dot(axis));
            if (bend.lengthSq() > 1e-20 && pole.lengthSq() > 1e-20) {
              bend.normalize(); pole.normalize();
              const angle = Math.atan2(axis.dot(bend.clone().cross(pole)), bend.dot(pole)) * prepared.definition.weight;
              const parent = base.parent?.getWorldQuaternion(new THREE.Quaternion()) ?? new THREE.Quaternion();
              const local = parent.clone().invert().multiply(new THREE.Quaternion().setFromAxisAngle(axis, angle)).multiply(parent);
              base.quaternion.premultiply(local); base.updateWorldMatrix(false, true); solver.update();
            }
          }
        }
        if (prepared.definition.orientation) {
          const parent = prepared.effector.parent?.getWorldQuaternion(new THREE.Quaternion()) ?? new THREE.Quaternion();
          const desired = parent.invert().multiply(owner.getWorldQuaternion(new THREE.Quaternion())).multiply(new THREE.Quaternion(...prepared.definition.orientation));
          prepared.effector.quaternion.slerp(desired, prepared.definition.orientationWeight ?? prepared.definition.weight);
          prepared.effector.updateWorldMatrix(false, true);
        }
      },
      dispose() { proxy.skeleton.dispose(); },
    };
  } catch (error) {
    proxy.skeleton.dispose();
    throw error;
  }
}
