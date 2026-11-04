import * as R2 from "@dimforge/rapier2d-compat";
import * as R3 from "@dimforge/rapier3d-compat";
import type { RigidBodyCaseReport, RigidBodyDimension } from "./types.ts";

export interface Vector {
  x: number;
  y: number;
  z?: number;
}
interface Body {
  handle: number;
  translation(): Vector;
  linvel(): Vector;
  rotation(): number | { x: number; y: number; z: number; w: number };
  angvel(): number | Vector;
  isSleeping(): boolean;
}
export interface ProbeWorld {
  timestep: number;
  free(): void;
  takeSnapshot(): Uint8Array;
  getRigidBody(handle: number): Body;
  getCollider(handle: number): { handle: number; isValid(): boolean };
  getImpulseJoint(handle: number): {
    isValid(): boolean;
    body1(): Body;
    body2(): Body;
  };
  bodies: { len(): number };
  colliders: { len(): number };
  impulseJoints: { len(): number };
}
export interface ProbeQueue {
  free(): void;
  drainCollisionEvents(
    callback: (a: number, b: number, started: boolean) => void,
  ): void;
}
export interface Scene {
  ground: number;
  box: number;
  ball: number;
  anchor: number;
  linked: number;
  boxCollider: number;
  ballCollider: number;
  joint: number;
}
export interface Adapter<W extends ProbeWorld, Q extends ProbeQueue> {
  dimension: RigidBodyDimension;
  init(): Promise<void>;
  version(): string;
  createWorld(): W;
  createQueue(): Q;
  populate(world: W): Scene;
  step(world: W, queue: Q): void;
  restore(bytes: Uint8Array): W;
  raycast(world: W, miss?: boolean): { handle: number; toi: number } | null;
  contactCount(world: W, first: number, second: number): number;
  softBodyApi(world: W): RigidBodyCaseReport["softBodyApi"];
}

function inspectSoftBodyApi(
  module: typeof R2 | typeof R3,
  world: R2.World | R3.World,
): RigidBodyCaseReport["softBodyApi"] {
  const exports = Object.keys(module)
    .filter((name) => /^Soft/.test(name))
    .sort();
  const worldMethods = Object.getOwnPropertyNames(module.World.prototype)
    .filter((name) => /soft/i.test(name))
    .sort();
  // Public declarations only: emitted private helpers are not supported API.
  const factories = [
    "rope",
    "volumetric",
    "polyline",
    "polygon",
    "disk",
    "grid",
    "trimesh",
    "cloth",
    "clothTube",
    "clothAnisotropic",
    "cuboid",
    "sphere",
  ];
  const descriptorFactories = factories.filter(
    (name) => typeof Reflect.get(module.SoftBodyDesc, name) === "function",
  );
  const worldSetPresent = world.softBodies instanceof module.SoftBodySet;
  return {
    exported:
      ["SoftBody", "SoftBodyDesc", "SoftBodySet"].every((name) =>
        exports.includes(name),
      ) && worldMethods.includes("createSoftBody"),
    exports,
    worldMethods,
    descriptorFactories,
    worldSetPresent,
  };
}

