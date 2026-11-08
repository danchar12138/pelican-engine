# Opaque BSDF Module

This is an isolated renderer building block, not an M3, path-tracer, hybrid-renderer,
or physical-material-extension completion claim. It adds no bindings, lights,
integrator, SDK exports, dependencies, or changes to the surface shader.

## Integration Contract

`src/bsdf.ts` exports `BSDF_SHADER: string`, `BSDF_MIN_ROUGHNESS = 0.045`,
`BsdfVec3 = readonly [number, number, number]`, and:

```ts
interface BsdfSample {
  direction: BsdfVec3;
  weight: BsdfVec3;
  pdf: number;
}
evaluateBsdf(normal, view, light, base, roughness, metalness): BsdfVec3;
bsdfPdf(normal, view, light, base, roughness, metalness): number;
sampleBsdf(normal, view, base, roughness, metalness, random): BsdfSample;
```

All vector arguments above are `BsdfVec3`; roughness and metalness are numbers.
The first function's CPU name differs intentionally from WGSL's `bsdfEvaluate`.
The binding-free string defines these exact entry points:

```wgsl
struct BsdfSample { direction: vec3f, weight: vec3f, pdf: f32, }
fn bsdfEvaluate(normal:vec3f, view:vec3f, light:vec3f, base:vec3f,
                roughness:f32, metalness:f32) -> vec3f
fn bsdfPdf(normal:vec3f, view:vec3f, light:vec3f, base:vec3f,
           roughness:f32, metalness:f32) -> f32
fn bsdfSample(normal:vec3f, view:vec3f, base:vec3f, roughness:f32,
              metalness:f32, random:vec3f) -> BsdfSample
```

Concatenate `BSDF_SHADER` once with the calling shader. All helper functions start
with `bsdf`; there are no globals, textures, resource layouts or shader entry points.
`BsdfSample` describes a function result, **not a storage-buffer ABI**; callers must
define their own packed readback/transport layout.

`normal`, `view`, `light`, and returned directions are world-space; view/light point
**away from the surface**. Nonzero directions are normalized internally using a
scaled norm (also avoiding overflow for large finite inputs). This is a one-sided
opaque BRDF: `NoV <= 0` or `NoL <= 0` returns zero; zero normal/view/light also gives
zero rather than `normalize(0)`/NaN. Do not use absolute cosine to make the back side
reflect; the caller must orient shading normals for double-sided surfaces and
handle geometric-normal consistency/shading-normal correction in its integrator.

`base` is **linear reflectance/albedo in [0,1]**, not sRGB and not HDR radiance.
HDR incident/emitted/environment radiance belongs outside this module. CPU APIs
throw `RangeError` with `TC_BSDF_INPUT` for nonfinite inputs, f32 overflow/underflow
to zero, wrong vector length, out-of-range albedo or invalid random inputs. Finite
roughness is clamped to `[0.045,1]`, finite metalness to `[0,1]`; neither silently
repairs NaN/Infinity. GPU callers must validate finite inputs/albedo before upload;
WGSL has no exception path and assumes this precondition. GPU random inputs must
remain in `[0,1)` **after f32 conversion** (a CPU double just below 1 can round to 1).
Use three independent uniform variates: x selects the lobe, yz sample its direction.

`evaluateBsdf` / `bsdfEvaluate` return the BRDF **f**, inverse steradians, without
incident radiance, a cosine, or an additional integrator-side division by pi.
Diffuse's `1/pi` is already inside f. `bsdfPdf` is the **full-mixture** density with
respect to solid angle, not a half-vector density or the chosen-lobe-only PDF.
For a successful sample:

```text
weight = f(normal, view, direction) * abs(dot(unit(normal), direction)) / pdf
```

Only positive-hemisphere samples survive, so `abs(NoL) = NoL` here. The weight is
not premultiplied by incident radiance. For NEE/MIS use the full mixture `bsdfPdf`;
integrate lights separately. Sampling PDFs need not be reciprocal even though f is.

## Model And Sources

Primary local reference is the installed, lock-pinned **Three.js 0.187.0** source:

- `node_modules/three/src/nodes/functions/BSDF/BRDF_GGX.js`: alpha is roughness
  squared, nonzero roughness floor 0.045, `F * V * D` composition.
- `.../D_GGX.js`: GGX/Trowbridge-Reitz normal distribution.
- `.../V_GGX_SmithCorrelated.js`: height-correlated Smith visibility.
- `.../F_Schlick.js`: Schlick model; Three uses an optimized exponential fit, while
  this module deliberately uses the original fifth-power form (also identified in
  that file). Therefore this is not a bit-identical port of Three's full material.
- `node_modules/three/src/renderers/shaders/ShaderChunk/lights_physical_pars_fragment.glsl.js`:
  corroborating scalar GGX/Smith formulas and separately handled physical layers.

