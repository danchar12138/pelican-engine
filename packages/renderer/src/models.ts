import * as THREE from "three/webgpu";
import { GLTFLoader, type GLTF } from "three/addons/loaders/GLTFLoader.js";
import { normalizeSparseGLB } from "../../assets/src/glb-sparse.ts";
import { clone as cloneSkeleton } from "three/addons/utils/SkeletonUtils.js";
import {
  associateEmbeddedImage,
  releaseEmbeddedImage,
} from "./embedded-image-pixels.ts";
import type {
  AnimationService,
  AnimationControlService,
  AssetDefinition,
  ModelDefinition,
} from "../../sdk/src/index.ts";

export type ModelSource = string | { id: string; url?: string; path?: string };
export interface ModelFadeSnapshot {
  from: number;
  to: 0 | 1;
  duration: number;
  elapsed: number;
}
export interface ModelActionSnapshot {
  clip: string;
  time: number;
  playing: boolean;
  speed: number;
  loop: boolean;
  weight: number;
  paused: boolean;
  fade: ModelFadeSnapshot | null;
}
export interface ModelAnimationSnapshot {
  entity: string;
  asset: string;
  currentClip: string | null;
  /** Optional for compatibility with snapshots created before animation suspension. */
  suspended?: boolean;
  blend?: { first: string; second: string; weight: number };
  actions: ModelActionSnapshot[];
}
export interface ModelLibrarySnapshot {
  format: "pelican.models";
  version: 2;
  animations: ModelAnimationSnapshot[];
}
export interface ModelInspection {
  disposed: boolean;
  templates: {
    id: string;
    animations: string[];
    meshes: number;
    primitives: number;
  }[];
  instances: number;
  definitions: number;
  playing: number;
  owned: {
    geometries: number;
    materials: number;
    textures: number;
    skeletons: number;
  };
}
export interface ModelLibraryOptions {
  fetch?: typeof fetch;
  baseURL?: string;
  /** Borrow a game-content material when an instance is created. */
  material?: (id: string) => THREE.Material | undefined;
}
export interface ModelInstance {
  readonly entity: string;
  readonly node: THREE.Group;
  dispose(): void;
}
export interface ModelBinding {
  entity: string;
  definition: ModelDefinition;
}
export interface ModelLibrary {
  prepare(
    assets?: readonly ModelSource[],
    options?: { signal?: AbortSignal },
  ): Promise<void>;
  register(
    entityId: string,
    definition: ModelDefinition,
    parent?: THREE.Object3D,
  ): void;
  get(entityId: string): ModelInstance | undefined;
  attach(entityId: string, parent: THREE.Object3D): ModelInstance;
  reconcile(
    activeIds: readonly string[],
    parent?: THREE.Object3D,
  ): readonly ModelInstance[];
  reconcileBindings(bindings: readonly ModelBinding[]): readonly ModelInstance[];
  instantiate(
    entityId: string,
    definition: ModelDefinition,
    parent?: THREE.Object3D,
  ): ModelInstance;
  remove(entityId: string): void;
  tick(dt: number): void;
  readonly animation: AnimationControlService;
  snapshot(): ModelLibrarySnapshot;
  validateSnapshot(value: unknown, bindings?: readonly ModelBinding[]): ModelLibrarySnapshot;
  restore(value: unknown, bindings?: readonly ModelBinding[]): void;
  inspect(): ModelInspection;
  dispose(): Promise<void>;
}

interface ModelTemplate {
  id: string;
  scene: THREE.Group;
  resources: ModelResources;
  clips: THREE.AnimationClip[];
  meshes: number;
  primitives: number;
}
type NormalizedModelDefinition = Omit<
  ModelDefinition,
  "asset" | "material" | "materialSlots"
> & {
  asset: string;
  material?: string;
  materialSlots?: Record<string, string>;
};
type AnimationPlayOptions = NonNullable<Parameters<AnimationService["play"]>[2]>;
interface KnownDefinition {
  definition: NormalizedModelDefinition;
  parent?: THREE.Object3D;
}
interface InstanceState {
  entity: string;
  asset: string;
  node: THREE.Group;
  handle: ModelInstance;
  root: THREE.Object3D;
  mixer: THREE.AnimationMixer;
  clips: Map<string, THREE.AnimationClip>;
  actions: Map<string, THREE.AnimationAction>;
  action: THREE.AnimationAction | null;
  clip: string | null;
  suspended: boolean;
  fades: Map<string, ModelFadeSnapshot>;
  blend: { first: string; second: string; weight: number } | null;
}

function attemptCleanup(failures: unknown[], action: () => void): void {
  try { action(); } catch (error) { failures.push(error); }
}
function reportCleanup(failures: unknown[], message: string): void {
  if (failures.length) throw new AggregateError(failures, message);
}

/** Tracks decoded dependencies, including resources outside the default scene. */
class ModelResources {
  readonly geometries = new Set<THREE.BufferGeometry>();
  readonly materials = new Set<THREE.Material>();
  readonly textures = new Set<THREE.Texture>();
  readonly skeletons = new Set<THREE.Skeleton>();
  private readonly bitmaps = new Set<{ close(): void }>();

  collect(value: unknown): void {
    if (Array.isArray(value)) {
      for (const item of value) this.collect(item);
    } else if (value instanceof THREE.Object3D) {
      value.traverse((object) => {
        const mesh = object as THREE.Mesh;
        this.collect(mesh.geometry);
        this.collect(mesh.material);
        if ((object as THREE.SkinnedMesh).isSkinnedMesh)
          this.collect((object as THREE.SkinnedMesh).skeleton);
      });
    } else if (value instanceof THREE.BufferGeometry)
      this.geometries.add(value);
    else if (value instanceof THREE.Skeleton) this.skeletons.add(value);
    else if (value instanceof THREE.Material && !this.materials.has(value)) {
      this.materials.add(value);
      for (const field of Object.values(value))
        if (field instanceof THREE.Texture) this.collect(field);
    } else if (value instanceof THREE.Texture) {
      this.textures.add(value);
      const data = value.source?.data;
      if (data && typeof data.close === "function") this.bitmaps.add(data);
    }
  }

  dispose(): void {
    const failures: unknown[] = [];
    for (const skeleton of this.skeletons) attemptCleanup(failures, () => skeleton.dispose());
    for (const geometry of this.geometries) attemptCleanup(failures, () => geometry.dispose());
    for (const material of this.materials) attemptCleanup(failures, () => material.dispose());
    for (const texture of this.textures) {
      attemptCleanup(failures, () => releaseEmbeddedImage(texture));
      attemptCleanup(failures, () => texture.dispose());
    }
    for (const bitmap of this.bitmaps) attemptCleanup(failures, () => bitmap.close());
    this.skeletons.clear();
    this.geometries.clear();
    this.materials.clear();
    this.textures.clear();
    this.bitmaps.clear();
    reportCleanup(failures, "TC_MODEL_RESOURCES_DISPOSE: Some model resources could not be released; inspect the error causes and restart the scene.");
  }
}

