import test from "node:test";
import assert from "node:assert/strict";
import { Accessor, Document, NodeIO } from "@gltf-transform/core";
import * as THREE from "three/webgpu";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { extractSurfaceScene } from "../packages/renderer/src/surface.ts";
import type { ModelDefinition } from "../packages/sdk/src/index.ts";
import {
  createModelLibrary,
  type ModelInstance,
  type ModelLibraryOptions,
} from "../packages/renderer/src/models.ts";

// Two material primitives, one joint, a morph target, and a real animation.
// Everything is generated in memory and decoded by the actual GLTFLoader.
async function skinnedMorphGLB(): Promise<ArrayBuffer> {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const accessor = (
    name: string,
    type: Parameters<Accessor["setType"]>[0],
    values: Parameters<Accessor["setArray"]>[0],
  ) => doc.createAccessor(name, buffer).setType(type).setArray(values);
  const position = accessor(
    "position",
    Accessor.Type.VEC3,
    new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
  );
  const joints = accessor("joints", Accessor.Type.VEC4, new Uint8Array(12));
  const weights = accessor(
    "weights",
    Accessor.Type.VEC4,
    new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]),
  );
  const morph = accessor(
    "morph",
    Accessor.Type.VEC3,
    new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
  );
  const mesh = doc.createMesh("two-primitives").setWeights([0.25]);
  for (const [name, color] of [
    ["asset-red", [1, 0, 0, 1]],
    ["asset-blue", [0, 0, 1, 1]],
  ] as const) {
    mesh.addPrimitive(
      doc
        .createPrimitive()
        .setAttribute("POSITION", position)
        .setAttribute("JOINTS_0", joints)
        .setAttribute("WEIGHTS_0", weights)
        .setMaterial(doc.createMaterial(name).setBaseColorFactor([...color]))
        .addTarget(doc.createPrimitiveTarget().setAttribute("POSITION", morph)),
    );
  }
  const bone = doc.createNode("animated-bone");
  const skin = doc.createSkin("skin").addJoint(bone);
  const scene = doc
    .createScene("scene")
    .addChild(bone)
    .addChild(doc.createNode("nodeSkin").setMesh(mesh).setSkin(skin));
  doc.getRoot().setDefaultScene(scene);
  const sampler = doc
    .createAnimationSampler("raise")
    .setInput(accessor("time", Accessor.Type.SCALAR, new Float32Array([0, 1])))
    .setOutput(
      accessor(
        "translation",
        Accessor.Type.VEC3,
        new Float32Array([0, 0, 0, 0, 1, 0]),
      ),
    );
  const channel = doc
    .createAnimationChannel("raise-bone")
    .setTargetNode(bone)
    .setTargetPath("translation")
    .setSampler(sampler);
  doc.createAnimation("raise").addSampler(sampler).addChannel(channel);
  const bytes = await new NodeIO().writeBinary(doc);
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

const fixture = skinnedMorphGLB();
async function makeLibrary(options: ModelLibraryOptions = {}) {
  const bytes = await fixture;
  const library = createModelLibrary(
    { hero: "https://assets.test/hero.glb" },
    { fetch: async () => new Response(bytes.slice(0)), ...options },
  );
  await library.prepare();
  return library;
}
function meshes(instance: ModelInstance): THREE.SkinnedMesh[] {
  const result: THREE.SkinnedMesh[] = [];
  instance.node.traverse((object) => {
    if ((object as THREE.Mesh).isMesh) {
      assert.ok((object as THREE.SkinnedMesh).isSkinnedMesh);
      result.push(object as THREE.SkinnedMesh);
    }
  });
  assert.equal(result.length, 2);
  assert.ok(instance.node.getObjectByName("nodeSkin"));
  return result;
}
function assertOverride(instance: ModelInstance, override: THREE.Material) {
  for (const mesh of meshes(instance)) {
    const slots = Array.isArray(mesh.material)
      ? mesh.material
      : [mesh.material];
    assert.ok(slots.length > 0);
    for (const slot of slots) assert.equal(slot, override);
  }
}

