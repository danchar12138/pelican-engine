import * as THREE from "three/webgpu";
import { createUIRenderer } from "./ui.ts";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { HDRLoader } from "three/addons/loaders/HDRLoader.js";
import type { PhysicsService } from "../../sdk/src/index.ts";
import type { GraphIR, SceneIR } from "../../compiler/src/types.ts";
import type { RuntimePluginFactory } from "../../runtime/src/plugins.ts";
import { createGameServices } from "../../runtime/src/game-services.ts";
import { createPhysicsFactory } from "../../physics/index.ts";
import { createNavigationPlugin } from "../../navigation/src/index.ts";
import { createWorldStreamingPlugin } from "../../runtime/src/world-streaming.ts";
import { createRopePlugin } from "../../simulation/src/rope-plugin.ts";
import { createClothPlugin } from "../../simulation/src/cloth-plugin.ts";
import { createFluidPlugin } from "../../simulation/src/fluid-plugin.ts";
import { createSoftBodyPlugin } from "../../simulation/src/softbody-plugin.ts";
import { createModelLibrary } from "./models.ts";
import { resolveEntityDefinition } from "../../runtime/src/prefabs.ts";
import type { EntityRecord } from "../../runtime/src/contracts.ts";

/** Private presentation ownership. Games receive only SDK services, never browser/library objects. */
export async function prepareGameplay(
  ir: SceneIR,
  baseURL: string,
  renderer: THREE.Renderer,
  materials: ReadonlyMap<string, THREE.Material> = new Map(),
) {
  const assetURL = (id: string) => {
    const asset = ir.assets.find((entry) => entry.id === id);
    if (!asset) throw new Error("TC_ASSET_MISSING: " + id);
    return new URL(asset.path, baseURL).href;
  };
  const models = createModelLibrary(
    ir.assets
      .filter((a) => a.type === "model")
      .map((a) => ({ id: a.id, url: assetURL(a.id) })),
    { material: id => materials.get(id) },
  );
  const textures = new Map<string, THREE.Texture>();
  const renderedTextures = new Set<string>();
  const addGraphTextures = (graph: GraphIR | undefined) => {
    if (!graph) return;
    for (const id of graph.textureIds ?? [])
      if (!Object.hasOwn(graph.textureSlots ?? {}, id)) renderedTextures.add(id);
  };
  const environment = ir.scene.environment;
  if (environment.backgroundTexture) renderedTextures.add(environment.backgroundTexture);
  if (environment.lightingTexture) renderedTextures.add(environment.lightingTexture);
  for (const material of ir.materials) {
    if (material.texture) renderedTextures.add(material.texture);
    addGraphTextures(material.graph);
    for (const graph of Object.values(material.graphs ?? {})) addGraphTextures(graph);
    for (const graph of Object.values(material.vertex ?? {})) addGraphTextures(graph);
  }
  for (const effect of ir.postProcesses ?? []) addGraphTextures(effect.graph);
  const hdrAssets = ir.assets.filter(asset => asset.type === "texture" && asset.metadata?.format === "hdr" && renderedTextures.has(asset.id));
  const requireHDRFiltering = (activeRenderer: THREE.Renderer) => {
    if (!hdrAssets.length) return;
    const backend = activeRenderer.backend as unknown as {
      isWebGPUBackend?: boolean;
      isWebGLBackend?: boolean;
      extensions?: { has(name: string): boolean };
    };
    const supported = backend.isWebGPUBackend
      ? activeRenderer.hasFeature("float32-filterable")
      : backend.isWebGLBackend && backend.extensions?.has("OES_texture_float_linear") === true;
    if (!supported)
      throw new Error(`TC_HDR_FILTER_UNAVAILABLE: HDR texture(s) ${hdrAssets.map(asset => asset.id).join(", ")} require float32 linear filtering. Use a backend with float32-filterable (WebGPU) or OES_texture_float_linear (WebGL2), or replace the HDR asset.`);
  };
  let physics: PhysicsService | undefined;
  let environmentTarget: THREE.RenderTarget | undefined;
  let environmentTexture: THREE.Texture | undefined;
  let background: THREE.Texture | undefined;
  const diagnostics: string[] = [];
  let audio: AudioContext | undefined;
  if ((ir.sounds?.length ?? 0) > 0) {
    try {
      if (typeof AudioContext !== "undefined") audio = new AudioContext();
      else diagnostics.push("TC_AUDIO_UNAVAILABLE: AudioContext is unavailable.");
    } catch (error) {
      diagnostics.push("TC_AUDIO_UNAVAILABLE: " + String(error));
    }
  }
  const buffers = new Map<string, AudioBuffer>();
  let masterGain: GainNode | undefined;
  const busGains = new Map<string, GainNode>();
  const busFadeKeys = new Map<string, string>();
  const voices = new Map<
    string,
    { source: AudioBufferSourceNode; gain: GainNode; panner?: PannerNode; version: number }
  >();
  let ui: ReturnType<typeof createUIRenderer> | undefined;
  let uiInput: ((key: string, pressed: boolean) => void) | undefined;
  let uiEmit: ((type: string, payload: unknown) => void) | undefined;
  let services: ReturnType<typeof createGameServices>;
  let closed = false;
  let audioRevision = -1;
  const stopVoice = (id: string) => {
    const voice = voices.get(id);
    if (!voice) return;
    voice.source.onended = null;
    try {
      voice.source.stop();
    } catch {
      /* A completed buffer source is already stopped. */
    }
    voice.source.disconnect();
    voice.gain.disconnect();
    voice.panner?.disconnect();
    voices.delete(id);
  };
  const dispose = async () => {
    if (closed) return;
    closed = true;
    ui?.dispose();
    for (const id of [...voices.keys()]) stopVoice(id);
    for (const gain of busGains.values()) gain.disconnect();
    busGains.clear();
    busFadeKeys.clear();
    masterGain?.disconnect();
    environmentTarget?.dispose();
    environmentTexture?.dispose();
    background?.dispose();
    for (const texture of textures.values()) texture.dispose();
    textures.clear();
    buffers.clear();
    await Promise.all([models.dispose(), audio?.close()]);
  };
  try {
    requireHDRFiltering(renderer);
    await models.prepare();
    if (ir.scene.environment.lighting === "studio") {
      const room = new RoomEnvironment(),
        pmrem = new THREE.PMREMGenerator(renderer);
      try {
        environmentTarget = pmrem.fromScene(room, 0.04);
      } finally {
        pmrem.dispose();
        room.dispose();
      }
    }
    for (const asset of ir.assets.filter((a) => a.type === "texture")) {
      const texture = asset.metadata?.format === "hdr"
        ? await new HDRLoader().setDataType(THREE.FloatType).loadAsync(assetURL(asset.id))
        : await new THREE.TextureLoader().loadAsync(assetURL(asset.id));
      texture.colorSpace = asset.colorSpace === "linear" ? THREE.LinearSRGBColorSpace : THREE.SRGBColorSpace;
      textures.set(asset.id, texture);
    }
    if (ir.scene.environment.lightingTexture) {
      const source = textures.get(ir.scene.environment.lightingTexture);
      if (!source) throw new Error(`TC_ENVIRONMENT_TEXTURE: Missing panorama '${ir.scene.environment.lightingTexture}'.`);
      environmentTexture = source.clone();
      environmentTexture.mapping = THREE.EquirectangularReflectionMapping;
      environmentTexture.wrapS = THREE.RepeatWrapping;
      environmentTexture.wrapT = THREE.ClampToEdgeWrapping;
      environmentTexture.needsUpdate = true;
    }
    if (ir.scene.environment.backgroundTexture) {
      const source = textures.get(ir.scene.environment.backgroundTexture);
      if (!source) throw new Error(`TC_BACKGROUND_TEXTURE: Missing panorama '${ir.scene.environment.backgroundTexture}'.`);
      background = source.clone();
      background.mapping = THREE.EquirectangularReflectionMapping;
      background.wrapS = THREE.RepeatWrapping;
      background.wrapT = THREE.ClampToEdgeWrapping;
      background.needsUpdate = true;
    }
    if (audio)
      for (const sound of ir.sounds ?? []) {
        if (buffers.has(sound.asset)) continue;
        const response = await fetch(assetURL(sound.asset));
        if (!response.ok)
          throw new Error(
            "TC_AUDIO_LOAD: " + sound.asset + " HTTP " + response.status,
          );
        const buffer = await audio.decodeAudioData(
          await response.arrayBuffer(),
        );
        buffers.set(sound.asset, buffer);
      }
    services = createGameServices(ir, models.animation);
    const modelBindings = (records: Pick<EntityRecord, "id" | "prefab">[]) =>
      records.filter((record) => resolveEntityDefinition(ir, record)?.model);
    const modelDefinitions = (records: Pick<EntityRecord, "id" | "prefab">[]) =>
      modelBindings(records).map((record) => ({
        entity: record.id,
        definition: resolveEntityDefinition(ir, record)!.model!,
      }));
    const validateModels = (value: unknown) => {
      const saved = structuredClone(value) as {
        version: number;
        bindings: Pick<EntityRecord, "id" | "prefab">[];
        animation: unknown;
      };
      if (
        !saved ||
        saved.version !== 1 ||
        !Array.isArray(saved.bindings) ||
        saved.bindings.some(
          (record) =>
            !record ||
            typeof record.id !== "string" ||
            (record.prefab !== undefined && typeof record.prefab !== "string"),
        ) ||
        new Set(saved.bindings.map((record) => record.id)).size !==
          saved.bindings.length
      )
        throw new Error(
          "TC_MODEL_BINDINGS_SNAPSHOT: Invalid model content identity.",
        );
      if (modelBindings(saved.bindings).length !== saved.bindings.length)
        throw new Error("TC_MODEL_BINDINGS_SNAPSHOT: Unknown model content.");
      const definitions = modelDefinitions(saved.bindings);
      const animation = models.validateSnapshot(saved.animation, definitions);
      if (
        JSON.stringify(
          animation.animations.map((item) => item.entity).sort(),
        ) !== JSON.stringify(saved.bindings.map((record) => record.id).sort())
      )
        throw new Error(
          "TC_MODEL_BINDINGS_SNAPSHOT: Active model bindings differ from animation state.",
        );
      return { animation, definitions };
    };
    const plugins: RuntimePluginFactory[] = [
      services.factory,
      createNavigationPlugin,
      createWorldStreamingPlugin,
      createRopePlugin,
      createClothPlugin,
      createFluidPlugin,
      createSoftBodyPlugin,
      (context) => ({
        id: "$engine.models",
        version: "2",
        snapshot: () => {
          const bindings = modelBindings(context.world.records()).map(
            ({ id, prefab }) => ({
              id,
              ...(prefab === undefined ? {} : { prefab }),
            }),
          );
          models.reconcileBindings(modelDefinitions(bindings));
          return { version: 1, bindings, animation: models.snapshot() };
        },
        validateSnapshot: (value) => {
          validateModels(value);
        },
        validateWorld: (value, world) => {
          const bindings = (
            value as { bindings: Pick<EntityRecord, "id" | "prefab">[] }
          ).bindings;
          const expected = modelBindings(world.entities)
            .map(({ id, prefab }) =>
              JSON.stringify({
                id,
                ...(prefab === undefined ? {} : { prefab }),
              }),
            )
            .sort();
          if (
            JSON.stringify(expected) !==
            JSON.stringify(
              bindings
                .map(({ id, prefab }) =>
                  JSON.stringify({
                    id,
                    ...(prefab === undefined ? {} : { prefab }),
                  }),
                )
                .sort(),
            )
          )
            throw new Error(
              "TC_MODEL_BINDINGS_WORLD: Model identities must match the restored World.",
            );
        },
        restore: (value) => {
          const { animation, definitions } = validateModels(value);
          models.restore(animation, definitions);
        },
        dispose() {
          /* Content owns async GPU/asset disposal. */
        },
        inspect: () => models.inspect(),
        systems: [
          {
            id: "$engine.models",
            phase: "presentation",
            run: (dt) => {
              const records = context.world.records();
              models.reconcileBindings(modelDefinitions(records));
              models.tick(dt);
            },
          },
        ],
      }),
    ];
    if (
      [...ir.scene.entities, ...ir.prefabs].some(
        (entity) => entity.rigidBody || entity.character,
      )
    ) {
      const factory = await createPhysicsFactory();
      plugins.push((context) => {
        const plugin = factory(context);
        physics = plugin.services?.physics;
        return plugin;
      });
    }
    ui = createUIRenderer(ir.ui ?? [], {
      input: (key, pressed) => {
        uiInput?.(key, pressed);
        void audio
          ?.resume()
          .catch((error) =>
            diagnostics.push("TC_AUDIO_RESUME: " + String(error)),
          );
      },
      emit: (type, payload) => {
        if (
          type === "ui.focus" &&
          payload &&
          typeof payload === "object" &&
          services.uiKind((payload as { id: string }).id) === "input"
        )
          for (const key of new Set(Object.values(ir.input ?? {}).flat()))
            uiInput?.(key, false);
        uiEmit?.(type, payload);
      },
    });
    return {
      models,
      async rebuildGpuResources(next: THREE.Renderer) {
        if (closed) throw new Error("TC_CONTENT_DISPOSED");
        requireHDRFiltering(next);
        environmentTarget?.dispose();
        environmentTarget = undefined;
        if (ir.scene.environment.lighting === "studio") {
          const room = new RoomEnvironment(),
            generator = new THREE.PMREMGenerator(next);
          try {
            environmentTarget = generator.fromScene(room, 0.04);
          } finally {
            generator.dispose();
            room.dispose();
          }
        }
        return environmentTexture ?? environmentTarget?.texture;
      },
      environment: environmentTexture ?? environmentTarget?.texture,
      background,
      textures,
      plugins,
      services,
      dispose,
      mount(
        input: (key: string, pressed: boolean) => void,
        emit: (type: string, payload: unknown) => void,
      ) {
        uiInput = input;
        uiEmit = emit;
        ui!.mount();
      },
      consumesKeyboard(event: KeyboardEvent) {
        return ui?.consumesKeyboard(event) ?? false;
      },
      unlockAudio() {
        void audio
          ?.resume()
          .catch((error) =>
            diagnostics.push("TC_AUDIO_RESUME: " + String(error)),
          );
      },
      present(
        camera: THREE.PerspectiveCamera,
        objects: ReadonlyMap<string, THREE.Object3D>,
        dt: number,
        tick: number,
      ) {
        const state = services.inspect();
        if (state.camera) {
          const follow = state.camera,
            object = objects.get(follow.entity);
          if (object) {
            const at = object.getWorldPosition(new THREE.Vector3());
            const target = at
              .clone()
              .add(new THREE.Vector3(0, follow.lookHeight, 0));
            const position = at.add(
              new THREE.Vector3(
                Math.sin(follow.yaw) * follow.distance,
                follow.height,
                Math.cos(follow.yaw) * follow.distance,
              ),
            );
            if (physics) {
              const direction = position.clone().sub(target),
                distance = direction.length();
              const hit = physics.raycast(
                target.toArray(),
                direction.toArray(),
                distance,
                { exclude: [follow.entity], includeTriggers: false },
              );
              if (hit && hit.distance < distance)
                position
                  .copy(target)
                  .addScaledVector(
                    direction.normalize(),
                    Math.max(0.2, hit.distance - 0.25),
                  );
            }
            camera.position.lerp(
              position,
              dt > 0 && follow.smoothing > 0
                ? 1 - Math.pow(1 - follow.smoothing, dt * 60)
                : 1,
            );
            if (physics) {
              const actual = camera.position.clone().sub(target),
                length = actual.length();
              if (length > 0) {
                const hit = physics.raycast(
                  target.toArray(),
                  actual.toArray(),
                  length,
                  { exclude: [follow.entity] },
                );
                if (hit && hit.distance < length)
                  camera.position
                    .copy(target)
                    .addScaledVector(
                      actual.normalize(),
                      Math.max(0.2, hit.distance - 0.25),
                    );
              }
            }
            camera.lookAt(target);
            camera.updateMatrixWorld();
          }
        }
        const size = renderer.getSize(new THREE.Vector2());
        const positions = new Map<
          string,
          { x: number; y: number; visible: boolean; occluded: boolean }
        >();
        for (const definition of state.ui ?? []) {
          if (!definition.world) continue;
          const object = objects.get(definition.world.entity);
          if (!object) {
            positions.set(definition.id, {
              x: 0,
              y: 0,
              visible: false,
              occluded: false,
            });
            continue;
          }
          object.updateWorldMatrix(true, false);
          const point = object
            .getWorldPosition(new THREE.Vector3())
            .add(new THREE.Vector3().fromArray(definition.world.offset));
          const delta = point.clone().sub(camera.position),
            distance = delta.length(),
            projected = point.clone().project(camera),
            forward = new THREE.Vector3();
          camera.getWorldDirection(forward);
          let occluded = false;
          if (definition.world.occlude && distance > 0) {
            const raycaster = new THREE.Raycaster(
              camera.position,
              delta.clone().normalize(),
              0.01,
              distance - 0.01,
            );
            occluded = raycaster
              .intersectObjects([...objects.values()], true)
              .some((hit) => {
                for (
                  let parent: THREE.Object3D | null = hit.object;
                  parent;
                  parent = parent.parent
                )
                  if (parent === object) return false;
                return hit.object.visible;
              });
          }
          positions.set(definition.id, {
            x: ((projected.x + 1) * size.x) / 2,
            y: ((1 - projected.y) * size.y) / 2,
            visible:
              forward.dot(delta) > 0 &&
              projected.z >= -1 &&
              projected.z <= 1 &&
              Math.abs(projected.x) <= 1 &&
              Math.abs(projected.y) <= 1,
            occluded,
          });
        }
        ui?.present(state.ui ?? [], positions);
        const clock = services.audioClock();
        if (clock.revision !== audioRevision) {
          for (const id of [...voices.keys()]) stopVoice(id);
          busFadeKeys.clear();
          for (const gain of busGains.values()) gain.gain.cancelScheduledValues(audio?.currentTime ?? 0);
          audioRevision = clock.revision;
        }
        const wanted = new Set(state.audio.voices.filter((voice) => voice.pausedAt == null).map((voice) => voice.id));
        for (const id of [...voices.keys()]) if (!wanted.has(id)) stopVoice(id);
        if (audio) {
          if (!masterGain) {
            const master = audio.createGain();
            const created = new Map<string, GainNode>();
            try {
              master.connect(audio.destination);
              for (const bus of ir.audioBuses ?? []) {
                const gain = audio.createGain();
                created.set(bus.id, gain);
                gain.connect(master);
              }
            } catch (error) {
              for (const gain of created.values()) gain.disconnect();
              master.disconnect();
              throw error;
            }
            masterGain = master;
            for (const [id, gain] of created) busGains.set(id, gain);
          }
          masterGain.gain.value = state.audio.volume;
          for (const bus of state.audio.busVolumes ?? []) {
            const gain = busGains.get(bus.id)!.gain;
            const fade = bus.fade;
            const key = fade && `${clock.revision}:${fade.startedAt}:${fade.from}:${fade.target}:${fade.duration}`;
            if (key && clock.fixedDt !== null) {
              if (busFadeKeys.get(bus.id) !== key) {
                gain.cancelScheduledValues(audio.currentTime);
                gain.setValueAtTime(bus.volume, audio.currentTime);
                gain.linearRampToValueAtTime(fade.target, audio.currentTime + Math.max(0, fade.duration - (clock.tick - fade.startedAt) * clock.fixedDt));
                busFadeKeys.set(bus.id, key);
              }
            } else {
              if (busFadeKeys.has(bus.id)) gain.cancelScheduledValues(audio.currentTime);
              busFadeKeys.delete(bus.id);
              gain.value = bus.volume;
            }
          }
          audio.listener.positionX.value = camera.position.x;
          audio.listener.positionY.value = camera.position.y;
          audio.listener.positionZ.value = camera.position.z;
          const forward = new THREE.Vector3();
          camera.getWorldDirection(forward);
          audio.listener.forwardX.value = forward.x;
          audio.listener.forwardY.value = forward.y;
          audio.listener.forwardZ.value = forward.z;
          for (const voice of state.audio.voices) {
            if (voice.pausedAt != null) continue;
            let active = voices.get(voice.id);
            if (active && active.version !== clock.versions[voice.id]) {
              stopVoice(voice.id);
              active = undefined;
            }
            if (!active && audio.state === "running") {
              const definition = ir.sounds!.find(
                (sound) => sound.id === voice.sound,
              )!;
              const buffer = buffers.get(definition.asset)!;
              const age = Math.max(0, (clock.tick - voice.startedAt - (voice.pausedTicks ?? 0)) * (clock.fixedDt ?? 0));
              if (buffer.duration <= 0 || (!voice.loop && age >= buffer.duration)) continue;
              const source = audio.createBufferSource(),
                gain = audio.createGain();
              source.buffer = buffer;
              source.loop = voice.loop;
              let panner: PannerNode | undefined;
              if (voice.entity) {
                panner = audio.createPanner();
                panner.panningModel = "HRTF";
                panner.distanceModel = "inverse";
                source.connect(panner);
                panner.connect(gain);
              } else source.connect(gain);
              gain.connect(voice.bus === undefined ? masterGain : busGains.get(voice.bus)!);
              active = { source, gain, panner, version: clock.versions[voice.id] };
              voices.set(voice.id, active);
              source.onended = () => {
                source.disconnect();
                gain.disconnect();
                panner?.disconnect();
              };
              source.start(0, age % buffer.duration);
            }
            if (active) {
              active.gain.gain.value = voice.volume;
              const position = voice.entity
                ? objects
                    .get(voice.entity)
                    ?.getWorldPosition(new THREE.Vector3())
                : undefined;
              if (active.panner && position) {
                active.panner.positionX.value = position.x;
                active.panner.positionY.value = position.y;
                active.panner.positionZ.value = position.z;
              }
            }
          }
        }
      },
      inspect() {
        return {
          ...services.inspect(),
          models: models.inspect(),
          audioDevice: audio?.state ?? ((ir.sounds?.length ?? 0) > 0 ? "unavailable" : "unused"),
          decodedSounds: buffers.size,
          uiPlatform: ui?.inspect(),
          diagnostics: [...diagnostics],
        };
      },
    };
  } catch (error) {
    await dispose();
    throw error;
  }
}
export type GameplayContent = Awaited<ReturnType<typeof prepareGameplay>>;
