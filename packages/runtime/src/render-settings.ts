import type { RenderSettings, RenderService, GraphParameter, RenderCapabilities, MaterialBufferInput, MaterialTextureInput } from "../../sdk/src/index.ts";
import type { PostProcessIR } from "../../compiler/src/types.ts";
import { renderCapabilities, validateRenderCapabilities } from "./render-capabilities.ts";
import { createMaterialParameters } from "./material-parameters.ts";
import { createMaterialSurfaceOwner } from "./material-surface.ts";
import { createPostProcessOwner } from "./postprocess.ts";
import { createRenderBufferOwner, type RenderBufferPeerSnapshots } from "./render-buffers.ts";
import type { RenderBufferProvider } from "./render-buffer-contract.ts";
import { createRenderTextureOwner } from "./render-textures.ts";
import type { RenderTextureProvider } from "./render-texture-contract.ts";
import type { RuntimePluginFactory } from "./plugins.ts";
export const DEFAULT_RENDER_SETTINGS: Readonly<RenderSettings> = Object.freeze({
  mode: "raster",
  samplesPerFrame: 1,
  maxBounces: 6,
  denoise: false,
  denoiseIterations: 3,
  exposure: 1,
  directLighting: true,
  indirectLighting: true,
  debug: "beauty",
});
const fail = (message: string): never => {
  throw new Error("TC_RENDER_SETTINGS: " + message);
};
const snapshotRecord = (value: unknown): value is Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return (proto === Object.prototype || proto === null) && Reflect.ownKeys(value).every(key => {
    const d = Object.getOwnPropertyDescriptor(value, key)!;
    return typeof key === "string" && d.enumerable && "value" in d;
  });
};
export function resolveRenderSettings(
  patch: unknown,
  base: Readonly<RenderSettings> = DEFAULT_RENDER_SETTINGS,
): RenderSettings {
  if (!patch || typeof patch !== "object" || Array.isArray(patch))
    return fail("Settings must be an object.");
  for (const key of Object.keys(patch))
    if (!Object.hasOwn(DEFAULT_RENDER_SETTINGS, key))
      fail("Unknown setting " + key);
  const result = { ...base, ...patch } as RenderSettings;
  if (!["raster", "hybrid", "path"].includes(result.mode))
    fail("Unknown render mode.");
  if (
    !["beauty", "albedo", "normal", "depth", "samples"].includes(result.debug)
  )
    fail("Unknown debug view.");
  for (const key of ["denoise", "directLighting", "indirectLighting"] as const)
    if (typeof result[key] !== "boolean") fail(key + " must be boolean.");
  for (const [key, min, max] of [
    ["samplesPerFrame", 1, 64],
    ["maxBounces", 1, 64],
    ["denoiseIterations", 0, 5],
  ] as const)
    if (
      !Number.isSafeInteger(result[key]) ||
      result[key] < min ||
      result[key] > max
    )
      fail(key + " must be an integer in [" + min + ", " + max + "].");
  if (
    !Number.isFinite(result.exposure) ||
    result.exposure <= 0 ||
    result.exposure > 65536
  )
    fail("Exposure must be finite and positive (maximum 65536).");
  return result;
}
export function createRenderSettingsDriver(
  initial: Partial<RenderSettings> = {},
  materials: readonly { id: string; graph?: unknown; graphs?: Partial<Record<string, unknown>>; parameters?: readonly GraphParameter[]; buffers?: readonly MaterialBufferInput[]; textures?: readonly MaterialTextureInput[] }[] = [],
  capabilities?: () => RenderCapabilities,
  postProcesses: readonly PostProcessIR[] = [],
  provider?: RenderBufferProvider,
  textureProvider?: RenderTextureProvider,
) {
  const parameters = createMaterialParameters(materials);
  const surfaces = createMaterialSurfaceOwner(materials);
  const postProcessOwner = createPostProcessOwner(postProcesses);
  const defaults = resolveRenderSettings(initial);
  if (capabilities) validateRenderCapabilities(defaults, capabilities());
  const pinGroups: Record<string, readonly string[]> = { material: [], effects: [], materialTextures: [], effectTextures: [] };
  let deferPins = false;
  const combinedPins = (groups = pinGroups) => [...new Set(Object.values(groups).flat())].sort();
  const scopedProvider = (group: string): RenderBufferProvider | undefined => provider && ({
    describe: handle => provider.describe(handle), resource: id => provider.resource(id),
    setPins(ids) {
      if (!deferPins) provider.setPins(combinedPins({ ...pinGroups, [group]: ids }));
      pinGroups[group] = [...ids];
    },
  });
  const bufferOwner = createRenderBufferOwner(materials, scopedProvider("material"));
  let effectBuffers: ReturnType<typeof createRenderBufferOwner>;
  try { effectBuffers = createRenderBufferOwner(postProcesses, scopedProvider("effects")); }
  catch (error) { bufferOwner.dispose(); throw error; }
  const scopedTextureProvider = (group: string): RenderTextureProvider | undefined => textureProvider && ({
    describe: handle => textureProvider.describe(handle), resource: id => textureProvider.resource(id),
    setPins(ids) { if (!deferPins) textureProvider.setPins(combinedPins({ ...pinGroups, [group]: ids })); pinGroups[group] = [...ids]; },
  });
  let textureOwner: ReturnType<typeof createRenderTextureOwner>, effectTextures: ReturnType<typeof createRenderTextureOwner>;
  try { textureOwner = createRenderTextureOwner(materials, scopedTextureProvider("materialTextures")); }
  catch (error) { effectBuffers.dispose(); bufferOwner.dispose(); throw error; }
  try { effectTextures = createRenderTextureOwner(postProcesses, scopedTextureProvider("effectTextures")); }
  catch (error) { textureOwner.dispose(); effectBuffers.dispose(); bufferOwner.dispose(); throw error; }
  const snapshotPins = (value: unknown): string[] => value === undefined ? [] :
    Object.values((value as { bindings: Record<string, Record<string, { id: string }>> }).bindings).flatMap(entries => Object.values(entries).map(ref => ref.id));
  const publishAllPins = (ids: readonly string[]) => {
    const owner = provider ?? textureProvider;
    if (!owner) return;
    try { owner.setPins(ids); }
    catch (cause) {
      try { owner.setPins(combinedPins()); } catch { /* preserve original failure */ }
      throw Object.assign(new Error("TC_RENDER_BUFFER_PROVIDER: Combined pin publication failed. Repair: Restore the provider and retry with matching live compute buffers.", { cause }), { code: "TC_RENDER_BUFFER_PROVIDER" });
    }
  };
  let current = { ...defaults },
    disposed = false;
  const active = () => {
    if (disposed)
      throw new Error("TC_RENDER_DISPOSED: Render settings owner is disposed.");
  };
  const service: RenderService = {
    configure(patch) {
      active();
      const next = resolveRenderSettings(patch, current);
      if (capabilities) validateRenderCapabilities(next, capabilities());
      current = next;
    },
    state() {
      active();
      return { ...current };
    },
    capabilities() {
      active();
      return structuredClone(capabilities?.() ?? renderCapabilities("uninitialized"));
    },
    setMaterialParameter(material, name, value) { active(); parameters.set(material, name, value); },
    materialParameters(material) { active(); return parameters.get(material); },
    setMaterialSurface(material, patch) { active(); surfaces.set(material, patch); },
    materialSurface(material) { active(); return surfaces.get(material); },
    resetMaterialSurface(material) { active(); surfaces.reset(material); },
    effects: Object.assign(postProcessOwner.service, { buffers: effectBuffers.service, textures: effectTextures.service }),
    buffers: bufferOwner.service,
    textures: textureOwner.service,
  };
  const preflight = (value: unknown) => {
    active();
    if (
      !snapshotRecord(value) ||
      Object.keys(value).some(key => !["version", "defaults", "settings", "parameters", "surfaces", "postProcesses", "bufferBindings", "effectBufferBindings", "textureBindings", "effectTextureBindings"].includes(key)) ||
      value.version !== 1 ||
      !snapshotRecord(value.defaults) ||
      Object.keys(value.defaults).length !== Object.keys(defaults).length ||
      Object.entries(defaults).some(([key, expected]) => !Object.hasOwn(value.defaults as object, key) || (value.defaults as Record<string, unknown>)[key] !== expected) ||
      !snapshotRecord(value.settings) ||
      Object.keys(value.settings).length !== Object.keys(defaults).length
    )
      throw new Error("TC_RENDER_SNAPSHOT: Incompatible settings snapshot.");
    const settings = resolveRenderSettings(value.settings);
    if (capabilities) validateRenderCapabilities(settings, capabilities());
    const materialState = Object.hasOwn(value, "parameters") ? value.parameters : undefined;
    const effects = Object.hasOwn(value, "postProcesses") ? value.postProcesses : undefined;
    parameters.validateSnapshot(materialState);
    const surfaceState = Object.hasOwn(value, "surfaces") ? value.surfaces : undefined;
    surfaces.validateSnapshot(surfaceState);
    postProcessOwner.validateSnapshot(effects);
    const bufferBindings = Object.hasOwn(value, "bufferBindings") ? value.bufferBindings : undefined;
    bufferOwner.validateSnapshot(bufferBindings);
    const effectBufferBindings = Object.hasOwn(value, "effectBufferBindings") ? value.effectBufferBindings : undefined;
    effectBuffers.validateSnapshot(effectBufferBindings);
    const textureBindings = Object.hasOwn(value, "textureBindings") ? value.textureBindings : undefined;
    const effectTextureBindings = Object.hasOwn(value, "effectTextureBindings") ? value.effectTextureBindings : undefined;
    textureOwner.validateSnapshot(textureBindings); effectTextures.validateSnapshot(effectTextureBindings);
    return { settings, materialState, surfaceState, effects, bufferBindings, effectBufferBindings, textureBindings, effectTextureBindings };
  };
  const dispose = () => {
    if (disposed) return;
    publishAllPins([]);
    deferPins = true;
    try { bufferOwner.dispose(); effectBuffers.dispose(); textureOwner.dispose(); effectTextures.dispose(); }
    finally { deferPins = false; }
    disposed = true;
    parameters.dispose();
    surfaces.dispose();
    postProcessOwner.dispose();
  };
  const factory = ((_context: Parameters<RuntimePluginFactory>[0]) => ({
    id: "$engine.render-settings",
    version: "1",
    services: { render: service },
    snapshot: () => {
      active();
      const effects = postProcessOwner.snapshot();
      const materialState = parameters.snapshot();
      const surfaceState = surfaces.snapshot();
      const bufferBindings = bufferOwner.snapshot();
      const effectBufferBindings = effectBuffers.snapshot();
      const textureBindings = textureOwner.snapshot(), effectTextureBindings = effectTextures.snapshot();
      return { version: 1, defaults: { ...defaults }, settings: service.state(), ...(materialState ? { parameters: materialState } : {}), ...(surfaceState.length ? { surfaces: surfaceState } : {}), ...(effects ? { postProcesses: effects } : {}), ...(bufferBindings ? { bufferBindings } : {}), ...(effectBufferBindings ? { effectBufferBindings } : {}), ...(textureBindings ? { textureBindings } : {}), ...(effectTextureBindings ? { effectTextureBindings } : {}) };
    },
    validateSnapshot(value) { preflight(value); },
    validatePeers(value: unknown, peers: RenderBufferPeerSnapshots) {
      const staged = preflight(value);
      bufferOwner.validatePeerSnapshot(staged.bufferBindings, peers);
      effectBuffers.validatePeerSnapshot(staged.effectBufferBindings, peers);
      textureOwner.validatePeerSnapshot(staged.textureBindings, peers);
      effectTextures.validatePeerSnapshot(staged.effectTextureBindings, peers);
    },
    restore(value) {
      const staged = preflight(value);
      publishAllPins(combinedPins({ material: snapshotPins(staged.bufferBindings), effects: snapshotPins(staged.effectBufferBindings), materialTextures: snapshotPins(staged.textureBindings), effectTextures: snapshotPins(staged.effectTextureBindings) }));
      deferPins = true;
      try { bufferOwner.restore(staged.bufferBindings); effectBuffers.restore(staged.effectBufferBindings); textureOwner.restore(staged.textureBindings); effectTextures.restore(staged.effectTextureBindings); }
      finally { deferPins = false; }
      parameters.restore(staged.materialState);
      surfaces.restore(staged.surfaceState);
      postProcessOwner.restore(staged.effects);
      current = staged.settings;
    },
    dispose,
    inspect: () => service.state(),
  })) satisfies RuntimePluginFactory;
  return {
    factory,
    service,
    parameters,
    postProcesses: postProcessOwner,
    buffers: bufferOwner,
    effectBuffers,
    textures: textureOwner,
    effectTextures,
    dispose,
  };
}
