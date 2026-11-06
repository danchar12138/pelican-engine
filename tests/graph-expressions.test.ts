import test from "node:test";
import assert from "node:assert/strict";
import { GRAPH_INPUT_TYPES, GRAPH_OPERATIONS } from "../packages/sdk/src/index.ts";
import type { GraphNode, GraphType, GraphValue, Vec2, Vec4 } from "../packages/sdk/src/index.ts";
import type { GraphIR } from "../packages/compiler/src/types.ts";
import { evaluateTypedGraph, lowerGraphWGSL, mapTypedGraph } from "../packages/renderer/src/graph-expressions.ts";
import type { GraphWGSLBindings, TypedGraphBuilder } from "../packages/renderer/src/graph-expressions.ts";

type Operation = Extract<GraphNode, { inputs: readonly string[] }>["op"];
const valueType = (value: GraphValue): GraphType =>
  typeof value === "boolean" ? "bool" : typeof value === "number" ? "float" : (`vec${value.length}` as GraphType);
const shaderType = (type: GraphType) => (type === "float" ? "f32" : type === "bool" ? "bool" : `${type}f`);
const vec = (values: readonly number[]) => values as Exclude<GraphValue, number | boolean>;
function constant(id: string, value: GraphValue): GraphNode {
  return { id, op: valueType(value), value } as GraphNode;
}
function ir(nodes: GraphNode[], nodeTypes: Record<string, GraphType>, output = nodes[0].id): GraphIR {
  return { nodes, nodeTypes, output, outputType: nodeTypes[output] };
}
function operation(op: Operation, values: GraphValue[], outputType: GraphType, components?: string): GraphIR {
  const nodes = values.map((value, i) => constant(`arg${i}`, value));
  const nodeTypes = Object.fromEntries(values.map((value, i) => [`arg${i}`, valueType(value)]));
  return ir([{ id: "result", op, inputs: nodes.map((n) => n.id), components } as unknown as GraphNode, ...nodes], {
    ...nodeTypes,
    result: outputType,
  });
}
const bindings: GraphWGSLBindings = {
  prefix: "fx",
  input: (name, type) => `engine_${name}_${type}`,
  parameter: (_name, type) => `engine_parameter_${type}`,
  sampleTexture: (_asset, uv) => `engine_sample(${uv})`,
};
function close(actual: GraphValue, expected: GraphValue): void {
  if (typeof expected === "boolean") {
    assert.equal(actual, expected);
    return;
  }
  const a = typeof actual === "number" ? [actual] : (actual as readonly number[]);
  const b = typeof expected === "number" ? [expected] : expected;
  assert.equal(a.length, b.length);
  b.forEach((n, i) => assert.ok(Math.abs(a[i] - n) <= 1e-14 * Math.max(1, Math.abs(n)), `${a[i]} != ${n}`));
}
interface Fixture {
  op: Operation;
  args: GraphValue[];
  type: GraphType;
  expected: GraphValue;
  expression: string;
  components?: string;
  before?: string;
}
const fixtures: Fixture[] = [
  { op: "sin", args: [0.5], type: "float", expected: Math.sin(0.5), expression: "sin(fx_g0)" },
  { op: "cos", args: [0.5], type: "float", expected: Math.cos(0.5), expression: "cos(fx_g0)" },
  { op: "abs", args: [-2], type: "float", expected: 2, expression: "abs(fx_g0)" },
  { op: "floor", args: [-1.2], type: "float", expected: -2, expression: "floor(fx_g0)" },
  { op: "ceil", args: [-1.2], type: "float", expected: -1, expression: "ceil(fx_g0)" },
  { op: "fract", args: [-1.2], type: "float", expected: 0.8, expression: "fract(fx_g0)" },
  { op: "negate", args: [-2], type: "float", expected: 2, expression: "(-fx_g0)" },
  { op: "saturate", args: [2], type: "float", expected: 1, expression: "clamp(fx_g0, f32(0.0), f32(1.0))" },
  { op: "safeSqrt", args: [-2], type: "float", expected: 0, expression: "sqrt(max(fx_g0, f32(0.0)))" },
  { op: "normalize", args: [[3, 0, 4]], type: "vec3", expected: [0.6, 0, 0.8], expression: "fx_safeNormalize_vec3(fx_g0)" },
  { op: "length", args: [-3], type: "float", expected: 3, expression: "abs(fx_g0)" },
  { op: "add", args: [2, 4], type: "float", expected: 6, expression: "(fx_g0 + fx_g1)" },
  { op: "subtract", args: [2, 4], type: "float", expected: -2, expression: "(fx_g0 - fx_g1)" },
  { op: "multiply", args: [2, [3, 4]], type: "vec2", expected: [6, 8], expression: "(vec2f(fx_g0) * fx_g1)" },
  { op: "safeDivide", args: [[4, 8], 2], type: "vec2", expected: [2, 4], expression: "fx_safeDivide_vec2(fx_g0, vec2f(fx_g1))" },
  { op: "min", args: [2, [3, 1]], type: "vec2", expected: [2, 1], expression: "min(vec2f(fx_g0), fx_g1)" },
  { op: "max", args: [[3, 1], 2], type: "vec2", expected: [3, 2], expression: "max(fx_g0, vec2f(fx_g1))" },
  {
    op: "dot",
    args: [
      [1, 2],
      [3, 4],
    ],
    type: "float",
    expected: 11,
    expression: "dot(fx_g0, fx_g1)",
  },
  {
    op: "cross",
    args: [
      [1, 0, 0],
      [0, 1, 0],
    ],
    type: "vec3",
    expected: [0, 0, 1],
    expression: "cross(fx_g0, fx_g1)",
  },
  { op: "step", args: [2, [1, 2, 3]], type: "vec3", expected: [0, 1, 1], expression: "step(vec3f(fx_g0), fx_g1)" },
  { op: "lessThan", args: [2, 4], type: "bool", expected: true, expression: "(fx_g0 < fx_g1)" },
  { op: "lessEqual", args: [2, 2], type: "bool", expected: true, expression: "(fx_g0 <= fx_g1)" },
  { op: "greaterThan", args: [2, 4], type: "bool", expected: false, expression: "(fx_g0 > fx_g1)" },
  { op: "greaterEqual", args: [2, 2], type: "bool", expected: true, expression: "(fx_g0 >= fx_g1)" },
  { op: "equal", args: [true, false], type: "bool", expected: false, expression: "(fx_g0 == fx_g1)" },
  { op: "and", args: [true, false], type: "bool", expected: false, expression: "(fx_g0 && fx_g1)" },
  { op: "or", args: [true, false], type: "bool", expected: true, expression: "(fx_g0 || fx_g1)" },
  { op: "not", args: [true], type: "bool", expected: false, expression: "(!fx_g0)" },
  { op: "mix", args: [[0, 4], [4, 8], 0.25], type: "vec2", expected: [1, 5], expression: "mix(fx_g0, fx_g1, vec2f(fx_g2))" },
  { op: "clamp", args: [[0, 4], 1, 3], type: "vec2", expected: [1, 3], expression: "clamp(fx_g0, vec2f(fx_g1), vec2f(fx_g2))" },
  {
    op: "smoothstep",
    args: [0, 2, 1],
    type: "float",
    expected: 0.5,
    before: "let fx_g3: f32 = clamp(fx_safeDivide_float(fx_g2 - fx_g0, fx_g1 - fx_g0), f32(0.0), f32(1.0));",
    expression: "(fx_g3 * fx_g3 * (f32(3.0) - f32(2.0) * fx_g3))",
  },
  { op: "select", args: [[1, 2], [3, 4], true], type: "vec2", expected: [3, 4], expression: "select(fx_g0, fx_g1, fx_g2)" },
  { op: "compose2", args: [1, 2], type: "vec2", expected: [1, 2], expression: "vec2f(fx_g0, fx_g1)" },
  { op: "compose3", args: [1, 2, 3], type: "vec3", expected: [1, 2, 3], expression: "vec3f(fx_g0, fx_g1, fx_g2)" },
  { op: "compose4", args: [1, 2, 3, 4], type: "vec4", expected: [1, 2, 3, 4], expression: "vec4f(fx_g0, fx_g1, fx_g2, fx_g3)" },
  { op: "swizzle", args: [[1, 2, 3, 4]], components: "bgra", type: "vec4", expected: [3, 2, 1, 4], expression: "fx_g0.zyxw" },
];
function fixtureLiteral(value: GraphValue): string {
  const number = (v: number) => (Number.isInteger(v) ? `${v}.0` : String(v));
  return typeof value === "boolean"
    ? String(value)
    : typeof value === "number"
      ? number(value)
      : `${shaderType(valueType(value))}(${value.map(number).join(", ")})`;
}
for (const f of fixtures) {
  test(`${f.op}: CPU reference and exact typed WGSL fixture`, () => {
    const graph = operation(f.op, f.args, f.type, f.components);
    close(evaluateTypedGraph(graph), f.expected);
    const lowered = lowerGraphWGSL(graph, bindings);
    const lines = f.args.map((arg, i) => `let fx_g${i}: ${shaderType(valueType(arg))} = ${fixtureLiteral(arg)};`);
    if (f.before) lines.push(f.before);
    const symbol = `fx_g${lines.length}`;
    lines.push(`let ${symbol}: ${shaderType(f.type)} = ${f.expression};`);
    assert.equal(lowered.code, lines.join("\n"));
    assert.equal(lowered.result, symbol);
    assert.equal(lowered.type, f.type);
    if (!["safeDivide", "normalize", "smoothstep"].includes(f.op)) assert.equal(lowered.helpers, "");
  });
}
test("fixture coverage tracks every SDK operation constant", () => {
  const covered = new Set(fixtures.map((f) => f.op));
  for (const op of [...GRAPH_OPERATIONS.unary, ...GRAPH_OPERATIONS.binary, ...GRAPH_OPERATIONS.ternary]) assert.ok(covered.has(op), op);
});

