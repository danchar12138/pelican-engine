import assert from "node:assert/strict";
import * as THREE from "three";
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser } from "playwright";
import { extractSurfaceScene } from "../packages/renderer/src/surface.ts";
import type { SurfaceTriangle } from "../packages/renderer/src/surface.ts";
import { createSurfaceAcceleration } from "../packages/renderer/src/acceleration.ts";
import {
  packSurfaceGeometry,
  packSurfaceResources,
} from "../packages/renderer/src/surface-gpu.ts";
import { packPreviousSurfacePositions } from "../packages/renderer/src/surface-motion.ts";
import { packTraversalData } from "../packages/renderer/src/traversal-nodes.ts";
import { SURFACE_SHADER } from "../packages/renderer/src/surface-shader.ts";
import { SURFACE_RAY_SHADER } from "../packages/renderer/src/surface-ray-shader.ts";
import { MOTION_SHADER } from "../packages/renderer/src/motion-shader.ts";
import {
  PRIMARY_SHADER,
  PATH_SHADER,
} from "../packages/renderer/src/path-shader.ts";
import { BSDF_SHADER } from "../packages/renderer/src/bsdf.ts";
import { DIELECTRIC_SHADER } from "../packages/renderer/src/dielectric.ts";
import { VOLUME_SHADER } from "../packages/renderer/src/volume-shader.ts";
import {
  automationLaunchOptions,
  withAutomationDeadline,
} from "./browser-session.ts";

export const MOTION_PROBE_WIDTH = 12;
export const MOTION_PROBE_HEIGHT = 8;
export const MOTION_PROBE_TOLERANCE = 2e-5;
export type MotionProbeMode = "path" | "hybrid";
export type MotionProbeSample = [number, number, number, number];

/** Emulate the shared WGSL PCG's u32 arithmetic and f32 conversion. */
export function motionProbeRandom(seed: number): {
  seed: number;
  value: number;
} {
  seed = (Math.imul(seed, 747796405) + 2891336453) >>> 0;
  const word =
    Math.imul((seed >>> ((seed >>> 28) + 4)) ^ seed, 277803737) >>> 0;
  return {
    seed,
    value: Math.min(
      Math.fround(((word >>> 22) ^ word) >>> 0) / 4294967296,
      Math.fround(0.99999994),
    ),
  };
}

export function motionProbeJitter(index: number, frame: number) {
  let random = motionProbeRandom(
    (Math.imul(index, 1973) + Math.imul(frame, 9277) + 89173) >>> 0,
  );
  const x = random.value;
  random = motionProbeRandom(random.seed);
  const y = random.value;
  random = motionProbeRandom(random.seed);
  return { x, y, coverage: random.value };
}

export function motionProbeHalton(index: number, base: number): number {
  assert.ok(Number.isSafeInteger(index) && index >= 0);
  assert.ok(Number.isSafeInteger(base) && base >= 2);
  let fraction = 1,
    result = 0;
  while (index > 0) {
    fraction /= base;
    result += fraction * (index % base);
    index = Math.floor(index / base);
  }
  return result;
}

/** Reference rays use uniforms, never raster/GPU hit or barycentric readback. */
export function motionProbeRay(
  params: ArrayLike<number>,
  x: number,
  y: number,
) {
  const width = params[20],
    height = params[21];
  const jitter =
    params[32] > 0.5
      ? { x: 0.5 + params[7], y: 0.5 + params[11], coverage: 0 }
      : motionProbeJitter(y * width + x, params[22]);
  const pixelX = ((x + jitter.x) / width) * 2 - 1;
  const pixelY = ((y + jitter.y) / height) * 2 - 1;
  const forward = new THREE.Vector3(params[4], params[5], params[6]);
  const direction = forward
    .clone()
    .addScaledVector(
      new THREE.Vector3(params[8], params[9], params[10]),
      pixelX,
    )
    .addScaledVector(
      new THREE.Vector3(params[12], params[13], params[14]),
      -pixelY,
    )
    .normalize();
  const cosine = Math.max(direction.dot(forward), 1e-5);
  const origin = new THREE.Vector3(
    params[0],
    params[1],
    params[2],
  ).addScaledVector(direction, params[23] / cosine);
  return {
    origin: origin.toArray(),
    direction: direction.toArray(),
    maxDistance: (params[31] - params[23]) / cosine,
    coverage: jitter.coverage,
  };
}

/** Full identity, deliberately independent of packed previous-position data. */
export function motionProbeTriangleKey(triangle: SurfaceTriangle): string {
  return JSON.stringify([
    triangle.objectUuid,
    triangle.geometryUuid,
    triangle.instanceId,
    triangle.groupIndex,
    triangle.elementOffset,
    triangle.vertexIndices,
  ]);
}

