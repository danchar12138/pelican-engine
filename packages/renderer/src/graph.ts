import * as TSL from "three/tsl";
import { Vector2, Vector3, Vector4 } from "three";
import type { GraphIR } from "../../compiler/src/types.ts";
import { compileGraphDeclaration } from "../../compiler/src/graph.ts";
import type { GraphValue } from "../../sdk/src/index.ts";
import {
  evaluateTypedGraph,
  lowerGraphWGSL,
  type GraphEvaluationContext,
} from "./graph-expressions.ts";
import { typedGraphToTSL } from "./graph-tsl.ts";

type CompatibleGraphIR = Omit<GraphIR, "nodeTypes"> & {
  nodeTypes?: GraphIR["nodeTypes"];
};
function typedGraph(graph: CompatibleGraphIR): GraphIR {
  if (!graph || graph.nodeTypes !== undefined) return graph as GraphIR;
  // M0 reference fixtures and serialized graphs predate per-node type metadata.
  const result = compileGraphDeclaration(
    {
      nodes: graph.nodes,
      output: graph.output,
      ...(graph.parameters ? { parameters: graph.parameters } : {}),
    },
    graph.outputType,
  );
  if (result.issues.length)
    throw Error(result.issues[0].code + ": " + result.issues[0].message);
  return result.graph;
}

/** Legacy signatures remain compatible; typed material adapters supply richer bindings. */
export function graphToTSL(
  input: CompatibleGraphIR,
  time: ReturnType<typeof TSL.uniform>,
) {
  const graph = typedGraph(input);
  const parameters = new Map(
    (graph.parameters ?? []).map((p) => {
      const value = Array.isArray(p.default)
        ? p.default.length === 2
          ? new Vector2(...(p.default as [number, number]))
          : p.default.length === 3
            ? new Vector3(...(p.default as [number, number, number]))
            : new Vector4(...(p.default as [number, number, number, number]))
        : p.default;
      return [p.name, (TSL.uniform as any)(value, p.type)];
    }),
  );
  return typedGraphToTSL(graph, time, parameters, new Map());
}
export function evaluateGraph(
  graph: CompatibleGraphIR,
  time: number,
): GraphValue {
  return evaluateTypedGraph(typedGraph(graph), { time });
}

