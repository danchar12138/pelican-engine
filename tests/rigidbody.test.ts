import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as publicApi from "../experiments/rigidbody/index.ts";
import {
  adapter2d,
  adapter3d,
  type Adapter,
  type ProbeQueue,
  type ProbeWorld,
} from "../experiments/rigidbody/adapters.ts";
import {
  restoreCheckpoint,
  RigidBodyCheckpointError,
} from "../experiments/rigidbody/checkpoint.ts";
import { runDimensionProbe } from "../experiments/rigidbody/probe.ts";

const report = await publicApi.runRigidBodyProbe();

describe("M0 real Rapier 2D/3D WASM candidate evaluation", () => {
  it("loads both pinned real packages and records the public initializer timings", () => {
    assert.equal(
      report.passed,
      true,
      JSON.stringify(report.cases.map((entry) => entry.checks)),
    );
    assert.equal(report.versions.rapier2d, "0.21.0");
    assert.equal(report.versions.rapier3d, "0.21.0");
    assert.deepEqual(report.versions.packages, {
      rapier2d: "0.21.0",
      rapier3d: "0.21.0",
    });
    assert.equal(report.versions.license, "Apache-2.0");
    for (const dimension of ["2d", "3d"] as const) {
      const initialization = report.versions.initialization[dimension];
      assert.equal(initialization.api, "init()");
      assert.equal(initialization.cached, false);
      assert.ok(
        Number.isFinite(initialization.wallMs) && initialization.wallMs > 0,
      );
    }
    assert.deepEqual(
      report.cases.map((entry) => entry.dimension),
      ["2d", "3d"],
    );
  });

  for (const entry of report.cases) {
    it(`${entry.dimension}: a falling box settles and a ball rebounds after actual ground contacts`, () => {
      assert.equal(entry.passed, true, JSON.stringify(entry.checks));
      assert.equal(entry.ticks, 240);
      assert.equal(entry.fixedDt, 1 / 60);
      assert.ok(entry.bodies.box.initialY > 2);
      assert.ok(Math.abs(entry.bodies.box.finalY - 0.5) < 0.04);
      assert.ok(entry.bodies.box.finalSpeed < 0.05);
      assert.ok(entry.bodies.ball.initialY > 4);
      assert.ok(entry.bodies.ball.peakUpwardSpeedAfterContact > 1);
      assert.ok(entry.contacts.boxGroundStarted >= 1);
      assert.ok(
        entry.contacts.ballGroundStarted >= 2,
        "the restitution ball makes repeated contacts",
      );
      assert.ok(
        entry.contacts.stopped > 0,
        "a bouncing ball separates from the ground",
      );
      assert.ok(entry.contacts.boxGroundManifoldSamples > 100);
      assert.ok(entry.contacts.ballGroundManifoldSamples > 0);
      assert.equal(entry.bodies.allStatesFinite, true);
    });

    it(`${entry.dimension}: raycast identifies the box collider, misses elsewhere and survives restoration`, () => {
      // Rapier handles are opaque numbers, including subnormal floats and zero. Never assume integers/truthiness.
      assert.notEqual(entry.raycast.hitColliderHandle, null);
      assert.equal(
        entry.raycast.hitColliderHandle,
        entry.raycast.expectedColliderHandle,
      );
      assert.ok(Number.isFinite(entry.raycast.hitColliderHandle));
      assert.ok(
        entry.raycast.timeOfImpact! > 8.9 && entry.raycast.timeOfImpact! < 9.1,
      );
      assert.equal(entry.raycast.miss, true);
      assert.equal(entry.raycast.restoredHandleMatches, true);
    });

    it(`${entry.dimension}: a fixed joint holds its dynamic body against gravity`, () => {
      assert.equal(entry.joint.kind, "fixed");
      assert.equal(entry.joint.valid, true);
      assert.ok(entry.joint.maxAnchorError < 0.02);
      assert.ok(entry.joint.finalSpeed < 0.05);
    });

    it(`${entry.dimension}: native bytes restore handles and replay every tick and collision event within tolerance`, () => {
      assert.ok(entry.snapshot.bytes > 1000);
      assert.equal(entry.snapshot.capturedTick, 30);
      assert.equal(entry.snapshot.replayedSteps, 210);
      assert.equal(entry.snapshot.tolerance, 1e-5);
      assert.ok(
        entry.snapshot.maxRestoreDifference <= entry.snapshot.tolerance,
      );
      assert.ok(entry.snapshot.maxReplayDifference <= entry.snapshot.tolerance);
      assert.equal(entry.snapshot.handlesPreserved, true);
      assert.equal(entry.snapshot.eventsMatch, true);
      assert.deepEqual(entry.snapshot.rejectedInvalidInputs, [
        "empty",
        "truncated",
        "garbage",
        "wrong-type",
      ]);
      assert.equal(entry.checks.snapshotInputNotMutated, true);
      for (const value of [
        entry.snapshot.captureWallMs,
        entry.snapshot.restoreWallMs,
        entry.timing.stepWallMs,
        entry.timing.replayStepWallMs,
        entry.timing.caseWallMs,
      ]) {
        assert.ok(Number.isFinite(value) && value > 0);
      }
      assert.equal(entry.timing.meanStepWallMs, entry.timing.stepWallMs / 240);
      assert.ok(entry.timing.maxStepWallMs >= entry.timing.meanStepWallMs);
    });

    it(`${entry.dimension}: repeated populated world / snapshot world cycles release all separate native resources`, () => {
      assert.equal(entry.lifecycle.cycles, 8);
      assert.equal(entry.lifecycle.worldsCreated, 16);
      assert.equal(entry.lifecycle.worldsFreed, 16);
      assert.equal(entry.lifecycle.eventQueuesCreated, 16);
      assert.equal(entry.lifecycle.eventQueuesFreed, 16);
      assert.equal(entry.lifecycle.ownedWorldsAfter, 0);
      assert.equal(entry.lifecycle.ownedEventQueuesAfter, 0);
      assert.equal(entry.lifecycle.releasedEveryCycle, true);
    });

    it(`${entry.dimension}: checks the installed JS soft-body surface without claiming simulation acceptance`, () => {
      assert.equal(entry.softBodyApi.exported, true);
      assert.equal(entry.softBodyApi.worldSetPresent, true);
      for (const name of ["SoftBody", "SoftBodyDesc", "SoftBodySet"])
        assert.ok(entry.softBodyApi.exports.includes(name));
      for (const name of ["createSoftBody", "getSoftBody", "removeSoftBody"])
        assert.ok(entry.softBodyApi.worldMethods.includes(name));
      assert.ok(entry.softBodyApi.descriptorFactories.includes("rope"));
      assert.ok(
        entry.softBodyApi.descriptorFactories.includes(
          entry.dimension === "2d" ? "grid" : "cloth",
        ),
      );
      assert.ok(
        !entry.softBodyApi.descriptorFactories.includes("withGenerator"),
        "private emitted helpers must not be advertised",
      );
      assert.ok(
        report.limitations.some((text) =>
          text.includes("No soft-body construction"),
        ),
      );
    });
  }

  it("exports only the probe function and returns finite plain JSON, with no live world methods", () => {
    assert.deepEqual(Object.keys(publicApi), ["runRigidBodyProbe"]);
    const seen = new Set<object>();
    function plain(value: unknown): void {
      assert.notEqual(typeof value, "function");
      if (typeof value === "number") assert.ok(Number.isFinite(value));
      if (value === null || typeof value !== "object") return;
      assert.ok(
        !seen.has(value),
        "report must not contain cycles or shared owned objects",
      );
      seen.add(value);
      assert.ok(
        Array.isArray(value) ||
          Object.getPrototypeOf(value) === Object.prototype,
      );
      for (const child of Object.values(value)) plain(child);
    }
    plain(report);
    assert.deepEqual(JSON.parse(JSON.stringify(report)), report);
  });

  it("can be invoked repeatedly/concurrently with independent reports and cached initialization", async () => {
    const [next, another] = await Promise.all([
      publicApi.runRigidBodyProbe(),
      publicApi.runRigidBodyProbe(),
    ]);
    for (const result of [next, another]) {
      assert.equal(result.passed, true);
      for (const dimension of ["2d", "3d"] as const) {
        assert.equal(result.versions.initialization[dimension].cached, true);
        assert.equal(
          result.versions.initialization[dimension].wallMs,
          report.versions.initialization[dimension].wallMs,
        );
      }
      assert.ok(
        result.cases.every(
          (entry) =>
            entry.lifecycle.ownedWorldsAfter === 0 &&
            entry.lifecycle.ownedEventQueuesAfter === 0,
        ),
      );
    }
    assert.notEqual(next.cases[0], another.cases[0]);
    assert.equal(
      next.cases[0].bodies.box.finalY,
      report.cases[0].bodies.box.finalY,
    );
    assert.equal(
      another.cases[1].bodies.ball.finalY,
      report.cases[1].bodies.ball.finalY,
    );
  });
});

