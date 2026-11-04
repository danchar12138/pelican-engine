import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createSimulation,
  runSimulationProbe,
  type SimulationKind,
  type Vec3,
} from "../experiments/simulation/index.ts";

const KINDS: SimulationKind[] = ["rope", "cloth", "softbody", "fluid"];
const norm = (v: number[]): number => Math.hypot(...v);
const distance = (a: number[], b: number[]): number =>
  norm(a.map((x, i) => x - b[i]));

describe("M0 CPU simulation: measured coupling controls and lifecycle", () => {
  const report = runSimulationProbe({ steps: 240, lifecycleCycles: 12 });
  for (const entry of report.cases) {
    it(`${entry.kind}: dynamic sphere and deformable / fluid exert measurable two-way feedback`, () => {
      assert.equal(entry.passed, true, JSON.stringify(entry.checks));
      assert.equal(entry.controls.noContact.contactCount, 0);
      assert.equal(entry.controls.noContact.absoluteReactionImpulse, 0);
      assert.ok(entry.controls.oneWay.contactCount > 0);
      assert.equal(entry.controls.oneWay.absoluteReactionImpulse, 0);
      assert.ok(entry.final.contacts.absoluteReactionImpulse > 1e-4);
      assert.ok(entry.controls.peakBodyDistanceFromOneWay > 0.01);
      assert.ok(entry.controls.peakBodyDistanceFromNoContact > 0.01);
      assert.ok(entry.controls.peakParticleRmsFromOneWay > 0.01);
      assert.ok(entry.controls.peakParticleRmsFromNoContact > 0.01);
    });
    it(`${entry.kind}: fixed-step constraints remain stable throughout coupled and control trajectories`, () => {
      assert.equal(entry.stability.samples, 240);
      assert.equal(entry.stability.allFinite, true);
      assert.ok(entry.stability.maxDistanceRelativeError < 0.05);
      assert.ok(entry.stability.maxVolumeRelativeError < 0.05);
      assert.ok(entry.stability.maxSpeed < 10);
      if (entry.kind === "softbody")
        assert.ok(entry.stability.minSignedVolumeRatio! > 0.95);
      if (entry.kind === "fluid")
        assert.ok(entry.stability.maxFluidPressure > 0);
    });
    it(`${entry.kind}: serialized checkpoint restores and replays both physical and render state exactly`, () => {
      assert.equal(entry.snapshot.maxRestoreDifference, 0);
      assert.equal(entry.snapshot.maxReplayDifference, 0);
      assert.equal(entry.snapshot.renderRestoredExactly, true);
      assert.equal(entry.snapshot.renderReplayedExactly, true);
      assert.ok(entry.snapshot.bytes > 1000);
      assert.ok(entry.snapshot.captureWallMs >= 0);
      assert.ok(entry.snapshot.restoreWallMs >= 0);
      assert.ok(entry.timing.coupledSolverWallMs > 0);
      assert.ok(entry.timing.meanCoupledStepMs > 0);
      assert.ok(entry.geometry.maxPositionChange > 0.01);
      assert.equal(entry.geometry.topologyUnchanged, true);
    });
    it(`${entry.kind}: repeated load / restore / run / dispose releases all owned state`, () => {
      assert.equal(entry.lifecycle.cycles, 12);
      assert.equal(entry.lifecycle.releasedEveryCycle, true);
      assert.deepEqual(entry.lifecycle.ownedCountsAfterDispose, {
        bodies: 0,
        particles: 0,
        constraints: 0,
        triangles: 0,
      });
    });
  }
});

