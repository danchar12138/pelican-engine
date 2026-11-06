import type { ComputeTextureBinding, Vec2, Vec4 } from "../../sdk/src/index.ts";
import type { ComputeExecutionInput } from "../../runtime/src/compute-contract.ts";

/** CPU vertex-geometry oracle only; GPU presentation never uploads this result. */
export function sampleManagedTexture(descriptor: ComputeExecutionInput, uv: Vec2, sampler: ComputeTextureBinding): Vec4 {
  const shape = descriptor.texture;
  if (!shape || descriptor.type !== "vec4" || !Number.isSafeInteger(shape.width) || !Number.isSafeInteger(shape.height) || shape.width < 1 || shape.height < 1 || shape.width * shape.height !== descriptor.values.length)
    throw new Error("TC_RENDER_TEXTURE_RESOURCE: Expected a live linear rgba32float descriptor with matching dimensions.");
  const f = Math.fround, u = f(uv[0]), v = f(uv[1]);
  if (!Number.isFinite(u) || !Number.isFinite(v)) return [0, 0, 0, 0];
  const normalize = (value: number, wrap = "clamp") => wrap === "repeat" ? f(value - Math.floor(value)) : wrap === "mirror" ? f(1 - Math.abs(f(value - f(2 * Math.floor(f(value * 0.5)))) - 1)) : Math.max(0, Math.min(1, value));
  const address = (index: number, size: number, wrap = "clamp") => {
    if (wrap === "clamp") return Math.max(0, Math.min(size - 1, index));
    const period = wrap === "mirror" ? size * 2 : size, cell = ((index % period) + period) % period;
    return wrap === "mirror" ? Math.min(cell, size * 2 - 1 - cell) : cell;
  };
  const read = (x: number, y: number): readonly number[] => {
    const value = descriptor.values[address(y, shape.height, sampler.wrapV) * shape.width + address(x, shape.width, sampler.wrapU)];
    if (!Array.isArray(value) || value.length !== 4 || value.some(v => !Number.isFinite(f(v)))) throw new Error("TC_RENDER_TEXTURE_RESOURCE: Invalid sampled Vec4 texel.");
    return value;
  };
  const x = f(normalize(u, sampler.wrapU) * shape.width), y = f(normalize(v, sampler.wrapV) * shape.height);
  if (sampler.filter === "nearest") return read(Math.floor(x), Math.floor(y)).map(f) as unknown as Vec4;
  const px = f(x - 0.5), py = f(y - 0.5), bx = Math.floor(px), by = Math.floor(py), wx = f(px - bx), wy = f(py - by);
  const a = read(bx, by), b = read(bx + 1, by), c = read(bx, by + 1), d = read(bx + 1, by + 1);
  const mix = (left: number, right: number, weight: number) => f(f(f(left) * f(1 - weight)) + f(f(right) * weight));
  return [0, 1, 2, 3].map(i => mix(mix(a[i], b[i], wx), mix(c[i], d[i], wx), wy)) as unknown as Vec4;
}