function failureTests<W extends ProbeWorld, Q extends ProbeQueue>(
  adapter: Adapter<W, Q>,
): void {
  describe(`${adapter.dimension}: native checkpoint errors and cleanup under injected failures`, () => {
    it("fails the evaluation when a restored native world uses a different fixed timestep", () => {
      const changedStep: Adapter<W, Q> = {
        ...adapter,
        restore(bytes) {
          const world = adapter.restore(bytes);
          if (world) world.timestep = 1 / 30;
          return world;
        },
      };
      const failed = runDimensionProbe(changedStep);
      assert.equal(failed.passed, false);
      assert.ok(
        failed.snapshot.maxRestoreDifference > failed.snapshot.tolerance,
      );
      assert.ok(
        failed.snapshot.maxReplayDifference > failed.snapshot.tolerance,
      );
      assert.equal(failed.checks.snapshotRestore, false);
      assert.equal(failed.checks.snapshotReplayEveryTick, false);
      assert.equal(failed.lifecycle.ownedWorldsAfter, 0);
      assert.equal(failed.lifecycle.ownedEventQueuesAfter, 0);
      assert.equal(
        failed.lifecycle.worldsCreated,
        failed.lifecycle.worldsFreed,
      );
      assert.equal(
        failed.lifecycle.eventQueuesCreated,
        failed.lifecycle.eventQueuesFreed,
      );
    });

    it("normalizes the real native null return for empty, truncated and garbage snapshots", () => {
      const world = adapter.createWorld();
      try {
        adapter.populate(world);
        const snapshot = world.takeSnapshot();
        const before = snapshot.slice();
        for (const data of [
          null,
          {},
          [1, 2],
          new Uint8Array(),
          snapshot.slice(0, 16),
          new Uint8Array(16).fill(255),
        ]) {
          assert.throws(
            () => restoreCheckpoint(adapter.dimension, adapter.restore, data),
            (error) => {
              assert.ok(error instanceof RigidBodyCheckpointError);
              assert.equal(error.code, "RIGIDBODY_CHECKPOINT_INVALID");
              assert.equal(error.dimension, adapter.dimension);
              assert.match(
                error.message,
                /same Rapier package version and dimension/,
              );
              return true;
            },
          );
        }
        const restored = restoreCheckpoint(
          adapter.dimension,
          adapter.restore,
          snapshot,
        );
        try {
          assert.equal(restored.bodies.len(), world.bodies.len());
        } finally {
          restored.free();
        }
        assert.deepEqual(
          snapshot,
          before,
          "a valid restore still works after bad native inputs",
        );
      } finally {
        world.free();
      }
    });

    for (const failure of [
      "populate",
      "queue",
      "step",
      "capture",
      "restore",
      "replay",
      "cycle",
      "release",
    ] as const) {
      it(`releases every acquired real native world / event queue after ${failure} failure`, () => {
        const worlds = new Set<W>(),
          queues = new Set<Q>();
        let worldCount = 0,
          queueCount = 0,
          steps = 0;
        const sentinel = new Error(`injected ${failure}`);
        const observed: Adapter<W, Q> = {
          ...adapter,
          createWorld() {
            const world = adapter.createWorld();
            worlds.add(world);
            worldCount++;
            const nativeFree = world.free.bind(world);
            world.free = () => {
              assert.ok(worlds.delete(world), "world freed exactly once");
              nativeFree();
              if (failure === "release" && worlds.size === 1) throw sentinel;
            };
            if (failure === "capture")
              world.takeSnapshot = () => {
                throw sentinel;
              };
            return world;
          },
          createQueue() {
            if (failure === "queue") throw sentinel;
            const queue = adapter.createQueue();
            queues.add(queue);
            queueCount++;
            const nativeFree = queue.free.bind(queue);
            queue.free = () => {
              assert.ok(queues.delete(queue), "queue freed exactly once");
              nativeFree();
            };
            return queue;
          },
          populate(world) {
            const scene = adapter.populate(world);
            if (
              failure === "populate" ||
              (failure === "cycle" && worldCount > 1)
            )
              throw sentinel;
            return scene;
          },
          step(world, queue) {
            steps++;
            if (
              (failure === "step" && steps === 2) ||
              (failure === "replay" && steps === 241)
            )
              throw sentinel;
            adapter.step(world, queue);
          },
          restore(bytes) {
            if (failure === "restore") throw sentinel;
            const world = adapter.restore(bytes);
            if (!world) return world; // Native invalid-data path is nullable despite the package declaration.
            // Instrument snapshot-created worlds as well as constructor-created worlds.
            worlds.add(world);
            worldCount++;
            const nativeFree = world.free.bind(world);
            world.free = () => {
              assert.ok(
                worlds.delete(world),
                "restored world freed exactly once",
              );
              nativeFree();
            };
            return world;
          },
        };
        assert.throws(
          () => runDimensionProbe(observed),
          (error) => {
            if (failure === "restore")
              return error instanceof RigidBodyCheckpointError;
            if (failure === "release")
              return (
                error instanceof AggregateError &&
                error.errors.includes(sentinel)
              );
            return error === sentinel;
          },
        );
        assert.ok(worldCount > 0);
        if (["replay", "release", "cycle"].includes(failure))
          assert.ok(worldCount >= 2 && queueCount >= 2);
        assert.equal(worlds.size, 0, "all acquired real worlds were freed");
        assert.equal(queues.size, 0, "all acquired real queues were freed");
      });
    }
  });
}

failureTests(adapter2d);
failureTests(adapter3d);