export function motionProbeReference(
  previous: SurfaceTriangle | undefined,
  barycentric: readonly number[],
  previousViewProjection: THREE.Matrix4,
  previousCameraOrigin: THREE.Vector3 | undefined,
): MotionProbeSample {
  if (!previous || !previousCameraOrigin) return [0, 0, 0, 0];
  const world = new THREE.Vector3();
  previous.vertices.forEach((vertex, index) => {
    world.addScaledVector(
      new THREE.Vector3(...vertex.position),
      barycentric[index],
    );
  });
  const clip = new THREE.Vector4(world.x, world.y, world.z, 1).applyMatrix4(
    previousViewProjection,
  );
  if (clip.w <= 0) return [0, 0, 0, 0];
  return [
    (clip.x / clip.w) * 0.5 + 0.5,
    -(clip.y / clip.w) * 0.5 + 0.5,
    world.distanceTo(previousCameraOrigin),
    1,
  ];
}

/** Byte minima for storage bindings 0..4, output 6, and uniform 7. */
export function motionProbeBufferSizes(
  lengths: readonly [number, number, number, number, number],
) {
  return {
    storage: lengths.map((length, binding) =>
      Math.max([288, 128, 96, 4, 16][binding], length * 4),
    ),
    output: MOTION_PROBE_WIDTH * MOTION_PROBE_HEIGHT * 16,
    uniform: 368,
  };
}

function viewProjection(
  camera: THREE.PerspectiveCamera,
  mode: MotionProbeMode,
  serial: number,
) {
  camera.updateWorldMatrix(true, false);
  const projection = camera.projectionMatrix.clone();
  if (mode === "hybrid") {
    projection.elements[8] +=
      (2 * motionProbeHalton(serial + 1, 2)) / MOTION_PROBE_WIDTH;
    projection.elements[9] -=
      (2 * motionProbeHalton(serial + 1, 3)) / MOTION_PROBE_HEIGHT;
  }
  return projection.multiply(camera.matrixWorldInverse);
}

function parameters(
  camera: THREE.PerspectiveCamera,
  previousCamera: THREE.PerspectiveCamera | undefined,
  mode: MotionProbeMode,
  serial: number,
  nodes: number,
  triangles: number,
) {
  camera.updateWorldMatrix(true, false);
  const forward = camera.getWorldDirection(new THREE.Vector3());
  const spread = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
  const right = new THREE.Vector3()
    .setFromMatrixColumn(camera.matrixWorld, 0)
    .multiplyScalar(spread * camera.aspect);
  const up = new THREE.Vector3()
    .setFromMatrixColumn(camera.matrixWorld, 1)
    .multiplyScalar(spread);
  const previousView = previousCamera
    ? viewProjection(previousCamera, mode, serial - 1)
    : new THREE.Matrix4();
  // First 72 floats follow SurfaceTracer.render; inactive light/environment/medium fields are explicit.
  const params = new Float32Array([
    ...camera.position.toArray(),
    0,
    ...forward.toArray(),
    mode === "hybrid" ? motionProbeHalton(serial + 1, 2) : 0,
    ...right.toArray(),
    mode === "hybrid" ? motionProbeHalton(serial + 1, 3) : 0,
    ...up.toArray(),
    0,
    0,
    0,
    0,
    0,
    MOTION_PROBE_WIDTH,
    MOTION_PROBE_HEIGHT,
    serial,
    camera.near,
    nodes,
    triangles,
    0,
    1,
    1,
    1,
    4,
    camera.far,
    mode === "hybrid" ? 1 : 0,
    0,
    1,
    1,
    ...viewProjection(camera, mode, serial).elements,
    -1,
    1,
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
    0,
    0,
    0,
    0,
    0,
    ...previousView.elements,
    ...(previousCamera?.position.toArray() ?? [0, 0, 0]),
    previousCamera ? 1 : 0,
  ]);
  assert.equal(params.length, 92);
  return { params, previousView };
}

export interface MotionProbePacket {
  forceRefinement?: boolean;
  name: string;
  mode: MotionProbeMode;
  width: number;
  height: number;
  geometry: number[];
  materials: number[];
  textures: number[];
  texels: number[];
  traversal: number[];
  params: number[];
  sourceIndices: number[];
  triangleCount: number;
  nodeCount: number;
  accelerationKind: string;
  matched: number;
  missing: number;
  cpuHits: ({
    sourceIndex: number;
    barycentric: number[];
    distance: number;
    coverage: number;
  } | null)[];
  expected: MotionProbeSample[];
  bufferSizes: ReturnType<typeof motionProbeBufferSizes>;
}

export function buildPrimaryRefinementPacket(
  packets: readonly MotionProbePacket[],
): MotionProbePacket {
  const original = packets.find(
    (packet) => packet.name === "static" && packet.mode === "hybrid",
  );
  assert.ok(
    original,
    "A real hybrid static packet is required for the refinement contract.",
  );
  return {
    ...structuredClone(original),
    name: "forced-primary-refinement",
    forceRefinement: true,
  };
}