interface PendingTemplate {
  controller: AbortController;
  promise: Promise<ModelTemplate>;
  callers: number;
  settled: boolean;
}

function disposeInstanceResources(root: THREE.Object3D): void {
  const failures: unknown[] = [], skeletons = new Set<THREE.Skeleton>(), shadows = new Set<THREE.LightShadow>();
  attemptCleanup(failures, () => root.traverse((object) => {
    if ((object as THREE.SkinnedMesh).isSkinnedMesh)
      skeletons.add((object as THREE.SkinnedMesh).skeleton);
    if (object instanceof THREE.PointLight || object instanceof THREE.SpotLight || object instanceof THREE.DirectionalLight)
      shadows.add(object.shadow);
  }));
  for (const shadow of shadows) attemptCleanup(failures, () => shadow.dispose());
  for (const skeleton of skeletons) attemptCleanup(failures, () => skeleton.dispose());
  reportCleanup(failures, "TC_MODEL_INSTANCE_DISPOSE: Some instance resources could not be released; inspect the error causes and restart the scene.");
}

function assetIdentity(source: ModelSource): { id: string; url?: string } {
  if (typeof source === "string") {
    if (!source.trim()) throw new Error("TC_MODEL_INVALID_ASSET");
    return { id: source };
  }
  if (!source || typeof source !== "object")
    throw new Error("TC_MODEL_INVALID_ASSET");
  const asset = source as AssetDefinition;
  const id = asset.id;
  if (typeof id !== "string" || !id.trim())
    throw new Error("TC_MODEL_INVALID_ASSET");
  const url = "url" in source ? source.url : asset.path;
  if (url !== undefined && (typeof url !== "string" || !url.trim()))
    throw new Error("TC_MODEL_INVALID_ASSET");
  return { id, url };
}

class ModelLibraryImpl implements ModelLibrary {
  private readonly urls = new Map<string, string>();
  private readonly templates = new Map<string, ModelTemplate>();
  private readonly pending = new Map<string, PendingTemplate>();
  private readonly loads = new Set<PendingTemplate>();
  private readonly instances = new Map<string, InstanceState>();
  private readonly definitions = new Map<string, KnownDefinition>();
  private readonly fetcher: typeof fetch;
  private closed = false;
  private disposing?: Promise<void>;

  readonly animation: AnimationControlService = {
    play: (entity, clip, options = {}) => this.play(entity, clip, options),
    blend: (entity, first, second, weight) => {
      const state = this.instance(entity), a = state.clips.get(first), b = state.clips.get(second);
      if (!a || !b || first === second) throw new Error(`TC_MODEL_BLEND_CLIPS: ${entity}; choose two distinct existing clips.`);
      if (!Number.isFinite(weight) || weight < 0 || weight > 1) throw new Error("TC_MODEL_BLEND_WEIGHT: Weight must be finite and within [0,1].");
      for (const action of state.actions.values()) action.stop();
      state.actions.clear(); state.fades.clear();
      const firstAction = state.mixer.clipAction(a), secondAction = state.mixer.clipAction(b);
      for (const action of [firstAction, secondAction]) {
        action.reset(); action.setEffectiveTimeScale(1); action.setLoop(THREE.LoopRepeat, Infinity); action.clampWhenFinished = false;
      }
      firstAction.setEffectiveWeight(1 - weight).play();
      secondAction.setEffectiveWeight(weight).play();
      state.actions.set(first, firstAction); state.actions.set(second, secondAction);
      state.action = firstAction; state.clip = first; state.blend = { first, second, weight };
      state.mixer.update(0);
    },
    setBlendWeight: (entity, weight) => {
      const state = this.instance(entity), blend = state.blend;
      if (!blend) throw new Error(`TC_MODEL_BLEND_MISSING: ${entity}; start a blend first.`);
      if (!Number.isFinite(weight) || weight < 0 || weight > 1) throw new Error("TC_MODEL_BLEND_WEIGHT: Weight must be finite and within [0,1].");
      state.actions.get(blend.first)!.setEffectiveWeight(1 - weight);
      state.actions.get(blend.second)!.setEffectiveWeight(weight);
      blend.weight = weight;
      state.mixer.update(0);
    },
    state: (entity) => {
      const instance = this.instance(entity);
      return {
        clip: instance.clip,
        time: instance.action?.time ?? 0,
        playing: !instance.suspended && (instance.action?.isRunning() ?? false),
      };
    },
    clips: (entity) => [...this.instance(entity).clips.values()]
      .map(({ name, duration }) => ({ name, duration })),
    pause: (entity) => { this.instance(entity).suspended = true; },
    resume: (entity) => { this.instance(entity).suspended = false; },
    seek: (entity, time) => {
      const state = this.instance(entity);
      const action = state.action;
      const clip = state.clip === null ? undefined : state.clips.get(state.clip);
      if (!action || !clip)
        throw new Error(`TC_MODEL_ANIMATION_MISSING: ${entity}; play a clip before seeking.`);
      if (!Number.isFinite(time) || time < 0 || time > clip.duration)
        throw new Error(`TC_MODEL_ANIMATION_TIME: ${entity}; time must be within [0, ${clip.duration}] seconds.`);
      action.time = time;
      state.mixer.update(0);
    },
    setSpeed: (entity, speed) => {
      const state = this.instance(entity);
      if (!state.action)
        throw new Error(`TC_MODEL_ANIMATION_MISSING: ${entity}; play a clip before changing speed.`);
      if (!Number.isFinite(speed))
        throw new Error(`TC_MODEL_ANIMATION_SPEED: ${entity}; speed must be finite.`);
      state.action.setEffectiveTimeScale(speed);
    },
  };

  constructor(
    sources: Record<string, string> | readonly ModelSource[],
    private readonly options: ModelLibraryOptions,
  ) {
    this.fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
    if (Array.isArray(sources)) {
      for (const source of sources) {
        const item = assetIdentity(source);
        if (item.url) {
          const previous = this.urls.get(item.id);
          if (previous && previous !== item.url)
            throw new Error("TC_MODEL_ASSET_CONFLICT");
          this.urls.set(item.id, item.url);
        }
      }
    } else {
      for (const [id, url] of Object.entries(sources)) {
        if (!id.trim() || typeof url !== "string" || !url.trim())
          throw new Error("TC_MODEL_INVALID_ASSET");
        this.urls.set(id, url);
      }
    }
  }