test("all typed constants have exact WGSL and detached vector results", () => {
  for (const value of [1.25, true, [1, 2], [1, 2, 3], [1, 2, 3, 4]] as GraphValue[]) {
    const type = valueType(value),
      graph = ir([constant("untrusted id ; /*", value)], { "untrusted id ; /*": type });
    const actual = evaluateTypedGraph(graph);
    assert.deepEqual(actual, value);
    if (Array.isArray(value)) assert.notEqual(actual, value);
    assert.deepEqual(lowerGraphWGSL(graph, bindings), {
      helpers: "",
      code: `let fx_g0: ${shaderType(type)} = ${fixtureLiteral(value)};`,
      result: "fx_g0",
      type,
    });
  }
  for (const [value, literal] of [
    [-0, "-0.0"],
    [1e-20, "1e-20"],
    [1e30, "1e+30"],
  ] as const) {
    assert.equal(lowerGraphWGSL(ir([constant("n", value)], { n: "float" }), bindings).code, `let fx_g0: f32 = ${literal};`);
  }
});

const componentFunctions = {
  sin: Math.sin,
  cos: Math.cos,
  abs: Math.abs,
  floor: Math.floor,
  ceil: Math.ceil,
  fract: (x: number) => x - Math.floor(x),
  negate: (x: number) => -x,
  saturate: (x: number) => Math.min(1, Math.max(0, x)),
  safeSqrt: (x: number) => Math.sqrt(Math.max(0, x)),
};
for (const width of [2, 3, 4] as const) {
  const type = `vec${width}` as GraphType;
  test(`${type} componentwise unary operations`, () => {
    const arg = vec([-1.25, 0.5, 2, 4].slice(0, width));
    for (const [op, fn] of Object.entries(componentFunctions)) {
      const graph = operation(op as Operation, [arg], type);
      close(evaluateTypedGraph(graph), vec(arg.map(fn)));
      assert.equal(lowerGraphWGSL(graph, bindings).type, type);
    }
  });
  test(`${type} binary and ternary broadcast in every scalar position`, () => {
    const vector = vec(Array.from({ length: width }, (_, i) => i + 1));
    for (const op of ["multiply", "safeDivide", "min", "max", "step"] as const) {
      for (const args of [
        [vector, 2],
        [2, vector],
        [vector, vector],
      ] as GraphValue[][]) {
        const scalar = (x: number, y: number) =>
          op === "multiply"
            ? x * y
            : op === "safeDivide"
              ? x / y
              : op === "min"
                ? Math.min(x, y)
                : op === "max"
                  ? Math.max(x, y)
                  : y < x
                    ? 0
                    : 1;
        const expected = Array.from({ length: width }, (_, i) =>
          scalar(
            typeof args[0] === "number" ? args[0] : (args[0] as readonly number[])[i],
            typeof args[1] === "number" ? args[1] : (args[1] as readonly number[])[i],
          ),
        );
        const graph = operation(op, args, type);
        close(evaluateTypedGraph(graph), expected as unknown as GraphValue);
        assert.equal(lowerGraphWGSL(graph, bindings).type, type);
      }
    }
    for (const op of ["clamp", "smoothstep"] as const) {
      for (const args of [
        [vector, 0, 4],
        [0, vector, 0.5],
        [0, 4, vector],
      ] as GraphValue[][]) {
        const scalar = (a: number, b: number, c: number) => {
          if (op === "clamp") return Math.min(Math.max(a, b), c);
          const t = Math.min(1, Math.max(0, (c - a) / (b - a)));
          return t * t * (3 - 2 * t);
        };
        const expected = Array.from({ length: width }, (_, i) =>
          scalar(...(args.map((v) => (typeof v === "number" ? v : (v as readonly number[])[i])) as [number, number, number])),
        );
        const graph = operation(op, args, type);
        close(evaluateTypedGraph(graph), expected as unknown as GraphValue);
        assert.equal(lowerGraphWGSL(graph, bindings).type, type);
      }
    }
    for (const op of ["add", "subtract", "mix"] as const) {
      const graph = operation(op, op === "mix" ? [vector, vector, vector] : [vector, vector], type);
      close(
        evaluateTypedGraph(graph),
        op === "subtract" ? vec(Array(width).fill(0)) : op === "add" ? vec(vector.map((n) => n * 2)) : vector,
      );
      assert.equal(lowerGraphWGSL(graph, bindings).type, type);
    }
  });
  test(`${type} normalize, length, dot, zero divide and helper safety`, () => {
    const vector = vec(Array(width).fill(3e38));
    const graph = operation("normalize", [vector], type);
    close(evaluateTypedGraph(graph), vec(Array(width).fill(1 / Math.sqrt(width))));
    close(evaluateTypedGraph(operation("normalize", [vec(Array(width).fill(0))], type)), vec(Array(width).fill(0)));
    close(evaluateTypedGraph(operation("normalize", [vec(Array(width).fill(1e-40))], type)), vec(Array(width).fill(1 / Math.sqrt(width))));
    close(evaluateTypedGraph(operation("length", [vector], "float")), Math.hypot(...vector));
    close(evaluateTypedGraph(operation("dot", [vec(Array(width).fill(2)), vec(Array(width).fill(3))], "float")), width * 6);
    const divisors = vec(Array.from({ length: width }, (_, i) => (i % 2 === 0 ? 0 : 2)));
    close(evaluateTypedGraph(operation("safeDivide", [vector, divisors], type)), vec(divisors.map((v) => (v === 0 ? 0 : 1.5e38))));
    const divide = lowerGraphWGSL(operation("safeDivide", [vector, divisors], type), bindings);
    assert.equal(
      divide.helpers,
      `fn fx_safeDivide_${type}(a: ${type}f, b: ${type}f) -> ${type}f {\n  let zero = b == ${type}f(0.0);\n  let denominator = select(b, ${type}f(1.0), zero);\n  return select(a / denominator, ${type}f(0.0), zero);\n}`,
    );
    assert.doesNotMatch(divide.helpers, /a \/ b/);
    const maximum = ["x", "y", "z", "w"]
      .slice(0, width)
      .map((axis) => `abs(v.${axis})`)
      .reduce((a, b) => `max(${a}, ${b})`);
    assert.equal(
      lowerGraphWGSL(graph, bindings).helpers,
      `fn fx_safeNormalize_${type}(v: ${type}f) -> ${type}f {\n  let scale = ${maximum};\n  if (scale == 0.0) { return ${type}f(0.0); }\n  let scaled = v / scale;\n  return scaled / length(scaled);\n}`,
    );
  });
}