/** CPU-only fixture construction; importing or calling this never starts automation. */
export function buildMotionProbePackets(): MotionProbePacket[] {
  assert.equal(
    THREE.REVISION,
    "187",
    "Probe requires the locked Three geometry implementation",
  );
  const packets: MotionProbePacket[] = [];
  const names = [
    "static",
    "rigid-transform",
    "camera-transform",
    "mirror",
    "topology-missing-previous",
    "no-previous-surface",
    "no-previous-camera",
    "skin-morph",
    "empty",
  ];
  for (const mode of ["path", "hybrid"] as const)
    for (const [caseIndex, name] of names.entries()) {
      const scene = new THREE.Scene();
      const material = new THREE.MeshStandardMaterial({
        color: 0xc44e68,
        side: THREE.DoubleSide,
      });
      const geometries: THREE.BufferGeometry[] = [];
      const acceleration = createSurfaceAcceleration();
      let skeleton: THREE.Skeleton | undefined;
      try {
        const geometry =
          name === "skin-morph"
            ? new THREE.PlaneGeometry(2, 1.4, 2, 2)
            : new THREE.BoxGeometry(2, 1.4, 0.6);
        geometries.push(geometry);
        let mesh: THREE.Mesh;
        let bone: THREE.Bone | undefined;
        if (name === "skin-morph") {
          const count = geometry.getAttribute("position").count;
          geometry.morphTargetsRelative = true;
          geometry.morphAttributes.position = [
            new THREE.Float32BufferAttribute(
              Array.from({ length: count }, (_, i) => [
                0.08 * (i % 3),
                0.03,
                0.12 * (i % 2),
              ]).flat(),
              3,
            ),
          ];
          geometry.setAttribute(
            "skinIndex",
            new THREE.Uint16BufferAttribute(new Uint16Array(count * 4), 4),
          );
          geometry.setAttribute(
            "skinWeight",
            new THREE.Float32BufferAttribute(
              Array.from({ length: count }, () => [1, 0, 0, 0]).flat(),
              4,
            ),
          );
          const skin = new THREE.SkinnedMesh(geometry, material);
          bone = new THREE.Bone();
          skin.add(bone);
          scene.add(skin);
          skeleton = new THREE.Skeleton([bone]);
          skin.bind(skeleton);
          skin.morphTargetInfluences![0] = 0.2;
          mesh = skin;
        } else {
          mesh = new THREE.Mesh(geometry, material);
          scene.add(mesh);
        }
        const companionGeometry = new THREE.BoxGeometry(0.5, 0.55, 0.5);
        geometries.push(companionGeometry);
        const companion = new THREE.Mesh(companionGeometry, material);
        companion.position.set(-1.35, 0.36, 0.15);
        scene.add(companion);
        const camera = new THREE.PerspectiveCamera(
          50,
          MOTION_PROBE_WIDTH / MOTION_PROBE_HEIGHT,
          0.1,
          20,
        );
        camera.coordinateSystem = THREE.WebGPUCoordinateSystem;
        camera.position.set(0.05, 0.08, 3.8);
        camera.lookAt(0, 0, 0);
        camera.updateProjectionMatrix();
        camera.updateMatrixWorld(true);
        const previousCamera = camera.clone();
        const previous = extractSurfaceScene(scene);
        acceleration.update(previous);
        if (name === "rigid-transform") {
          mesh.position.set(0.18, -0.13, 0.09);
          mesh.rotation.set(0.08, 0.28, -0.12);
        } else if (name === "camera-transform") {
          camera.position.set(0.3, -0.12, 3.65);
          camera.lookAt(0.03, 0.06, 0);
        } else if (name === "mirror") {
          mesh.scale.set(-1, 0.9, 1.1);
          mesh.rotation.y = 0.18;
        } else if (name === "topology-missing-previous") {
          mesh.geometry = new THREE.BoxGeometry(1.9, 1.3, 0.65, 2, 1, 1);
          geometries.push(mesh.geometry);
        } else if (bone) {
          bone.rotation.z = 0.16;
          bone.position.set(0.12, -0.06, 0.08);
          mesh.morphTargetInfluences![0] = 0.8;
        }
        if (name === "empty") scene.clear();
        const current = extractSurfaceScene(scene);
        const frame = acceleration.update(current);
        const history = name === "no-previous-surface" ? undefined : previous;
        const oldCamera =
          name === "no-previous-camera" ? undefined : previousCamera;
        const previousPositions = packPreviousSurfacePositions(
          history,
          current,
          frame.orderedTriangles,
        );
        const triangles = packSurfaceGeometry(current, frame.orderedTriangles);
        assert.equal(triangles.length, frame.metrics.triangles * 72);
        assert.equal(
          previousPositions.data.length,
          frame.metrics.triangles * 12,
        );
        const geometryData = new Float32Array(
          triangles.length + previousPositions.data.length,
        );
        geometryData.set(triangles);
        geometryData.set(previousPositions.data, triangles.length);
        // Traversal consumes just the 72-float prefix, not appended motion records.
        const traversal = packTraversalData(frame.nodes, triangles);
        const resources = packSurfaceResources(current);
        const { params, previousView } = parameters(
          camera,
          oldCamera,
          mode,
          11 + caseIndex,
          frame.metrics.nodes,
          frame.metrics.triangles,
        );
        const oldTriangles = new Map(
          history?.triangles.map((t) => [motionProbeTriangleKey(t), t]),
        );
        const expected: MotionProbeSample[] = [],
          cpuHits: MotionProbePacket["cpuHits"] = [];
        for (let y = 0; y < MOTION_PROBE_HEIGHT; y++)
          for (let x = 0; x < MOTION_PROBE_WIDTH; x++) {
            const ray = motionProbeRay(params, x, y);
            const hit = acceleration.intersect(
              ray.origin,
              ray.direction,
              ray.maxDistance,
            );
            cpuHits.push(
              hit
                ? {
                    sourceIndex: hit.triangleIndex,
                    barycentric: [...hit.barycentric],
                    distance: hit.distance,
                    coverage: ray.coverage,
                  }
                : null,
            );
            expected.push(
              hit
                ? motionProbeReference(
                    oldTriangles.get(
                      motionProbeTriangleKey(
                        current.triangles[hit.triangleIndex],
                      ),
                    ),
                    hit.barycentric,
                    previousView,
                    oldCamera?.position,
                  )
                : [0, 0, 0, 0],
            );
          }
        packets.push({
          name,
          mode,
          width: MOTION_PROBE_WIDTH,
          height: MOTION_PROBE_HEIGHT,
          geometry: Array.from(geometryData),
          materials: Array.from(resources.materials),
          textures: Array.from(
            new Uint32Array(
              resources.textures.buffer,
              resources.textures.byteOffset,
              resources.textures.byteLength / 4,
            ),
          ),
          texels: Array.from(resources.texels),
          traversal: Array.from(traversal),
          params: Array.from(params),
          sourceIndices: Array.from(frame.sourceIndices),
          triangleCount: frame.metrics.triangles,
          nodeCount: frame.metrics.nodes,
          accelerationKind: frame.changes.kind,
          matched: previousPositions.matched,
          missing: previousPositions.missing,
          expected,
          cpuHits,
          bufferSizes: motionProbeBufferSizes([
            geometryData.length,
            resources.materials.length,
            resources.textures.length,
            resources.texels.length,
            traversal.length,
          ]),
        });
      } finally {
        acceleration.dispose();
        skeleton?.dispose();
        for (const geometry of geometries) geometry.dispose();
        material.dispose();
      }
    }
  return packets;
}

