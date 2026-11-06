import {
  GRAPH_INPUT_TYPES,
  GRAPH_OPERATIONS,
  type ComputeTextureBinding,
  type GraphInputName,
  type GraphNode,
  type GraphParameter,
  type GraphType,
  type GraphValue,
} from "../../sdk/src/index.ts";
import { graphValue, isGraphType } from "../../sdk/src/graph-values.ts";
import type { GraphIR } from "./types.ts";

type Obj = Record<string, unknown>;
export interface GraphIssue {
  code: string;
  message: string;
  owner: object;
  field: string;
  suggestion: string;
}
const record = (value: unknown): value is Obj =>
  !!value && typeof value === "object" && !Array.isArray(value);
const idPattern = /^[a-zA-Z][a-zA-Z0-9_.-]*$/;
const has = (values: readonly string[], value: unknown) =>
  typeof value === "string" && values.includes(value);
const numeric = (type: GraphType) => type !== "bool";

/** Typed acyclic graph validation; issue owners are the original extraction objects. */
export function compileGraphDeclaration(
  raw: unknown,
  expected: GraphType,
  options: {
    owner?: object;
    inputs?: readonly GraphInputName[];
    textures?: ReadonlySet<string>;
    textureSlots?: Readonly<Record<string, ComputeTextureBinding>>;
    domain?: "material" | "compute" | "postprocess" | "vertex";
    buffers?: Readonly<Record<string, GraphType>>;
    frameChannels?: ReadonlySet<string>;
    historyChannels?: ReadonlySet<string>;
  } = {},
): { graph: GraphIR; issues: GraphIssue[] } {
  const issues: GraphIssue[] = [],
    g = record(raw) ? raw : {},
    fallbackOwner = options.owner ?? g;
  const error = (
    code: string,
    message: string,
    owner: object,
    field: string,
    suggestion = "Use the declared graph operation, matching types and existing node/parameter/texture IDs.",
  ) => issues.push({ code, message, owner, field, suggestion });
  if (!record(raw))
    error("TC_SCHEMA_TYPE", "graph must be an object.", fallbackOwner, "graph");
  for (const key of Object.keys(g))
    if (!["nodes", "output", "parameters"].includes(key))
      error("TC_GRAPH_FIELD", "Unknown graph field " + key, g, key);
  const parameters: GraphParameter[] = [],
    parameterTypes = new Map<string, GraphType>();
  if (g.parameters !== undefined && !Array.isArray(g.parameters))
    error("TC_SCHEMA_TYPE", "parameters must be an array.", g, "parameters");
  for (const rawParameter of Array.isArray(g.parameters) ? g.parameters : []) {
    if (!record(rawParameter)) {
      error(
        "TC_GRAPH_PARAMETER",
        "Parameter must be an object.",
        g,
        "parameters",
      );
      continue;
    }
    const p = rawParameter;
    for (const key of Object.keys(p))
      if (!["name", "type", "default"].includes(key))
        error("TC_GRAPH_FIELD", "Unknown parameter field " + key, p, key);
    if (typeof p.name !== "string" || !idPattern.test(p.name)) {
      error(
        "TC_GRAPH_PARAMETER",
        "Parameter requires a valid name.",
        p,
        "name",
      );
      continue;
    }
    if (parameterTypes.has(p.name)) {
      error("TC_GRAPH_PARAMETER", "Duplicate parameter " + p.name, p, "name");
      continue;
    }
    if (!isGraphType(p.type)) {
      error("TC_GRAPH_PARAMETER", "Unknown parameter type.", p, "type");
      continue;
    }
    const value = graphValue(p.type, p.default);
    if (value === null) {
      error(
        "TC_GRAPH_PARAMETER_VALUE",
        "Parameter default must match " +
          p.type +
          " and fit finite f32 values.",
        p,
        "default",
      );
      continue;
    }
    parameterTypes.set(p.name, p.type);
    parameters.push({ name: p.name, type: p.type, default: value });
  }
  if (!Array.isArray(g.nodes))
    error("TC_SCHEMA_TYPE", "nodes must be an array.", g, "nodes");
  const lookup = new Map<string, Obj>(),
    normalized = new Map<string, GraphNode>(),
    dependencies = new Map<string, Set<string>>(),
    consumers = new Map<string, Set<string>>();
  for (const rawNode of Array.isArray(g.nodes) ? g.nodes : []) {
    if (!record(rawNode)) {
      error("TC_SCHEMA_TYPE", "Graph node must be an object.", g, "nodes");
      continue;
    }
    const n = rawNode;
    if (typeof n.id !== "string" || !idPattern.test(n.id)) {
      error("TC_SCHEMA_ID", "Graph node requires a valid ID.", n, "id");
      continue;
    }
    if (lookup.has(n.id)) {
      error("TC_GRAPH_DUPLICATE", "Duplicate graph node: " + n.id, n, "id");
      continue;
    }
    lookup.set(n.id, n);
  }
  const requiredInputs = new Set<GraphInputName>(),
    textureIds = new Set<string>(),
    textureSlots: Record<string, ComputeTextureBinding> = Object.create(null),
    frameChannels = new Set<string>(),
    historyChannels = new Set<string>(),
    bufferTypes: Record<string, GraphType> = Object.create(null);
  for (const [name, n] of lookup) {
    const op = n.op;
    let arity = 0,
      fields = ["id", "op"],
      copy: Obj = { id: name, op };
    if (isGraphType(op)) {
      fields.push("value");
      const value = graphValue(op, n.value);
      if (value === null)
        error(
          "TC_GRAPH_VALUE",
          "Graph constant must match " + op + " and fit finite f32 values.",
          n,
          n.value === undefined ? "op" : "value",
        );
      copy.value = value;
    } else if (op === "time") {
      // The fixed simulation clock is an engine input, never a wall-clock read.
    } else if (op === "input") {
      fields.push("name");
      copy.name = n.name;
      if (
        typeof n.name !== "string" ||
        !Object.hasOwn(GRAPH_INPUT_TYPES, n.name)
      )
        error(
          "TC_GRAPH_CONTEXT",
          "Unknown graph input " + String(n.name),
          n,
          "name",
        );
      else {
        const input = n.name as GraphInputName;
        if (options.inputs && !options.inputs.includes(input))
          error(
            "TC_GRAPH_CONTEXT",
            "Input " + input + " is unavailable in this graph domain.",
            n,
            "name",
          );
      }
    } else if (op === "parameter") {
      fields.push("name");
      copy.name = n.name;
      if (typeof n.name !== "string" || !parameterTypes.has(n.name))
        error(
          "TC_GRAPH_PARAMETER",
          "Unknown parameter " + String(n.name),
          n,
          "name",
        );
    } else if (op === "sampleTexture") {
      arity = 1;
      fields.push("texture");
      const texture =
        typeof n.texture === "string"
          ? n.texture
          : record(n.texture) && n.texture.kind === "asset"
            ? n.texture.id
            : undefined;
      if (
        typeof texture !== "string" ||
        !idPattern.test(texture) ||
        ((options.textures || options.textureSlots) &&
          !options.textures?.has(texture) &&
          !(typeof n.texture === "string" && options.textureSlots && Object.hasOwn(options.textureSlots, texture)))
      )
        error(
          "TC_GRAPH_TEXTURE",
          options.domain === "compute" ? "Reference a named texture slot declared in defineCompute.textures." : "Reference a declared texture asset or render texture slot.",
          n,
          "texture",
        );
      if (typeof texture === "string" && options.textures?.has(texture) && options.textureSlots && Object.hasOwn(options.textureSlots, texture))
        error("TC_GRAPH_TEXTURE", "Texture slot name conflicts with static asset ID: " + texture, n, "texture");
      copy.texture = texture;
    } else if (op === "sampleFrame" || op === "sampleHistory") {
      arity = 1;
      fields.push("channel");
      copy.channel = n.channel;
      if (options.domain !== "postprocess")
        error("TC_GRAPH_CONTEXT", "Frame and history samples are available only in postprocess graphs.", n, "op");
      const channels = op === "sampleFrame" ? options.frameChannels : options.historyChannels;
      if (typeof n.channel !== "string" || !channels?.has(n.channel))
        error("TC_POSTPROCESS_CHANNEL", "Unknown or unavailable " + op + " channel: " + String(n.channel), n, "channel", "Frame reads must reference a scene channel or an earlier pass; history reads must reference a declared postprocess pass.");
    } else if (op === "readBuffer") {
      arity = 1;
      fields.push("buffer");
      copy.buffer = n.buffer;
      if (
        typeof n.buffer !== "string" ||
        !idPattern.test(n.buffer) ||
        !options.buffers ||
        !Object.hasOwn(options.buffers, n.buffer)
      )
        error(
          "TC_COMPUTE_BINDING",
          options.domain === "compute"
            ? "Reference a declared compute buffer binding."
            : "Reference a declared render buffer slot.",
          n,
          "buffer",
          options.domain === "compute"
            ? "Add a matching name/type to defineCompute.buffers and bind a managed buffer at dispatch."
            : "Add a matching name/type to " +
              (options.domain === "postprocess" ? "definePostProcess.buffers" : "defineMaterial.buffers") +
              " and bind a managed buffer before rendering.",
        );
    } else if (op === "swizzle") {
      arity = 1;
      fields.push("components");
      copy.components = n.components;
    } else if (op === "not" || has(GRAPH_OPERATIONS.unary, op)) arity = 1;
    else if (has(GRAPH_OPERATIONS.binary, op) || op === "compose2") arity = 2;
    else if (has(GRAPH_OPERATIONS.ternary, op) || op === "compose3") arity = 3;
    else if (op === "compose4") arity = 4;
    else
      error(
        "TC_GRAPH_OP",
        "Unsupported graph operation: " + String(op),
        n,
        "op",
      );
    const inputs = arity
      ? Array.isArray(n.inputs)
        ? Array.from(n.inputs)
        : []
      : [];
    if (arity) {
      fields.push("inputs");
      if (
        inputs.length !== arity ||
        inputs.some((value) => typeof value !== "string")
      )
        error(
          "TC_GRAPH_ARITY",
          "Node " + name + " requires " + arity + " node IDs.",
          n,
          "inputs",
        );
      copy.inputs = inputs;
    }
    for (const key of Object.keys(n))
      if (!fields.includes(key))
        error(
          "TC_GRAPH_FIELD",
          "Unknown " + String(op) + " node field " + key,
          n,
          key,
        );
    const deps = new Set<string>();
    for (const input of inputs) {
      if (typeof input !== "string") continue;
      if (!lookup.has(input))
        error(
          "TC_GRAPH_REFERENCE",
          "Graph references missing node: " + input,
          n,
          "inputs",
        );
      else {
        deps.add(input);
        if (!consumers.has(input)) consumers.set(input, new Set());
        consumers.get(input)!.add(name);
      }
    }
    dependencies.set(name, deps);
    normalized.set(name, copy as unknown as GraphNode);
  }
  const types: Record<string, GraphType> = Object.create(null),
    order: GraphNode[] = [],
    ready = [...lookup.keys()].filter(
      (name) => dependencies.get(name)!.size === 0,
    );
  for (let cursor = 0; cursor < ready.length; cursor++) {
    const name = ready[cursor],
      n = lookup.get(name)!,
      op = n.op;
    const inputIds = Array.isArray(n.inputs) ? n.inputs : [],
      ts = inputIds.map((id) =>
        typeof id === "string" ? (types[id] ?? "float") : "float",
      ) as GraphType[];
    let result: GraphType = "float";
    const problem = (message: string) =>
      error("TC_GRAPH_TYPE", message, n, "inputs");
    const broadcast = (): GraphType => {
      if (ts.some((type) => !numeric(type))) {
        problem("Numeric inputs are required.");
        return "float";
      }
      const vectors = [...new Set(ts.filter((type) => type !== "float"))];
      if (vectors.length > 1) problem("Vector dimensions must agree.");
      return vectors[0] ?? "float";
    };
    if (isGraphType(op)) result = op;
    else if (op === "time") result = "float";
    else if (
      op === "input" &&
      typeof n.name === "string" &&
      Object.hasOwn(GRAPH_INPUT_TYPES, n.name)
    )
      result = GRAPH_INPUT_TYPES[n.name as GraphInputName];
    else if (op === "parameter")
      result = parameterTypes.get(String(n.name)) ?? "float";
    else if (op === "sampleTexture" || op === "sampleFrame" || op === "sampleHistory") {
      result = "vec4";
      if (ts[0] !== "vec2")
        problem("Texture sampling requires vec2 UV coordinates.");
    } else if (op === "readBuffer") {
      result = options.buffers && Object.hasOwn(options.buffers, String(n.buffer))
        ? options.buffers[String(n.buffer)]
        : "float";
      if (ts[0] !== "float") problem("Buffer index must be a float-valued expression; valid indices are finite in-range integers.");
    } else if (op === "swizzle") {
      const components = n.components;
      const valid =
        typeof components === "string" &&
        (/^[xyzw]{1,4}$/.test(components) || /^[rgba]{1,4}$/.test(components));
      const indices =
        typeof components === "string"
          ? [...components].map((c) =>
              "xyzw".includes(c) ? "xyzw".indexOf(c) : "rgba".indexOf(c),
            )
          : [];
      if (
        !valid ||
        !ts[0]?.startsWith("vec") ||
        indices.some((index) => index >= Number(ts[0]?.slice(3)))
      )
        error(
          "TC_GRAPH_TYPE",
          "Swizzle requires valid components of the source vector.",
          n,
          "components",
        );
      result = valid
        ? components.length === 1
          ? "float"
          : (("vec" + components.length) as GraphType)
        : "float";
    } else if (typeof op === "string" && op.startsWith("compose")) {
      if (ts.some((type) => type !== "float"))
        problem("Vector composition requires scalar inputs.");
      result = ("vec" + op.slice(7)) as GraphType;
    } else if (op === "and" || op === "or" || op === "not") {
      if (ts.some((type) => type !== "bool"))
        problem("Boolean inputs are required.");
      result = "bool";
    } else if (op === "equal") {
      if (ts[0] !== ts[1] || !["float", "bool"].includes(ts[0]))
        problem("Equality requires equal scalar float or bool types.");
      result = "bool";
    } else if (
      ["lessThan", "lessEqual", "greaterThan", "greaterEqual"].includes(
        String(op),
      )
    ) {
      if (ts.some((type) => type !== "float"))
        problem("Comparison requires scalar float inputs.");
      result = "bool";
    } else if (op === "select") {
      if (ts[0] !== ts[1] || ts[2] !== "bool")
        problem("select requires equal value types and a bool condition.");
      result = ts[0] ?? "float";
    } else if (op === "dot" || op === "cross") {
      if (
        ts[0] !== ts[1] ||
        !ts[0]?.startsWith("vec") ||
        (op === "cross" && ts[0] !== "vec3")
      )
        problem("dot needs equal vectors; cross needs vec3 inputs.");
      result = op === "dot" ? "float" : "vec3";
    } else if (has(GRAPH_OPERATIONS.unary, op)) {
      if (
        !numeric(ts[0] ?? "bool") ||
        (op === "normalize" && !ts[0]?.startsWith("vec"))
      )
        problem(
          "Unary operation requires numeric input; normalize requires a vector.",
        );
      result = op === "length" ? "float" : (ts[0] ?? "float");
    } else if (op === "add" || op === "subtract") {
      if (ts[0] !== ts[1] || !numeric(ts[0] ?? "bool"))
        problem("add/subtract require equal numeric types.");
      result = ts[0] ?? "float";
    } else if (op === "mix") {
      if (
        ts[0] !== ts[1] ||
        !numeric(ts[0] ?? "bool") ||
        (ts[2] !== "float" && ts[2] !== ts[0])
      )
        problem(
          "mix requires equal numeric values and scalar/matching-vector weight.",
        );
      result = ts[0] ?? "float";
    } else if (
      has(GRAPH_OPERATIONS.binary, op) ||
      has(GRAPH_OPERATIONS.ternary, op)
    )
      result = broadcast();
    types[name] = result;
    order.push(normalized.get(name)!);
    for (const consumer of consumers.get(name) ?? []) {
      const deps = dependencies.get(consumer)!;
      deps.delete(name);
      if (!deps.size) ready.push(consumer);
    }
  }
  for (const [name, n] of lookup)
    if (!Object.hasOwn(types, name))
      error(
        "TC_GRAPH_CYCLE",
        "Graph cycle at node: " + name,
        n,
        "inputs",
        "Graphs must be acyclic.",
      );
  const output = typeof g.output === "string" ? g.output : "";
  if (!lookup.has(output))
    error(
      "TC_GRAPH_REFERENCE",
      "Graph references missing output: " + output,
      g,
      "output",
    );
  const outputType = types[output] ?? "float";
  if (outputType !== expected)
    error(
      "TC_GRAPH_TYPE",
      "Expected " + expected + " graph output, received " + outputType + ".",
      g,
      "output",
    );
  // Validate all nodes, but bind/evaluate only the output dependency closure.
  const reachable = new Set<string>(),
    pending = [output];
  while (pending.length) {
    const name = pending.pop()!;
    if (reachable.has(name)) continue;
    const node = normalized.get(name);
    if (!node) continue;
    reachable.add(name);
    if ("inputs" in node) pending.push(...node.inputs);
    if (node.op === "input") requiredInputs.add(node.name);
    if (node.op === "readBuffer" && options.buffers && Object.hasOwn(options.buffers, node.buffer))
      bufferTypes[node.buffer] = options.buffers[node.buffer];
    if (node.op === "sampleFrame") frameChannels.add(node.channel);
    if (node.op === "sampleHistory") historyChannels.add(node.channel);
    if (node.op === "sampleTexture") {
      const name = node.texture as string;
      textureIds.add(name);
      if (options.textureSlots && Object.hasOwn(options.textureSlots, name))
        textureSlots[name] = { ...options.textureSlots[name] };
    }
  }
  const nodes = order.filter((node) => reachable.has(node.id));
  const graph: GraphIR = {
    nodes,
    output,
    outputType,
    nodeTypes: Object.fromEntries(
      nodes.map((node) => [node.id, types[node.id]]),
    ),
  };
  if (parameters.length) graph.parameters = parameters;
  if (requiredInputs.size) graph.requiredInputs = [...requiredInputs];
  if (textureIds.size) graph.textureIds = [...textureIds];
  if (Object.keys(textureSlots).length) graph.textureSlots = { ...textureSlots };
  if (Object.keys(bufferTypes).length) graph.bufferTypes = { ...bufferTypes };
  if (frameChannels.size) graph.frameChannels = [...frameChannels];
  if (historyChannels.size) graph.historyChannels = [...historyChannels];
  return { graph, issues };
}
