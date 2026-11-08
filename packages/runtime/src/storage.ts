import type {
  ComponentData,
  ComponentSchema,
  Field,
} from "../../sdk/src/index.ts";
import type { JsonValue } from "../../sdk/src/index.ts";
import { cloneJsonValue } from "../../schema/src/json-value.ts";

/** Numeric component values live in columns, never in per-entity objects. */
export type Column = Float64Array | Uint8Array | JsonValue[];
type Value = ComponentData[string];

export function fail(code: string, message: string): never {
  throw new Error(`TC_WORLD_${code}: ${message}`);
}

export function record(
  value: unknown,
  label: string,
): asserts value is Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    fail("SCHEMA", `${label} must be a plain record.`);
  }
}

export function identifier(
  value: unknown,
  label: string,
): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0)
    fail("ID", `${label} must be a nonempty string.`);
}

function fieldValue(field: Field, value: unknown, label: string): Value {
  switch (field.type) {
    case "json": return cloneJsonValue(value);
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value))
        fail("VALUE", `${label} must be finite.`);
      return value;
    case "boolean":
      if (typeof value !== "boolean")
        fail("VALUE", `${label} must be boolean.`);
      return value;
    case "string":
      if (typeof value !== "string") fail("VALUE", `${label} must be string.`);
      return value;
    case "vec3":
      if (
        !Array.isArray(value) ||
        value.length !== 3 ||
        ![0, 1, 2].every(
          (i) => typeof value[i] === "number" && Number.isFinite(value[i]),
        )
      ) {
        fail("VALUE", `${label} must contain exactly three finite numbers.`);
      }
      return [value[0], value[1], value[2]];
    default:
      return fail("SCHEMA", `${label} has an unsupported field type.`);
  }
}

export function cloneSchema(input: ComponentSchema): ComponentSchema {
  record(input, "Component schema");
  return Object.fromEntries(
    Object.entries(input).map(([name, entry]) => {
      identifier(name, "Field name");
      record(entry, `Field ${name}`);
      if (
        !Object.hasOwn(entry, "type") ||
        !Object.hasOwn(entry, "default") ||
        Object.keys(entry).some((key) => key !== "type" && key !== "default")
      ) {
        fail("SCHEMA", `Field ${name} requires only type and default.`);
      }
      const field = entry as unknown as Field;
      return [
        name,
        {
          type: field.type,
          default: fieldValue(field, field.default, `Default ${name}`),
        },
      ];
    }),
  ) as ComponentSchema;
}

/** full=false validates a patch; full=true adds defaults (or requires complete snapshot data). */
export function values(
  schema: ComponentSchema,
  input: ComponentData,
  full: boolean,
  strict = false,
): ComponentData {
  record(input, "Component data");
  const entries: [string, Value][] = [];
  for (const key of Object.keys(input)) {
    if (!Object.hasOwn(schema, key))
      fail("FIELD", `Unknown component field ${key}.`);
  }
  for (const [key, field] of Object.entries(schema)) {
    if (Object.hasOwn(input, key))
      entries.push([key, fieldValue(field, input[key], key)]);
    else if (strict) fail("FIELD", `Snapshot is missing field ${key}.`);
    else if (full) entries.push([key, fieldValue(field, field.default, key)]);
  }
  return Object.fromEntries(entries);
}

/** Private storage module; presence and every field are indexed by stable entity index. */
export class ComponentStorage {
  readonly schema: ComponentSchema;
  readonly columns = new Map<string, Column>();
  presence: Uint8Array;

  constructor(schema: ComponentSchema, capacity: number) {
    this.schema = cloneSchema(schema);
    this.presence = new Uint8Array(capacity);
    for (const [key, field] of Object.entries(this.schema)) {
      this.columns.set(
        key,
        field.type === "string" || field.type === "json"
          ? new Array<JsonValue>(capacity).fill(field.type === "string" ? "" : null)
          : field.type === "boolean"
            ? new Uint8Array(capacity)
            : new Float64Array(capacity * (field.type === "vec3" ? 3 : 1)),
      );
    }
  }

  grow(capacity: number): void {
    if (capacity <= this.presence.length) return;
    const presence = new Uint8Array(capacity);
    presence.set(this.presence);
    this.presence = presence;
    for (const [key, field] of Object.entries(this.schema)) {
      const previous = this.columns.get(key)!;
      if (Array.isArray(previous)) {
        this.columns.set(key, [
          ...previous,
          ...new Array<JsonValue>(capacity - previous.length).fill(field.type === "string" ? "" : null),
        ]);
      } else {
        const column =
          field.type === "boolean"
            ? new Uint8Array(capacity)
            : new Float64Array(capacity * (field.type === "vec3" ? 3 : 1));
        column.set(previous);
        this.columns.set(key, column);
      }
    }
  }

  write(index: number, data: ComponentData): void {
    for (const [key, value] of Object.entries(data)) {
      const column = this.columns.get(key)!;
      switch (this.schema[key].type) {
        case "json": (column as JsonValue[])[index] = cloneJsonValue(value); break;
        case "vec3":
          (column as Float64Array).set(value as readonly number[], index * 3);
          break;
        case "boolean":
          (column as Uint8Array)[index] = value ? 1 : 0;
          break;
        case "number":
          (column as Float64Array)[index] = value as number;
          break;
        case "string":
          (column as string[])[index] = value as string;
          break;
      }
    }
    this.presence[index] = 1;
  }

  read(index: number): ComponentData {
    return Object.fromEntries(
      Object.entries(this.schema).map(([key, field]) => {
        const column = this.columns.get(key)!;
        const value =
          field.type === "json" ? cloneJsonValue(column[index]) : field.type === "vec3"
            ? Array.from(
                (column as Float64Array).subarray(index * 3, index * 3 + 3),
              )
            : field.type === "boolean"
              ? Boolean(column[index])
              : column[index];
        return [key, value];
      }),
    ) as ComponentData;
  }

  remove(index: number): void {
    this.presence[index] = 0;
    for (const [key, field] of Object.entries(this.schema)) {
      const column = this.columns.get(key)!;
      if (field.type === "vec3")
        (column as Float64Array).fill(0, index * 3, index * 3 + 3);
      else if (field.type === "string" || field.type === "json") (column as JsonValue[])[index] = field.type === "string" ? "" : null;
      else (column as Float64Array | Uint8Array)[index] = 0;
    }
  }

  clone(): ComponentStorage {
    const result = new ComponentStorage(this.schema, this.presence.length);
    result.presence.set(this.presence);
    for (const [key, column] of this.columns)
      result.columns.set(key, this.schema[key].type === "json" ? (column as JsonValue[]).map(value => cloneJsonValue(value)) : column.slice());
    return result;
  }
}
