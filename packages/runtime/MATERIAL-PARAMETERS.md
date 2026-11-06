# Material Parameters

`src/material-parameters.ts` exports the CPU-only `createMaterialParameters`
owner and its `MaterialParameterSnapshot` type. It imports the SDK's
`GraphParameter`, `GraphType`, `GraphValue`, `isGraphType` and `graphValue`
contracts; it does not own renderer, compiler, RenderService or Host integration.

```ts
const owner = createMaterialParameters([
  { id: "paint", parameters: [
    { name: "tint", type: "vec3", default: [1, 0.5, 0] },
    { name: "enabled", type: "bool", default: true },
  ] },
  { id: "unparameterized" },
]);
owner.set("paint", "tint", [0, 0.5, 1]);
const current = owner.get("paint");
const saved = owner.snapshot();
owner.validateSnapshot(saved);
owner.restore(saved);
owner.dispose();
```

## Ownership

Material IDs are unique and match `^[a-zA-Z][a-zA-Z0-9_.-]*$`, consistent with
the compiler. Parameter names are unique per material and must contain a
non-whitespace character. All five SDK types (`float`, `vec2`, `vec3`, `vec4`,
`bool`) require matching defaults and values. Numeric components must be finite
and remain finite after `Math.fround`; values are checked, not rounded.

The owner retains only copied declarations and values. `set` copies vectors;
`get` returns a detached frozen record with frozen vectors. Names such as
`constructor`, `toString`, and `__proto__` are ordinary own properties.
Parameterless materials remain known: `get` returns a frozen empty record,
while `set` reports an unknown parameter rather than an unknown material.

`inspect()` returns only detached `{materials, parameters, revision}` counts.
`materials` includes parameterless materials. Revision starts at zero and
increments once per changed set or restore; equal-value operations, reads,
validation, and failed operations do not increment it. `dispose` is idempotent;
every other operation, including inspection, rejects after disposal.

## Snapshots

With any declared parameters, `snapshot()` returns detached, deeply mutable
ordinary JSON objects and arrays:

```json
{
  "version": 1,
  "definitions": [
    { "id": "paint", "parameters": [
      { "name": "enabled", "type": "bool", "default": true },
      { "name": "tint", "type": "vec3", "default": [1, 0.5, 0] }
    ] }
  ],
  "values": { "paint": { "enabled": true, "tint": [0, 0.5, 1] } }
}
```

Definitions are sorted by material ID, then parameter name, using string
comparison rather than locale ordering. Only materials with parameters appear
in either `definitions` or `values`. Values contain exactly those material IDs
and parameter names. Input declaration order does not affect compatibility.
Snapshot descriptor arrays must retain canonical order; object property order
does not matter. Defaults, names and types must match the owner's declarations.

When no material declares parameters, `snapshot()` returns `undefined` and
only `undefined` is valid for validation or restore. Integration must omit the
optional material snapshot in that case to preserve the legacy render-settings
snapshot shape. Owners with parameters always reject `undefined`.

Validation checks every field without modifying the owner or the input.
Extra/missing fields, unsafe object/array prototypes, accessors, symbol or hidden
properties, sparse arrays, incompatible declarations, and invalid values are
rejected. Safe null-prototype records are accepted; output records always have
the ordinary object prototype. Restore stages all detached values before
applying anything, so failure cannot partially change values or revision.

## Errors

Errors have a stable code, `material:parameter` context (`*` where unavailable),
and a `Repair:` hint:

- `TC_RENDER_MATERIAL`: invalid, duplicate, or unknown material ID.
- `TC_RENDER_PARAMETER`: invalid/duplicate declaration or unknown parameter name/type.
- `TC_RENDER_PARAMETER_VALUE`: invalid declaration default or set value.
- `TC_RENDER_PARAMETERS_SNAPSHOT`: any invalid or incompatible snapshot.
- `TC_RENDER_DISPOSED`: operation on a disposed owner.

Run the focused CPU suite with
`node_modules/.bin/tsx --test tests/material-parameters.test.ts`.
