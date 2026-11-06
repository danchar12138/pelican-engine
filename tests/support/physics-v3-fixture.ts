import { createPhysicsFactory, type PhysicsServiceWithQueries } from "../../packages/physics/index.ts";
import { createWorld } from "../../packages/runtime/src/world.ts";
import { SDK_VERSION } from "../../packages/sdk/src/index.ts";
import type { EntityIR, SceneIR } from "../../packages/compiler/src/types.ts";
import type { RuntimePluginContext } from "../../packages/runtime/src/plugins.ts";

export type LegacyCase = "separate-remove-last" | "overlap-remove-first";
export async function legacyRig(which: LegacyCase) {
  const entity = (id: string, x: number): EntityIR => ({ id,
    transform: { position: [x,0,0], rotation: [0,0,0], scale: [1,1,1] }, components: {},
    rigidBody: { type: "dynamic", collider: { shape: "box", size: [2,2,2] }, mass: 2, friction: 0.5, restitution: 0, trigger: false },
  });
  const entities = [entity("first", 0), entity("last", which === "overlap-remove-first" ? 0.5 : 4)];
  const scene: SceneIR = { format: "pelican.scene", version: 1, engineVersion: SDK_VERSION, gameId: "physics-legacy-fixture",
    scene: { id: which, gravity: [0,0,0], camera: { position: [0,0,7], target: [0,0,0], fov: 45, near: 0.1, far: 100 }, environment: { background: "#000000", ambientIntensity: 1 }, entities },
    components: [], systems: [], prefabs: [], materials: [], computes: [], assets: [],
  };
  const world = createWorld({ entities: entities.map(({ id, transform }) => ({ id, transform, components: {} })) });
  const context: RuntimePluginContext = { scene, world, events: () => [], emit: () => ({}) as never };
  const plugin = (await createPhysicsFactory())(context), physics = plugin.services!.physics as PhysicsServiceWithQueries, system = plugin.systems![0];
  return { world, plugin, physics, step() { world.runSystem(system.id, system, () => system.run(1 / 60)); },
    prepare() { const removed = which === "overlap-remove-first" ? "first" : "last", survivor = removed === "first" ? "last" : "first";
      physics.setVelocity(survivor, [0.5,0,0]); physics.torqueImpulse(survivor, [0,0,0.2]); world.destroy(removed); return { removed, survivor }; },
    dispose() { try { plugin.dispose(); } finally { world.dispose(); } },
  };
}