  async prepare(
    assets: readonly ModelSource[] = [...this.urls.keys()],
    options: { signal?: AbortSignal } = {},
  ): Promise<void> {
    this.assertOpen();
    if (options.signal?.aborted) throw new Error("TC_MODEL_CANCELLED");
    const identities = assets.map(assetIdentity);
    const urls = new Map(this.urls);
    for (const asset of identities) {
      if (asset.url) {
        const previous = urls.get(asset.id);
        if (previous && previous !== asset.url)
          throw new Error("TC_MODEL_ASSET_CONFLICT");
        urls.set(asset.id, asset.url);
      }
      if (!urls.has(asset.id))
        throw new Error(`TC_MODEL_ASSET_UNKNOWN: ${asset.id}`);
    }
    for (const [id, url] of urls) this.urls.set(id, url);
    await Promise.all(
      identities.map((asset) => this.loadTemplate(asset.id, options.signal)),
    );
  }

  register(
    entityId: string,
    definition: ModelDefinition,
    parent?: THREE.Object3D,
  ): void {
    this.assertOpen();
    const normalized = this.normalizeDefinition(entityId, definition);
    const previous = this.definitions.get(entityId);
    this.definitions.set(entityId, {
      definition: normalized,
      parent: parent ?? previous?.parent,
    });
  }

  get(entityId: string): ModelInstance | undefined {
    this.assertOpen();
    return this.instances.get(entityId)?.handle;
  }

  attach(entityId: string, parent: THREE.Object3D): ModelInstance {
    this.assertOpen();
    const known = this.knownDefinition(entityId);
    let instance = this.get(entityId);
    if (!instance) instance = this.instantiate(entityId, known.definition);
    parent.add(instance.node);
    this.knownDefinition(entityId).parent = parent;
    return instance;
  }

  reconcile(
    activeIds: readonly string[],
    parent?: THREE.Object3D,
  ): readonly ModelInstance[] {
    this.assertOpen();
    const ids = new Set<string>();
    for (const id of activeIds) {
      if (ids.has(id)) throw new Error(`TC_MODEL_ENTITY_DUPLICATE: ${id}`);
      this.knownDefinition(id);
      ids.add(id);
    }
    const staged = this.stageInstances(ids);
    this.commitInstances(ids, staged, parent);
    return [...ids].map((id) => this.instances.get(id)!.handle);
  }

  reconcileBindings(bindings: readonly ModelBinding[]): readonly ModelInstance[] {
    this.assertOpen();
    const definitions = this.candidateDefinitions(bindings);
    const ids = new Set(definitions.keys());
    const staged = this.stageInstances(ids, definitions);
    try {
      for (const [id, state] of staged)
        definitions.get(id)!.parent?.add(state.node);
    } catch (error) {
      for (const state of staged.values()) this.releaseInstance(state);
      throw error;
    }
    for (const [id, known] of definitions) this.definitions.set(id, known);
    this.commitInstances(ids, staged, undefined, true);
    return [...ids].map((id) => this.instances.get(id)!.handle);
  }

  private candidateDefinitions(bindings: readonly ModelBinding[]): Map<string, KnownDefinition> {
    const result = new Map<string, KnownDefinition>();
    for (const { entity, definition } of bindings) {
      if (result.has(entity)) throw new Error(`TC_MODEL_ENTITY_DUPLICATE: ${entity}`);
      result.set(entity, {
        definition: this.normalizeDefinition(entity, definition, true),
        parent: this.definitions.get(entity)?.parent,
      });
    }
    return result;
  }

  instantiate(
    entityId: string,
    definition: ModelDefinition,
    parent?: THREE.Object3D,
  ): ModelInstance {
    this.assertOpen();
    if (this.instances.has(entityId))
      throw new Error(`TC_MODEL_ENTITY_DUPLICATE: ${entityId}`);
    const normalized = this.normalizeDefinition(entityId, definition);
    const state = this.createInstance(entityId, normalized);
    const rememberedParent = parent ?? this.definitions.get(entityId)?.parent;
    this.definitions.set(entityId, {
      definition: normalized,
      parent: rememberedParent,
    });
    this.instances.set(entityId, state);
    // Explicit instantiate only attaches when a parent is supplied; attach/reconcile can
    // re-use a remembered parent after a host restore.
    parent?.add(state.node);
    return state.handle;
  }

  remove(entityId: string): void {
    const state = this.instances.get(entityId);
    if (!state) return;
    try { this.releaseInstance(state); }
    finally { this.instances.delete(entityId); }
  }

  private knownDefinition(entity: string): KnownDefinition {
    const known = this.definitions.get(entity);
    if (!known)
      throw new Error(
        `TC_MODEL_DEFINITION_MISSING: ${entity}; register the model definition before restoring or reconciling`,
      );
    return known;
  }

