# Physical Volume Integration (M3 Development)

This describes the current integration, not formal M3 acceptance. Historical
standalone validation in `DIELECTRIC.md` and `MEDIUM.md` remains valid for those
modules; its earlier "not integrated" statements describe that earlier phase.

## Representation

The public SDK/compiler accepts transmission, IOR, attenuation color and distance.
Opacity remains independent alpha coverage. The browser privately constructs a
physical NodeMaterial; the capture adapter copies only known supported fields into
the immutable surface snapshot. Other physical extensions/maps still diagnose.

GPU material rows have 32 float32 words (128 bytes), not the earlier 24 words:

| Float Offset | Contents                                                       |
| ------------ | -------------------------------------------------------------- |
| 0-23         | Existing base/factors/emission/maps/normal                     |
| 24-27        | transmission, IOR, attenuation distance (0 disables), reserved |
| 28-31        | Linear attenuation RGB, reserved                               |

Triangle rows remain 72 float32 words: offset 63 stores mirrored orientation and
67 stores the object/instance volume ID. Material identity is not volume identity.
The integrator uniform is now 368 bytes: its original 288-byte prefix retains
the medium-table vec4, and an 80-byte previous-camera/view-projection suffix is
shared with primary motion. The medium table and initial stack are stored after
lights in the existing storage buffer; the light count excludes those records.

The output storage buffer has a 16-byte atomic diagnostic header before its four
pixel planes. Buffer copies/readbacks must account for that header. Faults include
missing IDs, boundary order/duplicate entry, a miss inside a volume and capacity. Diagnostics are
sticky for the current content generation and propagate to browser failure state;
late readbacks from older generations are ignored before mutating counters.

Development creation optionally reserves a bounded 1,232-byte diagnostic tail
after the four planes, without moving their offsets. The first miss can retain
ray/previous-triangle data; an explicitly selected pixel/sample can record its
first eight bounce events. This debug capacity does not limit transport bounces.
Production creation disables it. Error counters remain enabled in all pipelines.
CPU comparison metadata identifies its frame and does not pretend a later CPU
snapshot is the same as the captured GPU frame.

Hybrid primary raster coverage is only a visibility candidate at subpixel edges.
Out-of-triangle analytic barycentrics request exact GPU primary refinement in
transport and motion. Without that check, an extrapolated point can enter the
same closed volume twice; stack setup now rejects repeated active IDs as well.
The original failing ray and unchanged numeric packets are retained in the M3
development evidence. Neither coordinate clamping nor counter suppression fixes
that physical boundary error.

## Transport

The volume pipeline combines opaque GGX and the validated dielectric BSDF with the
full mixture PDF. Delta events retain discrete branch probability and bypass
inapplicable emitter/environment MIS weighting. Volume IDs form an explicit stack,
initially exterior air plus the camera containment chain; transmitted events alone
push/pop it. The current limit is 64 nested volumes, with an explicit overflow
fault, not truncation. Beer absorption uses distance between physical surface
points, rather than shortened offset-ray length. Direct shadow segments also use
the absorption coefficient for their outgoing side.

Shading normals do not redefine the geometric medium boundary. A shading normal
facing away from the incident view produces a null scattering sample. A sampled
reflection/transmission must remain on its corresponding geometric side before
the medium stack is changed. This fixes observed grazing-sphere exit-order faults;
it does not claim a general shading-normal energy compensation scheme.

Physical boundaries use dominant-axis sheared triangle edge predicates. Surface
points are reconstructed from barycentrics. Ray offsets use a gamma(7) float32
interpolation error bound projected onto the geometric normal, followed by outward
rounding, instead of a fixed 0.001 world-unit displacement. These changes address
observed shared-edge misses and keep small/translated geometry testable. They are
not a proof for arbitrary degenerate, self-intersecting or unresolvable geometry.

The opaque compute pipeline selects `traceVolumeEnabled=false`; medium-stack
operations are behind that compile-time branch. This is not a hardware register
allocation/disassembly measurement.
It also disables physical surface/intersection branches and returns the existing
opaque BSDF sample's weight/PDF directly. Nonzero-transmission mixtures still use
the full combined PDF. Fixed-seed linear image parity and native A-B-B-A timing
are retained under `evidence/m3/experiments/1793832880000/`; the speedup is not a
claim that the remaining native performance target has been met.
The medium catalog is cached by physical geometry references and optical signature;
camera classification is cached separately and refreshed on camera/catalog change.
This is CPU catalog construction, not GPU volume classification or GPU BVH refit.

## Evidence And Remaining Matrix

`examples/refraction` contains public-SDK-only scenes. The development probe checks
actual linear GPU images, finite values, medium state and analytic Beer factors;
its reports must remain separate from formal M3 acceptance. Surface GPU probes also
validate the expanded ABI, physical front/back queries and empty scene buffers.

Remaining work includes full raster/path volume-thickness consistency, complex
coverage-plus-volume combinations, intersecting media/cavity semantics, complete
lighting/MIS/caustic reference cases, clipping/large-world precision combinations,
dynamic physical meshes and volume device-recovery/resource failure matrices.
The current absence of those proofs must not be hidden by a single glass image.
M3 additionally requires temporal reconstruction, the complete controlled graphics
interfaces, native-size performance improvements and independent AI acceptance.
