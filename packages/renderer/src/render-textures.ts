import * as THREE from "three/webgpu";
import * as TSL from "three/tsl";
import type { ComputeTextureBinding } from "../../sdk/src/index.ts";
import type { ComputeExecutionInput } from "../../runtime/src/compute-contract.ts";
import type { ComputeTextureResidentSource } from "./compute-view-contract.ts";

type Backend = { device?: GPUDevice; isWebGLBackend?: boolean; get(texture: THREE.Texture): { texture?: GPUTexture } };
type Entry = { material: THREE.Material; name: string; texture: THREE.StorageTexture; width: number; height: number; size: any; nodes: any[]; key?: string; revision?: number };
const fail = (code: string, detail: string): never => { throw new Error(`TC_RENDER_TEXTURE_${code}: ${detail} Repair: Bind a live managed texture and use an initialized WebGPU backend.`); };

/** Three owns presentation textures; the compute executor owns the source versions. */
export function createRenderTextureBridge(renderer: THREE.Renderer, source: () => ComputeTextureResidentSource | undefined, resources: (target: string) => Readonly<Record<string, ComputeExecutionInput>>) {
  const backend = renderer.backend as unknown as Backend, device = backend.device;
  const entries = new Map<THREE.Material, Map<string, Entry>>();
  let disposed = false, allocations = 0, releases = 0, copies = 0, bytes = 0;
  const active = () => { if (disposed) fail("DISPOSED", "Texture bridge was disposed."); if (renderer.backend !== backend as unknown || backend.isWebGLBackend || !device || backend.device !== device) fail("CAPABILITY", "Managed render textures require WebGPU."); };
  const allocate = (width: number, height: number) => {
    if (![width, height].every(value => Number.isSafeInteger(value) && value > 0 && value <= device!.limits.maxTextureDimension2D)) fail("SIZE", "Texture dimensions exceed actual device limits.");
    const texture = new THREE.StorageTexture(width, height);
    texture.name = "Pelican managed render texture"; texture.format = THREE.RGBAFormat; texture.type = THREE.FloatType;
    texture.minFilter = THREE.NearestFilter; texture.magFilter = THREE.NearestFilter; texture.generateMipmaps = false; texture.flipY = false; texture.colorSpace = THREE.NoColorSpace;
    try { renderer.initTexture(texture); } catch (error) { texture.dispose(); throw error; }
    allocations++; return texture;
  };
  const get = (material: THREE.Material, name: string): Entry => {
    active(); const descriptor = resources(material.name)[name] ?? fail("UNBOUND", material.name + ":" + name);
    const shape = descriptor.texture;
    if (!shape || descriptor.type !== "vec4" || descriptor.values.length !== shape.width * shape.height) return fail("RESOURCE", "Invalid managed texture descriptor.");
    let slots = entries.get(material); if (!slots) { slots = new Map(); entries.set(material, slots); }
    let entry = slots.get(name);
    if (!entry) { const texture = allocate(shape.width, shape.height); entry = { material, name, texture, width: shape.width, height: shape.height, size: TSL.uniform(new THREE.Vector2(shape.width, shape.height)), nodes: [] }; slots.set(name, entry); }
    return entry;
  };
  return {
    prepare(material: THREE.Material, slots: Readonly<Record<string, ComputeTextureBinding>>) { for (const name of Object.keys(slots)) get(material, name); },
    node(material: THREE.Material, name: string, uv: any, sampler: ComputeTextureBinding) {
      const entry = get(material, name), size = entry.size;
      const finite = uv.x.equal(uv.x).and(uv.y.equal(uv.y)).and(TSL.abs(uv.x).lessThanEqual(3.402823e38)).and(TSL.abs(uv.y).lessThanEqual(3.402823e38));
      const safe = TSL.select(finite, uv, TSL.vec2(0));
      const normalize = (value: any, wrap = "clamp") => wrap === "repeat" ? value.sub(value.floor()) : wrap === "mirror" ? TSL.float(1).sub(TSL.abs(value.sub(value.mul(0.5).floor().mul(2)).sub(1))) : TSL.clamp(value, 0, 1);
      const address = (value: any, length: any, wrap = "clamp") => {
        if (wrap === "clamp") return TSL.clamp(value, 0, length.sub(1));
        const period = wrap === "mirror" ? length.mul(2) : length;
        const cell = value.sub(value.div(period).floor().mul(period));
        return wrap === "mirror" ? TSL.min(cell, length.mul(2).sub(1).sub(cell)) : cell;
      };
      const read = (x: any, y: any) => {
        const coord = TSL.ivec2(address(x, size.x, sampler.wrapU), address(y, size.y, sampler.wrapV));
        const node = TSL.textureLoad(entry.texture, coord); node.updateMatrix = false; node.mergeable = false; entry.nodes.push(node); return node.level(TSL.float(0));
      };
      const x = normalize(safe.x, sampler.wrapU).mul(size.x), y = normalize(safe.y, sampler.wrapV).mul(size.y);
      let value: any;
      if (sampler.filter === "nearest") value = read(x.floor(), y.floor());
      else {
        const px = x.sub(0.5), py = y.sub(0.5), bx = px.floor(), by = py.floor(), wx = px.fract(), wy = py.fract();
        value = TSL.mix(TSL.mix(read(bx, by), read(bx.add(1), by), wx), TSL.mix(read(bx, by.add(1)), read(bx.add(1), by.add(1)), wx), wy);
      }
      return TSL.select(finite, value, TSL.vec4(0));
    },
    update() {
      if (!entries.size) return; active(); const owner = source() ?? fail("CAPABILITY", "Missing compute texture executor.");
      const planned: { entry: Entry; descriptor: ComputeExecutionInput }[] = [];
      for (const [material, slots] of entries) { const current = resources(material.name); for (const entry of slots.values()) { const descriptor = current[entry.name] ?? fail("UNBOUND", material.name + ":" + entry.name); if (!descriptor.texture || descriptor.type !== "vec4" || descriptor.values.length !== descriptor.texture.width * descriptor.texture.height) fail("RESOURCE", "Invalid managed texture descriptor."); planned.push({ entry, descriptor }); } }
      const encoder = device!.createCommandEncoder({ label: "Pelican managed render texture copies" }), staged: { entry: Entry; descriptor: ComputeExecutionInput; texture: THREE.StorageTexture; previous?: THREE.StorageTexture }[] = [];
      try {
        for (const { entry, descriptor } of planned) {
          if (entry.key === descriptor.key && entry.revision === descriptor.revision) continue;
          const view = owner.textureResident(descriptor), shape = descriptor.texture!;
          if (view.width !== shape.width || view.height !== shape.height || view.revision !== descriptor.revision || view.texture.format !== "rgba32float" || !(view.texture.usage & GPUTextureUsage.COPY_SRC)) fail("RESOURCE", "Executor returned an incompatible texture.");
          const replacement = entry.width !== view.width || entry.height !== view.height;
          const texture = replacement ? allocate(view.width, view.height) : entry.texture;
          staged.push({ entry, descriptor, texture, ...(replacement ? { previous: entry.texture } : {}) });
          const target = backend.get(texture).texture ?? fail("RESOURCE", "Three did not allocate the render texture.");
          if (target === view.texture || target.format !== "rgba32float" || !(target.usage & GPUTextureUsage.COPY_DST)) fail("RESOURCE", "Render destination is incompatible or aliases the compute source.");
          encoder.copyTextureToTexture({ texture: view.texture }, { texture: target }, { width: view.width, height: view.height, depthOrArrayLayers: 1 });
        }
        if (staged.length) device!.queue.submit([encoder.finish()]);
      } catch (error) { for (const item of staged) if (item.previous) { item.texture.dispose(); releases++; } throw error; }
      for (const item of staged) {
        const shape = item.descriptor.texture!; if (item.previous) { item.entry.texture = item.texture; item.entry.width = shape.width; item.entry.height = shape.height; item.entry.size.value.set(shape.width, shape.height); for (const node of item.entry.nodes) node.value = item.texture; item.entry.material.needsUpdate = true; item.previous.dispose(); releases++; }
        item.entry.key = item.descriptor.key; item.entry.revision = item.descriptor.revision; copies++; bytes += shape.width * shape.height * 16;
      }
    },
    inspect() { return { disposed, slots: [...entries.values()].reduce((n, m) => n + m.size, 0), allocations, released: releases, liveTextures: allocations - releases, gpuCopies: copies, gpuCopyBytes: bytes, cpuResultUploads: 0, bindings: [...entries.values()].flatMap(slots => [...slots.values()].map(e => ({ target: e.material.name, name: e.name, width: e.width, height: e.height, key: e.key, revision: e.revision }))) }; },
    dispose() { if (disposed) return; disposed = true; for (const slots of entries.values()) for (const entry of slots.values()) { entry.texture.dispose(); releases++; } entries.clear(); },
  };
}
