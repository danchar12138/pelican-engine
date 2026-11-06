import { compileGraphDeclaration } from "../packages/compiler/src/graph.ts";
import { createComputeExecutor } from "../packages/renderer/src/compute-executor.ts";
import type { ComputeExecutionRequest } from "../packages/runtime/src/compute-contract.ts";
import type {
  Graph,
  GraphNode,
  GraphType,
  GraphValue,
} from "../packages/sdk/src/index.ts";

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw Error("TC_COMPUTE_PROBE: " + message);
}
function equal(actual: unknown, expected: unknown) {
  check(
    JSON.stringify(actual) === JSON.stringify(expected),
    JSON.stringify({ actual, expected }),
  );
}
function kernel(
  graph: Graph,
  type: GraphType,
  buffers: Record<string, GraphType> = {},
): ComputeExecutionRequest["kernel"] {
  const result = compileGraphDeclaration(graph, type, {
    domain: "compute",
    inputs: ["index"],
    buffers,
  });
  check(result.issues.length === 0, JSON.stringify(result.issues));
  return {
    id: "probe-" + type,
    count: 3,
    workgroupSize: 4,
    outputType: type,
    graph: result.graph,
    buffers: Object.entries(buffers).map(([name, type]) => ({ name, type })),
    source: {
      file: "managed-compute-gpu-probe.ts",
      line: 1,
      column: 1,
      length: 1,
    },
  };
}
function request(
  declaration: ComputeExecutionRequest["kernel"],
): ComputeExecutionRequest {
  return {
    kernel: declaration,
    inputs: {},
    output: {
      key: "output",
      type: declaration.outputType,
      count: declaration.count,
    },
    parameters: {},
    time: 2,
    signal: new AbortController().signal,
  };
}

