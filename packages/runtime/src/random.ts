/** Finite JSON data only; never invoke accessors or toJSON hooks. */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export function cloneSerializable<T>(value: T): T {
  const ancestors = new Set<object>();
  const visit = (input: unknown, path: string): unknown => {
    if (
      input === null ||
      typeof input === "string" ||
      typeof input === "boolean"
    )
      return input;
    if (typeof input === "number" && Number.isFinite(input)) return input;
    if (typeof input !== "object" || input === null)
      throw new Error(`TC_SERIALIZATION: Invalid JSON value at ${path}.`);
    if (ancestors.has(input))
      throw new Error(`TC_SERIALIZATION: Circular value at ${path}.`);
    const array = Array.isArray(input);
    const prototype = Object.getPrototypeOf(input);
    if (!array && prototype !== Object.prototype && prototype !== null)
      throw new Error(`TC_SERIALIZATION: Expected a plain object at ${path}.`);
    if (Object.getOwnPropertySymbols(input).length)
      throw new Error(`TC_SERIALIZATION: Symbol keys at ${path}.`);
    ancestors.add(input);
    const result: Record<string, unknown> | unknown[] = array ? [] : {};
    const keys = Object.getOwnPropertyNames(input).filter(
      (key) => !(array && key === "length"),
    );
    if (
      array &&
      (keys.length !== input.length ||
        keys.some((key, index) => key !== String(index)))
    )
      throw new Error(
        `TC_SERIALIZATION: Sparse array or array properties at ${path}.`,
      );
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(input, key)!;
      if (!descriptor.enumerable || !("value" in descriptor))
        throw new Error(
          `TC_SERIALIZATION: Accessor or hidden property at ${path}.${key}.`,
        );
      Object.defineProperty(result, key, {
        value: visit(descriptor.value, `${path}.${key}`),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    ancestors.delete(input);
    return result;
  };
  return visit(value, "$") as T;
}

export interface RandomSnapshot {
  format: "pelican.random";
  version: 1;
  algorithm: "mulberry32";
  state: number;
  draws: number;
}

export function validateRandomSnapshot(value: unknown): RandomSnapshot {
  const data = cloneSerializable(value) as RandomSnapshot;
  if (
    !data ||
    data.format !== "pelican.random" ||
    data.version !== 1 ||
    data.algorithm !== "mulberry32" ||
    !Number.isInteger(data.state) ||
    data.state < 0 ||
    data.state > 0xffffffff ||
    !Number.isSafeInteger(data.draws) ||
    data.draws < 0
  )
    throw new Error(
      "TC_RANDOM_SNAPSHOT: Unsupported or malformed random snapshot.",
    );
  return data;
}

/** CPU seeded stream, not cryptographic and not a cross-GPU determinism promise. */
export function createRandom(seed = 0) {
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff)
    throw new Error("TC_RANDOM_SEED: Expected a uint32 seed.");
  let state = seed >>> 0,
    draws = 0;
  return {
    next(): number {
      if (!Number.isSafeInteger(draws + 1))
        throw new Error("TC_RANDOM_LIMIT: Random draw counter exhausted.");
      state = (state + 0x6d2b79f5) >>> 0;
      let t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      draws++;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },
    snapshot(): RandomSnapshot {
      return {
        format: "pelican.random",
        version: 1,
        algorithm: "mulberry32",
        state,
        draws,
      };
    },
    restore(value: unknown): void {
      const data = validateRandomSnapshot(value);
      state = data.state;
      draws = data.draws;
    },
  };
}
