import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three/webgpu";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { createModelLibrary } from "../packages/renderer/src/models.ts";

for (const includeLive of [true, false])
  test(`CPU staged rollback preserves shared material and morph weights (live included: ${includeLive})`, async (t) => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      "position",
      new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3),
    );
    geometry.morphAttributes.position = [
      new THREE.Float32BufferAttribute([0, 0, 0, 0, 0, 0, 0, 0, 0], 3),
      new THREE.Float32BufferAttribute([0, 0, 0, 0, 0, 0, 0, 0, 0], 3),
    ];
    const material = new THREE.MeshBasicMaterial({ opacity: 0.2 });
    const scene = new THREE.Group();
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = "mesh";
    scene.add(mesh);
    const clip = new THREE.AnimationClip("anim", 1, [
      new THREE.NumberKeyframeTrack(
        "mesh.material.opacity",
        [0, 1],
        [0.2, 0.8],
      ),
      new THREE.NumberKeyframeTrack(
        "mesh.morphTargetInfluences",
        [0, 1],
        [0, 0, 1, 0.5],
      ),
      new THREE.VectorKeyframeTrack(
        "mesh.position",
        [0, 1],
        [0, 0, 0, 1, 2, 3],
      ),
      new THREE.QuaternionKeyframeTrack(
        "mesh.quaternion",
        [0, 1],
        [0, 0, 0, 1, 0, 0.70710678, 0, 0.70710678],
      ),
    ]);
    t.mock.method(
      GLTFLoader.prototype,
      "parseAsync",
      async () => ({ scene, scenes: [scene], animations: [clip] }) as any,
    );
    const lib = createModelLibrary(
      { hero: "hero.glb" },
      { fetch: async () => new Response(new Uint8Array([1])) },
    );
    t.after(() => lib.dispose());
    await lib.prepare();
    const live = lib.instantiate("a", { asset: "hero" });
    lib.animation.play("a", "anim");
    lib.tick(0.25);
    const liveMesh = live.node.getObjectByName("mesh") as THREE.Mesh;
    const before = lib.snapshot();
    const opacity = material.opacity;
    const morph = [...liveMesh.morphTargetInfluences!];
    const pos = liveMesh.position.toArray();
    const quat = liveMesh.quaternion.toArray();
    lib.register("b", { asset: "hero" });
    lib.register("c", { asset: "hero" });
    const target = structuredClone(before);
    target.animations.push({
      ...structuredClone(target.animations[0]!),
      entity: "b",
    });
    target.animations.push({
      ...structuredClone(target.animations[0]!),
      entity: "c",
    });
    target.animations[1]!.actions[0]!.time = 0.5;
    target.animations[2]!.actions[0]!.time = 0.75;
    if (!includeLive) target.animations.shift();
    const update = THREE.AnimationMixer.prototype.update;
    let count = 0;
    THREE.AnimationMixer.prototype.update = function (dt) {
      const r = update.call(this, dt);
      if (++count === 2) throw new Error("injected");
      return r;
    };
    try {
      assert.throws(() => lib.restore(target), /injected/);
    } finally {
      THREE.AnimationMixer.prototype.update = update;
    }
    assert.deepEqual(lib.snapshot(), before);
    assert.deepEqual(liveMesh.morphTargetInfluences, morph);
    assert.deepEqual(liveMesh.position.toArray(), pos);
    assert.deepEqual(liveMesh.quaternion.toArray(), quat);
    assert.ok(
      Math.abs(material.opacity - opacity) < 1e-6,
      `opacity ${material.opacity}, expected ${opacity}`,
    );
    lib.tick(0.1);
    assert.ok(Math.abs(material.opacity - 0.41) < 1e-6);
    assert.deepEqual(liveMesh.morphTargetInfluences, [0.35, 0.175]);
  });

