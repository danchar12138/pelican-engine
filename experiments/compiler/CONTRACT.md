# Internal compiler compatibility paths

The implementation is [packages/compiler/src](../../packages/compiler/src/index.ts). Files here are internal compatibility reexports for contributor regression inputs. They are not another game SDK or an npm authoring entry.

Current design is described in [architecture](../../docs/ARCHITECTURE.md); project configuration and compiler types are defined by implementation source. Games use the installed `pelican-engine` package and `pelican` CLI.
