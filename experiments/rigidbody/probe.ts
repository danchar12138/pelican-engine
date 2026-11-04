import { readFileSync } from "node:fs";
import {
  adapter2d,
  adapter3d,
  type Adapter,
  type ProbeQueue,
  type ProbeWorld,
  type Scene,
  type Vector,
} from "./adapters.ts";
import { restoreCheckpoint, RigidBodyCheckpointError } from "./checkpoint.ts";
import type {
  RigidBodyCaseReport,
  RigidBodyDimension,
  RigidBodyProbeReport,
} from "./types.ts";

const FIXED_DT = 1 / 60;
const TICKS = 240;
const CAPTURE_TICK = 30;
const CYCLES = 8;
const TOLERANCE = 1e-5;
const initialization = new Map<RigidBodyDimension, Promise<number>>();
const norm = (v: Vector): number => Math.hypot(v.x, v.y, v.z ?? 0);
const components = (v: number | Vector): number[] =>
  typeof v === "number" ? [v] : [v.x, v.y, v.z ?? 0];

function state(world: ProbeWorld, scene: Scene): number[] {
  const result = [
    world.timestep,
    world.bodies.len(),
    world.colliders.len(),
    world.impulseJoints.len(),
  ];
  for (const handle of [scene.box, scene.ball, scene.anchor, scene.linked]) {
    const body = world.getRigidBody(handle),
      rotation = body.rotation();
    result.push(
      body.handle,
      ...components(body.translation()),
      ...components(body.linvel()),
      ...components(body.angvel()),
      ...(typeof rotation === "number"
        ? [rotation]
        : [rotation.x, rotation.y, rotation.z, rotation.w]),
      Number(body.isSleeping()),
    );
  }
  return result;
}

function difference(a: number[], b: number[]): number {
  if (
    a.length !== b.length ||
    !a.every(Number.isFinite) ||
    !b.every(Number.isFinite)
  )
    return Infinity;
  return Math.max(0, ...a.map((value, index) => Math.abs(value - b[index])));
}

function anchorError(world: ProbeWorld, scene: Scene): number {
  const anchor = world.getRigidBody(scene.anchor).translation(),
    linked = world.getRigidBody(scene.linked).translation();
  return Math.hypot(
    linked.x - anchor.x,
    linked.y - anchor.y + 1,
    (linked.z ?? 0) - (anchor.z ?? 0),
  );
}

async function initialize<W extends ProbeWorld, Q extends ProbeQueue>(
  adapter: Adapter<W, Q>,
): Promise<{ wallMs: number; cached: boolean; api: "init()" }> {
  const cached = initialization.has(adapter.dimension);
  if (!cached) {
    const promise = (async () => {
      const start = performance.now();
      await adapter.init();
      return performance.now() - start;
    })();
    initialization.set(adapter.dimension, promise);
    promise.catch(() => {
      initialization.delete(adapter.dimension);
    });
  }
  return {
    wallMs: await initialization.get(adapter.dimension)!,
    cached,
    api: "init()",
  };
}

function packageVersion(name: string): string {
  const metadata: { version: string; license: string } = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.resolve(name)), "utf8"),
  );
  if (metadata.license !== "Apache-2.0")
    throw new Error(
      `RIGIDBODY_PACKAGE_LICENSE: Unexpected license for ${name}; review the installed candidate metadata.`,
    );
  return metadata.version;
}