test("omitting the override retains original GLTF materials, textures, skin, morph, and animation", async (t) => {
  const textures = new Map<string, THREE.Texture>();
  let textureDisposals = 0;
  const parse = GLTFLoader.prototype.parseAsync;
  t.mock.method(
    GLTFLoader.prototype,
    "parseAsync",
    async function (
      this: GLTFLoader,
      ...args: Parameters<GLTFLoader["parseAsync"]>
    ) {
      // CPU texture stand-ins avoid requiring a browser image decoder.
      this.register((parser) => ({
        name: "CPU_fixture_material_textures",
        loadMaterial: async (index) => {
          const material = (await parser.loadMaterial(
            index,
          )) as THREE.MeshStandardMaterial;
          const texture = new THREE.DataTexture(
            new Uint8Array([255, 0, 0, 255]),
            1,
            1,
          );
          texture.addEventListener("dispose", () => textureDisposals++);
          material.map = texture;
          textures.set(material.name, texture);
          return material;
        },
      }));
      return parse.apply(this, args);
    },
  );
  let resolutions = 0;
  const library = await makeLibrary({
    material: () => {
      resolutions++;
      return undefined;
    },
  });
  t.after(() => library.dispose());
  const first = library.instantiate("a", {
    asset: "hero",
    animation: { clip: "raise" },
  });
  const second = library.instantiate("b", { asset: "hero" });
  const a = meshes(first),
    b = meshes(second);
  assert.equal(resolutions, 0);
  assert.deepEqual(
    a.map((mesh) => (mesh.material as THREE.Material).name),
    ["asset-red", "asset-blue"],
  );
  for (let i = 0; i < a.length; i++) {
    assert.equal(a[i]!.material, b[i]!.material);
    const material = a[i]!.material as THREE.MeshStandardMaterial;
    assert.equal(material.map, textures.get(material.name));
    assert.equal(a[i]!.geometry, b[i]!.geometry);
    assert.notEqual(a[i]!.skeleton, b[i]!.skeleton);
    assert.notEqual(a[i]!.skeleton.bones[0], b[i]!.skeleton.bones[0]);
    assert.notEqual(a[i]!.morphTargetInfluences, b[i]!.morphTargetInfluences);
    assert.equal(a[i]!.morphTargetInfluences![0], 0.25);
  }
  library.tick(0.5);
  first.node.updateMatrixWorld(true);
  const vertex = a[0]!.getVertexPosition(0, new THREE.Vector3());
  assert.ok(Math.abs(vertex.y - 0.5) < 1e-6);
  assert.ok(Math.abs(vertex.z - 0.25) < 1e-6);
  assert.equal(b[0]!.skeleton.bones[0]!.position.y, 0);
  assert.equal(library.inspect().owned.textures, 2);
  await library.dispose();
  assert.equal(textureDisposals, 2);
});

test("a whole-model node material replaces every primitive by identity and retains nodeSkin", async (t) => {
  const override = new THREE.MeshStandardNodeMaterial();
  t.after(() => override.dispose());
  const requests: string[] = [];
  const library = await makeLibrary({
    material: (id) => {
      requests.push(id);
      return override;
    },
  });
  t.after(() => library.dispose());
  const original = library.instantiate("original", { asset: "hero" });
  const owned = library.inspect().owned;
  const instance = library.instantiate("overridden", {
    asset: "hero",
    material: "vertex-material",
    animation: { clip: "raise" },
  });
  assertOverride(instance, override);
  assert.deepEqual(requests, ["vertex-material"]);
  const skins = meshes(instance),
    originals = meshes(original);
  for (let i = 0; i < skins.length; i++) {
    assert.notEqual(originals[i]!.material, override);
    assert.equal(skins[i]!.geometry, originals[i]!.geometry);
    assert.notEqual(skins[i]!.skeleton, originals[i]!.skeleton);
    assert.notEqual(
      skins[i]!.morphTargetInfluences,
      originals[i]!.morphTargetInfluences,
    );
  }
  assert.equal(library.inspect().owned.materials, owned.materials);
  library.tick(0.5);
  instance.node.updateMatrixWorld(true);
  const vertex = skins[0]!.getVertexPosition(0, new THREE.Vector3());
  assert.ok(Math.abs(vertex.y - 0.5) < 1e-6);
  assert.ok(Math.abs(vertex.z - 0.25) < 1e-6);
  assert.equal(originals[0]!.skeleton.bones[0]!.position.y, 0);
});

