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
      field.type === "vec3"
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
  };
}
