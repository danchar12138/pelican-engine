import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { extractSurfaceScene } from "../packages/renderer/src/surface.ts";
import { SURFACE_SHADER } from "../packages/renderer/src/surface-shader.ts";
import { SURFACE_RAY_SHADER } from "../packages/renderer/src/surface-ray-shader.ts";
import { MOTION_SHADER } from "../packages/renderer/src/motion-shader.ts";
import { PRIMARY_SHADER } from "../packages/renderer/src/path-shader.ts";
import {
  buildMotionProbePackets,
  buildPrimaryRefinementPacket,
  compareMotionProbeSamples,
  MOTION_PROBE_BROWSER_SOURCE,
  MOTION_PROBE_TOLERANCE,
  motionProbeBufferSizes,
  motionProbeHalton,
  motionProbeJitter,
  motionProbeRandom,
  motionProbeRay,
  motionProbeReference,
} from "../tools/motion-gpu-probe.ts";

test("motion probe storage minima and shared uniform ABI", () => {
  assert.deepEqual(motionProbeBufferSizes([0, 0, 0, 0, 0]), {
    storage: [288, 128, 96, 4, 16],
    output: 12 * 8 * 16,
    uniform: 368,
  });
  assert.deepEqual(
    motionProbeBufferSizes([840, 64, 48, 8, 24]).storage,
    [3360, 256, 192, 32, 96],
  );
});

test("motion PCG agrees with independent BigInt u32 arithmetic including overflow", () => {
  const mask = 0xffffffffn;
  function next(input: number) {
    const seed = (BigInt(input >>> 0) * 747796405n + 2891336453n) & mask;
    const word = (((seed >> ((seed >> 28n) + 4n)) ^ seed) * 277803737n) & mask;
    return {
      seed: Number(seed),
      value: Math.min(
        Math.fround(Number((word >> 22n) ^ word)) / 4294967296,
        Math.fround(0.99999994),
      ),
    };
  }
  for (const index of [0, 1, 95, 0x7fffffff, 0xffffffff]) {
    assert.deepEqual(motionProbeRandom(index), next(index));
    const frame = 31;
    const a = next(
      Number((BigInt(index) * 1973n + BigInt(frame) * 9277n + 89173n) & mask),
    );
    const b = next(a.seed),
      c = next(b.seed);
    assert.deepEqual(motionProbeJitter(index, frame), {
      x: a.value,
      y: b.value,
      coverage: c.value,
    });
  }
});

test("hybrid rays use half-pixel plus forward.w/right.w and near/far planes", () => {
  const params = new Float32Array(92);
  params.set([0, 0, 4, 0, 0, 0, -1, 0.25, 1.5, 0, 0, 0.125, 0, 1, 0, 0]);
  params.set([12, 8, 9, 0.1], 20);
  params[31] = 20;
  params[32] = 1;
  const ray = motionProbeRay(params, 5, 3);
  const direction = new THREE.Vector3(
    ((5.75 / 12) * 2 - 1) * 1.5,
    -((3.625 / 8) * 2 - 1),
    -1,
  ).normalize();
  assert.ok(new THREE.Vector3(...ray.direction).distanceTo(direction) < 1e-14);
  assert.ok(Math.abs(ray.origin[2] - (4 - params[23])) < 1e-12);
  assert.ok(
    Math.abs(ray.maxDistance * -ray.direction[2] - (20 - params[23])) < 1e-12,
  );
  assert.equal(motionProbeHalton(1, 2), 0.5);
  assert.equal(motionProbeHalton(2, 3), 2 / 3);
});

