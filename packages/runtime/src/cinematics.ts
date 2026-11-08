import { Euler, Quaternion } from "three";
import type { CameraState, CinematicDefinition, CinematicService, CinematicState, CinematicTrack, EntityHandle, Transform, Vec3 } from "../../sdk/src/index.ts";
import type { EntityRecord } from "./contracts.ts";
import type { RuntimePluginFactory } from "./plugins.ts";
import { cloneSerializable } from "./random.ts";
import { resolveEntityDefinition } from "./prefabs.ts";
import { cinematicChannel, cinematicError as fail, cinematicName as name, normalizeCinematic, type CinematicSampler } from "./cinematics-data.ts";

type AnimationTrack = Extract<CinematicTrack, { kind: "animation" }>;
type AudioTrack = Extract<CinematicTrack, { kind: "audio" }>;
type Binding = { entity: string; transform: Transform; animation?: unknown; velocity?: Vec3 };
type Saved = { version: 1; definitions: CinematicDefinition[]; state: CinematicState; bindings: Binding[]; camera: CameraState | null; voices: [number, string][] };
type Prepared = { position?: CinematicSampler; rotation?: CinematicSampler; target?: CinematicSampler; opacity?: CinematicSampler };
const owner = "$engine.cinematics";
const idle = (): CinematicState => ({ id: null, time: 0, cycle: 0, speed: 1, status: "idle", error: null });
const finite = (value: unknown, min: number, max: number): value is number => typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
const vector = (value: unknown, limit = 1e6): value is Vec3 => Array.isArray(value) && value.length === 3 && Array.from(value).every(v => finite(v, -limit, limit));
function transform(value: unknown): value is Transform {
  const data = value as Transform;
  return !!data && typeof data === "object" && Object.keys(data).every(key => ["position", "rotation", "scale"].includes(key)) && vector(data.position, 1e12) && vector(data.rotation, 1e12) && vector(data.scale, 1e12);
}
function cameraState(value: CameraState | null): void {
  if (value === null) return;
  if (!value || typeof value !== "object" || !Object.hasOwn(value, "follow") || !Object.hasOwn(value, "pose") || (value.follow !== null && value.pose !== null)) fail("CAMERA_SNAPSHOT", "Invalid captured camera state.");
  if (Object.keys(value).some(key => !["follow", "pose"].includes(key))) fail("CAMERA_SNAPSHOT", "Unexpected captured camera fields.");
  if ((value.follow !== null && (!value.follow || typeof value.follow !== "object")) || (value.pose !== null && (!value.pose || typeof value.pose !== "object"))) fail("CAMERA_SNAPSHOT", "Captured camera modes must be objects or null.");
  if (value.follow) {
    const camera = value.follow;
    if (Object.keys(camera).some(key => !["entity", "distance", "height", "lookHeight", "yaw", "smoothing"].includes(key))) fail("CAMERA_SNAPSHOT", "Unexpected follow camera fields.");
    if (!name(camera.entity) || !finite(camera.distance, Number.MIN_VALUE, Infinity) || !finite(camera.height, 0, Infinity) || !finite(camera.lookHeight, 0, Infinity) || !finite(camera.yaw, -Infinity, Infinity) || !finite(camera.smoothing, 0, 1)) fail("CAMERA_SNAPSHOT", "Invalid captured follow camera.");
  }
  if (value.pose) {
    if (Object.keys(value.pose).some(key => !["position", "target", "transition"].includes(key))) fail("CAMERA_SNAPSHOT", "Unexpected manual camera fields.");
    if (!vector(value.pose.position, 1e9) || !vector(value.pose.target, 1e9) || Math.hypot(...value.pose.position.map((v, i) => v - value.pose!.target[i])) <= 1e-6) fail("CAMERA_SNAPSHOT", "Captured camera vectors must be finite and distinct.");
    const transition = value.pose.transition;
    if (transition && (!vector(transition.position, 1e9) || !vector(transition.target, 1e9) || !finite(transition.remaining, 0, 1e6))) fail("CAMERA_SNAPSHOT", "Invalid captured camera transition.");
  }
}

