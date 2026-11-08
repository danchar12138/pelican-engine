import * as THREE from "three/webgpu";
import type { AnimationGroundingDefinition, AnimationGroundingState, AnimationIKState, Transform, Vec3 } from "../../sdk/src/index.ts";
import type { ModelIKRig } from "./model-ik.ts";

export interface GroundingQueries {
  raycast(origin: Vec3, distance: number): { entity: string; point: Vec3; normal: Vec3 } | null;
  support(id: string): Transform | null;
}
const fail = (detail: string): never => { throw new Error(`TC_MODEL_GROUNDING: ${detail} Use a named body bone and existing limb chains, or restore an intact checkpoint.`); };
const vector = (value: unknown): value is Vec3 => Array.isArray(value) && value.length === 3 && [0, 1, 2].every(i => Number.isFinite(value[i]) && Math.abs(value[i]) <= 1e9);
export const transformMatrix = (value: Transform) => new THREE.Matrix4().compose(new THREE.Vector3(...value.position), new THREE.Quaternion().setFromEuler(new THREE.Euler(...value.rotation)), new THREE.Vector3(...value.scale));

export function groundingDefinition(root: THREE.Object3D, input: AnimationGroundingDefinition, chains: readonly AnimationIKState[]): Required<AnimationGroundingDefinition> {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(key => !["body", "chains", "probeUp", "probeDown", "soleOffset", "maxBodyOffset", "response", "plantDistance", "minGroundNormalY"].includes(key)) ||
      typeof input.body !== "string" || !input.body || !Array.isArray(input.chains) || input.chains.length < 1 || input.chains.length > 8 || new Set(input.chains).size !== input.chains.length || input.chains.some(id => !chains.some(chain => chain.id === id))) fail("Provide 1..8 distinct existing IK chain IDs.");
  const bones: THREE.Bone[] = [];
  root.traverse(object => { if (object instanceof THREE.Bone && object.name === input.body) bones.push(object); });
  if (bones.length !== 1) fail(`Body bone '${input.body}' is missing or ambiguous.`);
  for (const id of input.chains) {
    const chain = chains.find(item => item.id === id)!;
    const effector = root.getObjectByName(chain.effector);
    let ancestor = effector?.parent;
    while (ancestor && ancestor !== bones[0]) ancestor = ancestor.parent;
    if (!ancestor) fail(`Body '${input.body}' must be an ancestor of '${chain.effector}'.`);
  }
  const result = { probeUp: 0.5, probeDown: 1, soleOffset: 0.03, maxBodyOffset: 0.35, response: 16, plantDistance: 0.2, minGroundNormalY: 0.5, ...structuredClone(input) };
  for (const [key, value] of Object.entries(result)) if (key !== "body" && key !== "chains" && (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > (key === "minGroundNormalY" ? 1 : key === "response" ? 1000 : 100))) fail(`Invalid '${key}' grounding parameter.`);
  if (result.probeUp + result.probeDown <= 0) fail("Probe range must be positive.");
  return result;
}

export function validateGrounding(root: THREE.Object3D, value: AnimationGroundingState, chains: readonly AnimationIKState[]): void {
  if (!value || Object.keys(value).some(key => !["definition", "bodyOffset", "feet"].includes(key))) fail("Invalid saved grounding state.");
  const definition = groundingDefinition(root, value.definition, chains);
  if (!Number.isFinite(value.bodyOffset) || Math.abs(value.bodyOffset) > definition.maxBodyOffset + 1e-6 || !Array.isArray(value.feet) || value.feet.length > definition.chains.length) fail("Invalid saved body offset or feet.");
  const seen = new Set<string>();
  for (const foot of value.feet) {
    if (!foot || Object.keys(foot).some(key => !["chain", "target", "normal", "support", "localPoint", "localNormal"].includes(key)) || !definition.chains.includes(foot.chain) || seen.has(foot.chain) || !vector(foot.target) || !vector(foot.normal) || Math.abs(Math.hypot(...foot.normal) - 1) > 1e-5 ||
        !(foot.support === null || typeof foot.support === "string" && foot.support.length > 0 && foot.support.length <= 256) ||
        (foot.support !== null ? !vector(foot.localPoint) || !vector(foot.localNormal) || Math.abs(Math.hypot(...foot.localNormal) - 1) > 1e-5 : foot.localPoint !== undefined || foot.localNormal !== undefined)) fail("Invalid saved stance anchor.");
    seen.add(foot.chain);
  }
}

