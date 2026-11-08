import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { MeshStandardNodeMaterial } from "three/webgpu";
import {
  createSurfaceMeshCache,
  createSurfaceTextureCache,
  extractSurfaceScene,
  type SurfaceScene,
} from "../packages/renderer/src/surface.ts";
import { createSurfaceCapture } from "../packages/renderer/src/surface-capture.ts";
import { createSurfaceAcceleration } from "../packages/renderer/src/acceleration.ts";

function geometry(triangles = 1) {
  const g = new THREE.BufferGeometry();
  g.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(
      Array.from({ length: triangles }, (_, i) => [
        i * 2,
        0,
        0,
        i * 2 + 1,
        0,
        0,
        i * 2,
        1,
        0,
      ]).flat(),
      3,
    ),
  );
  g.setAttribute(
    "normal",
    new THREE.Float32BufferAttribute(
      Array.from({ length: triangles }, () => [
        0, 0, 1, 0, 0, 1, 0, 0, 1,
      ]).flat(),
      3,
    ),
  );
  g.setAttribute(
    "uv",
    new THREE.Float32BufferAttribute(
      Array.from({ length: triangles }, () => [0, 0, 1, 0, 0, 1]).flat(),
      2,
    ),
  );
  return g;
}
function setup() {
  const scene = new THREE.Scene(),
    parent = new THREE.Group(),
    material = new THREE.MeshStandardMaterial(),
    g = geometry(),
    mesh = new THREE.Mesh<
      THREE.BufferGeometry,
      THREE.Material | THREE.Material[]
    >(g, material),
    meshCache = createSurfaceMeshCache(),
    textureCache = createSurfaceTextureCache();
  scene.add(parent);
  parent.add(mesh);
  const capture = () => extractSurfaceScene(scene, { meshCache, textureCache });
  return { scene, parent, material, g, mesh, meshCache, textureCache, capture };
}
function skin(material: THREE.MeshStandardMaterial, g = geometry()) {
  const count = g.getAttribute("position").count;
  g.setAttribute(
    "skinIndex",
    new THREE.Uint16BufferAttribute(Array(count * 4).fill(0), 4),
  );
  g.setAttribute(
    "skinWeight",
    new THREE.Float32BufferAttribute(
      Array.from({ length: count }, () => [1, 0, 0, 0]).flat(),
      4,
    ),
  );
  const mesh = new THREE.SkinnedMesh(g, material),
    bone = new THREE.Bone();
  mesh.add(bone);
  mesh.bind(new THREE.Skeleton([bone]));
  return { mesh, bone };
}
function morph(material: THREE.MeshStandardMaterial, g = geometry()) {
  g.morphTargetsRelative = true;
  g.morphAttributes.position = [
    new THREE.Float32BufferAttribute(
      Array.from({ length: g.getAttribute("position").count }, () => [
        0, 0, 1,
      ]).flat(),
      3,
    ),
  ];
  return new THREE.Mesh(g, material);
}
function reused(before: SurfaceScene, after: SurfaceScene) {
  const old = new Set(before.triangles);
  return after.triangles.filter((t) => old.has(t)).length;
}
function code(action: () => unknown, expected: string) {
  assert.throws(
    action,
    (error: unknown) =>
      error instanceof Error && error.message.includes(expected),
  );
}

