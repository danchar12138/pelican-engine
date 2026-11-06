# Ordered Traversal Nodes

Optional development ABI only. This CPU packing utility now has an experimental
GPU traversal probe, but is not enabled by the default renderer. Correctness and
native performance were checked separately: exact image parity and ray tests
passed, but A-B-B-A timing showed no demonstrated speedup. See the experiment
record in `evidence/m3/experiments/1793832880000/`. No M3 acceptance follows.

`packOrderedTraversalData(nodes: Float32Array, geometry: Float32Array): Float32Array`
is exported directly from `src/ordered-traversal-nodes.ts`. Inputs use the existing
eight-float CPU node ABI and 72-float surface triangle ABI. Neither input changes;
each call returns an independent buffer, including empty calls.

## Node Layout

Each node occupies 12 floats. Node indices are not float-element offsets.

| Offset | Value                                                                                     |
| ------ | ----------------------------------------------------------------------------------------- |
| 0..7   | Exact original eight CPU node floats, including leaf start/count or signed child pointers |
| 8      | Parent node index; root uses `nodeCount`                                                  |
| 9      | Left child from original `nodes[index * 8 + 3]`; leaves use `nodeCount`                   |
| 10     | Right child from original `-nodes[index * 8 + 7]`; leaves use `nodeCount`                 |
| 11     | End-exclusive subtree escape from the existing traversal packer; a leaf uses `index + 1`  |

The root escape and final leaf escape equal `nodeCount`. The first eight floats
are not the rewritten eight-float threaded GPU node layout.

## Geometry Payload

The payload begins at float offset `nodeCount * 12`. It is copied unchanged from
the compact geometry suffix of `packTraversalData(nodes, geometry)`: 12 floats
per triangle, in the same order, with the same positions, material index, mirrored
orientation, and padding. There is no new geometry format.

## Validation And Lifetime

Layouts must contain whole records. Bounds must be finite with minima no greater
than maxima; fractional coordinates are valid. Counts and integer pointers must
fit the contiguous exact-float integer range `0..2^24`. Internal child indices
must be in range; positive leaf counts and nonnegative starts must stay within
the supplied triangle count. Geometry values are copied under the existing
packer's contract, not reinterpreted or independently validated here.

The existing traversal module validates preorder, full node reachability, sibling
ranges and cycles before an output is published. Its subtree escapes and geometry
packing remain authoritative. This wrapper adds no depth cap or fixed-size stack;
the existing validator's JavaScript recursion/runtime resource limits still apply.
Invalid nodes use `TC_TRACE_NODE_LAYOUT`; incomplete triangle records use
`TC_TRACE_TRIANGLE_LAYOUT`.

Empty nodes with empty geometry produce an empty independent array. Nonempty
geometry without a root, or leaves extending beyond empty geometry, are rejected.
The packer holds no state: repack the current CPU nodes and ordered geometry after
a refit or rebuild, and retain prior results as detached snapshots. Leaf ranges
are checked for bounds, not for complete or unique triangle coverage.

## GPU Prefix-Preserving Variant

`packParentLinkedTraversalData` transposes the validated ordered data into the
existing eight-float threaded node prefix and twelve-float compact geometry,
followed by four-float parent/left/right/escape records. The entire old prefix is
byte-identical to `packTraversalData`; any-hit shadow traversal therefore uses the
same layout and algorithm. WGSL `surfaceOrderedTraversal=true` uses the metadata
tail for near-first closest-hit with a two-index parent cursor, not a fixed stack.
The CPU adapter is tested with a 256-level tree; actual GPU queries include depth 128. These tests demonstrate those cases, not arbitrary resource-unbounded trees.

The renderer explicitly selects `surfaceOrderedTraversal=false` and uploads only
the original prefix. The experiment's additional CPU packing/upload cost is not
introduced into the default path merely because its correctness tests passed.
