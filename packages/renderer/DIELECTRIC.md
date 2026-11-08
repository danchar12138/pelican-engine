# Independent dielectric surface reference

Status: isolated CPU + binding-free WGSL reference; no main renderer, SDK, path shader,
surface, dependency, or opaque BSDF integration. Passing this module does not complete M3.

Current follow-up: the original GPU OPEN failure below is retained as historical
evidence. Retained-h sampling plus stable query reconstruction now passes the same
773 packets at the unchanged numerical limits. See the final follow-up section.

## Public contract

`DielectricVec3` is a readonly XYZ/RGB tuple. All functions are exported directly from
`src/dielectric.ts`; no barrel or SDK export is added.

```ts
evaluateDielectric(normal, view, light, material): DielectricVec3;
dielectricPdfCPU(normal, view, light, material): number;
sampleDielectric(normal, view, material, random): DielectricSample;
dielectricFresnelCPU(cosIncident, etaTOverEtaI): number;
dielectricBeerAttenuation(color, attenuationDistance, length): DielectricVec3;
```

- `normal` points from inside toward outside. `view` and `light` both point **away**
  from the interface. Nonzero finite input vectors are normalized. Same macro
  hemisphere means reflection; opposite hemispheres mean transmission. `N.V=0`
  returns a null sample / zero evaluation and PDF. No shading-normal correction is applied.
- Material: positive finite `etaOutside`, `etaInside`; `roughness` in [0,1]; optional
  `tint` in linear RGB [0,1] (default white), applied only to transmission; optional
  `transport: "radiance" | "importance"` (default radiance, PBRT convention).
  Reflectance is determined by the IORs, with no independent reflectance/mix control.
- `random=[branch,VNDF disk radius squared,azimuth]` is in [0,1)^3, independent uniform
  variates. The implementation does not own an RNG, retry null samples, or normalize
  away rejected probability. Tint does not change Fresnel selection probabilities.
- `evaluateDielectric` returns f (BRDF/BTDF in inverse steradians), without cosine or
  incident radiance. `dielectricPdfCPU` is the complete solid-angle density including
  Fresnel selection. Multiply f by `abs(N.L)` exactly once.
- `sampleDielectric` returns `direction`, RGB `weight=f*abs(N.L)/pdf`, `pdf`, `eta`,
  `event: "null" | "reflection" | "transmission"`, and `delta`. Transmission `eta` is
  IOR on the sampled-direction side divided by IOR on the view side; otherwise 1.
  Null results have zero direction, weight, and PDF, eta=1, delta=false.
- `roughness=0` is a real delta distribution. Nonzero roughness uses isotropic GGX
  `alpha=max(DIELECTRIC_MIN_ALPHA, roughness²)` with `DIELECTRIC_MIN_ALPHA=0.0025`
  (minimum effective roughness .05). Evaluate and sample use exactly that same model.
  Delta evaluation and solid-angle PDF are zero; sample PDF is the **discrete**
  Fresnel branch probability. A PDF measure must not be mixed with sr^-1 MIS.
  Equal IORs yield delta straight-through for every roughness, Fresnel=0.
- Exact unpolarized Fresnel, Snell refraction, microfacet TIR and both interface sides
  are supported. No alpha transparency, thin-sheet approximation, or arbitrary lobe mix.

WGSL `DIELECTRIC_SHADER` has no bindings/entry points/dependencies. All function names
start with `dielectric`; its `DielectricMaterial` fields are etaOutside, etaInside,
roughness, transport (`0u` radiance / `1u` importance), tint. `dielectricEvaluate`,
`dielectricPdf`, `dielectricSample` mirror CPU arguments and outputs. Sample events are
`0u` null / `1u` reflection / `2u` transmission, delta is 0u/1u. All material fields
must be supplied. WGSL callers must enforce the CPU input contract before dispatch;
shader functions do not throw or silently sanitize invalid materials.