test("80% static meshes retain deeply frozen triangles while only changed skin/morph/instance meshes extract", () => {
  const scene = new THREE.Scene(),
    material = new THREE.MeshStandardMaterial(),
    meshCache = createSurfaceMeshCache();
  for (let i = 0; i < 12; i++) {
    const mesh = new THREE.Mesh(geometry(), material);
    mesh.position.x = i * 3;
    scene.add(mesh);
  }
  const skinned = skin(material),
    morphed = morph(material),
    instances = new THREE.InstancedMesh(geometry(), material, 2);
  instances.setMatrixAt(1, new THREE.Matrix4().makeTranslation(3, 0, 0));
  scene.add(skinned.mesh, morphed, instances);
  const capture = () => extractSurfaceScene(scene, { meshCache });
  const first = capture(),
    old = JSON.stringify(first),
    warm = capture();
  assert.notEqual(first, warm);
  assert.notEqual(first.triangles, warm.triangles);
  assert.equal(reused(first, warm), 16);
  for (const t of warm.triangles) {
    assert.ok(Object.isFrozen(t));
    assert.ok(Object.isFrozen(t.vertices));
    for (const v of t.vertices) {
      assert.ok(Object.isFrozen(v));
      assert.ok(Object.isFrozen(v.position));
      assert.ok(Object.isFrozen(v.normal));
      assert.ok(Object.isFrozen(v.uv0));
    }
  }
  const originalWorld = skinned.bone.matrixWorld.toArray(),
    originalPalette = Array.from(skinned.mesh.skeleton.boneMatrices ?? []);
  skinned.bone.position.y = 2;
  const movedSkin = capture();
  assert.equal(reused(warm, movedSkin), 15);
  assert.deepEqual(skinned.bone.matrixWorld.toArray(), originalWorld);
  assert.deepEqual(
    Array.from(skinned.mesh.skeleton.boneMatrices ?? []),
    originalPalette,
  );
  morphed.morphTargetInfluences![0] = 0.5;
  const movedMorph = capture();
  assert.equal(reused(movedSkin, movedMorph), 15);
  // Native setMatrixAt deliberately does not increment version.
  const version = instances.instanceMatrix.version;
  instances.setMatrixAt(1, new THREE.Matrix4().makeTranslation(6, 0, 0));
  assert.equal(instances.instanceMatrix.version, version);
  const movedInstance = capture();
  assert.equal(reused(movedMorph, movedInstance), 14);
  assert.deepEqual(movedInstance, extractSurfaceScene(scene));
  assert.equal(JSON.stringify(first), old);
  meshCache.dispose();
  assert.equal(meshCache.inspect().meshes, 0);
});

test("transforms, ancestry, explicit world/local matrices, and visibility/layers invalidate without source writes", () => {
  const s = setup();
  let before = s.capture();
  for (const change of [
    () => s.mesh.position.set(2, 3, 4),
    () => s.parent.rotation.set(0.3, 0.2, 0.1),
    () => s.mesh.scale.set(-2, 3, 1),
    () => {
      s.mesh.matrixAutoUpdate = false;
      s.mesh.matrix.makeTranslation(7, 8, 9);
    },
    () => {
      s.mesh.matrixWorldAutoUpdate = false;
      s.mesh.matrixWorld.makeTranslation(9, 2, 1);
    },
  ]) {
    change();
    const matrix = s.mesh.matrix.toArray(),
      world = s.mesh.matrixWorld.toArray(),
      next = s.capture();
    assert.equal(reused(before, next), 0);
    assert.deepEqual(next, extractSurfaceScene(s.scene));
    assert.deepEqual(s.mesh.matrix.toArray(), matrix);
    assert.deepEqual(s.mesh.matrixWorld.toArray(), world);
    before = next;
  }
  s.parent.visible = false;
  assert.equal(s.capture().triangles.length, 0);
  s.parent.visible = true;
  assert.equal(s.capture().triangles.length, 1);
  s.mesh.userData.noTrace = true;
  assert.equal(s.capture().triangles.length, 0);
  s.mesh.userData.noTrace = false;
  s.mesh.layers.set(2);
  assert.equal(
    extractSurfaceScene(s.scene, { meshCache: s.meshCache, layersMask: 1 })
      .triangles.length,
    0,
  );
  assert.equal(
    extractSurfaceScene(s.scene, { meshCache: s.meshCache, layersMask: 4 })
      .triangles.length,
    1,
  );
  const replacementParent = new THREE.Group();
  s.scene.add(replacementParent);
  replacementParent.add(s.mesh);
  assert.notEqual(s.capture().triangles[0], before.triangles[0]);
  s.mesh.position.x = NaN;
  s.mesh.matrixAutoUpdate = s.mesh.matrixWorldAutoUpdate = true;
  code(s.capture, "SURFACE_NON_FINITE");
});