test("reference projects independently barycentrically matched Three vertices, distance and validity", () => {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 0, 1, 0], 3),
  );
  geometry.computeVertexNormals();
  const material = new THREE.MeshStandardMaterial({ side: THREE.DoubleSide });
  const scene = new THREE.Scene();
  const mesh = new THREE.Mesh(geometry, material);
  scene.add(mesh);
  try {
    const camera = new THREE.PerspectiveCamera(90, 1, 0.1, 20);
    camera.coordinateSystem = THREE.WebGPUCoordinateSystem;
    camera.position.z = 4;
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld(true);
    const view = camera.projectionMatrix
      .clone()
      .multiply(camera.matrixWorldInverse);
    const triangle = extractSurfaceScene(scene).triangles[0];
    assert.deepEqual(
      motionProbeReference(triangle, [0.25, 0.25, 0.5], view, camera.position),
      [0.5, 0.5, 4, 1],
    );
    const above = motionProbeReference(
      triangle,
      [0.125, 0.125, 0.75],
      view,
      camera.position,
    );
    assert.ok(Math.abs(above[0] - 0.5) < 1e-14);
    assert.ok(Math.abs(above[1] - 0.4375) < 1e-14);
    assert.ok(Math.abs(above[2] - Math.hypot(4, 0.5)) < 1e-14);
    assert.deepEqual(
      motionProbeReference(undefined, [1, 0, 0], view, camera.position),
      [0, 0, 0, 0],
    );
    assert.deepEqual(
      motionProbeReference(triangle, [1, 0, 0], view, undefined),
      [0, 0, 0, 0],
    );
    mesh.position.z = 8;
    assert.deepEqual(
      motionProbeReference(
        extractSurfaceScene(scene).triangles[0],
        [0.25, 0.25, 0.5],
        view,
        camera.position,
      ),
      [0, 0, 0, 0],
    );
    mesh.position.set(9, 0, 0);
    const outside = motionProbeReference(
      extractSurfaceScene(scene).triangles[0],
      [0.25, 0.25, 0.5],
      view,
      camera.position,
    );
    assert.ok(outside[0] > 1);
    assert.equal(
      outside[3],
      1,
      "Shader deliberately does not clamp or invalidate off-screen UVs",
    );
  } finally {
    geometry.dispose();
    material.dispose();
  }
});

const packets = buildMotionProbePackets();

test("CPU-only packets cover nine actual Three scenarios in both modes with nontrivial BVH orders", () => {
  assert.equal(packets.length, 18);
  for (const mode of ["path", "hybrid"]) {
    const cases = packets.filter((packet) => packet.mode === mode);
    assert.deepEqual(
      cases.map((packet) => packet.name),
      [
        "static",
        "rigid-transform",
        "camera-transform",
        "mirror",
        "topology-missing-previous",
        "no-previous-surface",
        "no-previous-camera",
        "skin-morph",
        "empty",
      ],
    );
    for (const packet of cases) {
      assert.equal(packet.expected.length, 96);
      assert.equal(packet.cpuHits.length, 96);
      assert.equal(packet.geometry.length, packet.triangleCount * (72 + 12));
      assert.equal(
        packet.traversal.length,
        packet.nodeCount * 8 + packet.triangleCount * 12,
      );
      assert.equal(packet.params.length, 92);
      assert.equal(packet.params[32], mode === "hybrid" ? 1 : 0);
      assert.equal(
        packet.params[91],
        packet.name === "no-previous-camera" ? 0 : 1,
      );
      assert.equal(packet.matched + packet.missing, packet.triangleCount);
      assert.ok(packet.geometry.every(Number.isFinite));
      assert.ok(packet.expected.flat().every(Number.isFinite));
      if (packet.name === "empty") {
        assert.ok(packet.cpuHits.every((hit) => hit === null));
        assert.deepEqual(packet.bufferSizes.storage.slice(0, 1), [288]);
      } else {
        assert.ok(
          packet.cpuHits.some(Boolean),
          mode + "/" + packet.name + " must hit geometry",
        );
        assert.ok(
          packet.cpuHits.some((hit) => hit === null),
          "Background is covered",
        );
        assert.ok(
          packet.sourceIndices.some((source, ordered) => source !== ordered),
          "Order must not hide source-index bugs",
        );
      }
      if (
        ["no-previous-surface", "no-previous-camera", "empty"].includes(
          packet.name,
        )
      ) {
        assert.ok(
          packet.expected.every((sample) =>
            sample.every((value) => value === 0),
          ),
        );
      } else {
        assert.ok(packet.expected.some((sample) => sample[3] === 1));
      }
      if (["rigid-transform", "mirror", "skin-morph"].includes(packet.name))
        assert.equal(packet.accelerationKind, "refit");
      if (packet.name === "topology-missing-previous") {
        assert.equal(packet.accelerationKind, "rebuild");
        assert.ok(packet.matched > 0 && packet.missing > 0);
        assert.ok(
          packet.cpuHits.some(
            (hit, index) => hit && packet.expected[index][3] === 0,
          ),
        );
      }
    }
  }
});

