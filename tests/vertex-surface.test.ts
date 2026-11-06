import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import {
  createSurfaceMeshCache,
  extractSurfaceScene,
  sampleSurfaceMaterial,
  sampleSurfaceTexture,
  SurfaceExtractionError,
  type SurfaceVec3,
} from "../packages/renderer/src/surface.ts";
import type {
  SurfaceVertexDeformer,
  VertexEvaluationInput,
} from "../packages/renderer/src/vertex-contract.ts";

function geometry(normal: SurfaceVec3 = [0, 0, 1]) {
  const g = new THREE.BufferGeometry();
  g.setAttribute(
    "position",
    new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0], 3),
  );
  g.setAttribute(
    "normal",
    new THREE.Float32BufferAttribute(
      Array.from({ length: 4 }, () => [...normal]).flat(),
      3,
    ),
  );
  g.setAttribute(
    "uv",
    new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1, 1, 1], 2),
  );
  g.setAttribute(
    "uv1",
    new THREE.Float32BufferAttribute(
      [0.25, 0.5, 0.75, 0.5, 0.25, 1, 0.75, 1],
      2,
    ),
  );
  g.setAttribute(
    "tangent",
    new THREE.Float32BufferAttribute(
      Array.from({ length: 4 }, () => [1, 0, 0, -1]).flat(),
      4,
    ),
  );
  g.setIndex([0, 1, 2, 2, 1, 3]);
  return g;
}
function morph(g: THREE.BufferGeometry) {
  g.morphTargetsRelative = true;
  g.morphAttributes.position = [
    new THREE.Float32BufferAttribute(
      Array.from({ length: 4 }, () => [0, 0, 2]).flat(),
      3,
    ),
  ];
  g.morphAttributes.normal = [
    new THREE.Float32BufferAttribute(
      Array.from({ length: 4 }, () => [1, 0, 0]).flat(),
      3,
    ),
  ];
}
function setup(g = geometry()) {
  const scene = new THREE.Scene(),
    material = new THREE.MeshStandardMaterial(),
    mesh = new THREE.Mesh(g, material);
  scene.add(mesh);
  return { scene, material, mesh, g };
}
function deformer(
  evaluate: SurfaceVertexDeformer["evaluate"],
): SurfaceVertexDeformer {
  return { evaluate, signature: () => [] };
}
function near(actual: readonly number[], expected: readonly number[]) {
  assert.equal(actual.length, expected.length);
  actual.forEach((value, i) => {
    assert.ok(Math.abs(value - expected[i]) < 1e-6, `${actual} != ${expected}`);
  });
}
function code(action: () => unknown, expected: string) {
  assert.throws(
    action,
    (error: unknown) =>
      error instanceof SurfaceExtractionError && error.code === expected,
  );
}