/** Fixed-time director. Every saved value is data; native, mixer and DOM objects stay private. */
export const createCinematicPlugin: RuntimePluginFactory = context => {
  let definitions = new Map<string, CinematicDefinition>(), state = idle(), bindings: Binding[] = [], camera: CameraState | null = null;
  let voices = new Map<number, string>(), handles = new Map<string, EntityHandle>(), cameraHandle: EntityHandle | undefined;
  let pendingRefs = false, disposed = false, faulted = false;
  const prepared = new Map<CinematicDefinition, Prepared[]>();
  const alive = (recovering = false) => { if (disposed) fail("DISPOSED", "Create a new host before using the director."); if (faulted && !recovering) fail("RECOVERY_REQUIRED", "Restore a known-good host checkpoint or restart the scene."); };
  const animation = () => context.getCinematicAnimationBridge?.() ?? fail("ANIMATION", "Skeletal tracks require the production model animation owner.");
  const audio = () => context.getAudioService?.() ?? fail("AUDIO", "Audio tracks require the audio service.");
  const cameras = () => context.getCameraService?.() ?? fail("CAMERA", "Camera tracks require the camera service.");
  const physics = () => context.getPhysicsService?.() ?? fail("PHYSICS", "Physical cinematic bindings require production 3D physics.");
  const records = () => new Map(context.world.records().map(record => [record.id, record]));
  const current = () => state.id === null ? undefined : definitions.get(state.id);
  const get = (id: string) => definitions.get(id) ?? fail("MISSING", `Sequence '${id}' is not defined.`);
  const animated = (definition: CinematicDefinition) => new Set(definition.tracks.filter((track): track is AnimationTrack => track.kind === "animation").map(track => track.entity));
  const targets = (definition: CinematicDefinition) => new Set(definition.tracks.flatMap(track => track.kind === "transform" || track.kind === "animation" ? [track.entity] : track.kind === "audio" && track.entity ? [track.entity] : []));
  const controlsTransform = (definition: CinematicDefinition, entity: string) => definition.tracks.some(track => track.kind === "transform" && track.entity === entity);
  const checkWorld = (definition: CinematicDefinition, world: Map<string, EntityRecord>, live2d = true) => {
    for (const id of targets(definition)) {
      const record = world.get(id);
      if (!record) fail("BINDING", `Sequence '${definition.id}' needs live entity '${id}'.`);
      const entity = resolveEntityDefinition(context.scene, record!);
      if (controlsTransform(definition, id) && (record!.parent !== undefined || entity?.rigidBody || (live2d && context.getPhysics2DBridge?.()?.hasEntity(id)))) fail("TRANSFORM_BODY", `'${id}' transform tracks require a non-physical root or 3D character, not a rigid or 2D body.`);
      if (animated(definition).has(id) && !entity?.model) fail("MODEL", `'${id}' needs a declared model for animation tracks.`);
    }
    for (const track of definition.tracks) if (track.kind === "audio") {
      if (!context.scene.sounds?.some(sound => sound.id === track.sound) || (track.bus !== undefined && !context.scene.audioBuses?.some(bus => bus.id === track.bus))) fail("SOUND", `Sequence '${definition.id}' uses an unknown sound or bus.`);
    }
  };
  const setRateCheck = (definition: CinematicDefinition, speed: number) => {
    if (!finite(speed, 0.01, 16) || definition.tracks.some(track => track.kind === "audio" && !finite((track.rate ?? 1) * speed, 0.01, 16))) fail("SPEED", "Sequence speed and combined audio rate must stay in [0.01,16].");
  };
  const compile = (definition: CinematicDefinition) => {
    let channels = prepared.get(definition);
    if (!channels) {
      channels = definition.tracks.map(track => track.kind === "transform" || track.kind === "camera" ? {
        ...(track.position ? { position: cinematicChannel(track.position, track.interpolation) } : {}),
        ...(track.kind === "transform" && track.rotation ? { rotation: cinematicChannel(track.rotation, track.interpolation, true) } : {}),
        ...(track.kind === "camera" ? { target: cinematicChannel(track.target, track.interpolation) } : {}),
      } : track.kind === "transition" ? { opacity: cinematicChannel(track.opacity.map(key => ({ time: key.time, value: [key.value] })), track.interpolation) } : {});
      prepared.set(definition, channels);
    }
    return channels;
  };
  const ensureRefs = () => {
    if (!pendingRefs) return;
    const world = records(), definition = current();
    if (definition) checkWorld(definition, world);
    handles = new Map(bindings.map(binding => [binding.entity, context.world.resolve(binding.entity)]));
    for (const binding of bindings) if (binding.animation !== undefined) {
      const model = resolveEntityDefinition(context.scene, world.get(binding.entity)!)!.model!;
      animation().reclaim(binding.entity, owner, model);
    }
    cameraHandle = camera?.follow && context.world.isAlive(camera.follow.entity) ? context.world.resolve(camera.follow.entity) : undefined;
    pendingRefs = false;
  };
  const guard = (operation: () => void) => {
    const sequence = state.id;
    try { operation(); }
    catch (error) { faulted = true; state.status = "failed"; state.error = String(error); throw new AggregateError([error], `TC_CINEMATIC_OPERATION: sequence='${state.id ?? sequence}', time=${state.time}, partialState=unknown; restore a known-good host checkpoint or restart the scene.`); }
  };
  const emitMarkers = (definition: CinematicDefinition, from: number, to: number, includeStart = false) => {
    for (const marker of definition.markers ?? []) if ((marker.time > from || (includeStart && marker.time === from)) && marker.time <= to)
      context.emit("cinematic.marker", { sequence: definition.id, id: marker.id, time: marker.time, cycle: state.cycle, payload: cloneSerializable(marker.payload ?? {}) });
  };
  const restoreCamera = () => {
    if (!camera) return;
    if (camera.follow) {
      if (cameraHandle && context.world.isAlive(cameraHandle)) { const { entity, ...options } = camera.follow; cameras().follow(entity, options); }
      else cameras().reset();
    } else if (camera.pose) {
      cameras().setPose(camera.pose.position, camera.pose.target);
      if (camera.pose.transition) cameras().moveTo(camera.pose.transition.position, camera.pose.transition.target, camera.pose.transition.remaining);
    } else cameras().reset();
  };
  const stopVoices = () => { for (const id of voices.values()) audio().stop(id); voices.clear(); };
  const release = (options: { restoreAnimation?: boolean; restoreCamera?: boolean; restoreTransforms?: boolean } = {}) => {
    stopVoices();
    const world = records();
    for (const binding of bindings) {
      const ref = handles.get(binding.entity), record = world.get(binding.entity), live = ref && context.world.isAlive(ref) && record;
      if (binding.animation !== undefined) {
        if (live) animation().release(binding.entity, owner, binding.animation, options.restoreAnimation ?? true);
        else animation().abandon(binding.entity, owner);
      }
      if (!live) continue;
      const entity = resolveEntityDefinition(context.scene, record);
      const definition = current(), controlled = definition && (controlsTransform(definition, binding.entity) || animated(definition).has(binding.entity));
      if (options.restoreTransforms && controlled) {
        if (entity?.character) physics().teleport(binding.entity, binding.transform);
        else context.world.setTransform(ref!, binding.transform);
      }
      if (binding.velocity && entity?.character) physics().setVelocity(binding.entity, binding.velocity);
    }
    if (options.restoreCamera ?? true) restoreCamera();
    bindings = []; handles.clear(); camera = null; cameraHandle = undefined; pendingRefs = false;
    const previous = state.id; state = idle();
    if (previous !== null) context.emit("cinematic.stopped", { sequence: previous });
  };
  const sampleAnimation = (definition: CinematicDefinition, from: number, to: number, discontinuity: boolean) => {
    for (const entity of animated(definition)) {
      const tracks = definition.tracks.filter((track): track is AnimationTrack => track.kind === "animation" && track.entity === entity).sort((a, b) => a.start - b.start);
      if (!discontinuity) for (const track of tracks) if (track.start < to && track.end > from) {
        const duration = animation().duration(entity, track.clip), speed = track.speed ?? 1, offset = track.sourceStart ?? (speed < 0 ? duration : 0);
        animation().sample(entity, owner, track.clip, offset + (Math.max(from, track.start) - track.start) * speed, offset + (Math.min(to, track.end) - track.start) * speed, track.loop ?? false, track.rootMotion ?? false);
      }
      const held = [...tracks].reverse().find(track => track.start <= to);
      if (held) {
        const duration = animation().duration(entity, held.clip), speed = held.speed ?? 1, time = (held.sourceStart ?? (speed < 0 ? duration : 0)) + (Math.min(to, held.end) - held.start) * speed;
        animation().sample(entity, owner, held.clip, time, time, held.loop ?? false, false);
      } else {
        const binding = bindings.find(item => item.entity === entity)!;
        // A backwards seek before the first clip restores the captured base pose,
        // then immediately reclaims it so ordinary animation cannot advance it.
        if (discontinuity && binding.animation !== undefined) {
          animation().release(entity, owner, binding.animation, true);
          animation().reclaim(entity, owner, resolveEntityDefinition(context.scene, records().get(entity)!)!.model!);
        }
      }
    }
  };
  const sampleAudio = (definition: CinematicDefinition, time: number, discontinuity: boolean) => {
    for (const [index, id] of [...voices]) {
      const track = definition.tracks[index] as AudioTrack;
      if (time < track.start || time >= track.end || !audio().voice(id)) { audio().stop(id); voices.delete(index); }
    }
    for (const [index, track] of definition.tracks.entries()) if (track.kind === "audio" && time >= track.start && time < track.end) {
      const position = (track.sourceStart ?? 0) + (time - track.start) * (track.rate ?? 1), rate = state.speed * (track.rate ?? 1);
      let id = voices.get(index);
      if (!id) {
        const sound = context.scene.sounds!.find(sound => sound.id === track.sound)!, asset = context.scene.assets?.find(asset => asset.id === sound.asset);
        const duration = asset?.metadata?.duration;
        if (!(track.loop ?? false) && typeof duration === "number" && position >= duration) continue;
        id = audio().play(track.sound, { offset: position, playbackRate: rate, loop: track.loop ?? false, volume: track.volume ?? sound.volume,
          ...(track.entity === undefined ? {} : { entity: track.entity }), ...(track.bus === undefined ? {} : { bus: track.bus }),
          ...(track.priority === undefined ? {} : { priority: track.priority }), ...(track.occlusion === undefined ? {} : { occlusion: track.occlusion }) });
        voices.set(index, id);
      } else {
        audio().setPlaybackRate(id, rate);
        if (discontinuity) audio().seek(id, position);
      }
      if (state.status === "playing") audio().resume(id); else audio().pause(id);
    }
  };
  const apply = (definition: CinematicDefinition, from: number, to: number, discontinuity: boolean) => {
    const channels = compile(definition), world = records();
    sampleAnimation(definition, from, to, discontinuity);
    for (const [index, track] of definition.tracks.entries()) {
      const channel = channels[index];
      if (track.kind === "camera") {
        const p = channel.position!(to), t = channel.target!(to);
        if (!vector(p) || !vector(t)) fail("NUMERIC", "Camera interpolation exceeded finite bounds.");
        cameras().setPose([p[0], p[1], p[2]], [t[0], t[1], t[2]]);
      } else if (track.kind === "transform") {
        const record = world.get(track.entity)!, entity = resolveEntityDefinition(context.scene, record), pose = context.world.getTransform(handles.get(track.entity)!);
        const p = channel.position?.(to), q = channel.rotation?.(to);
        if ((p && !vector(p)) || (q && (q.some(v => !Number.isFinite(v)) || Math.hypot(...q) < 1e-12))) fail("NUMERIC", `Transform interpolation failed for '${track.entity}'.`);
        const angles = q ? new Euler().setFromQuaternion(new Quaternion(q[0], q[1], q[2], q[3]).normalize(), "XYZ") : undefined;
        const rotation = angles ? [angles.x, angles.y, angles.z] as const : pose.rotation, position = p as Vec3 | undefined;
        if (entity?.character) {
          if (discontinuity) physics().teleport(track.entity, { position: position ?? pose.position, rotation });
          else {
            if (position) {
              physics().moveCharacterTo(track.entity, position);
            }
            if (angles) physics().teleport(track.entity, { rotation }, { resetVelocity: false });
          }
        } else context.world.setTransform(handles.get(track.entity)!, { ...(position ? { position } : {}), ...(angles ? { rotation } : {}) });
      }
    }
    sampleAudio(definition, to, discontinuity);
  };

  const parse = (input: unknown): Saved => {
    const saved = cloneSerializable(input) as Saved;
    if (!saved || saved.version !== 1 || !Array.isArray(saved.definitions) || saved.definitions.length > 128 || !Array.isArray(saved.bindings) || !Array.isArray(saved.voices)) return fail("SNAPSHOT", "Expected a version 1 director snapshot.");
    saved.definitions = saved.definitions.map(normalizeCinematic);
    const ids = new Set(saved.definitions.map(item => item.id));
    if (ids.size !== saved.definitions.length) return fail("SNAPSHOT", "Duplicate sequence definitions.");
    const value = saved.state;
    if (!value || !(value.id === null || name(value.id)) || !finite(value.time, 0, 86400) || !Number.isSafeInteger(value.cycle) || value.cycle < 0 || !finite(value.speed, 0.01, 16) || !["idle", "playing", "paused", "completed"].includes(value.status) || value.error !== null) return fail("SNAPSHOT", "Invalid director clock/status.");
    cameraState(saved.camera);
    if (value.id === null) {
      if (value.status !== "idle" || value.time !== 0 || value.cycle !== 0 || saved.bindings.length || saved.voices.length || saved.camera !== null) return fail("SNAPSHOT", "An idle director cannot retain bindings.");
      return saved;
    }
    const definition = saved.definitions.find(item => item.id === value.id) ?? fail("SNAPSHOT", "Active sequence is missing.");
    setRateCheck(definition, value.speed);
    if (value.status === "idle" || value.time > definition.duration || (value.status === "completed" && (definition.loop || value.time !== definition.duration)) || (!!definition.tracks.find(track => track.kind === "camera") !== (saved.camera !== null))) return fail("SNAPSHOT", "Sequence time, completion or camera ownership differs.");
    const expected = targets(definition), seen = new Set<string>(), animatedIds = animated(definition);
    for (const binding of saved.bindings) {
      if (!binding || Object.keys(binding).some(key => !["entity", "transform", "animation", "velocity"].includes(key)) || !expected.has(binding.entity) || seen.has(binding.entity) || !transform(binding.transform) || (binding.velocity !== undefined && !vector(binding.velocity, 1e12)) || animatedIds.has(binding.entity) !== (binding.animation !== undefined)) return fail("SNAPSHOT", "Invalid captured binding or animation baseline.");
      seen.add(binding.entity);
    }
    if (seen.size !== expected.size) return fail("SNAPSHOT", "Snapshot omits a sequence binding.");
    const indices = new Set<number>(), voiceIds = new Set<string>();
    for (const pair of saved.voices) {
      if (!Array.isArray(pair) || pair.length !== 2 || !Number.isSafeInteger(pair[0]) || indices.has(pair[0]) || typeof pair[1] !== "string" || !/^voice:[1-9]\d*$/.test(pair[1]) || voiceIds.has(pair[1])) return fail("SNAPSHOT", "Invalid audio cue ownership.");
      const track = definition.tracks[pair[0]];
      if (track?.kind !== "audio" || value.time < track.start || value.time >= track.end) return fail("SNAPSHOT", "A voice is outside its cue interval.");
      indices.add(pair[0]); voiceIds.add(pair[1]);
    }
    return saved;
  };

  const service: CinematicService = {
    define(input) { alive(); const definition = normalizeCinematic(input); if (definitions.has(definition.id) || definitions.size >= 128) return fail("DEFINITION", `Sequence '${definition.id}' exists or the 128-sequence capacity is exhausted.`); compile(definition); definitions.set(definition.id, definition); },
    undefine(id) { alive(); const definition = get(id); if (state.id === id) return fail("IN_USE", "Stop the sequence before undefining it."); definitions.delete(id); prepared.delete(definition); },
    list() { alive(); return [...definitions.keys()].sort(); },
    play(id, options = {}) {
      alive(); const definition = get(id), config = cloneSerializable(options), world = records();
      if (!config || typeof config !== "object" || Object.keys(config).some(key => !["startAt", "speed"].includes(key)) || !finite(config.startAt ?? 0, 0, definition.duration)) return fail("PLAY", "Use a startAt within the sequence and a supported speed.");
      const speed = config.speed ?? state.speed;
      setRateCheck(definition, speed); checkWorld(definition, world); compile(definition); ensureRefs();
      for (const track of definition.tracks) if (track.kind === "animation") {
        const model = resolveEntityDefinition(context.scene, world.get(track.entity)!)!.model!;
        const duration = animation().duration(track.entity, track.clip, model);
        if (track.sourceStart !== undefined && !finite(track.sourceStart, 0, duration)) return fail("ANIMATION", `Source start for '${track.entity}/${track.clip}' must fit the clip.`);
        if (track.rootMotion && animation().rootMotionMode(track.entity) !== "apply") return fail("ROOT_MOTION", `Configure apply-mode root motion on '${track.entity}' before playing this sequence.`);
      }
      guard(() => {
        if (state.id !== null) release();
        state = { id, time: config.startAt ?? 0, cycle: 0, speed, status: (config.startAt ?? 0) === definition.duration && !definition.loop ? "completed" : "playing", error: null };
        const animatedIds = animated(definition);
        for (const entity of targets(definition)) {
          const record = world.get(entity)!, content = resolveEntityDefinition(context.scene, record), ref = context.world.resolve(entity);
          const binding: Binding = { entity, transform: context.world.getTransform(ref),
            ...(content?.character && (animatedIds.has(entity) || controlsTransform(definition, entity)) ? { velocity: physics().velocity(entity) } : {}) };
          handles.set(entity, ref); bindings.push(binding);
          if (animatedIds.has(entity)) binding.animation = animation().claim(entity, owner, content!.model!);
          if (binding.velocity) physics().setVelocity(entity, [0, 0, 0]);
        }
        if (definition.tracks.some(track => track.kind === "camera")) {
          camera = cameras().state(); cameraHandle = camera.follow && context.world.isAlive(camera.follow.entity) ? context.world.resolve(camera.follow.entity) : undefined;
        }
        apply(definition, state.time, state.time, true);
        context.emit("cinematic.started", { sequence: id, time: state.time });
        emitMarkers(definition, state.time, state.time, true);
      });
    },
    pause() {
      alive(); if (state.status !== "playing") return; ensureRefs();
      guard(() => { state.status = "paused"; sampleAudio(current()!, state.time, true); });
    },
    resume() { alive(); if (state.status !== "paused") return; ensureRefs(); guard(() => { state.status = "playing"; sampleAudio(current()!, state.time, true); }); },
    setSpeed(speed) { alive(); const definition = current(); if (definition) setRateCheck(definition, speed); else if (!finite(speed, 0.01, 16)) return fail("SPEED", "Speed must be in [0.01,16]."); guard(() => { state.speed = speed; if (definition) sampleAudio(definition, state.time, true); }); },
    seek(time) {
      alive(); const definition = current() ?? fail("INACTIVE", "Play a sequence before seeking.");
      if (!finite(time, 0, definition.duration)) return fail("SEEK", "Seek time must fit the sequence.");
      ensureRefs(); guard(() => {
        const previous = state.time; state.time = time;
        state.status = time === definition.duration && !definition.loop ? "completed" : state.status === "playing" ? "playing" : "paused";
        apply(definition, previous, time, true);
      });
    },
    stop(options = {}) {
      alive(true); const config = cloneSerializable(options);
      if (!config || typeof config !== "object" || Object.keys(config).some(key => !["restoreAnimation", "restoreCamera", "restoreTransforms"].includes(key)) || Object.values(config).some(value => typeof value !== "boolean")) return fail("STOP", "Stop options must be supported boolean restore flags.");
      ensureRefs(); guard(() => release(config));
    },
    state() { alive(true); return cloneSerializable(state); },
    presentation() {
      alive(true); const definition = current();
      if (!definition) return { subtitles: [], transition: { color: "#000000", opacity: 0 } };
      const subtitles = definition.tracks.flatMap(track => track.kind === "subtitle" && state.time >= track.start && state.time < track.end ? [{
        text: track.key === undefined ? track.text! : (context.getLocalizationService?.() ?? fail("LOCALIZATION", "Localized subtitles require the localization service.")).text(track.key, track.variables), speaker: track.speaker ?? null,
      }] : []);
      const index = definition.tracks.findIndex(track => track.kind === "transition"), track = definition.tracks[index];
      const value = index < 0 ? 0 : compile(definition)[index].opacity!(state.time)[0];
      if (!Number.isFinite(value)) return fail("NUMERIC", "Transition opacity is not finite.");
      return { subtitles, transition: { color: track?.kind === "transition" ? track.color ?? "#000000" : "#000000", opacity: Math.max(0, Math.min(1, value)) } };
    },
  };
  return {
    id: owner, version: "1", services: { cinematics: service }, requiresRecovery: () => faulted,
    legacySnapshot: (): Saved => ({ version: 1, definitions: [], state: idle(), bindings: [], camera: null, voices: [] }),
    systems: [{ id: owner, phase: "physics", beforeIfPresent: ["$engine.models", "$engine.physics"], writes: ["Transform"], run(dt) {
      alive(); if (state.id === null) return; ensureRefs(); const definition = current()!;
      const lost = [...handles].filter(([, ref]) => !context.world.isAlive(ref)).map(([entity]) => entity);
      if (lost.length) {
        guard(() => { const previous = state.id; release(); context.emit("cinematic.bindingLost", { sequence: previous, entities: lost }); }); return;
      }
      if (state.status === "completed") { guard(() => { if (definition.onFinish === "restore") release(); else apply(definition, state.time, state.time, false); }); return; }
      if (state.status === "paused") { guard(() => apply(definition, state.time, state.time, false)); return; }
      if (state.status !== "playing") return;
      if (!finite(dt, 0, 1)) return fail("DT", "Director steps must be finite and at most one second.");
      const total = state.time + dt * state.speed, loops = definition.loop ? Math.floor(total / definition.duration) : 0;
      if (loops > 256 || state.cycle + loops > Number.MAX_SAFE_INTEGER) return fail("CAPACITY", "A director tick may cross at most 256 loops without overflowing its cycle counter.");
      guard(() => {
        let remaining = dt * state.speed;
        do {
          const from = state.time, to = Math.min(definition.duration, from + remaining), advance = to - from;
          state.time = to; apply(definition, from, to, false); emitMarkers(definition, from, to); remaining = Math.max(0, remaining - advance);
          if (to < definition.duration) break;
          if (!definition.loop) { state.status = "completed"; stopVoices(); context.emit("cinematic.completed", { sequence: definition.id, cycle: state.cycle }); break; }
          state.cycle++; state.time = 0; stopVoices(); apply(definition, 0, 0, true); emitMarkers(definition, 0, 0, true);
        } while (remaining > 1e-12);
      });
    } }],
    snapshot(): Saved {
      alive(); ensureRefs();
      const lost = [...handles].filter(([, ref]) => !context.world.isAlive(ref)).map(([entity]) => entity);
      if (lost.length) return fail("BINDING_STALE", `Sequence '${state.id}' lost entities '${lost.join("', '")}'. Advance the director or stop it before saving.`);
      const capturedCamera = camera?.follow && (!cameraHandle || !context.world.isAlive(cameraHandle)) ? { follow: null, pose: null } : camera;
      return cloneSerializable({ version: 1, definitions: [...definitions.values()].sort((a, b) => a.id.localeCompare(b.id, "en")), state, bindings, camera: capturedCamera,
        voices: [...voices].filter(([, id]) => audio().voice(id) !== null).sort(([a], [b]) => a - b) });
    },
    validateSnapshot(value) { parse(value); },
    validateWorld(value, world) {
      const saved = parse(value), definition = saved.definitions.find(item => item.id === saved.state.id);
      if (!definition) return;
      const entities = new Map(world.entities.map(record => [record.id, record])); checkWorld(definition, entities, false);
      for (const binding of saved.bindings) {
        const entity = resolveEntityDefinition(context.scene, entities.get(binding.entity)!);
        if (binding.animation !== undefined) animation().validate(binding.entity, binding.animation, entity!.model!, definition.tracks.filter((track): track is AnimationTrack => track.kind === "animation" && track.entity === binding.entity).map(track => track.clip));
        if (definition.tracks.some(track => track.kind === "animation" && track.entity === binding.entity && track.rootMotion) &&
            (binding.animation as { rootMotion?: { mode: string } } | undefined)?.rootMotion?.mode !== "apply") fail("SNAPSHOT_ROOT_MOTION", "A locomotion cue is missing its apply-mode root-motion baseline.");
        if (binding.velocity !== undefined && !entity?.character) fail("SNAPSHOT_BODY", "Only character bindings may retain a velocity baseline.");
        if (entity?.character && (controlsTransform(definition, binding.entity) || animated(definition).has(binding.entity)) && binding.velocity === undefined) fail("SNAPSHOT_BODY", "A controlled character is missing its captured velocity.");
      }
    },
    validatePeers(value, peers) {
      const saved = parse(value), definition = saved.definitions.find(item => item.id === saved.state.id);
      if (!definition) return;
      const physics2d = peers["$engine.physics2d"]?.payload as { bodies?: { definition: { entity: string } }[] } | undefined;
      for (const body of physics2d?.bodies ?? []) if (controlsTransform(definition, body.definition.entity)) fail("SNAPSHOT_BODY", "A cinematic transform binding cannot also be a 2D body.");
      const services = peers["game-services"]?.payload as { cameraPose?: { position: Vec3; target: Vec3 } | null; audio?: { voices?: { id: string; sound: string; entity: string | null; pausedAt?: number | null; playbackRate?: number }[] } } | undefined;
      for (const [index, track] of definition.tracks.entries()) if (track.kind === "camera") {
        const channels = compile(definition)[index], expected = [channels.position!(saved.state.time), channels.target!(saved.state.time)];
        if (!services?.cameraPose || JSON.stringify(expected) !== JSON.stringify([services.cameraPose.position, services.cameraPose.target])) fail("SNAPSHOT_CAMERA", "Camera pose differs from the director time.");
      }
      for (const [index, id] of saved.voices) {
        const track = definition.tracks[index] as AudioTrack, voice = services?.audio?.voices?.find(voice => voice.id === id);
        if (!voice || voice.sound !== track.sound || voice.entity !== (track.entity ?? null) || (voice.playbackRate ?? 1) !== saved.state.speed * (track.rate ?? 1) || (voice.pausedAt != null) !== (saved.state.status !== "playing")) fail("SNAPSHOT_AUDIO", `Cue '${id}' differs from the audio owner.`);
      }
      const models = peers["$engine.models"]?.payload as { animation?: { animations?: { entity: string; suspended?: boolean; rootMotion?: { mode: string } }[] } } | undefined;
      for (const entity of animated(definition)) {
        const model = models?.animation?.animations?.find(item => item.entity === entity);
        if (!model || model.suspended !== true) fail("SNAPSHOT_ANIMATION", `Model '${entity}' is not held by the timeline.`);
        if (definition.tracks.some(track => track.kind === "animation" && track.entity === entity && track.rootMotion) && model?.rootMotion?.mode !== "apply") fail("SNAPSHOT_ROOT_MOTION", `Model '${entity}' no longer has apply-mode root motion.`);
      }
    },
    restore(value) {
      alive(true); const saved = parse(value);
      definitions = new Map(saved.definitions.map(item => [item.id, item])); state = saved.state; bindings = saved.bindings; camera = saved.camera; voices = new Map(saved.voices);
      handles.clear(); prepared.clear(); cameraHandle = undefined; pendingRefs = true;
      try { ensureRefs(); faulted = false; } catch (error) { faulted = true; throw error; }
    },
    dispose() {
      if (disposed) return; const failures: unknown[] = [];
      for (const id of voices.values()) try { audio().stop(id); } catch (error) { failures.push(error); }
      for (const binding of bindings) if (binding.animation !== undefined) try { animation().release(binding.entity, owner, binding.animation, false); } catch (error) { failures.push(error); }
      disposed = true; voices.clear(); definitions.clear(); prepared.clear(); handles.clear(); bindings = [];
      if (failures.length) throw new AggregateError(failures, "TC_CINEMATIC_DISPOSE: Some timeline-owned resources could not be released.");
    },
  };
};