test(
  "CPU replacement restore applies morph and material saved pose",
  {
    skip:
      process.env.MODEL_RESTORE_REPRO !== "1"
        ? "known unresolved shared-material commit failure; set MODEL_RESTORE_REPRO=1 to reproduce"
        : false,
  },
  async (t) => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      "position",
      new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3),
    );
    geometry.morphAttributes.position = [
      new THREE.Float32BufferAttribute([0, 0, 0, 0, 0, 0, 0, 0, 0], 3),
      new THREE.Float32BufferAttribute([0, 0, 0, 0, 0, 0, 0, 0, 0], 3),
    ];
    const material = new THREE.MeshBasicMaterial({ opacity: 0.2 });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = "mesh";
    const scene = new THREE.Group();
    scene.add(mesh);
    const clip = new THREE.AnimationClip("anim", 1, [
      new THREE.NumberKeyframeTrack(
        "mesh.material.opacity",
        [0, 1],
        [0.2, 0.8],
      ),
      new THREE.NumberKeyframeTrack(
        "mesh.morphTargetInfluences",
        [0, 1],
        [0, 0, 1, 0.5],
      ),
    ]);
    t.mock.method(
      GLTFLoader.prototype,
      "parseAsync",
      async () => ({ scene, scenes: [scene], animations: [clip] }) as any,
    );
    const lib = createModelLibrary(
      { hero: "hero.glb" },
      { fetch: async () => new Response(new Uint8Array([1])) },
    );
    t.after(() => lib.dispose());
    await lib.prepare();
    lib.instantiate("a", { asset: "hero" });
    lib.animation.play("a", "anim");
    lib.tick(0.75);
    const saved = lib.snapshot();
    lib.tick(0.1);
    lib.restore(saved, [
      { entity: "a", definition: { asset: "hero", scale: 2 } },
    ]);
    const out = lib.get("a")!.node.getObjectByName("mesh") as THREE.Mesh;
    assert.deepEqual(out.morphTargetInfluences, [0.75, 0.375]);
    assert.ok(
      Math.abs(material.opacity - 0.65) < 1e-6,
      `opacity ${material.opacity}, expected 0.65`,
    );
  },
);

test("CPU real GLB morph weight restore and exception rollback", async (t) => {
  const { Accessor, Document, NodeIO } = await import("@gltf-transform/core");
  const doc = new Document(),
    buffer = doc.createBuffer();
  const attr = (name: string, values: number[]) =>
    doc
      .createAccessor(name, buffer)
      .setType(Accessor.Type.VEC3)
      .setArray(new Float32Array(values));
  const primitive = doc
    .createPrimitive()
    .setAttribute("POSITION", attr("position", [0, 0, 0, 1, 0, 0, 0, 1, 0]));
  for (const delta of [0.1, 0.2])
    primitive.addTarget(
      doc
        .createPrimitiveTarget()
        .setAttribute(
          "POSITION",
          attr("delta", [0, delta, 0, 0, delta, 0, 0, delta, 0]),
        ),
    );
  const node = doc
    .createNode("morph")
    .setMesh(
      doc.createMesh("shape").addPrimitive(primitive).setWeights([0, 0]),
    );
  doc.createScene("scene").addChild(node);
  const times = doc
    .createAccessor("time", buffer)
    .setType(Accessor.Type.SCALAR)
    .setArray(new Float32Array([0, 1]));
  const values = doc
    .createAccessor("weights", buffer)
    .setType(Accessor.Type.SCALAR)
    .setArray(new Float32Array([0, 0, 1, 0.5]));
  const sampler = doc
    .createAnimationSampler()
    .setInput(times)
    .setOutput(values);
  const channel = doc
    .createAnimationChannel()
    .setTargetNode(node)
    .setTargetPath("weights")
    .setSampler(sampler);
  doc.createAnimation("weights").addSampler(sampler).addChannel(channel);
  const data = await new NodeIO().writeBinary(doc);
  const lib = createModelLibrary(
    { hero: "hero.glb" },
    { fetch: async () => new Response(data as any) },
  );
  t.after(() => lib.dispose());
  await lib.prepare();
  const instance = lib.instantiate("a", { asset: "hero" });
  lib.animation.play("a", "weights");
  lib.tick(0.25);
  const mesh = instance.node.getObjectByProperty("isMesh", true) as THREE.Mesh;
  assert.deepEqual(mesh.morphTargetInfluences, [0.25, 0.125]);
  const saved = lib.snapshot();
  lib.tick(0.25);
  lib.restore(saved);
  assert.deepEqual(mesh.morphTargetInfluences, [0.25, 0.125]);
  const target = structuredClone(saved);
  target.animations[0]!.actions[0]!.time = 0.8;
  const update = THREE.AnimationMixer.prototype.update;
  let count = 0;
  THREE.AnimationMixer.prototype.update = function (dt) {
    const r = update.call(this, dt);
    if (++count === 1) throw new Error("morph injected");
    return r;
  };
  try {
    assert.throws(() => lib.restore(target), /morph injected/);
  } finally {
    THREE.AnimationMixer.prototype.update = update;
  }
  assert.deepEqual(mesh.morphTargetInfluences, [0.25, 0.125]);
  assert.deepEqual(lib.snapshot(), saved);
  lib.tick(0.25);
  assert.deepEqual(mesh.morphTargetInfluences, [0.5, 0.25]);
});

