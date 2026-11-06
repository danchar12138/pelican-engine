import * as TSL from "three/tsl";
import type * as THREE from "three/webgpu";
import type { GraphIR } from "../../compiler/src/types.ts";
import type { GraphType, GraphInputName } from "../../sdk/src/index.ts";
import { mapTypedGraph } from "./graph-expressions.ts";

type Node = any;
export function typedGraphToTSL(
  graph: GraphIR,
  time: Node,
  parameters: ReadonlyMap<string, Node>,
  textures: ReadonlyMap<string, THREE.Texture>,
  context?: { inputs?: Partial<Record<GraphInputName, Node>>; sampleFrame?: (channel: string, uv: Node) => Node; sampleHistory?: (channel: string, uv: Node) => Node; readBuffer?: (name: string, index: Node, type: GraphType) => Node; sampleTextureSlot?: (name: string, uv: Node) => Node },
): Node {
  const construct = (type: GraphType, value: any): Node =>
    type === "bool"
      ? TSL.bool(value)
      : type === "float"
        ? TSL.float(value)
        : (TSL[type] as any)(...(Array.isArray(value) ? value : [value]));
  const safeDivide = (a: Node, b: Node, type: GraphType) => {
    const zero = b.equal(0);
    return TSL.select(
      zero,
      construct(type, 0),
      a.div(TSL.select(zero, construct(type, 1), b)),
    );
  };
  return mapTypedGraph<Node>(graph, {
    constant: (value, type) => construct(type, value),
    input(name) {
      if (name === "time") return time;
      if (context?.inputs && Object.hasOwn(context.inputs, name)) return context.inputs[name];
      if (name === "uv") return TSL.uv(0);
      if (name === "uv1") return TSL.uv(1);
      if (name === "positionWorld") return TSL.positionWorld;
      if (name === "normalWorld") return TSL.normalWorldGeometry;
      if (name === "viewDirectionWorld")
        return TSL.cameraPosition.sub(TSL.positionWorld).normalize();
      if (name === "vertexColor") return TSL.vertexColor();
      throw Error("TC_GRAPH_CONTEXT: raster material input " + name);
    },
    parameter(name) {
      const value = parameters.get(name);
      if (!value) throw Error("TC_GRAPH_PARAMETER: " + name);
      return value;
    },
    texture(asset, uv) {
      if (Object.hasOwn(graph.textureSlots ?? {}, asset)) {
        if (!context?.sampleTextureSlot) throw Error("TC_RENDER_TEXTURE_CAPABILITY: Managed texture sampling requires a render texture bridge.");
        return context.sampleTextureSlot(asset, uv);
      }
      const texture = textures.get(asset);
      if (!texture) throw Error("TC_GRAPH_TEXTURE: " + asset);
      return TSL.texture(texture, uv).level(TSL.float(0));
    },
    frame(channel, uv) {
      if (!context?.sampleFrame) throw Error("TC_GRAPH_CONTEXT: Frame sampling requires a postprocess source.");
      return context.sampleFrame(channel, uv);
    },
    history(channel, uv) {
      if (!context?.sampleHistory) throw Error("TC_GRAPH_CONTEXT: History sampling requires a postprocess source.");
      return context.sampleHistory(channel, uv);
    },
    buffer(name, index, type) {
      if (!context?.readBuffer) throw new Error("TC_GRAPH_CONTEXT: Buffer reads require a managed render slot.");
      return context.readBuffer(name, index, type);
    },
    operation(node, inputs, type, inputTypes) {
      const cast = (v: Node, i: number) =>
        inputTypes[i] === "float" && type.startsWith("vec")
          ? construct(type, v)
          : v;
      const [a, b, c] = inputs.map(cast),
        op = node.op;
      if (op === "compose2" || op === "compose3" || op === "compose4")
        return (TSL[type as "vec2" | "vec3" | "vec4"] as any)(...inputs);
      if (op === "swizzle") {
        const family = /^[rgba]+$/.test(node.components) ? "rgba" : "xyzw";
        return inputs[0][
          [...node.components].map((c) => "xyzw"[family.indexOf(c)]).join("")
        ];
      }
      if (op === "add") return a.add(b);
      if (op === "subtract") return a.sub(b);
      if (op === "multiply") return a.mul(b);
      if (op === "safeDivide") return safeDivide(a, b, type);
      if (op === "negate") return a.negate();
      if (op === "not") return a.not();
      if (op === "and") return a.and(b);
      if (op === "or") return a.or(b);
      if (op === "equal") return a.equal(b);
      if (op === "lessThan") return a.lessThan(b);
      if (op === "lessEqual") return a.lessThanEqual(b);
      if (op === "greaterThan") return a.greaterThan(b);
      if (op === "greaterEqual") return a.greaterThanEqual(b);
      if (op === "select") return TSL.select(inputs[2], b, a);
      if (op === "saturate") return TSL.clamp(a, 0, 1);
      if (op === "safeSqrt") return TSL.sqrt(TSL.max(a, 0));
      if (op === "normalize") {
        const n = Number(type.slice(3));
        let scale = TSL.abs(a.x);
        for (let i = 1; i < n; i++)
          scale = TSL.max(scale, TSL.abs(a["xyzw"[i]]));
        const scaled = a.div(TSL.select(scale.equal(0), 1, scale));
        const length = TSL.length(scaled);
        return scaled.div(TSL.select(length.equal(0), 1, length));
      }
      if (op === "smoothstep") {
        const t = TSL.clamp(safeDivide(c.sub(a), b.sub(a), type), 0, 1);
        return t.mul(t).mul(construct(type, 3).sub(t.mul(2)));
      }
      if (op === "length")
        return inputTypes[0] === "float" ? TSL.abs(a) : TSL.length(a);
      if (["sin", "cos", "abs", "floor", "ceil", "fract"].includes(op))
        return (TSL as any)[op](a);
      if (["min", "max", "dot", "cross", "step"].includes(op))
        return (TSL as any)[op](a, b);
      if (op === "mix" || op === "clamp") return TSL[op](a, b, c);
      throw Error("TC_GRAPH_OP: " + node.id + ":" + op);
    },
  });
}

/** normalNode expects an already oriented, normalized view-space normal. */
export function materialGraphNormalToTSL(value: Node): Node {
  const scale = TSL.max(
    TSL.max(TSL.abs(value.x), TSL.abs(value.y)),
    TSL.abs(value.z),
  );
  const scaled = value.div(TSL.select(scale.equal(0), 1, scale));
  const length = TSL.length(scaled);
  const world = TSL.select(
    scale.equal(0),
    TSL.normalWorldGeometry,
    scaled.div(TSL.select(length.equal(0), 1, length)),
  );
  return TSL.negateOnBackSide(world.transformDirection(TSL.cameraViewMatrix));
}