test("vertex hook sees morph then skin, before world; normal override is world inverse transpose and tangents stay unchanged", () => {
  const g = geometry();
  morph(g);
  g.setAttribute(
    "skinIndex",
    new THREE.Uint16BufferAttribute(Array(16).fill(0), 4),
  );
  g.setAttribute(
    "skinWeight",
    new THREE.Float32BufferAttribute(
      Array.from({ length: 4 }, () => [1, 0, 0, 0]).flat(),
      4,
    ),
  );
  const scene = new THREE.Scene(),
    parent = new THREE.Group(),
    material = new THREE.MeshStandardMaterial(),
    mesh = new THREE.SkinnedMesh(g, material),
    bone = new THREE.Bone();
  mesh.add(bone);
  mesh.bind(new THREE.Skeleton([bone]));
  mesh.morphTargetInfluences![0] = 0.5;
  bone.position.set(2, 3, 4);
  bone.rotation.x = Math.PI / 6;
  bone.scale.set(1.2, 0.8, 1.5);
  parent.position.set(10, -4, 2);
  parent.scale.set(2, 3, 4);
  parent.rotation.z = Math.PI / 4;
  mesh.position.set(1, 2, 3);
  scene.add(parent);
  parent.add(mesh);
  const world = new THREE.Matrix4()
      .compose(parent.position, parent.quaternion, parent.scale)
      .multiply(
        new THREE.Matrix4().compose(mesh.position, mesh.quaternion, mesh.scale),
      ),
    skin = new THREE.Matrix4().compose(
      bone.position,
      bone.quaternion,
      bone.scale,
    ),
    oldBoneWorld = bone.matrixWorld.toArray(),
    oldPalette = Array.from(mesh.skeleton.boneMatrices ?? []),
    baseline = extractSurfaceScene(scene),
    calls: VertexEvaluationInput[] = [],
    snapshot = extractSurfaceScene(scene, {
      vertexDeformer: deformer((object, uuid, input) => {
        assert.equal(object, mesh);
        assert.equal(uuid, material.uuid);
        calls.push(input);
        return {
          position: [
            input.positionLocal[0] + 4,
            input.positionLocal[1],
            input.positionLocal[2],
          ],
          normal: [0, 2, 1],
        };
      }),
    });
  assert.equal(calls.length, 6);
  const input = calls[0];
  near(
    input.positionLocal,
    new THREE.Vector3(0, 0, 1).applyMatrix4(skin).toArray(),
  );
  near(
    input.normalLocal,
    new THREE.Vector3(0.5, 0, 1)
      .applyMatrix3(new THREE.Matrix3().setFromMatrix4(skin))
      .normalize()
      .toArray(),
  );
  assert.equal(input.vertexIndex, 0);
  assert.equal(input.instanceIndex, 0);
  assert.deepEqual(input.uv, [0, 0]);
  assert.deepEqual(input.uv1, [0.25, 0.5]);
  near(
    snapshot.triangles[0].vertices[0].position,
    new THREE.Vector3(
      input.positionLocal[0] + 4,
      input.positionLocal[1],
      input.positionLocal[2],
    )
      .applyMatrix4(world)
      .toArray(),
  );
  near(
    snapshot.triangles[0].vertices[0].normal,
    new THREE.Vector3(0, 2, 1)
      .applyMatrix3(new THREE.Matrix3().getNormalMatrix(world))
      .normalize()
      .toArray(),
  );
  assert.deepEqual(
    snapshot.triangles.map((t) => t.vertices.map((v) => v.tangent)),
    baseline.triangles.map((t) => t.vertices.map((v) => v.tangent)),
  );
  assert.deepEqual(bone.matrixWorld.toArray(), oldBoneWorld);
  assert.deepEqual(Array.from(mesh.skeleton.boneMatrices ?? []), oldPalette);
  assert.deepEqual(
    extractSurfaceScene(scene, { vertexDeformer: deformer(() => undefined) }),
    baseline,
  );
});

