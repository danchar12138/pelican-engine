# CPU Binned SAH Topology (M3)

This note supersedes only the median-build description in ACCELERATION.md.
The other acceleration contracts remain unchanged. This is a CPU topology
builder for existing world-space triangles, not GPU build/refit, BLAS/TLAS,
hardware ray tracing, a GPU traversal change, or GPU performance evidence.

## Algorithm

- Sixteen equal-width centroid bins on each of x, y, z. Triangle centroids
  retain the previous builder's arithmetic vertex average, computed in Float64.
  Each bin stores the union of actual triangle AABBs and its primitive count.
- Prefix/suffix AABB unions evaluate all 15 boundaries on all nonconstant axes.
  Minimize `area(left) * count(left) + area(right) * count(right)`, with
  `area = 2 * (dx*dy + dy*dz + dz*dx)` and primitive weight 1. This is the
  geometric SAH split ranking described by Physically Based Rendering, fourth
  edition, "Bounding Volume Hierarchies", section "The Surface Area Heuristic".
  The common parent-area denominator and constant traversal term do not change
  the winning split. There is no material/shader cost, ray feedback, scene-name
  branch, camera dependence, or timing-based tuning.
- Leaves always contain 1-4 triangles. For a larger partition, splitting is
  mandatory even if a leaf would have lower estimated SAH cost.
- Require both sides to contain at least `ceil(count / 32)` triangles. Root
  depth is 1. Global budget is `2 * ceil(log2(max(1, ceil(N / 4)))) + 1`.
  A candidate must leave enough budget for a balanced median tail:
  `level + 1 + ceil(log2(ceil(max(leftCount,rightCount) / 4))) <= budget`.
- If no candidate survives, fall back to widest-centroid-axis balanced median,
  ties broken by source index. This includes coincident centroids, empty/invalid
  partitions, exhausted SAH depth budget, and a zero/underflowed parent area.
  True zero-area triangles still reject under the existing validation contract;
  they are never silently discarded. A planar AABB can have positive area and
  is handled normally.
- Axis/bin cost ties retain the first axis/bin. A shared O(N) scratch buffer
  makes the chosen bin partition stable within each side. Temporary Float64
  centers/AABBs and bin workspace are build-local, not retained across updates.

With fixed bins and the depth budget, SAH scanning is O(N log N). Sorting
median fallback partitions retains an O(N log-squared N) comparison bound.
Auxiliary storage is O(N); recursive depth is O(log N). A constant-centroid
scene uses balanced median throughout, including the original 131073-triangle
regression. The guards trade some possible SAH quality for bounded depth and
complete primitive retention; they do not add a new scene-size cap.

## ABI And Updates

Nodes remain eight Float32 values:
`[minX,minY,minZ,leftOrLeafStart,maxX,maxY,maxZ,negativeRightOrLeafCount]`.
Internal left pointers are positive, right pointers negative; leaves keep
positive counts of at most four. Exact-integer capacity checks and outward
Float32 rounding are unchanged. Actual exported bounds still come from the
existing leaf-bounds and bottom-up-refit implementation, not the SAH estimates.

Allocation remains depth-first preorder, with contiguous subtrees:
`left === index + 1`, `leftSubtreeEnd === right`, and
`rightSubtreeEnd === parentEscape`. Root escape is the node count. Tests check
all these relations explicitly, before and after refit, for mainline escape
packing. This work does not implement or alter escape packing itself.

Reordering only remaps sourceIndices; leaf slots and pointers remain stable.
Position updates refit the same partition, including motion across old splits.
Repeated deformation can worsen traversal quality: no automatic rebuild is
introduced. Topology/identity changes still rebuild. Existing changes kinds,
revision rules, dirty ranges, nearest-hit/tie rules, buffer isolation and
failure publication semantics remain unchanged. In particular, the
isFrozenCapturedPixels/copyPixels provenance fast path is retained, and failed
updates do not clear prior frozen-data or validated-triangle caches. Caller
snapshots remain immutable by contract; validation of mutable records does not
turn accepted records into internally owned copies.

## Reproducible Geometry And Rays

All generators and an independent test-only longest-centroid-axis median
builder live in tests/acceleration-sah.test.ts. Both trees use the same
instrumented CPU traversal with outward-rounded bounds and Three's independent
triangle intersection. The median reference does not call production build or
intersect. Counters include every box evaluation (including misses) and every
triangle evaluation. Total work is `rayBoxTests + triangleTests`, weights 1.
These counters are not shader instruction counts, GPU cycles, or milliseconds.

The LCG is `state = (1664525 * state + 1013904223) mod 2^32`, returning
`state / 2^32`. Scene seeds are 0x51a7c001, 0x51a7c002, 0x51a7c003. Each
cost test uses 1536 rays, with the seed XOR 0x6a09e667. Rays mix interior,
front/back/side cameras, aimed interior triangle points and uncorrelated
targets; every seventh ray has finite maxDistance 8. All other limits are
Infinity. The test compares hit/miss, source index and distance for every ray,
under both left-first and near-first traversal. It asserts only a strict
reduction in computed total work, not a fitted percentage or elapsed time.