test("scalar safeDivide and degenerate smoothstep are deterministic without zero division", () => {
  assert.equal(evaluateTypedGraph(operation("safeDivide", [4, 0], "float")), 0);
  assert.equal(evaluateTypedGraph(operation("safeDivide", [4, -0], "float")), 0);
  assert.equal(evaluateTypedGraph(operation("smoothstep", [1, 1, 2], "float")), 0);
  const lowered = lowerGraphWGSL(operation("safeDivide", [4, 0], "float"), bindings);
  assert.equal(
    lowered.helpers,
    "fn fx_safeDivide_float(a: f32, b: f32) -> f32 {\n  let zero = b == f32(0.0);\n  let denominator = select(b, f32(1.0), zero);\n  return select(a / denominator, f32(0.0), zero);\n}",
  );
});

test("swizzle derives scalar and repeated vector widths, canonicalizes rgba, rejects injection", () => {
  for (const [components, type, expected] of [
    ["r", "float", 1],
    ["yy", "vec2", [2, 2]],
    ["bgr", "vec3", [3, 2, 1]],
    ["xxxx", "vec4", [1, 1, 1, 1]],
  ] as const) {
    const graph = operation("swizzle", [[1, 2, 3, 4]], type, components);
    assert.deepEqual(evaluateTypedGraph(graph), expected);
    assert.equal(lowerGraphWGSL(graph, bindings).type, type);
  }
  for (const mask of ["", "xr", "q", "xyzwx", "x;discard;", "z"]) {
    const graph = operation("swizzle", [[1, 2]], "float", mask);
    assert.throws(() => evaluateTypedGraph(graph), /^Error: TC_GRAPH_TYPE:result$/);
    assert.throws(() => lowerGraphWGSL(graph, bindings), /^Error: TC_GRAPH_TYPE:result$/);
  }
});

