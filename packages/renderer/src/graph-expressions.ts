import { GRAPH_INPUT_TYPES, GRAPH_OPERATIONS, GRAPH_TYPES } from "../../sdk/src/index.ts";
import type { GraphInputName, GraphNode, GraphType, GraphValue, Vec2, Vec4 } from "../../sdk/src/index.ts";
import type { GraphIR } from "../../compiler/src/types.ts";

type OperationNode = Extract<GraphNode, { inputs: readonly string[] }>;
export interface TypedGraphBuilder<T> {
  constant(value: GraphValue, type: GraphType, node: GraphNode): T;
  input(name: GraphInputName | "time", type: GraphType, node: GraphNode): T;
  parameter(name: string, type: GraphType, defaultValue: GraphValue, node: GraphNode): T;
  texture(asset: string, uv: T, node: GraphNode): T;
  buffer?(name: string, index: T, type: GraphType, node: GraphNode): T;
  frame?(channel: string, uv: T, node: GraphNode): T;
  history?(channel: string, uv: T, node: GraphNode): T;
  operation(node: OperationNode, inputs: readonly T[], type: GraphType, inputTypes: readonly GraphType[]): T;
}
const own = (object: object, key: string) => Object.prototype.hasOwnProperty.call(object, key);
function fail(code: string, id: string): never {
  throw new Error(`TC_GRAPH_${code}:${id}`);
}
const types = GRAPH_TYPES;
const numeric = (type: GraphType) => type !== "bool";
const width = (type: GraphType) => (type.startsWith("vec") ? Number(type[3]) : 1);
const unary: ReadonlySet<string> = new Set(GRAPH_OPERATIONS.unary);
const binary: ReadonlySet<string> = new Set(GRAPH_OPERATIONS.binary);
const ternary: ReadonlySet<string> = new Set(GRAPH_OPERATIONS.ternary);
function valueChecked(value: unknown, type: GraphType, id: string): GraphValue {
  const finite = (n: unknown) => typeof n === "number" && Number.isFinite(n) && Number.isFinite(Math.fround(n));
  if (type === "bool" && typeof value === "boolean") return value;
  if (type === "float" && finite(value)) return value as number;
  if (type.startsWith("vec") && Array.isArray(value) && value.length === width(type) && Array.from(value).every(finite))
    return [...value] as unknown as GraphValue;
  return fail("VALUE", id);
}
function broadcast(types: readonly GraphType[], id: string): GraphType {
  const vector = types.find((t) => width(t) > 1) ?? "float";
  if (types.some((t) => !numeric(t) || (t !== "float" && t !== vector))) fail("TYPE", id);
  return vector;
}
function swizzle(node: Extract<GraphNode, { op: "swizzle" }>, type: GraphType): string {
  const mask = node.components;
  if (width(type) === 1 || typeof mask !== "string" || !/^(?:[xyzw]{1,4}|[rgba]{1,4})$/.test(mask)) fail("TYPE", node.id);
  const family = /^[rgba]+$/.test(mask) ? "rgba" : "xyzw";
  const indices = [...mask].map((c) => family.indexOf(c));
  if (indices.some((i) => i >= width(type))) fail("TYPE", node.id);
  return indices.map((i) => "xyzw"[i]).join("");
}
function operationType(node: OperationNode, args: readonly GraphType[]): GraphType {
  const op = node.op,
    id = node.id;
  const require = (condition: boolean, result: GraphType): GraphType => (condition ? result : fail("TYPE", id));
  const a = args[0],
    b = args[1];
  if (op === "sampleTexture") return require(a === "vec2", "vec4");
  if (op === "swizzle") {
    const n = swizzle(node, a).length;
    return n === 1 ? "float" : (`vec${n}` as GraphType);
  }
  if (op.startsWith("compose")) return require(args.every((t) => t === "float"), `vec${args.length}` as GraphType);
  if (op === "not") return require(a === "bool", "bool");
  if (op === "and" || op === "or") return require(a === "bool" && b === "bool", "bool");
  if (["lessThan", "lessEqual", "greaterThan", "greaterEqual"].includes(op)) return require(a === "float" && b === "float", "bool");
  if (op === "equal") return require(a === b && (a === "float" || a === "bool"), "bool");
  if (op === "select") return require(a === b && args[2] === "bool", a);
  if (op === "dot") return require(a === b && width(a) > 1, "float");
  if (op === "cross") return require(a === "vec3" && b === "vec3", "vec3");
  if (op === "normalize") return require(width(a) > 1, a);
  if (op === "length") return require(numeric(a), "float");
  if (op === "add" || op === "subtract") return require(a === b && numeric(a), a);
  if (op === "mix") return require(a === b && numeric(a) && (args[2] === "float" || args[2] === a), a);
  if (unary.has(op)) return require(numeric(a), a);
  if (binary.has(op) || op === "clamp" || op === "smoothstep") return broadcast(args, id);
  return fail("OP", id);
}

