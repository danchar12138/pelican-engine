import * as THREE from "three/webgpu";

export interface Triangle {
  a: number[];
  b: number[];
  c: number[];
  color: number[];
  emission: number;
  roughness: number;
}
export interface PackedGeometry {
  triangles: Float32Array;
  nodes: Float32Array;
  triangleCount: number;
  nodeCount: number;
  bounds: number[];
}

/** Private render adapter. Never exported by the game SDK. */
export function extractTriangles(scene: THREE.Scene): Triangle[] {
  scene.updateMatrixWorld(true);
  const triangles: Triangle[] = [];
  scene.traverseVisible((object) => {
    if (
      !(object instanceof THREE.Mesh) ||
      !object.visible ||
      object.userData.noTrace
    )
      return;
    if (object instanceof THREE.SkinnedMesh) object.skeleton.update();
    const material = (
      Array.isArray(object.material) ? object.material[0] : object.material
    ) as THREE.MeshStandardMaterial;
    const geometry = object.geometry;
    const count =
      geometry.index?.count ?? geometry.getAttribute("position").count;
    const points = [
      new THREE.Vector3(),
      new THREE.Vector3(),
      new THREE.Vector3(),
    ];
    const instanced = object instanceof THREE.InstancedMesh ? object : undefined;
    const instance = new THREE.Matrix4(), transform = new THREE.Matrix4();
    for (let slot = 0; slot < (instanced?.count ?? 1); slot++) {
      if (instanced) {
        instanced.getMatrixAt(slot, instance);
        transform.multiplyMatrices(object.matrixWorld, instance);
      } else transform.copy(object.matrixWorld);
      for (let i = 0; i < count; i += 3) {
        for (let k = 0; k < 3; k++)
          object
            .getVertexPosition(geometry.index?.getX(i + k) ?? i + k, points[k])
            .applyMatrix4(transform);
        const color = material.color ?? new THREE.Color(0.6, 0.6, 0.6);
        triangles.push({
          a: points[0].toArray(),
          b: points[1].toArray(),
          c: points[2].toArray(),
          color: color.toArray(),
          emission:
            material.emissiveIntensity && material.emissive?.getHex()
              ? material.emissiveIntensity
              : 0,
          roughness: material.roughness ?? 0.8,
        });
      }
    }
  });
  return triangles;
}

/** Median-split CPU BVH prototype. Each upload is explicitly measured, not marketed as GPU refit. */
export function buildBVH(input: Triangle[]): PackedGeometry {
  const ordered: Triangle[] = [];
  const nodes: number[][] = [];
  const boundsOf = (triangles: Triangle[]) => {
    const low = [Infinity, Infinity, Infinity],
      high = [-Infinity, -Infinity, -Infinity];
    for (const triangle of triangles)
      for (const p of [triangle.a, triangle.b, triangle.c])
        for (let i = 0; i < 3; i++) {
          low[i] = Math.min(low[i], p[i]);
          high[i] = Math.max(high[i], p[i]);
        }
    return { low, high };
  };
  const visit = (triangles: Triangle[]): number => {
    const index = nodes.length;
    nodes.push([]);
    const { low, high } = boundsOf(triangles);
    if (triangles.length <= 4) {
      const offset = ordered.length;
      ordered.push(...triangles);
      nodes[index] = [...low, offset, ...high, triangles.length];
    } else {
      const axis = high
        .map((v, i) => v - low[i])
        .indexOf(Math.max(...high.map((v, i) => v - low[i])));
      triangles.sort(
        (x, y) =>
          x.a[axis] +
          x.b[axis] +
          x.c[axis] -
          (y.a[axis] + y.b[axis] + y.c[axis]),
      );
      const middle = triangles.length >> 1;
      const left = visit(triangles.slice(0, middle)),
        right = visit(triangles.slice(middle));
      nodes[index] = [...low, left, ...high, -right];
    }
    return index;
  };
  if (!input.length) throw new Error("TC_RENDER_EMPTY_GEOMETRY");
  visit([...input]);
  const packed = new Float32Array(ordered.length * 20);
  ordered.forEach((t, i) =>
    packed.set(
      [
        ...t.a,
        t.emission,
        ...t.b,
        t.roughness,
        ...t.c,
        0,
        ...t.color,
        0,
        0,
        0,
        0,
        0,
      ],
      i * 20,
    ),
  );
  return {
    triangles: packed,
    nodes: new Float32Array(nodes.flat()),
    triangleCount: ordered.length,
    nodeCount: nodes.length,
    bounds: [...nodes[0].slice(0, 3), ...nodes[0].slice(4, 7)],
  };
}