/** Node-only candidate evaluation. Returns plain data; all WASM worlds/queues are freed before resolution. */
export async function runRigidBodyProbe(): Promise<RigidBodyProbeReport> {
  const init2d = await initialize(adapter2d),
    init3d = await initialize(adapter3d);
  const cases = [runDimensionProbe(adapter2d), runDimensionProbe(adapter3d)];
  const packages = {
    rapier2d: packageVersion("@dimforge/rapier2d-compat"),
    rapier3d: packageVersion("@dimforge/rapier3d-compat"),
  };
  const versions: RigidBodyProbeReport["versions"] = {
    rapier2d: adapter2d.version(),
    rapier3d: adapter3d.version(),
    packages,
    license: "Apache-2.0",
    initialization: { "2d": init2d, "3d": init3d },
  };
  return {
    passed:
      cases.every((entry) => entry.passed) &&
      versions.rapier2d === packages.rapier2d &&
      versions.rapier3d === packages.rapier3d,
    versions,
    cases,
    limitations: [
      "Small Node CPU/WASM candidate probe: 240 fixed 1/60-second ticks, five rigid bodies, four colliders and one fixed joint per dimension. Not a production integration or representative game benchmark.",
      "Wall timings include JS/WASM boundary cost; exclude module import, queries and instrumentation from step timings. Initialization is measured once per module instance and cached calls report that original measurement, not another cold start.",
      "Snapshot replay tolerance is 1e-5 within the same installed package, dimension, process and fixed-step inputs. No cross-version, cross-dimension, cross-platform or networking determinism guarantee.",
      "Empty/truncated/garbage snapshots are checked, but native snapshot bytes have no application schema/version/checksum envelope here; do not deserialize arbitrary untrusted input. EventQueue contents and application state are outside the checkpoint.",
      "Lifecycle counts prove balanced explicit free() calls including restored worlds and separate event queues, not absence of allocator retention or a heap-leak proof. Reports expose no live WASM handles as objects or methods.",
      "Both installed JS packages export soft-body APIs, verified by runtime exports, public descriptor factories and world methods. No soft-body construction, stepping, tearing, stability or coupling acceptance is performed by this rigid-body probe.",
      "Vehicle controllers, articulated mechanisms beyond one fixed joint, CCD/high-speed tunneling, large stacks, browser deployment, gameplay adapters and GPU acceleration are not evaluated.",
      "The public compat init() declaration accepts no arguments; the installed 0.21.0 wrapper internally uses the new WASM object-form initializer. No undocumented init({}) call or console-warning suppression is used.",
    ],
  };
}