test("all SDK named inputs and time use typed private bindings and strict context", () => {
  const values = {
    uv: [0.2, 0.4],
    uv1: [0.1, 0.9],
    positionWorld: [1, 2, 3],
    normalWorld: [0, 1, 0],
    viewDirectionWorld: [0, 0, 1],
    vertexColor: [1, 0.5, 0.25, 1],
    index: 7,
    screenSize: [640, 360],
    texelSize: [1 / 640, 1 / 360],
    pixelCoord: [2, 1],
    outputSize: [4, 3],
    positionLocal: [1, 2, 3],
    normalLocal: [0, 1, 0],
    vertexIndex: 2,
    instanceIndex: 1,
  } as const;
  for (const name of Object.keys(GRAPH_INPUT_TYPES) as (keyof typeof GRAPH_INPUT_TYPES)[]) {
    const type = GRAPH_INPUT_TYPES[name],
      graph = ir([{ id: "n", op: "input", name }], { n: type });
    assert.deepEqual(evaluateTypedGraph(graph, { inputs: { [name]: values[name] } }), values[name]);
    assert.throws(() => evaluateTypedGraph(graph), /^Error: TC_GRAPH_CONTEXT:n$/);
    assert.throws(() => evaluateTypedGraph(graph, { inputs: { [name]: false } }), /^Error: TC_GRAPH_VALUE:n$/);
    assert.equal(lowerGraphWGSL(graph, bindings).code, `let fx_g0: ${shaderType(type)} = engine_${name}_${type};`);
  }
  const time = ir([{ id: "clock", op: "time" }], { clock: "float" });
  assert.equal(evaluateTypedGraph(time), 0);
  assert.equal(evaluateTypedGraph(time, { time: 0.1 }), 0.1);
  assert.equal(lowerGraphWGSL(time, bindings).code, "let fx_g0: f32 = engine_time_float;");
  assert.throws(() => evaluateTypedGraph(time, { time: Infinity }), /^Error: TC_GRAPH_VALUE:clock$/);
});

test("parameters use defaults, ignore extra sibling names, reject wrong used types, detach vectors", () => {
  for (const value of [2, false, [1, 2], [1, 2, 3], [1, 2, 3, 4]] as GraphValue[]) {
    const type = valueType(value),
      graph = ir([{ id: "p", op: "parameter", name: "gain" }], { p: type });
    graph.parameters = [{ name: "gain", type, default: value }];
    const actual = evaluateTypedGraph(graph, { parameters: { sibling: NaN } });
    assert.deepEqual(actual, value);
    if (Array.isArray(value)) assert.notEqual(actual, value);
    assert.deepEqual(evaluateTypedGraph(graph, { parameters: { gain: value, sibling: false } }), value);
    assert.throws(() => evaluateTypedGraph(graph, { parameters: { gain: type === "bool" ? 3 : true } }), /^Error: TC_GRAPH_VALUE:p$/);
    assert.equal(lowerGraphWGSL(graph, bindings).code, `let fx_g0: ${shaderType(type)} = engine_parameter_${type};`);
  }
  const graph = ir([{ id: "p", op: "parameter", name: "gain" }], { p: "float" });
  graph.parameters = [{ name: "gain", type: "float", default: 2 }];
  assert.equal(evaluateTypedGraph(graph, { parameters: { gain: 5 } }), 5);
  graph.parameters = [];
  assert.throws(() => evaluateTypedGraph(graph, { parameters: { gain: 5 } }), /^Error: TC_GRAPH_CONTEXT:p$/);
});