export function compareMotionProbeSamples(
  expected: readonly MotionProbeSample[],
  actual: readonly number[],
) {
  const failures: string[] = [];
  let maxUVError = 0,
    maxDepthError = 0;
  if (actual.length !== expected.length * 4)
    failures.push(
      "Readback length " + actual.length + " != " + expected.length * 4,
    );
  for (const [index, reference] of expected.entries()) {
    const sample = actual.slice(index * 4, index * 4 + 4);
    if (
      sample.length !== 4 ||
      sample.some((value) => !Number.isFinite(value))
    ) {
      failures.push(
        "Pixel " + index + ": missing/non-finite readback " + sample.join(","),
      );
      continue;
    }
    const uvError = Math.max(
      Math.abs(sample[0] - reference[0]),
      Math.abs(sample[1] - reference[1]),
    );
    const depthError = Math.abs(sample[2] - reference[2]);
    maxUVError = Math.max(maxUVError, uvError);
    maxDepthError = Math.max(maxDepthError, depthError);
    if (
      sample[3] !== reference[3] ||
      (reference[3] === 0 && sample.some((value) => value !== 0)) ||
      uvError > MOTION_PROBE_TOLERANCE ||
      depthError > MOTION_PROBE_TOLERANCE
    )
      failures.push(
        "Pixel " +
          index +
          ": expected=" +
          reference.join(",") +
          " actual=" +
          sample.join(",") +
          " UVerror=" +
          uvError +
          " depthError=" +
          depthError,
      );
  }
  return { maxUVError, maxDepthError, failures };
}

interface GpuCaseResult {
  name: string;
  mode: MotionProbeMode;
  actual: number[];
  primary: number[];
  transport?: number[];
  errors: string[];
}

interface GpuResult {
  backend: "webgpu" | null;
  adapter: Record<string, unknown> | null;
  compilation: Record<string, unknown>[];
  errors: string[];
  cases: GpuCaseResult[];
}

