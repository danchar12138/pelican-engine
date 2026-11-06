# Navigation grid example

A small game using the public `pelican-engine` SDK. A courier follows a path
through a 7-by-3 orthogonal grid. The route and movement progress are stored
in a component so the game can describe its state in a runtime snapshot.

- **B** toggles the center obstacle.
- **U** blocks the center column.
- **R** clears the column.
- **C** requests a path with a deliberately small search budget.

The obstacle changes use `ctx.navigation.setBlockedBatch`. All entries are
checked before the grid is changed; when the same cell appears more than once,
the last update wins. Entity transforms and path replanning are separate from
the grid-only batch. The example is not continuous-world navigation or a full
NPC steering system.

From a source checkout, the development entry is:

```sh
npm run dev -- --project examples/navigation-grid
```

The batch API and updated example are newly integrated and have not been
runtime or browser validated under the current project policy. Earlier reports
only apply to the older source recorded in those reports.
