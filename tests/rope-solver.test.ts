import test from "node:test";
import assert from "node:assert/strict";
import { createRope, RopeError, type RopeSnapshot, type Vec3 } from "../packages/simulation/src/rope.ts";

const point = (a: Vec3, b: Vec3): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const base = () => ({ points: [[0, 2, 0], [1, 2, 0], [2, 2, 0]] as Vec3[], mass: 2, radius: 0.1, gravity: [0, -9.81, 0] as Vec3 });
function code(fn: () => unknown, expected: string): void {
  assert.throws(fn, error => error instanceof RopeError && error.code === expected);
}

test("fixed ticks, gravitational displacement, anchored end and distance preservation", () => {
  const r = createRope(base()), initial = r.inspect();
  assert.deepEqual(initial.resources, { particles: 3, constraints: 2, anchors: 1, colliders: 0 });
  assert.equal(initial.tick, 0);
  const after = r.step(5);
  assert.equal(after.tick, 5);
  assert.equal(after.simulatedSeconds, 5 / 60);
  assert.deepEqual(after.positions[0], [0, 2, 0]);
  assert.ok(after.positions[2][1] < 2, "unanchored endpoint falls");
  assert.ok(after.positions[2][0] < 2, "rope bends under gravity");
  assert.ok(after.maxDistanceError < 0.02, `distance error ${after.maxDistanceError}`);
  assert.notDeepEqual(initial.positions, after.positions);
  r.dispose();
});

test("free particle integrates configured mass, gravity, damping, force only for next tick", () => {
  const r = createRope({ points: [[0, 0, 0], [1, 0, 0]], mass: 2, anchors: [], gravity: [0, 0, 0], damping: 0, substeps: 1, iterations: 1 });
  r.applyForce(1, [0, 120, 0]); // 60 m/s², dt = 1/60 -> +1 m/s
  const a = r.step();
  assert.ok(a.velocities[1][1] > 0.9);
  assert.ok(a.positions[1][1] > 0);
  r.step();
  const b = r.inspect();
  assert.ok(b.velocities[1][1] <= a.velocities[1][1] + 0.3, "force must not persist");
  const heavy = createRope({ points: [[0, 0, 0], [1, 0, 0]], mass: 4, anchors: [], gravity: [0, 0, 0], damping: 0, substeps: 1, iterations: 1 });
  heavy.applyForce(1, [0, 120, 0]);
  assert.ok(heavy.step().velocities[1][1] < a.velocities[1][1]);
  const damped = createRope({ points: [[0, 0, 0], [1, 0, 0]], mass: 2, anchors: [], gravity: [0, 0, 0], damping: 8 });
  damped.applyImpulse(1, [0, 2, 0]);
  assert.equal(damped.inspect().velocities[1][1], 1);
  damped.step(10);
  assert.ok(Math.abs(damped.inspect().velocities[1][1]) < 1);
});

test("move or release anchor, impulse changes velocity and follow-up position", () => {
  const r = createRope({ ...base(), gravity: [0, 0, 0] });
  r.setAnchor(0, [0, 3, 0]);
  assert.deepEqual(r.inspect().positions[0], [0, 3, 0]);
  code(() => r.applyImpulse(0, [1, 0, 0]), "ROPE_ANCHORED");
  r.step();
  assert.deepEqual(r.inspect().positions[0], [0, 3, 0]);
  r.releaseAnchor(0);
  assert.equal(r.inspect().resources.anchors, 0);
  const before = r.inspect().positions[0][2];
  r.applyImpulse(0, [0, 0, 4]);
  assert.equal(r.inspect().velocities[0][2], 2);
  assert.ok(r.step().positions[0][2] > before);
});

test("static plane and sphere contacts produce observable events and nonpenetration", () => {
  const r = createRope({ points: [[0, 0.5, 0], [0, 0.7, 0], [0, 0.9, 0]], mass: 1, radius: 0.1, anchors: [], gravity: [0, -9.81, 0] });
  const colliderInput = [{ kind: "plane" as const, id: "floor", normal: [0, 1, 0] as Vec3, offset: 0 }];
  r.setColliders(colliderInput);
  colliderInput[0].normal[1] = -1;
  let hits = 0;
  for (let tick = 0; tick < 100; tick++) {
    const state = r.step();
    hits += state.contacts.length;
    assert.ok(state.positions.every(p => p[1] >= 0.1 - 1e-7));
    assert.ok(state.contacts.every(c => c.tick === state.tick && c.colliderId === "floor" && c.penetration > 0));
    assert.equal(state.resources.colliders, 1);
  }
  assert.ok(hits > 0);
  const sphereRope = createRope({ points: [[0, 2, 0], [1, 2, 0], [2, 2, 0]], mass: 1, radius: 0.05, gravity: [0, 0, 0] });
  sphereRope.setColliders([{ kind: "sphere", id: "ball", center: [1, 2, 0], radius: 0.2 }]);
  const s = sphereRope.step();
  assert.ok(s.contacts.some(c => c.colliderId === "ball"));
  assert.ok(s.positions.slice(1).every(p => point(p, [1, 2, 0]) >= 0.25 - 1e-6));
  assert.equal(s.resources.colliders, 1);
  assert.ok(s.maxDistanceError < 0.3, "localized contact can stretch a rope but remains bounded");
  r.setColliders([]);
  assert.equal(r.step().resources.colliders, 0);
  sphereRope.setColliders([]);
  assert.deepEqual(sphereRope.snapshot().contacts, [], "changing collider inputs invalidates prior contacts");
  const copied = sphereRope.snapshot();
  sphereRope.restore(copied);
  assert.equal(sphereRope.inspect().resources.colliders, 0);
});