  private normalizeDefinition(
    entityId: string,
    definition: ModelDefinition,
    allowReplacement = false,
  ): NormalizedModelDefinition {
    if (typeof entityId !== "string" || !entityId.trim())
      throw new Error("TC_MODEL_INVALID_ENTITY");
    const assetId =
      typeof definition.asset === "string"
        ? definition.asset
        : definition.asset.id;
    const template = this.templates.get(assetId);
    if (!template) throw new Error(`TC_MODEL_NOT_PREPARED: ${assetId}`);
    const scale = definition.scale ?? 1;
    if (!Number.isFinite(scale) || scale <= 0)
      throw new Error("TC_MODEL_INVALID_SCALE");
    for (const [label, vector] of [
      ["OFFSET", definition.offset],
      ["ROTATION", definition.rotation],
    ] as const)
      if (
        vector !== undefined &&
        (!Array.isArray(vector) ||
          vector.length !== 3 ||
          ![0, 1, 2].every((index) => Number.isFinite(vector[index])))
      )
        throw new Error(`TC_MODEL_INVALID_${label}`);
    for (const field of ["castShadow", "receiveShadow", "embeddedLights", "embeddedLightShadows"] as const)
      if (
        definition[field] !== undefined &&
        typeof definition[field] !== "boolean"
      )
        throw new Error("TC_MODEL_INVALID_SHADOW");
    const override = definition.material;
    const materialId =
      typeof override === "string"
        ? override
        : override &&
            typeof override === "object" &&
            override.kind === "material"
          ? override.id
          : undefined;
    if (
      override !== undefined &&
      (typeof materialId !== "string" || !materialId.trim())
    )
      throw new Error(
        `TC_MODEL_INVALID_MATERIAL: ${entityId}; use a non-empty material ID or MaterialDefinition`,
      );
    const slots = definition.materialSlots;
    if (slots !== undefined && override !== undefined)
      throw new Error(
        `TC_MODEL_MATERIAL_CONFLICT: ${entityId}; use material or materialSlots, not both`,
      );
    let materialSlots: Record<string, string> | undefined;
    if (slots !== undefined) {
      if (!slots || typeof slots !== "object" || Array.isArray(slots) || !Object.keys(slots).length)
        throw new Error(
          `TC_MODEL_INVALID_MATERIAL_SLOTS: ${entityId}; provide a non-empty slot map`,
        );
      materialSlots = Object.fromEntries(
        Object.entries(slots).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([name, value]) => {
          const id = typeof value === "string" ? value : value && typeof value === "object" && value.kind === "material" ? value.id : undefined;
          if (!name.trim() || typeof id !== "string" || !id.trim())
            throw new Error(
              `TC_MODEL_INVALID_MATERIAL_SLOTS: ${entityId}: ${name}; provide a named slot and material ID`,
            );
          return [name, id];
        }),
      );
    }
    const normalized: NormalizedModelDefinition = {
      castShadow: definition.castShadow !== false,
      receiveShadow: definition.receiveShadow !== false,
      embeddedLights: definition.embeddedLights !== false,
      embeddedLightShadows: definition.embeddedLightShadows === true,
      asset: assetId,
      ...(materialId !== undefined ? { material: materialId } : {}),
      ...(materialSlots !== undefined ? { materialSlots } : {}),
      scale,
      offset: [...(definition.offset ?? [0, 0, 0])],
      rotation: [...(definition.rotation ?? [0, 0, 0])],
      ...(definition.animation
        ? {
            animation: {
              clip: definition.animation.clip,
              speed: definition.animation.speed ?? 1,
              loop: definition.animation.loop ?? true,
            },
          }
        : {}),
    };
    if (normalized.animation) {
      if (
        !template.clips.some((clip) => clip.name === normalized.animation!.clip)
      )
        throw new Error(
          `TC_MODEL_CLIP_MISSING: ${normalized.animation.clip}; available: ${template.clips.map((clip) => clip.name).join(", ")}`,
        );
      if (
        !Number.isFinite(normalized.animation.speed) ||
        typeof normalized.animation.loop !== "boolean"
      )
        throw new Error("TC_MODEL_INVALID_ANIMATION_OPTIONS");
    }
    const known = this.definitions.get(entityId);
    if (
      known &&
      !allowReplacement &&
      JSON.stringify(known.definition) !== JSON.stringify(normalized)
    )
      throw new Error(
        `TC_MODEL_DEFINITION_CONFLICT: ${entityId}; use a new library when authored model definitions change`,
      );
    return normalized;
  }

  private createInstance(
    entityId: string,
    definition: NormalizedModelDefinition,
    initializeAnimation = true,
  ): InstanceState {
    // Registration precedes game-material preparation. Resolve once here, before
    // cloning any private skeletons, and keep the borrowed material unowned.
    const material =
      definition.material === undefined
        ? undefined
        : this.options.material?.(definition.material);
    if (definition.material !== undefined && material === undefined)
      throw new Error(
        `TC_MODEL_MATERIAL_MISSING: ${entityId}: ${definition.material}; prepare the game material before creating model instances`,
      );
    const assetId = definition.asset;
    const template = this.templates.get(assetId)!;
    const slotMaterials = new Map<string, THREE.Material>();
    for (const [slot, id] of Object.entries(definition.materialSlots ?? {})) {
      const replacement = this.options.material?.(id);
      if (replacement === undefined)
        throw new Error(
          `TC_MODEL_MATERIAL_MISSING: ${entityId}: ${id}; prepare the game material before creating model instances`,
        );
      slotMaterials.set(slot, replacement);
    }
    const unmatched = new Set(slotMaterials.keys());
    const available = new Set<string>();
    if (unmatched.size)
      template.scene.traverse((object) => {
        if (object instanceof THREE.Mesh)
          for (const source of Array.isArray(object.material) ? object.material : [object.material]) {
            if (source.name) available.add(source.name);
            unmatched.delete(source.name);
          }
      });
    if (unmatched.size) {
      const names = [...available].sort().slice(0, 20);
      const missing = [...unmatched].sort().slice(0, 20);
      const label = (name: string) => JSON.stringify(name.length > 120 ? name.slice(0, 120) + "..." : name);
      throw new Error(
        `TC_MODEL_MATERIAL_SLOT_MISSING: ${entityId}: ${missing.map(label).join(", ")}${unmatched.size > missing.length ? ` and ${unmatched.size - missing.length} more` : ""}; available loaded material names: ${names.length ? names.map(label).join(", ") : "(none)"}${available.size > names.length ? ` and ${available.size - names.length} more` : ""}; use exact loaded names`,
      );
    }
    const root = cloneSkeleton(template.scene);
    const clones = new Map<THREE.Object3D, THREE.Object3D>();
    const pending: [THREE.Object3D, THREE.Object3D][] = [[template.scene, root]];
    while (pending.length) {
      const [source, copy] = pending.pop()!;
      clones.set(source, copy);
      for (let i = 0; i < source.children.length; i++)
        pending.push([source.children[i], copy.children[i]]);
    }
    for (const [source, copy] of clones) {
      if ((source instanceof THREE.DirectionalLight && copy instanceof THREE.DirectionalLight) ||
          (source instanceof THREE.SpotLight && copy instanceof THREE.SpotLight)) {
        const detachedChild = source.children.find(child =>
          child.type === "Object3D" && child.children.length === 0 &&
          child.position.equals(source.target.position) &&
          child.quaternion.equals(source.target.quaternion) &&
          child.scale.equals(source.target.scale));
        const target = clones.get(source.target) ?? (detachedChild && clones.get(detachedChild));
        if (!target) {
          disposeInstanceResources(root);
          throw new Error(`TC_MODEL_LIGHT_TARGET: ${entityId}: light '${source.name}' has no target in its model; re-export the model.`);
        }
        copy.target = target;
      }
    }
    root.traverse((object) => {
      if (object instanceof THREE.PointLight || object instanceof THREE.SpotLight || object instanceof THREE.DirectionalLight) {
        object.visible = definition.embeddedLights !== false;
        object.castShadow = definition.embeddedLightShadows === true;
      }
      if (object instanceof THREE.Mesh) {
        if (material !== undefined)
          object.material = Array.isArray(object.material)
            ? object.material.map(() => material)
            : material;
        else if (slotMaterials.size)
          object.material = Array.isArray(object.material)
            ? object.material.map((source) => slotMaterials.get(source.name) ?? source)
            : slotMaterials.get(object.material.name) ?? object.material;
        object.castShadow = definition.castShadow !== false;
        object.receiveShadow = definition.receiveShadow !== false;
      }
    });
    const node = new THREE.Group();
    node.name = `pelican-model:${entityId}`;
    node.scale.setScalar(definition.scale!);
    node.position.fromArray(definition.offset!);
    node.rotation.set(...definition.rotation!);
    node.add(root);
    const state: InstanceState = {
      entity: entityId,
      asset: assetId,
      node,
      handle: undefined!,
      root,
      mixer: new THREE.AnimationMixer(root),
      clips: new Map(template.clips.map((clip) => [clip.name, clip])),
      actions: new Map(),
      action: null,
      clip: null,
      suspended: false,
      fades: new Map(),
      blend: null,
    };
    state.handle = Object.freeze({
      entity: entityId,
      node,
      dispose: () => {
        if (this.instances.get(entityId) === state) this.remove(entityId);
      },
    });
    try {
      if (initializeAnimation && definition.animation)
        this.playState(state, definition.animation.clip, definition.animation);
      return state;
    } catch (error) {
      this.releaseInstance(state);
      throw error;
    }
  }

  private releaseInstance(state: InstanceState): void {
    const failures: unknown[] = [];
    attemptCleanup(failures, () => state.mixer.stopAllAction());
    attemptCleanup(failures, () => state.mixer.uncacheRoot(state.root));
    attemptCleanup(failures, () => state.node.removeFromParent());
    attemptCleanup(failures, () => disposeInstanceResources(state.root));
    reportCleanup(failures, `TC_MODEL_INSTANCE_DISPOSE: Failed to release instance '${state.entity}'; inspect the error causes and restart the scene.`);
  }

  private stageInstances(ids: ReadonlySet<string>, definitions = this.definitions, initializeAnimation = true): Map<string, InstanceState> {
    const staged = new Map<string, InstanceState>();
    try {
      for (const id of ids) {
        const known = definitions.get(id);
        if (!known) throw new Error(`TC_MODEL_DEFINITION_MISSING: ${id}`);
        if (!this.instances.has(id) ||
            JSON.stringify(this.definitions.get(id)?.definition) !== JSON.stringify(known.definition))
          staged.set(
            id,
            this.createInstance(id, known.definition, initializeAnimation),
          );
      }
      return staged;
    } catch (error) {
      for (const state of staged.values()) this.releaseInstance(state);
      throw error;
    }
  }

  private commitInstances(
    ids: ReadonlySet<string>,
    staged: ReadonlyMap<string, InstanceState>,
    parent?: THREE.Object3D,
    stagedAttached = false,
  ): void {
    for (const id of this.instances.keys()) if (!ids.has(id)) this.remove(id);
    for (const [id, state] of staged) {
      this.remove(id);
      this.instances.set(id, state);
    }
    for (const id of ids) {
      const known = this.knownDefinition(id);
      if (parent) known.parent = parent;
      if ((parent || (staged.has(id) && !stagedAttached)) && known.parent)
        known.parent.add(this.instances.get(id)!.node);
    }
  }

  tick(dt: number): void {
    this.assertOpen();
    if (!Number.isFinite(dt) || dt < 0) throw new Error("TC_MODEL_INVALID_DT");
    for (const state of this.instances.values()) {
      if (state.suspended) continue;
      for (const [name, fade] of state.fades) {
        fade.elapsed = Math.min(fade.duration, fade.elapsed + dt);
        state.actions.get(name)!.setEffectiveWeight(this.fadeWeight(fade));
      }
      state.mixer.update(dt);
      for (const [name, fade] of state.fades) {
        if (fade.elapsed < fade.duration) continue;
        state.fades.delete(name);
        if (fade.to === 0) {
          state.actions.get(name)!.stop();
          state.actions.delete(name);
        }
      }
    }
  }

  snapshot(): ModelLibrarySnapshot {
    this.assertOpen();
    return {
      format: "pelican.models",
      version: 2,
      animations: [...this.instances.values()]
        .sort((a, b) => a.entity.localeCompare(b.entity))
        .map(
          (state): ModelAnimationSnapshot => ({
            entity: state.entity,
            asset: state.asset,
            currentClip: state.clip,
            ...(state.suspended ? { suspended: true } : {}),
            ...(state.blend ? { blend: { ...state.blend } } : {}),
            actions: [...state.actions.entries()].map(([clip, action]) => ({
              clip,
              time: action.time,
              playing: action.isRunning(),
              speed: action.timeScale,
              loop: action.loop === THREE.LoopRepeat,
              weight: action.getEffectiveWeight(),
              paused: action.paused,
              fade: state.fades.has(clip)
                ? { ...state.fades.get(clip)! }
                : null,
            })),
          }),
        ),
    };
  }

  validateSnapshot(value: unknown, bindings?: readonly ModelBinding[]): ModelLibrarySnapshot {
    this.assertOpen();
    const definitions = bindings ? this.candidateDefinitions(bindings) : this.definitions;
    const invalid = () => new Error("TC_MODEL_INVALID_SNAPSHOT");
    if (!value || typeof value !== "object") throw invalid();
    const data = value as ModelLibrarySnapshot;
    if (
      data.format !== "pelican.models" ||
      data.version !== 2 ||
      !Array.isArray(data.animations)
    )
      throw invalid();
    const ids = new Set<string>();
    for (const item of data.animations) {
      if (
        !item ||
        typeof item.entity !== "string" ||
        !item.entity ||
        ids.has(item.entity)
      )
        throw invalid();
      ids.add(item.entity);
      const known = definitions.get(item.entity);
      if (!known)
        throw new Error(
          `TC_MODEL_INVALID_SNAPSHOT: TC_MODEL_DEFINITION_MISSING: ${item.entity}; register the model definition before restoring`,
        );
      if (item.asset !== known.definition.asset) throw invalid();
      const template = this.templates.get(item.asset);
      if (!template) throw invalid();
      const clips = new Map(template.clips.map((clip) => [clip.name, clip]));
      if (
        item.currentClip !== null &&
        (typeof item.currentClip !== "string" || !clips.has(item.currentClip))
      )
        throw invalid();
      if (item.suspended !== undefined && typeof item.suspended !== "boolean") throw invalid();
      const blend = item.blend;
      if (blend !== undefined && (!blend || typeof blend !== "object" || typeof blend.first !== "string" || typeof blend.second !== "string" ||
          blend.first === blend.second || !clips.has(blend.first) || !clips.has(blend.second) || item.currentClip !== blend.first ||
          !Number.isFinite(blend.weight) || blend.weight < 0 || blend.weight > 1)) throw invalid();
      if (!Array.isArray(item.actions)) throw invalid();
      const actionNames = new Set<string>();
      for (const action of item.actions) {
        if (
          !action ||
          typeof action.clip !== "string" ||
          actionNames.has(action.clip)
        )
          throw invalid();
        actionNames.add(action.clip);
        if (!clips.has(action.clip)) throw invalid();
        if (
          !Number.isFinite(action.time) ||
          action.time < 0 ||
          action.time > clips.get(action.clip)!.duration ||
          !Number.isFinite(action.speed) ||
          typeof action.playing !== "boolean" ||
          typeof action.loop !== "boolean" ||
          typeof action.paused !== "boolean" ||
          action.playing !== (!action.paused && action.speed !== 0) ||
          !Number.isFinite(action.weight) ||
          action.weight < 0 ||
          action.weight > 1
        )
          throw invalid();
        const fade = action.fade;
        if (fade !== null) {
          if (
            !fade ||
            typeof fade !== "object" ||
            !Number.isFinite(fade.from) ||
            fade.from < 0 ||
            fade.from > 1 ||
            (fade.to !== 0 && fade.to !== 1) ||
            !Number.isFinite(fade.duration) ||
            fade.duration <= 0 ||
            !Number.isFinite(fade.elapsed) ||
            fade.elapsed < 0 ||
            fade.elapsed >= fade.duration ||
            Math.abs(this.fadeWeight(fade) - action.weight) > 1e-7 ||
            fade.to !== (action.clip === item.currentClip ? 1 : 0)
          )
            throw invalid();
        }
        if (!blend && action.clip !== item.currentClip && (!fade || fade.to !== 0))
          throw invalid();
      }
      if (blend && (item.actions.length !== 2 || item.actions.some(action =>
        (action.clip !== blend.first && action.clip !== blend.second) || action.fade !== null || !action.loop ||
        Math.abs(action.weight - (action.clip === blend.first ? 1 - blend.weight : blend.weight)) > 1e-7))) throw invalid();
      if (item.currentClip !== null && !actionNames.has(item.currentClip))
        throw invalid();
      if (item.currentClip === null && actionNames.size) throw invalid();
    }
    return structuredClone(data);
  }

  restore(value: unknown, bindings?: readonly ModelBinding[]): void {
    const snapshot = this.validateSnapshot(value, bindings);
    const ids = new Set(snapshot.animations.map((item) => item.entity));
    const definitions = bindings ? this.candidateDefinitions(bindings) : this.definitions;
    const staged = this.stageInstances(ids, definitions, false);
    let previous = new Map<string, ModelAnimationSnapshot>();
    type PoseBinding = THREE.PropertyBinding & {
      getValue(values: number[], offset: number): void;
      setValue(values: number[], offset: number): void;
    };
    const poses: Array<{ binding: PoseBinding; values: number[] }> = [];
    const touched: InstanceState[] = [];
    let committed = false;
    let commitStarted = false;
    try {
      previous = new Map(this.snapshot().animations.map((item) => [item.entity, item]));
      // Staged tracks can target materials shared with active instances.
      const affected = snapshot.animations.map((item) =>
        staged.get(item.entity) ?? this.instances.get(item.entity)!,
      );
      for (const state of affected) {
        const tracks = new Map<string, THREE.KeyframeTrack>();
        for (const clip of state.clips.values())
          for (const track of clip.tracks) tracks.set(track.name, track);
        const values = [...tracks.values()].map((track) => {
          const binding = new THREE.PropertyBinding(state.root, track.name) as PoseBinding;
          const captured = new Array<number>(track.getValueSize());
          binding.getValue(captured, 0);
          return { binding, values: captured };
        });
        poses.push(...values);
      }
      for (const item of snapshot.animations)
        if (staged.has(item.entity))
          this.restoreAnimation(staged.get(item.entity)!, item);
      for (const [id, state] of staged)
        definitions.get(id)!.parent?.add(state.node);
      for (const item of snapshot.animations) {
        if (staged.has(item.entity)) continue;
        const state = this.instances.get(item.entity)!;
        touched.push(state);
        this.restoreAnimation(state, item);
      }
      if (bindings) for (const [id, known] of definitions) this.definitions.set(id, known);
      commitStarted = true;
      this.commitInstances(ids, staged, undefined, true);
      committed = true;
    } catch (error) {
      const failures: unknown[] = [];
      for (const state of touched) {
        try { this.restoreAnimation(state, previous.get(state.entity)!); }
        catch (rollbackError) { failures.push(rollbackError); }
      }
      // Stopping staged mixers can write shared values; restore bindings afterwards.
      for (const [id, candidate] of staged) {
        if (this.instances.get(id) !== candidate) {
          try { this.releaseInstance(candidate); }
          catch (rollbackError) { failures.push(rollbackError); }
        }
      }
      staged.clear();
      for (const pose of poses) {
        try { pose.binding.setValue(pose.values, 0); }
        catch (rollbackError) { failures.push(rollbackError); }
      }
      if (commitStarted)
        throw new AggregateError([error, ...failures], "TC_MODEL_RESTORE_COMMIT_FAILED: commit may be partial; model state is not guaranteed atomic");
      if (failures.length)
        throw new AggregateError([error, ...failures], "TC_MODEL_RESTORE_ROLLBACK_FAILED: original restore and rollback both failed");
      throw error;
    } finally {
      if (!committed)
        for (const [id, candidate] of staged)
          if (this.instances.get(id) !== candidate) this.releaseInstance(candidate);
    }
  }

  private restoreAnimation(state: InstanceState, item: ModelAnimationSnapshot): void {
    for (const action of state.actions.values()) action.stop();
    state.actions.clear();
    state.fades.clear();
    state.action = null;
    state.clip = null;
    state.blend = item.blend ? { ...item.blend } : null;
    state.suspended = item.suspended ?? false;
    for (const saved of item.actions) {
      const action = state.mixer.clipAction(state.clips.get(saved.clip)!);
      action.reset();
      action.setLoop(
        saved.loop ? THREE.LoopRepeat : THREE.LoopOnce,
        saved.loop ? Infinity : 1,
      );
      action.clampWhenFinished = !saved.loop;
      action.timeScale = saved.speed;
      action.enabled = true;
      action.setEffectiveWeight(saved.weight);
      action.play();
      action.time = saved.time;
      action.paused = saved.paused;
      if (saved.fade) state.fades.set(saved.clip, { ...saved.fade });
      state.actions.set(saved.clip, action);
    }
    state.action =
      item.currentClip === null ? null : state.actions.get(item.currentClip)!;
    state.clip = item.currentClip;
    state.mixer.update(0);
  }

  inspect(): ModelInspection {
    const geometries = new Set<THREE.BufferGeometry>();
    const materials = new Set<THREE.Material>();
    const textures = new Set<THREE.Texture>();
    const skeletons = new Set<THREE.Skeleton>();
    for (const template of this.templates.values()) {
      for (const value of template.resources.geometries) geometries.add(value);
      for (const value of template.resources.materials) materials.add(value);
      for (const value of template.resources.textures) textures.add(value);
      for (const value of template.resources.skeletons) skeletons.add(value);
    }
    const templates = [...this.templates.values()].map((template) => {
      return {
        id: template.id,
        animations: template.clips.map((clip) => clip.name),
        meshes: template.meshes,
        primitives: template.primitives,
      };
    });
    return {
      disposed: this.closed,
      templates,
      instances: this.instances.size,
      definitions: this.definitions.size,
      playing: [...this.instances.values()].filter((state) =>
        state.action?.isRunning(),
      ).length,
      owned: {
        geometries: geometries.size,
        materials: materials.size,
        textures: textures.size,
        skeletons: skeletons.size + this.instanceSkeletonCount(),
      },
    };
  }

  dispose(): Promise<void> {
    if (this.disposing) return this.disposing;
    this.closed = true;
    const pending = [...this.loads];
    // Assign the shared promise before running cleanup so reentrant calls await it too.
    this.disposing = Promise.resolve().then(async () => {
      const failures: unknown[] = [];
      for (const item of pending) attemptCleanup(failures, () => item.controller.abort());
      for (const entity of [...this.instances.keys()]) attemptCleanup(failures, () => this.remove(entity));
      const results = await Promise.allSettled(pending.map((item) => item.promise));
      for (const result of results)
        if (result.status === "rejected" && result.reason instanceof AggregateError && result.reason.message.startsWith("TC_MODEL_LOAD_CLEANUP")) failures.push(result.reason);
      for (const template of this.templates.values()) attemptCleanup(failures, () => template.resources.dispose());
      this.templates.clear();
      this.urls.clear();
      this.definitions.clear();
      this.pending.clear();
      reportCleanup(failures, "TC_MODEL_DISPOSE: Model cleanup was incomplete; inspect the error causes and restart the scene.");
    });
    return this.disposing;
  }

  private instance(entity: string): InstanceState {
    this.assertOpen();
    const value = this.instances.get(entity);
    if (!value) throw new Error(`TC_MODEL_ENTITY_MISSING: ${entity}`);
    return value;
  }

  private play(
    entity: string,
    clipName: string,
    options: AnimationPlayOptions = {},
  ): void {
    this.assertOpen();
    this.playState(this.instance(entity), clipName, options);
  }

  private playState(
    state: InstanceState,
    clipName: string,
    options: AnimationPlayOptions,
  ): void {
    const clip = state.clips.get(clipName);
    if (!clip)
      throw new Error(
        `TC_MODEL_CLIP_MISSING: ${clipName}; available: ${[...state.clips.keys()].join(", ")}`,
      );
    const fade = options.fade ?? 0;
    const speed = options.speed ?? 1;
    const loop = options.loop ?? true;
    const startAt = options.startAt ?? (speed < 0 ? clip.duration : 0);
    if (
      !Number.isFinite(fade) ||
      fade < 0 ||
      !Number.isFinite(speed) ||
      !Number.isFinite(startAt) ||
      startAt < 0 || startAt > clip.duration ||
      typeof loop !== "boolean"
    )
      throw new Error(`TC_MODEL_INVALID_ANIMATION_OPTIONS: '${clipName}' startAt must be within [0, ${clip.duration}] seconds; fade and speed must be finite and loop must be boolean.`);
    const action = state.mixer.clipAction(clip);
    state.blend = null;
    if (fade > 0) {
      for (const [name, old] of state.actions) {
        if (old === action) continue;
        state.fades.set(name, {
          from: old.getEffectiveWeight(),
          to: 0,
          duration: fade,
          elapsed: 0,
        });
      }
    } else {
      for (const old of state.actions.values()) old.stop();
      state.actions.clear();
      state.fades.clear();
    }
    action.reset();
    action.setEffectiveTimeScale(speed);
    action.setLoop(
      loop ? THREE.LoopRepeat : THREE.LoopOnce,
      loop ? Infinity : 1,
    );
    action.clampWhenFinished = !loop;
    action.setEffectiveWeight(fade > 0 ? 0 : 1).play();
    action.time = startAt;
    if (fade > 0)
      state.fades.set(clipName, { from: 0, to: 1, duration: fade, elapsed: 0 });
    else state.fades.delete(clipName);
    state.actions.set(clipName, action);
    state.action = action;
    state.clip = clipName;
    state.mixer.update(0);
  }

  private fadeWeight(fade: ModelFadeSnapshot): number {
    return fade.from + (fade.to - fade.from) * (fade.elapsed / fade.duration);
  }

  private async loadTemplate(
    id: string,
    signal?: AbortSignal,
  ): Promise<ModelTemplate> {
    if (signal?.aborted) throw new Error(`TC_MODEL_CANCELLED: ${id}`);
    const ready = this.templates.get(id);
    if (ready) return ready;
    let pending = this.pending.get(id);
    if (!pending) {
      const controller = new AbortController();
      const entry: PendingTemplate = {
        controller,
        callers: 0,
        settled: false,
        promise: undefined!,
      };
      entry.promise = Promise.resolve().then(async () => {
        const resources = new ModelResources();
        // Observers always fulfill, preventing orphan rejections while draining a failed parse.
        const decoding = new Set<Promise<void>>();
        const track = <T>(promise: Promise<T>): Promise<T> => {
          const observed = promise.then(
            (value) => {
              resources.collect(value);
            },
            () => {},
          );
          decoding.add(observed);
          void observed.then(() => decoding.delete(observed));
          return promise;
        };
        try {
          const url = this.resolveURL(this.urls.get(id)!);
          if (controller.signal.aborted || this.closed)
            throw new Error("cancelled");
          const response = await this.fetcher(url, {
            signal: controller.signal,
          });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const bytes = await response.arrayBuffer();
          if (controller.signal.aborted || this.closed)
            throw new Error("cancelled");
          const manager = new THREE.LoadingManager(
            undefined,
            undefined,
            (url) => {
              // GLTFLoader revokes successful image blob URLs, but not failed decodes.
              if (url.startsWith("blob:")) URL.revokeObjectURL(url);
            },
          );
          const loader = new GLTFLoader(manager);
          loader.register((parser) => {
            const specularColorImages = new Set<number>();
            for (const material of parser.json.materials ?? []) {
              const index =
                material.extensions?.KHR_materials_specular
                  ?.specularColorTexture?.index;
              const source =
                index === undefined
                  ? undefined
                  : parser.json.textures?.[index]?.source;
              if (source !== undefined) specularColorImages.add(source);
            }
            const dependency = parser.getDependency.bind(parser);
            parser.getDependency = (type, index) =>
              track(
                dependency(type, index).then((value) => {
                  if (type === "texture" && !value)
                    throw new Error(`TC_MODEL_TEXTURE_FAILED: ${index}`);
                  return value;
                }),
              );
            // Track each primitive separately: a failed sibling must not hide decoded geometry.
            const geometries = parser.loadGeometries.bind(parser);
            parser.loadGeometries = (primitives) =>
              Promise.all(
                primitives.map((primitive) => track(geometries([primitive]))),
              ).then((groups) => groups.flat());
            const image = parser.loadImageSource.bind(parser);
            parser.loadImageSource = (index, loader) =>
              track(
                (async () => {
                  const texture = await track(image(index, loader));
                  const definition = parser.json.images[index];
                  const uri: string | undefined = definition.uri;
                  const mime: string =
                    definition.mimeType ??
                    /^data:([^;,]+)/i.exec(uri ?? "")?.[1] ??
                    "";
                  // JPEG remains on the browser decoder path. Embedded PNG bytes are
                  // associated with Source, which GLTFLoader shares across clones.
                  if (
                    specularColorImages.has(index) &&
                    mime.toLowerCase() === "image/png"
                  ) {
                    let data: ArrayBuffer;
                    if (definition.bufferView !== undefined) {
                      data = await parser.getDependency(
                        "bufferView",
                        definition.bufferView,
                      );
                    } else if (uri?.startsWith("data:")) {
                      data = await (await fetch(uri)).arrayBuffer();
                    } else {
                      throw new Error(
                        `TC_MODEL_IMAGE_SOURCE_UNSUPPORTED: ${index}`,
                      );
                    }
                    associateEmbeddedImage(texture, new Uint8Array(data), mime);
                  }
                  return texture;
                })(),
              );
            const finalMaterial = parser.assignFinalMaterial.bind(parser);
            parser.assignFinalMaterial = (mesh) => {
              finalMaterial(mesh);
              resources.collect(mesh);
            };
            return {
              name: "PELICAN_resource_ownership",
              beforeRoot: () => {
                // Subresource fetches bypass options.fetch and its abort signal in GLTFLoader.
                for (const item of [
                  ...(parser.json.buffers ?? []),
                  ...(parser.json.images ?? []),
                ])
                  if (item.uri && !item.uri.startsWith("data:"))
                    throw new Error(
                      `TC_MODEL_EXTERNAL_URI_UNSUPPORTED: ${item.uri}; embed resources in the GLB`,
                    );
                for (const name of parser.json.extensionsRequired ?? [])
                  if (
                    !Object.hasOwn(parser.plugins, name) &&
                    !Object.hasOwn(parser.extensions, name)
                  )
                    throw new Error(`TC_MODEL_EXTENSION_UNSUPPORTED: ${name}`);
                // GLTFLoader skips node-less pointer animation channels, including
                // optional ones. Reject used channels rather than silently omit them.
                for (const [animationIndex, animation] of (parser.json.animations ?? []).entries())
                  for (const [channelIndex, channel] of (animation.channels ?? []).entries())
                    if (channel.target?.path === "pointer" || Object.hasOwn(channel.target?.extensions ?? {}, "KHR_animation_pointer"))
                      throw new Error(`TC_MODEL_EXTENSION_UNSUPPORTED: KHR_animation_pointer animation ${animationIndex} channel ${channelIndex}; pointer animation is not supported`);
                return null;
              },
            };
          });
          const normalized = normalizeSparseGLB(bytes);
          const normalizedBytes = normalized.buffer === bytes && normalized.byteOffset === 0 && normalized.byteLength === bytes.byteLength
            ? bytes
            : normalized.buffer.slice(normalized.byteOffset, normalized.byteOffset + normalized.byteLength) as ArrayBuffer;
          const gltf = await loader.parseAsync(normalizedBytes, new URL(".", url).href);
          resources.collect(gltf.scenes);
          const template = this.makeTemplate(id, gltf, resources);
          if (controller.signal.aborted || this.closed)
            throw new Error("cancelled");
          this.templates.set(id, template);
          return template;
        } catch (error) {
          while (decoding.size) await Promise.all([...decoding]);
          try { resources.dispose(); }
          catch (cleanupError) {
            throw new AggregateError([error, cleanupError], `TC_MODEL_LOAD_CLEANUP: Model '${id}' failed to load and some resources could not be released; inspect the causes and retry in a new scene.`);
          }
          if (controller.signal.aborted || this.closed)
            throw new Error(`TC_MODEL_CANCELLED: ${id}`);
          throw new Error(
            `TC_MODEL_LOAD_FAILED: ${id}: ${error instanceof Error ? error.message : "decode failed"}`,
          );
        } finally {
          entry.settled = true;
          this.loads.delete(entry);
          if (this.pending.get(id) === entry) this.pending.delete(id);
        }
      });
      pending = entry;
      this.pending.set(id, entry);
      this.loads.add(entry);
    }
    const shared = pending;
    shared.callers++;
    try {
      return await new Promise<ModelTemplate>((resolve, reject) => {
        const cleanup = () => {
          signal?.removeEventListener("abort", abort);
          shared.controller.signal.removeEventListener("abort", abort);
        };
        const abort = () => {
          cleanup();
          reject(new Error(`TC_MODEL_CANCELLED: ${id}`));
        };
        signal?.addEventListener("abort", abort, { once: true });
        shared.controller.signal.addEventListener("abort", abort, {
          once: true,
        });
        shared.promise.then(
          (value) => {
            cleanup();
            resolve(value);
          },
          (error) => {
            cleanup();
            reject(error);
          },
        );
        if (signal?.aborted || shared.controller.signal.aborted) abort();
      });
    } finally {
      shared.callers--;
      if (shared.callers === 0 && !shared.settled) {
        shared.controller.abort();
        if (this.pending.get(id) === shared) this.pending.delete(id);
      }
    }
  }

  private makeTemplate(
    id: string,
    gltf: GLTF,
    resources: ModelResources,
  ): ModelTemplate {
    const names = new Set<string>();
    for (const clip of gltf.animations) {
      if (!clip.name.trim() || names.has(clip.name))
        throw new Error(
          `TC_MODEL_CLIP_DUPLICATE: ${clip.name}; give every animation a unique name`,
        );
      if (!Number.isFinite(clip.duration) || clip.duration <= 0)
        throw new Error(
          `TC_MODEL_INVALID_CLIP_DURATION: ${clip.name}; animation duration must be positive`,
        );
      names.add(clip.name);
    }
    let meshes = 0,
      primitives = 0;
    gltf.scene.traverse((object) => {
      if ((object as THREE.Mesh).isMesh) {
        meshes++;
        const mesh = object as THREE.Mesh;
        primitives += Array.isArray(mesh.material) ? mesh.material.length : 1;
      }
    });
    return {
      id,
      scene: gltf.scene,
      resources,
      clips: gltf.animations,
      meshes,
      primitives,
    };
  }

  private instanceSkeletonCount(): number {
    const values = new Set<THREE.Skeleton>();
    for (const state of this.instances.values())
      state.root.traverse((object) => {
        if ((object as THREE.SkinnedMesh).isSkinnedMesh)
          values.add((object as THREE.SkinnedMesh).skeleton);
      });
    return values.size;
  }

  private resolveURL(value: string): string {
    try {
      return new URL(value, this.options.baseURL ?? import.meta.url).href;
    } catch {
      throw new Error("TC_MODEL_INVALID_URL");
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("TC_MODEL_LIBRARY_DISPOSED");
  }
}

export function createModelLibrary(
  assets: Record<string, string> | readonly ModelSource[],
  options: ModelLibraryOptions = {},
): ModelLibrary {
  return new ModelLibraryImpl(assets, options);
}
