import { packTraversalData } from "./traversal-nodes.ts";

const MAX_EXACT_POINTER = 2 ** 24;

function nodeError(message: string): never {
  throw new Error("TC_TRACE_NODE_LAYOUT: " + message);
}

function exactPointer(value: number): boolean {
  return (
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= MAX_EXACT_POINTER &&
    Math.fround(value) === value
  );
}

/** Optional development ABI: original CPU nodes followed by parent/child/escape links. */
export function packOrderedTraversalData(
  nodes: Float32Array,
  geometry: Float32Array,
): Float32Array {
  if (nodes.length % 8) nodeError("Expected eight-float CPU nodes.");
  if (geometry.length % 72)
    throw new Error(
      "TC_TRACE_TRIANGLE_LAYOUT: Expected surface ABI triangles.",
    );
  const nodeCount = nodes.length / 8,
    triangleCount = geometry.length / 72;
  if (!exactPointer(nodeCount) || !exactPointer(triangleCount))
    nodeError("Node and triangle counts must fit exact float pointers.");
  if (!nodeCount && triangleCount)
    nodeError("Nonempty geometry requires a reachable root node.");

  for (let index = 0; index < nodeCount; index++) {
    const offset = index * 8;
    for (let axis = 0; axis < 3; axis++) {
      const min = nodes[offset + axis],
        max = nodes[offset + axis + 4];
      if (!Number.isFinite(min) || !Number.isFinite(max) || min > max)
        nodeError("Node " + index + " requires finite, ordered bounds.");
    }
    const first = nodes[offset + 3],
      tag = nodes[offset + 7];
    if (!exactPointer(first) || !exactPointer(Math.abs(tag)))
      nodeError("Node " + index + " requires exact integer pointers/counts.");
    if (tag > 0) {
      if (first + tag > triangleCount)
        nodeError("Leaf " + index + " exceeds the packed triangle range.");
    } else if (first >= nodeCount || -tag >= nodeCount)
      nodeError("Node " + index + " has an out-of-range child pointer.");
  }

  // The existing packer validates preorder, cycles and reachability, and owns
  // both subtree escapes and the compact triangle payload.
  const threaded = packTraversalData(nodes, geometry),
    output = new Float32Array(nodeCount * 12 + triangleCount * 12);
  for (let index = 0; index < nodeCount; index++) {
    const source = index * 8,
      target = index * 12,
      leaf = nodes[source + 7] > 0;
    output.set(nodes.subarray(source, source + 8), target);
    output[target + 8] = nodeCount;
    output[target + 9] = leaf ? nodeCount : nodes[source + 3];
    output[target + 10] = leaf ? nodeCount : -nodes[source + 7];
    output[target + 11] = leaf ? index + 1 : threaded[source + 3];
  }
  for (let index = 0; index < nodeCount; index++) {
    const offset = index * 12;
    if (nodes[index * 8 + 7] > 0) continue;
    output[output[offset + 9] * 12 + 8] = index;
    output[output[offset + 10] * 12 + 8] = index;
  }
  output.set(threaded.subarray(nodes.length), nodeCount * 12);
  return output;
}

/** Keep the existing threaded bounds/geometry prefix; closest-hit metadata follows it. */
export function packParentLinkedTraversalData(
  nodes: Float32Array,
  geometry: Float32Array,
): Float32Array {
  const ordered = packOrderedTraversalData(nodes, geometry),
    nodeCount = nodes.length / 8,
    triangleCount = geometry.length / 72,
    metadata = nodeCount * 8 + triangleCount * 12,
    output = new Float32Array(ordered.length);
  for (let index = 0; index < nodeCount; index++) {
    const source = index * 12,
      target = index * 8;
    output.set(ordered.subarray(source, source + 8), target);
    if (nodes[target + 7] <= 0) {
      output[target + 3] = ordered[source + 11];
      output[target + 7] = 0;
    }
    output.set(ordered.subarray(source + 8, source + 12), metadata + index * 4);
  }
  output.set(ordered.subarray(nodeCount * 12), nodeCount * 8);
  return output;
}