/** The active check prevents uncancellable GPU promises from creating late resources. */
export async function withGraphGPUDeadline<T>(
  device: GPUDevice,
  prefix: string,
  work: (active: () => void) => Promise<T>,
  timeoutMs = 10000,
): Promise<T> {
  let stopped = false,
    timer: ReturnType<typeof setTimeout> | undefined;
  let scope: Promise<GPUError | null> | undefined;
  device.pushErrorScope("validation");
  const closeScope = () => (scope ??= device.popErrorScope());
  const active = () => {
    if (stopped)
      throw Error(prefix + "_CANCELLED: GPU graph work is no longer active.");
  };
  try {
    return await Promise.race([
      Promise.resolve()
        .then(() => work(active))
        .then(async (value) => {
          active();
          const validation = await closeScope();
          active();
          if (validation) throw Error(prefix + "_GPU: " + validation.message);
          return value;
        }),
      device.lost.then((info) => {
        throw Error(prefix + "_DEVICE_LOST: " + info.reason);
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              Error(
                prefix +
                  "_TIMEOUT: GPU graph work exceeded " +
                  timeoutMs +
                  "ms.",
              ),
            ),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    stopped = true;
    clearTimeout(timer);
    // popErrorScope may itself wait for a stuck device; cleanup must not await it.
    void closeScope().catch(() => null);
  }
}

export async function runComputeGraph(
  device: GPUDevice,
  input: CompatibleGraphIR,
  count: number,
  workgroupSize: number,
  time: number,
  parameters: Readonly<Record<string, GraphValue>> = {},
) {
  if (
    !Number.isSafeInteger(count) ||
    count < 1 ||
    count > 65536 ||
    count * 16 > device.limits.maxStorageBufferBindingSize ||
    count * 16 > device.limits.maxBufferSize
  )
    throw Error(
      "TC_COMPUTE_COUNT: Count must fit the validated output budget.",
    );
  if (
    !Number.isSafeInteger(workgroupSize) ||
    workgroupSize < 1 ||
    workgroupSize > 256 ||
    workgroupSize > device.limits.maxComputeWorkgroupSizeX ||
    workgroupSize > device.limits.maxComputeInvocationsPerWorkgroup ||
    Math.ceil(count / workgroupSize) >
      device.limits.maxComputeWorkgroupsPerDimension
  )
    throw Error("TC_COMPUTE_WORKGROUP: Dispatch exceeds actual device limits.");
  const graph = typedGraph(input);
  if (graph.nodes.some((node) => node.op === "sampleTexture"))
    throw Error(
      "TC_COMPUTE_TEXTURE: Compute texture bindings are not supported yet.",
    );
  if (graph.nodes.some(node => node.op === "readBuffer"))
    throw Error("TC_COMPUTE_BINDING: Buffered kernels require the managed compute service and explicit buffer bindings.");
  const context: GraphEvaluationContext = {
    time,
    parameters,
    inputs: { index: 0 },
  };
  const expected = evaluateTypedGraph(graph, context);
  const declarations = graph.parameters ?? [];
  const uniforms = new Float32Array((declarations.length + 1) * 4);
  uniforms[0] = time;
  for (let i = 0; i < declarations.length; i++) {
    const p = declarations[i],
      value = Object.hasOwn(parameters, p.name)
        ? parameters[p.name]
        : p.default;
    if (typeof value === "number" || typeof value === "boolean")
      uniforms[(i + 1) * 4] = Number(value);
    else uniforms.set(value, (i + 1) * 4);
  }
  const lowered = lowerGraphWGSL(graph, {
    prefix: "tcCompute",
    input: (name) => {
      if (name === "time") return "params[0].x";
      if (name === "index") return "f32(id.x)";
      throw Error("TC_GRAPH_CONTEXT: Unsupported compute input " + name);
    },
    parameter: (name, type) => {
      const index = declarations.findIndex((p) => p.name === name) + 1;
      if (index === 0) throw Error("TC_GRAPH_PARAMETER: " + name);
      const base = "params[" + index + "]";
      return type === "float"
        ? base + ".x"
        : type === "bool"
          ? "(" + base + ".x != 0.0)"
          : base + "." + "xyzw".slice(0, Number(type.slice(3)));
    },
    sampleTexture: () => {
      throw Error(
        "TC_COMPUTE_TEXTURE: A compute texture binding must be supplied by the engine resource API.",
      );
    },
  });
  const value =
    lowered.type === "float"
      ? "vec4f(" + lowered.result + ",0,0,1)"
      : lowered.type === "bool"
        ? "vec4f(select(0.0,1.0," + lowered.result + "),0,0,1)"
        : lowered.type === "vec2"
          ? "vec4f(" + lowered.result + ",0,1)"
          : lowered.type === "vec3"
            ? "vec4f(" + lowered.result + ",1)"
            : lowered.result;
  const source =
    "@group(0) @binding(0) var<storage,read_write> result:array<vec4f>; @group(0) @binding(1) var<uniform> params:array<vec4f," +
    (declarations.length + 1) +
    ">;\n" +
    lowered.helpers +
    "\n@compute @workgroup_size(" +
    workgroupSize +
    ") fn main(@builtin(global_invocation_id) id:vec3u){if(id.x>=" +
    count +
    "u){return;}\n" +
    lowered.code +
    "\nresult[id.x]=" +
    value +
    ";}";
  const buffers: GPUBuffer[] = [];
  try {
    const values = await withGraphGPUDeadline(
      device,
      "TC_COMPUTE",
      async (active) => {
        active();
        const module = device.createShaderModule({
          code: source,
          label: "pelican controlled compute graph",
        });
        const info = await module.getCompilationInfo();
        active();
        const errors = info.messages.filter((m) => m.type === "error");
        if (errors.length)
          throw Error(
            "TC_COMPUTE_SHADER: " + errors.map((e) => e.message).join("; "),
          );
        const pipeline = await device.createComputePipelineAsync({
          layout: "auto",
          compute: { module, entryPoint: "main" },
        });
        active();
        const make = (size: number, usage: number) => {
          const b = device.createBuffer({ size, usage });
          buffers.push(b);
          return b;
        };
        const output = make(
            count * 16,
            GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
          ),
          uniform = make(
            uniforms.byteLength,
            GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
          ),
          read = make(
            count * 16,
            GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
          );
        device.queue.writeBuffer(uniform, 0, uniforms);
        const group = device.createBindGroup({
          layout: pipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: output } },
            { binding: 1, resource: { buffer: uniform } },
          ],
        });
        const encoder = device.createCommandEncoder(),
          pass = encoder.beginComputePass();
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, group);
        pass.dispatchWorkgroups(Math.ceil(count / workgroupSize));
        pass.end();
        encoder.copyBufferToBuffer(output, 0, read, 0, count * 16);
        device.queue.submit([encoder.finish()]);
        await read.mapAsync(GPUMapMode.READ);
        active();
        const values = Array.from(
          new Float32Array(read.getMappedRange().slice(0)),
        );
        read.unmap();
        if (values.some((value) => !Number.isFinite(value)))
          throw Error(
            "TC_COMPUTE_NONFINITE: Graph arithmetic produced a nonfinite result; reduce parameter magnitude.",
          );
        return values;
      },
    );
    return { count, outputType: graph.outputType, values, expected };
  } finally {
    for (const buffer of buffers) buffer.destroy();
  }
}