test("72-float geometry prefix and 12-float history suffix retain current BVH order and per-triangle validity", () => {
  for (const packet of packets) {
    let matched = 0,
      changed = 0;
    for (let index = 0; index < packet.triangleCount; index++) {
      const history = packet.geometry.slice(
        packet.triangleCount * 72 + index * 12,
        packet.triangleCount * 72 + (index + 1) * 12,
      );
      const current = packet.geometry.slice(index * 72, index * 72 + 12);
      if (history[3] === 1) {
        matched++;
        assert.equal(history[7], 0);
        assert.equal(history[11], 0);
        const positions = [0, 1, 2, 4, 5, 6, 8, 9, 10];
        if (positions.some((offset) => history[offset] !== current[offset]))
          changed++;
        if (packet.name === "static")
          assert.deepEqual(
            positions.map((i) => history[i]),
            positions.map((i) => current[i]),
          );
      } else
        assert.deepEqual(
          history,
          Array(12).fill(0),
          "Missing history cannot substitute current positions",
        );
    }
    assert.equal(matched, packet.matched);
    if (["rigid-transform", "mirror", "skin-morph"].includes(packet.name))
      assert.ok(changed > 0);
  }
});

test("static reference UVs match independent pixel projection including prior hybrid Halton jitter", () => {
  for (const packet of packets.filter((packet) => packet.name === "static")) {
    const serial = packet.params[22];
    for (let index = 0; index < 96; index++) {
      if (!packet.expected[index][3]) continue;
      const jitter =
        packet.mode === "path"
          ? motionProbeJitter(index, serial)
          : {
              x:
                0.5 +
                motionProbeHalton(serial + 1, 2) -
                motionProbeHalton(serial, 2),
              y:
                0.5 +
                motionProbeHalton(serial + 1, 3) -
                motionProbeHalton(serial, 3),
            };
      assert.ok(
        Math.abs(packet.expected[index][0] - ((index % 12) + jitter.x) / 12) <
          1e-6,
      );
      assert.ok(
        Math.abs(
          packet.expected[index][1] - (Math.floor(index / 12) + jitter.y) / 8,
        ) < 1e-6,
      );
    }
    // WebGPU near/far map into [0,1], unlike a default WebGL camera.
    const previousView = new THREE.Matrix4().fromArray(
      packet.params.slice(72, 88),
    );
    const origin = new THREE.Vector3(
      ...(packet.params.slice(88, 91) as [number, number, number]),
    );
    const forward = new THREE.Vector3(
      ...(packet.params.slice(4, 7) as [number, number, number]),
    );
    for (const [distance, depth] of [
      [packet.params[23], 0],
      [packet.params[31], 1],
    ]) {
      const point = origin.clone().addScaledVector(forward, distance);
      const clip = new THREE.Vector4(point.x, point.y, point.z, 1).applyMatrix4(
        previousView,
      );
      assert.ok(
        Math.abs(clip.z / clip.w - depth) < 2e-6,
        "WebGPU near/far NDC depth",
      );
    }
  }
});