test("named material slots replace only matching GLB primitives and reject unresolved slots atomically", async (t) => {
  const replacement = new THREE.MeshStandardMaterial({ color: 0x00ff00 });
  let disposals = 0;
  replacement.addEventListener("dispose", () => disposals++);
  const library = await makeLibrary({ material: (id) => id === "game" ? replacement : undefined });
  t.after(() => { library.dispose(); replacement.dispose(); });
  const original = library.instantiate("original", { asset: "hero" });
  const selected = library.instantiate("selected", {
    asset: "hero", materialSlots: { "asset-red": "game" }, animation: { clip: "raise" },
  });
  const source = meshes(original);
  const result = meshes(selected);
  assert.equal((source[0]!.material as THREE.Material).name, "asset-red");
  assert.equal((source[1]!.material as THREE.Material).name, "asset-blue");
  assert.equal(result[0]!.material, replacement);
  assert.equal(result[1]!.material, source[1]!.material);
  const scene = new THREE.Scene();
  scene.add(selected.node);
  const surfaces = extractSurfaceScene(scene);
  assert.ok(surfaces.materials.some(material => material.uuid === replacement.uuid));
  assert.ok(surfaces.materials.some(material => material.uuid === (source[1]!.material as THREE.Material).uuid));
  assert.notEqual(result[0]!.skeleton, source[0]!.skeleton);
  library.tick(0.5);
  selected.node.updateMatrixWorld(true);
  assert.ok(Math.abs(result[0]!.getVertexPosition(0, new THREE.Vector3()).y - 0.5) < 1e-6);
  const before = library.inspect();
  assert.throws(() => library.instantiate("bad-slot", { asset: "hero", materialSlots: { absent: "game" } }), /TC_MODEL_MATERIAL_SLOT_MISSING.*available loaded material names: "asset-blue", "asset-red"/);
  assert.throws(() => library.instantiate("bad-target", { asset: "hero", materialSlots: { "asset-red": "absent" } }), /TC_MODEL_MATERIAL_MISSING/);
  assert.throws(() => library.instantiate("conflict", { asset: "hero", material: "game", materialSlots: { "asset-red": "game" } }), /TC_MODEL_MATERIAL_CONFLICT/);
  assert.deepEqual(library.inspect(), before);
  selected.dispose();
  assert.equal(disposals, 0);
});

test("named slots replace matching members of material arrays", async (t) => {
  const parse = GLTFLoader.prototype.parseAsync;
  t.mock.method(GLTFLoader.prototype, "parseAsync", async function (this: GLTFLoader, ...args: Parameters<GLTFLoader["parseAsync"]>) {
    const gltf = await parse.apply(this, args);
    const materials: THREE.Material[] = [];
    gltf.scene.traverse(object => { if (object instanceof THREE.Mesh) materials.push(object.material as THREE.Material); });
    gltf.scene.traverse(object => { if (object instanceof THREE.Mesh) object.material = [...materials]; });
    return gltf;
  });
  const replacement = new THREE.MeshStandardMaterial();
  const library = await makeLibrary({ material: () => replacement });
  t.after(() => { library.dispose(); replacement.dispose(); });
  const instance = library.instantiate("array", { asset: "hero", materialSlots: { "asset-blue": "game" } });
  for (const mesh of meshes(instance)) {
    assert.ok(Array.isArray(mesh.material));
    assert.equal(mesh.material[0]!.name, "asset-red");
    assert.equal(mesh.material[1], replacement);
  }
});

