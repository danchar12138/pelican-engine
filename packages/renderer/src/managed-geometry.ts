import * as THREE from "three/webgpu";
import type { Geometry } from "../../sdk/src/index.ts";

const MAX_VERTICES = 1048576,
  MAX_INDICES = 3145728;
/** Internal renderer factory. Each call owns copies; the mesh owner disposes the result. */
export function createManagedGeometry(
  input: Geometry,
  owner: string,
): THREE.BufferGeometry {
  const fail = (code: string, field: string, detail: string): never => {
    throw new Error(
      `${code}: ${owner}.geometry.${field}: ${detail} Repair: Supply finite float32 attributes and complete triangles with valid integer indices.`,
    );
  };
  if (input.kind === "box")
    return new THREE.BoxGeometry(...(input.size ?? [1, 1, 1]));
  if (input.kind === "sphere")
    return new THREE.SphereGeometry(
      input.radius ?? 0.5,
      input.segments ?? 64,
      Math.max(8, Math.ceil((input.segments ?? 64) / 2)),
    );
  if (input.kind === "plane")
    return new THREE.PlaneGeometry(...(input.size ?? [1, 1]));
  if (input.kind !== "buffer")
    return fail("TC_GEOMETRY_KIND", "kind", "Unknown geometry kind.");
  for (const field of Object.keys(input))
    if (
      ![
        "kind",
        "positions",
        "normals",
        "uv",
        "indices",
        "computeBounds",
      ].includes(field)
    )
      fail("TC_GEOMETRY_FIELD", field, "Unknown buffer geometry field.");
  const attribute = (
    field: "positions" | "normals" | "uv",
    stride: number,
    required = false,
  ): Float32Array | undefined => {
    const values = input[field];
    if (values === undefined && !required) return undefined;
    if (
      !Array.isArray(values) ||
      !values.length ||
      values.length % stride ||
      values.length > MAX_VERTICES * stride
    )
      return fail(
        "TC_GEOMETRY_ATTRIBUTE",
        field,
        `Expected a flat array with ${stride} components per vertex (at most ${MAX_VERTICES} vertices).`,
      );
    const copy = new Float32Array(values.length);
    for (let i = 0; i < values.length; i++) {
      const value = values[i];
      if (
        typeof value !== "number" ||
        !Number.isFinite(value) ||
        !Number.isFinite(Math.fround(value)) ||
        (value !== 0 && Math.fround(value) === 0)
      )
        fail(
          "TC_GEOMETRY_NUMBER",
          `${field}[${i}]`,
          "Value is not representable as finite float32.",
        );
      copy[i] = value!;
    }
    return copy;
  };
  const positions = attribute("positions", 3, true)!,
    normals = attribute("normals", 3),
    uv = attribute("uv", 2);
  const count = positions.length / 3;
  if (normals && normals.length !== positions.length)
    fail(
      "TC_GEOMETRY_ATTRIBUTE",
      "normals",
      "Vertex count differs from positions.",
    );
  if (uv && uv.length !== count * 2)
    fail("TC_GEOMETRY_ATTRIBUTE", "uv", "Vertex count differs from positions.");
  const indices = input.indices;
  if (indices !== undefined) {
    if (
      !Array.isArray(indices) ||
      !indices.length ||
      indices.length % 3 ||
      indices.length > MAX_INDICES
    )
      fail(
        "TC_GEOMETRY_INDEX",
        "indices",
        `Expected complete triangles (at most ${MAX_INDICES} indices).`,
      );
    for (let i = 0; i < indices.length; i++)
      if (
        !Number.isSafeInteger(indices[i]) ||
        indices[i]! < 0 ||
        indices[i]! >= count
      )
        fail(
          "TC_GEOMETRY_INDEX",
          `indices[${i}]`,
          "Index is outside the vertex buffer.",
        );
  } else if (count % 3)
    fail(
      "TC_GEOMETRY_INDEX",
      "positions",
      "Nonindexed positions must contain complete triangles.",
    );
  if (
    input.computeBounds !== undefined &&
    typeof input.computeBounds !== "boolean"
  )
    fail("TC_GEOMETRY_BOUNDS", "computeBounds", "Expected boolean.");
  // Accumulate in float64 so large, valid float32 positions cannot overflow normal attributes.
  const generated = normals ? undefined : new Float64Array(positions.length);
  if (generated)
    for (let i = 0; i < (indices?.length ?? count); i += 3) {
      const a = (indices?.[i] ?? i) * 3,
        b = (indices?.[i + 1] ?? i + 1) * 3,
        c = (indices?.[i + 2] ?? i + 2) * 3;
      const ux = positions[b]! - positions[a]!,
        uy = positions[b + 1]! - positions[a + 1]!,
        uz = positions[b + 2]! - positions[a + 2]!;
      const vx = positions[c]! - positions[a]!,
        vy = positions[c + 1]! - positions[a + 1]!,
        vz = positions[c + 2]! - positions[a + 2]!;
      const nx = uy * vz - uz * vy,
        ny = uz * vx - ux * vz,
        nz = ux * vy - uy * vx;
      for (const index of [a, b, c]) {
        generated[index] = generated[index]! + nx;
        generated[index + 1] = generated[index + 1]! + ny;
        generated[index + 2] = generated[index + 2]! + nz;
      }
    }
  const source = normals ?? generated!,
    normal = normals ?? new Float32Array(positions.length);
  for (let i = 0; i < source.length; i += 3) {
    const length = Math.hypot(source[i]!, source[i + 1]!, source[i + 2]!);
    if (!length && normals)
      fail(
        "TC_GEOMETRY_NORMAL",
        `normals[${i / 3}]`,
        "Normal must be nonzero.",
      );
    // Degenerate or unused generated vertices retain zero normals, as in Three.js.
    for (let axis = 0; axis < 3; axis++)
      normal[i + axis] = length ? source[i + axis]! / length : 0;
  }
  const geometry = new THREE.BufferGeometry();
  try {
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute("normal", new THREE.BufferAttribute(normal, 3));
    if (uv) geometry.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
    if (indices) geometry.setIndex(Array.from(indices));
    if (input.computeBounds !== false) {
      geometry.computeBoundingBox();
      geometry.computeBoundingSphere();
    }
    return geometry;
  } catch (error) {
    geometry.dispose();
    throw error;
  }
}
