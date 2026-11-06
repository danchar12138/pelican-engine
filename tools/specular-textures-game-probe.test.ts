import assert from "node:assert/strict";
import test from "node:test";
import {
  SPECULAR_TEXTURE_LIFECYCLE_OPERATIONS,
  checkSpecularObservation,
  checkTraceCapabilities,
} from "./specular-textures-game-probe.ts";

test("specular texture lifecycle documents every public operation", () => {
  assert.deepEqual(
    SPECULAR_TEXTURE_LIFECYCLE_OPERATIONS.map((item) => item.id),
    [
      "initial-raster",
      "path-activation",
      "three-mode-pixels",
      "snapshot-restore",
      "invalid-restore",
      "device-recovery",
    ],
  );
  assert.ok(SPECULAR_TEXTURE_LIFECYCLE_OPERATIONS.every((item) => item.operation && item.expected));
});

test("trace capability checks distinguish lazy raster from active path", () => {
  checkTraceCapabilities(
    { tracer: "WebGPU surface triangle-BVH (lazy initialization)", tracerInitialized: false },
    false,
  );
  checkTraceCapabilities(
    { tracer: "WebGPU surface triangle-BVH", tracerInitialized: true },
    true,
  );
  assert.throws(() => checkTraceCapabilities({ tracer: "WebGPU surface triangle-BVH", tracerInitialized: false }, true));
});

test("pixel and resource observation rejects missing lifecycle resources", () => {
  const observation = {
    mode: "path",
    samples: {
      gray: [80, 80, 80],
      zeroAlphaRed: [0, 0, 0],
      red: [220, 5, 5],
      green: [5, 220, 5],
      grayReference: [80, 80, 80],
    },
    surface: {
      triangleCount: 4,
      capture: { textures: { entries: 2, texels: 512 } },
    },
    models: { disposed: false, instances: 1, owned: { textures: 1 } },
    resources: { disposed: false, owned: { loaded: 1 } },
    capabilities: { tracerInitialized: true },
  };
  checkSpecularObservation(observation);
  assert.throws(() => checkSpecularObservation({ ...observation, resources: { disposed: false, owned: { loaded: 0 } } }));
});