test("snapshot restores queued forces, collider input and contacts; JSON replay is deterministic", () => {
  const r = createRope(base());
  r.setColliders([{ kind: "plane", id: "floor", normal: [0, 1, 0], offset: 0 }]);
  r.step(40);
  r.applyImpulse(2, [0, 1, 2]);
  r.applyForce(1, [0, 0, 10]);
  const saved = JSON.parse(JSON.stringify(r.snapshot())) as RopeSnapshot;
  const baseline = r.step(20), state = r.snapshot();
  r.setColliders([]); r.setAnchor(0, [0, 10, 0]); r.step();
  r.restore(saved);
  assert.deepEqual(r.step(20), baseline);
  assert.deepEqual(r.snapshot(), state);
  saved.positions[1][0] = 900;
  assert.notEqual(r.inspect().positions[1][0], 900);
  const other = createRope(base());
  other.restore(state);
  assert.deepEqual(other.inspect(), r.inspect());
});

test("long-run stability under moving anchor and repeated external contacts", () => {
  const r = createRope({ points: Array.from({ length: 10 }, (_, i): Vec3 => [i * 0.18, 2, 0]), mass: 0.5, radius: 0.04 });
  r.setColliders([{ kind: "plane", id: "floor", normal: [0, 1, 0], offset: 0 }]);
  for (let i = 0; i < 400; i++) {
    r.setAnchor(0, [0, 2 + Math.sin(i * 0.015) * 0.15, 0]);
    const s = r.step();
    assert.ok(s.positions.every(p => p.every(Number.isFinite)));
    assert.ok(s.velocities.every(v => v.every(Number.isFinite)));
    assert.ok(s.positions.slice(1).every(p => p[1] >= 0.04 - 1e-7));
    assert.ok(s.maxDistanceError < 0.12, `tick ${i} error ${s.maxDistanceError}`);
  }
  assert.equal(r.inspect().tick, 400);
});

test("batched fixed ticks match repeated single ticks bit-for-bit", () => {
  const a = createRope(base()), b = createRope(base());
  a.applyForce(2, [0, 12, 3]); b.applyForce(2, [0, 12, 3]);
  const afterBatch = a.step(25);
  for (let i = 0; i < 25; i++) b.step();
  assert.deepEqual(b.inspect(), afterBatch);
  assert.deepEqual(b.snapshot(), a.snapshot());
});

test("rejects invalid input and snapshots atomically; releases resources exactly once", () => {
  code(() => createRope({ ...base(), mass: 0 }), "ROPE_INPUT");
  code(() => createRope({ ...base(), points: [[0, 0, 0], [0, 0, 0]] }), "ROPE_INPUT");
  code(() => createRope({ ...base(), points: [[0, 0, 0], [Number.NaN, 0, 0]] }), "ROPE_INPUT");
  code(() => createRope({ ...base(), fixedDt: 1 }), "ROPE_INPUT");
  code(() => createRope({ ...base(), substeps: 0 }), "ROPE_INPUT");
  code(() => createRope({ ...base(), gravity: [Infinity, 0, 0] }), "ROPE_INPUT");
  code(() => createRope({ ...base(), anchors: [{ index: 0, position: [0, 0, 0] }, { index: 0, position: [1, 0, 0] }] }), "ROPE_INPUT");
  const r = createRope(base());
  code(() => r.setColliders([{ kind: "plane", id: "bad", normal: [0, 2, 0], offset: 0 }]), "ROPE_INPUT");
  code(() => r.setColliders([{ kind: "sphere", id: "bad", center: [0, 0, 0], radius: -1 }]), "ROPE_INPUT");
  code(() => r.setColliders([{ kind: "sphere", id: "same", center: [0, 0, 0], radius: 1 }, { kind: "sphere", id: "same", center: [0, 0, 0], radius: 1 }]), "ROPE_INPUT");
  code(() => r.applyImpulse(99, [0, 1, 0]), "ROPE_INDEX");
  code(() => r.applyForce(1, [0, Infinity, 0]), "ROPE_INPUT");
  code(() => r.step(0), "ROPE_INPUT");
  code(() => r.step(1.5), "ROPE_INPUT");
  const good = r.snapshot();
  const bad = JSON.parse(JSON.stringify(good)) as RopeSnapshot;
  bad.positions[1][0] = Number.NaN;
  code(() => r.restore(bad), "ROPE_SNAPSHOT");
  assert.deepEqual(r.snapshot(), good);
  const wrong = JSON.parse(JSON.stringify(good)) as RopeSnapshot;
  wrong.config.mass = 999;
  code(() => r.restore(wrong), "ROPE_SNAPSHOT");
  assert.deepEqual(r.snapshot(), good);
  const invalidAnchor = JSON.parse(JSON.stringify(good)) as RopeSnapshot;
  invalidAnchor.anchors[0].position[0] += 1;
  code(() => r.restore(invalidAnchor), "ROPE_SNAPSHOT");
  assert.deepEqual(r.snapshot(), good);
  r.dispose(); r.dispose();
  assert.deepEqual(r.inspect().resources, { particles: 0, constraints: 0, anchors: 0, colliders: 0 });
  assert.deepEqual(r.inspect().positions, []);
  code(() => r.step(), "ROPE_DISPOSED");
  code(() => r.snapshot(), "ROPE_DISPOSED");
  code(() => r.restore(good), "ROPE_DISPOSED");
});
