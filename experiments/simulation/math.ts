import type { Vec3 } from "./types.ts";
export const add = (a: Vec3, b: Vec3): Vec3 => [
  a[0] + b[0],
  a[1] + b[1],
  a[2] + b[2],
];
export const sub = (a: Vec3, b: Vec3): Vec3 => [
  a[0] - b[0],
  a[1] - b[1],
  a[2] - b[2],
];
export const mul = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a: Vec3, b: Vec3): number =>
  a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export const length = (a: Vec3): number => Math.hypot(...a);
export function accumulate(a: Vec3, b: Vec3, scale = 1): void {
  for (let k = 0; k < 3; k++) a[k] += b[k] * scale;
}
export const volume = (a: Vec3, b: Vec3, c: Vec3, d: Vec3): number =>
  dot(sub(b, a), cross(sub(c, a), sub(d, a))) / 6;
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function copy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
export function fail(code: string, message: string): never {
  throw new Error(`${code}: ${message}`);
}
export const isVec3 = (v: unknown): v is Vec3 =>
  Array.isArray(v) &&
  v.length === 3 &&
  v.every((x) => typeof x === "number" && Number.isFinite(x));
