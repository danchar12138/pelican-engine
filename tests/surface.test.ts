import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import {
  extractSurfaceScene,
  sampleSurfaceMaterial,
  SurfaceExtractionError,
  type SurfaceVec3,
} from "../packages/renderer/src/surface.ts";
import { extractTriangles } from "../packages/renderer/src/geometry.ts";

test("derived normal frame retains actual mirrored world and UV handedness", () => {
  const t = new THREE.DataTexture(
    new Float32Array([0.5, 1, 0.5, 1]),
    1,
    1,
    THREE.RGBAFormat,
    THREE.FloatType,
  );
  const { scene, mesh } = setup(
    new THREE.MeshStandardMaterial({ normalMap: t }),
  );
  mesh.scale.x = -1;
  nearVec(
    sampleSurfaceMaterial(extractSurfaceScene(scene), 0, [1, 0, 0]).normal,
    [0, 1, 0],
  );
  t.repeat.y = -1;
  nearVec(
    sampleSurfaceMaterial(extractSurfaceScene(scene), 0, [1, 0, 0]).normal,
    [0, -1, 0],
  );
});

test("supplied custom mip zero is diagnosed rather than silently replaced with image pixels", () => {
  const t = dataTexture([255, 0, 0, 255]);
  t.mipmaps = [{ data: new Uint8Array([0, 255, 0, 255]), width: 1, height: 1 }];
  const snapshot = extractSurfaceScene(
    setup(new THREE.MeshStandardMaterial({ map: t })).scene,
  );
  assert.equal(snapshot.textures[0].uuid, t.uuid);
  assert.ok(
    snapshot.diagnostics.some(
      (d) => d.code === "SURFACE_TEXTURE_TYPE_UNSUPPORTED",
    ),
  );
  expectCode(
    () => sampleSurfaceMaterial(snapshot, 0, [1, 0, 0]),
    "SURFACE_TEXTURE_PIXELS_UNAVAILABLE",
  );
});

test("texture rotation/center/repeat/offset are sampled from the immutable matrix", () => {
  const t = dataTexture([255, 0, 0, 255, 0, 255, 0, 255], 2);
  t.wrapS = THREE.RepeatWrapping;
  t.offset.set(0.1, 0.1);
  t.repeat.set(0.5, 0.5);
  t.center.set(0.5, 0.5);
  t.rotation = Math.PI / 2;
  const { scene } = setup(new THREE.MeshStandardMaterial({ map: t }));
  const matrixBefore = t.matrix.toArray();
  const s = extractSurfaceScene(scene),
    expected = new THREE.Matrix3().setUvTransform(
      0.1,
      0.1,
      0.5,
      0.5,
      Math.PI / 2,
      0.5,
      0.5,
    );
  nearVec(s.textures[0].matrix, expected.elements);
  assert.deepEqual(t.matrix.toArray(), matrixBefore);
  for (const uv of [
    [0, 0],
    [0.2, 0.9],
    [-3, 0.2],
    [1.5, -2],
  ] as const) {
    const u = new THREE.Vector3(...uv, 1).applyMatrix3(expected).x,
      repeated = ((u % 1) + 1) % 1;
    nearVec(
      sampleSurfaceMaterial(s, 0, [1, 0, 0], { uv0: uv }).baseColor,
      repeated < 0.5 ? [1, 0, 0] : [0, 1, 0],
    );
  }
});

test("normal scale, handedness, side and object-space inverse transpose have numeric reference values", () => {
  const t = new THREE.DataTexture(
    new Float32Array([0.75, 0.75, 1, 1]),
    1,
    1,
    THREE.RGBAFormat,
    THREE.FloatType,
  );
  const m = new THREE.MeshStandardMaterial({
    normalMap: t,
    normalScale: new THREE.Vector2(2, 0.5),
    side: THREE.DoubleSide,
  });
  const { scene, g, mesh } = setup(m);
  g.setAttribute(
    "tangent",
    new THREE.Float32BufferAttribute(
      Array.from({ length: 6 }, () => [1, 0, 0, -1]).flat(),
      4,
    ),
  );
  let s = extractSurfaceScene(scene);
  nearVec(
    sampleSurfaceMaterial(s, 0, [1, 0, 0]).normal,
    new THREE.Vector3(1, -0.25, 1).normalize().toArray(),
  );
  nearVec(
    sampleSurfaceMaterial(s, 0, [1, 0, 0], { frontFacing: false }).normal,
    new THREE.Vector3(-1, 0.25, -1).normalize().toArray(),
  );
  m.normalMapType = THREE.ObjectSpaceNormalMap;
  mesh.scale.set(2, 4, 1);
  s = extractSurfaceScene(scene);
  nearVec(
    sampleSurfaceMaterial(s, 0, [1, 0, 0]).normal,
    new THREE.Vector3(0.5, 0.0625, 1).normalize().toArray(),
  );
});

test("flat shading uses face normal and missing tangent uses transformed UV frame or rejects degenerate UV", () => {
  const t = new THREE.DataTexture(
    new Float32Array([1, 0.5, 0.5, 1]),
    1,
    1,
    THREE.RGBAFormat,
    THREE.FloatType,
  );
  const m = new THREE.MeshStandardMaterial({ normalMap: t, flatShading: true });
  const { scene, g } = setup(m);
  g.setAttribute(
    "normal",
    new THREE.Float32BufferAttribute(
      Array.from({ length: 6 }, () => [1, 0, 0]).flat(),
      3,
    ),
  );
  nearVec(
    extractSurfaceScene(scene).triangles[0].vertices[0].normal,
    [0, 0, 1],
  );
  t.rotation = Math.PI / 2;
  nearVec(
    sampleSurfaceMaterial(extractSurfaceScene(scene), 0, [1, 0, 0]).normal,
    [0, 1, 0],
  );
  g.setAttribute(
    "uv",
    new THREE.Float32BufferAttribute(new Float32Array(12), 2),
  );
  expectCode(
    () => sampleSurfaceMaterial(extractSurfaceScene(scene), 0, [1, 0, 0]),
    "SURFACE_NORMAL_TANGENT_DEGENERATE",
  );
});