/** Browser-only; exactly 20 dispatches of three invocations, no renderer/performance suite. */
export async function runManagedComputeGpuCases() {
  check(navigator.gpu, "WebGPU is required; no fallback is permitted.");
  const adapter = await navigator.gpu.requestAdapter({
    powerPreference: "high-performance",
    forceFallbackAdapter: false,
  });
  check(adapter, "No WebGPU adapter.");
  const info = adapter.info;
  const identity = [
    info.vendor,
    info.architecture,
    info.device,
    info.description,
  ].join(" ");
  check(
    identity.trim().length > 0,
    "Hardware adapter identity is unavailable.",
  );
  check(
    !info.isFallbackAdapter &&
      !/swiftshader|llvmpipe|software|lavapipe|warp|basic render/i.test(
        identity,
      ),
    "A hardware adapter is required: " + identity,
  );
  const device = await adapter.requestDevice();
  const executor = createComputeExecutor(device);
  const uncaptured: string[] = [];
  device.addEventListener("uncapturederror", (event) =>
    uncaptured.push(event.error.message),
  );
  const cases: { name: string; actual?: unknown }[] = [];
  const failures: string[] = [];
  try {
    for (const type of ["float", "vec2", "vec3", "vec4", "bool"] as const) {
      const makeValue = (n: number): GraphValue =>
        type === "bool"
          ? n % 2 === 1
          : type === "float"
            ? n
            : (Array.from(
                { length: Number(type[3]) },
                (_, i) => n + i,
              ) as unknown as GraphValue);
      const initial = [makeValue(1), makeValue(2), makeValue(3)];
      const step = makeValue(1),
        nextStep = makeValue(2);
      const nodes: GraphNode[] = [
        { id: "index", op: "input", name: "index" },
        { id: "old", op: "readBuffer", buffer: "state", inputs: ["index"] },
        { id: "step", op: "parameter", name: "step" },
        ...(type === "bool"
          ? [
              { id: "inverse", op: "not", inputs: ["old"] } as GraphNode,
              {
                id: "out",
                op: "select",
                inputs: ["old", "inverse", "step"],
              } as GraphNode,
            ]
          : [{ id: "out", op: "add", inputs: ["old", "step"] } as GraphNode]),
      ];
      const declaration = kernel(
        {
          nodes,
          output: "out",
          parameters: [{ name: "step", type, default: step }],
        },
        type,
        { state: type },
      );
      const key = "feedback-" + type;
      const req = {
        ...request(declaration),
        inputs: { state: { key, type, revision: 0, values: initial } },
        output: { key, type, count: 3 },
      };
      const add = (a: GraphValue, b: GraphValue): GraphValue =>
        typeof a === "boolean"
          ? b
            ? !a
            : a
          : typeof a === "number"
            ? a + (b as number)
            : (a.map(
                (n, i) => n + (b as readonly number[])[i],
              ) as unknown as GraphValue);
      const expected = initial.map((value) => add(value, step));
      const first = await executor.run(req);
      equal(first, expected);
      equal(req.inputs.state.values, initial);
      const uploaded = executor.inspect().uploads;
      const allocations = executor.inspect().allocations;
      equal(await executor.run(req), expected);
      equal(executor.inspect().uploads, uploaded);
      equal(executor.inspect().allocations, allocations + 4);
      equal(executor.inspect().liveBuffers, 1);
      const feedback = await executor.run({
        ...req,
        inputs: { state: { key, type, revision: 1, values: first } },
        parameters: { step: nextStep },
      });
      equal(
        feedback,
        expected.map((value) => add(value, nextStep)),
      );
      equal(executor.inspect().uploads, uploaded + 1);
      equal(executor.inspect().allocations, allocations + 8);
      executor.release(key);
      equal(executor.inspect().liveBuffers, 0);
      equal(executor.inspect().cachedInputs, 0);
      cases.push({
        name: type + "-arithmetic-feedback-cache-release",
        actual: feedback,
      });
    }
    const arithmetic = kernel(
      {
        nodes: [
          { id: "i", op: "input", name: "index" },
          { id: "t", op: "time" },
          { id: "out", op: "add", inputs: ["i", "t"] },
        ],
        output: "out",
      },
      "float",
    );
    equal(await executor.run(request(arithmetic)), [2, 3, 4]);
    cases.push({ name: "index-time", actual: [2, 3, 4] });

    const bounds = kernel(
      {
        parameters: [{ name: "index", type: "float", default: 0 }],
        nodes: [
          { id: "i", op: "parameter", name: "index" },
          { id: "out", op: "readBuffer", buffer: "state", inputs: ["i"] },
        ],
        output: "out",
      },
      "float",
      { state: "float" },
    );
    for (const index of [-1, 0.5, 3]) {
      const req = {
        ...request(bounds),
        inputs: {
          state: {
            key: "bounds",
            type: "float" as const,
            revision: 0,
            values: [1, 2, 3],
          },
        },
        parameters: { index },
      };
      let message = "";
      try {
        await executor.run(req);
      } catch (failure) {
        message = String(failure);
      }
      check(
        message.includes("TC_COMPUTE_BOUNDS"),
        "Bounds fault was not deterministic: " + message,
      );
      failures.push(message);
      equal(req.inputs.state.values, [1, 2, 3]);
      equal(executor.inspect().liveBuffers, 0);
    }
    const nonfinite = kernel(
      {
        parameters: [{ name: "large", type: "float", default: 1 }],
        nodes: [
          { id: "large", op: "parameter", name: "large" },
          { id: "two", op: "float", value: 2 },
          { id: "out", op: "multiply", inputs: ["large", "two"] },
        ],
        output: "out",
      },
      "float",
    );
    let nonfiniteMessage = "";
    try {
      await executor.run({
        ...request(nonfinite),
        parameters: { large: 3e38 },
      });
    } catch (failure) {
      nonfiniteMessage = String(failure);
    }
    check(
      nonfiniteMessage.includes("TC_COMPUTE_NONFINITE"),
      "Nonfinite result was not diagnosed: " + nonfiniteMessage,
    );
    failures.push(nonfiniteMessage);
    equal(executor.inspect().dispatches, 20);
    equal(executor.inspect().liveBuffers, 0);
    equal(uncaptured, []);
    executor.dispose();
    return {
      passed: true,
      backend: "webgpu",
      adapter: {
        vendor: info.vendor,
        architecture: info.architecture,
        device: info.device,
        description: info.description,
        isFallbackAdapter: info.isFallbackAdapter,
      },
      cases,
      failures,
      ownership: executor.inspect(),
      limitations: [
        "Small executor-only hardware check, not browser integration, M3 acceptance or a performance measurement.",
      ],
    };
  } finally {
    executor.dispose();
    device.destroy();
  }
}