/** Renderer-private traversal. Only output-reachable nodes invoke builder callbacks. */
export function mapTypedGraph<T>(graph: GraphIR, builder: TypedGraphBuilder<T>): T {
  if (!graph || !Array.isArray(graph.nodes) || !graph.nodeTypes || typeof graph.output !== "string") fail("IR", "graph");
  const nodes = new Map<string, GraphNode>(),
    values = new Map<string, T>(),
    active = new Set<string>();
  if (
    graph.parameters !== undefined &&
    (!Array.isArray(graph.parameters) || Array.from(graph.parameters).some((p) => !p || typeof p.name !== "string"))
  )
    fail("IR", "parameters");
  const parameters = new Map((graph.parameters ?? []).map((p) => [p.name, p]));
  if (parameters.size !== (graph.parameters?.length ?? 0)) fail("IR", "parameters");
  for (const node of graph.nodes) {
    if (!node || typeof node.id !== "string" || nodes.has(node.id)) fail("IR", node?.id ?? "graph");
    nodes.set(node.id, node);
  }
  const typeOf = (id: string): GraphType => {
    if (!nodes.has(id)) fail("REF", id);
    const type = graph.nodeTypes[id];
    if (!own(graph.nodeTypes, id) || !types.includes(type)) fail("TYPE", id);
    return type;
  };
  const stack: { id: string; ready: boolean }[] = [{ id: graph.output, ready: false }];
  if (graph.outputType !== typeOf(graph.output)) fail("TYPE", graph.output);
  while (stack.length) {
    const { id, ready } = stack.pop()!;
    if (values.has(id)) continue;
    const type = typeOf(id),
      node = nodes.get(id)!;
    const checked = (expected: GraphType) => (expected === type ? expected : fail("TYPE", id));
    const refs = "inputs" in node ? node.inputs : [];
    if (!Array.isArray(refs) || refs.some((ref) => typeof ref !== "string")) fail("REF", id);
    if (!ready) {
      if (active.has(id)) fail("CYCLE", id);
      active.add(id);
      stack.push({ id, ready: true });
      for (let i = refs.length - 1; i >= 0; i--) stack.push({ id: refs[i], ready: false });
      continue;
    }
    let result: T, expected: GraphType;
    if (node.op === "float" || node.op === "bool" || node.op === "vec2" || node.op === "vec3" || node.op === "vec4") {
      expected = checked(node.op);
      result = builder.constant(valueChecked(node.value, expected, id), expected, node);
    } else if (node.op === "time" || node.op === "input") {
      const name = node.op === "time" ? "time" : node.name;
      if (node.op === "input" && !own(GRAPH_INPUT_TYPES, node.name)) fail("CONTEXT", id);
      expected = checked(name === "time" ? "float" : GRAPH_INPUT_TYPES[name]);
      result = builder.input(name, expected, node);
    } else if (node.op === "parameter") {
      const parameter = parameters.get(node.name);
      if (!parameter || !types.includes(parameter.type)) fail("CONTEXT", id);
      expected = checked(parameter.type);
      result = builder.parameter(node.name, expected, valueChecked(parameter.default, expected, id), node);
    } else if (node.op === "sampleFrame" || node.op === "sampleHistory") {
      if (refs.length !== 1 || typeOf(refs[0]) !== "vec2" || typeof node.channel !== "string" || !node.channel.length) fail("TYPE", id);
      expected = checked("vec4");
      const callback = node.op === "sampleFrame" ? builder.frame : builder.history;
      if (!callback) fail("CONTEXT", id);
      result = callback(node.channel, values.get(refs[0])!, node);
    } else if (node.op === "readBuffer") {
      if (refs.length !== 1 || typeOf(refs[0]) !== "float" || !graph.bufferTypes || !own(graph.bufferTypes, node.buffer) || !types.includes(graph.bufferTypes[node.buffer])) fail("TYPE", id);
      expected = checked(graph.bufferTypes[node.buffer]);
      if (!builder.buffer) fail("CONTEXT", id);
      result = builder.buffer(node.buffer, values.get(refs[0])!, expected, node);
    } else {
      const op = node.op;
      const count =
        unary.has(op) || op === "not" || op === "swizzle" || op === "sampleTexture"
          ? 1
          : binary.has(op) || op === "compose2"
            ? 2
            : ternary.has(op) || op === "compose3"
              ? 3
              : op === "compose4"
                ? 4
                : fail("OP", id);
      if (refs.length !== count) fail("TYPE", id);
      const inputTypes = refs.map(typeOf);
      expected = checked(operationType(node, inputTypes));
      if (node.op === "sampleTexture") {
        const asset = typeof node.texture === "string" ? node.texture : node.texture?.id;
        if (typeof asset !== "string" || !asset.length) fail("CONTEXT", id);
        result = builder.texture(asset, values.get(refs[0])!, node);
      } else
        result = builder.operation(
          node,
          refs.map((ref) => values.get(ref)!),
          expected,
          inputTypes,
        );
    }
    values.set(id, result);
    active.delete(id);
  }
  return values.get(graph.output)!;
}