test("attribute/index identity, versions, types, interleaved data, draw ranges and material groups invalidate", () => {
  const s = setup();
  let previous = s.capture();
  const changed = (action: () => void) => {
    action();
    const next = s.capture();
    assert.equal(reused(previous, next), 0);
    assert.deepEqual(next, extractSurfaceScene(s.scene));
    previous = next;
  };
  const position = s.g.getAttribute("position") as THREE.BufferAttribute;
  // Same semantics as Three uploads: ordinary buffer writes require needsUpdate.
  position.setX(0, 0.1);
  assert.equal(s.capture().triangles[0], previous.triangles[0]);
  changed(() => {
    position.needsUpdate = true;
  });
  changed(() => s.g.setAttribute("position", position.clone()));
  changed(() =>
    s.g.setAttribute(
      "position",
      new THREE.BufferAttribute(new Float64Array(position.array), 3),
    ),
  );
  const interleaved = new THREE.InterleavedBuffer(
    new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    3,
  );
  changed(() =>
    s.g.setAttribute(
      "position",
      new THREE.InterleavedBufferAttribute(interleaved, 3, 0),
    ),
  );
  changed(() => {
    interleaved.array[0] = 0.2;
    interleaved.needsUpdate = true;
  });
  changed(() => s.g.setIndex([0, 1, 2]));
  changed(() => {
    s.g.index!.needsUpdate = true;
  });
  changed(() => s.g.setIndex(new THREE.Uint32BufferAttribute([0, 1, 2], 1)));
  changed(() => {
    s.g.groups.push({ start: 0, count: 3, materialIndex: 0 });
    s.mesh.material = [s.material];
  });
  changed(() => {
    s.g.groups[0].materialIndex = 1;
    (s.mesh.material as THREE.Material[]).push(
      new THREE.MeshStandardMaterial(),
    );
  });
  changed(() => s.g.setDrawRange(0, 3));
  s.g.setDrawRange(0, 0);
  assert.equal(s.capture().triangles.length, 0);
  s.g.setDrawRange(0, 2);
  code(s.capture, "SURFACE_TRIANGLE_BOUNDARY_INVALID");
  s.g.setDrawRange(0, 3);
  s.g.groups[0].materialIndex = 3;
  code(s.capture, "SURFACE_MATERIAL_INDEX_MISSING");
  s.g.groups[0].materialIndex = 0;
  Reflect.set(s.g.getAttribute("normal"), "count", 2);
  code(s.capture, "SURFACE_ATTRIBUTE_COUNT_INVALID");
});

test("material factors and textures refresh independently; side/flat/vertex flags and identity invalidate", () => {
  const s = setup(),
    texture = new THREE.DataTexture(new Uint8Array([255, 0, 0, 255]), 1, 1);
  s.material.map = texture;
  const before = s.capture(),
    saved = JSON.stringify(before);
  s.material.color.setRGB(0.2, 0.4, 0.6);
  s.material.emissive.setRGB(0.1, 0.2, 0.3);
  s.material.emissiveIntensity = 2;
  s.material.roughness = 0.3;
  const factors = s.capture();
  assert.equal(reused(before, factors), 1);
  assert.equal(factors.textures[0], before.textures[0]);
  assert.equal(factors.textures[0].pixels, before.textures[0].pixels);
  assert.equal(factors.materials[0].uuid, s.material.uuid);
  assert.deepEqual(factors.materials[0].emissive, [0.1, 0.2, 0.3]);
  texture.offset.x = 0.2;
  const sampler = s.capture();
  assert.equal(reused(factors, sampler), 1);
  assert.notEqual(sampler.textures[0], factors.textures[0]);
  let previous = sampler;
  for (const change of [
    () => {
      s.material.side = THREE.DoubleSide;
    },
    () => {
      s.material.flatShading = true;
    },
    () => {
      s.material.vertexColors = true;
    },
    () => {
      s.mesh.material = s.material.clone();
    },
  ]) {
    change();
    const next = s.capture();
    assert.equal(reused(previous, next), 0);
    previous = next;
  }
  const active = s.mesh.material as THREE.MeshStandardMaterial;
  active.visible = false;
  assert.equal(s.capture().triangles.length, 0);
  active.visible = true;
  assert.equal(s.capture().materials[0].uuid, active.uuid);
  assert.equal(JSON.stringify(before), saved);
  active.roughness = NaN;
  code(s.capture, "SURFACE_NON_FINITE");
});

