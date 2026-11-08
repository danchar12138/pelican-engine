# Editable Terrain

`ctx.terrain` owns editable X/Z height surfaces. The same row-major height grid
produces native collision triangles, visible meshes, tracing geometry and owned
navigation projections. Game code imports only `pelican-engine`.

## Create And Edit

Create terrain once from a game system after its material has been declared:

```ts
ctx.terrain.create({
  id: "ground",
  columns: 17,
  rows: 17,
  cellSize: 1,
  origin: [-8, 0, -8],
  heights: new Array(17 * 17).fill(0),
  material: "ground-material",
  friction: 0.7,
  navigation: { grid: "ground-navigation", maxSlope: Math.PI / 4, maxStep: 0.5 },
});

ctx.terrain.sculpt("ground", {
  center: [0, 0],
  radius: 3,
  delta: 0.25,
  falloff: "smooth",
});

ctx.terrain.setHeights("ground", [
  { column: 8, row: 8, height: 0.3 },
]);
const height = ctx.terrain.sampleHeight("ground", 0, 0);
```

`columns` and `rows` count vertices, not cells, and range from 2 to 64. Heights
are local Y offsets at `row * columns + column`. `origin` is the first vertex's
world position; `cellSize` is the square X/Z spacing. Each host supports up to
128 terrains. No game entity or prefab is required for the terrain itself.
IDs use ASCII letters, digits, `_`, `-` and `.`, start with a letter or digit,
and have at most 128 characters.

Height edits validate the complete batch before changing an owner. Repeated
vertex edits within one batch are rejected. Brush centers/radii use world X/Z
coordinates and support smooth, linear or constant falloff. A successful edit
increments `inspect(id).revision` and emits `terrain.changed`.

## Physics And Rendering

Terrain collision uses a fixed production-physics triangle mesh. Triangle
winding faces positive Y. The native mesh, raster mesh and tracing source share
the same f32 world-space vertices and diagonal split. Queries return the stable
resource ID `$terrain/<id>` for terrain hits; it is not a World entity and must
not be passed to body impulse/velocity APIs.

Native queries are refreshed after an edit without advancing simulation time.
Dynamic rigid bodies are woken. Automatic particle simulations use the terrain
triangles in the shared contact stage. Visible geometry participates in the
existing dynamic-geometry/tracing invalidation path; there is no independent
static tracing substitute.

The production gameplay host prepares 3D physics even when its initial scene
has no authored bodies, so later terrain creation has the same service. This
adds native initialization/memory cost to such scenes; that cost is unmeasured.

Terrain is a height surface, not a closed solid or volumetric field. An edit
that instantly engulfs a rigid body does not guarantee upward ejection. Game
rules may restrict edits around actors or reposition them explicitly. Arbitrary
caves, holes and volumetric destruction are not implemented by this service.

## Navigation

The optional navigation binding owns a grid of `(columns - 1) * (rows - 1)`
cells. A cell is blocked when either triangle exceeds `maxSlope`, its corner
height span exceeds `maxStep`, or its cost exceeds navigation's numeric range.
Walkable cells receive cost `1 + tan(slope)` using the steeper triangle.

```ts
ctx.navigation.createAgent({
  id: "walker-route",
  entity: "walker",
  grid: "ground-navigation",
  terrain: "ground",
  speed: 2,
});
```

Terrain agents use the terrain's X/Z origin, positive row direction and cell
size automatically. Explicit mapping overrides must match. They remain
non-physical root agents; use the character/rigid APIs for physical actors.
Agent movement and idle grounding sample the actual terrain triangles, not a
bilinear height approximation. Terrain edits invalidate affected grid paths.
Destroy dependent navigation agents before destroying their terrain.

## Snapshots And Failures

Terrain, native geometry history and navigation are separate snapshot owners.
Peer preflight requires matching height data, owned grid projections and
terrain-agent mappings before host mutation. Legacy snapshots without terrain
use an empty terrain owner. Terrain edits are recorded in native reconstruction
history; the native world never deserializes caller-provided bytes.

Navigation edits retain a complete owner checkpoint, including agent paths and
dirty state, for rollback around native terrain application.
Any exception after native application begins faults the physics owner, even
when the exception has a stable diagnostic code. Recover a known-good host
checkpoint or restart the scene before continuing; compile success does not
establish native recovery safety.

An event-delivery failure after all owners commit reports `committed=true`;
inspect the terrain revision before retrying that edit.

Current native reconstruction history is bounded to 8,000,000 cumulative terrain
height samples and 100,000 total physics operations per scene. Snapshot native
bytes remain bounded to 64 MiB. Batch edits and choose scene boundaries to avoid
unbounded history growth. Terrain residency, asynchronous asset streaming and
large-world origin shifts remain separate unfinished world work.

Only compilation and builds have been performed for this implementation. Native
collision, navigation, particle coupling, rendering, tracing, snapshots,
failure rollback and resource lifecycle have not been runtime-validated.