export interface GraphEvaluationContext {
  /** Vertex mirrors round each graph-node result to f32; legacy CPU references remain f64. */
  precision?: "f32" | "f64";
  time?: number;
  parameters?: Readonly<Record<string, GraphValue>>;
  inputs?: Partial<Record<GraphInputName, GraphValue>>;
  sampleTexture?: (asset: string, uv: Vec2) => Vec4;
  readBuffer?: (name: string, index: number) => GraphValue;
  sampleFrame?: (channel: string, uv: Vec2) => Vec4;
  sampleHistory?: (channel: string, uv: Vec2) => Vec4;
}
const components = (v: GraphValue): readonly number[] => (typeof v === "number" ? [v] : (v as readonly number[]));
function arithmetic(node: OperationNode, args: readonly GraphValue[], type: GraphType): GraphValue {
  const [a, b, c] = args,
    op = node.op;
  const aa = components(a),
    bb = components(b);
  const componentwise = (fn: (...values: number[]) => number): GraphValue => {
    const result = Array.from({ length: width(type) }, (_, i) =>
      fn(
        ...args.map((v) => {
          const a = components(v);
          return a[a.length === 1 ? 0 : i];
        }),
      ),
    );
    return type === "float" ? result[0] : (result as unknown as GraphValue);
  };
  const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);
  switch (op) {
    case "not":
      return !a;
    case "and":
      return Boolean(a && b);
    case "or":
      return Boolean(a || b);
    case "equal":
      return a === b;
    case "lessThan":
      return (a as number) < (b as number);
    case "lessEqual":
      return (a as number) <= (b as number);
    case "greaterThan":
      return (a as number) > (b as number);
    case "greaterEqual":
      return (a as number) >= (b as number);
    case "select":
      return c ? b : a;
    case "compose2":
    case "compose3":
    case "compose4":
      return [...args] as unknown as GraphValue;
    case "swizzle": {
      const v = [...swizzle(node, `vec${aa.length}` as GraphType)].map((c) => aa["xyzw".indexOf(c)]);
      return v.length === 1 ? v[0] : (v as unknown as GraphValue);
    }
    case "length":
      return Math.hypot(...aa);
    case "normalize": {
      const scale = Math.max(...aa.map(Math.abs));
      const v = scale === 0 ? aa.map(() => 0) : aa.map((n) => n / scale);
      const len = Math.hypot(...v);
      return v.map((n) => (len === 0 ? 0 : n / len)) as unknown as GraphValue;
    }
    case "dot":
      return aa.reduce((sum, n, i) => sum + n * bb[i], 0);
    case "cross":
      return [aa[1] * bb[2] - aa[2] * bb[1], aa[2] * bb[0] - aa[0] * bb[2], aa[0] * bb[1] - aa[1] * bb[0]];
    case "add":
      return componentwise((x, y) => x + y);
    case "subtract":
      return componentwise((x, y) => x - y);
    case "multiply":
      return componentwise((x, y) => x * y);
    case "safeDivide":
      return componentwise((x, y) => (y === 0 ? 0 : x / y));
    case "min":
      return componentwise(Math.min);
    case "max":
      return componentwise(Math.max);
    case "step":
      return componentwise((edge, v) => (v < edge ? 0 : 1));
    case "mix":
      return componentwise((x, y, t) => x * (1 - t) + y * t);
    case "clamp":
      return componentwise(clamp);
    case "smoothstep":
      return componentwise((lo, hi, v) => {
        const t = clamp(hi === lo ? 0 : (v - lo) / (hi - lo), 0, 1);
        return t * t * (3 - 2 * t);
      });
    case "sin":
      return componentwise(Math.sin);
    case "cos":
      return componentwise(Math.cos);
    case "abs":
      return componentwise(Math.abs);
    case "floor":
      return componentwise(Math.floor);
    case "ceil":
      return componentwise(Math.ceil);
    case "fract":
      return componentwise((x) => x - Math.floor(x));
    case "negate":
      return componentwise((x) => -x);
    case "saturate":
      return componentwise((x) => clamp(x, 0, 1));
    case "safeSqrt":
      return componentwise((x) => Math.sqrt(Math.max(x, 0)));
    default:
      return fail("OP", node.id);
  }
}
/** f64 intermediates intentionally preserve legacy CPU evaluation. */
export function evaluateTypedGraph(graph: GraphIR, context: GraphEvaluationContext = {}): GraphValue {
  if (!context || typeof context !== "object" || Array.isArray(context)) fail("CONTEXT", "graph");
  if (context.precision !== undefined && context.precision !== "f32" && context.precision !== "f64") fail("CONTEXT", "precision");
  const round = (value: GraphValue, id: string): GraphValue => {
    if (context.precision !== "f32" || typeof value === "boolean") return value;
    const rounded = typeof value === "number" ? Math.fround(value) : value.map(Math.fround) as unknown as GraphValue;
    if (typeof rounded !== "boolean" && components(rounded).some(number => !Number.isFinite(number))) fail("ARITHMETIC", id);
    return rounded;
  };
  for (const record of [context.parameters, context.inputs]) {
    if (record !== undefined && (!record || typeof record !== "object" || Array.isArray(record))) fail("CONTEXT", "graph");
  }
  const result = mapTypedGraph<GraphValue>(graph, {
    constant: (value, _type, node) => round(value, node.id),
    input: (name, type, node) => {
      const value =
        name === "time"
          ? context.time === undefined
            ? 0
            : context.time
          : context.inputs && own(context.inputs, name)
            ? context.inputs[name]
            : undefined;
      if (value === undefined) fail("CONTEXT", node.id);
      return round(valueChecked(value, type, node.id), node.id);
    },
    parameter: (name, type, fallback, node) =>
      round(valueChecked(context.parameters && own(context.parameters, name) ? context.parameters[name] : fallback, type, node.id), node.id),
    texture: (asset, uv, node) => {
      if (typeof context.sampleTexture !== "function") fail("CONTEXT", node.id);
      return round(valueChecked(context.sampleTexture(asset, [...(uv as Vec2)] as Vec2), "vec4", node.id), node.id);
    },
    buffer: (name, index, type, node) => {
      if (typeof context.readBuffer !== "function" || typeof index !== "number") fail("CONTEXT", node.id);
      return round(valueChecked(context.readBuffer(name, index), type, node.id), node.id);
    },
    frame: (channel, uv, node) => {
      if (!context.sampleFrame) fail("CONTEXT", node.id);
      return round(valueChecked(context.sampleFrame(channel, [...(uv as Vec2)] as Vec2), "vec4", node.id), node.id);
    },
    history: (channel, uv, node) => {
      if (!context.sampleHistory) fail("CONTEXT", node.id);
      return round(valueChecked(context.sampleHistory(channel, [...(uv as Vec2)] as Vec2), "vec4", node.id), node.id);
    },
    operation: (node, inputs, type) => {
      const value = arithmetic(node, inputs, type);
      if (typeof value !== "boolean" && components(value).some((n) => !Number.isFinite(n))) fail("ARITHMETIC", node.id);
      return round(value, node.id);
    },
  });
  return Array.isArray(result) ? ([...result] as unknown as GraphValue) : result;
}

