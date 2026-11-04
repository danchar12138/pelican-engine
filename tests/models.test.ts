import test from "node:test";
import assert from "node:assert/strict";
import { Accessor, Document, NodeIO } from "@gltf-transform/core";
import * as THREE from "three/webgpu";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { extractTriangles } from "../packages/renderer/src/geometry.ts";
import { createModelLibrary } from "../packages/renderer/src/models.ts";

async function animatedGLB(): Promise<ArrayBuffer> {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const position = doc
    .createAccessor("position", buffer)
    .setType(Accessor.Type.VEC3)
    .setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]));
  const joints = doc
    .createAccessor("joints", buffer)
    .setType(Accessor.Type.VEC4)
    .setArray(new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]));
  const weights = doc
    .createAccessor("weights", buffer)
    .setType(Accessor.Type.VEC4)
    .setArray(new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]));
  const mesh = doc
    .createMesh("triangle")
    .addPrimitive(
      doc
        .createPrimitive()
        .setAttribute("POSITION", position)
        .setAttribute("JOINTS_0", joints)
        .setAttribute("WEIGHTS_0", weights),
    );
  const scene = doc.createScene("scene");
  const bone = doc.createNode("animated-bone");
  const skin = doc.createSkin("skin").addJoint(bone);
  scene.addChild(bone);
  scene.addChild(doc.createNode("skin-mesh").setMesh(mesh).setSkin(skin));
  const times = doc
    .createAccessor("times", buffer)
    .setType(Accessor.Type.SCALAR)
    .setArray(new Float32Array([0, 1]));
  const translations = doc
    .createAccessor("translations", buffer)
    .setType(Accessor.Type.VEC3)
    .setArray(new Float32Array([0, 0, 0, 0, 1, 0]));
  const sampler = doc
    .createAnimationSampler("move")
    .setInput(times)
    .setOutput(translations)
    .setInterpolation("LINEAR");
  const channel = doc
    .createAnimationChannel("move-bone")
    .setTargetNode(bone)
    .setTargetPath("translation")
    .setSampler(sampler);
  doc.createAnimation("raise").addSampler(sampler).addChannel(channel);
  const down = doc
    .createAccessor("down", buffer)
    .setType(Accessor.Type.VEC3)
    .setArray(new Float32Array([0, 1, 0, 0, 0, 0]));
  const downSampler = doc
    .createAnimationSampler("lower")
    .setInput(times)
    .setOutput(down)
    .setInterpolation("LINEAR");
  const downChannel = doc
    .createAnimationChannel("lower-bone")
    .setTargetNode(bone)
    .setTargetPath("translation")
    .setSampler(downSampler);
  doc.createAnimation("lower").addSampler(downSampler).addChannel(downChannel);
  doc.getRoot().setDefaultScene(scene);
  const bytes = await new NodeIO().writeBinary(doc);
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

function fixtureFetch(bytes: ArrayBuffer) {
  let requests = 0;
  const fetcher: typeof fetch = async (_input, init) => {
    requests++;
    if (init?.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    return new Response(bytes.slice(0), { status: 200 });
  };
  return { fetcher, requests: () => requests };
}

test("loads a real animated GLB once and creates isolated skeletal instances", async () => {
  const bytes = await animatedGLB();
  const fetch = fixtureFetch(bytes);
  const library = createModelLibrary(
    { hero: "file:///models/hero.glb" },
    { fetch: fetch.fetcher },
  );
  await library.prepare();
  assert.equal(fetch.requests(), 1);
  const parent = new THREE.Group();
  const first = library.instantiate(
    "hero-a",
    { asset: "hero", scale: 2 },
    parent,
  );
  const second = library.instantiate("hero-b", { asset: "hero" }, parent);
  const firstSkin = first.node.getObjectByName(
    "skin-mesh",
  ) as THREE.SkinnedMesh;
  const secondSkin = second.node.getObjectByName(
    "skin-mesh",
  ) as THREE.SkinnedMesh;
  assert.ok(firstSkin.isSkinnedMesh && secondSkin.isSkinnedMesh);
  assert.notEqual(firstSkin.skeleton, secondSkin.skeleton);
  assert.notEqual(firstSkin.skeleton.bones[0], secondSkin.skeleton.bones[0]);
  assert.equal(firstSkin.geometry, secondSkin.geometry);
  assert.equal(firstSkin.material, secondSkin.material);
  library.animation.play("hero-a", "raise", { speed: 1.5, loop: false });
  library.tick(0.4);
  const firstBone = first.node.getObjectByName("animated-bone")!;
  const secondBone = second.node.getObjectByName("animated-bone")!;
  assert.ok(firstBone.position.y > 0.5);
  assert.equal(secondBone.position.y, 0);
  assert.equal(library.animation.state("hero-a").clip, "raise");
  assert.ok(Math.abs(library.animation.state("hero-a").time - 0.6) < 1e-6);
  const snapshot = library.snapshot();
  library.tick(0.2);
  library.restore(snapshot);
  assert.ok(Math.abs(firstBone.position.y - 0.6) < 1e-5);
  assert.ok(Math.abs(library.animation.state("hero-a").time - 0.6) < 1e-6);
  assert.throws(
    () => library.animation.play("hero-a", "missing"),
    /TC_MODEL_CLIP_MISSING.*available: raise/,
  );
  assert.throws(
    () => library.instantiate("hero-a", { asset: "hero" }),
    /TC_MODEL_ENTITY_DUPLICATE/,
  );
  assert.deepEqual(library.inspect().templates[0]?.animations, [
    "raise",
    "lower",
  ]);
  assert.equal(library.inspect().instances, 2);
  library.remove("hero-a");
  assert.equal(library.inspect().instances, 1);
  assert.equal(secondSkin.geometry.getAttribute("position").count, 3);
  await library.dispose();
  assert.equal(library.inspect().disposed, true);
});

test("snapshots and restores an in-progress crossfade pose", async () => {
  const bytes = await animatedGLB();
  const { fetcher } = fixtureFetch(bytes);
  const library = createModelLibrary(
    { hero: "hero.glb" },
    { fetch: fetcher, baseURL: "https://assets.test/" },
  );
  await library.prepare();
  const instance = library.instantiate("hero", { asset: "hero" });
  library.animation.play("hero", "raise");
  library.tick(0.2);
  library.animation.play("hero", "lower", { fade: 0.8 });
  library.tick(0.2);
  const saved = library.snapshot();
  assert.equal(saved.animations[0]?.actions.length, 2);
  const bone = instance.node.getObjectByName("animated-bone")!;
  const expectedY = bone.position.y;
  close(expectedY, 0.5);
  library.tick(0.2);
  library.restore(saved);
  assert.ok(Math.abs(bone.position.y - expectedY) < 1e-5);
  assert.equal(library.animation.state("hero").clip, "lower");
  const deltas = [0.1, 0.2, 0.31, 0.3];
  const trajectory = () =>
    deltas.map((dt) => {
      library.tick(dt);
      return {
        y: bone.position.y,
        state: library.animation.state("hero"),
        actions: library.snapshot().animations[0]!.actions.length,
      };
    });
  const uninterrupted = trajectory();
  uninterrupted.forEach((sample, i) =>
    close(sample.y, [0.575, 0.575, 0.19, 0.89][i]!),
  );
  library.restore(JSON.parse(JSON.stringify(saved)));
  const restored = trajectory();
  for (let i = 0; i < deltas.length; i++) {
    close(restored[i]!.y, uninterrupted[i]!.y);
    close(restored[i]!.state.time, uninterrupted[i]!.state.time);
    assert.equal(restored[i]!.state.playing, uninterrupted[i]!.state.playing);
    assert.equal(restored[i]!.actions, uninterrupted[i]!.actions);
  }
  assert.equal(restored.at(-1)!.actions, 1);
  await library.dispose();
});

test("validates snapshots before mutation and supports deterministic repeated restore", async () => {
  const bytes = await animatedGLB();
  const { fetcher } = fixtureFetch(bytes);
  const library = createModelLibrary(
    { hero: "hero.glb" },
    { fetch: fetcher, baseURL: "https://assets.test/game/" },
  );
  await library.prepare();
  const instance = library.instantiate("hero", { asset: "hero" });
  library.animation.play("hero", "raise");
  library.tick(0.25);
  const saved = library.snapshot();
  library.tick(0.25);
  const current = library.animation.state("hero").time;
  assert.throws(
    () =>
      library.restore({
        ...saved,
        animations: [
          {
            ...saved.animations[0]!,
            actions: [{ ...saved.animations[0]!.actions[0]!, time: NaN }],
          },
        ],
      }),
    /TC_MODEL_INVALID_SNAPSHOT/,
  );
  assert.equal(library.animation.state("hero").time, current);
  library.restore(saved);
  const once = instance.node.getObjectByName("animated-bone")!.position.y;
  library.tick(0.25);
  library.restore(saved);
  const twice = instance.node.getObjectByName("animated-bone")!.position.y;
  assert.equal(once, twice);
  await library.dispose();
});

test("aborts pending fetch when the library is disposed", async () => {
  let aborted = false;
  const fetcher: typeof fetch = (_input, init) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener(
        "abort",
        () => {
          aborted = true;
          reject(new DOMException("Aborted", "AbortError"));
        },
        { once: true },
      );
    });
  const library = createModelLibrary(
    { hero: "hero.glb" },
    { fetch: fetcher, baseURL: "https://assets.test/" },
  );
  const preparing = library.prepare();
  await new Promise((resolve) => setImmediate(resolve));
  await library.dispose();
  await assert.rejects(preparing, /TC_MODEL_CANCELLED/);
  assert.equal(aborted, true);
});