// Plain browser JavaScript avoids tsx/esbuild helper captures in page.evaluate.
export const MOTION_PROBE_BROWSER_SOURCE = String.raw`
async packet => {
  const result = { backend: null, adapter: null, compilation: [], errors: [], cases: [] };
  let device;
  let openScopes = 0;
  const progress = async () => { await globalThis.__motionProbeProgress(result); };
  const pushScopes = () => {
    for (const filter of ['out-of-memory', 'internal', 'validation']) {
      device.pushErrorScope(filter);
      openScopes++;
    }
  };
  const popScopes = async errors => {
    while (openScopes > 0) {
      openScopes--;
      try {
        const error = await device.popErrorScope();
        if (error) errors.push(error.constructor.name + ': ' + error.message);
      } catch (error) { errors.push(String(error)); }
    }
  };
  try {
    if (!navigator.gpu) throw Error('TC_MOTION_WEBGPU_UNAVAILABLE');
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) throw Error('TC_MOTION_ADAPTER_UNAVAILABLE');
    const info = adapter.info;
    result.adapter = {
      vendor: info.vendor, architecture: info.architecture, device: info.device,
      description: info.description, isFallbackAdapter: info.isFallbackAdapter,
      features: Array.from(adapter.features),
    };
    await progress();
    if (info.isFallbackAdapter) throw Error('TC_MOTION_HARDWARE_REQUIRED: fallback adapter');
    device = await adapter.requestDevice();
    result.backend = 'webgpu';
    device.addEventListener('uncapturederror', event => result.errors.push('Uncaptured: ' + event.error.message));
    device.lost.then(info => {
      if (info.reason !== 'destroyed') result.errors.push('Device lost: ' + info.reason + ': ' + info.message);
    });
    let motionPipeline, primaryPipeline, transportPipeline;
    pushScopes();
    try {
      const modules = [];
      for (const [label, code] of [['motion', packet.motionShader], ['primary', packet.primaryShader], ['transport', packet.transportShader]]) {
        const module = device.createShaderModule({ label, code });
        const compilation = await module.getCompilationInfo();
        for (const message of compilation.messages) result.compilation.push({
          shader: label, type: message.type, message: message.message,
          lineNum: message.lineNum, linePos: message.linePos, offset: message.offset, length: message.length,
        });
        modules.push(module);
      }
      if (result.compilation.some(message => message.type === 'error')) throw Error('TC_MOTION_SHADER_COMPILATION');
      const motionLayout = device.createBindGroupLayout({ entries: [
        ...[288, 128, 96, 4, 16].map((minBindingSize, binding) => ({ binding, visibility: GPUShaderStage.COMPUTE,
          buffer: { type: 'read-only-storage', minBindingSize } })),
        { binding: 6, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage', minBindingSize: 16 } },
        { binding: 7, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform', minBindingSize: 368 } },
        { binding: 8, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'unfilterable-float', viewDimension: '2d' } },
      ] });
      const primaryLayout = device.createBindGroupLayout({ entries: [
        ...[288, 128, 96, 4].map((minBindingSize, binding) => ({ binding,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage', minBindingSize } })),
        { binding: 7, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform', minBindingSize: 368 } },
      ] });
      motionPipeline = await device.createComputePipelineAsync({
        label: 'motion numeric probe', layout: device.createPipelineLayout({ bindGroupLayouts: [motionLayout] }),
        compute: { module: modules[0], entryPoint: 'motionMain', constants: { surfacePhysicalEnabled: 1, surfaceOrderedTraversal: 0 } },
      });
      primaryPipeline = await device.createRenderPipelineAsync({
        label: 'real hybrid primary visibility', layout: device.createPipelineLayout({ bindGroupLayouts: [primaryLayout] }),
        vertex: { module: modules[1], entryPoint: 'primaryVertex' },
        fragment: { module: modules[1], entryPoint: 'primaryFragment', constants: { surfacePhysicalEnabled: 1 }, targets: [{ format: 'rgba32float' }] },
        primitive: { topology: 'triangle-list', cullMode: 'none' },
        depthStencil: { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less' },
      });
      transportPipeline = await device.createComputePipelineAsync({ layout:'auto', compute:{ module:modules[2], entryPoint:'pathMain', constants:{ surfacePhysicalEnabled:1, surfaceOrderedTraversal:0, traceVolumeEnabled:0, traceCaptureFault:0 } } });
    } finally { await popScopes(result.errors); await progress(); }
    if (result.errors.length) throw Error('TC_MOTION_PIPELINE_VALIDATION');
    for (const frame of packet.frames) {
      const entry = { name: frame.name, mode: frame.mode, actual: [], primary: [], errors: [] };
      result.cases.push(entry);
      const buffers = [], textures = [];
      pushScopes();
      try {
        const storage = (values, size, integer = false, uniform = false) => {
          const buffer = device.createBuffer({ size, usage: uniform ? GPUBufferUsage.UNIFORM : GPUBufferUsage.STORAGE, mappedAtCreation: true });
          buffers.push(buffer);
          (integer ? new Uint32Array(buffer.getMappedRange()) : new Float32Array(buffer.getMappedRange())).set(values);
          buffer.unmap();
          return buffer;
        };
        const input = [
          storage(frame.geometry, frame.bufferSizes.storage[0]),
          storage(frame.materials, frame.bufferSizes.storage[1]),
          storage(frame.textures, frame.bufferSizes.storage[2], true),
          storage(frame.texels, frame.bufferSizes.storage[3], true),
          storage(frame.traversal, frame.bufferSizes.storage[4]),
        ];
        const params = storage(frame.params, frame.bufferSizes.uniform, false, true);
        const output = device.createBuffer({ size: frame.bufferSizes.output, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
        buffers.push(output);
        const read = device.createBuffer({ size: frame.bufferSizes.output, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
        buffers.push(read);
        const primary = device.createTexture({ size: [frame.width, frame.height], format: 'rgba32float',
          usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC });
        textures.push(primary);
        const depth = device.createTexture({ size: [frame.width, frame.height], format: 'depth24plus', usage: GPUTextureUsage.RENDER_ATTACHMENT });
        textures.push(depth);
        // Explicit unfilterable-float layout needs no optional float32-filterable feature.
        const group = device.createBindGroup({ layout: motionPipeline.getBindGroupLayout(0), entries: [
          ...input.map((buffer, binding) => ({ binding, resource: { buffer } })),
          { binding: 6, resource: { buffer: output } }, { binding: 7, resource: { buffer: params } },
          { binding: 8, resource: primary.createView() },
        ] });
        const encoder = device.createCommandEncoder({ label: frame.mode + '/' + frame.name });
        let primaryRead;
        const rowBytes = Math.ceil(frame.width * 16 / 256) * 256;
        if (frame.mode === 'hybrid') {
          const rasterGroup = device.createBindGroup({ layout: primaryPipeline.getBindGroupLayout(0), entries: [
            ...input.slice(0, 4).map((buffer, binding) => ({ binding, resource: { buffer } })),
            { binding: 7, resource: { buffer: params } },
          ] });
          const pass = encoder.beginRenderPass({
            colorAttachments: [{ view: primary.createView(), clearValue: { r: -1, g: frame.forceRefinement ? -2 : -1, b: 0, a: 0 }, loadOp: 'clear', storeOp: 'store' }],
            depthStencilAttachment: { view: depth.createView(), depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'store' },
          });
          pass.setPipeline(primaryPipeline);
          pass.setBindGroup(0, rasterGroup);
          if (!frame.forceRefinement) pass.draw(frame.triangleCount * 3);
          pass.end();
          primaryRead = device.createBuffer({ size: rowBytes * frame.height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
          buffers.push(primaryRead);
          encoder.copyTextureToBuffer({ texture: primary }, { buffer: primaryRead, bytesPerRow: rowBytes }, [frame.width, frame.height]);
        }
        const pass = encoder.beginComputePass();
        pass.setPipeline(motionPipeline);
        pass.setBindGroup(0, group);
        pass.dispatchWorkgroups(Math.ceil(frame.width / 8), Math.ceil(frame.height / 8));
        pass.end();
        encoder.copyBufferToBuffer(output, 0, read, 0, frame.bufferSizes.output);
        device.queue.submit([encoder.finish()]);
        await read.mapAsync(GPUMapMode.READ);
        entry.actual = Array.from(new Float32Array(read.getMappedRange().slice(0)));
        read.unmap();
        await progress();
        if (primaryRead) {
          await primaryRead.mapAsync(GPUMapMode.READ);
          const mapped = primaryRead.getMappedRange();
          for (let y = 0; y < frame.height; y++) entry.primary.push(...new Float32Array(mapped, y * rowBytes, frame.width * 4));
          primaryRead.unmap();
        }
        if (entry.actual.some(value => !Number.isFinite(value))) entry.errors.push('TC_MOTION_NON_FINITE');
        if (entry.primary.some(value => !Number.isFinite(value))) entry.errors.push('TC_MOTION_PRIMARY_NON_FINITE');
        if (frame.forceRefinement) {
          const transportParams=frame.params.slice();transportParams[27]=1;transportParams[28]=1;transportParams[29]=1;transportParams[30]=1;transportParams[33]=1;transportParams[34]=0;transportParams[35]=0;transportParams[52]=-1;
          const transportUniform=storage(transportParams,368,false,true), lights=storage([],48), environment=storage([],16);
          const plane=frame.width*frame.height*16, traced=device.createBuffer({size:plane*4+16,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC});
          const tracedRead=device.createBuffer({size:plane,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});buffers.push(traced,tracedRead);
          const tracedGroup=device.createBindGroup({layout:transportPipeline.getBindGroupLayout(0),entries:[...input.map((buffer,binding)=>({binding,resource:{buffer}})),{binding:5,resource:{buffer:lights}},{binding:6,resource:{buffer:traced}},{binding:7,resource:{buffer:transportUniform}},{binding:8,resource:primary.createView()},{binding:9,resource:{buffer:environment}}]});
          const tracedEncoder=device.createCommandEncoder(), tracedPass=tracedEncoder.beginComputePass();tracedPass.setPipeline(transportPipeline);tracedPass.setBindGroup(0,tracedGroup);tracedPass.dispatchWorkgroups(Math.ceil(frame.width/8),Math.ceil(frame.height/8));tracedPass.end();tracedEncoder.copyBufferToBuffer(traced,plane+16,tracedRead,0,plane);device.queue.submit([tracedEncoder.finish()]);
          await tracedRead.mapAsync(GPUMapMode.READ);entry.transport=Array.from(new Float32Array(tracedRead.getMappedRange().slice(0)));tracedRead.unmap();
        }
        await device.queue.onSubmittedWorkDone();
      } catch (error) { entry.errors.push(String(error && error.stack || error)); }
      finally {
        await popScopes(entry.errors);
        for (const buffer of buffers) buffer.destroy();
        for (const texture of textures) texture.destroy();
        await progress();
      }
    }
  } catch (error) { result.errors.push(String(error && error.stack || error)); }
  finally {
    if (device) {
      await popScopes(result.errors);
      device.destroy();
    }
    await progress();
  }
  return result;
}
`;

