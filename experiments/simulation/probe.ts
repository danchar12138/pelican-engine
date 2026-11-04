import { createSimulation } from "./solver.ts";
import { KINDS } from "./scenes.ts";
import { length, sub } from "./math.ts";
import type {
  SimulationInspection,
  SimulationKind,
  SimulationRenderState,
  SimulationSnapshot,
  Vec3,
} from "./types.ts";

export interface SimulationProbeOptions {
  seed?: number;
  /** [60, 3600]. Each scenario runs this many fixed 1/60-second steps. */
  steps?: number;
  kinds?: SimulationKind[];
  /** Number of create / run / dispose repetitions, [1,100]. */
  lifecycleCycles?: number;
}
export interface SimulationCaseReport {
  kind: SimulationKind;
  passed: boolean;
  checks: Record<string, boolean>;
  load: {
    bodies: number;
    particles: number;
    distanceConstraints: number;
    volumeConstraints: number;
    triangles: number;
  };
  controls: {
    /** Both controls use identical initial conditions and seeded perturbations. */
    noContact: {
      contactCount: number;
      absoluteReactionImpulse: number;
      finalBodyPosition: Vec3;
    };
    oneWay: {
      contactCount: number;
      absoluteReactionImpulse: number;
      finalBodyPosition: Vec3;
    };
    peakBodyDistanceFromNoContact: number;
    peakBodyDistanceFromOneWay: number;
    peakParticleRmsFromNoContact: number;
    peakParticleRmsFromOneWay: number;
  };
  stability: {
    samples: number;
    allFinite: boolean;
    maxDistanceRelativeError: number;
    maxVolumeRelativeError: number;
    minSignedVolumeRatio: number | null;
    maxSpeed: number;
    maxFluidPressure: number;
  };
  snapshot: {
    bytes: number;
    captureWallMs: number;
    restoreWallMs: number;
    capturedTick: number;
    replayedSteps: number;
    maxRestoreDifference: number;
    maxReplayDifference: number;
    renderRestoredExactly: boolean;
    renderReplayedExactly: boolean;
  };
  geometry: {
    initialBytes: number;
    finalBytes: number;
    maxPositionChange: number;
    topologyUnchanged: boolean;
  };
  timing: {
    /** Synchronous CPU solver wall times; excludes inspect(), captures, and framework overhead. */
    coupledSolverWallMs: number;
    noContactSolverWallMs: number;
    oneWaySolverWallMs: number;
    meanCoupledStepMs: number;
    maxCoupledStepMs: number;
    probeWallMs: number;
  };
  lifecycle: {
    cycles: number;
    releasedEveryCycle: boolean;
    ownedCountsAfterDispose: SimulationInspection["resources"];
  };
  final: SimulationInspection;
}
export interface SimulationProbeReport {
  prototype: "threecat-m0-cpu-interaction";
  version: 1;
  passed: boolean;
  seed: number;
  fixedDt: number;
  steps: number;
  cases: SimulationCaseReport[];
  limitations: string[];
}

function positionDifference(
  a: SimulationRenderState,
  b: SimulationRenderState,
): { body: number; particles: number; max: number } {
  const body = Math.max(
    0,
    ...a.bodies.map((p, i) => length(sub(p.position, b.bodies[i].position))),
  );
  const differences = a.particles.map((p, i) =>
    length(sub(p.position, b.particles[i].position)),
  );
  return {
    body,
    particles: Math.sqrt(
      differences.reduce((s, x) => s + x * x, 0) / differences.length,
    ),
    max: Math.max(body, ...differences),
  };
}
/** Numeric diff includes velocities, counters, configuration, rest lengths and every coordinate. */
export function maxSnapshotDifference(a: unknown, b: unknown): number {
  if (typeof a === "number" && typeof b === "number") return Math.abs(a - b);
  if (a === b) return 0;
  if (!a || !b || typeof a !== "object" || typeof b !== "object")
    return Infinity;
  const ak = Object.keys(a),
    bk = Object.keys(b);
  if (ak.length !== bk.length || ak.some((key) => !Object.hasOwn(b, key)))
    return Infinity;
  return Math.max(
    0,
    ...ak.map((key) =>
      maxSnapshotDifference(
        (a as Record<string, unknown>)[key],
        (b as Record<string, unknown>)[key],
      ),
    ),
  );
}
const bytes = (x: unknown): number =>
  new TextEncoder().encode(JSON.stringify(x)).byteLength;

