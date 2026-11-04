import * as THREE from "three/webgpu";
import { GLTFLoader, type GLTF } from "three/addons/loaders/GLTFLoader.js";
import { clone as cloneSkeleton } from "three/addons/utils/SkeletonUtils.js";
import type {
  AnimationService,
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
  actions: ModelActionSnapshot[];
}
export interface ModelLibrarySnapshot {
  format: "threecat.models";
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
}
export interface ModelInstance {
  readonly entity: string;
  readonly node: THREE.Group;
  dispose(): void;
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
  instantiate(
    entityId: string,
    definition: ModelDefinition,
    parent?: THREE.Object3D,
  ): ModelInstance;
  remove(entityId: string): void;
  tick(dt: number): void;
  readonly animation: AnimationService;
  snapshot(): ModelLibrarySnapshot;
  validateSnapshot(value: unknown): ModelLibrarySnapshot;
  restore(value: unknown): void;
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
interface KnownDefinition {
  definition: ModelDefinition;
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
  fades: Map<string, ModelFadeSnapshot>;
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
    for (const skeleton of this.skeletons) skeleton.dispose();
    for (const geometry of this.geometries) geometry.dispose();
    for (const material of this.materials) material.dispose();
    for (const texture of this.textures) texture.dispose();
    for (const bitmap of this.bitmaps) bitmap.close();
    this.skeletons.clear();
    this.geometries.clear();
    this.materials.clear();
    this.textures.clear();
    this.bitmaps.clear();
  }
}

interface PendingTemplate {
  controller: AbortController;
  promise: Promise<ModelTemplate>;
  callers: number;
  settled: boolean;
}

