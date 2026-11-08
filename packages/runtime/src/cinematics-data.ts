import { NumberKeyframeTrack, QuaternionKeyframeTrack, VectorKeyframeTrack, InterpolateDiscrete, InterpolateLinear, InterpolateSmooth, type Interpolant, type KeyframeTrack } from "three";
import type { CinematicDefinition, CinematicTrack, CinematicScalarKey } from "../../sdk/src/index.ts";
import { cloneSerializable } from "./random.ts";

export const cinematicError = (code: string, detail: string): never => { throw new Error(`TC_CINEMATIC_${code}: ${detail}`); };
export const cinematicName = (value: unknown): value is string => typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= 128 && !/[\x00-\x1f\x7f]/.test(value);
const bounded = (value: unknown, min: number, max: number) => typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
export function normalizeCinematic(raw: CinematicDefinition): CinematicDefinition {
  const input = cloneSerializable(raw);
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(key => !["id", "duration", "loop", "onFinish", "tracks", "markers"].includes(key)) ||
      !cinematicName(input.id) || !bounded(input.duration, 1e-6, 86400) || (input.loop !== undefined && typeof input.loop !== "boolean") || !["hold", "restore"].includes(input.onFinish ?? "restore") || !Array.isArray(input.tracks) || input.tracks.length > 256) return cinematicError("DEFINITION", "Use an id, positive duration up to one day and at most 256 tracks.");
  const keys = (value: unknown, dimensions: number) => {
    if (!Array.isArray(value) || value.length < 1 || value.length > 4096) return cinematicError("KEYS", "Channels need 1..4096 ordered keys.");
    let previous = -1;
    for (const key of value) {
      if (!key || typeof key !== "object" || Object.keys(key).some(field => !["time", "value"].includes(field)) || !bounded(key.time, 0, input.duration) || key.time <= previous ||
          !Array.isArray(key.value) || key.value.length !== dimensions || !Array.from(key.value).every(v => bounded(v, -1e6, 1e6)) || (dimensions === 4 && Math.abs(Math.hypot(...key.value) - 1) > 1e-6)) return cinematicError("KEYS", "Key times must be strictly increasing and values finite; rotations must be normalized quaternions.");
      previous = key.time;
    }
  };
  const transformed = new Set<string>(), segments = new Map<string, { start: number; end: number }[]>();
  let camera = false;
  let transition = false;
  for (const track of input.tracks) {
    if (!track || typeof track !== "object" || Array.isArray(track)) return cinematicError("TRACK", "Each track must be a supported object.");
    const fields: Record<CinematicTrack["kind"], string[]> = {
      transform: ["kind", "entity", "position", "rotation", "interpolation"], camera: ["kind", "position", "target", "interpolation"],
      animation: ["kind", "entity", "clip", "start", "end", "sourceStart", "speed", "loop", "rootMotion"],
      audio: ["kind", "sound", "start", "end", "sourceStart", "rate", "volume", "loop", "entity", "bus", "priority", "occlusion"],
      subtitle: ["kind", "start", "end", "text", "key", "variables", "speaker"], transition: ["kind", "opacity", "color", "interpolation"],
    };
    if (!Object.hasOwn(fields, track.kind) || Object.keys(track).some(field => !fields[track.kind as CinematicTrack["kind"]].includes(field))) return cinematicError("TRACK", "Unsupported track kind or field.");
    if (track.kind === "transition") {
      if (transition || !/^#[0-9a-fA-F]{6}$/.test(track.color ?? "#000000") || !["linear", "smooth", "step"].includes(track.interpolation ?? "linear") ||
          !Array.isArray(track.opacity) || track.opacity.some((key: CinematicScalarKey) => !key || Object.keys(key).some(field => !["time", "value"].includes(field)) || !bounded(key.value, 0, 1))) return cinematicError("TRANSITION", "Use one transition track, a six-digit hex color and opacity keys in [0,1].");
      keys(track.opacity.map((key: CinematicScalarKey) => ({ time: key.time, value: [key.value] })), 1); transition = true;
    } else if (track.kind === "subtitle") {
      if (!bounded(track.start, 0, input.duration) || !bounded(track.end, 0, input.duration) || track.end <= track.start || ((track.text === undefined) === (track.key === undefined)) ||
          (track.text !== undefined && (typeof track.text !== "string" || track.text.length > 4096)) || (track.key !== undefined && !cinematicName(track.key)) ||
          (track.speaker !== undefined && (typeof track.speaker !== "string" || track.speaker.length > 128)) ||
          (track.variables !== undefined && (!track.variables || typeof track.variables !== "object" || Array.isArray(track.variables) || Object.keys(track.variables).length > 32 || Object.entries(track.variables).some(([key, value]) => !cinematicName(key) || !(typeof value === "boolean" || (typeof value === "string" && value.length <= 4096) || (typeof value === "number" && Number.isFinite(value))))))) return cinematicError("SUBTITLE", "Subtitle cues need a valid interval and either text or a localization key.");
    } else if (track.kind === "transform" || track.kind === "camera") {
      if (!["linear", "smooth", "step"].includes(track.interpolation ?? "linear")) return cinematicError("INTERPOLATION", "Use linear, smooth or step interpolation.");
      if (track.position !== undefined) keys(track.position, 3);
      if (track.kind === "transform") {
        if (!cinematicName(track.entity) || transformed.has(track.entity) || (!track.position && !track.rotation)) return cinematicError("BINDING", "Each transform entity needs one nonempty track.");
        transformed.add(track.entity); if (track.rotation !== undefined) keys(track.rotation, 4);
      } else {
        if (camera || !track.position) return cinematicError("CAMERA", "A sequence may contain one camera track with position and target channels.");
        camera = true; keys(track.target, 3);
      }
    } else {
      if (!bounded(track.start, 0, input.duration) || !bounded(track.end, 0, input.duration) || track.end <= track.start || (track.sourceStart !== undefined && !bounded(track.sourceStart, 0, 86400)) || (track.loop !== undefined && typeof track.loop !== "boolean")) return cinematicError("INTERVAL", "Track intervals must fit the sequence and source offsets must be nonnegative.");
      if (track.kind === "animation") {
        if (!cinematicName(track.entity) || !cinematicName(track.clip) || (track.speed !== undefined && !bounded(track.speed, -100, 100)) || (track.rootMotion !== undefined && typeof track.rootMotion !== "boolean")) return cinematicError("ANIMATION", "Supply a model entity, clip and finite speed in [-100,100].");
        if (Math.abs((track.sourceStart ?? 0) + (track.end - track.start) * (track.speed ?? 1)) > 86400) return cinematicError("ANIMATION", "Animation source intervals must stay within one day of the clip origin.");
        const list = segments.get(track.entity) ?? []; list.push(track); segments.set(track.entity, list);
      } else if (!cinematicName(track.sound) || (track.entity !== undefined && !cinematicName(track.entity)) || (track.bus !== undefined && !cinematicName(track.bus)) ||
          (track.volume !== undefined && !bounded(track.volume, 0, 1)) || (track.rate !== undefined && !bounded(track.rate, 0.01, 16)) ||
          (track.priority !== undefined && (!Number.isSafeInteger(track.priority) || !bounded(track.priority, 0, 255))) || (track.occlusion !== undefined && typeof track.occlusion !== "boolean") || (track.occlusion && !track.entity) ||
          (track.sourceStart ?? 0) + (track.end - track.start) * (track.rate ?? 1) > 86400) return cinematicError("AUDIO", "Invalid sound, spatial binding, volume, rate, priority, occlusion or one-day source interval.");
    }
  }
  for (const [entity, list] of segments) {
    list.sort((a, b) => a.start - b.start);
    if (list.some((track, index) => index > 0 && track.start < list[index - 1].end)) return cinematicError("OVERLAP", `Animation intervals overlap for '${entity}'.`);
    if (transformed.has(entity) && input.tracks.some(track => track.kind === "animation" && track.entity === entity && track.rootMotion === true)) return cinematicError("MOTION", `Set rootMotion:false when '${entity}' also has a transform track.`);
  }
  const edges = input.tracks.flatMap(track => track.kind === "audio" ? [{ time: track.start, delta: 1 }, { time: track.end, delta: -1 }] : []).sort((a, b) => a.time - b.time || a.delta - b.delta);
  let simultaneous = 0;
  for (const edge of edges) { simultaneous += edge.delta; if (simultaneous > 32) return cinematicError("AUDIO_CAPACITY", "One sequence cannot require more than 32 simultaneous voices."); }
  const subtitles = input.tracks.flatMap(track => track.kind === "subtitle" ? [{ time: track.start, delta: 1 }, { time: track.end, delta: -1 }] : []).sort((a, b) => a.time - b.time || a.delta - b.delta);
  simultaneous = 0;
  for (const edge of subtitles) { simultaneous += edge.delta; if (simultaneous > 4) return cinematicError("SUBTITLE_CAPACITY", "Use at most four simultaneous subtitle cues."); }
  if (input.markers !== undefined) {
    if (!Array.isArray(input.markers) || input.markers.length > 4096) return cinematicError("MARKER", "Use at most 4096 markers.");
    const names = new Set<string>();
    for (const marker of input.markers) {
      if (!marker || typeof marker !== "object" || Object.keys(marker).some(key => !["id", "time", "payload"].includes(key)) || !cinematicName(marker.id) || names.has(marker.id) || !bounded(marker.time, 0, input.duration) ||
          (marker.payload !== undefined && (!marker.payload || typeof marker.payload !== "object" || Array.isArray(marker.payload) || JSON.stringify(marker.payload).length > 65536))) return cinematicError("MARKER", "Markers need unique IDs, bounded time and a serializable object payload up to 64 KiB.");
      names.add(marker.id);
    }
  }
  return { ...input, loop: input.loop ?? false, onFinish: input.onFinish ?? "restore", markers: [...(input.markers ?? [])].sort((a, b) => a.time - b.time || a.id.localeCompare(b.id, "en")) };
}

export type CinematicSampler = (time: number) => number[];
/** Three interpolants own channel interpolation; no game-visible renderer objects. */
export function cinematicChannel(keys: readonly { time: number; value: readonly number[] }[], mode: "linear" | "smooth" | "step" = "linear", rotation = false): CinematicSampler {
  const values = keys.flatMap(key => [...key.value]), times = keys.map(key => key.time);
  const interpolation = mode === "step" ? InterpolateDiscrete : mode === "smooth" && !rotation ? InterpolateSmooth : InterpolateLinear;
  const track = rotation ? new QuaternionKeyframeTrack("pose", times, values, interpolation) : keys[0].value.length === 1 ? new NumberKeyframeTrack("pose", times, values, interpolation) : new VectorKeyframeTrack("pose", times, values, interpolation);
  const sampler = (track as KeyframeTrack & { createInterpolant(): Interpolant }).createInterpolant();
  return time => Array.from(sampler.evaluate(time));
}