export const adapter2d: Adapter<R2.World, R2.EventQueue> = {
  dimension: "2d",
  init: R2.init,
  version: R2.version,
  createWorld: () => new R2.World({ x: 0, y: -9.81 }),
  createQueue: () => new R2.EventQueue(true),
  populate(world) {
    const groundBody = world.createRigidBody(
      R2.RigidBodyDesc.fixed().setTranslation(0, -0.5),
    );
    const ground = world.createCollider(
      R2.ColliderDesc.cuboid(10, 0.5),
      groundBody,
    );
    const box = world.createRigidBody(
      R2.RigidBodyDesc.dynamic().setTranslation(-2, 3),
    );
    const boxCollider = world.createCollider(
      R2.ColliderDesc.cuboid(0.5, 0.5)
        .setRestitution(0)
        .setActiveEvents(R2.ActiveEvents.COLLISION_EVENTS),
      box,
    );
    const ball = world.createRigidBody(
      R2.RigidBodyDesc.dynamic().setTranslation(2, 5),
    );
    const ballCollider = world.createCollider(
      R2.ColliderDesc.ball(0.5)
        .setRestitution(0.8)
        .setRestitutionCombineRule(R2.CoefficientCombineRule.Max)
        .setActiveEvents(R2.ActiveEvents.COLLISION_EVENTS),
      ball,
    );
    const anchor = world.createRigidBody(
      R2.RigidBodyDesc.fixed().setTranslation(5, 3),
    );
    const linked = world.createRigidBody(
      R2.RigidBodyDesc.dynamic().setTranslation(5, 2),
    );
    world.createCollider(R2.ColliderDesc.ball(0.2), linked);
    const joint = world.createImpulseJoint(
      R2.JointData.fixed({ x: 0, y: -1 }, 0, { x: 0, y: 0 }, 0),
      anchor,
      linked,
      true,
    );
    return {
      ground: ground.handle,
      box: box.handle,
      ball: ball.handle,
      anchor: anchor.handle,
      linked: linked.handle,
      boxCollider: boxCollider.handle,
      ballCollider: ballCollider.handle,
      joint: joint.handle,
    };
  },
  step: (world, queue) => world.step(queue),
  restore: (bytes) => R2.World.restoreSnapshot(bytes),
  raycast(world, miss = false) {
    const hit = world.castRay(
      new R2.Ray({ x: miss ? 30 : -2, y: 10 }, { x: 0, y: -1 }),
      20,
      true,
    );
    return hit ? { handle: hit.collider.handle, toi: hit.timeOfImpact } : null;
  },
  contactCount(world, first, second) {
    let count = 0;
    world.contactPair(
      world.getCollider(first),
      world.getCollider(second),
      (manifold) => {
        count += manifold.numContacts();
      },
    );
    return count;
  },
  softBodyApi: (world) => inspectSoftBodyApi(R2, world),
};

export const adapter3d: Adapter<R3.World, R3.EventQueue> = {
  dimension: "3d",
  init: R3.init,
  version: R3.version,
  createWorld: () => new R3.World({ x: 0, y: -9.81, z: 0 }),
  createQueue: () => new R3.EventQueue(true),
  populate(world) {
    const groundBody = world.createRigidBody(
      R3.RigidBodyDesc.fixed().setTranslation(0, -0.5, 0),
    );
    const ground = world.createCollider(
      R3.ColliderDesc.cuboid(10, 0.5, 10),
      groundBody,
    );
    const box = world.createRigidBody(
      R3.RigidBodyDesc.dynamic().setTranslation(-2, 3, 0),
    );
    const boxCollider = world.createCollider(
      R3.ColliderDesc.cuboid(0.5, 0.5, 0.5)
        .setRestitution(0)
        .setActiveEvents(R3.ActiveEvents.COLLISION_EVENTS),
      box,
    );
    const ball = world.createRigidBody(
      R3.RigidBodyDesc.dynamic().setTranslation(2, 5, 0),
    );
    const ballCollider = world.createCollider(
      R3.ColliderDesc.ball(0.5)
        .setRestitution(0.8)
        .setRestitutionCombineRule(R3.CoefficientCombineRule.Max)
        .setActiveEvents(R3.ActiveEvents.COLLISION_EVENTS),
      ball,
    );
    const anchor = world.createRigidBody(
      R3.RigidBodyDesc.fixed().setTranslation(5, 3, 0),
    );
    const linked = world.createRigidBody(
      R3.RigidBodyDesc.dynamic().setTranslation(5, 2, 0),
    );
    world.createCollider(R3.ColliderDesc.ball(0.2), linked);
    const identity = { x: 0, y: 0, z: 0, w: 1 };
    const joint = world.createImpulseJoint(
      R3.JointData.fixed(
        { x: 0, y: -1, z: 0 },
        identity,
        { x: 0, y: 0, z: 0 },
        identity,
      ),
      anchor,
      linked,
      true,
    );
    return {
      ground: ground.handle,
      box: box.handle,
      ball: ball.handle,
      anchor: anchor.handle,
      linked: linked.handle,
      boxCollider: boxCollider.handle,
      ballCollider: ballCollider.handle,
      joint: joint.handle,
    };
  },
  step: (world, queue) => world.step(queue),
  restore: (bytes) => R3.World.restoreSnapshot(bytes),
  raycast(world, miss = false) {
    const hit = world.castRay(
      new R3.Ray({ x: miss ? 30 : -2, y: 10, z: 0 }, { x: 0, y: -1, z: 0 }),
      20,
      true,
    );
    return hit ? { handle: hit.collider.handle, toi: hit.timeOfImpact } : null;
  },
  contactCount(world, first, second) {
    let count = 0;
    world.contactPair(
      world.getCollider(first),
      world.getCollider(second),
      (manifold) => {
        count += manifold.numContacts();
      },
    );
    return count;
  },
  softBodyApi: (world) => inspectSoftBodyApi(R3, world),
};