test("rejects malformed time and unknown assets with stable diagnostics", async () => {
  const library = createModelLibrary({});
  assert.throws(() => library.tick(Number.NaN), /TC_MODEL_INVALID_DT/);
  await assert.rejects(library.prepare(["unknown"]), /TC_MODEL_ASSET_UNKNOWN/);
  await library.dispose();
});

function close(actual: number, expected: number, epsilon = 1e-6): void {
  assert.ok(
    Math.abs(actual - expected) < epsilon,
    `expected ${actual} to be close to ${expected}`,
  );
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

// Repack fixture JSON without changing its binary data or mutating source assets.
function editGLB(
  bytes: ArrayBuffer,
  edit: (json: Record<string, any>) => void,
): ArrayBuffer {
  const view = new DataView(bytes);
  const jsonLength = view.getUint32(12, true);
  const json = JSON.parse(
    new TextDecoder().decode(new Uint8Array(bytes, 20, jsonLength)),
  );
  edit(json);
  const encoded = new TextEncoder().encode(JSON.stringify(json));
  const padded = Math.ceil(encoded.length / 4) * 4;
  const tail = new Uint8Array(bytes, 20 + jsonLength);
  const result = new ArrayBuffer(20 + padded + tail.length);
  const output = new DataView(result);
  output.setUint32(0, 0x46546c67, true);
  output.setUint32(4, 2, true);
  output.setUint32(8, result.byteLength, true);
  output.setUint32(12, padded, true);
  output.setUint32(16, 0x4e4f534a, true);
  new Uint8Array(result, 20, padded).fill(32);
  new Uint8Array(result, 20, encoded.length).set(encoded);
  new Uint8Array(result, 20 + padded).set(tail);
  return result;
}

for (const cancelled of [0, 1]) {
  test(
    `cancelling shared prepare caller ${cancelled + 1} rejects promptly and preserves the other caller`,
    { timeout: 5000 },
    async (t) => {
      const bytes = await animatedGLB();
      const response = deferred<Response>();
      let calls = 0;
      let sharedSignal: AbortSignal | null | undefined;
      const fetcher: typeof fetch = async (_input, init) => {
        calls++;
        sharedSignal = init?.signal;
        return response.promise;
      };
      const library = createModelLibrary(
        { hero: "hero.glb" },
        { fetch: fetcher },
      );
      t.after(() => library.dispose());
      const controllers = [new AbortController(), new AbortController()];
      const preparing = controllers.map((c) =>
        library.prepare(["hero"], { signal: c.signal }),
      );
      const rejected = assert.rejects(
        preparing[cancelled]!,
        /TC_MODEL_CANCELLED/,
      );
      await turn();
      controllers[cancelled]!.abort();
      await rejected;
      assert.equal(calls, 1);
      assert.equal(sharedSignal?.aborted, false);
      response.resolve(new Response(bytes));
      await preparing[1 - cancelled];
      library.instantiate("hero", { asset: "hero" });
      await library.prepare(["hero", "hero"]);
      assert.equal(calls, 1);
    },
  );
}

test(
  "all callers can cancel a non-cooperating fetch and retry while its stale result is still pending",
  { timeout: 5000 },
  async (t) => {
    const bytes = await animatedGLB();
    const old = deferred<Response>();
    const signals: AbortSignal[] = [];
    let calls = 0;
    const library = createModelLibrary(
      { hero: "hero.glb" },
      {
        fetch: async (_input, init) => {
          signals.push(init!.signal!);
          return ++calls === 1 ? old.promise : new Response(bytes.slice(0));
        },
      },
    );
    t.after(() => library.dispose());
    const a = new AbortController(),
      b = new AbortController();
    const pa = library.prepare(["hero"], { signal: a.signal });
    const pb = library.prepare(["hero"], { signal: b.signal });
    const rejectedA = assert.rejects(pa, /TC_MODEL_CANCELLED/);
    const rejectedB = assert.rejects(pb, /TC_MODEL_CANCELLED/);
    await turn();
    a.abort();
    b.abort();
    await Promise.all([rejectedA, rejectedB]);
    assert.equal(signals[0]!.aborted, true);
    await library.prepare();
    assert.equal(calls, 2);
    old.resolve(new Response(bytes.slice(0)));
    await turn();
    await library.prepare();
    assert.equal(calls, 2);
    assert.equal(library.inspect().templates.length, 1);
  },
);

test("pre-aborted prepare never fetches or registers new assets, including cached and empty requests", async (t) => {
  const bytes = await animatedGLB();
  const fixture = fixtureFetch(bytes);
  const library = createModelLibrary(
    { hero: "hero.glb" },
    { fetch: fixture.fetcher },
  );
  t.after(() => library.dispose());
  const signal = AbortSignal.abort();
  await assert.rejects(
    library.prepare([{ id: "new", path: "new.glb" }], { signal }),
    /TC_MODEL_CANCELLED/,
  );
  await assert.rejects(library.prepare(["new"]), /TC_MODEL_ASSET_UNKNOWN/);
  await assert.rejects(library.prepare([], { signal }), /TC_MODEL_CANCELLED/);
  assert.equal(fixture.requests(), 0);
  await library.prepare();
  await assert.rejects(
    library.prepare(["hero"], { signal }),
    /TC_MODEL_CANCELLED/,
  );
  assert.equal(fixture.requests(), 1);
});

test("prepare validates registrations atomically before starting any loads", async (t) => {
  const fixture = fixtureFetch(await animatedGLB());
  const library = createModelLibrary(
    { hero: "hero.glb" },
    { fetch: fixture.fetcher },
  );
  t.after(() => library.dispose());
  await assert.rejects(
    library.prepare([{ id: "new", path: "new.glb" }, "unknown"]),
    /TC_MODEL_ASSET_UNKNOWN/,
  );
  await assert.rejects(library.prepare(["new"]), /TC_MODEL_ASSET_UNKNOWN/);
  await assert.rejects(
    library.prepare([{ id: "hero", path: "other.glb" }]),
    /TC_MODEL_ASSET_CONFLICT/,
  );
  await assert.rejects(library.prepare([""]), /TC_MODEL_INVALID_ASSET/);
  assert.equal(fixture.requests(), 0);
});

test("HTTP and decode failures do not poison the cache and concurrent retry loads once", async (t) => {
  const bytes = await animatedGLB();
  let calls = 0;
  const library = createModelLibrary(
    { hero: "hero.glb" },
    {
      fetch: async () => {
        calls++;
        if (calls === 1) return new Response("unavailable", { status: 503 });
        if (calls === 2) return new Response(new Uint8Array([1, 2, 3]));
        return new Response(bytes.slice(0));
      },
    },
  );
  t.after(() => library.dispose());
  await assert.rejects(
    library.prepare(),
    /TC_MODEL_LOAD_FAILED: hero: HTTP 503/,
  );
  await assert.rejects(library.prepare(), /TC_MODEL_LOAD_FAILED: hero:/);
  assert.equal(library.inspect().templates.length, 0);
  await Promise.all([library.prepare(), library.prepare()]);
  assert.equal(calls, 3);
  library.instantiate("hero", { asset: "hero" });
});

test("duplicate clip names release a fully decoded GLB and allow a successful retry", async (t) => {
  const bytes = await animatedGLB();
  const duplicate = editGLB(bytes, (json) => {
    json.animations[1].name = "raise";
  });
  const releasedGeometry: THREE.BufferGeometry[] = [];
  const releasedMaterials: THREE.Material[] = [];
  const releasedSkeletons: THREE.Skeleton[] = [];
  t.mock.method(
    THREE.BufferGeometry.prototype,
    "dispose",
    function (this: THREE.BufferGeometry) {
      releasedGeometry.push(this);
    },
  );
  t.mock.method(
    THREE.Material.prototype,
    "dispose",
    function (this: THREE.Material) {
      releasedMaterials.push(this);
    },
  );
  t.mock.method(
    THREE.Skeleton.prototype,
    "dispose",
    function (this: THREE.Skeleton) {
      releasedSkeletons.push(this);
    },
  );
  let calls = 0;
  const library = createModelLibrary(
    { hero: "hero.glb" },
    { fetch: async () => new Response(++calls === 1 ? duplicate : bytes) },
  );
  t.after(() => library.dispose());
  await assert.rejects(
    library.prepare(),
    /TC_MODEL_LOAD_FAILED: hero: TC_MODEL_CLIP_DUPLICATE: raise/,
  );
  assert.ok(releasedGeometry.length > 0);
  assert.ok(releasedMaterials.length > 0);
  assert.ok(releasedSkeletons.length > 0);
  for (const list of [releasedGeometry, releasedMaterials, releasedSkeletons])
    assert.equal(new Set<unknown>(list).size, list.length);
  assert.deepEqual(library.inspect().owned, {
    geometries: 0,
    materials: 0,
    textures: 0,
    skeletons: 0,
  });
  await library.prepare();
  const count = releasedGeometry.length;
  const instance = library.instantiate("hero", { asset: "hero" });
  instance.dispose();
  assert.equal(releasedGeometry.length, count);
  await library.dispose();
  assert.ok(releasedGeometry.length > count);
});

test("removing instances releases each private skeleton once and library disposal owns all scenes", async (t) => {
  const bytes = editGLB(await animatedGLB(), (json) => {
    json.materials = [
      { pbrMetallicRoughness: { baseColorFactor: [1, 0, 0, 1] } },
    ];
    json.meshes.push({
      primitives: [
        {
          attributes: {
            POSITION: json.meshes[0].primitives[0].attributes.POSITION,
          },
          material: 0,
        },
      ],
    });
    json.nodes.push({ name: "other-scene-mesh", mesh: 1 });
    json.scenes.push({ nodes: [json.nodes.length - 1] });
  });
  const geometries: THREE.BufferGeometry[] = [],
    materials: THREE.Material[] = [],
    skeletons: THREE.Skeleton[] = [];
  t.mock.method(
    THREE.BufferGeometry.prototype,
    "dispose",
    function (this: THREE.BufferGeometry) {
      geometries.push(this);
    },
  );
  t.mock.method(
    THREE.Material.prototype,
    "dispose",
    function (this: THREE.Material) {
      materials.push(this);
    },
  );
  t.mock.method(
    THREE.Skeleton.prototype,
    "dispose",
    function (this: THREE.Skeleton) {
      skeletons.push(this);
    },
  );
  const library = createModelLibrary(
    { hero: "hero.glb" },
    { fetch: fixtureFetch(bytes).fetcher },
  );
  t.after(() => library.dispose());
  await library.prepare();
  const owned = library.inspect().owned;
  assert.equal(owned.geometries, 2);
  assert.ok(owned.materials >= 2);
  const parent = new THREE.Group();
  const first = library.instantiate("a", { asset: "hero" }, parent);
  library.instantiate("b", { asset: "hero" }, parent);
  first.dispose();
  first.dispose();
  assert.equal(skeletons.length, 1);
  assert.equal(geometries.length, 0);
  assert.equal(materials.length, 0);
  assert.equal(parent.children.length, 1);
  const replacement = library.instantiate("a", { asset: "hero" }, parent);
  first.dispose();
  assert.equal(
    library.inspect().instances,
    2,
    "stale handle must not dispose a replacement entity",
  );
  replacement.dispose();
  await Promise.all([library.dispose(), library.dispose()]);
  assert.equal(parent.children.length, 0);
  assert.equal(geometries.length, owned.geometries);
  assert.equal(materials.length, owned.materials);
  assert.equal(skeletons.length, owned.skeletons + 3);
  for (const list of [geometries, materials, skeletons])
    assert.equal(new Set<unknown>(list).size, list.length);
  assert.deepEqual(library.inspect().owned, {
    geometries: 0,
    materials: 0,
    textures: 0,
    skeletons: 0,
  });
});

test(
  "dispose drains a cancelled decode, releases its late resources, and every dispose caller waits",
  { timeout: 5000 },
  async (t) => {
    const bytes = await animatedGLB();
    const decoded = deferred<void>(),
      release = deferred<void>();
    const parse = GLTFLoader.prototype.parseAsync;
    let geometry: THREE.BufferGeometry | undefined;
    let disposed = 0;
    t.mock.method(
      GLTFLoader.prototype,
      "parseAsync",
      async function (this: GLTFLoader, ...args: Parameters<typeof parse>) {
        const result = await parse.apply(this, args);
        result.scene.traverse((object) => {
          if ((object as THREE.Mesh).isMesh)
            geometry = (object as THREE.Mesh).geometry;
        });
        geometry!.addEventListener("dispose", () => disposed++);
        decoded.resolve();
        await release.promise;
        return result;
      },
    );
    const library = createModelLibrary(
      { hero: "hero.glb" },
      { fetch: fixtureFetch(bytes).fetcher },
    );
    t.after(() => library.dispose());
    const controller = new AbortController();
    const preparing = library.prepare(undefined, { signal: controller.signal });
    const rejected = assert.rejects(preparing, /TC_MODEL_CANCELLED/);
    await decoded.promise;
    controller.abort();
    await rejected;
    let finished = false;
    const one = library.dispose().then(() => {
      finished = true;
    });
    const two = library.dispose();
    await turn();
    assert.equal(finished, false);
    assert.equal(disposed, 0);
    release.resolve();
    await Promise.all([one, two]);
    assert.equal(disposed, 1);
    assert.equal(library.inspect().templates.length, 0);
  },
);

test("offset, XYZ rotation in radians, and scale compose on the wrapper and affect traced skinned vertices", async (t) => {
  const library = createModelLibrary(
    { hero: "hero.glb" },
    { fetch: fixtureFetch(await animatedGLB()).fetcher },
  );
  t.after(() => library.dispose());
  await library.prepare();
  const scene = new THREE.Scene();
  const instance = library.instantiate(
    "hero",
    {
      asset: "hero",
      scale: 2,
      offset: [3, 4, 5],
      rotation: [0, 0, Math.PI / 2],
    },
    scene,
  );
  library.animation.play("hero", "raise");
  library.tick(0.25);
  close(instance.node.getObjectByName("animated-bone")!.position.y, 0.25);
  const triangles = extractTriangles(scene);
  assert.equal(triangles.length, 1);
  const expected = [
    [2.5, 4, 5],
    [2.5, 6, 5],
    [0.5, 4, 5],
  ];
  [triangles[0]!.a, triangles[0]!.b, triangles[0]!.c].forEach((point, i) =>
    point.forEach((value, k) => close(value, expected[i]![k]!)),
  );
});

test("invalid transforms and initial animation fail without attaching an instance", async (t) => {
  const library = createModelLibrary(
    { hero: "hero.glb" },
    { fetch: fixtureFetch(await animatedGLB()).fetcher },
  );
  t.after(() => library.dispose());
  await library.prepare();
  const parent = new THREE.Group();
  const definitions = [
    { asset: "hero", scale: 0 },
    { asset: "hero", offset: [0, NaN, 0] as const },
    { asset: "hero", rotation: [0, 0, Infinity] as const },
    { asset: "hero", animation: { clip: "missing" } },
    { asset: "hero", animation: { clip: "raise", speed: NaN } },
  ];
  const before = library.inspect().owned;
  for (const definition of definitions) {
    assert.throws(
      () => library.instantiate("hero", definition, parent),
      /TC_MODEL_/,
    );
    assert.equal(parent.children.length, 0);
    assert.equal(library.inspect().instances, 0);
    assert.deepEqual(library.inspect().owned, before);
  }
  library.instantiate(
    "hero",
    { asset: "hero", animation: { clip: "raise" } },
    parent,
  );
  library.tick(0.25);
  close(library.animation.state("hero").time, 0.25);
});

test("clip time follows speed, repeat wrapping, reverse, zero speed, and clamped LoopOnce across restore", async (t) => {
  const library = createModelLibrary(
    { hero: "hero.glb" },
    { fetch: fixtureFetch(await animatedGLB()).fetcher },
  );
  t.after(() => library.dispose());
  await library.prepare();
  const instance = library.instantiate("hero", { asset: "hero" });
  const bone = instance.node.getObjectByName("animated-bone")!;
  library.animation.play("hero", "raise", { speed: 2 });
  library.tick(0.625);
  close(library.animation.state("hero").time, 0.25);
  close(bone.position.y, 0.25);
  library.animation.play("hero", "raise", { speed: -1 });
  library.tick(0.25);
  close(library.animation.state("hero").time, 0.75);
  const reverse = library.snapshot();
  library.tick(0.1);
  const expected = bone.position.y;
  library.restore(reverse);
  library.tick(0.1);
  close(bone.position.y, expected);
  library.animation.play("hero", "raise", { speed: 0 });
  library.tick(5);
  assert.equal(library.animation.state("hero").playing, false);
  const stopped = library.snapshot();
  library.restore(stopped);
  library.tick(5);
  close(bone.position.y, 0);
  library.animation.play("hero", "raise", { loop: false, speed: 1.5 });
  library.tick(2);
  assert.deepEqual(library.animation.state("hero"), {
    clip: "raise",
    time: 1,
    playing: false,
  });
  close(bone.position.y, 1);
  const end = library.snapshot();
  library.animation.play("hero", "lower");
  library.tick(0.2);
  library.restore(end);
  library.tick(5);
  close(bone.position.y, 1);
  assert.equal(library.animation.state("hero").playing, false);
});

test("interrupted fades and replayed clips reset weights and remain deterministic after JSON restore", async (t) => {
  const library = createModelLibrary(
    { hero: "hero.glb" },
    { fetch: fixtureFetch(await animatedGLB()).fetcher },
  );
  t.after(() => library.dispose());
  await library.prepare();
  const bone = library
    .instantiate("hero", { asset: "hero" })
    .node.getObjectByName("animated-bone")!;
  library.animation.play("hero", "raise", { fade: 1 });
  library.tick(0.3);
  library.animation.play("hero", "lower", { fade: 1 });
  library.tick(0.25);
  library.animation.play("hero", "raise", { fade: 0.5 });
  library.tick(0.1);
  const saved = JSON.parse(JSON.stringify(library.snapshot()));
  library.tick(0.3);
  const expected = bone.position.y;
  library.restore(saved);
  library.tick(0.3);
  close(bone.position.y, expected);
  library.tick(0.3);
  assert.equal(library.snapshot().animations[0]!.actions.length, 1);
  library.animation.play("hero", "lower");
  library.tick(0.2);
  close(bone.position.y, 0.8);
  library.animation.play("hero", "raise");
  library.tick(0.2);
  close(bone.position.y, 0.2);
  assert.equal(library.snapshot().animations[0]!.actions[0]!.weight, 1);
});

test("malformed snapshots reject every entity atomically, including fade state and unknown definitions", async (t) => {
  const library = createModelLibrary(
    { hero: "hero.glb" },
    { fetch: fixtureFetch(await animatedGLB()).fetcher },
  );
  t.after(() => library.dispose());
  await library.prepare();
  const a = library.instantiate("a", { asset: "hero" });
  const b = library.instantiate("b", { asset: "hero" });
  for (const id of ["a", "b"]) library.animation.play(id, "raise");
  library.tick(0.2);
  for (const id of ["a", "b"])
    library.animation.play(id, "lower", { fade: 0.8 });
  library.tick(0.2);
  const saved = library.snapshot();
  library.tick(0.1);
  const current = library.snapshot();
  const pose = [a, b].map(
    (i) => i.node.getObjectByName("animated-bone")!.position.y,
  );
  const edits: ((s: any) => void)[] = [
    (s) => {
      s.version = 1;
    },
    (s) => {
      s.animations[1].entity = "a";
    },
    (s) => {
      s.animations[1].entity = "missing";
    },
    (s) => {
      s.animations[1].asset = "other";
    },
    (s) => {
      s.animations[1].currentClip = "missing";
    },
    (s) => {
      s.animations[1].currentClip = null;
    },
    (s) => {
      s.animations[1].actions.push(s.animations[1].actions[0]);
    },
    (s) => {
      s.animations[1].actions[0].time = NaN;
    },
    (s) => {
      s.animations[1].actions[0].time = 2;
    },
    (s) => {
      s.animations[1].actions[0].speed = Infinity;
    },
    (s) => {
      s.animations[1].actions[0].playing = "yes";
    },
    (s) => {
      s.animations[1].actions[0].paused = true;
    },
    (s) => {
      s.animations[1].actions[0].weight = -1;
    },
    (s) => {
      s.animations[1].actions[0].fade = null;
    },
    (s) => {
      s.animations[1].actions[0].fade.duration = 0;
    },
    (s) => {
      s.animations[1].actions[0].fade.elapsed = -1;
    },
    (s) => {
      s.animations[1].actions[0].fade.elapsed = 0.8;
    },
    (s) => {
      s.animations[1].actions[0].fade.from = NaN;
    },
    (s) => {
      s.animations[1].actions[0].fade.to = 1;
    },
    (s) => {
      s.animations[1].actions[0].fade.elapsed = 0.3;
    },
  ];
  for (const edit of edits) {
    const broken = structuredClone(saved);
    edit(broken);
    assert.throws(() => library.restore(broken), /TC_MODEL_INVALID_SNAPSHOT/);
    assert.deepEqual(library.snapshot(), current);
    assert.deepEqual(
      [a, b].map((i) => i.node.getObjectByName("animated-bone")!.position.y),
      pose,
    );
  }
  const validated = library.validateSnapshot(saved);
  validated.animations[0]!.actions[0]!.fade!.elapsed = 0;
  assert.equal(saved.animations[0]!.actions[0]!.fade!.elapsed, 0.2);
});

test("unnamed clips receive loader names, while required extensions and external resources reject explicitly", async (t) => {
  const bytes = await animatedGLB();
  const unnamed = editGLB(bytes, (json) => {
    delete json.animations[0].name;
  });
  const library = createModelLibrary(
    { hero: "hero.glb" },
    { fetch: fixtureFetch(unnamed).fetcher },
  );
  t.after(() => library.dispose());
  await library.prepare();
  library.instantiate("hero", { asset: "hero" });
  library.animation.play("hero", "animation_0");
  assert.throws(
    () => library.animation.play("hero", "Raise"),
    /TC_MODEL_CLIP_MISSING.*animation_0, lower/,
  );
  for (const [edit, diagnostic] of [
    [
      (json: any) => {
        json.extensionsUsed = ["UNKNOWN_required"];
        json.extensionsRequired = ["UNKNOWN_required"];
      },
      /TC_MODEL_EXTENSION_UNSUPPORTED/,
    ],
    [
      (json: any) => {
        json.buffers[0].uri = "external.bin";
      },
      /TC_MODEL_EXTERNAL_URI_UNSUPPORTED/,
    ],
  ] as const) {
    const bad = createModelLibrary(
      { hero: "hero.glb" },
      { fetch: fixtureFetch(editGLB(bytes, edit)).fetcher },
    );
    try {
      await assert.rejects(bad.prepare(), diagnostic);
      assert.equal(bad.inspect().templates.length, 0);
    } finally {
      await bad.dispose();
    }
  }
});

test("disposed libraries reject operations consistently and instance handles remain idempotent", async () => {
  const library = createModelLibrary(
    { hero: "hero.glb" },
    { fetch: fixtureFetch(await animatedGLB()).fetcher },
  );
  await library.prepare();
  const instance = library.instantiate("hero", { asset: "hero" });
  const saved = library.snapshot();
  await library.dispose();
  instance.dispose();
  library.remove("hero");
  await assert.rejects(library.prepare(), /TC_MODEL_LIBRARY_DISPOSED/);
  for (const operation of [
    () => library.tick(0),
    () => library.snapshot(),
    () => library.restore(saved),
    () => library.animation.play("hero", "raise"),
    () => library.animation.state("hero"),
    () => library.instantiate("hero", { asset: "hero" }),
  ])
    assert.throws(operation, /TC_MODEL_LIBRARY_DISPOSED/);
});

test("a parse failure drains independently decoded sibling resources before rejecting", async (t) => {
  const bad = editGLB(await animatedGLB(), (json) => {
    json.animations[0].samplers[0].output = 999;
  });
  const disposed: THREE.BufferGeometry[] = [];
  t.mock.method(
    THREE.BufferGeometry.prototype,
    "dispose",
    function (this: THREE.BufferGeometry) {
      disposed.push(this);
    },
  );
  const library = createModelLibrary(
    { hero: "hero.glb" },
    { fetch: fixtureFetch(bad).fetcher },
  );
  t.after(() => library.dispose());
  await assert.rejects(library.prepare(), /TC_MODEL_LOAD_FAILED/);
  assert.ok(
    disposed.length > 0,
    "a sibling mesh decoded even though the animation failed",
  );
  const count = disposed.length;
  await turn();
  assert.equal(
    disposed.length,
    count,
    "prepare failure includes draining and releasing sibling work",
  );
  assert.deepEqual(library.inspect().owned, {
    geometries: 0,
    materials: 0,
    textures: 0,
    skeletons: 0,
  });
});

test("morph influences are private while geometry, bind inverses, and materials stay shared", async (t) => {
  const bytes = editGLB(await animatedGLB(), (json) => {
    const primitive = json.meshes[0].primitives[0];
    primitive.targets = [{ POSITION: primitive.attributes.POSITION }];
    json.meshes[0].weights = [0];
  });
  const library = createModelLibrary(
    { hero: "hero.glb" },
    { fetch: fixtureFetch(bytes).fetcher },
  );
  t.after(() => library.dispose());
  await library.prepare();
  const a = library
    .instantiate("a", { asset: "hero" })
    .node.getObjectByName("skin-mesh") as THREE.SkinnedMesh;
  const b = library
    .instantiate("b", { asset: "hero" })
    .node.getObjectByName("skin-mesh") as THREE.SkinnedMesh;
  assert.notEqual(a.morphTargetInfluences, b.morphTargetInfluences);
  assert.equal(a.geometry, b.geometry);
  assert.equal(a.material, b.material);
  const bind = b.skeleton.boneInverses[0]!.toArray();
  a.morphTargetInfluences![0] = 0.75;
  a.skeleton.bones[0]!.position.y = 2;
  assert.equal(b.morphTargetInfluences![0], 0);
  assert.equal(b.skeleton.bones[0]!.position.y, 0);
  assert.deepEqual(b.skeleton.boneInverses[0]!.toArray(), bind);
});

// Opt in because this probe needs a locally installed Playwright Chromium.
// It serves in-memory modules on port 0 and closes its browser/server in finally.
test(
  "embedded Fox and WaterBottle decode in Chromium, share textures, and release ImageBitmaps",
  {
    skip: process.env.THREECAT_MODEL_BROWSER !== "1",
    timeout: 60000,
  },
  async () => {
    const { createServer } = await import("node:http");
    const { readFile } = await import("node:fs/promises");
    const { resolve, relative, sep } = await import("node:path");
    const { chromium } = await import("playwright");
    const ts = await import("typescript");
    const source = await readFile(
      new URL("../packages/renderer/src/models.ts", import.meta.url),
      "utf8",
    );
    const module = ts.transpileModule(source, {
      compilerOptions: {
        target: ts.ScriptTarget.ES2023,
        module: ts.ModuleKind.ESNext,
      },
    }).outputText;
    const vendorRoot = resolve("node_modules/three");
    const fox = await readFile(
      new URL("../examples/m2/assets/Fox.glb", import.meta.url),
    );
    const bottle = await readFile(
      new URL("../examples/m2/assets/WaterBottle.glb", import.meta.url),
    );
    const broken = Buffer.from(bottle);
    const jsonLength = broken.readUInt32LE(12);
    const json = JSON.parse(broken.toString("utf8", 20, 20 + jsonLength));
    for (const image of json.images) {
      const view = json.bufferViews[image.bufferView];
      broken.fill(
        0,
        28 + jsonLength + (view.byteOffset ?? 0),
        28 + jsonLength + (view.byteOffset ?? 0) + view.byteLength,
      );
    }
    const server = createServer((request, response) => {
      void (async () => {
        const path = new URL(request.url!, "http://localhost").pathname;
        if (path === "/") {
          response.setHeader("Content-Type", "text/html");
          response.end(
            '<script type="importmap">{"imports":{"three":"/vendor/build/three.webgpu.js","three/webgpu":"/vendor/build/three.webgpu.js","three/tsl":"/vendor/build/three.tsl.js","three/addons/":"/vendor/examples/jsm/"}}</script>',
          );
        } else if (path === "/models.js") {
          response.setHeader("Content-Type", "text/javascript");
          response.end(module);
        } else if (
          ["/Fox.glb", "/WaterBottle.glb", "/broken.glb"].includes(path)
        ) {
          response.setHeader("Content-Type", "model/gltf-binary");
          response.end(
            path === "/Fox.glb"
              ? fox
              : path === "/broken.glb"
                ? broken
                : bottle,
          );
        } else if (path.startsWith("/vendor/")) {
          const target = resolve(vendorRoot, path.slice(8));
          const within = relative(vendorRoot, target);
          if (
            within.startsWith(".." + sep) ||
            within === ".." ||
            resolve(vendorRoot, within) !== target
          ) {
            response.writeHead(403);
            response.end();
            return;
          }
          response.setHeader("Content-Type", "text/javascript");
          response.end(await readFile(target));
        } else {
          response.writeHead(404);
          response.end();
        }
      })().catch((error) => {
        response.writeHead(500);
        response.end(String(error));
      });
    });
    server.requestTimeout = 10000;
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      browser = await chromium.launch({ headless: true, timeout: 20000 });
      watchdog = setTimeout(() => {
        void browser?.close();
      }, 30000);
      const page = await browser.newPage();
      page.setDefaultTimeout(15000);
      await page.goto(`http://127.0.0.1:${address.port}/`);
      const result = await page.evaluate<{
        decoded: number;
        textures: number;
        blobURLs: number;
      }>(`(async () => {
      const { createModelLibrary } = await import('/models.js');
      const THREE = await import('three/webgpu');
      const check = (condition, message) => { if (!condition) throw new Error(message); };
      const decoded = new Set(), closed = new Map(), blobs = new Set();
      const createBitmap = globalThis.createImageBitmap;
      globalThis.createImageBitmap = async (...args) => { const bitmap = await createBitmap(...args); decoded.add(bitmap); return bitmap; };
      const close = ImageBitmap.prototype.close;
      ImageBitmap.prototype.close = function() { closed.set(this, (closed.get(this) ?? 0) + 1); return close.call(this); };
      const createURL = URL.createObjectURL, revokeURL = URL.revokeObjectURL;
      URL.createObjectURL = function(value) { const url = createURL.call(this, value); blobs.add(url); return url; };
      URL.revokeObjectURL = function(url) { blobs.delete(url); return revokeURL.call(this, url); };
      const models = createModelLibrary({ fox: '/Fox.glb', bottle: '/WaterBottle.glb' }, { baseURL: location.href });
      let bad;
      try {
        await models.prepare(undefined, { signal: AbortSignal.timeout(10000) });
        check(JSON.stringify(models.inspect().templates.find(t => t.id === 'fox').animations) === JSON.stringify(['Survey', 'Walk', 'Run']), 'Fox clip names changed');
        const a = models.instantiate('fox-a', { asset: 'fox' });
        const b = models.instantiate('fox-b', { asset: 'fox' });
        const skins = [];
        for (const instance of [a, b]) instance.node.traverse(o => { if (o.isSkinnedMesh) skins.push(o); });
        check(skins.length === 2 && skins[0].skeleton !== skins[1].skeleton, 'Fox skeletons must be independent');
        for (const skin of skins) skin.skeleton.computeBoneTexture();
        check(skins[0].skeleton.boneTexture !== skins[1].skeleton.boneTexture, 'bone textures must be independent');
        models.animation.play('fox-a', 'Walk'); models.tick(0.25);
        models.animation.play('fox-a', 'Run', { fade: 0.8 }); models.tick(0.2);
        const saved = JSON.parse(JSON.stringify(models.snapshot()));
        const trajectory = () => [0.1, 0.3, 0.4].map(dt => { models.tick(dt); return skins[0].skeleton.bones.flatMap(bone => [...bone.position.toArray(), ...bone.quaternion.toArray()]); });
        const uninterrupted = trajectory(); models.restore(saved); const restored = trajectory();
        check(uninterrupted.every((pose, i) => pose.every((v, k) => Math.abs(v - restored[i][k]) < 1e-5)), 'real Fox fade continuation differs after restore');
        const one = models.instantiate('bottle-a', { asset: 'bottle' });
        const two = models.instantiate('bottle-b', { asset: 'bottle' });
        let meshA, meshB;
        one.node.traverse(o => { if (o.isMesh) meshA = o; });
        two.node.traverse(o => { if (o.isMesh) meshB = o; });
        check(meshA.geometry === meshB.geometry && meshA.material === meshB.material, 'bottle template resources must be shared');
        const material = meshA.material;
        check(material.map && material.normalMap && material.roughnessMap && material.metalnessMap, 'embedded PBR textures missing');
        check(material.map.colorSpace === THREE.SRGBColorSpace, 'base color must use sRGB');
        check(material.normalMap.colorSpace === THREE.NoColorSpace, 'normal map must stay linear');
        const image = material.map.source.data;
        check(image instanceof ImageBitmap && image.width > 0 && image.height > 0, 'real browser image decode missing');
        const textures = new Set(Object.values(material).filter(v => v?.isTexture));
        let released = 0;
        for (const texture of textures) texture.addEventListener('dispose', () => released++);
        one.dispose(); a.dispose();
        check(released === 0 && !closed.has(image), 'instance disposal released shared textures');
        check(skins[0].skeleton.boneTexture === null && skins[1].skeleton.boneTexture !== null, 'instance removal damaged sibling bone texture');
        const owned = models.inspect().owned;
        await Promise.all([models.dispose(), models.dispose()]);
        check(released === textures.size, 'each shared texture must be released once');
        check([...decoded].every(bitmap => closed.get(bitmap) === 1), 'every decoded bitmap must close exactly once');
        bad = createModelLibrary({ bad: '/broken.glb' }, { baseURL: location.href });
        let error = '';
        try { await bad.prepare(undefined, { signal: AbortSignal.timeout(10000) }); } catch (failure) { error = failure.message; }
        check(error.includes('TC_MODEL_TEXTURE_FAILED'), 'corrupt texture silently fell back to an untextured material: ' + error);
        check(bad.inspect().templates.length === 0, 'failed texture published a template');
        await bad.dispose();
        check(blobs.size === 0, 'embedded image blob URLs leaked after success/failure');
        check([...decoded].every(bitmap => closed.get(bitmap) === 1), 'failure leaked or double-closed bitmap');
        return { decoded: decoded.size, textures: owned.textures, geometries: owned.geometries, blobURLs: blobs.size };
      } finally {
        await models.dispose(); await bad?.dispose();
        globalThis.createImageBitmap = createBitmap; ImageBitmap.prototype.close = close;
        URL.createObjectURL = createURL; URL.revokeObjectURL = revokeURL;
      }
    })()`);
      assert.ok(result.decoded >= 2);
      assert.ok(result.textures >= 4);
      assert.equal(result.blobURLs, 0);
    } finally {
      clearTimeout(watchdog);
      await browser?.close();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  },
);

test("restoring a neutral snapshot removes all animation influence and invalid playback leaves the pose untouched", async (t) => {
  const library = createModelLibrary(
    { hero: "hero.glb" },
    { fetch: fixtureFetch(await animatedGLB()).fetcher },
  );
  t.after(() => library.dispose());
  await library.prepare();
  const bone = library
    .instantiate("hero", { asset: "hero" })
    .node.getObjectByName("animated-bone")!;
  const neutral = library.snapshot();
  library.animation.play("hero", "raise", { fade: 1 });
  library.tick(0.25);
  close(bone.position.y, 0.0625, 1e-7);
  const before = library.snapshot();
  for (const options of [{ speed: NaN }, { fade: -1 }, { fade: Infinity }]) {
    assert.throws(
      () => library.animation.play("hero", "lower", options),
      /TC_MODEL_INVALID_ANIMATION_OPTIONS/,
    );
    assert.deepEqual(library.snapshot(), before);
    close(bone.position.y, 0.0625, 1e-7);
  }
  library.restore(neutral);
  assert.deepEqual(library.animation.state("hero"), {
    clip: null,
    time: 0,
    playing: false,
  });
  library.tick(0.5);
  close(bone.position.y, 0);
  library.restore(before);
  before.animations[0]!.actions[0]!.fade!.elapsed = 0;
  library.tick(0.25);
  close(bone.position.y, 0.25, 1e-7);
});

test("zero-duration clips reject explicitly instead of producing non-finite repeat time", async (t) => {
  const bytes = editGLB(await animatedGLB(), (json) => {
    for (const animation of json.animations) {
      const input = json.accessors[animation.samplers[0].input];
      input.count = 1;
      input.max = [0];
    }
  });
  const library = createModelLibrary(
    { hero: "hero.glb" },
    { fetch: fixtureFetch(bytes).fetcher },
  );
  t.after(() => library.dispose());
  await assert.rejects(
    library.prepare(),
    /TC_MODEL_INVALID_CLIP_DURATION.*positive/,
  );
  assert.equal(library.inspect().templates.length, 0);
});

test("restore reconstructs deleted instances and a saved subset removes extra active instances", async (t) => {
  const library = createModelLibrary(
    { hero: "hero.glb" },
    { fetch: fixtureFetch(await animatedGLB()).fetcher },
  );
  t.after(() => library.dispose());
  await library.prepare();
  const parentA = new THREE.Group(),
    parentB = new THREE.Group();
  const oldA = library.instantiate("a", { asset: "hero" }, parentA);
  library.instantiate("b", { asset: "hero" }, parentB);
  library.animation.play("a", "raise");
  library.tick(0.2);
  library.animation.play("a", "lower", { fade: 0.8 });
  library.tick(0.2);
  const full = library.snapshot();
  const y = oldA.node.getObjectByName("animated-bone")!.position.y;
  library.remove("a");
  assert.equal(library.get("a"), undefined);
  assert.equal(parentA.children.length, 0);
  const subset = library.snapshot();
  assert.deepEqual(
    subset.animations.map((a) => a.entity),
    ["b"],
  );
  library.validateSnapshot(full);
  assert.equal(
    library.get("a"),
    undefined,
    "validation must not reconstruct instances",
  );
  library.restore(full);
  const newA = library.get("a")!;
  assert.notEqual(newA, oldA);
  assert.equal(newA.node.parent, parentA);
  close(newA.node.getObjectByName("animated-bone")!.position.y, y);
  oldA.dispose();
  assert.equal(library.get("a"), newA);
  library.tick(0.1);
  close(newA.node.getObjectByName("animated-bone")!.position.y, 0.575);
  library.restore(subset);
  assert.equal(library.get("a"), undefined);
  assert.equal(library.inspect().instances, 1);
  assert.equal(library.inspect().definitions, 2);
  assert.equal(parentB.children.length, 1);
  library.restore({ ...subset, animations: [] });
  assert.equal(library.inspect().instances, 0);
  assert.equal(parentB.children.length, 0);
});

test("cold-host restore accepts a deleted authored subset and registry-only reconstruction preserves playback", async (t) => {
  const bytes = await animatedGLB();
  const make = () =>
    createModelLibrary(
      { hero: "hero.glb" },
      { fetch: fixtureFetch(bytes).fetcher },
    );
  const original = make(),
    allAuthored = make(),
    registryOnly = make();
  t.after(() =>
    Promise.all([
      original.dispose(),
      allAuthored.dispose(),
      registryOnly.dispose(),
    ]),
  );
  await Promise.all([
    original.prepare(),
    allAuthored.prepare(),
    registryOnly.prepare(),
  ]);
  const definition = {
    asset: "hero",
    animation: { clip: "raise", speed: 1.5, loop: false },
  };
  for (const library of [original, allAuthored]) {
    library.instantiate("a", definition);
    library.instantiate("b", definition);
  }
  const parent = new THREE.Group();
  registryOnly.register("a", definition, parent);
  registryOnly.register("b", definition, parent);
  assert.equal(registryOnly.inspect().instances, 0);
  original.remove("a");
  original.tick(0.4);
  const saved = JSON.parse(JSON.stringify(original.snapshot()));
  for (const library of [allAuthored, registryOnly]) {
    library.restore(saved);
    assert.equal(library.get("a"), undefined);
    assert.ok(library.get("b"));
    close(library.animation.state("b").time, 0.6);
    close(
      library.get("b")!.node.getObjectByName("animated-bone")!.position.y,
      0.6,
    );
    library.tick(1);
    assert.deepEqual(library.animation.state("b"), {
      clip: "raise",
      time: 1,
      playing: false,
    });
  }
  assert.equal(parent.children.length, 1);
  assert.equal(registryOnly.get("b")!.node.parent, parent);
});

test("get, attach, and reconcile let browser views replace parents without restarting live animations", async (t) => {
  const library = createModelLibrary(
    { hero: "hero.glb" },
    { fetch: fixtureFetch(await animatedGLB()).fetcher },
  );
  t.after(() => library.dispose());
  await library.prepare();
  const oldParent = new THREE.Group(),
    newParent = new THREE.Group();
  library.register(
    "a",
    { asset: "hero", animation: { clip: "raise" } },
    oldParent,
  );
  library.register("b", { asset: "hero" }, oldParent);
  const initial = library.reconcile(["a", "b"]);
  assert.deepEqual(
    initial.map((i) => i.entity),
    ["a", "b"],
  );
  assert.equal(oldParent.children.length, 2);
  library.tick(0.25);
  const live = library.get("a")!;
  assert.equal(library.attach("a", newParent), live);
  close(library.animation.state("a").time, 0.25);
  assert.equal(live.node.parent, newParent);
  assert.equal(oldParent.children.length, 1);
  const remaining = library.reconcile(["a"]);
  assert.equal(remaining[0], live);
  assert.equal(library.get("b"), undefined);
  assert.equal(oldParent.children.length, 0);
  assert.equal(live.node.parent, newParent);
  library.remove("a");
  const replacement = library.attach("a", oldParent);
  assert.notEqual(replacement, live);
  close(library.animation.state("a").time, 0);
  live.dispose();
  assert.equal(library.get("a"), replacement);
  library.remove("a");
  library.reconcile(["a"]);
  assert.equal(
    library.get("a")!.node.parent,
    oldParent,
    "attach must remember the replacement parent",
  );
});

test("immutable known definitions are copied, and unknown restore/reconcile entities reject before changing the active set", async (t) => {
  const library = createModelLibrary(
    { hero: "hero.glb" },
    { fetch: fixtureFetch(await animatedGLB()).fetcher },
  );
  t.after(() => library.dispose());
  await library.prepare();
  const parent = new THREE.Group();
  const input = {
    asset: "hero",
    scale: 2,
    offset: [1, 2, 3] as [number, number, number],
  };
  library.register("a", input, parent);
  input.scale = 99;
  input.offset[0] = 99;
  library.attach("a", parent);
  assert.equal(library.get("a")!.node.scale.x, 2);
  assert.equal(library.get("a")!.node.position.x, 1);
  library.register("b", { asset: "hero" }, parent);
  const saved = library.snapshot();
  const current = library.get("a");
  const broken = structuredClone(saved);
  broken.animations.push({ ...broken.animations[0]!, entity: "unknown" });
  assert.throws(
    () => library.restore(broken),
    /TC_MODEL_INVALID_SNAPSHOT.*TC_MODEL_DEFINITION_MISSING: unknown/,
  );
  assert.throws(
    () => library.reconcile(["b", "unknown"]),
    /TC_MODEL_DEFINITION_MISSING: unknown/,
  );
  assert.throws(
    () => library.reconcile(["b", "b"]),
    /TC_MODEL_ENTITY_DUPLICATE/,
  );
  assert.throws(
    () => library.attach("unknown", parent),
    /TC_MODEL_DEFINITION_MISSING/,
  );
  assert.throws(
    () => library.register("a", input),
    /TC_MODEL_DEFINITION_CONFLICT/,
  );
  assert.equal(library.get("a"), current);
  assert.equal(library.get("b"), undefined);
  assert.equal(parent.children.length, 1);
  assert.deepEqual(library.snapshot(), saved);
});
