/** GPU-only depth-first escape layout; CPU acceleration ABI stays unchanged. */
export function packTraversalNodes(nodes: Float32Array) {
  if (nodes.length % 8)
    throw new Error("TC_TRACE_NODE_LAYOUT: Expected eight-float nodes.");
  const output = nodes.slice(),
    visited = new Set<number>();
  const count = nodes.length / 8;
  const visit = (index: number): number => {
    if (
      !Number.isSafeInteger(index) ||
      index < 0 ||
      index >= count ||
      visited.has(index)
    )
      throw new Error("TC_TRACE_NODE_LAYOUT: Invalid or cyclic node pointer.");
    visited.add(index);
    const offset = index * 8;
    if (nodes[offset + 7] > 0) {
      return index + 1;
    }
    const left = nodes[offset + 3],
      right = -nodes[offset + 7];
    if (left !== index + 1)
      throw new Error(
        "TC_TRACE_NODE_LAYOUT: Threading requires the validated depth-first node order.",
      );
    const endLeft = visit(left);
    if (endLeft !== right)
      throw new Error("TC_TRACE_NODE_LAYOUT: Sibling ranges overlap.");
    const end = visit(right);
    output[offset + 3] = end;
    output[offset + 7] = 0;
    return end;
  };
  if (count) {
    const end = visit(0);
    if (end !== count || visited.size !== count)
      throw new Error("TC_TRACE_NODE_LAYOUT: Unreachable acceleration nodes.");
  }
  return output;
}

/** Positions/material/orientation occupy compact cache lines beside the node tree. */
export function packTraversalData(nodes: Float32Array, geometry: Float32Array) {
  if (geometry.length % 72)
    throw new Error(
      "TC_TRACE_TRIANGLE_LAYOUT: Expected surface ABI triangles.",
    );
  const count = geometry.length / 72,
    output = new Float32Array(nodes.length + count * 12);
  output.set(packTraversalNodes(nodes));
  for (let index = 0; index < count; index++) {
    const source = index * 72,
      target = nodes.length + index * 12;
    output.set(geometry.subarray(source, source + 4), target);
    output.set(
      [
        geometry[source + 4],
        geometry[source + 5],
        geometry[source + 6],
        geometry[source + 63],
      ],
      target + 4,
    );
    output.set(
      [geometry[source + 8], geometry[source + 9], geometry[source + 10], 0],
      target + 8,
    );
  }
  return output;
}
