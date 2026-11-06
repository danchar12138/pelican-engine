# M3 Graph Stabilization Handoff

This is a narrow stabilization of the current graph WIP, not CAP17 acceptance.
Browser integration belongs to main. No browser, fallback, SDK, runtime, tools,
package metadata, compiler entry point, commit, push, or release changes are made
by this work. The npm and WebGL2 fallback scope decisions remain unchanged.

## Contracts

- `select(a, b, condition)` means false selects `a`, true selects `b` on CPU,
  WGSL, and TSL. Three's TSL select takes its true arm first.
- Material graph texture sampling explicitly uses base LOD 0. It does not use
  implicit raster derivatives. This does not change standard material-map LOD.
- `baseColor` replaces standard color and base-map RGB, while retaining Three's
  enabled vertex-color and instance-color multiplication. It does not multiply
  by the authored material color. A base-color graph has implicit alpha 1 before
  enabled vertex alpha and the opacity factor.
- `opacity` replaces the standard opacity/alpha-map factor, NOT final alpha.
  Clamp it to [0,1], then multiply by the remaining base-map/vertex alpha. A
  base-color graph also replaces the base map, including its alpha. Surface
  adapters set standard opacity to 1 and remove alphaMap for this hook; coverage
  and full surface evaluation use the same multiplication.
- `normalWorld` outputs an absolute unsided world-space direction. Normalize
  safely, use the geometric normal for an exact zero vector, then orient once
  for the material boundary. A zero hook does not restore the standard normal
  map. The raster adapter returns view space for `normalNode`.
- Graph emissive values replace standard emission. Emitting graph materials
  receive a positive area-based light proposal even when standard emissive is
  black or its intensity is zero. The proposal is separate from actual surface
  radiance, which is still evaluated by the graph at each sample. This ensures
  sampling support, not optimal importance weights for arbitrary procedural maps.
- All nodes are validated, including dead nodes. Only output-reachable nodes,
  input requirements, and texture IDs enter emitted IR. Dead view inputs no
  longer incorrectly reject otherwise view-independent opacity/emissive graphs.
- Reachable compute `sampleTexture` produces `TC_COMPUTE_TEXTURE` at the original
  node's `op` field. The runtime guard also rejects direct texture IR before CPU
  evaluation/GPU work. Compute texture bindings are not implemented.
- GPU graph work has a 10-second deadline covering shader compilation,
  pipeline creation, mapping, and validation. Scopes are popped once, buffers
  are destroyed on exit, and late continuations check cancellation before
  allocating/reading. Surface pipeline replacement is atomic and rejects
  disposed/stale content. Motion and volume variants use the same deadline.
- Legacy graph.ts entry points infer missing nodeTypes without mutating the
  caller. The typed mapper itself still rejects malformed typed IR. The f32
  overflow fixture uses `3.4028236e38`; `3.4028235e38` still rounds to finite f32
  and remains accepted under the existing shared value rule.

## Exact Browser Integration

In `packages/renderer/src/browser.ts`, main should extend the existing import:

```ts
import { typedGraphToTSL, materialGraphNormalToTSL } from "./graph-tsl.ts";
```

In the existing channel loop, replace the bare normal transform and clamp scalar
hooks before assigning the existing channel-to-NodeMaterial property mapping:

```ts
let node = typedGraphToTSL(graph, graphTime, uniforms, textures);
if (channel === "normalWorld") node = materialGraphNormalToTSL(node);
else if (["roughness", "metalness", "opacity"].includes(channel))
  node = node.clamp(0, 1);
// Keep the existing assignment of node to colorNode/emissiveNode/etc.
```

Do not multiply a base-color hook by material.color or material.map, and do not
apply another normal transform/face sign after this helper. If cameraViewMatrix
becomes unused, remove only that now-unused import. For the opacity hook:

```ts
if (graphs.opacity) {
  material.transparent = true;
  material.alphaMap = null;
}
```

Keep material.opacity as authored if desired: opacityNode replaces that factor.
Do not also multiply the node by material.opacity or clear material.map solely
for an opacity hook. Standard base-map alpha must still contribute when there
is no base-color hook. Clearing alphaMap explicitly matches surface capture and
avoids misleading stale map state, although Three's opacityNode bypasses it.

Surface capture now rejects missing reachable uv/uv1 with `TC_GRAPH_UV`, including
material ID, object UUID, and geometry UUID. Raster-only rendering must perform
the same validation before content commit, since it does not call capture. After
all entity/model meshes have been instantiated, before swapping the active root:

```ts
const byMaterial = new Map<THREE.Material, MaterialGraphBinding>(
  nextGraphs.map((item) => [item.material, item.binding]),
);
nextRoot.traverse((object) => {
  if (!(object instanceof THREE.Mesh)) return;
  const materials = Array.isArray(object.material)
    ? object.material
    : [object.material];
  for (const material of materials) {
    const binding = byMaterial.get(material);
    if (!binding) continue;
    for (const graph of Object.values(binding.graphs)) {
      for (const input of graph.requiredInputs ?? []) {
        if (
          (input === "uv" || input === "uv1") &&
          !object.geometry.hasAttribute(input)
        )
          throw Error(
            "TC_GRAPH_UV: Material " +
              binding.id +
              " requires " +
              input +
              " on object " +
              object.uuid +
              " geometry " +
              object.geometry.uuid,
          );
      }
    }
  }
});
```

This is independent of backend/fallback selection. Keep the existing material
uniform/time updates and pass the registered bindings into surface capture.
The graph-emissive proposal is already connected inside SurfaceTracer; no
browser-side emissive-color workaround is required.

## Verification Boundary

Focused tests cover compiler reachability/diagnostics, legacy evaluation, TSL
node arm/LOD construction, capture UV validation, channel lowering, emitter
proposal support, mocked GPU timeout/loss/cleanup, and atomic stale pipeline
replacement. They are not hardware image-parity evidence. Raster/path/hybrid
pixel tests for textured alpha, vertex/instance tint, normal sidedness (including
flat/mirrored/physical cases), and procedural emitters remain integration work.
