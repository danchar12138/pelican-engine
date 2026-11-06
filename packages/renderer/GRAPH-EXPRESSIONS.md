# Private Typed Graph Expressions

`src/graph-expressions.ts` is an engine-internal expression utility, not a new SDK
entry point. It consumes compiler-owned `GraphIR` and the existing SDK
`GraphNode`, `GraphType`, `GRAPH_INPUT_TYPES`, and `GRAPH_OPERATIONS` contracts.
Compiler validation, renderer integration, resource binding, and public parameter
services remain with their existing owners.

## Typed Builder

```ts
mapTypedGraph<T>(graph: GraphIR, builder: TypedGraphBuilder<T>): T

interface TypedGraphBuilder<T> {
  constant(value: GraphValue, type: GraphType, node: GraphNode): T;
  input(name: GraphInputName | 'time', type: GraphType, node: GraphNode): T;
  parameter(name: string, type: GraphType, defaultValue: GraphValue, node: GraphNode): T;
  texture(asset: string, uv: T, node: GraphNode): T;
  operation(
    node: Extract<GraphNode, { inputs: readonly string[] }>,
    inputs: readonly T[],
    type: GraphType,
    inputTypes: readonly GraphType[],
  ): T;
}
```

The result is the builder value for `graph.output`. An explicit stack visits
output-reachable nodes in dependency-first, input-list order, even when the node
array is not already topological. Each node invokes exactly one callback; shared
dependencies reuse the same builder value, including `undefined` values. There
is no recursion or arbitrary depth limit. Unreachable nodes do not invoke
callbacks. Node indexing, traversal, and memoization take O(V + E) time and space.

The texture callback receives a string; object-valued texture references are
reduced to their `id`, never their path or other properties. Parameter callbacks
receive the validated declaration default. The builder resolves engine-side
parameter bindings itself. The special `time` node uses the input callback;
`time` is not an additional public named-input key.

## CPU Reference

`evaluateTypedGraph(graph, context?)` accepts optional `time`, `parameters`,
`inputs`, and `sampleTexture(asset, uv)` fields. Time defaults to zero. Used named
inputs must be supplied. Used parameters must have declarations and fall back to
their defaults when no own-property override exists. Extra parameter names from
sibling material graphs are ignored, including their values. Wrong used values
are rejected; no scalar/vector coercion occurs at the context boundary.

Constants, defaults, supplied parameters/inputs, and texture samples must match
their declared scalar/bool/vector type. Numeric entry values must be finite and
within the finite f32 range (absolute value at most `3.4028234663852886e38`). They
are not rounded to f32: CPU arithmetic intentionally retains JavaScript f64
intermediates for legacy exact evaluation, including finite intermediate results
above f32 range. Non-finite arithmetic fails at the responsible node. Returned
vectors are fresh detached arrays. Samplers receive detached UV arrays and must
return a finite f32-fit vec4; no implicit texture fallback exists.

Supported operation rules:

| Family                                                        | Contract                                                                                                                                                                 |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| add, subtract                                                 | Equal numeric types only; scalar/vector add remains invalid.                                                                                                             |
| multiply, safeDivide, min, max, step                          | Float/vector broadcast; vector widths must agree. Step arguments are edge, value.                                                                                        |
| sin, cos, abs, floor, ceil, fract, negate, saturate, safeSqrt | Componentwise numeric operations; safeSqrt is sqrt(max(value, 0)).                                                                                                       |
| normalize, length                                             | Normalize requires a vector and scales by its largest absolute component before measuring length; zero yields zero. Length is scalar absolute value or vector magnitude. |
| dot, cross                                                    | Dot requires equal vectors and returns float; cross requires vec3.                                                                                                       |
| mix                                                           | Equal numeric a/b; t is float or the same type.                                                                                                                          |
| clamp, smoothstep                                             | Numeric broadcast to the widest compatible vector, or float.                                                                                                             |
| lessThan, lessEqual, greaterThan, greaterEqual                | Float-only arguments, bool result.                                                                                                                                       |
| equal                                                         | Equal float or bool arguments, bool result.                                                                                                                              |
| and, or, not                                                  | Bool arguments/results.                                                                                                                                                  |
| select                                                        | Inputs are a, b, condition; a/b types agree, condition is bool; false selects a, true selects b.                                                                         |
| compose2/3/4                                                  | Float inputs produce the corresponding vector.                                                                                                                           |
| swizzle                                                       | One to four components from one xyzw or rgba family, bounded by source width; one component returns float.                                                               |

Safe division returns zero independently for each zero divisor component.
Smoothstep computes a clamped safe quotient followed by `t*t*(3-2*t)`; equal
edges deterministically produce zero. These safety semantics are shared by the
CPU reference and private WGSL lowering.

## Private WGSL Lowering

`lowerGraphWGSL(graph, bindings)` returns `{ helpers, code, result, type }`.
The required bindings are `prefix`, `input(name, type)`, `parameter(name, type)`,
and `sampleTexture(asset, uvSymbol)`. All code-returning callbacks are trusted
ENGINE PRIVATE adapters, never SDK fields, user shader text, or a public raw-source
route. Their return values are deliberately not parsed or sanitized as user code.

The prefix must match `[A-Za-z][A-Za-z0-9_]*`. Generated names use only that prefix
and internal counters/type names; user node IDs, parameter names, assets, and paths
are never interpolated into shader code by this module. Swizzles are validated
and canonicalized to xyzw. Constants and temporary variables have explicit WGSL
types (`f32`, `bool`, `vec2f`, `vec3f`, `vec4f`). Prefixes must be unique within
the enclosing engine shader.

Helpers are emitted only when used, once per operation/type in first-use order.
Place `helpers` at shader module scope and `code` inside the consuming function;
`result` names the output local. SafeDivide replaces each zero denominator with
one BEFORE division, then selects zero for that component. It never relies on
an eager `select` to hide a division by zero. SafeNormalize returns early for
zero scale and normalizes the largest-component-scaled vector.

## Errors And Verification

Defensive failures use stable `TC_GRAPH_*:<nodeId>` errors: `IR`, `REF`, `CYCLE`,
`TYPE`, `VALUE`, `CONTEXT`, `OP`, `PREFIX`, and `ARITHMETIC`. Graph-level errors use
`graph` or `parameters` in place of a node ID. Missing-reference errors identify
the missing reference. The compiler remains the primary IR validator.

CPU and exact-emission fixtures are in `tests/graph-expressions.test.ts`. They
cover every SDK operation constant, special nodes, vector widths, typed bindings,
memoization/order, malformed graphs/context, arithmetic safety, generated names,
and a 20,000-operation chain. Run from the isolated worktree:

```powershell
.\node_modules\.bin\tsx.cmd --test tests/graph-expressions.test.ts
.\node_modules\.bin\tsc.cmd --ignoreConfig --noEmit --target ES2023 --module ESNext --moduleResolution Bundler --strict --allowImportingTsExtensions --skipLibCheck --types node packages/renderer/src/graph-expressions.ts tests/graph-expressions.test.ts
```

This work does not execute or validate shaders on a GPU, modify actual shader
integration, or complete CAP17. Full graph resource feedback, deformation,
postprocessing, and cross-mode acceptance remain future/integration work.
