import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import {
  extractSurfaceScene,
  isFrozenCapturedPixels,
} from "../packages/renderer/src/surface.ts";
import { createSurfaceAcceleration } from "../packages/renderer/src/acceleration.ts";
test("trusted frozen pixel storage bypasses property enumeration without trusting cloned or mutable data", () => {
  const scene = new THREE.Scene(),
    texture = new THREE.DataTexture(
      new Uint8Array([10, 20, 30, 255, 255, 50, 20, 255]),
      2,
      1,
    );
  scene.add(
    new THREE.Mesh(
      new THREE.PlaneGeometry(),
      new THREE.MeshStandardMaterial({ map: texture }),
    ),
  );
  const surface = extractSurfaceScene(scene),
    pixels = surface.textures[0].pixels!;
  assert.equal(isFrozenCapturedPixels(pixels), true);
  assert.equal(isFrozenCapturedPixels(Object.freeze([...pixels])), false);
  assert.equal(isFrozenCapturedPixels([...pixels]), false);
  const acceleration = createSurfaceAcceleration(),
    ownKeys = Reflect.ownKeys;
  Reflect.ownKeys = function (value) {
    if (value === pixels)
      throw new Error("Large dense pixel enumeration is forbidden");
    return ownKeys(value);
  };
  try {
    acceleration.update(surface);
    assert.equal(acceleration.update(surface).changes.kind, "none");
  } finally {
    Reflect.ownKeys = ownKeys;
    acceleration.dispose();
  }
  const invalid = {
    ...surface,
    textures: [
      {
        ...surface.textures[0],
        pixels: Object.freeze([NaN, ...pixels.slice(1)]),
      },
    ],
  };
  const other = createSurfaceAcceleration();
  try {
    assert.throws(
      () => other.update(invalid),
      /TC_ACCELERATION_INVALID_SNAPSHOT/,
    );
  } finally {
    other.dispose();
  }
});
