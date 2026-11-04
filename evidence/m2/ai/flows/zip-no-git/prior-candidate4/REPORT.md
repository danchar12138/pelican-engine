# Candidate4 ZIP / no-Git acceptance

Definitive structured result: `flow.json` (`status: passed`). Final archive SHA256 is `0cd57233f868aecc620fff4afadc37067991e99814c3383da17df1ecfd41c4f8`; final source identity is `310d38ff51f423ec4d567191b118f47b83d8d3bd586852e8984169f2bd5f3c58`; engine version remains `0.2.0-m2.0`.

Candidate4 was extracted into a new isolated directory. The existing game was copied into `candidate4/threecat/games/core-relay` with `engine.path: ../..`. `candidate3-to-candidate4-comparison.json` proves 191 engine files differ only at `.github/workflows/ci.yml`, whose exact addition is `npx --no-install playwright install chromium`; runtime, SDK, tools, dependencies and game files are unchanged. Candidate3’s complete report is preserved at `candidate3-result/flow.json`.

Candidate4 actually reused the locked dependency and local Playwright cache. Setup, offline setup, game check, the intentional missing-audio check (exit 1), repaired check, complete gameplay/cold restore, build, static production cold restore, cleanup and final engine hash comparison all ran on candidate4. The intentional failure is represented as `expectedFailure: true`; earlier accidental failures remain in `raw-command-log/` and are not reclassified.

The game is a new repair/reboot loop, not a renamed template: three timed core repairs grant speed and spawn three dynamic rigid-body capacitor rewards; a separate timed south-console reboot is required; a central fixed obstacle changes routing; the physical exit gate rises only after reboot. Real Fox GLB Run/Survey skeletal animation, character jump/collision and physics storage are evidenced by state JSON, snapshots retained locally, PNGs and `running-animation.json`.

Development gameplay on candidate4 proves blocked early exit, central collision, jump, partial repair, runtime prefab reward fall, speed reward, three cores, partial reboot, gate y=4.5, exit and `escaped:true`. A saved one-core/partial-state checkpoint was loaded after closing and relaunching the browser process; exact gameplay entity records match.

The built `dist` was copied to `flow-zip/deployment4/relay` and served independently at `/relay/`. Production has no `window.__threecat` or development control endpoint. Native keyboard repair and UI save were followed by full browser-process cold restore; the `threecat.save` record in `runtime.world.entities` restored the score and retained save hash. All 43 build/deployment file hashes match.

The candidate engine defect is disclosed, not hidden: a minimal player/floor/kinematic-gate project reproduces sticking at z≈6.4901 after contact, with reverse movement unchanged; the fixed-gate comparison moves away. The final game uses a fixed solid collider moved through the documented transform API, leaving collision and gate motion real and leaving engine source untouched. See `kinematic-repro-result.json` and the repro scripts/logs.

All own servers/browsers are closed; `cleanup-verification.json` is the evidence. No Git metadata, commit, engine source, SDK, dependency or tool modification was made. Limitations are listed in `flow.json`, including bounded physics-history snapshots and the fact that rendering evidence claims hardware WebGPU raster, not hardware ray tracing.