test("skin inverses/bind/bone actual matrices, morph target versions and instance count/color are observable", () => {
  const s = setup(),
    skinned = skin(s.material),
    morphed = morph(s.material),
    instances = new THREE.InstancedMesh(geometry(), s.material, 2);
  s.parent.remove(s.mesh);
  s.scene.add(skinned.mesh, morphed, instances);
  let previous = s.capture();
  const changed = (mesh: THREE.Mesh, action: () => void) => {
    action();
    const next = s.capture();
    const old = previous.triangles.find((t) => t.objectUuid === mesh.uuid);
    assert.notEqual(
      next.triangles.find((t) => t.objectUuid === mesh.uuid),
      old,
    );
    for (const t of next.triangles.filter((t) => t.objectUuid !== mesh.uuid))
      assert.ok(previous.triangles.includes(t));
    assert.deepEqual(next, extractSurfaceScene(s.scene));
    previous = next;
  };
  changed(skinned.mesh, () => {
    skinned.mesh.skeleton.boneInverses[0].elements[12] = 1;
  });
  changed(skinned.mesh, () => {
    skinned.mesh.bindMatrix.makeTranslation(0, 1, 0);
  });
  changed(skinned.mesh, () => {
    skinned.mesh.bindMode = "detached";
  });
  changed(skinned.mesh, () => {
    skinned.bone.matrixAutoUpdate = false;
    skinned.bone.matrix.makeTranslation(0, 0, 1);
  });
  changed(skinned.mesh, () => {
    skinned.bone.matrixWorldAutoUpdate = false;
    skinned.bone.matrixWorld.makeTranslation(0, 0, 2);
  });
  changed(morphed, () => {
    morphed.morphTargetInfluences![0] = 0.4;
  });
  changed(morphed, () => {
    morphed.geometry.morphAttributes.position![0].needsUpdate = true;
  });
  changed(morphed, () => {
    morphed.geometry.morphAttributes.position![0] =
      morphed.geometry.morphAttributes.position![0].clone();
  });
  changed(instances, () => instances.setColorAt(0, new THREE.Color(1, 0, 0)));
  changed(instances, () => instances.setColorAt(0, new THREE.Color(0, 1, 0)));
  changed(instances, () => {
    instances.instanceColor!.needsUpdate = true;
  });
  changed(instances, () => {
    instances.count = 1;
  });
  instances.count = 3;
  code(s.capture, "SURFACE_INSTANCE_COUNT_INVALID");
  instances.count = 1;
  morphed.morphTargetInfluences![0] = NaN;
  code(s.capture, "SURFACE_NON_FINITE");
  morphed.morphTargetInfluences![0] = 0;
  skinned.bone.matrixWorld.elements[12] = NaN;
  code(s.capture, "SURFACE_NON_FINITE");
});

test("warm paths retain early option/NodeGraph/extension/hook diagnostics and capture owner API/lifecycle", () => {
  const s = setup();
  s.capture();
  code(
    () =>
      extractSurfaceScene(s.scene, {
        meshCache: s.meshCache,
        materialAdapter: () => new THREE.ShaderMaterial(),
      }),
    "SURFACE_MATERIAL_UNSUPPORTED",
  );
  s.material.userData.gltfExtensions = { UNKNOWN: {} };
  code(s.capture, "SURFACE_EXTENSION_UNSUPPORTED");
  delete s.material.userData.gltfExtensions;
  s.mesh.onBeforeRender = () => {};
  code(s.capture, "SURFACE_CUSTOM_RENDER_HOOK_UNSUPPORTED");
  s.mesh.onBeforeRender = THREE.Object3D.prototype.onBeforeRender;
  const owner = createSurfaceCapture(),
    node = new MeshStandardNodeMaterial();
  Object.assign(node, { colorNode: { isNode: true } });
  s.mesh.material = node;
  const known = new Set<THREE.Material>([node]);
  const first = owner.capture(s.scene, known);
  node.color.setRGB(0.1, 0.3, 0.5);
  const warm = owner.capture(s.scene, known);
  assert.equal(reused(first.surface, warm.surface), 1);
  assert.deepEqual(warm.surface.materials[0].baseColor, [0.1, 0.3, 0.5, 1]);
  assert.equal(warm.surface.materials[0].uuid, node.uuid);
  assert.deepEqual(
    Object.keys(warm).sort(),
    [
      "surface",
      "lights",
      "lightIds",
      "environment",
      "environmentTexture",
    ].sort(),
  );
  code(() => owner.capture(s.scene), "TC_TRACE_NODE_GRAPH");
  Object.assign(node, { roughnessNode: { isNode: true } });
  code(() => owner.capture(s.scene, known), "TC_TRACE_NODE_GRAPH");
  Object.assign(node, { roughnessNode: null });
  assert.equal(owner.inspect().meshes.meshes, 1);
  owner.clear();
  assert.equal(owner.inspect().meshes.meshes, 0);
  assert.equal(owner.inspect().adaptedMaterials, 0);
  assert.equal(reused(first.surface, owner.capture(s.scene, known).surface), 0);
  owner.dispose();
  owner.dispose();
  assert.equal(owner.inspect().meshes.disposed, true);
  assert.equal(owner.inspect().meshes.triangles, 0);
  code(() => owner.capture(s.scene, known), "TC_TRACE_CAPTURE_DISPOSED");
  s.meshCache.clear();
  assert.equal(s.meshCache.inspect().meshes, 0);
  s.meshCache.dispose();
  code(
    () => extractSurfaceScene(new THREE.Scene(), { meshCache: s.meshCache }),
    "SURFACE_MESH_CACHE_DISPOSED",
  );
});