export interface GraphWGSLBindings {
  prefix: string;
  input: (name: GraphInputName | "time", type: GraphType) => string;
  parameter: (name: string, type: GraphType) => string;
  sampleTexture: (asset: string, uvSymbol: string) => string;
  readBuffer?: (name: string, indexSymbol: string, type: GraphType) => string;
  sampleFrame?: (channel: string, uvSymbol: string) => string;
  sampleHistory?: (channel: string, uvSymbol: string) => string;
}
const wgslType = (type: GraphType) => (type === "float" ? "f32" : type === "bool" ? "bool" : `${type}f`);
const literal = (value: number) => (Object.is(value, -0) ? "-0.0" : /[.e]/i.test(String(value)) ? String(value) : `${value}.0`);
/** Bindings contain trusted engine code, never SDK/user-provided shader source. */
export function lowerGraphWGSL(
  graph: GraphIR,
  bindings: GraphWGSLBindings,
): { helpers: string; code: string; result: string; type: GraphType } {
  if (!bindings || typeof bindings.prefix !== "string" || !/^[A-Za-z][A-Za-z0-9_]*$/.test(bindings.prefix)) fail("PREFIX", "graph");
  const lines: string[] = [],
    helpers = new Map<string, string>(),
    prefix = bindings.prefix;
  const emit = (expression: string, type: GraphType) => {
    const symbol = `${prefix}_g${lines.length}`;
    lines.push(`let ${symbol}: ${wgslType(type)} = ${expression};`);
    return symbol;
  };
  const binding = <Args extends unknown[]>(callback: (...args: Args) => string, args: Args, id: string): string => {
    if (typeof callback !== "function") fail("CONTEXT", id);
    const result = callback(...args);
    return typeof result === "string" && result.trim().length ? result : fail("CONTEXT", id);
  };
  const helper = (kind: "safeDivide" | "safeNormalize", type: GraphType) => {
    const name = `${prefix}_${kind}_${type}`,
      t = wgslType(type),
      zero = `${t}(0.0)`,
      one = `${t}(1.0)`;
    if (!helpers.has(name)) {
      if (kind === "safeDivide")
        helpers.set(
          name,
          `fn ${name}(a: ${t}, b: ${t}) -> ${t} {\n  let zero = b == ${zero};\n  let denominator = select(b, ${one}, zero);\n  return select(a / denominator, ${zero}, zero);\n}`,
        );
      else {
        const maximum = Array.from({ length: width(type) }, (_, i) => `abs(v.${"xyzw"[i]})`).reduce((a, b) => `max(${a}, ${b})`);
        helpers.set(
          name,
          `fn ${name}(v: ${t}) -> ${t} {\n  let scale = ${maximum};\n  if (scale == 0.0) { return ${zero}; }\n  let scaled = v / scale;\n  return scaled / length(scaled);\n}`,
        );
      }
    }
    return name;
  };
  const result = mapTypedGraph<string>(graph, {
    constant: (value, type) =>
      emit(
        typeof value === "boolean"
          ? String(value)
          : typeof value === "number"
            ? literal(value)
            : `${wgslType(type)}(${value.map(literal).join(", ")})`,
        type,
      ),
    input: (name, type, node) => emit(binding(bindings.input, [name, type], node.id), type),
    parameter: (name, type, _fallback, node) => emit(binding(bindings.parameter, [name, type], node.id), type),
    texture: (asset, uv, node) => emit(binding(bindings.sampleTexture, [asset, uv], node.id), "vec4"),
    buffer: (name, index, type, node) => {
      if (!bindings.readBuffer) fail("CONTEXT", node.id);
      return emit(binding(bindings.readBuffer, [name, index, type], node.id), type);
    },
    frame: (channel, uv, node) => {
      if (!bindings.sampleFrame) fail("CONTEXT", node.id);
      return emit(binding(bindings.sampleFrame, [channel, uv], node.id), "vec4");
    },
    history: (channel, uv, node) => {
      if (!bindings.sampleHistory) fail("CONTEXT", node.id);
      return emit(binding(bindings.sampleHistory, [channel, uv], node.id), "vec4");
    },
    operation: (node, inputs, type, inputTypes) => {
      const op = node.op,
        t = wgslType(type);
      const cast = (symbol: string, index: number) => (inputTypes[index] === "float" && width(type) > 1 ? `${t}(${symbol})` : symbol);
      const [a, b, c] = inputs.map(cast);
      let expression: string;
      switch (op) {
        case "add":
        case "subtract":
        case "multiply":
          expression = `(${a} ${{ add: "+", subtract: "-", multiply: "*" }[op]} ${b})`;
          break;
        case "lessThan":
        case "lessEqual":
        case "greaterThan":
        case "greaterEqual":
        case "equal":
        case "and":
        case "or": {
          const operator = { lessThan: "<", lessEqual: "<=", greaterThan: ">", greaterEqual: ">=", equal: "==", and: "&&", or: "||" }[op];
          expression = `(${a} ${operator} ${b})`;
          break;
        }
        case "not":
          expression = `(!${a})`;
          break;
        case "negate":
          expression = `(-${a})`;
          break;
        case "select":
          expression = `select(${a}, ${b}, ${inputs[2]})`;
          break;
        case "compose2":
        case "compose3":
        case "compose4":
          expression = `${t}(${inputs.join(", ")})`;
          break;
        case "swizzle":
          expression = `${inputs[0]}.${swizzle(node, inputTypes[0])}`;
          break;
        case "safeDivide":
          expression = `${helper("safeDivide", type)}(${a}, ${b})`;
          break;
        case "normalize":
          expression = `${helper("safeNormalize", type)}(${a})`;
          break;
        case "safeSqrt":
          expression = `sqrt(max(${a}, ${t}(0.0)))`;
          break;
        case "saturate":
          expression = `clamp(${a}, ${t}(0.0), ${t}(1.0))`;
          break;
        case "length":
          expression = inputTypes[0] === "float" ? `abs(${a})` : `length(${a})`;
          break;
        case "smoothstep": {
          const tt = emit(`clamp(${helper("safeDivide", type)}(${c} - ${a}, ${b} - ${a}), ${t}(0.0), ${t}(1.0))`, type);
          expression = `(${tt} * ${tt} * (${t}(3.0) - ${t}(2.0) * ${tt}))`;
          break;
        }
        case "sin":
        case "cos":
        case "abs":
        case "floor":
        case "ceil":
        case "fract":
          expression = `${op}(${a})`;
          break;
        case "min":
        case "max":
        case "dot":
        case "cross":
        case "step":
          expression = `${op}(${a}, ${b})`;
          break;
        case "mix":
        case "clamp":
          expression = `${op}(${a}, ${b}, ${c})`;
          break;
        default:
          return fail("OP", node.id);
      }
      return emit(expression, type);
    },
  });
  return { helpers: [...helpers.values()].join("\n"), code: lines.join("\n"), result, type: graph.outputType };
}