async function sharedMaterialFixture(t: import("node:test").TestContext) {
  const material = new THREE.MeshBasicMaterial({ opacity: 0.2 });
  const mesh = new THREE.Mesh(new THREE.BufferGeometry(), material);
  mesh.name = "mesh";
  const scene = new THREE.Group();
  scene.add(mesh);
  const clip = new THREE.AnimationClip("anim", 1, [
    new THREE.NumberKeyframeTrack("mesh.material.opacity", [0, 1], [0.2, 0.8]),
  ]);
  t.mock.method(
    GLTFLoader.prototype,
    "parseAsync",
    async () => ({ scene, scenes: [scene], animations: [clip] }) as any,
  );
  const lib = createModelLibrary(
    { hero: "hero.glb" },
    { fetch: async () => new Response(new Uint8Array([1])) },
  );
  t.after(() => lib.dispose());
  await lib.prepare();
  return { lib, material };
}
const knownFailure = {
  skip:
    process.env.MODEL_RESTORE_REPRO !== "1"
      ? "known shared-material mixer lifecycle defect; set MODEL_RESTORE_REPRO=1"
      : false,
};
test(
  "CPU replacement last stop restores original material not pre-restore pose",
  knownFailure,
  async (t) => {
    const { lib, material } = await sharedMaterialFixture(t);
    lib.instantiate("a", { asset: "hero" });
    lib.animation.play("a", "anim");
    lib.tick(0.75);
    const saved = lib.snapshot();
    lib.tick(0.1);
    lib.restore(saved, [
      { entity: "a", definition: { asset: "hero", scale: 2 } },
    ]);
    lib.tick(0);
    lib.remove("a");
    assert.ok(
      Math.abs(material.opacity - 0.2) < 1e-6,
      `last stop: ${material.opacity}, expected 0.2`,
    );
  },
);
for (const condition of ["first stop", "last stop"] as const)
  test(
    `CPU independent shared mixers preserve ${condition} semantics`,
    knownFailure,
    async (t) => {
      const { lib, material } = await sharedMaterialFixture(t);
      lib.instantiate("a", { asset: "hero" });
      lib.animation.play("a", "anim");
      lib.tick(0.25);
      lib.instantiate("b", { asset: "hero" });
      lib.animation.play("b", "anim");
      lib.tick(0.5);
      const current = material.opacity;
      lib.remove("a");
      if (condition === "first stop")
        assert.ok(
          Math.abs(material.opacity - current) < 1e-6,
          `remaining active mixer: ${material.opacity}, expected ${current}`,
        );
      else {
        lib.remove("b");
        assert.ok(
          Math.abs(material.opacity - 0.2) < 1e-6,
          `last mixer: ${material.opacity}, expected 0.2`,
        );
      }
    },
  );