## Formula provenance

Primary sources read for this implementation:

- Walter, Marschner, Li, Torrance (EGSR 2007), _Microfacet Models for Refraction
  through Rough Surfaces_, equations 17 and 21: generalized half vector and
  transmission Jacobian. https://www.graphics.cornell.edu/~bjw/microfacetbsdf.pdf
- Heitz (JCGT 2018), _Sampling the GGX Distribution of Visible Normals_,
  sections 3–5: stretch, visible hemisphere disk, unstretch.
  https://jcgt.org/published/0007/04/01/paper.pdf
- PBRT 4, _Dielectric BSDF_, rough reflection/transmission and specular interface
  fragments, particularly `dwm_dwi` and radiance `ft /= Sqr(etap)`.
  https://www.pbr-book.org/4ed/Reflection_Models/Dielectric_BSDF
- PBRT 4, _Roughness Using Microfacet Theory_, Trowbridge–Reitz D, Lambda,
  height-correlated Smith G and visible-normal PDF.
  https://www.pbr-book.org/4ed/Reflection_Models/Roughness_Using_Microfacet_Theory

Let n face v, nv=n.v>0, nl=n.l (signed), e=etaT/etaI, alpha as above.
For reflection h=normalize(v+l); for transmission h=normalize(v+e*l).
Face h toward n, require v.h>0 and (l.h)*nl>0.

```text
D(h) = alpha² / [pi * (sin²(thetaH) + alpha²*cos²(thetaH))²]
Lambda(w) = (sqrt(1 + alpha²*tan²(thetaW)) - 1)/2
G1(v) = 1/(1+Lambda(v))
G(v,l) = 1/(1+Lambda(v)+Lambda(l))
pm(h|v) = D(h)*G1(v)*(v.h)/nv
F = exact unpolarized dielectric Fresnel(v.h,e)
fR = F*D*G/(4*nv*nl)
pR = pm * F / (4*(v.h))
J = e²*abs(l.h)/(v.h + e*(l.h))²
fT_importance = (1-F)*D*G*(v.h)*J/(nv*abs(nl))
pT = pm * (1-F) * J
fT_radiance = fT_importance / e²
```

PBRT writes the same J as `abs(l.h)/(l.h+(v.h)/e)²`.
There is no missing e² in the Jacobian. A sampled importance throughput is G/G1(v)
for either untinted branch; radiance transmission has an additional 1/e².
Radiance throughput on exiting high IOR can exceed 1. That is radiance scaling,
not energy creation. Energy tests use importance; adjoint tests verify the e² relation
and opposite-side reciprocity. Single-scattering rough microfacets lose energy through
masking/multiple internal interactions; no compensation or forced furnace normalization.

Local Three source audit: installed `three@0.187.0` (`node_modules/three/package.json`),
`src/nodes/functions/BSDF/{BRDF_GGX,D_GGX,V_GGX_SmithCorrelated}.js`, and
`src/nodes/functions/PhysicalLightingModel.js` were read. Three uses correlated GGX
for reflection and a framebuffer transmission approximation with volume attenuation.
That framebuffer path is not a reference BTDF or this module's sampling implementation.
No Three code is imported or modified.

## Absorption and scope

`dielectricBeerAttenuation` is independent of the interface: color is the linear
transmittance at strictly positive finite attenuationDistance; finite length>=0
uses the same units. Result is color^(length/distance); zero length is exactly white,
including zero color channels. Color channels must be finite in [0,1]. WGSL helper
has the same preconditions. Interface tint and volume attenuation are separate;
callers must avoid unintentionally applying the same absorption twice.

No volume scattering, dispersion, polarization, multiple-scattering compensation,
medium stack, thickness/intersection tracking, normal mapping or integrator is provided.
Unsupported features have no switches or placeholder implementation. Input errors
throw RangeError with `DIELECTRIC_INPUT`; extra unsupported features must not be
interpreted as implemented by a future caller.