test("instanced groups expose raw UVs, indices and normalized inverse-transpose instance normals", () => {
  const g = geometry([1, 2, 3]);
  g.addGroup(0, 3, 0);
  g.addGroup(3, 3, 1);
  const materials = [
      new THREE.MeshStandardMaterial(),
      new THREE.MeshStandardMaterial(),
    ],
    mesh = new THREE.InstancedMesh(g, materials, 2),
    scene = new THREE.Scene(),
    instances = [
      new THREE.Matrix4().makeScale(2, 3, 4).setPosition(5, 6, 7),
      new THREE.Matrix4().set(1, 0, 2, -3, 0, 2, 0, 4, 0, 0, -1, 5, 0, 0, 0, 1),
    ];
  instances.forEach((matrix, i) => mesh.setMatrixAt(i, matrix));
  mesh.position.set(10, 20, 30);
  mesh.scale.set(3, 4, 2);
  mesh.rotation.y = Math.PI / 6;
  scene.add(mesh);
  const world = new THREE.Matrix4().compose(
      mesh.position,
      mesh.quaternion,
      mesh.scale,
    ),
    baseline = extractSurfaceScene(scene),
    inputs: { uuid: string; input: VertexEvaluationInput }[] = [],
    snapshot = extractSurfaceScene(scene, {
      vertexDeformer: deformer((object, uuid, input) => {
        assert.equal(object, mesh);
        inputs.push({ uuid, input });
        return {
          position: [
            input.positionLocal[0],
            input.positionLocal[1],
            input.positionLocal[2] + (uuid === materials[0].uuid ? 2 : 4),
          ],
          normal: input.normalLocal,
        };
      }),
    });
  assert.equal(snapshot.triangles.length, 4);
  assert.equal(inputs.length, 12);
  for (const [i, triangle] of snapshot.triangles.entries()) {
    assert.equal(triangle.materialUuid, materials[triangle.materialIndex].uuid);
    assert.equal(triangle.groupIndex, triangle.materialIndex);
    for (const [j, vertex] of triangle.vertices.entries()) {
      const { uuid, input } = inputs[i * 3 + j],
        index = triangle.vertexIndices[j],
        source = new THREE.Vector3().fromBufferAttribute(
          g.getAttribute("position"),
          index,
        ),
        instance = instances[triangle.instanceId];
      assert.equal(uuid, triangle.materialUuid);
      assert.equal(input.vertexIndex, index);
      assert.equal(input.instanceIndex, triangle.instanceId);
      near(input.positionLocal, source.applyMatrix4(instance).toArray());
      near(
        input.normalLocal,
        new THREE.Vector3(1, 2, 3)
          .applyMatrix3(new THREE.Matrix3().getNormalMatrix(instance))
          .normalize()
          .toArray(),
      );
      near(input.uv!, [
        g.getAttribute("uv").getX(index),
        g.getAttribute("uv").getY(index),
      ]);
      near(input.uv1!, [
        g.getAttribute("uv1").getX(index),
        g.getAttribute("uv1").getY(index),
      ]);
      near(
        vertex.position,
        new THREE.Vector3(...input.positionLocal)
          .add(new THREE.Vector3(0, 0, triangle.materialIndex === 0 ? 2 : 4))
          .applyMatrix4(world)
          .toArray(),
      );
      near(
        vertex.normal,
        new THREE.Vector3(...input.normalLocal)
          .applyMatrix3(new THREE.Matrix3().getNormalMatrix(world))
          .normalize()
          .toArray(),
      );
      assert.deepEqual(
        vertex.tangent,
        baseline.triangles[i].vertices[j].tangent,
      );
    }
  }
  assert.deepEqual(
    extractSurfaceScene(scene, { vertexDeformer: deformer(() => undefined) }),
    baseline,
  );
  const moved = extractSurfaceScene(scene, {
    vertexDeformer: deformer((_mesh, _uuid, input) => ({
      position: [
        input.positionLocal[0],
        input.positionLocal[1],
        input.positionLocal[2] + 3,
      ],
    })),
  });
  assert.deepEqual(
    moved.triangles.map((t) => t.vertices.map((v) => v.normal)),
    baseline.triangles.map((t) => t.vertices.map((v) => v.normal)),
  );
});

test("missing normals keep deformed face fallback, but a normal override requires a normal attribute", () => {
  const { scene, g } = setup();
  g.deleteAttribute("normal");
  g.deleteAttribute("uv");
  g.deleteAttribute("uv1");
  const snapshot = extractSurfaceScene(scene, {
    vertexDeformer: deformer((_mesh, _uuid, input) => {
      assert.equal(input.uv, undefined);
      assert.equal(input.uv1, undefined);
      assert.deepEqual(input.normalLocal, [0, 0, 0]);
      return {
        position: [
          input.positionLocal[0],
          input.positionLocal[1],
          input.positionLocal[0],
        ],
      };
    }),
  });
  for (const triangle of snapshot.triangles)
    for (const vertex of triangle.vertices)
      near(vertex.normal, new THREE.Vector3(-1, 0, 1).normalize().toArray());
  code(
    () =>
      extractSurfaceScene(scene, {
        vertexDeformer: deformer((_mesh, _uuid, input) => ({
          position: input.positionLocal,
          normal: [0, 0, 1],
        })),
      }),
    "TC_VERTEX_NORMAL_ATTRIBUTE",
  );
});

test("flat shading still uses the deformed face rather than a supplied shading normal", () => {
  const { scene, material } = setup();
  material.flatShading = true;
  const snapshot = extractSurfaceScene(scene, {
    vertexDeformer: deformer((_mesh, _uuid, input) => ({
      position: [
        input.positionLocal[0],
        input.positionLocal[1],
        input.positionLocal[0],
      ],
      normal: [0, 1, 0],
    })),
  });
  near(
    snapshot.triangles[0].vertices[0].normal,
    new THREE.Vector3(-1, 0, 1).normalize().toArray(),
  );
});