/** Standalone localhost readback; the caller explicitly opts into owning a real GPU run. */
export async function runMotionGpuProbe(output: string) {
  await mkdir(output, { recursive: true });
  const packets: MotionProbePacket[] = [];
  let gpu: GpuResult = {
    backend: null,
    adapter: null,
    compilation: [],
    errors: [],
    cases: [],
  };
  const failures: string[] = [],
    browserErrors: string[] = [];
  const server = createServer((_request, response) => {
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    });
    response.end(
      '<!doctype html><meta charset="utf-8"><title>Motion GPU numeric probe</title>',
    );
  });
  let browser: Browser | undefined;
  const motionShader = SURFACE_SHADER + SURFACE_RAY_SHADER + MOTION_SHADER;
  const primaryShader = SURFACE_SHADER + PRIMARY_SHADER;
  const transportShader =
    SURFACE_SHADER +
    SURFACE_RAY_SHADER +
    BSDF_SHADER +
    DIELECTRIC_SHADER +
    VOLUME_SHADER +
    PATH_SHADER;
  const json = (value: unknown) =>
    JSON.stringify(
      value,
      (_key, item) =>
        typeof item === "number" && !Number.isFinite(item)
          ? String(item)
          : item,
      2,
    ) + "\n";
  try {
    packets.push(...buildMotionProbePackets());
    packets.push(buildPrimaryRefinementPacket(packets));
    // Save exact packets and shader sources before startup so failures remain reproducible.
    await writeFile(
      path.join(output, "motion-gpu-packets.json"),
      json({
        threeRevision: THREE.REVISION,
        tolerance: MOTION_PROBE_TOLERANCE,
        constants: { surfacePhysicalEnabled: 1, surfaceOrderedTraversal: 0 },
        motionShader,
        primaryShader,
        transportShader,
        frames: packets,
      }),
    );
    await withAutomationDeadline(
      async () => {
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(0, "127.0.0.1", () => {
            server.off("error", reject);
            resolve();
          });
        });
        const address = server.address();
        assert.ok(address && typeof address !== "string");
        browser = await chromium.launch(automationLaunchOptions(20_000));
        const page = await browser.newPage();
        page.on("pageerror", (error) =>
          browserErrors.push(error.stack ?? error.message),
        );
        page.on("console", (message) => {
          if (message.type() === "error") browserErrors.push(message.text());
        });
        page.on("requestfailed", (request) =>
          browserErrors.push(
            request.url() + ": " + request.failure()?.errorText,
          ),
        );
        await page.exposeFunction(
          "__motionProbeProgress",
          (progress: GpuResult) => {
            gpu = progress;
          },
        );
        await page.goto("http://127.0.0.1:" + address.port, {
          waitUntil: "load",
          timeout: 15_000,
        });
        const execute = new Function(
          "return (" + MOTION_PROBE_BROWSER_SOURCE + ")",
        )() as (packet: unknown) => Promise<GpuResult>;
        gpu = await page.evaluate(execute, {
          motionShader,
          primaryShader,
          transportShader,
          frames: packets,
        });
      },
      90_000,
      "Motion WebGPU numeric readback",
    );
  } catch (error) {
    failures.push(
      error instanceof Error ? (error.stack ?? error.message) : String(error),
    );
  } finally {
    if (browser) {
      try {
        await withAutomationDeadline(
          () => browser!.close(),
          10_000,
          "Motion browser cleanup",
        );
      } catch (error) {
        failures.push(String(error));
      }
    }
    if (server.listening) {
      server.closeAllConnections();
      try {
        await withAutomationDeadline(
          () =>
            new Promise<void>((resolve, reject) =>
              server.close((error) => (error ? reject(error) : resolve())),
            ),
          5_000,
          "Motion HTTP cleanup",
        );
      } catch (error) {
        failures.push(String(error));
      }
    }
  }
  failures.push(...gpu.errors, ...browserErrors);
  if (gpu.backend !== "webgpu")
    failures.push("No actual WebGPU device/readback backend");
  if (!packets.length) failures.push("No CPU reference packets");
  const cases = packets.map((packet) => {
    const actual = gpu.cases.find(
      (item) => item.name === packet.name && item.mode === packet.mode,
    );
    const comparison = compareMotionProbeSamples(
      packet.expected,
      actual?.actual ?? [],
    );
    const caseFailures = [
      ...(actual?.errors ?? ["GPU case did not complete"]),
      ...comparison.failures,
    ];
    if (packet.forceRefinement) {
      if (actual?.transport?.length !== packet.width * packet.height * 4)
        caseFailures.push("Missing forced-refinement transport readback");
      else
        for (let index = 0; index < packet.cpuHits.length; index++) {
          for (let channel = 0; channel < 4; channel++) {
            const expected =
              channel === 3
                ? 1
                : packet.cpuHits[index]
                  ? packet.materials[channel]
                  : 0;
            const value = actual.transport[index * 4 + channel];
            if (
              !Number.isFinite(value) ||
              Math.abs(value - expected) > MOTION_PROBE_TOLERANCE
            )
              caseFailures.push(
                "Forced refinement transport pixel " +
                  index +
                  ":" +
                  channel +
                  " expected=" +
                  expected +
                  " actual=" +
                  value,
              );
          }
        }
    }
    if (
      packet.mode === "hybrid" &&
      actual?.primary.length !== packet.width * packet.height * 4
    )
      caseFailures.push("Incomplete real PRIMARY_SHADER readback");
    failures.push(
      ...caseFailures.map(
        (message) => packet.mode + "/" + packet.name + ": " + message,
      ),
    );
    return {
      name: packet.name,
      mode: packet.mode,
      accelerationKind: packet.accelerationKind,
      matched: packet.matched,
      missing: packet.missing,
      passed: caseFailures.length === 0,
      expected: packet.expected,
      actual: actual?.actual ?? [],
      primary: actual?.primary ?? [],
      forcedRefinement: packet.forceRefinement === true,
      transport: actual?.transport,
      maxUVError: comparison.maxUVError,
      maxDepthError: comparison.maxDepthError,
      failures: caseFailures,
    };
  });
  const report = {
    passed: failures.length === 0,
    formalMilestoneAccepted: false,
    requestedBackend: "webgpu",
    actualBackend: gpu.backend,
    backend: gpu.backend,
    adapter: gpu.adapter,
    width: MOTION_PROBE_WIDTH,
    height: MOTION_PROBE_HEIGHT,
    threeRevision: THREE.REVISION,
    tolerance: {
      absoluteUV: MOTION_PROBE_TOLERANCE,
      absoluteDepth: MOTION_PROBE_TOLERANCE,
    },
    maxUVError: Math.max(0, ...cases.map((item) => item.maxUVError)),
    maxDepthError: Math.max(0, ...cases.map((item) => item.maxDepthError)),
    cases,
    compilation: gpu.compilation,
    browserErrors,
    failures,
    packets: "motion-gpu-packets.json",
    limitations: [
      "Numeric motion shader validation only; full application temporal history, ghosting, lighting and milestone acceptance are separate.",
      "CPU acceleration/intersection and extracted Three world positions are shared production prerequisites, not an independent geometry/BVH implementation.",
      "Opaque double-sided fixtures; stochastic alpha, texture coverage, instancing, disocclusion policy and complete animation matrices are not covered.",
      "Unparented perspective cameras use WebGPU depth coordinates; CPU reference uses double-precision ray/projection math against Float32 uniforms. Fixed absolute tolerance is never widened after GPU results.",
      "CPU-built/refitted compact BVH is uploaded to WebGPU; this is not GPU BVH refit or hardware ray tracing.",
    ],
  };
  await writeFile(path.join(output, "motion-gpu.json"), json(report));
  return report;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  runMotionGpuProbe(
    path.resolve(process.argv[2] ?? "artifacts/motion-gpu-probe"),
  )
    .then((report) => {
      console.log(
        JSON.stringify({
          passed: report.passed,
          formalMilestoneAccepted: false,
          actualBackend: report.actualBackend,
          cases: report.cases.length,
          maxUVError: report.maxUVError,
          maxDepthError: report.maxDepthError,
          failures: report.failures,
        }),
      );
      if (!report.passed) process.exitCode = 1;
    })
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}
