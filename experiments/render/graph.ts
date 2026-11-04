import * as TSL from "three/tsl";
import type { GraphIR } from "../compiler/types.ts";

/** Internal translators for the deliberately small, compiler-validated M0 graph subset. */
export function graphToTSL(
  graph: GraphIR,
  time: ReturnType<typeof TSL.uniform>,
) {
  const values = new Map<string, any>();
  const visit = (id: string): any => {
    if (values.has(id)) return values.get(id);
    const node = graph.nodes.find((n) => n.id === id);
    if (!node) throw new Error(`TC_GRAPH_NODE:${id}`);
    let result: any;
    if (node.op === "float") result = TSL.float(node.value);
    else if (node.op === "vec3") result = TSL.vec3(...node.value);
    else if (node.op === "time") result = time;
    else if (node.op === "sin") result = TSL.sin(visit(node.inputs[0]));
    else if (node.op === "add")
      result = TSL.add(visit(node.inputs[0]), visit(node.inputs[1]));
    else result = TSL.mul(visit(node.inputs[0]), visit(node.inputs[1]));
    values.set(id, result);
    return result;
  };
  return visit(graph.output);
}
export function evaluateGraph(graph: GraphIR, time: number): number | number[] {
  const memo = new Map<string, number | number[]>();
  const visit = (id: string): number | number[] => {
    if (memo.has(id)) return memo.get(id)!;
    const n = graph.nodes.find((n) => n.id === id)!;
    let result: number | number[];
    if (n.op === "float" || n.op === "vec3")
      result = typeof n.value === "number" ? n.value : [...n.value];
    else if (n.op === "time") result = time;
    else if (n.op === "sin") {
      const a = visit(n.inputs[0]);
      result = typeof a === "number" ? Math.sin(a) : a.map(Math.sin);
    } else {
      const a = visit(n.inputs[0]),
        b = visit(n.inputs[1]);
      const op = (x: number, y: number) => (n.op === "add" ? x + y : x * y);
      result =
        typeof a === "number" && typeof b === "number"
          ? op(a, b)
          : Array.from({ length: 3 }, (_, i) =>
              op(
                typeof a === "number" ? a : a[i],
                typeof b === "number" ? b : b[i],
              ),
            );
    }
    memo.set(id, result);
    return result;
  };
  return visit(graph.output);
}
export async function runComputeGraph(
  device: GPUDevice,
  graph: GraphIR,
  count: number,
  workgroupSize: number,
  time: number,
) {
  if (!Number.isInteger(count) || count < 1 || count > 65536)
    throw new Error("TC_COMPUTE_COUNT");
  if (
    !Number.isInteger(workgroupSize) ||
    workgroupSize < 1 ||
    workgroupSize > 256
  )
    throw new Error("TC_COMPUTE_WORKGROUP");
  const float = (v: number) => (Number.isInteger(v) ? `${v}.0` : String(v));
  const memo = new Map<string, string>();
  const lines: string[] = [];
  const visit = (id: string): string => {
    if (memo.has(id)) return memo.get(id)!;
    const n = graph.nodes.find((n) => n.id === id)!;
    const symbol = `v${memo.size}`;
    memo.set(id, symbol);
    let expression: string;
    if (n.op === "float") expression = float(n.value);
    else if (n.op === "vec3")
      expression = `vec3f(${n.value.map(float).join(",")})`;
    else if (n.op === "time") expression = "params.x";
    else if (n.op === "sin") expression = `sin(${visit(n.inputs[0])})`;
    else
      expression = `(${visit(n.inputs[0])}${n.op === "add" ? "+" : "*"}${visit(n.inputs[1])})`;
    lines.push(`let ${symbol} = ${expression};`);
    return symbol;
  };
  const output = visit(graph.output);
  const source = `@group(0) @binding(0) var<storage,read_write> result:array<vec4f>; @group(0) @binding(1) var<uniform> params:vec4f; @compute @workgroup_size(${workgroupSize}) fn main(@builtin(global_invocation_id) id:vec3u){if(id.x>=${count}u){return;} ${lines.join("\n")} result[id.x]=${graph.outputType === "float" ? `vec4f(${output},0,0,1)` : `vec4f(${output},1)`};}`;
  device.pushErrorScope("validation");
  const module = device.createShaderModule({ code: source });
  const pipeline = await device.createComputePipelineAsync({
    layout: "auto",
    compute: { module, entryPoint: "main" },
  });
  const buffer = device.createBuffer({
    size: count * 16,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  });
  const uniform = device.createBuffer({
    size: 16,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  const read = device.createBuffer({
    size: count * 16,
    usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
  });
  try {
    device.queue.writeBuffer(uniform, 0, new Float32Array([time, 0, 0, 0]));
    const group = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer } },
        { binding: 1, resource: { buffer: uniform } },
      ],
    });
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, group);
    pass.dispatchWorkgroups(Math.ceil(count / workgroupSize));
    pass.end();
    encoder.copyBufferToBuffer(buffer, 0, read, 0, count * 16);
    device.queue.submit([encoder.finish()]);
    await read.mapAsync(GPUMapMode.READ);
    const result = Array.from(new Float32Array(read.getMappedRange()));
    read.unmap();
    const error = await device.popErrorScope();
    if (error) throw new Error(`TC_COMPUTE_GPU:${error.message}`);
    return {
      count,
      outputType: graph.outputType,
      values: result,
      expected: evaluateGraph(graph, time),
    };
  } finally {
    buffer.destroy();
    uniform.destroy();
    read.destroy();
  }
}