test("hook output must be finite and normals nonzero; failed meshes never replace successful cached triangles", () => {
  const { scene } = setup(),
    meshCache = createSurfaceMeshCache(),
    state: unknown[] = [0];
  let calls = 0,
    invalid: "position" | "normal" | "zero" | "degenerate" | "late" | undefined;
  const vertexDeformer: SurfaceVertexDeformer = {
      signature: () => state,
      evaluate: (_mesh, _uuid, input) => {
        calls++;
        if (invalid === "degenerate") return { position: [0, 0, 0] };
        return {
          position:
            invalid === "position"
              ? [NaN, 0, 0]
              : invalid === "late" && input.vertexIndex === 3
                ? [0, Infinity, 0]
                : input.positionLocal,
          normal:
            invalid === "normal"
              ? [0, Infinity, 1]
              : invalid === "zero"
                ? [0, 0, 0]
                : input.normalLocal,
        };
      },
    },
    capture = () => extractSurfaceScene(scene, { meshCache, vertexDeformer });
  const first = capture();
  assert.equal(calls, 6);
  for (const [mode, expected] of [
    ["position", "SURFACE_NON_FINITE"],
    ["normal", "SURFACE_NON_FINITE"],
    ["zero", "SURFACE_NORMAL_INVALID"],
    ["degenerate", "SURFACE_DEGENERATE_TRIANGLE"],
    ["late", "SURFACE_NON_FINITE"],
  ] as const) {
    invalid = mode;
    state[0] = 1;
    code(capture, expected);
    assert.equal(meshCache.inspect().meshes, 1);
    assert.equal(meshCache.inspect().triangles, 2);
    invalid = undefined;
    state[0] = 0;
    const before: number = calls;
    const recovered = capture();
    assert.equal(calls, before);
    assert.equal(recovered.triangles[0], first.triangles[0]);
  }
  const freshCache = createSurfaceMeshCache();
  invalid = "position";
  code(
    () => extractSurfaceScene(scene, { meshCache: freshCache, vertexDeformer }),
    "SURFACE_NON_FINITE",
  );
  assert.equal(freshCache.inspect().meshes, 0);
});

test("flat scalar graph/time/parameter/texture signatures hit when stable and update positions on each changed value", () => {
  const { scene } = setup(),
    meshCache = createSurfaceMeshCache(),
    texture = new THREE.DataTexture(new Uint8Array([255, 0, 0, 255]), 1, 1);
  let graph = 0,
    time = 0,
    parameter = 0,
    calls = 0;
  const vertexDeformer: SurfaceVertexDeformer = {
      signature: () => [
        graph,
        time,
        parameter,
        texture.version,
        texture.offset.x,
      ],
      evaluate: (_mesh, _uuid, input) => {
        calls++;
        return {
          position: [
            input.positionLocal[0],
            input.positionLocal[1],
            graph + time + parameter + texture.version + texture.offset.x,
          ],
        };
      },
    },
    capture = () => extractSurfaceScene(scene, { meshCache, vertexDeformer });
  let previous = capture();
  assert.equal(calls, 6);
  for (const change of [
    () => {
      graph++;
    },
    () => {
      time++;
    },
    () => {
      parameter++;
    },
    () => {
      texture.needsUpdate = true;
    },
    () => {
      texture.offset.x = 0.5;
    },
  ]) {
    const before: number = calls;
    const stable = capture();
    assert.equal(calls, before);
    assert.equal(stable.triangles[0], previous.triangles[0]);
    change();
    const changed = capture();
    assert.equal(calls, before + 6);
    assert.notEqual(changed.triangles[0], previous.triangles[0]);
    assert.ok(
      changed.triangles[0].vertices[0].position[2] >
        previous.triangles[0].vertices[0].position[2],
    );
    assert.ok(Object.isFrozen(changed.triangles[0].vertices[0].position));
    previous = changed;
  }
  const plain = extractSurfaceScene(scene, { meshCache });
  assert.equal(plain.triangles[0].vertices[0].position[2], 0);
  assert.notEqual(plain.triangles[0], previous.triangles[0]);
  assert.equal(capture().triangles[0].vertices[0].position[2], 4.5);
});

