import test from "node:test";
import assert from "node:assert/strict";
import {
  createPhysicsFactory,
  type PhysicsServiceWithQueries,
} from "../packages/physics/index.ts";
import { createWorld } from "../packages/runtime/src/world.ts";
import { SDK_VERSION } from "../packages/sdk/src/index.ts";
import type { EntityIR, SceneIR } from "../packages/compiler/src/types.ts";
import type { RuntimePluginContext } from "../packages/runtime/src/plugins.ts";

test("removing an initial dynamic body before the first step preserves queries and replay", async () => {
  const make = (
    id: string,
    x: number,
    type: "dynamic" | "kinematic",
  ): EntityIR => ({
    id,
    transform: { position: [x, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    components: {},
    rigidBody: { type, collider: { shape: "box", size: [2, 2, 2] }, mass: 2, friction: 0.5, restitution: 0, trigger: false },
  });
  const entities = [
    make("removed", 3, "dynamic"),
    make("survivor", 40, "kinematic"),
  ];
  const scene: SceneIR = {
    format: "pelican.scene",
    version: 1,
    engineVersion: SDK_VERSION,
    gameId: "initial-removal",
    scene: {
      id: "scene",
      camera: {
        position: [0, 5, 10],
        target: [0, 0, 0],
        fov: 50,
        near: 0.1,
        far: 100,
      },
      environment: { background: "#000000", ambientIntensity: 1 },
      gravity: [0, 0, 0],
      entities,
    },
    components: [],
    systems: [],
    prefabs: [],
    materials: [],
    computes: [],
    assets: [],
  };
  const world = createWorld({
    entities: entities.map(({ id, transform }) => ({
      id,
      transform,
      components: {},
    })),
  });
  const context: RuntimePluginContext = {
    scene,
    world,
    events: () => [],
    emit: () => ({}) as never,
  };
  const plugin = (await createPhysicsFactory())(context);
  const physics = plugin.services!.physics as PhysicsServiceWithQueries;
  const system = plugin.systems![0];
  let failed = true;
  try {
    assert.equal(physics.raycast([0, 0, 0], [1, 0, 0], 50)?.entity, "removed");
    const initial = plugin.snapshot();
    plugin.validateSnapshot(initial);
    world.destroy("removed");
    assert.equal(physics.raycast([0, 0, 0], [1, 0, 0], 50)?.entity, "survivor");
    world.runSystem(system.id, system, () => system.run(1 / 60));
    assert.equal(physics.raycast([0, 0, 0], [1, 0, 0], 50)?.entity, "survivor");
    const saved = plugin.snapshot();
    plugin.validateSnapshot(saved);
    plugin.restore(saved);
    assert.deepEqual(plugin.snapshot(), saved);
    failed = false;
  } finally {
    try {
      plugin.dispose();
    } catch (error) {
      if (!failed) throw error;
    } finally {
      world.dispose();
    }
  }
});
