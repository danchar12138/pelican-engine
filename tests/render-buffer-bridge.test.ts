import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three/webgpu";
import { createRenderBufferBridge } from "../packages/renderer/src/render-buffers.ts";
import type { ComputeExecutionInput } from "../packages/runtime/src/compute-contract.ts";
import type { ComputeGpuView } from "../packages/renderer/src/compute-view-contract.ts";

const previousUsage = Object.getOwnPropertyDescriptor(globalThis, "GPUBufferUsage");
test.before(() => Object.defineProperty(globalThis, "GPUBufferUsage", { configurable: true, value: { COPY_SRC: 4 } }));
test.after(() => { if (previousUsage) Object.defineProperty(globalThis, "GPUBufferUsage", previousUsage); else delete (globalThis as any).GPUBufferUsage; });

function fixture() {
  const resources = new Map<object, { buffer: any }>(), copies: any[] = [], submitted: any[] = [];
  let uploads = 0, destroys = 0;
  const device = { limits: { maxStorageBufferBindingSize: 1024, maxBufferSize: 1024 }, createCommandEncoder: () => ({ copyBufferToBuffer(...args: any[]) { copies.push(args); }, finish: () => ({ copies: copies.length }) }), queue: { submit: (commands: any[]) => submitted.push(...commands), writeBuffer() { uploads++; } } };
  const backend = {
    device, isWebGLBackend: false,
    createStorageAttribute(attribute: THREE.StorageBufferAttribute) { resources.set(attribute, { buffer: { size: attribute.array.byteLength, usage: 128 | 4 | 8, destroy() { destroys++; } } }); },
    destroyAttribute(attribute: THREE.StorageBufferAttribute) { resources.get(attribute)!.buffer.destroy(); resources.delete(attribute); },
    has: (attribute: object) => resources.has(attribute), get: (attribute: object) => resources.get(attribute)!,
  };
  const renderer = { backend } as unknown as THREE.Renderer;
  let descriptor: ComputeExecutionInput = { key: "a", type: "vec3", revision: 0, values: [[1,2,3]] };
  let source = { buffer: { usage: 4, size: 16 }, type: "vec3", count: 1, revision: 0 } as ComputeGpuView;
  const bridge = createRenderBufferBridge(renderer, () => ({ resident: input => { assert.equal(input.key, descriptor.key); return source; } }), () => ({ position: descriptor }));
  const material = new THREE.MeshStandardNodeMaterial(); material.name = "shape";
  return { bridge, material, resources, copies, submitted, backend, get uploads() { return uploads; }, get destroys() { return destroys; }, set(input: ComputeExecutionInput) { descriptor = input; source = { buffer: { usage: 4, size: input.values.length * 16 }, type: input.type, count: input.values.length, revision: input.revision } as ComputeGpuView; } };
}
test("render slots GPU-copy committed results without CPU uploads or aliasing the compute buffer", t => {
  const f = fixture();
  f.bridge.prepare(f.material, { position: "vec3" });
  f.bridge.update();
  assert.equal(f.copies.length, 1); assert.equal(f.uploads, 0);
  assert.notEqual(f.copies[0][0], f.copies[0][2]);
  f.bridge.update(); assert.equal(f.copies.length, 1);
  f.set({ key: "a", type: "vec3", revision: 1, values: [[4,5,6]] });
  f.bridge.update(); assert.equal(f.copies.length, 2); assert.equal(f.uploads, 0);
  assert.equal(f.bridge.inspect().liveAttributes, 1);
  f.bridge.dispose(); f.bridge.dispose();
  assert.equal(f.bridge.inspect().liveAttributes, 0); assert.equal(f.destroys, 1);
  f.material.dispose();
});
test("restore identities and valid size changes recreate Three-owned attributes, not source ownership", t => {
  const f = fixture(); f.bridge.prepare(f.material, { position: "vec3" }); f.bridge.update();
  f.set({ key: "restored-owner", type: "vec3", revision: 0, values: [[1,1,1],[2,2,2]] });
  f.bridge.update();
  assert.equal(f.bridge.inspect().allocations, 2); assert.equal(f.bridge.inspect().released, 1);
  assert.equal(f.bridge.inspect().liveAttributes, 1); assert.equal(f.copies.at(-1)[4], 32);
  f.bridge.dispose(); f.material.dispose();
});
test("WebGL2, wrong types and disposed bridge fail before producing a new rendered version", t => {
  const f = fixture(); f.bridge.prepare(f.material, { position: "vec3" }); f.bridge.update();
  f.set({ key: "wrong", type: "float", revision: 1, values: [1] });
  assert.throws(() => f.bridge.update(), /TC_RENDER_BUFFER_TYPE/); assert.equal(f.copies.length, 1);
  f.backend.isWebGLBackend = true;
  assert.throws(() => f.bridge.update(), /TC_RENDER_BUFFER_CAPABILITY/);
  f.bridge.dispose();
  assert.throws(() => f.bridge.prepare(f.material, { position: "vec3" }), /TC_RENDER_BUFFER_DISPOSED/);
  f.material.dispose();
});

test("a partial native attribute allocation is released before a retry", () => {
  const f = fixture();
  const allocate = f.backend.createStorageAttribute;
  f.backend.createStorageAttribute = attribute => { allocate(attribute); throw Error("injected allocation failure"); };
  assert.throws(() => f.bridge.prepare(f.material, { position: "vec3" }), /injected allocation failure/);
  assert.equal(f.resources.size, 0); assert.equal(f.destroys, 1);
  f.backend.createStorageAttribute = allocate;
  f.bridge.prepare(f.material, { position: "vec3" }); f.bridge.update();
  assert.equal(f.bridge.inspect().liveAttributes, 1);
  f.bridge.dispose(); f.material.dispose();
});
