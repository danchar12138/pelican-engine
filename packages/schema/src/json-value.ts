import type { JsonValue } from "../../sdk/src/index.ts";

/** Bounded structured component state, shared by compiler and runtime. */
export function cloneJsonValue(value: unknown): JsonValue {
  let nodes = 0;
  const ancestors = new Set<object>();
  const fail = (): never => { throw new Error("TC_STATE_JSON: Expected finite plain JSON, depth <=16, <=8192 nodes and <=65536 UTF-8 bytes per field."); };
  const visit = (item: unknown, depth: number): JsonValue => {
    if (++nodes > 8192 || depth > 16) return fail();
    if (item === null || typeof item === "boolean" || typeof item === "string") return item;
    if (typeof item === "number") return Number.isFinite(item) ? item : fail();
    if (!item || typeof item !== "object" || ancestors.has(item) ||
        (!Array.isArray(item) && ![Object.prototype, null].includes(Object.getPrototypeOf(item)))) return fail();
    ancestors.add(item);
    try {
      if (Array.isArray(item)) {
        if (Reflect.ownKeys(item).length !== item.length + 1) return fail();
        return Array.from({ length: item.length }, (_, index) => {
          const descriptor = Object.getOwnPropertyDescriptor(item, String(index));
          return descriptor && "value" in descriptor && descriptor.enumerable ? visit(descriptor.value, depth + 1) : fail();
        });
      }
      return Object.fromEntries(Reflect.ownKeys(item).map(key => {
        const descriptor = Object.getOwnPropertyDescriptor(item, key)!;
        if (typeof key !== "string" || ["__proto__", "constructor", "prototype"].includes(key) || !("value" in descriptor) || !descriptor.enumerable) return fail();
        return [key, visit(descriptor.value, depth + 1)];
      }));
    } finally { ancestors.delete(item); }
  };
  const result = visit(value, 0);
  if (new TextEncoder().encode(JSON.stringify(result)).length > 65536) return fail();
  return result;
}
