export function startupPolicy(development: boolean, search: string) {
  const automation =
    development && new URLSearchParams(search).get("automation") === "1";
  return { automation, playing: !automation };
}

/** Diagnostic descriptions distinguish capability from lazy renderer allocation. */
export function inspectTraceCapabilities(data: {
  backend: "webgpu" | "webgl2" | "uninitialized";
  legacyProbe: boolean;
  surfaceInitialized: boolean;
  gameplay: boolean;
  maxBounces: number;
}) {
  const compute = data.backend === "webgpu";
  const legacy = compute && data.legacyProbe;
  const modern = compute && !data.legacyProbe;
  return {
    tracer: !compute ? false : legacy ? "legacy software-triangle-BVH" : data.surfaceInitialized ? "WebGPU surface triangle-BVH" : "WebGPU surface triangle-BVH (lazy initialization)",
    tracerInitialized: compute && (legacy || data.surfaceInitialized),
    hardwareRT: false,
    denoiser: modern ? "motion-reprojected temporal history + spatial a-trous; complete quality matrix unaccepted" : false,
    hybrid: !compute ? false : legacy ? "legacy raster + traced image compositing prototype" : "raster primary visibility + actual shadow and secondary rays",
    pathBounces: data.maxBounces,
    tracedLights: !compute ? false : legacy ? "legacy first authored light only" : "all captured point/spot/directional/ambient/hemisphere lights",
    textures: data.gameplay ? (modern ? "supported GLB PBR textures in raster and surface tracing; see documented limits" : "GLB PBR and base-color textures in raster") : "no authored texture assets",
    experimentalProbes: "Four small CPU simulations and finite world probe are M0 debug sidecars, not M1 production modules",
  };
}

/** Explicit progress deadline; startup and commands never require a user focus/key event. */
export async function boundedOperation<T>(
  promise: PromiseLike<T>,
  label: string,
  timeoutMs = 30000,
  code: "TC_GPU_TIMEOUT" | "TC_MODULE_TIMEOUT" | "TC_ASSET_DECODE_TIMEOUT" = "TC_GPU_TIMEOUT",
): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
    throw new Error("TC_GPU_TIMEOUT_CONFIG: Invalid timeout.");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve(promise),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                `${code}: ${label} did not complete within ${timeoutMs} ms; no click or key is required to continue.`,
              ),
            ),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export function runtimeStatus(data: {
  backend?: "webgpu" | "webgl2" | "uninitialized";
  mode: string;
  playing: boolean;
  automation: boolean;
  tick: number;
  triangles: number;
  faulted?: boolean;
}) {
  const state = data.faulted
    ? "faulted"
    : data.playing
      ? "running"
      : data.automation
        ? "paused · automation"
        : "paused";
  const backend = data.backend === "webgl2" ? "WebGL2" : data.backend === "uninitialized" ? "Initializing" : "WebGPU";
  return `Pelican Engine · ${data.mode}\n${backend} · ${data.triangles} triangles · tick ${data.tick}\n${state}`;
}