function disposeInstanceSkeletons(root: THREE.Object3D): void {
  const skeletons = new Set<THREE.Skeleton>();
  root.traverse((object) => {
    if ((object as THREE.SkinnedMesh).isSkinnedMesh)
      skeletons.add((object as THREE.SkinnedMesh).skeleton);
  });
  for (const skeleton of skeletons) skeleton.dispose();
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

  readonly animation: AnimationService = {
    play: (entity, clip, options = {}) => this.play(entity, clip, options),
    state: (entity) => {
      const instance = this.instance(entity);
      return {
        clip: instance.clip,
        time: instance.action?.time ?? 0,
        playing: instance.action?.isRunning() ?? false,
      };
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
    this.releaseInstance(state);
    this.instances.delete(entityId);
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
  ): ModelDefinition {
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
    for (const field of ["castShadow", "receiveShadow"] as const)
      if (
        definition[field] !== undefined &&
        typeof definition[field] !== "boolean"
      )
        throw new Error("TC_MODEL_INVALID_SHADOW");
    const normalized: ModelDefinition = {
      castShadow: definition.castShadow !== false,
      receiveShadow: definition.receiveShadow !== false,
      asset: assetId,
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
      JSON.stringify(known.definition) !== JSON.stringify(normalized)
    )
      throw new Error(
        `TC_MODEL_DEFINITION_CONFLICT: ${entityId}; use a new library when authored model definitions change`,
      );
    return normalized;
  }

  private createInstance(
    entityId: string,
    definition: ModelDefinition,
  ): InstanceState {
    const assetId = definition.asset as string;
    const template = this.templates.get(assetId)!;
    const root = cloneSkeleton(template.scene);
    root.traverse((object) => {
      if (object instanceof THREE.Mesh) {
        object.castShadow = definition.castShadow !== false;
        object.receiveShadow = definition.receiveShadow !== false;
      }
    });
    const node = new THREE.Group();
    node.name = `threecat-model:${entityId}`;
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
      fades: new Map(),
    };
    state.handle = Object.freeze({
      entity: entityId,
      node,
      dispose: () => {
        if (this.instances.get(entityId) === state) this.remove(entityId);
      },
    });
    try {
      if (definition.animation)
        this.playState(state, definition.animation.clip, definition.animation);
      return state;
    } catch (error) {
      this.releaseInstance(state);
      throw error;
    }
  }

  private releaseInstance(state: InstanceState): void {
    state.mixer.stopAllAction();
    state.mixer.uncacheRoot(state.root);
    state.node.removeFromParent();
    disposeInstanceSkeletons(state.root);
  }

  private stageInstances(ids: ReadonlySet<string>): Map<string, InstanceState> {
    const staged = new Map<string, InstanceState>();
    try {
      for (const id of ids)
        if (!this.instances.has(id))
          staged.set(
            id,
            this.createInstance(id, this.knownDefinition(id).definition),
          );
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
  ): void {
    for (const id of this.instances.keys()) if (!ids.has(id)) this.remove(id);
    for (const [id, state] of staged) this.instances.set(id, state);
    for (const id of ids) {
      const known = this.knownDefinition(id);
      if (parent) known.parent = parent;
      if ((parent || staged.has(id)) && known.parent)
        known.parent.add(this.instances.get(id)!.node);
    }
  }

  tick(dt: number): void {
    this.assertOpen();
    if (!Number.isFinite(dt) || dt < 0) throw new Error("TC_MODEL_INVALID_DT");
    for (const state of this.instances.values()) {
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
      format: "threecat.models",
      version: 2,
      animations: [...this.instances.values()]
        .sort((a, b) => a.entity.localeCompare(b.entity))
        .map(
          (state): ModelAnimationSnapshot => ({
            entity: state.entity,
            asset: state.asset,
            currentClip: state.clip,
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

  validateSnapshot(value: unknown): ModelLibrarySnapshot {
    this.assertOpen();
    const invalid = () => new Error("TC_MODEL_INVALID_SNAPSHOT");
    if (!value || typeof value !== "object") throw invalid();
    const data = value as ModelLibrarySnapshot;
    if (
      data.format !== "threecat.models" ||
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
      const known = this.definitions.get(item.entity);
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
        if (action.clip !== item.currentClip && (!fade || fade.to !== 0))
          throw invalid();
      }
      if (item.currentClip !== null && !actionNames.has(item.currentClip))
        throw invalid();
      if (item.currentClip === null && actionNames.size) throw invalid();
    }
    return structuredClone(data);
  }

  restore(value: unknown): void {
    const snapshot = this.validateSnapshot(value);
    const ids = new Set(snapshot.animations.map((item) => item.entity));
    const staged = this.stageInstances(ids);
    for (const item of snapshot.animations) {
      const state = this.instances.get(item.entity) ?? staged.get(item.entity)!;
      for (const action of state.actions.values()) action.stop();
      state.actions.clear();
      state.fades.clear();
      state.action = null;
      state.clip = null;
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
    this.commitInstances(ids, staged);
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
    for (const item of pending) item.controller.abort();
    for (const entity of [...this.instances.keys()]) this.remove(entity);
    this.disposing = (async () => {
      await Promise.allSettled(pending.map((item) => item.promise));
      for (const template of this.templates.values())
        template.resources.dispose();
      this.templates.clear();
      this.urls.clear();
      this.definitions.clear();
      this.pending.clear();
    })();
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
    options: { fade?: number; speed?: number; loop?: boolean } = {},
  ): void {
    this.assertOpen();
    this.playState(this.instance(entity), clipName, options);
  }

  private playState(
    state: InstanceState,
    clipName: string,
    options: { fade?: number; speed?: number; loop?: boolean },
  ): void {
    const clip = state.clips.get(clipName);
    if (!clip)
      throw new Error(
        `TC_MODEL_CLIP_MISSING: ${clipName}; available: ${[...state.clips.keys()].join(", ")}`,
      );
    const fade = options.fade ?? 0;
    const speed = options.speed ?? 1;
    const loop = options.loop ?? true;
    if (
      !Number.isFinite(fade) ||
      fade < 0 ||
      !Number.isFinite(speed) ||
      typeof loop !== "boolean"
    )
      throw new Error("TC_MODEL_INVALID_ANIMATION_OPTIONS");
    const action = state.mixer.clipAction(clip);
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
            parser.loadImageSource = (...args) => track(image(...args));
            const finalMaterial = parser.assignFinalMaterial.bind(parser);
            parser.assignFinalMaterial = (mesh) => {
              finalMaterial(mesh);
              resources.collect(mesh);
            };
            return {
              name: "THREECAT_resource_ownership",
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
                return null;
              },
            };
          });
          const gltf = await loader.parseAsync(bytes, new URL(".", url).href);
          resources.collect(gltf.scenes);
          const template = this.makeTemplate(id, gltf, resources);
          if (controller.signal.aborted || this.closed)
            throw new Error("cancelled");
          this.templates.set(id, template);
          return template;
        } catch (error) {
          while (decoding.size) await Promise.all([...decoding]);
          resources.dispose();
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