test("path ray uses exactly two PCG draws for jitter then the third draw for coverage", () => {
  const packet = packets.find(
    (packet) => packet.name === "static" && packet.mode === "path",
  )!;
  const params = packet.params;
  for (const [x, y] of [
    [0, 0],
    [5, 3],
    [11, 7],
  ]) {
    const random = motionProbeJitter(y * 12 + x, params[22]);
    const ray = motionProbeRay(params, x, y);
    const direction = new THREE.Vector3(params[4], params[5], params[6])
      .addScaledVector(
        new THREE.Vector3(params[8], params[9], params[10]),
        ((x + random.x) / 12) * 2 - 1,
      )
      .addScaledVector(
        new THREE.Vector3(params[12], params[13], params[14]),
        -(((y + random.y) / 8) * 2 - 1),
      )
      .normalize();
    assert.ok(
      new THREE.Vector3(...ray.direction).distanceTo(direction) < 1e-14,
    );
    assert.equal(ray.coverage, random.coverage);
  }
});

test("comparison rejects fixed-tolerance UV/depth violations, validity errors, nonfinite and incomplete readback", () => {
  const reference: [number, number, number, number][] = [
    [0.25, 0.5, 4, 1],
    [0, 0, 0, 0],
  ];
  const exact = reference.flat();
  assert.deepEqual(compareMotionProbeSamples(reference, exact), {
    maxUVError: 0,
    maxDepthError: 0,
    failures: [],
  });
  const within = [...exact];
  within[0] += MOTION_PROBE_TOLERANCE * 0.5;
  within[2] += MOTION_PROBE_TOLERANCE * 0.5;
  assert.equal(compareMotionProbeSamples(reference, within).failures.length, 0);
  for (const field of [0, 1, 2, 3, 7]) {
    const bad = [...exact];
    bad[field] +=
      field === 3 || field === 7 ? 1 : MOTION_PROBE_TOLERANCE * 1.01;
    assert.ok(compareMotionProbeSamples(reference, bad).failures.length > 0);
  }
  for (const invalid of [NaN, Infinity, -Infinity]) {
    const bad = [...exact];
    bad[0] = invalid;
    assert.match(
      compareMotionProbeSamples(reference, bad).failures.join(" "),
      /non-finite/,
    );
  }
  const staleInvalid = [...exact];
  staleInvalid[4] = 1e-8;
  assert.ok(
    compareMotionProbeSamples(reference, staleInvalid).failures.length > 0,
    "Invalid history must stay exactly zero",
  );
  assert.ok(compareMotionProbeSamples(reference, []).failures.length > 0);
  assert.ok(
    compareMotionProbeSamples(reference, [...exact, 0]).failures.length > 0,
  );
});

test("deferred browser program parses without launching; imports use the actual shared shader sources", () => {
  assert.equal(
    typeof new Function("return (" + MOTION_PROBE_BROWSER_SOURCE + ")")(),
    "function",
  );
  const motion = SURFACE_SHADER + SURFACE_RAY_SHADER + MOTION_SHADER;
  const primary = SURFACE_SHADER + PRIMARY_SHADER;
  assert.match(motion, /surfaceGeometry:array<vec4f>/);
  assert.match(motion, /fn motionMain/);
  assert.match(primary, /fn primaryVertex/);
  assert.match(primary, /fn primaryFragment/);
  assert.match(
    MOTION_PROBE_BROWSER_SOURCE,
    /surfacePhysicalEnabled: 1, surfaceOrderedTraversal: 0/,
  );
  assert.match(MOTION_PROBE_BROWSER_SOURCE, /format: 'rgba32float'/);
  assert.match(
    MOTION_PROBE_BROWSER_SOURCE,
    /pass\.draw\(frame\.triangleCount \* 3\)/,
  );
});

test("forced primary refinement preserves the original 18 packets and owns independent inputs", () => {
  const before = structuredClone(packets),
    forced = buildPrimaryRefinementPacket(packets);
  const original = packets.find(
    (packet) => packet.name === "static" && packet.mode === "hybrid",
  )!;
  assert.equal(forced.forceRefinement, true);
  assert.equal(forced.name, "forced-primary-refinement");
  assert.deepEqual(forced.params, original.params);
  assert.deepEqual(forced.expected, original.expected);
  forced.params[0] += 1;
  forced.geometry[0] += 1;
  assert.deepEqual(packets, before);
  assert.throws(() => buildPrimaryRefinementPacket([]));
});
