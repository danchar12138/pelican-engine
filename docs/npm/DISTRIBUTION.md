<div align="center">
  <img src="https://raw.githubusercontent.com/danchar12138/pelican-engine/main/docs/assets/pelican-mark.svg" alt="Pelican Engine" width="110" height="110">
  <h1>Pelican Engine</h1>
  <p><strong>Build games for the web with TypeScript.</strong></p>
  <p>Code-first · WebGPU-first · Designed for human and external AI workflows</p>
  <p>
    <a href="https://www.npmjs.com/package/pelican-engine"><img src="https://img.shields.io/npm/v/pelican-engine?label=npm&amp;color=168b80" alt="npm version"></a>
    <img src="https://img.shields.io/badge/license-MIT-24536b" alt="MIT license">
    <img src="https://img.shields.io/badge/TypeScript-SDK-3178c6" alt="TypeScript SDK">
  </p>
</div>

Pelican Engine provides a TypeScript SDK, compiler, runtime, renderer and CLI in one package. Define game content and behavior in code, run a local development server and build a static web distribution. AI tools may assist development, but the game runtime does not include an LLM or AI agent.

> **Development status:** this is an evolving engine, not a complete first release. Current source behavior, hardware compatibility, performance and the full feature set have not been fully validated. A normal version number is not an acceptance claim. See the [development status](https://github.com/danchar12138/pelican-engine/blob/main/docs/STATUS.md) for known gaps.

## Quick start

Install Node.js **24.x** and npm, then create a new empty game directory:

```sh
mkdir my-pelican-game
cd my-pelican-game
npm --prefix . install --save-dev --save-exact pelican-engine
npx pelican dev
```

The first `dev` creates `game.ts`, `pelican.project.json` and `AGENTS.md` in an eligible empty project. Existing game files and author instructions are not overwritten. The explicit `--prefix .` prevents npm from choosing a parent project; `--save-exact` pins the installed version. Stop the development server before building:

```sh
npx --no-install pelican build
```

Deploy the resulting `dist/` directory, including its generated assets and notices, to an HTTP(S) static host. For a nested deployment, use `npx --no-install pelican build --base /game/`.

Commands use common Node/npm syntax rather than a particular shell. **Engine and game development currently support Windows only**; Linux and macOS development workflows have not been promised or validated. Player platforms are not restricted by brand or OS: actual rendering availability depends on browser and graphics capabilities.

## Your game

The generated starter defines a scene and a rotating box. Game code imports only the public package, for example:

```ts
import { defineGame, defineMaterial, defineScene } from "pelican-engine";

const material = defineMaterial({ id: "paint", color: "#38b8a4", roughness: 0.45 });
const scene = defineScene({
  id: "main",
  camera: { position: [4, 3, 6], target: [0, 0, 0], fov: 50 },
  entities: [
    { id: "box", mesh: { geometry: { kind: "box" }, material } },
    { id: "light", light: { kind: "directional", intensity: 4 },
      transform: { position: [3, 6, 4] } },
  ],
});
export default defineGame({ id: "my-game", scene });
```

Save it as `game.ts` in a project created by the CLI. The exact engine version is recorded in `pelican.project.json`. `pelican migrate` can plan an explicit lock update and, with `--apply --from`, create a recovery backup before changing it; see GAME-AUTHOR for the restore protocol. This lock-only command does not migrate game code, dependencies or saves and has not been runtime-validated. Do not edit `node_modules` or import engine internals.

Useful commands:

```sh
npx --no-install pelican help
npx --no-install pelican api
npx --no-install pelican api --symbol defineGame
npx --no-install pelican migrate
npx --no-install pelican dev --port 4173
npx --no-install pelican build
```

The renderer prioritizes WebGPU and can use Three.js's built-in WebGL2 raster fallback. Compute-dependent hybrid/path tracing and compute features are not available on WebGL2; unsupported requests return diagnostics rather than silently claiming equivalent rendering. See the [backend guide](https://github.com/danchar12138/pelican-engine/blob/main/docs/RENDER-BACKENDS.md).

## Documentation

- [Getting started: npm and source checkout](https://github.com/danchar12138/pelican-engine/blob/main/docs/GETTING-STARTED.md)
- [Game author guide](https://github.com/danchar12138/pelican-engine/blob/main/docs/npm/GAME-AUTHOR.md)
- [API reference](https://github.com/danchar12138/pelican-engine/blob/main/docs/api/REFERENCE.md) and [capabilities](https://github.com/danchar12138/pelican-engine/blob/main/docs/CAPABILITIES.md)
- [Source repository and contribution guide](https://github.com/danchar12138/pelican-engine)

The installed package also includes `docs/npm/GAME-AUTHOR.md`, `docs/api/REFERENCE.md`, `docs/api/index.json` and `lib/sdk/index.d.ts`. The installed declarations and `pelican api` describe the API of the actual installed version. Repository examples and assets are not shipped in the npm package.

Playwright Chromium is optional for capture and browser automation. If needed, prepare it while online with `npx --no-install pelican setup --install-browser`. With required dependencies and assets already available, everyday operations need no engine account or hosted development service. An offline reinstall additionally requires cached packages.

## License

Pelican Engine's own code is MIT licensed. Dependency licenses and third-party notices are included in the package under `licenses/` and in the [repository notices](https://github.com/danchar12138/pelican-engine/blob/main/docs/THIRD-PARTY-NOTICES.md).