/** Node-only launcher. Calling it requires the main agent's exclusive GPU slot. */
export async function runManagedComputeGpuProbe(
  output: string,
): Promise<unknown> {
  check(
    typeof output === "string" && output.length > 0,
    "An output directory is required.",
  );
  // Keep Node packages outside Vite's browser dependency scan of this same module.
  const importNode = (id: string) => import(/* @vite-ignore */ id);
  const { createServer }: typeof import("vite") = await importNode("vite");
  const { chromium }: typeof import("playwright") =
    await importNode("playwright");
  const {
    automationLaunchOptions,
    withAutomationDeadline,
  }: typeof import("./browser-session.ts") = await importNode(
    new URL("./browser-session.ts", import.meta.url).href,
  );
  const { fileURLToPath }: typeof import("node:url") =
    await importNode("node:url");
  const { mkdir, writeFile }: typeof import("node:fs/promises") =
    await importNode("node:fs/promises");
  const { join }: typeof import("node:path") = await importNode("node:path");
  const server = await createServer({
    configFile: false,
    root: fileURLToPath(new URL("../", import.meta.url)),
    server: { host: "127.0.0.1", port: 0 },
    logLevel: "error",
    plugins: [
      {
        name: "managed-compute-probe-page",
        configureServer(server) {
          server.middlewares.use((req, res, next) => {
            if (req.url !== "/__managed-compute-probe") return next();
            res.setHeader("Content-Type", "text/html");
            res.end("<!doctype html><title>Managed compute GPU probe</title>");
          });
        },
      },
    ],
  });
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    await server.listen();
    const address = server.httpServer!.address();
    check(address && typeof address !== "string", "Probe server did not bind.");
    browser = await chromium.launch(automationLaunchOptions());
    const page = await browser.newPage();
    await page.goto(
      "http://127.0.0.1:" + address.port + "/__managed-compute-probe",
    );
    const report = await withAutomationDeadline(
      () =>
        page.evaluate(async () => {
          const modulePath = "/tools/managed-compute-gpu-probe.ts";
          const { runManagedComputeGpuCases } = await import(
            /* @vite-ignore */ modulePath
          );
          return runManagedComputeGpuCases();
        }),
      60_000,
      "Managed compute hardware cases",
    );
    await mkdir(output, { recursive: true });
    await writeFile(
      join(output, "managed-compute-gpu.json"),
      JSON.stringify(report, null, 2) + "\n",
    );
    return report;
  } finally {
    try {
      await browser?.close();
    } finally {
      await server.close();
    }
  }
}

if (
  typeof process !== "undefined" &&
  process.argv[1]
    ?.replaceAll("\\", "/")
    .endsWith("/managed-compute-gpu-probe.ts")
) {
  if (!process.argv.includes("--exclusive-gpu")) {
    console.error(
      "TC_COMPUTE_PROBE: Wait for the exclusive GPU signal, then pass --exclusive-gpu.",
    );
    process.exitCode = 1;
  } else {
    const outputIndex = process.argv.indexOf("--output");
    const output =
      outputIndex >= 0
        ? process.argv[outputIndex + 1]
        : ".pelican/probes/managed-compute-gpu";
    runManagedComputeGpuProbe(output)
      .then((report) => {
        console.log(JSON.stringify(report, null, 2));
      })
      .catch((failure) => {
        console.error(String(failure));
        process.exitCode = 1;
      });
  }
}