test("hooked cache still tracks morph, skin, instance and world changes", () => {
  const g = geometry();
  morph(g);
  const morphed = new THREE.Mesh(g, new THREE.MeshStandardMaterial()),
    instance = new THREE.InstancedMesh(
      geometry(),
      new THREE.MeshStandardMaterial(),
      1,
    ),
    skinGeometry = geometry();
  skinGeometry.setAttribute(
    "skinIndex",
    new THREE.Uint16BufferAttribute(Array(16).fill(0), 4),
  );
  skinGeometry.setAttribute(
    "skinWeight",
    new THREE.Float32BufferAttribute(
      Array.from({ length: 4 }, () => [1, 0, 0, 0]).flat(),
      4,
    ),
  );
  const skin = new THREE.SkinnedMesh(
      skinGeometry,
      new THREE.MeshStandardMaterial(),
    ),
    bone = new THREE.Bone(),
    scene = new THREE.Scene(),
    meshCache = createSurfaceMeshCache();
  skin.add(bone);
  skin.bind(new THREE.Skeleton([bone]));
  scene.add(morphed, instance, skin);
  const vertexDeformer = deformer((_mesh, _uuid, input) => ({
      position: input.positionLocal,
    })),
    capture = () => extractSurfaceScene(scene, { meshCache, vertexDeformer });
  let previous = capture();
  for (const [mesh, change] of [
    [
      morphed,
      () => {
        morphed.morphTargetInfluences![0] = 0.5;
      },
    ],
    [
      instance,
      () => {
        instance.setMatrixAt(0, new THREE.Matrix4().makeTranslation(0, 0, 2));
      },
    ],
    [
      skin,
      () => {
        bone.position.z = 3;
      },
    ],
    [
      skin,
      () => {
        skin.position.z = 4;
      },
    ],
  ] as const) {
    change();
    const next = capture();
    for (const triangle of next.triangles) {
      const old = previous.triangles.find(
        (t) =>
          t.objectUuid === triangle.objectUuid &&
          t.elementOffset === triangle.elementOffset,
      )!;
      if (triangle.objectUuid === mesh.uuid) {
        assert.notEqual(triangle, old);
        assert.ok(
          triangle.vertices[0].position[2] > old.vertices[0].position[2],
        );
      } else assert.equal(triangle, old);
    }
    previous = next;
  }
});

test("meshFilter excludes invalid geometry/materials before validation but still traverses children", () => {
  const scene = new THREE.Scene(),
    excluded = new THREE.Mesh(
      new THREE.BufferGeometry(),
      new THREE.ShaderMaterial(),
    ),
    child = new THREE.Mesh(geometry(), new THREE.MeshStandardMaterial()),
    meshCache = createSurfaceMeshCache(),
    visited: THREE.Mesh[] = [];
  excluded.position.z = 3;
  excluded.add(child);
  scene.add(excluded);
  const options = {
    meshCache,
    meshFilter: (mesh: THREE.Mesh) => {
      visited.push(mesh);
      return mesh === child;
    },
    materialAdapter: (material: THREE.Material) => {
      assert.equal(material, child.material);
      return material;
    },
    vertexDeformer: deformer((mesh, _uuid, input) => {
      assert.equal(mesh, child);
      return { position: input.positionLocal };
    }),
  };
  const first = extractSurfaceScene(scene, options);
  assert.deepEqual(visited, [excluded, child]);
  assert.equal(first.materials.length, 1);
  assert.equal(first.triangles.length, 2);
  assert.equal(first.triangles[0].objectUuid, child.uuid);
  assert.equal(first.triangles[0].vertices[0].position[2], 3);
  assert.equal(meshCache.inspect().meshes, 1);
  assert.equal(
    extractSurfaceScene(scene, options).triangles[0],
    first.triangles[0],
  );
  const empty = extractSurfaceScene(scene, {
    meshCache,
    meshFilter: () => false,
  });
  assert.equal(empty.triangles.length, 0);
  assert.equal(empty.materials.length, 0);
  assert.equal(empty.diagnostics.length, 0);
  code(
    () => extractSurfaceScene(scene, { meshCache }),
    "SURFACE_POSITION_MISSING",
  );
});

