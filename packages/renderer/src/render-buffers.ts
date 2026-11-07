import * as THREE from "three/webgpu";
import * as TSL from "three/tsl";
import type { GraphType } from "../../sdk/src/index.ts";
import type { ComputeExecutionInput } from "../../runtime/src/compute-contract.ts";
import type { ComputeResidentSource } from "./compute-view-contract.ts";

type Entry = { material: THREE.Material; name: string; type: GraphType; count: number; length: any; attribute: THREE.StorageBufferAttribute; node: any; key?: string; revision?: number };
type Backend = { device?: GPUDevice; isWebGLBackend?: boolean; createStorageAttribute(attribute: THREE.StorageBufferAttribute): void; destroyAttribute(attribute: THREE.StorageBufferAttribute): void; has(attribute: THREE.StorageBufferAttribute): boolean; get(attribute: THREE.StorageBufferAttribute): { buffer?: GPUBuffer } };
const fail = (code: string, message: string): never => { throw new Error("TC_RENDER_BUFFER_" + code + ": " + message + " Repair: Use a live matching WebGPU buffer binding and recreate resources after device replacement."); };

/** Three owns render attributes; the executor owns source buffers. Every update is a GPU copy. */
export function createRenderBufferBridge(renderer: THREE.Renderer, source: () => ComputeResidentSource | undefined, resources: (material: string) => Readonly<Record<string, ComputeExecutionInput>>) {
  const backend = renderer.backend as unknown as Backend;
  const device = backend.device;
  const entries = new Map<THREE.Material, Map<string, Entry>>();
  let disposed = false, copies = 0, copyBytes = 0, allocations = 0, released = 0;
  const active = () => {
    if (disposed) fail("DISPOSED", "Render buffer bridge was disposed.");
    if ((renderer.backend as unknown) !== backend || backend.isWebGLBackend || !device || backend.device !== device) fail("CAPABILITY", "Managed GPU render slots require the initialized WebGPU backend.");
  };
  const disposeAttribute = (attribute: THREE.StorageBufferAttribute) => {
    attribute.dispose();
    // Before a material's first render, Three's Attributes owner has no listener yet.
    if (backend.has(attribute)) backend.destroyAttribute(attribute);
    released++;
  };
  const makeAttribute = (count: number) => {
    if (!Number.isSafeInteger(count) || count < 1 || count * 16 > device!.limits.maxStorageBufferBindingSize || count * 16 > device!.limits.maxBufferSize) fail("COUNT", "Render storage count exceeds actual GPU limits.");
    const attribute = new THREE.StorageBufferAttribute(count, 4);
    attribute.name = "Pelican controlled render slot";
    try { backend.createStorageAttribute(attribute); }
    catch (error) {
      attribute.dispose();
      if (backend.has(attribute)) backend.destroyAttribute(attribute);
      throw error;
    }
    allocations++;
    return attribute;
  };
  const get = (material: THREE.Material, name: string, type: GraphType): Entry => {
    active();
    const descriptor = resources(material.name)[name] ?? fail("UNBOUND", material.name + ":" + name);
    if (descriptor.type !== type) fail("TYPE", material.name + ":" + name);
    let slots = entries.get(material);
    if (!slots) { slots = new Map(); entries.set(material, slots); }
    let entry = slots.get(name);
    if (!entry) {
      const attribute = makeAttribute(descriptor.values.length);
      entry = { material, name, type, count: descriptor.values.length, length: TSL.uniform(descriptor.values.length), attribute, node: TSL.storage(attribute, "vec4", descriptor.values.length).toReadOnly() };
      slots.set(name, entry);
    }
    return entry;
  };
  return {
    node(material: THREE.Material, name: string, index: any, type: GraphType, robust = false) {
      const entry = get(material, name, type);
      const value = entry.node.element(TSL.uint(robust ? TSL.clamp(index, 0, entry.length.sub(1)) : index));
      const typed = type === "bool" ? value.x.notEqual(0) : type === "float" ? value.x : type === "vec2" ? value.xy : type === "vec3" ? value.xyz : value;
      if (!robust) return typed;
      const valid = index.greaterThanEqual(0).and(index.lessThan(entry.length)).and(index.equal(index.floor()));
      const zero = type === "bool" ? TSL.bool(false) : type === "float" ? TSL.float(0) : type === "vec2" ? TSL.vec2(0) : type === "vec3" ? TSL.vec3(0) : TSL.vec4(0);
      return TSL.select(valid, typed, zero);
    },
    prepare(material: THREE.Material, names: Readonly<Record<string, GraphType>>) {
      for (const [name, type] of Object.entries(names)) get(material, name, type);
    },
    update() {
      if (!entries.size) return false;
      active();
      const executor = source() ?? fail("CAPABILITY", "No managed compute GPU owner is attached.");
      const planned: { entry: Entry; descriptor: ComputeExecutionInput }[] = [];
      for (const [material, slots] of entries) {
        const values = resources(material.name);
        for (const entry of slots.values()) {
          const descriptor = values[entry.name] ?? fail("UNBOUND", material.name + ":" + entry.name);
          if (descriptor.type !== entry.type) fail("TYPE", material.name + ":" + entry.name);
          planned.push({ entry, descriptor });
        }
      }
      const encoder = device!.createCommandEncoder({ label: "Pelican compute-to-render copies" });
      const committed: { entry: Entry; key: string; revision: number; bytes: number }[] = [];
      for (const { entry, descriptor } of planned) {
        if (entry.key === descriptor.key && entry.revision === descriptor.revision) continue;
        const view = executor.resident(descriptor);
        if (view.type !== entry.type || view.count !== descriptor.values.length || view.revision !== descriptor.revision || !(view.buffer.usage & GPUBufferUsage.COPY_SRC)) fail("RESOURCE", "Executor returned a mismatched committed resource.");
        if (entry.count !== view.count) {
          const attribute = makeAttribute(view.count);
          disposeAttribute(entry.attribute);
          entry.attribute = attribute; entry.count = view.count;
          entry.length.value = view.count;
          entry.node.value = attribute; entry.node.bufferCount = view.count;
          entry.material.needsUpdate = true;
        }
        const target = backend.get(entry.attribute).buffer ?? fail("RESOURCE", "Three did not allocate the destination render attribute.");
        if (target === view.buffer) fail("RESOURCE", "Compute source and Three render destination must have different owners.");
        encoder.copyBufferToBuffer(view.buffer, 0, target, 0, view.count * 16);
        committed.push({ entry, key: descriptor.key, revision: descriptor.revision, bytes: view.count * 16 });
      }
      if (committed.length) device!.queue.submit([encoder.finish()]);
      for (const item of committed) { item.entry.key = item.key; item.entry.revision = item.revision; copies++; copyBytes += item.bytes; }
      return committed.length > 0;
    },
    inspect() { return { disposed, slots: [...entries.values()].reduce((count, slots) => count + slots.size, 0), allocations, released, liveAttributes: allocations - released, gpuCopies: copies, gpuCopyBytes: copyBytes, cpuResultUploads: 0, bindings: [...entries.values()].flatMap(slots => [...slots.values()].map(entry => ({ material: entry.material.name, name: entry.name, type: entry.type, count: entry.count, key: entry.key, revision: entry.revision }))) }; },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const slots of entries.values()) for (const entry of slots.values()) disposeAttribute(entry.attribute);
      entries.clear();
    },
  };
}
