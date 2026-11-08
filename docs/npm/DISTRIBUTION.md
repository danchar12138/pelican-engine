# Pelican Engine

<p align="center"><img src="docs/assets/pelican-mark.svg" width="180" alt="Pelican Engine pelican icon" /></p>

**Turn game ideas into running worlds with TypeScript and AI coding tools.** WebGPU-first rendering, physics, animation, UI, audio, save/restore and a machine-readable CLI ship together. Ordinary npm algorithms, per-instance runtime hooks, managed meshes and reusable rendering extensions help you build beyond a fixed game template.

Single-package game engine for external AI coding tools. Install from npm in a separate game directory. This package includes the public SDK, runtime, renderer, compiler and `pelican` CLI. No engine repository checkout, source ZIP or Git installation is required.

```sh
mkdir my-game
cd my-game
npm --prefix . install --save-dev --save-exact pelican-engine
npx pelican dev
```

Node.js 24.x and npm are required. Development tools support Windows, macOS and Linux. The explicit prefix prevents installing into a parent project. The first dev command scaffolds an eligible empty directory; existing game work is preserved.

Query `npx --no-install pelican capabilities`, `pelican api --search <query>` and `pelican recipe --id <id>` before authoring. New projects use ordinary TypeScript construction and browser-compatible npm dependencies. Build and deploy with `npx --no-install pelican build`; serve the resulting game `dist/` over HTTP(S).

Read [Game Author](docs/npm/GAME-AUTHOR.md), [integrations](docs/npm/INTEGRATIONS.md), [recipes](docs/npm/RECIPES.md) and the generated [API reference](docs/api/REFERENCE.md). Use `pelican api --symbol AudioService.play` or `--search play --member` for compact exact contracts. Feature limits come from `pelican capabilities`; WebGPU is preferred, WebGL2 raster fallback is capability-dependent, and compute software BVH tracing is not hardware ray tracing.