test("named slot definitions survive reconciliation and restore without owning replacements", async (t) => {
  const replacement = new THREE.MeshStandardMaterial();
  let disposals = 0;
  replacement.addEventListener("dispose", () => disposals++);
  const library = await makeLibrary({ material: () => replacement });
  t.after(() => { library.dispose(); replacement.dispose(); });
  const definition = { asset: "hero", materialSlots: { "asset-red": "game" } };
  library.register("actor", definition);
  library.reconcile(["actor"]);
  assert.equal(meshes(library.get("actor")!)[0]!.material, replacement);
  const snapshot = library.snapshot();
  library.reconcile([]);
  library.restore(snapshot);
  assert.equal(meshes(library.get("actor")!)[0]!.material, replacement);
  assert.equal((meshes(library.get("actor")!)[1]!.material as THREE.Material).name, "asset-blue");
  assert.equal(disposals, 0);
});

test("named slot definitions are independent of insertion order and locale collation", async (t) => {
  const library = await makeLibrary();
  t.after(() => library.dispose());
  t.mock.method(String.prototype, "localeCompare", () => 0);
  const first = Object.fromEntries([["asset-red", "red"], ["__proto__", "special"], ["asset-blue", "blue"]]);
  const reverse = Object.fromEntries(Object.entries(first).reverse());
  library.register("actor", { asset: "hero", materialSlots: first });
  assert.doesNotThrow(() => library.register("actor", { asset: "hero", materialSlots: reverse }));
  assert.throws(() => library.register("actor", { asset: "hero", materialSlots: { ...reverse, "asset-red": "other" } }), /TC_MODEL_DEFINITION_CONFLICT/);
});

test("missing material slot diagnostics bound names and report omitted entries", async (t) => {
  const replacement = new THREE.MeshStandardMaterial();
  const library = await makeLibrary({ material: () => replacement });
  t.after(() => { library.dispose(); replacement.dispose(); });
  const slots = Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`${String(i).padStart(2, "0")}${"x".repeat(200)}`, "game"]));
  assert.throws(() => library.instantiate("bounded", { asset: "hero", materialSlots: slots }), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /TC_MODEL_MATERIAL_SLOT_MISSING.*and 5 more/);
    assert.match(error.message, /available loaded material names: "asset-blue", "asset-red"/);
    assert.ok(error.message.length < 3000);
    return true;
  });
  assert.equal(library.inspect().instances, 0);
});

test("material arrays replace all slots while template arrays retain their original materials", async (t) => {
  const parse = GLTFLoader.prototype.parseAsync;
  t.mock.method(
    GLTFLoader.prototype,
    "parseAsync",
    async function (
      this: GLTFLoader,
      ...args: Parameters<GLTFLoader["parseAsync"]>
    ) {
      const gltf = await parse.apply(this, args);
      const originals: THREE.Material[] = [];
      gltf.scene.traverse((object) => {
        if ((object as THREE.Mesh).isMesh)
          originals.push((object as THREE.Mesh).material as THREE.Material);
      });
      // Exercise the adapter's array-material branch using actual decoded resources.
      gltf.scene.traverse((object) => {
        if ((object as THREE.Mesh).isMesh)
          (object as THREE.Mesh).material = [...originals];
      });
      return gltf;
    },
  );
  const override = new THREE.MeshStandardNodeMaterial();
  t.after(() => override.dispose());
  const library = await makeLibrary({ material: () => override });
  t.after(() => library.dispose());
  const overridden = library.instantiate("a", {
    asset: "hero",
    material: "all",
  });
  assertOverride(overridden, override);
  for (const mesh of meshes(overridden))
    assert.deepEqual(mesh.material, [override, override]);
  const original = library.instantiate("b", { asset: "hero" });
  for (const mesh of meshes(original)) {
    assert.ok(Array.isArray(mesh.material));
    assert.deepEqual(
      mesh.material.map((material) => material.name),
      ["asset-red", "asset-blue"],
    );
  }
});

