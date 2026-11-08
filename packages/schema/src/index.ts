import type {
  ComponentDefinition,
  ComponentSchema,
} from "../../sdk/src/index.ts";
export const CONTENT_FORMAT_VERSION = 1 as const;
/** Generate JSON Schema from the exact SDK component declaration, never a parallel hand-maintained model. */
export function componentJSONSchema(
  definition: Pick<ComponentDefinition<ComponentSchema>, "id" | "schema">,
) {
  const properties = Object.fromEntries(
    Object.entries(definition.schema).map(([name, field]) => [
      name,
      field.type === "json" ? { $ref: "#/$defs/JsonValue", default: field.default, "x-pelican-maxDepth": 16, "x-pelican-maxNodes": 8192, "x-pelican-maxBytes": 65536 } : field.type === "vec3"
        ? {
            type: "array",
            items: { type: "number" },
            minItems: 3,
            maxItems: 3,
            default: [...field.default],
          }
        : { type: field.type, default: field.default },
    ]),
  );
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: definition.id,
    type: "object",
    additionalProperties: false,
    required: Object.keys(properties),
    properties,
    ...(Object.values(definition.schema).some(field => field.type === "json") ? { $defs: { JsonValue: { anyOf: [
      { type: ["null", "boolean", "number", "string"] }, { type: "array", items: { $ref: "#/$defs/JsonValue" } },
      { type: "object", additionalProperties: { $ref: "#/$defs/JsonValue" }, propertyNames: { not: { enum: ["__proto__", "constructor", "prototype"] } } },
    ] } } } : {}),
  };
}