test("no meshCache preserves default allocation, cached clear releases records and old snapshots stay detached", () => {
  const s = setup(),
    first = extractSurfaceScene(s.scene),
    second = extractSurfaceScene(s.scene);
  assert.equal(reused(first, second), 0);
  assert.deepEqual(first, second);
  const cached = s.capture(),
    json = JSON.stringify(cached);
  s.meshCache.clear();
  const fresh = s.capture();
  assert.equal(reused(cached, fresh), 0);
  s.g.getAttribute("position").setX(0, 0.2);
  s.g.getAttribute("position").needsUpdate = true;
  s.mesh.position.y = 3;
  s.material.color.setRGB(0, 0, 0);
  s.capture();
  assert.equal(JSON.stringify(cached), json);
  s.meshCache.dispose();
  assert.equal(s.meshCache.inspect().triangles, 0);
});

test("acceleration reuses only validated deeply frozen geometry; mutable children, accessors, cycles and new invalid triangles still fail", () => {
  const base = setup().capture(),
    acceleration = createSurfaceAcceleration();
  acceleration.update(base);
  assert.equal(
    acceleration.update({ ...base, triangles: [...base.triangles] }).changes
      .kind,
    "none",
  );
  code(
    () => acceleration.update({ ...base, materials: [] }),
    "INVALID_MATERIAL",
  );
  code(
    () =>
      acceleration.update({
        ...base,
        triangles: [base.triangles[0], base.triangles[0]],
      }),
    "DUPLICATE_IDENTITY",
  );
  for (const mode of [
    "mutable",
    "rootFrozen",
    "frozenVertices",
    "accessor",
  ] as const) {
    const triangle = structuredClone(base.triangles[0]);
    const position = triangle.vertices[0].position as unknown as number[];
    if (mode === "frozenVertices") {
      triangle.vertices.forEach(Object.freeze);
      Object.freeze(triangle.vertices);
    }
    if (mode === "accessor") {
      const vertex = triangle.vertices[0];
      Object.defineProperty(vertex, "position", {
        get: () => position,
        enumerable: true,
      });
      Object.freeze(vertex);
    }
    if (mode !== "mutable") Object.freeze(triangle);
    const snapshot = { ...base, triangles: [triangle] };
    acceleration.update(snapshot);
    position[0] = NaN;
    code(() => acceleration.update(snapshot), "INVALID_SNAPSHOT");
  }
  const invalid = structuredClone(base.triangles[0]);
  Reflect.set(invalid.vertices[1], "position", [
    ...invalid.vertices[0].position,
  ]);
  code(
    () => acceleration.update({ ...base, triangles: [invalid] }),
    "DEGENERATE_TRIANGLE",
  );
  // A frozen root/vertices array is insufficient proof for any geometry child.
  for (const mutate of [
    (tri: typeof invalid) => {
      (tri.vertices[0].normal as unknown as number[])[1] = Infinity;
    },
    (tri: typeof invalid) => {
      (tri.vertices[0].uv0 as unknown as number[])[0] = NaN;
    },
    (tri: typeof invalid) => {
      (tri.normalMatrix as number[]).fill(0);
    },
    (tri: typeof invalid) => {
      (tri.vertexIndices as unknown as number[])[0] = -1;
    },
  ]) {
    const triangle = structuredClone(base.triangles[0]);
    Object.freeze(triangle);
    Object.freeze(triangle.vertices);
    const snapshot = { ...base, triangles: [triangle] };
    acceleration.update(snapshot);
    mutate(triangle);
    code(() => acceleration.update(snapshot), "INVALID_SNAPSHOT");
  }
  const cyclicTriangle = structuredClone(base.triangles[0]);
  acceleration.update({ ...base, triangles: [cyclicTriangle] });
  Object.assign(cyclicTriangle.vertices[0], { cycle: cyclicTriangle });
  code(
    () => acceleration.update({ ...base, triangles: [cyclicTriangle] }),
    "INVALID_SNAPSHOT",
  );
  const cyclic = { ...base } as SurfaceScene & { cycle?: unknown };
  cyclic.cycle = cyclic;
  Object.freeze(cyclic);
  code(() => acceleration.update(cyclic), "INVALID_SNAPSHOT");
  acceleration.dispose();
  code(() => acceleration.update(base), "DISPOSED");
  const another = createSurfaceAcceleration();
  assert.equal(another.update(base).changes.kind, "rebuild");
  another.dispose();
});