test("registration canonicalizes a material definition before the map is filled and retains it across recreation", async (t) => {
  const materials = new Map<string, THREE.Material>();
  const requests: string[] = [];
  const library = await makeLibrary({
    material: (id) => {
      requests.push(id);
      return materials.get(id);
    },
  });
  t.after(() => library.dispose());
  const parent = new THREE.Group();
  const material = {
    kind: "material" as const,
    id: "vertex-material",
    color: "#f00",
  };
  library.register(
    "a",
    { asset: "hero", material, animation: { clip: "raise" } },
    parent,
  );
  material.id = "mutated";
  library.register("a", {
    asset: "hero",
    material: "vertex-material",
    animation: { clip: "raise" },
  });
  assert.deepEqual(requests, []);
  assert.throws(
    () => library.register("a", { asset: "hero", material: "different" }),
    /TC_MODEL_DEFINITION_CONFLICT/,
  );
  const override = new THREE.MeshStandardNodeMaterial();
  t.after(() => override.dispose());
  materials.set("vertex-material", override);
  const first = library.attach("a", parent);
  assertOverride(first, override);
  library.tick(0.4);
  const saved = JSON.parse(JSON.stringify(library.snapshot()));
  first.dispose();
  const [reconciled] = library.reconcile(["a"]);
  assertOverride(reconciled!, override);
  assert.notEqual(reconciled, first);
  library.reconcile([]);
  library.restore(saved);
  const restored = library.get("a")!;
  assertOverride(restored, override);
  assert.equal(restored.node.parent, parent);
  assert.ok(
    Math.abs(meshes(restored)[0]!.skeleton.bones[0]!.position.y - 0.4) < 1e-6,
  );
  assert.deepEqual(requests, [
    "vertex-material",
    "vertex-material",
    "vertex-material",
  ]);

  const cold = await makeLibrary({ material: (id) => materials.get(id) });
  t.after(() => cold.dispose());
  cold.register("a", {
    asset: "hero",
    material: "vertex-material",
    animation: { clip: "raise" },
  });
  cold.restore(saved);
  assertOverride(cold.get("a")!, override);
});

test("invalid override IDs and non-material objects reject before resolution or definition retention", async (t) => {
  let resolutions = 0;
  const library = await makeLibrary({
    material: () => {
      resolutions++;
      return undefined;
    },
  });
  t.after(() => library.dispose());
  for (const material of [
    "",
    "  ",
    null,
    1,
    {},
    { id: "m" },
    { kind: "asset", id: "m" },
    { kind: "material" },
    { kind: "material", id: " " },
    { kind: "material", id: 1 },
  ]) {
    const definition = {
      asset: "hero",
      material,
    } as unknown as ModelDefinition;
    assert.throws(
      () => library.register("bad", definition),
      /TC_MODEL_INVALID_MATERIAL/,
    );
    assert.throws(
      () => library.instantiate("bad", definition),
      /TC_MODEL_INVALID_MATERIAL/,
    );
  }
  assert.equal(resolutions, 0);
  assert.equal(library.inspect().instances, 0);
  assert.equal(library.inspect().definitions, 0);
});

test("missing resolvers and unknown override IDs fail before cloning or retaining an instance", async (t) => {
  const clone = t.mock.method(THREE.Skeleton.prototype, "clone");
  for (const material of [undefined, (_id: string) => undefined]) {
    const library = await makeLibrary({ material });
    t.after(() => library.dispose());
    const owned = library.inspect().owned;
    const parent = new THREE.Group();
    assert.throws(
      () =>
        library.instantiate(
          "missing",
          { asset: "hero", material: "absent" },
          parent,
        ),
      /TC_MODEL_MATERIAL_MISSING: missing: absent/,
    );
    assert.equal(library.get("missing"), undefined);
    assert.equal(library.inspect().instances, 0);
    assert.equal(library.inspect().definitions, 0);
    assert.equal(parent.children.length, 0);
    assert.deepEqual(library.inspect().owned, owned);
  }
  assert.equal(clone.mock.callCount(), 0);
});

test("a throwing resolver allocates no skeletons and the same entity can retry", async (t) => {
  const override = new THREE.MeshStandardNodeMaterial();
  t.after(() => override.dispose());
  const failure = new Error("game material map unavailable");
  let ready = false;
  let resolutions = 0;
  const library = await makeLibrary({
    material: () => {
      resolutions++;
      if (!ready) throw failure;
      return override;
    },
  });
  t.after(() => library.dispose());
  const clone = t.mock.method(THREE.Skeleton.prototype, "clone");
  const definition = { asset: "hero", material: "borrowed" };
  assert.throws(
    () => library.instantiate("retry", definition),
    (error) => error === failure,
  );
  assert.equal(clone.mock.callCount(), 0);
  assert.equal(library.inspect().instances, 0);
  assert.equal(library.inspect().definitions, 0);
  ready = true;
  assertOverride(library.instantiate("retry", definition), override);
  assert.equal(resolutions, 2);
});