describe("M0 simulation state contracts", () => {
  for (const kind of KINDS) {
    it(`${kind}: fixed step batching, independent instances, seeds and topology`, () => {
      const a = createSimulation(kind, { seed: 42 }),
        b = createSimulation(kind, { seed: 42 }),
        c = createSimulation(kind, { seed: 43 });
      const initial = a.snapshot();
      assert.deepEqual(initial, b.snapshot());
      assert.notDeepEqual(initial.particles, c.snapshot().particles);
      const render = a.getRenderState();
      assert.equal(render.bodies.length, 1);
      assert.ok(render.particles.length > 0);
      const indices = [...render.links.flat(), ...render.triangles.flat()];
      assert.ok(
        indices.every(
          (index) =>
            Number.isInteger(index) &&
            index >= 0 &&
            index < render.particles.length,
        ),
      );
      if (kind === "cloth" || kind === "softbody")
        assert.ok(render.triangles.length > 0);
      if (kind === "rope") assert.ok(render.links.length > 0);
      if (kind === "fluid") assert.deepEqual(render.triangles, []);
      a.step(20);
      for (let i = 0; i < 20; i++) b.step();
      assert.deepEqual(a.snapshot(), b.snapshot());
      assert.deepEqual(a.getRenderState(), b.getRenderState());
      assert.equal(a.inspect().simulatedSeconds, 20 / 60);
      const before = a.snapshot();
      a.step(0);
      assert.deepEqual(a.snapshot(), before);
      a.dispose();
      b.dispose();
      c.dispose();
    });
    it(`${kind}: render / snapshot / inspect buffers do not alias live state`, () => {
      const sim = createSimulation(kind);
      sim.step(3);
      const before = sim.snapshot(),
        render = sim.getRenderState(),
        inspection = sim.inspect();
      render.bodies[0].position[0] = 999;
      render.particles[0].position[1] = 999;
      render.links.length = 0;
      render.triangles.length = 0;
      inspection.bodies[0].velocity[0] = 999;
      inspection.contacts.reactionImpulse[0] = 999;
      assert.deepEqual(sim.snapshot(), before);
      const restored = createSimulation(kind);
      restored.restore(before);
      before.particles[0].position[0] = 999;
      assert.notEqual(restored.snapshot().particles[0].position[0], 999);
      sim.dispose();
      restored.dispose();
    });
    it(`${kind}: failed restore is atomic; malformed version, topology, mass and nonfinite coordinates are rejected`, () => {
      const sim = createSimulation(kind);
      sim.step(4);
      const before = sim.snapshot();
      const corruptions: ((s: ReturnType<typeof sim.snapshot>) => void)[] = [
        (s) => {
          s.version = 2 as 1;
        },
        (s) => {
          s.tick = -1;
        },
        (s) => {
          s.particles[0].position[0] = NaN;
        },
        (s) => {
          s.bodies[0].velocity[0] = Infinity;
        },
        (s) => {
          s.particles.pop();
        },
        (s) => {
          s.bodies[0].inverseMass = 0;
        },
        (s) => {
          s.triangles.push([999, 0, 1]);
        },
        (s) => {
          s.counters.absoluteReactionImpulse = -1;
        },
        (s) => {
          s.options.substeps = 0;
        },
      ];
      for (const corrupt of corruptions) {
        const bad = sim.snapshot();
        corrupt(bad);
        assert.throws(() => sim.restore(bad), /SIM_SNAPSHOT/);
        assert.deepEqual(sim.snapshot(), before);
      }
      sim.dispose();
      assert.equal(sim.inspect().disposed, true);
      assert.equal(sim.inspect().fluid, null);
      assert.throws(() => sim.step(), /SIM_DISPOSED/);
      assert.throws(() => sim.snapshot(), /SIM_DISPOSED/);
      assert.throws(() => sim.restore(before), /SIM_DISPOSED/);
      assert.throws(() => sim.getRenderState(), /SIM_DISPOSED/);
      assert.throws(
        () => sim.applyImpulse("body:0", [1, 0, 0]),
        /SIM_DISPOSED/,
      );
      assert.doesNotThrow(() => sim.dispose());
    });
  }

  it("normal contact conserves linear momentum in an isolated one-substep event and records actual sphere impulse", () => {
    const sim = createSimulation("rope", {
      gravity: [0, 0, 0],
      bodyPosition: [-0.22, 0.19, 0],
      bodyVelocity: [0, 0, 0],
      substeps: 1,
      iterations: 1,
    });
    const before = sim.inspect();
    assert.equal(norm(before.momentum), 0);
    const after = sim.step();
    assert.ok(after.contacts.contactCount > 0);
    assert.ok(after.contacts.absoluteReactionImpulse > 0);
    assert.ok(norm(after.momentum) < 1e-9, JSON.stringify(after.momentum));
    const bodyImpulse = after.bodies[0].velocity.map(
      (v) => v / after.bodies[0].inverseMass,
    );
    assert.ok(distance(bodyImpulse, after.contacts.reactionImpulse) < 1e-9);
    sim.dispose();
  });

  it("public impulses change momentum by the requested amount and fixed anchors reject impulses", () => {
    const sim = createSimulation("rope");
    sim.applyImpulse("body:0", [0.35, 0, 0]);
    assert.ok(Math.abs(sim.snapshot().bodies[0].velocity[0] - 2.6) < 1e-12);
    sim.applyImpulse("particle:1", [0, 0.04, 0]);
    assert.equal(sim.snapshot().particles[1].velocity[1], 1);
    assert.throws(
      () => sim.applyImpulse("particle:0", [1, 0, 0]),
      /SIM_PINNED/,
    );
    assert.throws(() => sim.applyImpulse("missing", [1, 0, 0]), /SIM_ENTITY/);
    assert.throws(() => sim.applyImpulse("body:0", [NaN, 0, 0]), /SIM_IMPULSE/);
    sim.dispose();
  });

  it("tetrahedral softbody responds to an internal deformation and recovers positive volumes", () => {
    const sim = createSimulation("softbody", {
      gravity: [0, 0, 0],
      bodyVelocity: [0, 0, 0],
      contacts: false,
    });
    const deformed = sim.snapshot();
    deformed.particles[13].position[0] += 0.035;
    deformed.particles[13].position[1] += 0.02;
    sim.restore(deformed);
    const before = sim.inspect();
    assert.ok(before.maxVolumeRelativeError > 0.05);
    const after = sim.step(30);
    assert.ok(
      after.maxVolumeRelativeError < before.maxVolumeRelativeError * 0.1,
    );
    assert.ok(after.minSignedVolumeRatio! > 0.98);
    assert.ok(after.maxSpeed > 0); // actual evolution, not reset to predefined pose
    sim.dispose();
  });

  it("compressed SPH fluid generates pressure and expands with equal-and-opposite pair momentum", () => {
    const sim = createSimulation("fluid", {
      gravity: [0, 0, 0],
      bodyVelocity: [0, 0, 0],
      contacts: false,
    });
    const compressed = sim.snapshot();
    const center: Vec3 = [0, 0.22, 0];
    for (const p of compressed.particles)
      p.position = p.position.map(
        (x, k) => center[k] + (x - center[k]) * 0.7,
      ) as Vec3;
    sim.restore(compressed);
    const before = sim.inspect();
    assert.ok(before.fluid!.maxDensity > before.fluid!.restDensity);
    assert.ok(before.fluid!.maxPressure > 0);
    const spread = (points: ReturnType<typeof sim.snapshot>["particles"]) =>
      points.reduce((sum, p) => sum + distance(p.position, center) ** 2, 0);
    const initialSpread = spread(sim.snapshot().particles);
    const after = sim.step(5);
    assert.ok(spread(sim.snapshot().particles) > initialSpread);
    assert.ok(after.kineticEnergy > 0);
    assert.ok(norm(after.momentum) < 1e-9, JSON.stringify(after.momentum));
    sim.dispose();
  });

  it("unsupported options fail early with actionable codes", () => {
    assert.throws(
      () => createSimulation("unknown" as SimulationKind),
      /SIM_KIND/,
    );
    for (const fixedDt of [0, NaN, Infinity, 1])
      assert.throws(() => createSimulation("rope", { fixedDt }), /SIM_OPTIONS/);
    for (const seed of [-1, 1.5, 0x100000000])
      assert.throws(() => createSimulation("rope", { seed }), /SIM_OPTIONS/);
    assert.throws(
      () => createSimulation("rope", { gravity: [0, NaN, 0] }),
      /SIM_OPTIONS/,
    );
    const sim = createSimulation("rope");
    for (const steps of [-1, 0.5, Infinity, 10001])
      assert.throws(() => sim.step(steps), /SIM_STEPS/);
    assert.throws(() => runSimulationProbe({ steps: 1 }), /SIM_PROBE_OPTIONS/);
    assert.throws(() => runSimulationProbe({ kinds: [] }), /SIM_PROBE_OPTIONS/);
    assert.throws(
      () => runSimulationProbe({ kinds: ["rope", "rope"] }),
      /SIM_PROBE_OPTIONS/,
    );
    assert.throws(
      () => runSimulationProbe({ lifecycleCycles: 0 }),
      /SIM_PROBE_OPTIONS/,
    );
    sim.dispose();
  });
});