test("normalized and interleaved CPU attributes use Three accessors", () => {
  const { scene, g } = setup(
    new THREE.MeshStandardMaterial({ vertexColors: true }),
  );
  g.setAttribute(
    "color",
    new THREE.Uint8BufferAttribute(
      Array.from({ length: 6 }, () => [128, 64, 255, 128]).flat(),
      4,
      true,
    ),
  );
  const source = new THREE.InterleavedBuffer(
    new Float32Array(
      Array.from({ length: 6 }, (_, i) => [99, i % 2, 0.25]).flat(),
    ),
    3,
  );
  g.setAttribute("uv", new THREE.InterleavedBufferAttribute(source, 2, 1));
  const s = extractSurfaceScene(scene);
  nearVec(s.triangles[0].vertices[1].uv0!, [1, 0.25]);
  nearVec(sampleSurfaceMaterial(s, 0, [1, 0, 0]).baseColor, [
    128 / 255,
    64 / 255,
    1,
  ]);
});

test("source units, negative scale, sheared native instances and explicit matrix-world policy are retained", () => {
  const { scene, mesh } = setup();
  mesh.matrixAutoUpdate = false;
  mesh.matrix.makeScale(-2, 3, 4).setPosition(1000, 2000, 3000);
  let s = extractSurfaceScene(scene);
  nearVec(s.triangles[0].vertices[1].position, [998, 2000, 3000]);
  nearVec(s.triangles[0].vertices[0].normal, [0, 0, 1]);
  mesh.matrixWorldAutoUpdate = false;
  mesh.matrixWorld.makeTranslation(7, 8, 9);
  s = extractSurfaceScene(scene);
  nearVec(s.triangles[0].vertices[0].position, [7, 8, 9]);
  const instanced = new THREE.InstancedMesh(
    geometry(),
    new THREE.MeshStandardMaterial(),
    1,
  );
  const shear = new THREE.Matrix4().set(
    1,
    0,
    2,
    0,
    0,
    1,
    0,
    0,
    0,
    0,
    1,
    0,
    0,
    0,
    0,
    1,
  );
  instanced.setMatrixAt(0, shear);
  const otherScene = new THREE.Scene();
  otherScene.add(instanced);
  nearVec(
    extractSurfaceScene(otherScene).triangles[0].vertices[0].normal,
    new THREE.Vector3(0, 0, 1)
      .applyMatrix3(new THREE.Matrix3().getNormalMatrix(shear))
      .normalize()
      .toArray(),
  );
});

test("unsupported pixel formats/types retain immutable identity and diagnostics without fake texels", () => {
  for (const t of [
    new THREE.DataTexture(
      new Uint16Array([1, 2, 3, 4]),
      1,
      1,
      THREE.RGBAFormat,
      THREE.HalfFloatType,
    ),
    new THREE.DataTexture(
      new Uint8Array([1, 2, 3, 4]),
      1,
      1,
      THREE.RGBAIntegerFormat,
    ),
  ]) {
    const s = extractSurfaceScene(
      setup(new THREE.MeshStandardMaterial({ map: t })).scene,
    );
    assert.equal(s.textures[0].uuid, t.uuid);
    assert.equal(s.textures[0].pixels, undefined);
    assert.ok(s.diagnostics.some((d) => d.code.includes("UNSUPPORTED")));
    expectCode(
      () => sampleSurfaceMaterial(s, 0, [1, 0, 0]),
      "SURFACE_TEXTURE_PIXELS_UNAVAILABLE",
    );
  }
});

test("provider texture-origin rows bypass flipY; invalid pixels and nonfinite sampler state fail explicitly", () => {
  const t = new THREE.Texture({
    width: 1,
    height: 2,
  } as unknown as HTMLImageElement);
  t.flipY = true;
  t.magFilter = THREE.NearestFilter;
  const { scene } = setup(new THREE.MeshStandardMaterial({ map: t }));
  const s = extractSurfaceScene(scene, {
    decodedTextureProvider: () => ({
      width: 1,
      height: 2,
      data: new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255]),
      channels: 4,
      encoding: "unorm8",
      origin: "texture",
    }),
  });
  nearVec(
    sampleSurfaceMaterial(s, 0, [1, 0, 0], { uv0: [0.5, 0.25] }).baseColor,
    [1, 0, 0],
  );
  expectCode(
    () => sampleSurfaceMaterial(s, 0, [1, 0, 0], { uv0: [NaN, 0] }),
    "SURFACE_NON_FINITE",
  );
  expectCode(
    () =>
      extractSurfaceScene(scene, {
        decodedTextureProvider: () => ({
          width: 1,
          height: 2,
          data: new Uint8Array(1),
          channels: 4,
          encoding: "unorm8",
          origin: "image",
        }),
      }),
    "SURFACE_TEXTURE_DATA_INVALID",
  );
  t.rotation = NaN;
  expectCode(() => extractSurfaceScene(scene), "SURFACE_NON_FINITE");
});