test("CPU generated multi-mesh DataTexture sample reports capture/update timing and reused allocation references without time thresholds", (t) => {
  const scene = new THREE.Scene(),
    texture = new THREE.DataTexture(
      new Uint8Array(64 * 64 * 4).fill(128),
      64,
      64,
    ),
    material = new THREE.MeshStandardMaterial({ map: texture }),
    meshCache = createSurfaceMeshCache(),
    textureCache = createSurfaceTextureCache(),
    acceleration = createSurfaceAcceleration();
  for (let i = 0; i < 80; i++) {
    const mesh = new THREE.Mesh(geometry(55 + (i === 0 ? 14 : 0)), material);
    mesh.position.x = i * 2;
    scene.add(mesh);
  }
  const animate: ((value: number) => void)[] = [];
  for (let i = 0; i < 20; i++) {
    if (i % 3 === 0) {
      const { mesh, bone } = skin(material, geometry(54));
      scene.add(mesh);
      animate.push((value) => {
        bone.position.z = value;
      });
    } else if (i % 3 === 1) {
      const mesh = morph(material, geometry(54));
      scene.add(mesh);
      animate.push((value) => {
        mesh.morphTargetInfluences![0] = value;
      });
    } else {
      const mesh = new THREE.InstancedMesh(geometry(54), material, 1);
      scene.add(mesh);
      animate.push((value) =>
        mesh.setMatrixAt(0, new THREE.Matrix4().makeTranslation(0, 0, value)),
      );
    }
  }
  const capture = (cached: boolean) =>
    extractSurfaceScene(scene, {
      textureCache,
      ...(cached ? { meshCache } : {}),
    });
  const samples: object[] = [];
  for (const mode of [
    "uncachedDynamic",
    "cachedDynamic",
    "cachedStatic",
  ] as const) {
    const cached = mode !== "uncachedDynamic";
    let before = capture(cached);
    acceleration.update(before);
    for (let i = 0; i < 5; i++) {
      if (mode !== "cachedStatic")
        for (const change of animate) change((i + 1) * 0.01);
      const start = performance.now(),
        next = capture(cached),
        captured = performance.now(),
        frame = acceleration.update(next),
        updated = performance.now();
      const same = reused(before, next);
      assert.equal(next.triangles.length, 5494);
      if (cached) assert.equal(same, mode === "cachedStatic" ? 5494 : 4414);
      else assert.equal(same, 0);
      assert.equal(next.textures[0].pixels, before.textures[0].pixels);
      samples.push({
        mode,
        sample: i,
        triangles: next.triangles.length,
        captureMs: captured - start,
        updateMs: updated - captured,
        reusedTriangles: same,
        newTriangles: next.triangles.length - same,
        reusedVertexRecords: same * 3,
        newVertexRecords: (next.triangles.length - same) * 3,
        texturePixelsSame:
          next.textures[0].pixels === before.textures[0].pixels,
        kind: frame.changes.kind,
      });
      before = next;
    }
  }
  t.diagnostic(JSON.stringify({ node: process.version, samples }));
  meshCache.dispose();
  textureCache.dispose();
  acceleration.dispose();
  texture.dispose();
  material.dispose();
  scene.traverse((object) => {
    if (object instanceof THREE.Mesh) object.geometry.dispose();
  });
});