test("a missing override rolls back staged reconciliation and restore without retaining cloned skeletons", async (t) => {
  const override = new THREE.MeshStandardNodeMaterial();
  t.after(() => override.dispose());
  const library = await makeLibrary({
    material: (id) => (id === "ready" ? override : undefined),
  });
  t.after(() => library.dispose());
  const parent = new THREE.Group();
  const live = library.instantiate("live", { asset: "hero" }, parent);
  library.register("good", { asset: "hero", material: "ready" }, parent);
  library.register("missing", { asset: "hero", material: "absent" }, parent);
  const before = library.inspect();
  const release = t.mock.method(THREE.Skeleton.prototype, "dispose");
  const saved = {
    format: "pelican.models",
    version: 2,
    animations: ["good", "missing"].map((entity) => ({
      entity,
      asset: "hero",
      currentClip: null,
      actions: [],
    })),
  };
  for (const attempt of [
    () => library.reconcile(["good", "missing"]),
    () => library.restore(saved),
  ]) {
    assert.throws(attempt, /TC_MODEL_MATERIAL_MISSING: missing: absent/);
    assert.deepEqual(library.inspect(), before);
    assert.equal(library.get("live"), live);
    assert.equal(library.get("good"), undefined);
    assert.equal(library.get("missing"), undefined);
    assert.deepEqual(parent.children, [live.node]);
  }
  assert.equal(release.mock.callCount(), meshes(live).length * 2);
});

test("instance and library disposal release template originals and private skeletons but never borrowed overrides or their textures", async (t) => {
  const override = new THREE.MeshStandardNodeMaterial();
  const texture = new THREE.DataTexture(new Uint8Array([255, 0, 0, 255]), 1, 1);
  override.map = texture;
  const library = await makeLibrary({ material: () => override });
  t.after(() => library.dispose());
  const original = library.instantiate("original", { asset: "hero" });
  const originals = new Set(
    meshes(original).map((mesh) => mesh.material as THREE.Material),
  );
  const owned = library.inspect().owned;
  let borrowedDisposals = 0,
    textureDisposals = 0;
  const disposed: THREE.Material[] = [];
  override.addEventListener("dispose", () => borrowedDisposals++);
  texture.addEventListener("dispose", () => textureDisposals++);
  for (const material of originals)
    material.addEventListener("dispose", () => disposed.push(material));
  const instance = library.instantiate("override", {
    asset: "hero",
    material: "borrowed",
  });
  const skins = meshes(instance);
  let skeletonDisposals = 0;
  for (const skin of skins) {
    skin.skeleton.computeBoneTexture();
    skin.skeleton.boneTexture!.addEventListener(
      "dispose",
      () => skeletonDisposals++,
    );
  }
  instance.dispose();
  instance.dispose();
  assert.equal(skeletonDisposals, skins.length);
  assert.equal(borrowedDisposals, 0);
  assert.equal(textureDisposals, 0);
  assert.equal(disposed.length, 0);
  assert.equal(library.inspect().owned.materials, owned.materials);
  // Also exercise a live override during whole-library cleanup.
  library.instantiate("live-override", { asset: "hero", material: "borrowed" });
  original.dispose();
  await library.dispose();
  await library.dispose();
  assert.equal(disposed.length, originals.size);
  assert.equal(new Set(disposed).size, originals.size);
  assert.equal(borrowedDisposals, 0);
  assert.equal(textureDisposals, 0);
  assert.equal(library.inspect().instances, 0);
  assert.equal(library.inspect().definitions, 0);
  assert.deepEqual(library.inspect().owned, {
    geometries: 0,
    materials: 0,
    textures: 0,
    skeletons: 0,
  });
  // The game-content owner remains responsible for these resources.
  override.dispose();
  texture.dispose();
  assert.equal(borrowedDisposals, 1);
  assert.equal(textureDisposals, 1);
});
