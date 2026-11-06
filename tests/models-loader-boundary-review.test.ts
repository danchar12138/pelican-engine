import test from "node:test";
import assert from "node:assert/strict";
import { Accessor, Document, NodeIO } from "@gltf-transform/core";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import * as THREE from "three/webgpu";
import { createModelLibrary } from "../packages/renderer/src/models.ts";
import { createGameServices } from "../packages/runtime/src/game-services.ts";

async function glb(
  mode:
    | "core"
    | "declared-unused"
    | "required-unused"
    | "optional-pointer"
    | "required-pointer"
    | "only-pointer"
    | "undeclared-pointer",
) {
  const d = new Document(),
    b = d.createBuffer();
  function a(name: string, type: string, data: number[]) {
    return d
      .createAccessor(name, b)
      .setType(type as any)
      .setArray(new Float32Array(data));
  }
  const material = d
    .createMaterial("shared")
    .setBaseColorFactor([1, 1, 1, 0.2])
    .setAlphaMode("BLEND");
  const primitive = d
    .createPrimitive()
    .setMaterial(material)
    .setAttribute(
      "POSITION",
      a("position", "VEC3", [0, 0, 0, 1, 0, 0, 0, 1, 0]),
    );
  primitive.addTarget(
    d
      .createPrimitiveTarget()
      .setAttribute(
        "POSITION",
        a("delta", "VEC3", [0, 0.1, 0, 0, 0.1, 0, 0, 0.1, 0]),
      ),
  );
  const node = d
    .createNode("mesh.material.opacity")
    .setMesh(d.createMesh("mesh").addPrimitive(primitive).setWeights([0]));
  d.createScene("scene").addChild(node);
  const times = a("time", "SCALAR", [0, 1]);
  const animation = d.createAnimation("move");
  function channel(
    path: "translation" | "rotation" | "scale" | "weights",
    type: string,
    values: number[],
  ) {
    const sampler = d
      .createAnimationSampler()
      .setInput(times)
      .setOutput(a(path, type, values));
    animation
      .addSampler(sampler)
      .addChannel(
        d
          .createAnimationChannel()
          .setTargetNode(node)
          .setTargetPath(path)
          .setSampler(sampler),
      );
  }
  channel("translation", "VEC3", [0, 0, 0, 1, 0, 0]);
  channel("rotation", "VEC4", [0, 0, 0, 1, 0, 0, 0.70710678, 0.70710678]);
  channel("scale", "VEC3", [1, 1, 1, 2, 2, 2]);
  channel("weights", "SCALAR", [0, 1]);
  let data = await new NodeIO().writeBinary(d);
  if (mode === "core") return data;
  const buf = Buffer.from(data),
    jsonLength = buf.readUInt32LE(12);
  const json = JSON.parse(buf.subarray(20, 20 + jsonLength).toString());
  const rot = json.animations[0].channels.find(
    (c: any) => c.target.path === "rotation",
  );
  if (mode !== "declared-unused" && mode !== "required-unused")
    rot.target = {
      path: "pointer",
      extensions: {
        KHR_animation_pointer: {
          pointer: "/materials/0/pbrMetallicRoughness/baseColorFactor",
        },
      },
    };
  if (mode === "only-pointer") json.animations[0].channels = [rot];
  if (mode !== "undeclared-pointer")
    json.extensionsUsed = ["KHR_animation_pointer"];
  if (mode === "required-pointer" || mode === "required-unused")
    json.extensionsRequired = ["KHR_animation_pointer"];
  const encoded = Buffer.from(JSON.stringify(json)),
    pad = (4 - (encoded.length % 4)) % 4;
  const chunk = Buffer.concat([encoded, Buffer.alloc(pad, 0x20)]),
    rest = buf.subarray(20 + jsonLength);
  const header = Buffer.alloc(20);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(20 + chunk.length + rest.length, 8);
  header.writeUInt32LE(chunk.length, 12);
  header.writeUInt32LE(0x4e4f534a, 16);
  return new Uint8Array(Buffer.concat([header, chunk, rest]));
}
function close(x: number, expected: number) {
  assert.ok(Math.abs(x - expected) < 1e-5, `${x} != ${expected}`);
}
function services(lib: ReturnType<typeof createModelLibrary>) {
  const ir: any = {
    gameId: "test",
    assets: [],
    scene: { id: "scene", entities: [{ id: "a" }, { id: "b" }] },
  };
  return createGameServices(ir, lib.animation).factory({ scene: ir } as any)
    .services!.animation!;
}
function mesh(
  instance: ReturnType<ReturnType<typeof createModelLibrary>["instantiate"]>,
) {
  return instance.node.getObjectByProperty("isMesh", true) as THREE.Mesh;
}

