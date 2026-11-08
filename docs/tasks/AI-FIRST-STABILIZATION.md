# AI-first stabilization

Decision D61 restores testing for the post-1.0 optimization requested on
2026-11-08. Work stays serial on main and preserves historical evidence.

## Delivery order

- [x] Correct native lifecycle actions and add public-game regression coverage.
- [x] Isolate and correct rigid/material coupling numerical failures.
- [x] Bound replay storage without a fixed session lifetime; preserve legacy v3.
- [x] Make scene/save/UI disposal exception-safe and dependency-ordered.
- [x] Separate runtime viewport/DPR from explicit automation capture dimensions.
- [x] Expose controlled pointer input and deterministic focus release.
- [x] Return actionable structured runtime causes through the JSON CLI.
- [x] Add machine-readable capability discovery and deterministic content generation.
- [x] Improve AI project scaffolds and bounded structured state support.
- [x] Reconcile stale tests with actual contracts without discarding regressions.
- [x] Run source, installed-game, browser, GPU and distribution regressions.
- [x] Measure a controlled Three.js visual baseline and record the unmeasured AI task target.

## 1.1.0 delivery evidence

Source fingerprint: `ee7c96be6106b4874a4c5d3c1309b9e791d4128ed985d65ba7a09dd7eb1cce95`.
The [structured report](../../evidence/ai-first/1.1.0-2026-11-08/summary.json)
records 1784 main-suite passes, zero failures and five opt-in skips; all five
opt-in GPU/model-browser cases subsequently passed. The installed 1.1.0 tarball
passed 24 real workflows, all 53 source examples compiled, the 16 distribution
contracts passed, and offline package smoke/static deployment passed. New v4
checkpoints were exercised with contacts, joints, characters, terrain, a forged
collider definition, 110000 empty ticks and 2400-tick cloth/softbody continuation.

The evidence retains prior failures separately. After the runtime freeze only two CI workflows and the npm documentation
inventory changed. Distribution contracts and packaging were rerun; all 184
installed runtime/declaration files were compared with the final package.
Publication, if attempted, is recorded separately.

## Evidence and remaining objective

The same-scene emissive-only comparison demonstrates an integrated path-transport
advantage over stock Three.js raster, not an upper bound on arbitrary Three.js
extensions. A 256-sample engine image is a convergence reference, not independent
ground truth. No independent AI task-time benchmark has yet established overall
development-efficiency superiority. Keep those target claims open.

## Acceptance boundaries

The target is superior integrated rendering and AI development workflow, not a
claim that arbitrary applications written with Three.js have a finite universal
quality ceiling. A sample, compilation, or release does not establish the target.
Record exact source identities, fixtures, render dimensions and hardware. Keep
failed results and distinguish test harness repairs from product fixes.
