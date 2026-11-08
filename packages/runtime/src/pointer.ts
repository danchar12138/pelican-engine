import type { PointerState } from "../../sdk/src/index.ts";

export function neutralPointer(): PointerState {
  return { position: [0, 0], ndc: [0, 0], delta: [0, 0], wheel: [0, 0], buttons: 0, pressed: 0, released: 0, inside: false, locked: false, contacts: [] };
}
export function parsePointer(value: unknown, code = "TC_POINTER_EVENT"): PointerState {
  const fail = (): never => { throw new Error(`${code}: Expected bounded canvas-local pointer state with at most 16 contacts.`); };
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail();
  const p = value as PointerState;
  if (Object.keys(p).sort().join() !== Object.keys(neutralPointer()).sort().join()) return fail();
  for (const v of [p.position, p.ndc, p.delta, p.wheel]) if (!Array.isArray(v) || v.length !== 2 || v.some(n => !Number.isFinite(n) || Math.abs(n) > 1e6)) return fail();
  for (const v of [p.buttons, p.pressed, p.released]) if (!Number.isInteger(v) || v < 0 || v > 31) return fail();
  if (typeof p.inside !== "boolean" || typeof p.locked !== "boolean" || !Array.isArray(p.contacts) || p.contacts.length > 16) return fail();
  const ids = new Set<number>();
  for (const c of p.contacts) {
    if (!c || Object.keys(c).sort().join() !== "id,kind,position,pressure" || !Number.isSafeInteger(c.id) || c.id < 0 || ids.has(c.id) ||
        !["mouse", "pen", "touch"].includes(c.kind) || !Number.isFinite(c.pressure) || c.pressure < 0 || c.pressure > 1 ||
        !Array.isArray(c.position) || c.position.length !== 2 || c.position.some((n: number) => !Number.isFinite(n) || Math.abs(n) > 1e6)) return fail();
    ids.add(c.id);
  }
  return { ...p, position: [...p.position], ndc: [...p.ndc], delta: [...p.delta], wheel: [...p.wheel], contacts: p.contacts.map(c => ({ ...c, position: [...c.position] })) };
}
export function advancePointer(previous: PointerState, samples: readonly unknown[]): PointerState {
  let state: PointerState = { ...previous, delta: [0, 0], wheel: [0, 0], pressed: 0, released: 0 };
  for (const raw of samples) {
    const next = parsePointer(raw);
    state = { ...next, pressed: state.pressed | next.pressed | (next.buttons & ~state.buttons), released: state.released | next.released | (state.buttons & ~next.buttons),
      delta: [state.delta[0] + next.delta[0], state.delta[1] + next.delta[1]], wheel: [state.wheel[0] + next.wheel[0], state.wheel[1] + next.wheel[1]] };
  }
  return parsePointer(state);
}
