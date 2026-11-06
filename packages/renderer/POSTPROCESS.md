# Controlled HDR Postprocess Composer

`src/postprocess.ts` is renderer-private. It consumes compiled `PostProcessIR`,
the runtime's `PostProcessOwnerView`, and engine-owned asset textures. Neither
Three nodes/textures nor native GPU targets belong in the game SDK or snapshots.

## Main Integration

- Initialize the Three renderer before constructing a composer. Pass physical
  output width/height and the compiled ordered pass definitions. The renderer's
  public `samples` determines capture scene MSAA; `currentSamples` can be zero
  for the final tone/color-conversion stage and must not be used for this. Construct at
  the original scene render boundary, before binding a temporary render target.
- Keep the existing direct renderer/tracer path when there is no enabled effect
  graph. Do not construct/present this composer as an implicit no-effect path.
- Raster: `captureRaster(scene, camera)`, then `present(owner, time, settings)`.
  Capture the world scene only; keep DOM/overlay UI outside it and present UI last.
- Path/hybrid: obtain `traceTargets()` and have the tracer write raw linear color,
  world shading normal, and radial world distance to the three resolved textures.
  Present with this composer only after the tracer submission. Do not run its old
  display pass, apply exposure earlier, or copy/read back these attachments.
- Snapshot restore is communicated by owner history revisions. Also call
  `resetHistory(reason)` for mode/content lifecycle transitions that can happen
  while main is bypassing presentation. Present detects mode changes itself, but
  cannot observe transitions that occur entirely while bypassed.
- Dispose/recreate on resize, renderer/backend/device replacement, or changed
  compiled definitions/assets. Raw targets must not outlive the composer. A
  detected device replacement fails explicitly, rather than reusing old targets.
  Recreate or explicitly reset when returning from an all-disabled direct path.

## Targets And Sampling

The source is a full-resolution `HalfFloatType`/RGBA/linear-sRGB target, with
attachments named `output`, `normal`, and `linearDepth`. Color has no exposure, tone
mapping, or output color conversion. Normal RGB is the material's actual shading
normal transformed to world space (`normalWorld`, including material normal
graphs/maps). Depth R is camera-to-fragment world distance, positive on hits.
Normal/depth clear to RGBA zero using locked Three r187 MRT per-output clears;
the generated `Background.mesh`/`Background.material` also writes zero guides.
The output clear follows Three's scene background, not the zero guide policy.

The private MRT entry, attachment name, and `inspect().sourceAttachments` use
`linearDepth`: locked Three r187's `NodeMaterial.setupDepth` treats an MRT entry
named `depth` as a hardware fragment-depth override. Radial world distance must
not replace hardware depth or near/far occlusion breaks. The public graph channel
`scene.depth` and native `TracePresentationTargets.depth` property are unchanged;
both still route to the third attachment, with the same world-distance semantics.

This is not a multilayer G-buffer. Opaque/alpha-tested surfaces are the primary
coverage contract. Transparent surfaces use Three's MRT ordering/blending; the
guides do not describe all contributing layers or promise cross-backend pixel
identity for transparency. Custom fragment outputs that bypass Three's MRT
material path are not a supported world-surface capture contract.

Every declared pass owns two full-size rgba16float, single-sample targets. Graphs
may sample `scene.color`, `scene.normal`, `scene.depth`, earlier current-frame pass
IDs, and any declared previous-frame pass ID. Frame/history samples and graph
asset sampling use explicit base LOD. No effect downscale or format fallback is
performed. UV, screenSize, texelSize, time, parameters, and asset textures are
supported; material/compute-only inputs are refused.

History starts as an engine-owned zero half-float texture. Disabled passes alias
the previous active upstream current-frame output and retain their own history.
Re-enabling resets all histories defensively; owner revisions can independently
invalidate a pass. Only after every pass, final presentation, and renderer state
restoration succeed are enabled read/write sides swapped. Failed draws can dirty
the write sides, never the committed history. This synchronous API treats a draw
returning without exception as submission success; device-loss recovery belongs
to main, not a fabricated GPU-completion/readback barrier.

Texture nodes are cached and non-mergeable, preserving independent bindings even
when several channels initially use the same zero texture. Parameters/time and
texture values update in place; materials are not rebuilt per parameter change.

## Presentation And Ownership

Raster beauty uses the incoming renderer tone mapper and settings exposure.
Path/hybrid beauty matches `TRACE_PRESENT_SHADER`'s simple ACES rational fit on
nonnegative HDR times settings exposure, not Three's matrix-based ACES. Debug
views apply exposure and nonnegative clamping but skip the fit/tone mapper.
`renderOutput` performs the final working-to-output color conversion once;
automatic renderer transforms remain disabled for the final quad. Its graph only
changes when output mode/tone mapper/color space changes.

Target/MRT, clear color/alpha/depth/stencil, viewport (including depth range),
scissor, auto-clear flags, exposure/tone mapper/output space, and XR enable state
are restored on both success and synchronous failure. QuadMesh's temporary vertex
node is restored after failed draws. Disposal releases only owned targets,
materials, and the zero texture, never asset textures or Three's shared quad
geometry. `inspect()` returns plain counters/channel names, not GPU/Three objects.

WebGPU validates three attachment slots, 24 color bytes/sample, texture dimensions,
and supported MSAA counts. WebGL2 requires `EXT_color_buffer_float`, three draw
buffers/attachments, full-size texture/renderbuffer limits, and the exact RGBA16F
MSAA count. Unsupported cases fail `TC_POSTPROCESS_CAPABILITY`; no WebGL tracer,
precision, size, or MSAA substitution is made. Native target access is deliberately
isolated here: `renderer.initRenderTarget()` followed by private
`renderer.backend.get(texture).texture`, pinned to the locked Three version.

## Verification Scope

`node --import tsx --test tests/postprocess-renderer.test.ts` runs CPU fixtures
with real Three targets/materials/nodes and a fake renderer protocol. It checks
resource/state/lifecycle behavior, channel routing, history commits, failure
retries, capability refusal, parameter reuse, and output-node selection. It also
asserts the MRT has `linearDepth`, does not have reserved `depth`, and clears the
distance guide to RGBA zero. It does not establish GPU shader compilation,
rendered pixel identity, backend parity,
performance, or complete M3 acceptance. The small exclusive real-GPU integration
probe belongs to main after the cooperating renderer/tracer changes are combined:

`node --import tsx tools/postprocess-occlusion-probe.ts --prepare --output .pelican/postprocess-occlusion`
compiles a small generated public-API game without launching a browser or GPU.
Once exclusive GPU access is granted, run the same command with `--exclusive-gpu`
instead of `--prepare`, or call `runPostprocessOcclusionProbe(output)` from an
exclusive main integration. The bounded probe runs WebGPU then one WebGL2 case
serially: a near green opaque emissive box is submitted before a far red box;
identity postprocessing must preserve the green center and match effects-disabled
raster pixels. A second graph visualizes public `scene.depth` and corroborates
the near surface's 3.5-unit distance rather than the far surface's 4.5 units.
Screenshots and a JSON report are written under the requested output directory.
