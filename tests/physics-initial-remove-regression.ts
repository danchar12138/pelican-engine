// Standalone native Rapier reproducer; intentionally not a *.test.ts file.
import RAPIER from "@dimforge/rapier3d-compat";

await RAPIER.init();
const world = new RAPIER.World({ x: 0, y: 0, z: 0 });
const queue = new RAPIER.EventQueue(true);
const removed = world.createRigidBody(
  RAPIER.RigidBodyDesc.dynamic().setTranslation(3, 0, 0),
);
world.createCollider(RAPIER.ColliderDesc.cuboid(1, 1, 1).setMass(2), removed);
const survivor = world.createRigidBody(
  RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(40, 0, 0),
);
world.createCollider(RAPIER.ColliderDesc.cuboid(1, 1, 1), survivor);

world.timestep = 0;
world.step(queue);
world.removeRigidBody(removed);
world.timestep = 1 / 60;
console.log("Stepping after zero-dt initialization and dynamic-body removal");
world.step(queue); // Rapier 0.21.0 throws RuntimeError: unreachable here.
console.log("Step succeeded");
queue.free();
world.free();