export function runSimulationProbe(
  options: SimulationProbeOptions = {},
): SimulationProbeReport {
  const seed = options.seed ?? 12345,
    steps = options.steps ?? 120,
    cycles = options.lifecycleCycles ?? 8;
  const kinds = options.kinds ?? [...KINDS];
  if (!Number.isInteger(steps) || steps < 60 || steps > 3600)
    throw new Error("SIM_PROBE_OPTIONS: steps must be in [60,3600].");
  if (!Number.isInteger(cycles) || cycles < 1 || cycles > 100)
    throw new Error("SIM_PROBE_OPTIONS: lifecycleCycles must be in [1,100].");
  if (
    !kinds.length ||
    new Set(kinds).size !== kinds.length ||
    kinds.some((k) => !KINDS.includes(k))
  )
    throw new Error(
      "SIM_PROBE_OPTIONS: kinds must be a nonempty unique list of valid kinds.",
    );
  const cases = kinds.map((kind) => probeCase(kind, seed, steps, cycles));
  return {
    prototype: "threecat-m0-cpu-interaction",
    version: 1,
    passed: cases.every((c) => c.passed),
    seed,
    fixedDt: 1 / 60,
    steps,
    cases,
    limitations: [
      "Small CPU-only reference experiments; no GPU / WebGPU performance or production physics claim.",
      "One dynamic translational sphere per scene; no angular dynamics, friction, rigid mesh contacts or CCD.",
      "Rope / cloth / tetrahedral softbody couple only to that sphere and static axis-aligned walls, not to each other.",
      "No cloth self-collision, tearing, plasticity, arbitrary solid surface collision or rigid-body library integration.",
      "WCSPH has O(n²) neighbors, compressive pressure / viscosity, no surface tension or boundary-density correction; particle sphere contact is not hydrodynamically accurate buoyancy.",
      "Fixed walls and rope / cloth anchors exchange momentum with the environment; damping dissipates energy.",
      "Owned-array lifecycle checks demonstrate explicit release only, not absence of process / GPU memory leaks.",
      "Snapshot replay is checked on the same JS runtime; no cross-browser or cross-architecture bitwise determinism guarantee.",
      "Render data is renderer-independent; dynamic BVH / actual WebGPU and ray-tracing synchronization is a separate integration test.",
    ],
  };
}

