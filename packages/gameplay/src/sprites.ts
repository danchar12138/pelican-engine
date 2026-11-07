import type { EntityHandle, SpriteAnimation, SpriteDefinition, SpriteService, SpriteState, Vec2 } from "../../sdk/src/index.ts";
import type { WorldSnapshot } from "../../runtime/src/contracts.ts";
import type { RuntimePluginFactory } from "../../runtime/src/plugins.ts";
import { cloneSerializable } from "../../runtime/src/random.ts";

type Animation = SpriteAnimation & { loop: boolean };
type Entry = { id: string; entity: string; material: string; size: Vec2; offset: Vec2; columns: number; rows: number;
  frame: number; animation: Animation | null; phase: number; playing: boolean; completed: boolean; castShadow: boolean; receiveShadow: boolean };
type Snapshot = { format: "pelican.sprites"; version: 1; sprites: Entry[] };
const MAX_SPRITES = 1024, MAX_DIMENSION = 256, MAX_FRAMES = 4096;
const fail = (code: string, message: string): never => { throw new Error(`TC_SPRITE_${code}: ${message}`); };
const validName = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0 && value.length <= 64 && !/[\x00-\x1f\x7f]/.test(value);
const fields = (value: unknown, allowed: readonly string[]): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).every(key => allowed.includes(key));
function pair(value: unknown, label: string, positive: boolean): Vec2 {
  if (!Array.isArray(value) || value.length !== 2 || value.some(v => typeof v !== "number" || !Number.isFinite(v) || Math.abs(v) > 1e6 ||
      !Number.isFinite(Math.fround(v)) || (positive && (v <= 0 || Math.fround(v) === 0))))
    return fail("VALUE", `${label} must contain two ${positive ? "positive " : ""}finite values with magnitude at most 1e6.`);
  return [value[0], value[1]];
}
function frame(value: unknown, total: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) >= total)
    return fail("FRAME", `Frame must be an integer in [0, ${total - 1}].`);
  return value as number;
}
function animation(value: SpriteAnimation, total: number): Animation {
  if (!fields(value, ["first", "last", "fps", "loop"])) return fail("ANIMATION", "Expected first, last, fps and optional loop.");
  const first = frame(value.first, total), last = frame(value.last, total);
  if (last < first || typeof value.fps !== "number" || !Number.isFinite(value.fps) || value.fps <= 0 || value.fps > 240 ||
      (value.loop !== undefined && typeof value.loop !== "boolean"))
    return fail("ANIMATION", "Animation requires first <= last, fps in (0, 240], and a boolean loop.");
  return { first, last, fps: value.fps, loop: value.loop === undefined ? true : value.loop };
}
function view(item: Entry): SpriteState {
  return cloneSerializable({ id: item.id, entity: item.entity, material: item.material, size: item.size, offset: item.offset,
    columns: item.columns, rows: item.rows, frame: item.frame, animation: item.animation, playing: item.playing, completed: item.completed,
    castShadow: item.castShadow, receiveShadow: item.receiveShadow });
}
export const createSpritePlugin: RuntimePluginFactory = context => {
  let entries = new Map<string, Entry>(), handles = new Map<string, EntityHandle>(), disposed = false;
  const alive = () => { if (disposed) fail("DISPOSED", "Create a new host before using sprites."); };
  const prune = () => {
    for (const [id, handle] of handles) if (!context.world.isAlive(handle)) { handles.delete(id); entries.delete(id); }
  };
  const get = (id: string) => {
    alive(); prune();
    if (!validName(id)) return fail("ID", "Expected a nonempty sprite id.");
    return entries.get(id) ?? fail("MISSING", `Sprite '${id}' does not exist or its entity was destroyed.`);
  };
  const materialExists = (id: string) => context.scene.materials.some(material => material.id === id && !!material.texture);
  function parse(value: unknown): Entry[] {
    const data = cloneSerializable(value) as Snapshot;
    if (!fields(data, ["format", "version", "sprites"]) || data.format !== "pelican.sprites" || data.version !== 1 ||
        !Array.isArray(data.sprites) || data.sprites.length > MAX_SPRITES) return fail("SNAPSHOT", "Expected a bounded version 1 sprite snapshot.");
    const ids = new Set<string>();
    return data.sprites.map(item => {
      if (!fields(item, ["id", "entity", "material", "size", "offset", "columns", "rows", "frame", "animation", "phase", "playing", "completed", "castShadow", "receiveShadow"]) ||
          !validName(item.id) || ids.has(item.id) || !validName(item.entity) || !validName(item.material) || !materialExists(item.material) ||
          !Number.isSafeInteger(item.columns) || item.columns < 1 || item.columns > MAX_DIMENSION ||
          !Number.isSafeInteger(item.rows) || item.rows < 1 || item.rows > MAX_DIMENSION || item.columns * item.rows > MAX_FRAMES ||
          typeof item.phase !== "number" || !Number.isFinite(item.phase) || item.phase < 0 || item.phase >= 1 ||
          typeof item.playing !== "boolean" || typeof item.completed !== "boolean" || typeof item.castShadow !== "boolean" || typeof item.receiveShadow !== "boolean")
        return fail("SNAPSHOT", "Invalid or duplicate sprite state.");
      ids.add(item.id);
      const size = pair(item.size, "size", true), offset = pair(item.offset, "offset", false), total = item.columns * item.rows;
      const selected = frame(item.frame, total), clip = item.animation === null ? null : animation(item.animation, total);
      if ((item.playing && (!clip || item.completed || selected < clip.first || selected > clip.last)) ||
          (item.completed && (!clip || clip.loop || item.playing || selected !== clip.last || item.phase !== 0)) ||
          (!clip && item.phase !== 0))
        return fail("SNAPSHOT", `Sprite '${item.id}' has inconsistent playback state.`);
      return { id: item.id, entity: item.entity, material: item.material, size, offset, columns: item.columns, rows: item.rows,
        frame: selected, animation: clip, phase: item.phase, playing: item.playing, completed: item.completed,
        castShadow: item.castShadow, receiveShadow: item.receiveShadow };
    });
  }
  function validateWorld(items: readonly Entry[], world: WorldSnapshot): void {
    const ids = new Set(world.entities.map(item => item.id));
    for (const item of items) if (!ids.has(item.entity)) return fail("SNAPSHOT", `Sprite '${item.id}' needs live entity '${item.entity}' in the world snapshot.`);
  }
  const service: SpriteService = {
    create(input) {
      alive(); prune();
      const value = cloneSerializable(input);
      if (!fields(value, ["id", "entity", "material", "size", "offset", "columns", "rows", "frame", "animation", "castShadow", "receiveShadow"]) ||
          !validName(value.id) || !validName(value.entity) || !validName(value.material))
        return fail("DEFINITION", "Sprite requires nonempty id, entity and textured material ids.");
      if (entries.has(value.id)) return fail("DUPLICATE", `Sprite '${value.id}' already exists.`);
      if (entries.size >= MAX_SPRITES) return fail("CAPACITY", `At most ${MAX_SPRITES} sprites may exist.`);
      if (!context.world.isAlive(value.entity)) return fail("ENTITY", `Entity '${value.entity}' is not alive; create it before the sprite.`);
      if (!materialExists(value.material)) return fail("MATERIAL", `Material '${value.material}' must be declared with a texture.`);
      const columns = value.columns === undefined ? 1 : value.columns, rows = value.rows === undefined ? 1 : value.rows;
      if (typeof columns !== "number" || !Number.isSafeInteger(columns) || columns < 1 || columns > MAX_DIMENSION ||
          typeof rows !== "number" || !Number.isSafeInteger(rows) || rows < 1 || rows > MAX_DIMENSION || columns * rows > MAX_FRAMES)
        return fail("ATLAS", `Atlas dimensions must be 1..${MAX_DIMENSION} with at most ${MAX_FRAMES} frames.`);
      if ((value.castShadow !== undefined && typeof value.castShadow !== "boolean") ||
          (value.receiveShadow !== undefined && typeof value.receiveShadow !== "boolean"))
        return fail("DEFINITION", "Sprite shadow options must be boolean.");
      const total = columns * rows, clip = value.animation === undefined ? null : animation(value.animation as SpriteAnimation, total);
      const selected = value.frame === undefined ? clip?.first ?? 0 : frame(value.frame, total);
      if (clip && selected !== clip.first) return fail("FRAME", "A sprite with automatic animation must start at its first frame; omit frame or use the first frame.");
      const entry: Entry = { id: value.id, entity: value.entity, material: value.material, size: pair(value.size, "size", true),
        offset: value.offset === undefined ? [0, 0] : pair(value.offset, "offset", false), columns, rows,
        frame: selected, animation: clip, phase: 0, playing: clip !== null, completed: false,
        castShadow: value.castShadow === true, receiveShadow: value.receiveShadow === true };
      const handle = context.world.resolve(value.entity);
      entries.set(entry.id, entry); handles.set(entry.id, handle);
    },
    play(id, input) {
      const entry = get(id), clip = input === undefined ? entry.animation : animation(cloneSerializable(input), entry.columns * entry.rows);
      if (!clip) return fail("ANIMATION", `Sprite '${id}' has no animation; provide one to play.`);
      entry.animation = clip; entry.frame = clip.first; entry.phase = 0; entry.playing = true; entry.completed = false;
    },
    pause(id) { const entry = get(id); entry.playing = false; },
    resume(id) {
      const entry = get(id), clip = entry.animation;
      if (!clip || entry.completed || entry.frame < clip.first || entry.frame > clip.last)
        return fail("ANIMATION", `Sprite '${id}' cannot resume; call play with a valid animation.`);
      entry.playing = true;
    },
    setFrame(id, value) { const entry = get(id), selected = frame(value, entry.columns * entry.rows); entry.frame = selected; entry.phase = 0; entry.playing = false; entry.completed = false; },
    inspect(id) { return view(get(id)); },
    visuals() { alive(); prune(); return [...entries.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0).map(view); },
    destroy(id) { get(id); entries.delete(id); handles.delete(id); },
  };
  const empty = (): Snapshot => ({ format: "pelican.sprites", version: 1, sprites: [] });
  return {
    id: "$engine.sprites", version: "1", services: { sprites: service },
    systems: [{ id: "$engine.sprites.tick", phase: "presentation", run(dt) {
      alive(); prune();
      if (!Number.isFinite(dt) || dt < 0) return fail("DT", "Sprite fixed step must be finite and nonnegative.");
      const updates: { entry: Entry; frame: number; phase: number; playing: boolean; completed: boolean }[] = [];
      for (const entry of entries.values()) if (entry.playing && entry.animation) {
        const clip = entry.animation, elapsed = entry.phase + dt * clip.fps, steps = Math.floor(elapsed);
        if (!Number.isFinite(elapsed) || !Number.isSafeInteger(steps)) return fail("DT", "Sprite frame advance exceeded the safe integer range.");
        let selected = entry.frame, phase = elapsed - steps, playing = true, completed = false;
        if (clip.loop) {
          const length = clip.last - clip.first + 1;
          selected = clip.first + ((entry.frame - clip.first + (steps % length)) % length);
        }
        else if (steps > clip.last - entry.frame) { selected = clip.last; phase = 0; playing = false; completed = true; }
        else selected += steps;
        updates.push({ entry, frame: selected, phase, playing, completed });
      }
      for (const update of updates) Object.assign(update.entry, { frame: update.frame, phase: update.phase, playing: update.playing, completed: update.completed });
    } }],
    snapshot() { alive(); prune(); return cloneSerializable({ format: "pelican.sprites", version: 1,
      sprites: [...entries.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0) }); },
    legacySnapshot: empty,
    validateSnapshot(value) { parse(value); },
    validateWorld(value, world) { validateWorld(parse(value), world); },
    restore(value) {
      alive();
      const parsed = parse(value), nextHandles = new Map<string, EntityHandle>();
      for (const item of parsed) nextHandles.set(item.id, context.world.resolve(item.entity));
      entries = new Map(parsed.map(item => [item.id, item])); handles = nextHandles;
    },
    dispose() { disposed = true; entries.clear(); handles.clear(); },
  };
};