test("scene effects and unsupported renderables are diagnostics while override/deformation/attributes reject", () => {
  const { scene, mesh, g } = setup();
  scene.background = new THREE.Color(1, 1, 1);
  scene.add(new THREE.PointLight(), new THREE.Line());
  const s = extractSurfaceScene(scene);
  assert.ok(
    s.diagnostics.some((d) => d.code === "SURFACE_SCENE_EFFECTS_NOT_CAPTURED"),
  );
  assert.ok(
    s.diagnostics.some((d) => d.code === "SURFACE_RENDERABLE_UNSUPPORTED"),
  );
  assert.ok(s.diagnostics.some((d) => d.code === "SURFACE_LIGHT_NOT_CAPTURED"));
  scene.overrideMaterial = new THREE.MeshStandardMaterial();
  expectCode(
    () => extractSurfaceScene(scene),
    "SURFACE_SCENE_OVERRIDE_UNSUPPORTED",
  );
  scene.overrideMaterial = null;
  g.setAttribute("normal", new THREE.Float32BufferAttribute([0, 0, 1], 3));
  expectCode(
    () => extractSurfaceScene(scene),
    "SURFACE_ATTRIBUTE_COUNT_INVALID",
  );
  g.deleteAttribute("normal");
  mesh.matrixAutoUpdate = false;
  mesh.matrix.elements[3] = 1;
  expectCode(() => extractSurfaceScene(scene), "SURFACE_TRANSFORM_UNSUPPORTED");
});

