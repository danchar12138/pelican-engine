# Navigation grid game

This small game imports only `pelican-engine`. The cyan courier follows a
shortest path on a 7-by-3 orthogonal grid to the gold destination. It moves
1/12 of a cell per fixed tick; its component stores the route, completed-cell
cursor and within-edge progress so a snapshot resumes the same movement.
The red blocks correspond to navigation obstacles. Replanning while between
cells returns the courier to its last completed cell before finding a route.

* **B** toggles the center obstacle and replans.
* **U** blocks all three cells in the center column and replans; when the
  courier is to the left, this makes the destination unreachable.
* **R** clears the wall and replans.
* **C** runs an independent search with a deliberately tiny budget and catches
  the capacity error without replacing the active route.

The game refuses to place a block on the current cell. Unreachable and budget
errors are recorded in `NavigationState.error`, rather than crashing the game.
This example demonstrates finite four-neighbor grid navigation, not continuous
navigation or full M5 acceptance.

From the source worktree, without a GPU:

```powershell
node --import tsx examples/navigation-grid/cpu-test.ts
```

When a GPU is available and exclusively reserved, the browser probe runs the
compiled game, requires a non-fallback WebGPU adapter, records state and raw
errors, checks every tick of a rerouted path, screenshots the visible courier,
tests errors and snapshot restoration, and checks browser teardown:

```powershell
node --import tsx tools/navigation-game-probe.ts --exclusive-gpu --output .pelican/navigation-game-source
```

For an independently installed npm project, copy the exact `game.ts` and
`pelican.project.json` to that project root and install a `pelican-engine`
package built from a revision that includes the M5 navigation API. Run the
same probe from the source worktree with `--installed-root <project-directory>`
and a different `--output`. It verifies hashes of the copied game and manifest,
starts the installed package's own CLI, and records package, SDK and lockfile
identity. A previously published package without the navigation API is not
equivalent to a package built from this source. The probe's Playwright/Vite and
other development dependencies still come from the source worktree.

The JSON report and PNGs are written under the specified output directory.
CPU test success is not GPU/browser evidence; failures and cleanup errors are
recorded in the report when the probe can create the output directory.
