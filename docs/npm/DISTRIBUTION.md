# Pelican Engine npm development distribution

The installed package is `pelican-engine`. Its root export is the same compiled
public SDK used by repository games, not a wrapper or a separate SDK. The package
also provides the `pelican` executable. This is an M3 development distribution,
not accepted M3 hardware evidence or a complete engine release.

## Windows project workflow

Use Node 24 and npm in an empty project directory. The explicit prefix keeps npm
in this directory even when a parent directory is also an npm project:

```powershell
npm --prefix . i -D pelican-engine
npx pelican dev
```

The first installed `dev` creates the minimal `game.ts`, `pelican.project.json`
version lock, and game-author `AGENTS.md` when the directory contains only npm
installation metadata. An existing game or manifest is used as supplied; other
project files or author instructions prevent automatic scaffolding. Files are
never overwritten. Stop dev with Ctrl+C, then use the same local CLI:

```powershell
npx --no-install pelican api
npx --no-install pelican setup --install-browser
npx --no-install pelican check
npx --no-install pelican dev --port 4173
npx --no-install pelican capture --port 4174 --output capture.png
npx --no-install pelican build
```

For an exact-version install use `npm --prefix . i -D --save-exact pelican-engine@0.3.1`,
or substitute the local `pelican-engine-0.3.1.tgz` tarball before registry
publication. `pelican create --template minimal` remains available explicitly.

Without `--prefix .`, npm may select an ancestor `package.json` or `node_modules`
as the install root and modify that parent. The shorter `npm i -D pelican-engine`
works when npm selects the intended directory; verify `npm prefix` before using
it. The smoke harness uses an explicit prefix and does not require `npm init`.

`create --template minimal` uses the same primitive starter in npm and repository
workflows. npm defaults to `minimal` and reports the selected template; repository
default `m2` is preserved with its historical sample assets. Samples are not engine
capabilities. Identical authored game/asset inputs use the same API/compiler/runtime
in either channel. npm does not bundle the `m2` sample or any sample/game assets.

`create` writes `game.ts`, `AGENTS.md` and an exact `pelican.project.json` lock in the current
directory. Existing project files are never overwritten. Author TypeScript with
named imports from `pelican-engine` and project-local imports only. The compiler
reports `TC_PUBLIC_API` for renderer, Three.js, TSL, physics, Node and internal
package imports, including type-only and unused imports. Package subpaths are not
public exports. Project lock mismatches report `TC_ENGINE_VERSION_MISMATCH`;
mixed package/API versions report `TC_ENGINE_SDK_VERSION`. Reinstall a matching
exact version, or migrate through the public API before explicitly changing a lock.

After npm dependencies and Playwright Chromium have been installed, authoring,
API inspection, checks, builds, dev/control commands and capture need no network
service. `setup --offline` never installs dependencies or downloads a browser in
an installed package. Keep the game package-lock for repeatable future installs;
an offline _reinstall_ additionally requires the npm cache or a dependency mirror.
`TC_DISTRIBUTION_DEPENDENCY_MISSING` and
`TC_DISTRIBUTION_DEPENDENCY_VERSION` identify broken tool dependencies.

Serve the generated `dist/` directory over HTTP(S), including its `generated/`
files, license files, notices and compression manifests. No Node process, engine
repository, SDK installation, external AI service or development control server
is needed by players. Use `build --base /game/` for a nested deployment URL.
Capture requires installed Chromium and actual supported graphics capability.
No software renderer result establishes hardware acceptance.

## AI entry points

Read the game-author `AGENTS.md`, `docs/npm/GAME-AUTHOR.md`, `docs/CAPABILITIES.md` and
`docs/api/REFERENCE.md` inside `node_modules/pelican-engine`. The machine-readable
API is `docs/api/index.json`, also discoverable through `pelican api`.
`lib/sdk/index.d.ts` is the authoritative installed declaration surface.
`docs/PELICAN-MIGRATION.md` explains current names and historical provenance.
Repository paths and release instructions in copied documents are historical
context; the installed workflow above replaces source-checkout commands.
The JSON CLI protocol and dev control operations are shared with the repository.

## Maintainer validation and publishing

```powershell
npm run distribution:test
npm run distribution:pack
npm run distribution:smoke
npm run distribution:smoke -- --gpu
```

Build output is regenerated from current sources into ignored
`.pelican/npm/package/`; tarballs and smoke reports go in `.pelican/npm/artifacts/`.
Neither staging nor tarballs are inside the deployable game `dist/`.
Pack that staging directory, not the private repository root. Compiled relative
imports use `lib/` modules and `.js`, never the TypeScript source layout. The
tarball allowlist excludes source maps, evidence, examples and game assets;
SDK declarations, engine runtime code, MIT, copied AI docs, and dependency
license texts are included. `distribution.json` records version and file hashes.
Dependencies are normal pinned npm dependencies, not vendored engine sources.

The npm workflow runs only for a published GitHub milestone release. Its gate
requires tag/version/SDK/manifest identity and the existing milestone acceptance
and source-fingerprint checks. An ordinary push or CPU-green build cannot publish.
M3 is deliberately blocked until its release profile and real acceptance exist.
The default smoke install uses npm cache only; `--online-install` allows network
for initial dependency installation, then runs every operation offline with a
disabled registry. CI uses this flag because `npm ci` alone need not populate
registry metadata for a fresh external install. `--gpu` additionally measures
the installed WebGPU backend, renders path/hybrid/raster, checks a nonblank canvas,
captures through both CLI routes, verifies WebGL2 fallback rejection, and loads
the nested-base static build without a development hook. It is not M3 acceptance.

The single unscoped package is `pelican-engine`, its only public import is
`pelican-engine`, and its executable is `pelican`. The GitHub target is
`danchar12138/pelican-engine`; main completed the public repository rename and
verified the updated origin. No new organization is required. The authorized
npm Automation Token was authenticated as `danchar12138`, and main confirmed
the repository Actions secret `NPM_TOKEN` is configured. `npm view pelican-engine`
returned `E404` before publication. The package remains unpublished pending
genuine M3 acceptance; this is not an authentication or organization blocker.
`setup-node` configures the registry;
only the final publication step receives `NODE_AUTH_TOKEN`. A missing secret
fails with `TC_NPM_AUTH_MISSING`, without printing the value. The token must have
permission to publish the fixed unscoped package. No OIDC/trusted-publisher setup
or provenance flag is required by this workflow. Prereleases use `next`; stable
versions use `latest`. These credentials do not bypass milestone acceptance.
No token value is stored in source, documentation, or probe output. No publication
is performed by this packaging task. See
`tools/npm/publish-gate.ts` in the source distribution.
