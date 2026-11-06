import { GRAPH_TYPES, type GraphType, type GraphValue } from "./index.ts";

/** Internal shared value contract; public declarations remain in the SDK entry. */
export function isGraphType(value: unknown): value is GraphType {
  return typeof value === "string" && (GRAPH_TYPES as readonly string[]).includes(value);
}
export function graphValue(type: GraphType, value: unknown): GraphValue | null {
  const number = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && Number.isFinite(Math.fround(v));
  if (type === "bool") return typeof value === "boolean" ? value : null;
  if (type === "float") return number(value) ? value : null;
  const size = Number(type.slice(3));
  if (!Array.isArray(value) || value.length !== size || !Array.from(value).every(number)) return null;
  return Object.freeze(Array.from(value)) as unknown as GraphValue;
}