The sampling primary reference is Jonathan Dupuy and Anis Benyoub, _Sampling
Visible GGX Normals with Spherical Caps_, HPG / Computer Graphics Forum 42(8), 2023,
section 3, `https://arxiv.org/abs/2306.05044` (author paper).
Its stretch/spherical-cap/half-vector/unstretch algorithm samples the same exact
GGX visible-normal distribution as Eric Heitz, _Sampling the GGX Distribution of
Visible Normals_, JCGT 7(4), 2018,
`https://jcgt.org/published/0007/04/01/paper.pdf`. Spherical-cap sampling avoids
Heitz's auxiliary view-aligned tangent-basis degeneracy at V=N; rounding of an
arbitrarily small tangent component cannot flip its basis and same-random CPU/GPU
directions. No secondary implementation is a source of truth.

Let N,V,L be normalized, H=unit(V+L), a=clamp(roughness,0.045,1)^2,
m=clamp(metalness,0,1), `F0 = 0.04*(1-m) + base*m`, `NoX=clamp(dot(N,X),0,1)`.
For valid positive hemispheres:

```text
F(c) = F0 + (1-F0)*(1-clamp(c,0,1))^5
R(c) = sqrt(a^2 + (1-a^2)*c^2)
D(H) = a^2 / (pi * (1 + (a^2-1)*NoH^2)^2)
Vcorr = 0.5 / (NoL*R(NoV) + NoV*R(NoL))
fSpec = F(dot(V,H)) * D(H) * Vcorr
fDiffuse = base*(1-m)*(1-F(NoV))*(1-F(NoL))/pi
f = fSpec + fDiffuse
```

The diffuse term is deliberately conservative and symmetric: both interface
directions attenuate diffuse, preserving Helmholtz reciprocity and reducing
double-counted reflection energy at grazing. It is an explicit model choice, not
Three's complete diffuse/DFG/multiscattering material or an exact layered dielectric
solution. The single-scattering rough metal intentionally loses energy to unresolved
microfacet multiple scattering; we do not claim perfect energy preservation.
White-furnace tests check no energy creation for the covered materials/views.