test("texture asset objects normalize to id only; detached UV and sample; callback required", () => {
  const uv: Vec2 = [0.25, 0.75],
    sample: Vec4 = [1, 0.5, 0.25, 1];
  for (const texture of ["tex", { id: "tex", path: "NEVER_EMIT", type: "texture", kind: "asset" }] as const) {
    const graph = ir([{ id: "sample", op: "sampleTexture", texture, inputs: ["uv"] } as GraphNode, constant("uv", uv)], {
      sample: "vec4",
      uv: "vec2",
    });
    let calls = 0;
    const result = evaluateTypedGraph(graph, {
      sampleTexture: (asset, coords) => {
        assert.equal(asset, "tex");
        assert.deepEqual(coords, uv);
        assert.notEqual(coords, uv);
        calls++;
        return sample;
      },
    });
    assert.equal(calls, 1);
    assert.deepEqual(result, sample);
    assert.notEqual(result, sample);
    assert.throws(() => evaluateTypedGraph(graph), /^Error: TC_GRAPH_CONTEXT:sample$/);
    assert.throws(() => evaluateTypedGraph(graph, { sampleTexture: () => [1, NaN, 0, 1] }), /^Error: TC_GRAPH_VALUE:sample$/);
    const lowered = lowerGraphWGSL(graph, {
      ...bindings,
      sampleTexture: (asset, symbol) => {
        assert.equal(asset, "tex");
        return `engine_sample(${symbol})`;
      },
    });
    assert.equal(lowered.code, "let fx_g0: vec2f = vec2f(0.25, 0.75);\nlet fx_g1: vec4f = engine_sample(fx_g0);");
    assert.doesNotMatch(lowered.code, /tex|NEVER_EMIT/);
  }
});

test("iterative traversal preserves dependency order, shared identity, callback types and unreachable pruning", () => {
  const graph = ir(
    [
      { id: "out", op: "add", inputs: ["left", "right"] },
      { id: "right", op: "multiply", inputs: ["shared", "shared"] },
      { id: "left", op: "sin", inputs: ["shared"] },
      constant("shared", 0.5),
      { id: "unused", op: "input", name: "uv" },
    ],
    { out: "float", right: "float", left: "float", shared: "float", unused: "vec2" },
  );
  const order: string[] = [];
  type Token = { id: string };
  const builder: TypedGraphBuilder<Token> = {
    constant: (value, type, node) => {
      assert.equal(value, 0.5);
      assert.equal(type, "float");
      order.push(node.id);
      return { id: node.id };
    },
    input: () => assert.fail("unreachable"),
    parameter: () => assert.fail("unexpected"),
    texture: () => assert.fail("unexpected"),
    operation: (node, args, type, inputTypes) => {
      assert.equal(type, "float");
      assert.deepEqual(
        inputTypes,
        args.map(() => "float"),
      );
      if (node.id === "right") assert.equal(args[0], args[1]);
      order.push(node.id);
      return { id: node.id };
    },
  };
  assert.deepEqual(mapTypedGraph(graph, builder), { id: "out" });
  assert.deepEqual(order, ["shared", "left", "right", "out"]);
  assert.equal(evaluateTypedGraph(graph), Math.sin(0.5) + 0.5 * 0.5);
  assert.equal(
    lowerGraphWGSL(graph, bindings).code,
    "let fx_g0: f32 = 0.5;\nlet fx_g1: f32 = sin(fx_g0);\nlet fx_g2: f32 = (fx_g0 * fx_g0);\nlet fx_g3: f32 = (fx_g1 + fx_g2);",
  );
});

test("private builder parameters, texture and input callbacks expose typed metadata", () => {
  const graph = ir(
    [
      { id: "out", op: "sampleTexture", inputs: ["uv"], texture: "asset" },
      { id: "uv", op: "parameter", name: "coords" },
    ],
    { out: "vec4", uv: "vec2" },
  );
  graph.parameters = [{ name: "coords", type: "vec2", default: [0.5, 0.25] }];
  const builder: TypedGraphBuilder<string> = {
    constant: () => assert.fail("unexpected"),
    input: () => assert.fail("unexpected"),
    operation: () => assert.fail("unexpected"),
    parameter: (name, type, value, node) => {
      assert.deepEqual([name, type, value, node.id], ["coords", "vec2", [0.5, 0.25], "uv"]);
      return "uv-token";
    },
    texture: (asset, uv, node) => {
      assert.deepEqual([asset, uv, node.id], ["asset", "uv-token", "out"]);
      return "texture-token";
    },
  };
  assert.equal(mapTypedGraph(graph, builder), "texture-token");
});

test("very deep graphs avoid recursive overflow without a fixed depth cap", () => {
  const nodes: GraphNode[] = [constant("n0", 1)],
    nodeTypes: Record<string, GraphType> = { n0: "float" };
  for (let i = 1; i <= 20000; i++) {
    nodes.push({ id: `n${i}`, op: "negate", inputs: [`n${i - 1}`] });
    nodeTypes[`n${i}`] = "float";
  }
  const graph = ir(nodes, nodeTypes, "n20000");
  assert.equal(evaluateTypedGraph(graph), 1);
  const lowered = lowerGraphWGSL(graph, bindings);
  assert.equal(lowered.result, "fx_g20000");
  assert.equal(lowered.code.split("\n").length, 20001);
});