/** Internal test seam for real-WASM failure/ownership injection; not part of the public barrel. */
export function runDimensionProbe<W extends ProbeWorld, Q extends ProbeQueue>(
  adapter: Adapter<W, Q>,
): RigidBodyCaseReport {
  const caseStart = performance.now();
  const worlds = new Set<W>(),
    queues = new Set<Q>();
  const lifecycle: RigidBodyCaseReport["lifecycle"] = {
    cycles: CYCLES,
    worldsCreated: 0,
    worldsFreed: 0,
    eventQueuesCreated: 0,
    eventQueuesFreed: 0,
    ownedWorldsAfter: 0,
    ownedEventQueuesAfter: 0,
    releasedEveryCycle: false,
  };
  function ownWorld(world: W): W {
    worlds.add(world);
    lifecycle.worldsCreated++;
    return world;
  }
  function ownQueue(): Q {
    const queue = adapter.createQueue();
    queues.add(queue);
    lifecycle.eventQueuesCreated++;
    return queue;
  }
  function releaseWorld(world: W): void {
    if (worlds.delete(world)) {
      world.free();
      lifecycle.worldsFreed++;
    }
  }
  function releaseQueue(queue: Q): void {
    if (queues.delete(queue)) {
      queue.free();
      lifecycle.eventQueuesFreed++;
    }
  }
  function releaseAll(): void {
    // Attempt every release even if one native resource reports a failure.
    const errors: unknown[] = [];
    for (const queue of queues) {
      try {
        releaseQueue(queue);
      } catch (error) {
        errors.push(error);
      }
    }
    for (const world of worlds) {
      try {
        releaseWorld(world);
      } catch (error) {
        errors.push(error);
      }
    }
    lifecycle.ownedWorldsAfter =
      lifecycle.worldsCreated - lifecycle.worldsFreed;
    lifecycle.ownedEventQueuesAfter =
      lifecycle.eventQueuesCreated - lifecycle.eventQueuesFreed;
    if (errors.length)
      throw new AggregateError(
        errors,
        "RIGIDBODY_RELEASE_FAILED: inspect native resource cleanup before reusing the candidate.",
      );
  }

  let report: RigidBodyCaseReport;
  try {
    const world = ownWorld(adapter.createWorld());
    world.timestep = FIXED_DT;
    const scene = adapter.populate(world),
      queue = ownQueue();
    const softBodyApi = adapter.softBodyApi(world);
    const contacts: RigidBodyCaseReport["contacts"] = {
      started: 0,
      stopped: 0,
      boxGroundStarted: 0,
      ballGroundStarted: 0,
      boxGroundManifoldSamples: 0,
      ballGroundManifoldSamples: 0,
    };
    const originalEvents: string[] = [],
      replayEvents: string[] = [],
      trajectory: number[][] = [];
    const ball = world.getRigidBody(scene.ball),
      box = world.getRigidBody(scene.box);
    const initialBoxY = box.translation().y,
      initialBallY = ball.translation().y;
    let peakUpwardSpeedAfterContact = 0,
      allStatesFinite = true,
      maxAnchorError = 0;
    let stepWallMs = 0,
      maxStepWallMs = 0,
      captureWallMs = 0;
    let snapshot: Uint8Array = new Uint8Array();
    let capturedState: number[] = [];
    function drain(q: Q, tick: number, events: string[], count: boolean): void {
      q.drainCollisionEvents((a, b, started) => {
        if (tick > CAPTURE_TICK)
          events.push(`${tick}:${Math.min(a, b)}:${Math.max(a, b)}:${started}`);
        if (!count) return;
        if (started) contacts.started++;
        else contacts.stopped++;
        if (!started || (a !== scene.ground && b !== scene.ground)) return;
        if (a === scene.boxCollider || b === scene.boxCollider)
          contacts.boxGroundStarted++;
        if (a === scene.ballCollider || b === scene.ballCollider)
          contacts.ballGroundStarted++;
      });
    }
    for (let tick = 1; tick <= TICKS; tick++) {
      const start = performance.now();
      adapter.step(world, queue);
      const elapsed = performance.now() - start;
      stepWallMs += elapsed;
      maxStepWallMs = Math.max(maxStepWallMs, elapsed);
      drain(queue, tick, originalEvents, true);
      if (contacts.ballGroundStarted)
        peakUpwardSpeedAfterContact = Math.max(
          peakUpwardSpeedAfterContact,
          ball.linvel().y,
        );
      if (adapter.contactCount(world, scene.ground, scene.boxCollider) > 0)
        contacts.boxGroundManifoldSamples++;
      if (adapter.contactCount(world, scene.ground, scene.ballCollider) > 0)
        contacts.ballGroundManifoldSamples++;
      const current = state(world, scene);
      allStatesFinite &&= current.every(Number.isFinite);
      maxAnchorError = Math.max(maxAnchorError, anchorError(world, scene));
      if (tick === CAPTURE_TICK) {
        capturedState = current;
        const captureStart = performance.now();
        snapshot = world.takeSnapshot();
        captureWallMs = performance.now() - captureStart;
      }
      if (tick > CAPTURE_TICK) trajectory.push(current);
    }
    const preservedBytes = snapshot.slice();
    const restoreStart = performance.now();
    const restored = ownWorld(
      restoreCheckpoint(adapter.dimension, adapter.restore, snapshot),
    );
    const restoreWallMs = performance.now() - restoreStart;
    const replayQueue = ownQueue();
    const maxRestoreDifference = difference(
      capturedState,
      state(restored, scene),
    );
    const handlesPreserved =
      restored.getRigidBody(scene.box)?.handle === scene.box &&
      restored.getRigidBody(scene.ball)?.handle === scene.ball &&
      [scene.ground, scene.boxCollider, scene.ballCollider].every((handle) =>
        restored.getCollider(handle)?.isValid(),
      ) &&
      restored.getImpulseJoint(scene.joint)?.isValid() &&
      restored.getImpulseJoint(scene.joint).body1().handle === scene.anchor &&
      restored.getImpulseJoint(scene.joint).body2().handle === scene.linked;
    let maxReplayDifference = 0,
      replayStepWallMs = 0;
    for (let tick = CAPTURE_TICK + 1; tick <= TICKS; tick++) {
      const start = performance.now();
      adapter.step(restored, replayQueue);
      replayStepWallMs += performance.now() - start;
      drain(replayQueue, tick, replayEvents, false);
      maxReplayDifference = Math.max(
        maxReplayDifference,
        difference(trajectory[tick - CAPTURE_TICK - 1], state(restored, scene)),
      );
    }
    const hit = adapter.raycast(world),
      restoredHit = adapter.raycast(restored);
    const rejectedInvalidInputs: string[] = [];
    for (const [name, bytes] of [
      ["empty", new Uint8Array()],
      ["truncated", snapshot.slice(0, 16)],
      ["garbage", new Uint8Array(16).fill(255)],
      ["wrong-type", [1, 2, 3]],
    ] as const) {
      try {
        const unexpected = ownWorld(
          restoreCheckpoint(adapter.dimension, adapter.restore, bytes),
        );
        releaseWorld(unexpected);
      } catch (error) {
        if (!(error instanceof RigidBodyCheckpointError)) throw error;
        rejectedInvalidInputs.push(name);
      }
    }
    const finalBoxY = box.translation().y,
      finalBoxSpeed = norm(box.linvel());
    const settled = Math.abs(finalBoxY - 0.5) < 0.04 && finalBoxSpeed < 0.05;
    const bounced = peakUpwardSpeedAfterContact > 1;
    const validJoint = world.getImpulseJoint(scene.joint).isValid();
    const jointSpeed = norm(world.getRigidBody(scene.linked).linvel());
    const checks: Record<string, boolean> = {
      boxSettledOnGround: settled,
      ballBouncedAfterContact: bounced,
      collisionEvents:
        contacts.boxGroundStarted > 0 &&
        contacts.ballGroundStarted > 0 &&
        contacts.stopped > 0,
      contactManifolds:
        contacts.boxGroundManifoldSamples > 0 &&
        contacts.ballGroundManifoldSamples > 0,
      allStatesFinite,
      raycastHandle:
        hit?.handle === scene.boxCollider &&
        Number.isFinite(hit.toi) &&
        hit.toi > 0 &&
        hit.toi < 20,
      raycastMiss: adapter.raycast(world, true) === null,
      restoredRaycastHandle: restoredHit?.handle === scene.boxCollider,
      fixedJoint: validJoint && maxAnchorError < 0.02 && jointSpeed < 0.05,
      snapshotNonempty: snapshot.byteLength > 0,
      snapshotRestore: maxRestoreDifference <= TOLERANCE,
      snapshotReplayEveryTick: maxReplayDifference <= TOLERANCE,
      snapshotHandlesPreserved: handlesPreserved,
      snapshotEventsReplayed:
        originalEvents.length > 0 &&
        JSON.stringify(originalEvents) === JSON.stringify(replayEvents),
      snapshotInputNotMutated: snapshot.every(
        (value, index) => value === preservedBytes[index],
      ),
      invalidSnapshotsRejected: rejectedInvalidInputs.length === 4,
    };
    report = {
      dimension: adapter.dimension,
      passed: false,
      checks,
      fixedDt: FIXED_DT,
      ticks: TICKS,
      bodies: {
        box: {
          initialY: initialBoxY,
          finalY: finalBoxY,
          finalSpeed: finalBoxSpeed,
          settled,
        },
        ball: {
          initialY: initialBallY,
          finalY: ball.translation().y,
          finalSpeed: norm(ball.linvel()),
          bounced,
          peakUpwardSpeedAfterContact,
        },
        allStatesFinite,
      },
      contacts,
      raycast: {
        expectedColliderHandle: scene.boxCollider,
        hitColliderHandle: hit?.handle ?? null,
        timeOfImpact: hit?.toi ?? null,
        miss: checks.raycastMiss,
        restoredHandleMatches: checks.restoredRaycastHandle,
      },
      joint: {
        kind: "fixed",
        handle: scene.joint,
        valid: validJoint,
        maxAnchorError,
        finalSpeed: jointSpeed,
      },
      snapshot: {
        bytes: snapshot.byteLength,
        captureWallMs,
        restoreWallMs,
        capturedTick: CAPTURE_TICK,
        replayedSteps: TICKS - CAPTURE_TICK,
        tolerance: TOLERANCE,
        maxRestoreDifference,
        maxReplayDifference,
        handlesPreserved,
        eventsMatch: checks.snapshotEventsReplayed,
        rejectedInvalidInputs,
      },
      timing: {
        stepWallMs,
        meanStepWallMs: stepWallMs / TICKS,
        maxStepWallMs,
        replayStepWallMs,
        caseWallMs: 0,
      },
      lifecycle,
      softBodyApi,
    };
    releaseAll();
    let cyclesPassed = true;
    for (let cycle = 1; cycle < CYCLES; cycle++) {
      const fresh = ownWorld(adapter.createWorld());
      fresh.timestep = FIXED_DT;
      const freshScene = adapter.populate(fresh),
        freshQueue = ownQueue();
      adapter.step(fresh, freshQueue);
      const copy = ownWorld(
          restoreCheckpoint(
            adapter.dimension,
            adapter.restore,
            fresh.takeSnapshot(),
          ),
        ),
        copyQueue = ownQueue();
      adapter.step(fresh, freshQueue);
      adapter.step(copy, copyQueue);
      cyclesPassed &&=
        difference(state(fresh, freshScene), state(copy, freshScene)) <=
        TOLERANCE;
      releaseAll();
      cyclesPassed &&= worlds.size === 0 && queues.size === 0;
    }
    lifecycle.releasedEveryCycle =
      cyclesPassed &&
      lifecycle.worldsCreated === CYCLES * 2 &&
      lifecycle.worldsCreated === lifecycle.worldsFreed &&
      lifecycle.eventQueuesCreated === CYCLES * 2 &&
      lifecycle.eventQueuesCreated === lifecycle.eventQueuesFreed;
    checks.lifecycleBalanced = lifecycle.releasedEveryCycle;
  } finally {
    releaseAll();
  }
  report.timing.caseWallMs = performance.now() - caseStart;
  report.passed = Object.values(report.checks).every(Boolean);
  return report;
}