function probeCase(
  kind: SimulationKind,
  seed: number,
  steps: number,
  cycles: number,
): SimulationCaseReport {
  const started = performance.now();
  const sim = createSimulation(kind, { seed }),
    noContact = createSimulation(kind, { seed, contacts: false }),
    oneWay = createSimulation(kind, { seed, twoWayCoupling: false });
  const initial = sim.getRenderState(),
    initialSnapshot = sim.snapshot();
  let peakBodyDistanceFromNoContact = 0,
    peakBodyDistanceFromOneWay = 0,
    peakParticleRmsFromNoContact = 0,
    peakParticleRmsFromOneWay = 0;
  const stability: SimulationCaseReport["stability"] = {
    samples: 0,
    allFinite: true,
    maxDistanceRelativeError: 0,
    maxVolumeRelativeError: 0,
    minSignedVolumeRatio: null,
    maxSpeed: 0,
    maxFluidPressure: 0,
  };
  const midpoint = Math.floor(steps / 2);
  let checkpoint: SimulationSnapshot | undefined,
    checkpointRender: SimulationRenderState | undefined,
    captureWallMs = 0;
  try {
    for (let frame = 1; frame <= steps; frame++) {
      const inspection = sim.step(),
        nc = noContact.step(),
        ow = oneWay.step();
      const render = sim.getRenderState();
      const d0 = positionDifference(render, noContact.getRenderState()),
        d1 = positionDifference(render, oneWay.getRenderState());
      peakBodyDistanceFromNoContact = Math.max(
        peakBodyDistanceFromNoContact,
        d0.body,
      );
      peakBodyDistanceFromOneWay = Math.max(
        peakBodyDistanceFromOneWay,
        d1.body,
      );
      peakParticleRmsFromNoContact = Math.max(
        peakParticleRmsFromNoContact,
        d0.particles,
      );
      peakParticleRmsFromOneWay = Math.max(
        peakParticleRmsFromOneWay,
        d1.particles,
      );
      stability.samples++;
      stability.allFinite &&= inspection.finite && nc.finite && ow.finite;
      stability.maxDistanceRelativeError = Math.max(
        stability.maxDistanceRelativeError,
        inspection.maxDistanceRelativeError,
        nc.maxDistanceRelativeError,
        ow.maxDistanceRelativeError,
      );
      stability.maxVolumeRelativeError = Math.max(
        stability.maxVolumeRelativeError,
        inspection.maxVolumeRelativeError,
        nc.maxVolumeRelativeError,
        ow.maxVolumeRelativeError,
      );
      if (inspection.minSignedVolumeRatio !== null)
        stability.minSignedVolumeRatio = Math.min(
          stability.minSignedVolumeRatio ?? Infinity,
          inspection.minSignedVolumeRatio,
          nc.minSignedVolumeRatio!,
          ow.minSignedVolumeRatio!,
        );
      stability.maxSpeed = Math.max(
        stability.maxSpeed,
        inspection.maxSpeed,
        nc.maxSpeed,
        ow.maxSpeed,
      );
      stability.maxFluidPressure = Math.max(
        stability.maxFluidPressure,
        inspection.fluid?.maxPressure ?? 0,
        nc.fluid?.maxPressure ?? 0,
        ow.fluid?.maxPressure ?? 0,
      );
      if (frame === midpoint) {
        const start = performance.now();
        checkpoint = sim.snapshot();
        captureWallMs = performance.now() - start;
        checkpointRender = sim.getRenderState();
      }
    }
    const final = sim.inspect(),
      nc = noContact.inspect(),
      ow = oneWay.inspect(),
      finalSnapshot = sim.snapshot(),
      finalRender = sim.getRenderState();
    const restoreStart = performance.now();
    sim.restore(JSON.parse(JSON.stringify(checkpoint)));
    const restoreWallMs = performance.now() - restoreStart;
    const maxRestoreDifference = maxSnapshotDifference(
      checkpoint,
      sim.snapshot(),
    );
    const renderRestoredExactly =
      JSON.stringify(checkpointRender) === JSON.stringify(sim.getRenderState());
    sim.step(steps - midpoint);
    const maxReplayDifference = maxSnapshotDifference(
      finalSnapshot,
      sim.snapshot(),
    );
    const renderReplayedExactly =
      JSON.stringify(finalRender) === JSON.stringify(sim.getRenderState());
    let releasedEveryCycle = true;
    let ownedCountsAfterDispose: SimulationInspection["resources"] = {
      bodies: 0,
      particles: 0,
      constraints: 0,
      triangles: 0,
    };
    for (let cycle = 0; cycle < cycles; cycle++) {
      const temporary = createSimulation(kind, { seed });
      temporary.restore(checkpoint!);
      temporary.step(2);
      temporary.dispose();
      temporary.dispose();
      const inspection = temporary.inspect();
      ownedCountsAfterDispose = inspection.resources;
      releasedEveryCycle &&=
        inspection.disposed &&
        Object.values(inspection.resources).every((x) => x === 0);
    }
    const topologyUnchanged =
      JSON.stringify({ l: initial.links, t: initial.triangles }) ===
      JSON.stringify({ l: finalRender.links, t: finalRender.triangles });
    const checks = {
      finite: stability.allFinite,
      contactOccurred: final.contacts.contactCount > 0,
      noContactControlClean:
        nc.contacts.contactCount === 0 &&
        nc.contacts.absoluteReactionImpulse === 0,
      oneWayControlHasContactWithoutReaction:
        ow.contacts.contactCount > 0 &&
        ow.contacts.absoluteReactionImpulse === 0,
      measuredReaction: final.contacts.absoluteReactionImpulse > 1e-5,
      bodyResponds:
        peakBodyDistanceFromNoContact > 1e-4 &&
        peakBodyDistanceFromOneWay > 1e-4,
      particlesRespond:
        peakParticleRmsFromNoContact > 1e-4 && peakParticleRmsFromOneWay > 1e-5,
      distanceStable: stability.maxDistanceRelativeError < 0.1,
      volumeStable:
        stability.maxVolumeRelativeError < 0.1 &&
        (stability.minSignedVolumeRatio === null ||
          stability.minSignedVolumeRatio > 0),
      boundedSpeed: stability.maxSpeed < 20,
      fluidPressureActive: kind !== "fluid" || stability.maxFluidPressure > 0,
      restored: maxRestoreDifference === 0 && renderRestoredExactly,
      replayed: maxReplayDifference === 0 && renderReplayedExactly,
      geometryUpdated:
        positionDifference(initial, finalRender).max > 1e-4 &&
        topologyUnchanged,
      released: releasedEveryCycle,
    };
    return {
      kind,
      passed: Object.values(checks).every(Boolean),
      checks,
      load: {
        bodies: initial.bodies.length,
        particles: initial.particles.length,
        distanceConstraints: initialSnapshot.distances.length,
        volumeConstraints: initialSnapshot.volumes.length,
        triangles: initial.triangles.length,
      },
      controls: {
        noContact: {
          contactCount: nc.contacts.contactCount,
          absoluteReactionImpulse: nc.contacts.absoluteReactionImpulse,
          finalBodyPosition: nc.bodies[0].position,
        },
        oneWay: {
          contactCount: ow.contacts.contactCount,
          absoluteReactionImpulse: ow.contacts.absoluteReactionImpulse,
          finalBodyPosition: ow.bodies[0].position,
        },
        peakBodyDistanceFromNoContact,
        peakBodyDistanceFromOneWay,
        peakParticleRmsFromNoContact,
        peakParticleRmsFromOneWay,
      },
      stability,
      snapshot: {
        bytes: bytes(checkpoint),
        captureWallMs,
        restoreWallMs,
        capturedTick: midpoint,
        replayedSteps: steps - midpoint,
        maxRestoreDifference,
        maxReplayDifference,
        renderRestoredExactly,
        renderReplayedExactly,
      },
      geometry: {
        initialBytes: bytes(initial),
        finalBytes: bytes(finalRender),
        maxPositionChange: positionDifference(initial, finalRender).max,
        topologyUnchanged,
      },
      timing: {
        coupledSolverWallMs: final.timing.solverWallMs,
        noContactSolverWallMs: nc.timing.solverWallMs,
        oneWaySolverWallMs: ow.timing.solverWallMs,
        meanCoupledStepMs: final.timing.meanStepMs,
        maxCoupledStepMs: final.timing.maxStepMs,
        probeWallMs: performance.now() - started,
      },
      lifecycle: { cycles, releasedEveryCycle, ownedCountsAfterDispose },
      final,
    };
  } finally {
    sim.dispose();
    noContact.dispose();
    oneWay.dispose();
  }
}