const near = (actual: number, expected: number, tolerance = 1e-6) =>
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${actual} != ${expected}`,
  );
const nearVec = (
  actual: readonly number[],
  expected: readonly number[],
  tolerance = 1e-6,
) => {
  assert.equal(actual.length, expected.length);
  actual.forEach((v, i) => near(v, expected[i], tolerance));
};
const bary: SurfaceVec3 = [0.25, 0.25, 0.5];
function geometry(indexed = false): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(
      [0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0],
      3,
    ),
  );
  g.setAttribute(
    "normal",
    new THREE.Float32BufferAttribute(
      Array.from({ length: 6 }, () => [0, 0, 1]).flat(),
      3,
    ),
  );
  g.setAttribute(
    "uv",
    new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1, 1, 0, 1, 1, 0, 1], 2),
  );
  g.setAttribute(
    "uv1",
    new THREE.Float32BufferAttribute(
      Array.from({ length: 6 }, () => [0.75, 0.25]).flat(),
      2,
    ),
  );
  if (indexed) g.setIndex([0, 1, 2, 3, 4, 5]);
  return g;
}
function setup(
  material:
    | THREE.Material
    | THREE.Material[] = new THREE.MeshStandardMaterial(),
  g = geometry(),
) {
  const scene = new THREE.Scene(),
    mesh = new THREE.Mesh(g, material);
  scene.add(mesh);
  return { scene, mesh, g };
}
function dataTexture(data: number[], width = 1, height = 1) {
  return new THREE.DataTexture(
    new Uint8Array(data),
    width,
    height,
    THREE.RGBAFormat,
    THREE.UnsignedByteType,
  );
}
function expectCode(fn: () => unknown, code: string) {
  assert.throws(
    fn,
    (error: unknown) =>
      error instanceof SurfaceExtractionError &&
      error.code === code &&
      error.message.includes(code),
  );
}
function frozenTree(value: unknown): void {
  if (value && typeof value === "object") {
    assert.ok(Object.isFrozen(value));
    for (const child of Object.values(value)) frozenTree(child);
  }
}

for (const indexed of [false, true])
  test(`two material groups retain two colors and original indices (${indexed ? "indexed" : "nonindexed"})`, () => {
    const red = new THREE.MeshStandardMaterial({ color: 0xff0000 }),
      green = new THREE.MeshStandardMaterial({ color: 0x00ff00 }),
      { scene, g, mesh } = setup([red, green], geometry(indexed));
    g.addGroup(0, 3, 0);
    g.addGroup(3, 3, 1);
    const snapshot = extractSurfaceScene(scene),
      old = extractTriangles(scene);
    assert.equal(snapshot.triangles.length, 2);
    assert.equal(snapshot.materials.length, 2);
    nearVec(sampleSurfaceMaterial(snapshot, 0, bary).baseColor, [1, 0, 0]);
    nearVec(sampleSurfaceMaterial(snapshot, 1, bary).baseColor, [0, 1, 0]);
    assert.deepEqual(
      old.map((t) => t.color),
      [
        [1, 0, 0],
        [1, 0, 0],
      ],
    );
    assert.deepEqual(
      snapshot.triangles.map((t) => [
        t.materialIndex,
        t.groupIndex,
        t.elementOffset,
        t.objectUuid,
      ]),
      [
        [0, 0, 0, mesh.uuid],
        [1, 1, 3, mesh.uuid],
      ],
    );
    g.setDrawRange(3, 3);
    assert.deepEqual(
      extractSurfaceScene(scene).triangles.map((t) => t.materialIndex),
      [1],
    );
  });

test("interpolated vertex UV, factor, vertex RGBA and sRGB texels defeat the uniform-color extractor", () => {
  const texture = dataTexture([255, 0, 0, 128, 0, 128, 255, 64], 2);
  texture.colorSpace = THREE.SRGBColorSpace;
  const factor = new THREE.Color().setRGB(
      0.5,
      0.25,
      0.75,
      THREE.LinearSRGBColorSpace,
    ),
    material = new THREE.MeshStandardMaterial({
      color: factor,
      map: texture,
      vertexColors: true,
      opacity: 0.8,
      transparent: true,
    });
  const { scene, g } = setup(material);
  g.setAttribute(
    "color",
    new THREE.Float32BufferAttribute(
      Array.from({ length: 6 }, () => [0.5, 0.8, 1, 0.5]).flat(),
      4,
    ),
  );
  const snapshot = extractSurfaceScene(scene),
    a = sampleSurfaceMaterial(snapshot, 0, [1, 0, 0]),
    b = sampleSurfaceMaterial(snapshot, 0, [0.1, 0.8, 0.1]);
  nearVec(a.baseColor, [0.25, 0, 0]);
  nearVec(b.baseColor, [
    0,
    0.25 * 0.8 * ((128 / 255 + 0.055) / 1.055) ** 2.4,
    0.75,
  ]);
  near(b.alpha, (0.8 * 0.5 * 64) / 255);
  assert.equal(b.alphaMode, "blend");
  assert.deepEqual(
    extractTriangles(scene).map((t) => t.color),
    [factor.toArray(), factor.toArray()],
  );
  assert.notDeepEqual(a.baseColor, b.baseColor);
  assert.equal(snapshot.textures[0].uuid, texture.uuid);
});

test("sRGB decode occurs before bilinear filtering; linear material color is not decoded again", () => {
  const texture = dataTexture([0, 0, 0, 64, 255, 255, 255, 128], 2);
  texture.magFilter = THREE.LinearFilter;
  texture.colorSpace = THREE.SRGBColorSpace;
  const { scene } = setup(
    new THREE.MeshStandardMaterial({
      map: texture,
      color: new THREE.Color(0.5, 0.5, 0.5),
      transparent: true,
    }),
  );
  const snapshot = extractSurfaceScene(scene),
    sample = sampleSurfaceMaterial(snapshot, 0, bary, { uv0: [0.5, 0.5] });
  nearVec(sample.baseColor, [0.25, 0.25, 0.25]);
  near(sample.alpha, 96 / 255);
  const gray = dataTexture([128, 128, 128, 255]);
  gray.colorSpace = THREE.SRGBColorSpace;
  const grayScene = setup(
    new THREE.MeshStandardMaterial({
      map: gray,
      color: new THREE.Color(0.5, 0.5, 0.5),
    }),
  ).scene;
  near(
    sampleSurfaceMaterial(extractSurfaceScene(grayScene), 0, bary).baseColor[0],
    0.5 * ((128 / 255 + 0.055) / 1.055) ** 2.4,
  );
});

test("UV1, texture transform, repeat/mirror/clamp, min/mag filters, source identity", () => {
  const texture = dataTexture([255, 0, 0, 255, 0, 255, 0, 255], 2);
  texture.channel = 1;
  texture.offset.set(0.5, 0);
  texture.repeat.set(2, 1);
  texture.wrapS = THREE.RepeatWrapping;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  const { scene } = setup(new THREE.MeshStandardMaterial({ map: texture }));
  let snapshot = extractSurfaceScene(scene);
  nearVec(sampleSurfaceMaterial(snapshot, 0, bary).baseColor, [1, 0, 0]);
  assert.equal(snapshot.textures[0].sourceUuid, texture.source.uuid);
  assert.equal(snapshot.textures[0].channel, 1);
  assert.equal(snapshot.textures[0].minFilter, THREE.LinearMipmapLinearFilter);
  texture.offset.set(0, 0);
  texture.repeat.set(1, 1);
  texture.wrapS = THREE.MirroredRepeatWrapping;
  snapshot = extractSurfaceScene(scene);
  nearVec(
    sampleSurfaceMaterial(snapshot, 0, bary, { uv1: [1.25, 0.5] }).baseColor,
    [0, 1, 0],
  );
  nearVec(
    sampleSurfaceMaterial(snapshot, 0, bary, {
      uv1: [0.5, 0.5],
      footprint: "minification",
    }).baseColor,
    [0.5, 0.5, 0],
  );
  texture.wrapS = THREE.ClampToEdgeWrapping;
  snapshot = extractSurfaceScene(scene);
  nearVec(
    sampleSurfaceMaterial(snapshot, 0, bary, { uv1: [-5, 0.5] }).baseColor,
    [1, 0, 0],
  );
  texture.matrixAutoUpdate = false;
  texture.matrix.set(1, 0, 0.5, 0, 1, 0, 0, 0, 1);
  snapshot = extractSurfaceScene(scene);
  nearVec(
    sampleSurfaceMaterial(snapshot, 0, bary, { uv1: [0, 0.5] }).baseColor,
    [0, 1, 0],
  );
});

test("shared ORM texture uses R/G/B and actual material emissive factors", () => {
  const orm = dataTexture([51, 102, 153, 255]),
    emission = dataTexture([128, 64, 255, 255]);
  emission.colorSpace = THREE.SRGBColorSpace;
  const m = new THREE.MeshStandardMaterial({
    aoMap: orm,
    roughnessMap: orm,
    metalnessMap: orm,
    roughness: 0.8,
    metalness: 0.5,
    aoMapIntensity: 0.75,
    emissive: new THREE.Color(0.2, 0.4, 0.1),
    emissiveIntensity: 3,
    emissiveMap: emission,
  });
  const snapshot = extractSurfaceScene(setup(m).scene),
    sample = sampleSurfaceMaterial(snapshot, 0, bary);
  assert.equal(snapshot.textures.length, 2);
  assert.equal(
    new Set([
      snapshot.materials[0].maps.aoMap,
      snapshot.materials[0].maps.roughnessMap,
      snapshot.materials[0].maps.metalnessMap,
    ]).size,
    1,
  );
  near(sample.occlusion, 0.4);
  near(sample.roughness, 0.32);
  near(sample.metalness, 0.3);
  nearVec(sample.emissive, [
    0.6 * ((128 / 255 + 0.055) / 1.055) ** 2.4,
    1.2 * ((64 / 255 + 0.055) / 1.055) ** 2.4,
    0.3,
  ]);
});

test("inverse transpose world normal under parent rotation and nonuniform scale; UV/tangent/color retained", () => {
  const { scene, mesh, g } = setup();
  const parent = new THREE.Group();
  scene.add(parent);
  parent.add(mesh);
  parent.rotation.z = 0.4;
  parent.scale.set(2, 3, 4);
  mesh.rotation.x = 0.2;
  g.setAttribute(
    "normal",
    new THREE.Float32BufferAttribute(
      Array.from({ length: 6 }, () => [1, 1, 1]).flat(),
      3,
    ),
  );
  g.setAttribute(
    "tangent",
    new THREE.Float32BufferAttribute(
      Array.from({ length: 6 }, () => [1, -1, 0, -1]).flat(),
      4,
    ),
  );
  scene.updateMatrixWorld(true);
  const expected = new THREE.Vector3(1, 1, 1)
    .applyMatrix3(new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld))
    .normalize();
  const wrong = new THREE.Vector3(1, 1, 1).transformDirection(mesh.matrixWorld),
    snapshot = extractSurfaceScene(scene),
    v = snapshot.triangles[0].vertices[0];
  nearVec(v.normal, expected.toArray());
  assert.ok(new THREE.Vector3(...v.normal).distanceTo(wrong) > 0.1);
  assert.equal(v.tangent![3], -1);
  assert.ok(v.uv0);
  assert.ok(v.uv1);
});

test("actual tangent and object-space normal maps transform into world normal", () => {
  const normal = new THREE.DataTexture(
    new Float32Array([1, 0.5, 0.5, 1]),
    1,
    1,
    THREE.RGBAFormat,
    THREE.FloatType,
  );
  const m = new THREE.MeshStandardMaterial({ normalMap: normal });
  const { scene, g, mesh } = setup(m);
  g.setAttribute(
    "tangent",
    new THREE.Float32BufferAttribute(
      Array.from({ length: 6 }, () => [1, 0, 0, 1]).flat(),
      4,
    ),
  );
  mesh.rotation.z = Math.PI / 2;
  mesh.scale.set(2, 3, 1);
  nearVec(
    sampleSurfaceMaterial(extractSurfaceScene(scene), 0, bary).normal,
    [0, 1, 0],
  );
  m.normalMapType = THREE.ObjectSpaceNormalMap;
  nearVec(
    sampleSurfaceMaterial(extractSurfaceScene(scene), 0, bary).normal,
    [0, 1, 0],
  );
  m.normalMapType = THREE.TangentSpaceNormalMap;
  g.deleteAttribute("tangent");
  nearVec(
    sampleSurfaceMaterial(extractSurfaceScene(scene), 0, bary).normal,
    [0, 1, 0],
  );
});
test("relative and absolute animated morph position/normal/color are captured without changing the source", () => {
  for (const relative of [false, true]) {
    const { scene, g, mesh } = setup(
      new THREE.MeshStandardMaterial({ vertexColors: true }),
    );
    g.setAttribute(
      "color",
      new THREE.Float32BufferAttribute(
        Array.from({ length: 6 }, () => [0.4, 0.2, 0.1]).flat(),
        3,
      ),
    );
    g.morphTargetsRelative = relative;
    g.morphAttributes.position = [
      new THREE.Float32BufferAttribute(
        Array.from({ length: 6 }, (_, i) =>
          relative
            ? [0, 0, 2]
            : [
                g.getAttribute("position").getX(i),
                g.getAttribute("position").getY(i),
                2,
              ],
        ).flat(),
        3,
      ),
    ];
    g.morphAttributes.normal = [
      new THREE.Float32BufferAttribute(
        Array.from({ length: 6 }, () =>
          relative ? [1, 0, -1] : [1, 0, 0],
        ).flat(),
        3,
      ),
    ];
    g.morphAttributes.color = [
      new THREE.Float32BufferAttribute(
        Array.from({ length: 6 }, () =>
          relative ? [0.4, 0, 0] : [0.8, 0.2, 0.1],
        ).flat(),
        3,
      ),
    ];
    mesh.updateMorphTargets();
    mesh.morphTargetInfluences![0] = 0.5;
    const matrix = mesh.matrixWorld.elements.slice(),
      positions = Array.from(g.getAttribute("position").array),
      snapshot = extractSurfaceScene(scene),
      v = snapshot.triangles[0].vertices[0];
    nearVec(v.position, [0, 0, 1]);
    nearVec(v.normal, [Math.SQRT1_2, 0, Math.SQRT1_2]);
    nearVec(
      sampleSurfaceMaterial(snapshot, 0, bary).baseColor,
      [0.6, 0.2, 0.1],
    );
    assert.deepEqual(mesh.matrixWorld.elements, matrix);
    assert.deepEqual(Array.from(g.getAttribute("position").array), positions);
    mesh.morphTargetInfluences![0] = 1;
    nearVec(
      extractSurfaceScene(scene).triangles[0].vertices[0].position,
      [0, 0, 2],
    );
    assert.equal(v.position[2], 1);
  }
});

test("animated skin plus morph matches locked Three getVertexPosition; bind matrices and bones are not mutated", () => {
  const scene = new THREE.Scene(),
    g = geometry();
  g.morphTargetsRelative = true;
  g.morphAttributes.position = [
    new THREE.Float32BufferAttribute(
      Array.from({ length: 6 }, () => [0, 0, 1]).flat(),
      3,
    ),
  ];
  g.setAttribute(
    "skinIndex",
    new THREE.Uint16BufferAttribute(
      Array.from({ length: 6 }, () => [0, 0, 0, 0]).flat(),
      4,
    ),
  );
  g.setAttribute(
    "skinWeight",
    new THREE.Float32BufferAttribute(
      Array.from({ length: 6 }, () => [1, 0, 0, 0]).flat(),
      4,
    ),
  );
  const mesh = new THREE.SkinnedMesh(g, new THREE.MeshStandardMaterial()),
    bone = new THREE.Bone();
  mesh.add(bone);
  scene.add(mesh);
  mesh.bind(new THREE.Skeleton([bone]));
  mesh.morphTargetInfluences![0] = 0.4;
  bone.rotation.x = Math.PI / 2;
  bone.position.set(0, 1, 0);
  mesh.position.set(2, 3, 4);
  mesh.scale.set(2, 3, 4);
  scene.updateMatrixWorld(true);
  const before = {
    world: mesh.matrixWorld.toArray(),
    bone: bone.matrixWorld.toArray(),
    inverse: mesh.bindMatrixInverse.toArray(),
    palette: Array.from(mesh.skeleton.boneMatrices ?? []),
  };
  const expected = Array.from({ length: 3 }, (_, i) =>
    mesh
      .getVertexPosition(i, new THREE.Vector3())
      .applyMatrix4(mesh.matrixWorld)
      .toArray(),
  );
  const snapshot = extractSurfaceScene(scene);
  snapshot.triangles[0].vertices.forEach((v, i) =>
    nearVec(v.position, expected[i]),
  );
  assert.deepEqual(mesh.matrixWorld.toArray(), before.world);
  assert.deepEqual(bone.matrixWorld.toArray(), before.bone);
  assert.deepEqual(mesh.bindMatrixInverse.toArray(), before.inverse);
  assert.deepEqual(
    Array.from(mesh.skeleton.boneMatrices ?? []),
    before.palette,
  );
  const expectedNormal = new THREE.Vector3(0, 0, 1)
    .applyMatrix3(
      new THREE.Matrix3().setFromMatrix4(
        mesh.bindMatrixInverse
          .clone()
          .multiply(bone.matrixWorld)
          .multiply(mesh.skeleton.boneInverses[0])
          .multiply(mesh.bindMatrix),
      ),
    )
    .applyMatrix3(new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld))
    .normalize();
  nearVec(snapshot.triangles[0].vertices[0].normal, expectedNormal.toArray());
  bone.rotation.x = 0;
  assert.notDeepEqual(
    extractSurfaceScene(scene).triangles[0].vertices[0].position,
    snapshot.triangles[0].vertices[0].position,
  );
});

test("native InstancedMesh snapshots per-instance world matrices, identity and colors (old extractor loses them)", () => {
  const scene = new THREE.Scene(),
    m = new THREE.MeshStandardMaterial({
      color: new THREE.Color(0.5, 0.5, 0.5),
    }),
    g = geometry(),
    mesh = new THREE.InstancedMesh(g, m, 2);
  mesh.setMatrixAt(0, new THREE.Matrix4().makeTranslation(2, 0, 0));
  mesh.setMatrixAt(
    1,
    new THREE.Matrix4().makeScale(2, 3, 1).setPosition(4, 1, 0),
  );
  mesh.setColorAt(0, new THREE.Color(1, 0, 0));
  mesh.setColorAt(1, new THREE.Color(0, 0, 1));
  mesh.position.set(0, 5, 0);
  scene.add(mesh);
  const snapshot = extractSurfaceScene(scene);
  assert.equal(snapshot.triangles.length, 4);
  assert.equal(snapshot.materials.length, 1);
  assert.deepEqual(
    snapshot.triangles.map((t) => t.instanceId),
    [0, 0, 1, 1],
  );
  nearVec(snapshot.triangles[0].vertices[0].position, [2, 5, 0]);
  nearVec(snapshot.triangles[2].vertices[1].position, [6, 6, 0]);
  nearVec(sampleSurfaceMaterial(snapshot, 0, bary).baseColor, [0.5, 0, 0]);
  nearVec(sampleSurfaceMaterial(snapshot, 2, bary).baseColor, [0, 0, 0.5]);
  assert.equal(extractTriangles(scene).length, 2);
  assert.deepEqual(snapshot.triangles[2].instanceColor, [0, 0, 1]);
});

test("immutable shared texture/material records detach pixels, transforms and factors from source", () => {
  const t = dataTexture([128, 64, 32, 255]),
    m = new THREE.MeshStandardMaterial({ map: t });
  const { scene, mesh } = setup(m);
  scene.add(new THREE.Mesh(mesh.geometry, m));
  const s = extractSurfaceScene(scene),
    before = sampleSurfaceMaterial(s, 0, bary);
  frozenTree(s);
  assert.equal(s.textures.length, 1);
  assert.equal(s.materials.length, 1);
  (t.image.data as Uint8Array).fill(0);
  t.offset.set(9, 8);
  m.color.set(0x00ff00);
  mesh.position.x = 8;
  assert.deepEqual(sampleSurfaceMaterial(s, 0, bary), before);
  assert.deepEqual(s.textures[0].offset, [0, 0]);
  assert.throws(() => {
    (s.triangles as unknown as unknown[]).push({});
  }, TypeError);
  assert.throws(() => {
    (s.textures[0].pixels as number[])[0] = 0;
  }, TypeError);
});

test("visible ancestry, scene subtree, noTrace, layers and hidden materials have explicit traversal semantics", () => {
  const { scene, mesh } = setup();
  const hidden = new THREE.Group();
  hidden.visible = false;
  scene.add(hidden);
  hidden.add(new THREE.Mesh(geometry(), new THREE.MeshStandardMaterial()));
  mesh.layers.set(2);
  const child = new THREE.Mesh(geometry(), new THREE.MeshStandardMaterial());
  child.layers.set(0);
  mesh.add(child);
  const outside = new THREE.Group();
  outside.position.x = 4;
  outside.add(
    scene,
    new THREE.Mesh(geometry(), new THREE.MeshStandardMaterial()),
  );
  const s = extractSurfaceScene(scene, { layersMask: 1 });
  assert.equal(s.triangles.length, 2);
  assert.equal(s.triangles[0].objectUuid, child.uuid);
  assert.equal(s.triangles[0].vertices[0].position[0], 4);
  mesh.userData.noTrace = true;
  assert.equal(extractSurfaceScene(scene).triangles.length, 2);
  mesh.visible = false;
  assert.equal(extractSurfaceScene(scene).triangles.length, 0);
  const invisible = new THREE.MeshStandardMaterial();
  invisible.visible = false;
  assert.equal(extractSurfaceScene(setup(invisible).scene).triangles.length, 0);
});

test("alpha factor/map channels, masks, transparent cutoff and material sides", () => {
  const alphaMap = dataTexture([255, 64, 255, 255]),
    map = dataTexture([255, 255, 255, 128]);
  const m = new THREE.MeshStandardMaterial({
    map,
    alphaMap,
    opacity: 0.8,
    alphaTest: 0.2,
    side: THREE.DoubleSide,
  });
  const { scene } = setup(m);
  let sample = sampleSurfaceMaterial(extractSurfaceScene(scene), 0, bary, {
    frontFacing: false,
  });
  near(sample.alpha, (((0.8 * 128) / 255) * 64) / 255);
  assert.equal(sample.coverage, 0);
  assert.equal(sample.discarded, true);
  nearVec(sample.normal, [0, 0, -1]);
  m.transparent = true;
  sample = sampleSurfaceMaterial(extractSurfaceScene(scene), 0, bary);
  assert.equal(sample.alphaMode, "blend");
  assert.equal(sample.discarded, true);
  assert.equal(sample.coverage, 0);
  m.alphaTest = 0;
  sample = sampleSurfaceMaterial(extractSurfaceScene(scene), 0, bary);
  assert.equal(sample.discarded, false);
  near(sample.coverage, sample.alpha);
  m.transparent = false;
  sample = sampleSurfaceMaterial(extractSurfaceScene(scene), 0, bary);
  assert.equal(sample.alphaMode, "opaque");
  assert.equal(sample.coverage, 1);
  m.side = THREE.BackSide;
  assert.equal(
    sampleSurfaceMaterial(extractSurfaceScene(scene), 0, bary).discarded,
    true,
  );
});

test("positive alpha cutoff includes equality for mask and blend; zero disables cutoff", () => {
  for (const transparent of [false, true]) {
    const material = new THREE.MeshStandardMaterial({ opacity: 0.5, alphaTest: 0.5, transparent, side: THREE.DoubleSide });
    const { scene } = setup(material);
    assert.equal(sampleSurfaceMaterial(extractSurfaceScene(scene), 0, bary).discarded, true);
    material.alphaTest = 0.499;
    assert.equal(sampleSurfaceMaterial(extractSurfaceScene(scene), 0, bary).discarded, false);
    material.opacity = 0;
    material.alphaTest = 0;
    assert.equal(sampleSurfaceMaterial(extractSurfaceScene(scene), 0, bary).discarded, false);
  }
});

test("ordinary image texture retains identity without DOM and sampling fails until external pixels are supplied", () => {
  const texture = new THREE.Texture({
    width: 1,
    height: 2,
  } as unknown as HTMLImageElement);
  texture.flipY = true;
  const { scene } = setup(new THREE.MeshStandardMaterial({ map: texture }));
  const noPixels = extractSurfaceScene(scene);
  assert.equal(noPixels.textures[0].uuid, texture.uuid);
  assert.equal(noPixels.textures[0].pixels, undefined);
  assert.ok(
    noPixels.diagnostics.some(
      (d) => d.code === "SURFACE_TEXTURE_PIXELS_UNAVAILABLE",
    ),
  );
  expectCode(
    () => sampleSurfaceMaterial(noPixels, 0, bary),
    "SURFACE_TEXTURE_PIXELS_UNAVAILABLE",
  );
  let calls = 0;
  const bytes = new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255]);
  const snapshot = extractSurfaceScene(scene, {
    decodedTextureProvider: (t) => {
      assert.equal(t, texture);
      calls++;
      return {
        width: 1,
        height: 2,
        data: bytes,
        channels: 4,
        encoding: "unorm8",
        origin: "image",
      };
    },
  });
  assert.equal(calls, 1);
  nearVec(
    sampleSurfaceMaterial(snapshot, 0, bary, { uv0: [0.5, 0.25] }).baseColor,
    [0, 1, 0],
  );
  bytes.fill(0);
  nearVec(
    sampleSurfaceMaterial(snapshot, 0, bary, { uv0: [0.5, 0.75] }).baseColor,
    [1, 0, 0],
  );
});

test("DataTexture row flip and RGB/RG/Red default channels follow actual GPU texture semantics", () => {
  const t = dataTexture([255, 0, 0, 255, 0, 255, 0, 255], 1, 2);
  t.flipY = true;
  let s = extractSurfaceScene(
    setup(new THREE.MeshStandardMaterial({ map: t })).scene,
  );
  nearVec(
    sampleSurfaceMaterial(s, 0, bary, { uv0: [0.5, 0.25] }).baseColor,
    [0, 1, 0],
  );
  const red = new THREE.DataTexture(
    new Uint8Array([128]),
    1,
    1,
    THREE.RedFormat,
  );
  s = extractSurfaceScene(
    setup(new THREE.MeshStandardMaterial({ map: red })).scene,
  );
  const sample = sampleSurfaceMaterial(s, 0, bary);
  nearVec(sample.baseColor, [128 / 255, 0, 0]);
  near(sample.alpha, 1);
});

test("invalid geometry/groups/indices/nonfinite data are rejected with stable codes", () => {
  expectCode(
    () =>
      extractSurfaceScene(
        setup(new THREE.MeshStandardMaterial(), new THREE.BufferGeometry())
          .scene,
      ),
    "SURFACE_POSITION_MISSING",
  );
  let input = setup([new THREE.MeshStandardMaterial()]);
  input.g.addGroup(0, 3, 2);
  expectCode(
    () => extractSurfaceScene(input.scene),
    "SURFACE_MATERIAL_INDEX_MISSING",
  );
  input = setup([new THREE.MeshStandardMaterial()]);
  input.g.addGroup(1, 3, 0);
  expectCode(
    () => extractSurfaceScene(input.scene),
    "SURFACE_TRIANGLE_BOUNDARY_INVALID",
  );
  const indexed = setup();
  indexed.g.setIndex([0, 1, 99]);
  expectCode(() => extractSurfaceScene(indexed.scene), "SURFACE_INDEX_INVALID");
  const nonfinite = setup();
  nonfinite.g.getAttribute("position").setX(0, NaN);
  expectCode(() => extractSurfaceScene(nonfinite.scene), "SURFACE_NON_FINITE");
  const uv = setup();
  uv.g.getAttribute("uv").setX(0, Infinity);
  expectCode(() => extractSurfaceScene(uv.scene), "SURFACE_NON_FINITE");
  const singular = setup();
  singular.mesh.scale.x = 0;
  expectCode(
    () => extractSurfaceScene(singular.scene),
    "SURFACE_SINGULAR_TRANSFORM",
  );
  const degenerate = setup();
  degenerate.g.getAttribute("position").setXYZ(1, 0, 0, 0);
  expectCode(
    () => extractSurfaceScene(degenerate.scene),
    "SURFACE_DEGENERATE_TRIANGLE",
  );
});

test("unknown materials, graph, active extensions, custom deformation and instanced morph are never silently faithful", async () => {
  expectCode(
    () => extractSurfaceScene(setup(new THREE.MeshBasicMaterial()).scene),
    "SURFACE_MATERIAL_UNSUPPORTED",
  );
  const webgpu = await import("three/webgpu");
  expectCode(
    () =>
      extractSurfaceScene(setup(new webgpu.MeshStandardNodeMaterial()).scene),
    "SURFACE_NODE_GRAPH_UNSUPPORTED",
  );
  for (const property of [
    "clearcoat",
    "diffuseRoughness",
    "retroreflectivity",
  ]) {
    const m = new THREE.MeshPhysicalMaterial();
    (m as unknown as Record<string, unknown>)[property] = 0.5;
    expectCode(
      () => extractSurfaceScene(setup(m).scene),
      "SURFACE_PHYSICAL_EXTENSION_UNSUPPORTED",
    );
  }
  const ext = new THREE.MeshStandardMaterial();
  ext.userData.gltfExtensions = { EXT_unknown_surface: {} };
  expectCode(
    () => extractSurfaceScene(setup(ext).scene),
    "SURFACE_EXTENSION_UNSUPPORTED",
  );
  class Deformed extends THREE.Mesh {}
  const scene = new THREE.Scene();
  scene.add(new Deformed(geometry(), new THREE.MeshStandardMaterial()));
  expectCode(
    () => extractSurfaceScene(scene),
    "SURFACE_DEFORMATION_UNSUPPORTED",
  );
  const custom = setup();
  custom.mesh.getVertexPosition = (_i, t) => t.set(9, 9, 9);
  expectCode(
    () => extractSurfaceScene(custom.scene),
    "SURFACE_DEFORMATION_UNSUPPORTED",
  );
  const inst = new THREE.InstancedMesh(
    geometry(),
    new THREE.MeshStandardMaterial(),
    1,
  );
  inst.morphTexture = dataTexture([0, 0, 0, 0]);
  const instScene = new THREE.Scene();
  instScene.add(inst);
  expectCode(
    () => extractSurfaceScene(instScene),
    "SURFACE_INSTANCE_MORPH_UNSUPPORTED",
  );
});

test("valid scene without materials groups draws nothing; single-material ignores groups; missing UV fails sampling", () => {
  const { scene, g } = setup([new THREE.MeshStandardMaterial()]);
  assert.equal(extractSurfaceScene(scene).triangles.length, 0);
  const single = setup();
  single.g.addGroup(0, 3, 5);
  assert.equal(extractSurfaceScene(single.scene).triangles.length, 2);
  const textured = setup(
    new THREE.MeshStandardMaterial({ map: dataTexture([1, 2, 3, 255]) }),
  );
  textured.g.deleteAttribute("uv");
  expectCode(
    () => sampleSurfaceMaterial(extractSurfaceScene(textured.scene), 0, bary),
    "SURFACE_UV_MISSING",
  );
  expectCode(
    () =>
      sampleSurfaceMaterial(extractSurfaceScene(single.scene), 0, [NaN, 0, 1]),
    "SURFACE_BARYCENTRIC_INVALID",
  );
});