| Scene                | Exact Construction                                                                                                                                                                                                                            |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| clusters             | 896 small triangles; centers (-18,-4,0), (-17,5,1), (0,0,0), (2,7,-3), (18,-2,2); populations 128/192/384/128/64; 1.8-wide jitter; sizes 0.04-0.20                                                                                            |
| wide-walls           | 64 broad triangles: 32 layered 48x12 rectangular walls at z=-4-0.08\*i; 1024 small foreground triangles in a 4x4 cluster arrangement, z in [1,7), sizes 0.06-0.26                                                                             |
| bottle-cloud-remotes | 48x48 lathed body quads, two triangles each, height 4; body radius about 1, taper at normalized heights 0.65-0.82 to neck radius 0.35; 32 remote four-face tetrahedra, abs(x) in [7,10), y/z in [-4,4), sizes 0.05-0.20; 4736 total triangles |

The bottle is generated geometry, **not** a measured WaterBottle asset. There
are no Fox/WaterBottle downloads, actual-scene GPU traces or GPU timing here.

## Raw CPU Evidence

Windows, Node v24.15.0, 2026-11-04. Each row is a single deterministic 1536-ray
run; counts reproduce exactly, timings need not. No bins, guards or weights
were adjusted after examining these scene costs.

| Scene                | Order      | Hits | SAH Box | SAH Triangle | SAH Total | Median Box | Median Triangle | Median Total | SAH/Median |
| -------------------- | ---------- | ---: | ------: | -----------: | --------: | ---------: | --------------: | -----------: | ---------: |
| clusters             | left-first | 1148 |   55072 |        13449 |     68521 |      66562 |           27062 |        93624 |   0.731874 |
| clusters             | near-first | 1148 |   46090 |         8684 |     54774 |      52944 |           19177 |        72121 |   0.759474 |
| wide-walls           | left-first | 1201 |   38692 |        27206 |     65898 |      90358 |           40146 |       130504 |   0.504950 |
| wide-walls           | near-first | 1201 |   26934 |         6598 |     33532 |      75060 |           30482 |       105542 |   0.317712 |
| bottle-cloud-remotes | left-first | 1172 |   54638 |         9211 |     63849 |      90044 |           16266 |       106310 |   0.600593 |
| bottle-cloud-remotes | near-first | 1172 |   38280 |         5524 |     43804 |      60154 |           10362 |        70516 |   0.621192 |

One standalone test-file run reported the following raw CPU timings in ms.
SAH buildMs/refitMs are the existing update metrics: validation, tree work,
identity handling, dirty scanning and output copies up to publication. Refit
moves every fifth triangle by (0.1,-0.05,0.03), leaving the others shared/frozen.
Median reference time measures only test tree construction and output buffers,
without production validation or update/publication work; it is not an
apples-to-apples production builder benchmark. No time thresholds are asserted.

| Scene                | SAH Nodes | SAH Depth | Median Nodes | Build ms | Refit ms | Reference Build ms |
| -------------------- | --------: | --------: | -----------: | -------: | -------: | -----------------: |
| clusters             |       599 |        13 |          511 |  16.7828 |   3.5262 |             7.6477 |
| wide-walls           |       695 |        12 |          639 |  13.0649 |   3.4280 |             8.6086 |
| bottle-cloud-remotes |      2775 |        13 |         3327 |  51.2942 |  16.5143 |            23.6197 |

SAH can increase node counts (as for clusters/walls), adds CPU build work, and
is not guaranteed to improve arbitrary geometry or rays. The exponential
pathology test has 8193 triangles, seed 0x51a7dead, x=2^(floor(i/64)-64),
size=x\*0.001; its measured depth is 25, equal to its budget, with all sources
retained. A shorter-centroid-axis broad-sheet test separately checks that the
builder really evaluates all three axes rather than only the widest one.

## Verification And Handoff

```sh
node node_modules/typescript/bin/tsc --noEmit
node --import tsx --test tests/acceleration.test.ts tests/acceleration-sah.test.ts tests/surface-cache.test.ts
node node_modules/prettier/bin/prettier.cjs --check packages/renderer/src/acceleration.ts tests/acceleration-sah.test.ts packages/renderer/SAH.md
```

The original 19 acceleration and 9 surface-cache tests are unchanged. Twelve
new tests cover three representative cost scenes, 192 independently generated
brute-force rays per scene at each of original/reordered/refitted states,
source remapping, stable partitions/pointers, exact outward containment,
preorder escapes, coincident/overlapping geometry, tiny planar bounds,
zero-area rejection, ratio/depth guards, mutable failures and persistence of
prior frozen validation after rejection. The original 131073-coincident test
still exercises build/refit/query without overflowing recursion or traversal.

Final verification passed TypeScript, the three-file Prettier check, and all
84 tests in acceleration, acceleration-sah, surface-cache, surface,
surface-capture, surface-pixel-validation and texture-pixels. The existing
texture-pixels browser test also ran its ordinary image/texture checks; that
is not a GPU path-tracing benchmark. Production source before build (apart
from the two SAH constants) and after build was checked byte-for-byte against
the starting acceleration source, preserving validation/refit/query code.

Only these paths are delivered:

- packages/renderer/src/acceleration.ts
- tests/acceleration-sah.test.ts (new)
- packages/renderer/SAH.md (new)

No main-worktree, shader, SDK, existing-test, dependency or commit changes.
Mainline owns actual scene integration and native 1920x1080, five-bounce,
one-sample GPU measurements with its threaded/escape traversal and attribute
memory changes. This work neither lowers those requirements nor establishes
GPU speedup or image correctness on actual Fox/WaterBottle/studio scenes.