test("f64 intermediates preserve exact legacy evaluation, allow finite values above f32 range", () => {
  const graph = ir(
    [
      { id: "out", op: "add", inputs: ["sin", "product"] },
      { id: "sin", op: "sin", inputs: ["t"] },
      { id: "product", op: "multiply", inputs: ["t", "x"] },
      { id: "t", op: "time" },
      constant("x", 0.1),
    ],
    { out: "float", sin: "float", product: "float", t: "float", x: "float" },
  );
  assert.equal(evaluateTypedGraph(graph, { time: 0.2 }), Math.sin(0.2) + 0.2 * 0.1);
  assert.notEqual(evaluateTypedGraph(graph, { time: 0.2 }), Math.fround(Math.sin(Math.fround(0.2)) + Math.fround(0.2) * Math.fround(0.1)));
  assert.equal(evaluateTypedGraph(operation("multiply", [3e38, 3e38], "float")), 3e38 * 3e38);
});

test("nonfinite arithmetic reports the offending node instead of returning NaN/Infinity", () => {
  const graph = ir([constant("x", 3e38)], { x: "float" });
  let previous = "x";
  for (let i = 0; i < 4; i++) {
    const id = `square${i}`;
    graph.nodes = [...graph.nodes, { id, op: "multiply", inputs: [previous, previous] }];
    graph.nodeTypes[id] = "float";
    previous = id;
  }
  graph.output = previous;
  graph.outputType = "float";
  assert.throws(() => evaluateTypedGraph(graph), /^Error: TC_GRAPH_ARITHMETIC:square3$/);
});

test("malformed IR produces stable errors, never an implicit multiply fallback", () => {
  const cases: [GraphIR, string][] = [
    [ir([{ id: "n", op: "sin", inputs: ["missing"] }], { n: "float" }), "REF:missing"],
    [ir([{ id: "n", op: "sin", inputs: ["n"] }], { n: "float" }), "CYCLE:n"],
    [ir([constant("n", 1)], {}), "TYPE:n"],
    [ir([constant("n", 1)], { n: "vec2" }), "TYPE:n"],
    [ir([constant("n", 1), constant("n", 2)], { n: "float" }), "IR:n"],
    [ir([{ id: "n", op: "bad", inputs: [] } as unknown as GraphNode], { n: "float" }), "OP:n"],
    [ir([{ id: "n", op: "sin", inputs: [] } as unknown as GraphNode], { n: "float" }), "TYPE:n"],
    [ir([{ id: "n", op: "sin", inputs: null } as unknown as GraphNode], { n: "float" }), "REF:n"],
    [ir([{ id: "n", op: "input", name: "rawSource" } as unknown as GraphNode], { n: "float" }), "CONTEXT:n"],
    [ir([{ id: "n", op: "parameter", name: "missing" }], { n: "float" }), "CONTEXT:n"],
    [ir([constant("n", 1)], { n: "float" }, "missing"), "REF:missing"],
    [{ ...ir([constant("n", 1)], { n: "float" }), outputType: "vec2" }, "TYPE:n"],
  ];
  for (const [graph, error] of cases) {
    assert.throws(() => evaluateTypedGraph(graph), { message: `TC_GRAPH_${error}` });
    assert.throws(() => lowerGraphWGSL(graph, bindings), { message: `TC_GRAPH_${error}` });
  }
});

test("operation type constraints reject illegal scalar/vector, bool and width combinations", () => {
  const cases: [Operation, GraphValue[], GraphType][] = [
    ["add", [1, [1, 2, 3]], "vec3"],
    ["subtract", [[1, 2], 1], "vec2"],
    [
      "multiply",
      [
        [1, 2],
        [1, 2, 3],
      ],
      "vec3",
    ],
    ["safeDivide", [true, 1], "float"],
    [
      "min",
      [
        [1, 2],
        [1, 2, 3],
      ],
      "vec3",
    ],
    ["max", [false, true], "bool"],
    ["normalize", [1], "float"],
    ["length", [false], "float"],
    ["sin", [true], "bool"],
    [
      "dot",
      [
        [1, 2],
        [1, 2, 3],
      ],
      "float",
    ],
    ["dot", [1, 2], "float"],
    [
      "cross",
      [
        [1, 2],
        [1, 2],
      ],
      "vec2",
    ],
    ["step", [true, 2], "float"],
    ["mix", [1, [1, 2], 0.5], "vec2"],
    [
      "mix",
      [
        [1, 2],
        [3, 4],
        [1, 2, 3],
      ],
      "vec2",
    ],
    ["clamp", [[1, 2], [1, 2, 3], 0], "vec3"],
    ["smoothstep", [true, 1, 2], "float"],
    [
      "lessThan",
      [
        [1, 2],
        [3, 4],
      ],
      "bool",
    ],
    ["lessEqual", [true, false], "bool"],
    ["greaterThan", [true, false], "bool"],
    [
      "greaterEqual",
      [
        [1, 2],
        [3, 4],
      ],
      "bool",
    ],
    [
      "equal",
      [
        [1, 2],
        [1, 2],
      ],
      "bool",
    ],
    ["equal", [true, 1], "bool"],
    ["and", [1, 2], "bool"],
    ["or", [true, 2], "bool"],
    ["not", [1], "bool"],
    ["select", [1, true, false], "float"],
    ["select", [1, 2, 1], "float"],
    ["compose2", [1, true], "vec2"],
    ["compose3", [1, [1, 2], 3], "vec3"],
    ["compose4", [1, 2, 3, false], "vec4"],
  ];
  for (const [op, args, type] of cases) {
    const graph = operation(op, args, type);
    assert.throws(() => evaluateTypedGraph(graph), { message: "TC_GRAPH_TYPE:result" }, op);
    assert.throws(() => lowerGraphWGSL(graph, bindings), { message: "TC_GRAPH_TYPE:result" }, op);
  }
});