## Validation and numerical limits

The test file contains independent analytic Fresnel/Snell checks, a deterministic
projected-NDF quadrature (distinct from the VNDF implementation), Monte Carlo moments,
importance furnace/eta-adjoint tests, and an opt-in real hardware WebGPU probe.
Commands and measured results are recorded below after validation.

CPU arithmetic is f64; WGSL uses f32. Finite material IORs and their squared ratio
must be representable. Near matched but unequal IORs and directions exactly at the
critical angle are ill-conditioned in f32: do not infer bitwise CPU/GPU branch parity
at those boundaries. Exactly matched IOR is handled analytically. This reference does
not claim accuracy across the entire dynamic range of positive IEEE floating point IORs.

## Frozen signatures for integration

```wgsl
fn dielectricEvaluate(normal: vec3f, view: vec3f, light: vec3f,
                      m: DielectricMaterial) -> vec3f
fn dielectricPdf(normal: vec3f, view: vec3f, light: vec3f,
                 m: DielectricMaterial) -> f32
fn dielectricSample(normal: vec3f, view: vec3f, m: DielectricMaterial,
                    random: vec3f) -> DielectricSample
```

CPU material fields, types and tuple arguments are defined in `src/dielectric.ts`.
WGSL struct field order (for constructors, not a promised storage-buffer ABI):

```wgsl
struct DielectricMaterial {
  etaOutside: f32, etaInside: f32, roughness: f32,
  transport: u32, tint: vec3f,
}
struct DielectricSample {
  direction: vec3f, weight: vec3f, pdf: f32,
  eta: f32, event: u32, delta: u32,
}
```

A caller packing structs into buffers must obey WGSL alignment rather than tightly
packing these field lists. The probe deliberately packs input/output scalar arrays.

## Historical failed validation, 2026-11-04

**Historical checkpoint: CPU passed; hardware GPU parity was OPEN / FAILED.**
This section preserves the failure and original numerical limit; the follow-up
below records the diagnosis, intermediate failure, and successful revalidation.
This is a reviewable reference, not a claim that GPU physical transmission is ready
for mainline acceptance. No files outside the three requested paths were edited,
and no commit was created.

| Check                              | Actual result               | Coverage / limit                                                                                                                       |
| ---------------------------------- | --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Repository TypeScript              | PASS                        | `tsc --noEmit`                                                                                                                         |
| Prettier, three added files        | PASS                        | `prettier --check`                                                                                                                     |
| Default dielectric tests           | 7 PASS, 1 explicit GPU skip | CPU evidence only                                                                                                                      |
| Closed-form optics                 | PASS                        | F0=.04 for 1/1.5; both sides; independent angle/polarization oracle; critical angle +/-1e-5 radians                                    |
| Delta Snell and TIR                | PASS                        | direction norm, reciprocal eta, round trip direction/throughput, branch masses, swapped normal/media, matched IOR                      |
| Rough analytic f/PDF               | PASS                        | normal incidence reflection/transmission; independent central differential of Snell solid-angle Jacobian (2e-8 absolute)               |
| Random rough contracts             | PASS                        | 12,000 samples; f\*cos/pdf, nulls, finite values, reciprocity, eta adjoint, minimum alpha                                              |
| Independent NDF quadrature         | PASS                        | coarse 384x768 and fine 768x1536 per case; largest moment change 1.1319124613e-5, below preset 0.0012 gate                             |
| Oblique MC / importance furnace    | PASS                        | 6 view/roughness cases, 3 seeds each, 65,536 samples/seed; 1,179,648 total; four moments each; maximum standardized error 2.5799921164 |
| MC convergence                     | PASS                        | same 24 moments, early 6,144 vs final 196,608 samples/case; RMSE .003998819674 -> .000552435832                                        |
| Eta-weighted delta furnace         | PASS                        | importance sum=1; radiance eta-adjoint sum=1; normal exit radiance=2.2 is accepted, never clamped to 1                                 |
| Validation / absorption            | PASS                        | invalid vectors/material/RNG/color/distance rejected; length=0 and zero-color Beer cases                                               |
| Hardware compile/dispatch/readback | EXECUTED                    | 773 packets, combined opaque BSDF + dielectric WGSL, zero compilation diagnostics / validation errors                                  |
| Hardware numeric gate              | FAIL / OPEN                 | 90 scalar failures across 18 packets; no tolerance change                                                                              |

