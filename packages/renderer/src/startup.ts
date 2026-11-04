export function startupPolicy(development: boolean, search: string) {
  const automation =
    development && new URLSearchParams(search).get("automation") === "1";
  return { automation, playing: !automation };
}

/** Explicit progress deadline; startup and commands never require a user focus/key event. */
export async function boundedOperation<T>(
  promise: PromiseLike<T>,
  label: string,
  timeoutMs = 30000,
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
                `TC_GPU_TIMEOUT: ${label} did not complete within ${timeoutMs} ms; no click or key is required to continue.`,
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
  return `threecat · ${data.mode}\nWebGPU · ${data.triangles} triangles · tick ${data.tick}\n${state}`;
}