test("finite f32-fit boundary applies to constants, parameters, and named inputs", () => {
  for (const bad of [NaN, Infinity, -Infinity, Number.MAX_VALUE, 3.4028236e38]) {
    const graph = ir([constant("n", bad)], { n: "float" });
    assert.throws(() => evaluateTypedGraph(graph), { message: "TC_GRAPH_VALUE:n" });
    assert.throws(() => lowerGraphWGSL(graph, bindings), { message: "TC_GRAPH_VALUE:n" });
    const parameter = ir([{ id: "p", op: "parameter", name: "gain" }], { p: "float" });
    parameter.parameters = [{ name: "gain", type: "float", default: 0 }];
    assert.throws(() => evaluateTypedGraph(parameter, { parameters: { gain: bad } }), { message: "TC_GRAPH_VALUE:p" });
    const input = ir([{ id: "i", op: "input", name: "index" }], { i: "float" });
    assert.throws(() => evaluateTypedGraph(input, { inputs: { index: bad } }), { message: "TC_GRAPH_VALUE:i" });
  }
  for (const bad of [[1, NaN], [1], [1, 2, 3], new Array(2)]) {
    assert.throws(() => evaluateTypedGraph(ir([{ id: "n", op: "vec2", value: bad } as unknown as GraphNode], { n: "vec2" })), {
      message: "TC_GRAPH_VALUE:n",
    });
  }
  assert.equal(evaluateTypedGraph(ir([constant("n", 3.4028234663852886e38)], { n: "float" })), 3.4028234663852886e38);
  assert.equal(evaluateTypedGraph(ir([constant("n", 3.4028235e38)], { n: "float" })), 3.4028235e38);
  assert.throws(() => evaluateTypedGraph(ir([constant("n", 1)], { n: "float" }), null as never), { message: "TC_GRAPH_CONTEXT:graph" });
});

test("select supports all value types and false means a, true means b", () => {
  for (const [a, b] of [
    [1, 2],
    [false, true],
    [
      [1, 2],
      [3, 4],
    ],
    [
      [1, 2, 3],
      [3, 4, 5],
    ],
    [
      [1, 2, 3, 4],
      [3, 4, 5, 6],
    ],
  ] as GraphValue[][]) {
    for (const condition of [false, true]) {
      const graph = operation("select", [a, b, condition], valueType(a));
      assert.deepEqual(evaluateTypedGraph(graph), condition ? b : a);
      assert.match(lowerGraphWGSL(graph, bindings).code, /select\(fx_g0, fx_g1, fx_g2\);$/);
    }
  }
  assert.equal(evaluateTypedGraph(operation("equal", [2, 2], "bool")), true);
});

test("symbols exclude user text; prefixes and absent/empty binding callbacks fail stably", () => {
  const graph = ir([{ id: "node;bad", op: "input", name: "uv" }], { "node;bad": "vec2" });
  for (const prefix of ["", "_bad", "__bad", "1bad", "x;bad", "x-y", "x\ny"]) {
    assert.throws(() => lowerGraphWGSL(graph, { ...bindings, prefix }), { message: "TC_GRAPH_PREFIX:graph" });
  }
  assert.equal(lowerGraphWGSL(graph, { ...bindings, prefix: "fn" }).result, "fn_g0");
  for (const input of [undefined, () => "", () => "   "]) {
    assert.throws(() => lowerGraphWGSL(graph, { ...bindings, input } as GraphWGSLBindings), { message: "TC_GRAPH_CONTEXT:node;bad" });
  }
  assert.doesNotMatch(lowerGraphWGSL(graph, bindings).code, /node;bad/);
});

test("safe helpers are emitted once per type in first-use order", () => {
  const graph = ir(
    [
      { id: "out", op: "add", inputs: ["d1", "d2"] },
      { id: "d1", op: "safeDivide", inputs: ["n", "v"] },
      { id: "d2", op: "safeDivide", inputs: ["n", "v"] },
      { id: "n", op: "normalize", inputs: ["v"] },
      constant("v", [3, 4]),
    ],
    { out: "vec2", d1: "vec2", d2: "vec2", n: "vec2", v: "vec2" },
  );
  const lowered = lowerGraphWGSL(graph, bindings);
  assert.equal((lowered.helpers.match(/fn fx_safeDivide_vec2/g) ?? []).length, 1);
  assert.equal((lowered.helpers.match(/fn fx_safeNormalize_vec2/g) ?? []).length, 1);
  assert.ok(lowered.helpers.indexOf("fn fx_safeNormalize_vec2") < lowered.helpers.indexOf("fn fx_safeDivide_vec2"));
  assert.equal(lowered.code.split("\n").length, 5);
});