Independent quadrature integrates projected GGX NDF area, not visible normals. It
integrates both Snell branches with explicit facet projected-area weighting and
correlated masking. The endpoint substitution `u=1-(1-s)^2` removes the integrable
horizon singularity. Coarse/fine grid convergence is checked before MC comparisons.
Tests compare energy and weighted Lz, Lz², Lx moments. The MC acceptance is six
estimated standard errors plus twice coarse/fine grid difference plus 2e-5; that
statistical test supports convergence, not a mathematical proof of unbiasedness.
The sampling/evaluation/Jacobian derivation provides the unbiased estimator argument.

GPU hardware reported `vendor=nvidia`, `architecture=blackwell`,
`isFallbackAdapter=false`. Chromium ran **headless with ANGLE D3D11**. Vendor device
and description strings were empty; no exact GPU model is claimed. All 24,736 output
scalars were finite; all 773 event/delta flags matched CPU. Direction max absolute
error was 1.2602484956e-6. The fixed component tolerance is
`abs(error) <= 2e-5 + 5e-4*abs(reference)`, direction norm tolerance 3e-5.
Scalar peak comparisons use f64 evaluation at the GPU returned direction; direction
mapping is checked separately. Maximum `abs(error)/max(1,abs(reference))` was
0.001517218153, above the gate. Failed fields were sampled PDF (18), sampled f RGB
(18 each), and evaluated sample PDF (18). Query f/PDF, sample throughput, eta,
Beer attenuation, F0, and directions passed the existing gate for this packet set.

First failure (zero-based packet 31): `N=(0,0,1)`,
`V=(0.999549925327301,0,-0.029999999329447746)`, roughness about .001
(effective alpha=.0025), etaOutside=1.3300000429153442, etaInside=1,
importance transport, random=(.199929416179657,.738233149051666,.783607721328735).
Sample PDF GPU=13397.224609375, f64 reference=13411.246529889431, relative error
.001045534469. This is a narrow grazing reflection. Half-vector reconstruction and
normalization roundoff were suspected; at this checkpoint the precise cause and a
corrective implementation were **not resolved**. No model roughness or error threshold
was increased to pass it. The optional GPU test exited nonzero on this hardware result.

The GPU harness tries headless then headed D3D11 **only if startup/adapter detection
fails**. Headed fallback exists but was not exercised on this successful headless
adapter. Compilation/numeric failures are not retried as a different backend.
Software/fallback adapters are rejected as evidence. Bounds: browser launch 12s,
connect/navigation 5s each, adapter probe 10s, compile/dispatch/readback 25s,
close/force-kill 5s each, whole GPU test 110s. `finally` destroys buffers/device,
closes the owned browser server (force-kill fallback), and closes the HTTP server.
Timeout/fallback failure paths have not been fault-injected; ordinary cleanup ran.

Reproduce from this worktree, PowerShell (no dependency installation):

```sh
node tools/run-with-env.mjs PELICAN_DIELECTRIC_GPU=1 -- node node_modules/typescript/bin/tsc --noEmit
node tools/run-with-env.mjs PELICAN_DIELECTRIC_GPU=1 -- node node_modules/prettier/bin/prettier.cjs --check packages/renderer/src/dielectric.ts tests/dielectric.test.ts packages/renderer/DIELECTRIC.md
node tools/run-with-env.mjs PELICAN_DIELECTRIC_GPU=1 -- node node_modules/tsx/dist/cli.mjs --test tests/dielectric.test.ts
node tools/run-with-env.mjs PELICAN_DIELECTRIC_GPU=1 -- node node_modules/tsx/dist/cli.mjs --test tests/dielectric.test.ts
```