test("real GLB core paths and game animation service preserve shared material across restore/removal", async (t) => {
  const bytes = await glb("core");
  const decoded = await new GLTFLoader().parseAsync(
    bytes.buffer as ArrayBuffer,
    "",
  );
  const names = decoded.animations[0]!.tracks.map((x) => x.name);
  assert.deepEqual(
    names.map((x) => x.split(".").at(-1)).sort(),
    ["morphTargetInfluences", "position", "quaternion", "scale"].sort(),
  );
  assert.ok(
    names.every((x) => !x.includes(".material.")),
    JSON.stringify(names),
  );
  const lib = createModelLibrary(
    { hero: "hero.glb" },
    { fetch: async () => new Response(bytes as any) },
  );
  t.after(() => lib.dispose());
  await lib.prepare();
  const a = lib.instantiate("a", { asset: "hero" }),
    b = lib.instantiate("b", { asset: "hero" });
  const ma = mesh(a),
    mb = mesh(b);
  assert.equal(ma.material, mb.material);
  const mat = ma.material as THREE.MeshStandardMaterial;
  close(mat.opacity, 0.2);
  const game = services(lib);
  game.play("a", "move");
  lib.tick(0.25);
  game.play("b", "move");
  lib.tick(0.25);
  close(game.state("a").time, 0.5);
  close(ma.position.x, 0.5);
  close(mb.position.x, 0.25);
  close(ma.morphTargetInfluences![0]!, 0.5);
  close(mat.opacity, 0.2);
  const saved = lib.snapshot();
  lib.tick(0.1);
  lib.restore(saved, [
    { entity: "a", definition: { asset: "hero", scale: 2 } },
    { entity: "b", definition: { asset: "hero" } },
  ]);
  close(game.state("a").time, 0.5);
  close(mesh(lib.get("a")!).position.x, 0.5);
  close(mat.opacity, 0.2);
  lib.remove("a");
  close(mat.opacity, 0.2);
  lib.remove("b");
  close(mat.opacity, 0.2);
});

test("real GLBs reject used pointer channels and accept unused optional declaration", async (t) => {
  // The upstream loader omits an optional pointer channel while retaining the
  // core channels: prove the behavior that the adapter must not silently pass.
  const bytes = await glb("optional-pointer");
  const decoded = await new GLTFLoader().parseAsync(
    bytes.buffer as ArrayBuffer,
    "",
  );
  assert.deepEqual(
    decoded.animations[0]!.tracks.map((x) => x.name.split(".").at(-1)).sort(),
    ["position", "scale", "morphTargetInfluences"].sort(),
  );
  for (const mode of [
    "optional-pointer",
    "required-pointer",
    "only-pointer",
    "undeclared-pointer",
    "required-unused",
  ] as const) {
    const input = await glb(mode);
    const lib = createModelLibrary(
      { hero: "hero.glb" },
      { fetch: async () => new Response(input as any) },
    );
    t.after(() => lib.dispose());
    await assert.rejects(
      lib.prepare(),
      /TC_MODEL_LOAD_FAILED: hero: TC_MODEL_EXTENSION_UNSUPPORTED: KHR_animation_pointer/,
    );
    assert.equal(lib.inspect().templates.length, 0);
    assert.deepEqual(lib.inspect().owned, {
      geometries: 0,
      materials: 0,
      textures: 0,
      skeletons: 0,
    });
  }
  const unused = await glb("declared-unused");
  const lib = createModelLibrary(
    { hero: "hero.glb" },
    { fetch: async () => new Response(unused as any) },
  );
  t.after(() => lib.dispose());
  await lib.prepare();
  const inst = lib.instantiate("a", { asset: "hero" });
  services(lib).play("a", "move");
  lib.tick(0.5);
  close(mesh(inst).position.x, 0.5);
  close((mesh(inst).material as THREE.MeshStandardMaterial).opacity, 0.2);
});

test("rejected real pointer GLB is not cached; retry and disposal release normal assets once", async (t) => {
  const bad = await glb("optional-pointer"),
    good = await glb("core");
  let requests = 0;
  const lib = createModelLibrary(
    { hero: "hero.glb" },
    { fetch: async () => new Response((++requests === 1 ? bad : good) as any) },
  );
  t.after(() => lib.dispose());
  let geometries = 0,
    materials = 0;
  const geometryDispose = THREE.BufferGeometry.prototype.dispose;
  const materialDispose = THREE.Material.prototype.dispose;
  t.mock.method(
    THREE.BufferGeometry.prototype,
    "dispose",
    function (this: THREE.BufferGeometry) {
      geometries++;
      return geometryDispose.call(this);
    },
  );
  t.mock.method(
    THREE.Material.prototype,
    "dispose",
    function (this: THREE.Material) {
      materials++;
      return materialDispose.call(this);
    },
  );
  await assert.rejects(
    lib.prepare(),
    /TC_MODEL_LOAD_FAILED: hero: TC_MODEL_EXTENSION_UNSUPPORTED: KHR_animation_pointer/,
  );
  assert.deepEqual(lib.inspect().owned, {
    geometries: 0,
    materials: 0,
    textures: 0,
    skeletons: 0,
  });
  assert.equal(geometries, 0);
  assert.equal(materials, 0); // rejected before decode
  await lib.prepare();
  assert.equal(requests, 2);
  const owned = lib.inspect().owned;
  assert.ok(owned.geometries > 0);
  assert.ok(owned.materials > 0);
  await lib.dispose();
  assert.equal(geometries, owned.geometries);
  assert.equal(materials, owned.materials);
  await lib.dispose();
  assert.equal(geometries, owned.geometries);
  assert.equal(materials, owned.materials);
});
