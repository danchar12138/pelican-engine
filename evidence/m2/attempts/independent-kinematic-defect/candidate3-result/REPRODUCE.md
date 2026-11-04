# Reproduce without Git

Use the final candidate ZIP identified in `flow.json`, with Node 24.15.0 and the existing locked Playwright browser cache. No Git or worktree is needed. Run in the extracted `candidate3/threecat` directory with PowerShell UTF-8 output enabled.

1. `powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\threecat.ps1 setup --install-browser`
2. `powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\threecat.ps1 setup --offline`
3. On a fresh extraction, `powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\threecat.ps1 create --project .\games\core-relay`; copy `report/game-source/game.ts`, `assets.ts`, `README.md` and `threecat.project.json` into that game directory. Keep the template assets and their original license metadata. `engine.path` is `../..` from the game directory.
4. `powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\threecat.ps1 check --project .\games\core-relay`
5. For the recorded intentional negative, change chime path to `assets/missing-relay-chime.wav` using `final-negative.patch`, check and confirm exit 1 / TC_ASSET_MISSING. Apply `final-fix.patch`, then check and confirm exit 0. Patch paths are relative to the retained flow root.
6. Start the dev server with `powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\threecat.ps1 dev --project .\games\core-relay --port 4319`. A background PowerShell launch must use `Start-Process -WindowStyle Hidden` and redirect output. The saved commands/logs identify the actual launch used.
7. From the flow root, run `node report/gameplay-test.cjs`. It uses only `window.__threecat.command` shared test protocol externally; it never imports engine private objects. It asserts real game behavior and closes both browser processes after cold restore.
8. Build with `powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\threecat.ps1 build --project .\games\core-relay`. Copy the resulting game dist directory to flow-root `deployment/relay`. `node report/managed-static.cjs` starts an independent static server, runs native-input production/browser cold restore, captures raw logs and PNGs, then closes its server and browsers.
9. `node report/kinematic-repro.cjs` makes two minimal game projects under candidate3 games, checks them, runs kinematic/fixed comparisons with public commands on ports 4323/4324, and closes its servers and browsers. This reproduces a known engine defect, not a gameplay test expected to fail.
10. `node report/archive-evidence.cjs` verifies exact deployed build hashes and saved/restored gameplay equality, while copying selected small source/build evidence. Use `audit.cjs before --candidate3` on a fresh extraction before any setup and `audit.cjs after --candidate3` at the end; an existing baseline intentionally cannot be overwritten.

Artifacts use report-relative paths. Complete large snapshots and original compressed traces remain local; `.gzip-data` is byte-identical gzip-compressed UTF-8 JSON for audit tooling. No browser cache, node_modules, or duplicate complete external model asset is included in report.
