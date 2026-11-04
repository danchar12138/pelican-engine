# M0 compiler-driven sample

This directory is a complete input project for the implemented compileProject function; it does not need Git or its own package.json. The committed threecat.project.json records the relative game.ts entry and engineVersion. It contains no absolute enginePath; moving or copying the directory does not require path edits.

From the engine root, with the root dependencies installed:

```powershell
npx tsx -e "import {compileProject} from './experiments/compiler/index.ts'; compileProject({projectRoot:'examples/m0',outDir:'.threecat/compiled'}).then(r=>{console.log(JSON.stringify(r.report,null,2));if(!r.success)process.exitCode=1})"
```

Outputs are scene.ir.json, standalone browser ESM game.js, game.js.map, build-report.json and version.json. Do not load previous successful files after a failed current build; check success in the report.

The scene contains m0-spinner, m0-orb, m0-ground and m0-sun. The spinner starts at [-2, 1, 1.5]; its Motion component controls angular speed. Calling createGame(facade).update(0.5) advances rotation.y by 0.4 radians with the default component state. Disabling Motion.enabled stops that entity's rotation.

The pulse compute graph yields sin(time) for each output element. The animated material graph yields base \* (1 + sin(time)), with base = [0.1, 0.4, 0.8]. These values provide reference expectations for renderer GPU readback tests.

All example imports use @threecat/sdk. No source module is executed while compiling. See ../../experiments/compiler/CONTRACT.md for the renderer facade and IR integration contract.
