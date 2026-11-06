import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, mkdir, cp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { compileProject } from "../packages/compiler/src/index.ts";
import { SDK_VERSION } from "../packages/sdk/src/index.ts";
const engineRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const source = (clip = "Survey") =>
  [
    'import {defineAsset,defineGame,defineScene}from "pelican-engine";',
    'const fox=defineAsset({id:"fox",type:"model",path:"assets/Fox.glb",license:"CC0-1.0 AND CC-BY-4.0",attribution:"PixelMannen, tomkranis, AsoboStudio, scurest",source:"fixed-source"});',
    'const chime=defineAsset({id:"chime",type:"audio",path:"assets/chime.wav",license:"MIT"});',
    'export default defineGame({id:"asset-game",assets:[fox,chime],sounds:[{id:"pickup",asset:chime}],scene:defineScene({id:"scene",entities:[{id:"hero",model:{asset:fox,scale:0.01,offset:[0,-0.7,0],rotation:[0,1,0],animation:{clip:' +
      JSON.stringify(clip) +
      "}}}]})});",
  ].join("\n");
test("named model material slots compile and invalid declarations are diagnosed", async (t) => {
  const p = await fixture(t);
  const game = source()
    .replace("defineAsset,defineGame,defineScene", "defineAsset,defineGame,defineScene,defineMaterial")
    .replace("export default defineGame", 'const paint=defineMaterial({id:"paint",color:"#ff0000"});\nexport default defineGame')
    .replace("asset:fox,scale", 'asset:fox,materialSlots:{Fur:paint},scale');
  await writeFile(path.join(p.root, "game.ts"), game);
  const ok = await p.compile();
  assert.equal(ok.success, true, JSON.stringify(ok.diagnostics));
  assert.deepEqual(ok.ir!.scene.entities[0]!.model!.materialSlots, { Fur: "paint" });
  await writeFile(path.join(p.root, "game.ts"), game.replace('materialSlots:{Fur:paint}', 'materialSlots:{Z:paint,A:paint}'));
  const ordered = await p.compile();
  assert.equal(ordered.success, true, JSON.stringify(ordered.diagnostics));
  assert.deepEqual(Object.keys(ordered.ir!.scene.entities[0]!.model!.materialSlots!), ["A", "Z"]);
  await writeFile(path.join(p.root, "game.ts"), game.replace('materialSlots:{Fur:paint}', 'material:paint,materialSlots:{Fur:paint}'));
  const conflict = await p.compile();
  assert.equal(conflict.success, false);
  assert.ok(conflict.diagnostics.some(d => d.code === "TC_MODEL_MATERIAL_CONFLICT"));
  await writeFile(path.join(p.root, "game.ts"), game.replace('materialSlots:{Fur:paint}', 'materialSlots:{Fur:"missing"}'));
  const missing = await p.compile();
  assert.equal(missing.success, false);
  assert.ok(missing.diagnostics.some(d => d.code === "TC_RESOURCE_MISSING"));
});
test("audio bus declarations and routes compile through the public SDK", async (t) => {
  const p = await fixture(t);
  const game = source()
    .replace('defineAsset,defineGame,defineScene', 'defineAsset,defineGame,defineScene,defineSystem')
    .replace('export default defineGame', 'const system=defineSystem({id:"audio-control",run(ctx){ctx.audio.busVolume("effects",0.5);ctx.audio.play("pickup",{bus:"effects"});}});\nexport default defineGame')
    .replace('sounds:[{id:"pickup",asset:chime}]', 'systems:[system],audioBuses:[{id:"effects",volume:0.4}],sounds:[{id:"pickup",asset:chime,bus:"effects"}]');
  await writeFile(path.join(p.root, "game.ts"), game);
  const ok = await p.compile();
  assert.equal(ok.success, true, JSON.stringify(ok.diagnostics));
  assert.deepEqual(ok.ir!.audioBuses, [{ id: "effects", volume: 0.4 }]);
  assert.equal(ok.ir!.sounds![0].bus, "effects");
  assert.equal(ok.ir!.systems[0].id, "audio-control");
  await writeFile(path.join(p.root, "game.ts"), game.replace('asset:chime,bus:"effects"', 'asset:chime,bus:"missing"'));
  const bad = await p.compile();
  assert.equal(bad.success, false);
  assert.ok(bad.diagnostics.some(d => d.code === "TC_AUDIO_BUS"));
});
async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(path.join(tmpdir(), "pelican compiler assets "));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(tmpdir()));
    assert.ok(path.basename(root).startsWith("pelican compiler assets "));
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(path.join(root, "assets"));
  for (const name of ["Fox.glb", "chime.wav"])
    await cp(
      path.join(engineRoot, "examples/m2/assets", name),
      path.join(root, "assets", name),
    );
  await writeFile(
    path.join(root, "pelican.project.json"),
    JSON.stringify({ engineVersion: SDK_VERSION }),
  );
  await writeFile(path.join(root, "game.ts"), source());
  return {
    root,
    compile: () =>
      compileProject({ projectRoot: root, outDir: "output", engineRoot }),
  };
}
test("compiler inspects real skeletal assets/audio, preserves transforms and bundles provenance", async (t) => {
  const p = await fixture(t),
    r = await p.compile();
  assert.equal(r.success, true, JSON.stringify(r.diagnostics));
  const fox = r.ir!.assets.find((a) => a.id === "fox")!,
    audio = r.ir!.assets.find((a) => a.id === "chime")!;
  assert.equal(fox.metadata?.skinCount, 1);
  assert.deepEqual(
    (fox.metadata?.animations as { name: string }[]).map((a) => a.name),
    ["Survey", "Walk", "Run"],
  );
  assert.equal(audio.metadata?.duration, 0.45);
  assert.deepEqual(r.ir!.scene.entities[0]!.model!.offset, [0, -0.7, 0]);
  assert.deepEqual(r.ir!.scene.entities[0]!.model!.rotation, [0, 1, 0]);
  const notices = JSON.parse(
    await readFile(path.join(p.root, "output/asset-notices.json"), "utf8"),
  );
  assert.match(notices.assets[0].attribution, /tomkranis/);
  assert.equal(notices.assets[0].source, "fixed-source");
  assert.equal((await p.compile()).report.incremental.cacheHit, true);
});
test("missing model clip fails at source; corrupt asset invalidates cache and preserves prior outputs", async (t) => {
  const p = await fixture(t),
    initial = await p.compile();
  assert.equal(initial.success, true);
  const bytes = await readFile(path.join(p.root, "output/game.js"));
  await writeFile(path.join(p.root, "game.ts"), source("not-an-animation"));
  const badClip = await p.compile();
  assert.equal(badClip.success, false);
  const diagnostic = badClip.diagnostics.find(
    (d) => d.code === "TC_MODEL_CLIP",
  );
  assert.equal(diagnostic?.source?.file, "game.ts");
  assert.ok(diagnostic!.source!.line > 0);
  assert.match(diagnostic!.message, /Survey.*Walk.*Run/);
  await writeFile(path.join(p.root, "game.ts"), source());
  await writeFile(path.join(p.root, "assets/Fox.glb"), Buffer.from("bad"));
  const corrupt = await p.compile();
  assert.equal(corrupt.success, false);
  const invalid = corrupt.diagnostics.find(
    (d) => d.code === "TC_ASSET_INVALID",
  );
  assert.equal(invalid?.source?.file, "game.ts");
  assert.ok(!invalid?.message.includes(p.root));
  assert.deepEqual(await readFile(path.join(p.root, "output/game.js")), bytes);
});
test("unsupported audio is diagnosed before browser load with asset declaration coordinates", async (t) => {
  const p = await fixture(t);
  await writeFile(
    path.join(p.root, "assets/chime.wav"),
    Buffer.from("ID3not-PCM"),
  );
  const r = await p.compile();
  assert.equal(r.success, false);
  assert.ok(
    r.diagnostics.some(
      (d) =>
        ["TC_ASSET_INVALID", "TC_ASSET_UNSUPPORTED"].includes(d.code) &&
        d.source?.file === "game.ts",
    ),
  );
});