test("vertex UVs use the existing normalized/interleaved attribute readers and reject invalid values", () => {
  const { scene, g } = setup();
  g.setAttribute(
    "uv",
    new THREE.Uint16BufferAttribute(
      [0, 65535, 65535, 0, 0, 65535, 65535, 65535],
      2,
      true,
    ),
  );
  g.setAttribute(
    "uv1",
    new THREE.InterleavedBufferAttribute(
      new THREE.InterleavedBuffer(
        new Float32Array([99, 0.25, 0.5, 99, 0.5, 0.75, 99, 0.75, 1, 99, 0, 0]),
        3,
      ),
      2,
      1,
    ),
  );
  const inputs: VertexEvaluationInput[] = [],
    vertexDeformer = deformer((_mesh, _uuid, input) => {
      inputs.push(input);
      return undefined;
    });
  extractSurfaceScene(scene, { vertexDeformer });
  assert.deepEqual(inputs[0].uv, [0, 1]);
  assert.deepEqual(inputs[0].uv1, [0.25, 0.5]);
  g.getAttribute("uv1").setX(0, Infinity);
  code(
    () => extractSurfaceScene(scene, { vertexDeformer }),
    "SURFACE_NON_FINITE",
  );
  g.setAttribute("uv1", new THREE.Float32BufferAttribute([0, 0], 2));
  code(
    () => extractSurfaceScene(scene, { vertexDeformer }),
    "SURFACE_ATTRIBUTE_COUNT_INVALID",
  );
  g.setAttribute("uv1", new THREE.Float32BufferAttribute([0, 0, 0, 0], 1));
  code(
    () => extractSurfaceScene(scene, { vertexDeformer }),
    "SURFACE_ATTRIBUTE_UNSUPPORTED",
  );
});

test("base-level vertex texture wrapper matches existing material sampling including UV transform, wrapping, filtering and sRGB", () => {
  const texture = new THREE.DataTexture(
      new Uint8Array([
        128, 64, 32, 255, 16, 192, 96, 128, 32, 128, 224, 64, 255, 160, 80, 192,
      ]),
      2,
      2,
    ),
    { scene, mesh } = setup();
  mesh.material.map = texture;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.offset.set(0.15, -0.1);
  texture.repeat.set(1.5, 0.75);
  texture.center.set(0.5, 0.5);
  texture.rotation = 0.3;
  for (const wrap of [
    THREE.ClampToEdgeWrapping,
    THREE.RepeatWrapping,
    THREE.MirroredRepeatWrapping,
  ] as const) {
    texture.wrapS = texture.wrapT = wrap;
    for (const filter of [THREE.NearestFilter, THREE.LinearFilter] as const) {
      texture.magFilter = filter;
      texture.minFilter =
        filter === THREE.NearestFilter
          ? THREE.LinearFilter
          : THREE.NearestFilter;
      const snapshot = extractSurfaceScene(scene),
        captured = snapshot.textures[0];
      for (const uv of [
        [0.5, 0.5],
        [-1.25, 2.75],
        [0.2, 0.8],
      ] as const) {
        const sampled = sampleSurfaceMaterial(snapshot, 0, [1, 0, 0], {
          uv0: uv,
        });
        near(sampleSurfaceTexture(captured, uv), [
          ...sampled.baseColor,
          sampled.alpha,
        ]);
      }
    }
  }
  texture.offset.set(0, 0);
  texture.repeat.set(1, 1);
  texture.rotation = 0;
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.LinearFilter;
  const snapshot = extractSurfaceScene(scene),
    captured = snapshot.textures[0];
  assert.notDeepEqual(
    sampleSurfaceTexture(captured, [0.5, 0.5]).slice(0, 3),
    sampleSurfaceMaterial(snapshot, 0, [1, 0, 0], {
      uv0: [0.5, 0.5],
      footprint: "minification",
    }).baseColor,
  );
  for (const uv of [
    [NaN, 0],
    [0, Infinity],
    [-Infinity, 1],
  ] as const)
    code(() => sampleSurfaceTexture(captured, uv), "SURFACE_NON_FINITE");
  code(
    () => sampleSurfaceTexture({ ...captured, pixels: undefined }, [0, 0]),
    "SURFACE_TEXTURE_PIXELS_UNAVAILABLE",
  );
});