test("malformed context records and an input named time are rejected", () => {
  const graph = ir([{ id: "t", op: "time" }], { t: "float" });
  assert.throws(() => evaluateTypedGraph(graph, [] as never), { message: "TC_GRAPH_CONTEXT:graph" });
  assert.throws(() => evaluateTypedGraph(graph, { time: null } as never), { message: "TC_GRAPH_VALUE:t" });
  for (const context of [{ parameters: 3 }, { parameters: null }, { parameters: [] }, { inputs: 3 }, { inputs: null }, { inputs: [] }]) {
    assert.throws(() => evaluateTypedGraph(graph, context as never), { message: "TC_GRAPH_CONTEXT:graph" });
  }
  const input = ir([{ id: "n", op: "input", name: "time" } as unknown as GraphNode], { n: "float" });
  assert.throws(() => evaluateTypedGraph(input), { message: "TC_GRAPH_CONTEXT:n" });
  assert.throws(() => lowerGraphWGSL(input, bindings), { message: "TC_GRAPH_CONTEXT:n" });
});

test("malformed declarations, sample UVs, and asset references fail stably", () => {
  const graph = ir([{ id: "p", op: "parameter", name: "gain" }], { p: "float" });
  assert.throws(() => evaluateTypedGraph({ ...graph, parameters: new Array(2) }), { message: "TC_GRAPH_IR:parameters" });
  for (const declarations of [
    3,
    [null],
    [{ name: 3 }],
    null,
    [
      { name: "gain", type: "float", default: 1 },
      { name: "gain", type: "float", default: 2 },
    ],
  ]) {
    assert.throws(() => evaluateTypedGraph({ ...graph, parameters: declarations } as never), { message: "TC_GRAPH_IR:parameters" });
  }
  graph.parameters = [{ name: "gain", type: "float", default: Infinity }];
  assert.throws(() => evaluateTypedGraph(graph), { message: "TC_GRAPH_VALUE:p" });
  assert.throws(() => lowerGraphWGSL(graph, bindings), { message: "TC_GRAPH_VALUE:p" });
  const sample = ir([{ id: "s", op: "sampleTexture", texture: "tex", inputs: ["uv"] }, constant("uv", 1)], { s: "vec4", uv: "float" });
  assert.throws(() => evaluateTypedGraph(sample), { message: "TC_GRAPH_TYPE:s" });
  for (const texture of ["", null, {}]) {
    const bad = ir([{ id: "s", op: "sampleTexture", texture, inputs: ["uv"] } as unknown as GraphNode, constant("uv", [0, 0])], {
      s: "vec4",
      uv: "vec2",
    });
    assert.throws(() => lowerGraphWGSL(bad, bindings), { message: "TC_GRAPH_CONTEXT:s" });
  }
});

test("sampler UV mutation cannot change shared dependencies; shared samples evaluate once", () => {
  const graph = ir(
    [
      { id: "out", op: "add", inputs: ["sample", "sample"] },
      { id: "sample", op: "sampleTexture", inputs: ["uv"], texture: "asset" },
      constant("uv", [0.25, 0.75]),
    ],
    { out: "vec4", sample: "vec4", uv: "vec2" },
  );
  let calls = 0;
  assert.deepEqual(
    evaluateTypedGraph(graph, {
      sampleTexture: () => {
        calls++;
        return [1, 2, 3, 4];
      },
    }),
    [2, 4, 6, 8],
  );
  assert.equal(calls, 1);
  const mutation = ir(
    [
      { id: "out", op: "add", inputs: ["sample", "position"] },
      { id: "sample", op: "sampleTexture", inputs: ["uv"], texture: "asset" },
      { id: "position", op: "compose4", inputs: ["x", "y", "zero", "zero"] },
      { id: "x", op: "swizzle", inputs: ["uv"], components: "x" },
      { id: "y", op: "swizzle", inputs: ["uv"], components: "y" },
      constant("zero", 0),
      constant("uv", [0.25, 0.75]),
    ],
    { out: "vec4", sample: "vec4", position: "vec4", x: "float", y: "float", zero: "float", uv: "vec2" },
  );
  assert.deepEqual(
    evaluateTypedGraph(mutation, {
      sampleTexture: (_asset, uv) => {
        (uv as [number, number])[0] = 99;
        return [1, 2, 3, 4];
      },
    }),
    [1.25, 2.75, 3, 4],
  );
});

test("undefined builder values are memoized and prototype-like IDs stay data", () => {
  const graph = ir(
    [{ id: "out", op: "add", inputs: ["__proto__", "__proto__"] }, constant("__proto__", 1)],
    Object.fromEntries([
      ["out", "float"],
      ["__proto__", "float"],
    ]),
  );
  let constants = 0,
    operations = 0;
  const builder: TypedGraphBuilder<undefined> = {
    constant: () => {
      constants++;
      return undefined;
    },
    input: () => assert.fail("unexpected"),
    parameter: () => assert.fail("unexpected"),
    texture: () => assert.fail("unexpected"),
    operation: (_node, args) => {
      operations++;
      assert.deepEqual(args, [undefined, undefined]);
      return undefined;
    },
  };
  assert.equal(mapTypedGraph(graph, builder), undefined);
  assert.equal(constants, 1);
  assert.equal(operations, 1);
  assert.equal(evaluateTypedGraph(graph), 2);
  assert.equal(lowerGraphWGSL(graph, bindings).code, "let fx_g0: f32 = 1.0;\nlet fx_g1: f32 = (fx_g0 + fx_g0);");
});