For floating-point stability, D evaluates its equivalent denominator as
`dot(cross(N,H),cross(N,H)) + a^2*NoH^2`, avoiding subtraction cancellation at the
sharp peak. The Smith denominator is bounded below by `1e-30` only to avoid
extreme grazing overflow (not Three's more visible EPSILON cutoff). Exact tangent
directions give zero; near-tangent positive directions remain finite. There is no
delta lobe: even input roughness 0 uses a finite-width 0.045 floor. These conventions
match between CPU and WGSL; CPU uses JS doubles, GPU f32, not bitwise parity.
Subnormal f32 values may be flushed by hardware; do not rely on subnormal angles.
For near-opposite unit directions (`dot(V,L)<-0.5`), H is constructed symmetrically
as `unit(cross(cross(V,L),V-L))`, algebraically `unit((1-dot(V,L))*(V+L))`.
This avoids severe half-vector cancellation when f32 normalization cannot retain
`1-NoV^2` at extreme grazing. A zero cross product falls back to `unit(V+L)`.

## Sampling And PDF

With `S=mean(F(NoV))`, `B=(1-m)*mean(base)`:

```text
pSpec = 1                         if B == 0
pSpec = clamp(S/(S+B),.05,.95)    otherwise
G1(V) = 2*NoV/(NoV + R(NoV))
pH(H|V) = D(H)*G1(V)*abs(dot(V,H))/NoV
pSpecDirection(L|V) = pH/(4*abs(dot(V,H)))
                    = D(H)/(2*(NoV + R(NoV)))
pDiffuse(L) = NoL/pi
p(L) = pSpec*pSpecDirection(L) + (1-pSpec)*pDiffuse(L)
```

This scalar probability is a proposal heuristic only; f and the full-mixture PDF
determine the actual weight. No nonzero lobe is dropped, even at grazing or for
partially metallic materials. Pure metals and black dielectrics use specular-only
sampling because their diffuse term is zero. Black metal can still reflect through
Schlick grazing Fresnel.

The VNDF branch samples visible normals relative to V, not the raw GGX NDF. It
greatly reduces invalid reflections for sharp/grazing configurations, but cannot
eliminate them: for a=1 and V=N, half the reflected directions are below N.
Such events return `{direction:[0,0,0],weight:[0,0,0],pdf:0}`. **Never resample or
renormalize them away**: the upper-hemisphere PDF is a sub-probability distribution
whose missing mass belongs to the null event. The integrator must terminate that
sample's continuation with zero contribution. This event does not invalidate a
separately computed direct-light estimate. A direction proposal is sampled, not a
linear blend of specular and diffuse vectors, and the weight always includes both
lobes regardless of the selected branch.

In local coordinates the exact spherical-cap mapping is:

```text
Vh = unit(a*Vlocal.x, a*Vlocal.y, NoV)
phi = 2*pi*random.z
z = 1-random.y*(1+Vh.z)
C = (sqrt(max(0,1-z*z))*cos(phi), sqrt(max(0,1-z*z))*sin(phi), z)
Nh = C+Vh
Hlocal = unit(a*Nh.x, a*Nh.y, max(0,Nh.z))
L = reflect(-V, Hworld)
```

## Verification

Default, CPU only (does not require a browser or adapter):

```sh
node --import tsx --test tests/bsdf.test.ts
node node_modules/typescript/bin/tsc --noEmit
node node_modules/prettier/bin/prettier.cjs --check packages/renderer/src/bsdf.ts tests/bsdf.test.ts packages/renderer/BSDF.md
```

The suite covers independent scalar/closed-form references, reciprocity, hemisphere
and rotation conventions, malformed/nonfinite inputs, clamping, zero/opposite/tiny
grazing vectors, black albedo, both lobe branches' full-mixture weight, numerical hemisphere PDF
and BRDF quadrature, angular moments, nonconstant incident radiance, null mass, and
Monte Carlo white furnaces for two albedos, metalness 0/0.5/1, five roughnesses,
four view angles and three deterministic independent seeds. Statistical tests
include all null events in their denominator. Energy checks use measured standard
error (not per-sample weight<=1, which is not required for a mixture). For the unit
conductor at roughness 1, normal view, the independent exact reference is
`integral(f*NoL)=1-ln(2)` and hemisphere PDF mass is `1/2`.

Optional **actual hardware WebGPU** compilation and numeric readback:

```sh
node tools/run-with-env.mjs PELICAN_BSDF_GPU=1 -- node --import tsx --test tests/bsdf.test.ts
```

The test starts an independent in-memory HTTP server on a random loopback port,
launches the full bundled Playwright Chromium in headless mode (not the separate
headless-shell binary), requests a nonfallback adapter, rejects known
software/WARP adapters or an unverified fallback flag, and uses storage-buffer
packets plus GPU map/readback. It compiles the actual exported WGSL and compares f,
queried PDF, sampled direction/weight/PDF and reevaluation at sampled directions
against CPU references using the exact uploaded f32 packet inputs. It also checks
sampled directions independently; the sampled scalar PDF/f/weight CPU reference
uses the actual readback direction, avoiding an ill-conditioned comparison of two
slightly different near-opposite grazing directions at the sharpest lobe. It checks
the GPU's own full-mixture weight identity and emits adapter/compilation/error
diagnostics. No file server, evidence files or external running app are required.
Browser absence, no WebGPU, no verified hardware or device-creation failure explicitly **skip** the probe;
shader compilation, validation, or numerical mismatches **fail** it. CPU success
and a skipped GPU test are not evidence of GPU correctness. No software fallback
is accepted as a hardware result. Readback tolerances account for f32 behavior
near narrow grazing lobes; these are numeric correctness checks, not performance
or image-quality acceptance. Per-component tolerance is `2e-5 + 5e-4*abs(reference)`;
GPU weight-identity and unit-direction checks use separate tighter bounds.

Validation recorded in this worktree on 2026-11-04:

- CPU suite: 10 passed, one optional GPU test explicitly skipped when disabled.
- Hardware run with `PELICAN_BSDF_GPU=1`: all 11 passed, none skipped; 773 packets
  sampled with three seeds, NVIDIA / Blackwell, `isFallbackAdapter=false`, no WGSL
  compilation messages. Maximum `abs(error)/max(1,abs(reference))` was
  `0.00011915306282135415`.
- TypeScript project check and Prettier check on the three allowed files passed.
- The standard white-furnace sweep contains 360 seeded cases / 1,080,000 samples.
  A further independent 2,400,000-sample white-albedo sweep (40,000 per case)
  found no statistically significant energy excess; its largest mean was
  `0.9999749997471444` with standard error `0.000024999687464407194`.

These are reproducible module tests and one recorded hardware execution, not an
all-adapter guarantee or a renderer performance/visual acceptance.

## Not Implemented

Clearcoat, transmission/refraction, IOR customization, exact conductor complex IOR,
volume transport/absorption, thin-film iridescence, sheen, anisotropy, rough diffuse,
microfacet multiple-scattering compensation, alpha coverage, normal-map filtering,
geometric/shading-normal correction, light sampling/MIS policy, path integration,
denoising and renderer wiring are outside this module. Transmission must eventually
be a real BSDF/transport integration, not opacity/diffuse mixing. This opaque
submodule alone does not establish full MeshPhysicalMaterial equivalence or M3
completion.