Remaining integration work belongs to the mainline: medium state, surface/material
transport representation, ray intersections and path/MIS handling for transmission.
The GPU numeric gate follow-up is recorded below. Keep the current
`unsupportedPhysicalExtension` behavior until that integration is validated. This
module does not remove that diagnostic or provide an alpha-based fallback.

## Follow-up validation, 2026-11-04

**The original GPU numeric defect is corrected for the unchanged 773-packet set.**
This is isolated module validation, not M3 acceptance or authorization to enable
physical extensions. Nothing was copied to main, connected to a renderer, or committed.
Public CPU/WGSL signatures, material fields, alpha minimum, Fresnel probabilities,
transport factors and Jacobians are unchanged.

### Diagnosis before correction

The initial diagnostic-only hardware run left the implementation and failing
assertions intact. It read the sampled VNDF h, normalized view, density computed
using that h, and the D ratio after reconstructing h from the sampled direction.
The diagnostic uses otherwise reserved output slots; no original f/PDF/direction/
throughput/eta/event/delta/absorption/F0 comparisons were removed.

| Zero-based packet | CPU sample PDF     | GPU PDF using original h | Original GPU sample/query PDF | Naive reconstructed D / original D |
| ----------------- | ------------------ | ------------------------ | ----------------------------- | ---------------------------------- |
| 31                | 13411.236286938149 | 13411.234375             | 13397.224609375               | .9989656209945679                  |
| 91                | 105874.45075360732 | 105874.4140625           | 105745.2890625                | .998780369758606                   |

For packet 31, sampled GPU h was
(0.00492121372371912, -0.0010105666005983949, -0.9999873638153076),
normalized GPU view was
(0.999549925327301, 0, -0.029999999329447746), and sampled D was
2006.3212890625. Retaining the original h recovers the density with approximately
1.4e-7 relative discrepancy, versus about .0010455 with naive reconstruction.
Packet 91 independently exhibits the same error pattern.

The old sampling path discarded h, normalized the sampled direction, and then called
the query evaluator to invert that rounded direction. Moreover, query normalization
can return slightly unequal f32 vector lengths. Their residual component along v-l
is magnified in v+l at grazing incidence. These are numerical changes in the
reconstructed microfacet distribution, not missing Fresnel or Jacobian factors.

### Corrections

1. Private CPU/WGSL `dielectricTermsWithHalfVector` takes an already oriented normal,
   view, light, original h, etaT/etaI and material. Sampling now uses its original
   VNDF h for both f and PDF. Query evaluation still derives h solely from supplied
   directions, then uses the same core formula. This follows PBRT's direct use of
   the sampled microfacet normal in rough dielectric `Sample_f`; no theoretical density
   or probability measure changed.
2. For reflection queries with v.l<0, reconstruct the bisector with the unit-vector
   identity below instead of adding nearly opposite vectors. CPU and WGSL use the
   same identity. Reflection with v.l>=0 still uses v+l, and transmission still uses
   v+eta\*l. The condition selects a numerically conditioned expression of the same
   model, not a roughness clamp, angular rejection, or lobe change.

```text
(v cross l) cross (v-l) = (1-v.l)*(v+l), for unit v and l.
```

Query f/PDF are checked against a separate f64 direct-sum oracle using angular GGX
D/Lambda, independent angle/polarization Fresnel, and PBRT's algebraically different
transmission denominator. This oracle does not call production helpers or use the
stable bisector. A 2,400-case CPU regression spans minimum roughness, cosine .0003
through normal incidence, both media, reflection/transmission queries, and rotated
normals, at 2e-8\*max(1,abs(reference)) absolute limits. Exact input/RNG/sample-PDF
regressions for original packets 31 and 91 are also retained.