export class ModelGrounding {
  state: AnimationGroundingState;
  private body: THREE.Bone;
  private base: THREE.Vector3 | null = null;
  private overrides = new Map<ModelIKRig, AnimationIKState>();
  original(rig: ModelIKRig): AnimationIKState { return this.overrides.get(rig) ?? rig.definition; }
  constructor(root: THREE.Object3D, definition: AnimationGroundingDefinition, chains: readonly AnimationIKState[], saved?: AnimationGroundingState) {
    const normalized = groundingDefinition(root, definition, chains);
    if (saved) validateGrounding(root, saved, chains);
    this.state = saved ? structuredClone(saved) : { definition: normalized, bodyOffset: 0, feet: [] };
    this.body = root.getObjectByName(normalized.body) as THREE.Bone;
  }
  reset(): void {
    if (this.base) this.body.position.copy(this.base);
    this.base = null;
    for (const [rig, definition] of this.overrides) Object.assign(rig.definition, definition);
    for (const [rig, definition] of this.overrides) if (definition.orientation === undefined) { delete rig.definition.orientation; delete rig.definition.orientationWeight; }
    this.overrides.clear();
  }
  restorePose(root: THREE.Object3D, rigs: ReadonlyMap<string, ModelIKRig>, world: THREE.Matrix4): void {
    this.reset(); root.updateWorldMatrix(true, true);
    this.applyBody(root, world);
    const inverse = world.clone().invert();
    for (const foot of this.state.feet) {
      const rig = rigs.get(foot.chain);
      if (!rig) fail(`Grounded chain '${foot.chain}' was removed.`);
      this.setTarget(rig!, new THREE.Vector3(...foot.target), new THREE.Vector3(...foot.normal), inverse);
    }
  }
  apply(root: THREE.Object3D, rigs: ReadonlyMap<string, ModelIKRig>, world: THREE.Matrix4, dt: number, queries: GroundingQueries): void {
    this.reset(); root.updateWorldMatrix(true, true);
    const config = this.state.definition, inverse = world.clone().invert(), rootInverse = root.matrixWorld.clone().invert();
    const candidates: { chain: string; point: THREE.Vector3; normal: THREE.Vector3; support: string | null; localPoint?: Vec3; localNormal?: Vec3; rest: THREE.Vector3 }[] = [];
    for (const id of config.chains) {
      const rig = rigs.get(id);
      if (!rig) fail(`Grounded chain '${id}' was removed.`);
      const effector = root.getObjectByName(rig!.definition.effector)!;
      const rest = effector.getWorldPosition(new THREE.Vector3()).applyMatrix4(rootInverse).applyMatrix4(world);
      const hit = queries.raycast([rest.x, rest.y + config.probeUp, rest.z], config.probeUp + config.probeDown);
      if (!hit || hit.normal[1] < config.minGroundNormalY) continue;
      let point = new THREE.Vector3(...hit.point).addScaledVector(new THREE.Vector3(...hit.normal), config.soleOffset);
      let normal = new THREE.Vector3(...hit.normal).normalize();
      const previous = this.state.feet.find(foot => foot.chain === id), support = queries.support(hit.entity);
      if (previous && previous.support === hit.entity && support && previous.localPoint && previous.localNormal) {
        const matrix = transformMatrix(support), anchor = new THREE.Vector3(...previous.localPoint).applyMatrix4(matrix);
        if (Math.hypot(anchor.x - rest.x, anchor.z - rest.z) <= config.plantDistance && Math.abs(anchor.y - point.y) <= config.probeUp) {
          point = anchor; normal = new THREE.Vector3(...previous.localNormal).applyMatrix3(new THREE.Matrix3().getNormalMatrix(matrix)).normalize();
        }
      } else if (previous?.support === null && !support && Math.hypot(previous.target[0] - rest.x, previous.target[2] - rest.z) <= config.plantDistance && Math.abs(previous.target[1] - point.y) <= config.probeUp) {
        point = new THREE.Vector3(...previous.target); normal = new THREE.Vector3(...previous.normal);
      }
      const matrix = support ? transformMatrix(support) : null;
      candidates.push({ chain: id, point, normal, rest, support: matrix ? hit.entity : null,
        ...(matrix ? { localPoint: point.clone().applyMatrix4(matrix.clone().invert()).toArray() as Vec3,
          localNormal: normal.clone().applyMatrix3(new THREE.Matrix3().setFromMatrix4(matrix).transpose()).normalize().toArray() as Vec3 } : {}) });
    }
    const desired = candidates.length ? Math.min(...candidates.map(item => item.point.y - item.rest.y)) : 0;
    const target = THREE.MathUtils.clamp(desired, -config.maxBodyOffset, config.maxBodyOffset);
    const bodyOffset = THREE.MathUtils.lerp(this.state.bodyOffset, target, 1 - Math.exp(-config.response * dt));
    this.state = { definition: config, bodyOffset, feet: candidates.map(item => ({ chain: item.chain, target: item.point.toArray() as Vec3, normal: item.normal.toArray() as Vec3, support: item.support,
      ...(item.localPoint ? { localPoint: item.localPoint, localNormal: item.localNormal } : {}) })) };
    this.applyBody(root, world);
    for (const item of candidates) {
      const rig = rigs.get(item.chain)!;
      this.setTarget(rig, item.point, item.normal, inverse);
    }
  }
  private setTarget(rig: ModelIKRig, point: THREE.Vector3, normal: THREE.Vector3, inverse: THREE.Matrix4): void {
      this.overrides.set(rig, structuredClone(rig.definition));
      rig.definition.target = point.clone().applyMatrix4(inverse).toArray() as Vec3;
      const up = normal.clone().applyMatrix3(new THREE.Matrix3().getNormalMatrix(inverse)).normalize();
      const authored = new THREE.Quaternion(...(rig.definition.orientation ?? [0, 0, 0, 1]));
      const currentUp = new THREE.Vector3(0, 1, 0).applyQuaternion(authored);
      rig.definition.orientation = new THREE.Quaternion().setFromUnitVectors(currentUp, up).multiply(authored).toArray() as readonly [number, number, number, number];
      rig.definition.orientationWeight ??= rig.definition.weight;
  }
  private applyBody(root: THREE.Object3D, world: THREE.Matrix4): void {
    this.base = this.body.position.clone();
    const rootInverse = root.matrixWorld.clone().invert(), parent = this.body.parent!;
    const localParent = rootInverse.multiply(parent.matrixWorld);
    const parentWorld = world.clone().multiply(localParent), inverse = parentWorld.clone().invert();
    const delta = new THREE.Vector3(0, this.state.bodyOffset, 0).applyMatrix4(inverse).sub(new THREE.Vector3().applyMatrix4(inverse));
    this.body.position.add(delta); root.updateWorldMatrix(true, true);
  }
}