describe("M0 contact causality and externally controlled replay", () => {
  for (const kind of KINDS) {
    it(`${kind}: an enabled collider with a real spatial gap produces no contact or reaction`, () => {
      const sim = createSimulation(kind, {
        gravity: [0, 0, 0],
        bodyPosition: [-0.95, 1.35, 0.75],
        bodyVelocity: [0, 0, 0],
      });
      const before = sim.snapshot().bodies[0];
      const after = sim.step(60);
      assert.equal(after.contacts.contactCount, 0);
      assert.equal(after.contacts.absoluteReactionImpulse, 0);
      assert.deepEqual(after.contacts.reactionImpulse, [0, 0, 0]);
      assert.deepEqual(after.bodies[0].position, before.position);
      assert.deepEqual(after.bodies[0].velocity, [0, 0, 0]);
      sim.dispose();
    });
    it(`${kind}: a public user impulse changes the trajectory and can be replayed from a checkpoint`, () => {
      const sim = createSimulation(kind);
      sim.step(12);
      const checkpoint = sim.snapshot();
      sim.applyImpulse("body:0", [0.02, 0.04, -0.03]);
      sim.step(25);
      const expected = sim.snapshot(),
        geometry = sim.getRenderState();
      sim.restore(checkpoint);
      sim.step(25);
      assert.notDeepEqual(
        sim.snapshot().bodies[0].position,
        expected.bodies[0].position,
      );
      sim.restore(checkpoint);
      sim.applyImpulse("body:0", [0.02, 0.04, -0.03]);
      sim.step(25);
      assert.deepEqual(sim.snapshot(), expected);
      assert.deepEqual(sim.getRenderState(), geometry);
      sim.dispose();
    });
  }
});