The GPU checks sample PDF/weight against the CPU original random-to-direction sample,
and checks query f/PDF at the GPU returned direction against the independent oracle.
This separation is necessary: the stored f32 direction is a rounded representation
of the sampled continuous direction, not the exact inverse of its original h.
Direction mapping has its own original tolerance. GPU sample throughput is also
checked against GPU query f\*abs(N.L)/queryPdf at the unchanged component tolerance.
Finite-precision sample and query PDFs need not be bit-identical.

### Actual results after correction

All three stages used the same 773 input packets, NVIDIA Blackwell hardware,
headless Chromium, ANGLE D3D11, alpha minimum .0025 and scalar error bound
abs(error)<=2e-5+5e-4\*abs(reference). No failed packet was removed or GPU test skipped.

| Stage                               | Sample PDF scalar failures | Sample-direction query f/PDF scalar failures | Total   |
| ----------------------------------- | -------------------------- | -------------------------------------------- | ------- |
| Original implementation             | 18                         | 72                                           | 90 FAIL |
| Retain original h in sampling only  | 0                          | 72                                           | 72 FAIL |
| Retain h plus stable query bisector | 0                          | 0                                            | 0 PASS  |

Final full run: **10/10 tests passed, zero skipped**, including 9 CPU tests and
the 773-packet hardware test. All 24,736 output scalars (including diagnostic slots)
were finite; every event/delta flag matched. Combined opaque BSDF + dielectric WGSL
compiled with zero diagnostics; validation error scope was empty.

- Maximum abs(error)/max(1,abs(reference)): **.0001685442584899761** (~.0168544%).
- Worst field: packet 685, query sample PDF; GPU=79587.046875,
  independent f64 reference=79600.46307602461.
- Maximum direction absolute error: **1.260248495615901e-6**, unchanged.
- Maximum GPU sample/query PDF discrepancy divided by max(1,queryPdf):
  **.0002069922625045151** (~.0206992%). This is recorded, not clamped away.
- Packet 31 corrected sample PDF=13411.234375; query PDF=13411.265625.
- Packet 91 corrected sample PDF=105874.4140625; query PDF=105874.6171875.
- Independent importance/energy/direction-moment MC rerun: **1,179,648 samples**,
  maximum standardized error **2.5799921163600974**; quadrature grid change
  **1.1319124613246023e-5**. Moment RMSE .003998819673652323 -> .0005524358322922929.
- Fresnel, Snell, TIR, reciprocal eta, orientation, delta measure, Beer attenuation,
  importance furnace, radiance eta-adjoint, 12,000 random contracts, and both new
  independent regressions all passed.
- Repository `tsc --noEmit` and Prettier check of all three files passed.

Input fingerprint (the test asserts this SHA-256 of the 773 packed Float32 queries):

```text
488c27aebccc09d1fad36dede16f4db4836a4d1eac3f6ea9bacbd79e0741fef6
```

Set `PELICAN_DIELECTRIC_GPU=1` to reproduce the complete hardware run using the
commands above. If explicitly requested hardware cannot be obtained after both
headless/headed attempts, the test now fails rather than skipping. Only the default
not-requested invocation skips hardware. Cleanup/deadline behavior is unchanged;
normal cleanup ran on each successful and failing numeric run. Headed fallback and
timeout fault injection remain untested, as in the historical checkpoint.

Residual scope: these results validate this packet set and CPU references on this
adapter, not every f32 IOR/grazing/critical configuration or another GPU backend.
Near unequal-but-matched IORs and exactly critical boundaries remain conditioning
limits noted above. Medium-stack/surface/material/path/MIS integration is still
absent. Mainline physical extensions remain unsupported; no alpha substitute exists.
