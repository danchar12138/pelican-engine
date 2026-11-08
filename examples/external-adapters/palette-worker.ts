const worker = globalThis as unknown as {
  onmessage:
    | ((event: MessageEvent<{ epoch: number; request: number }>) => void)
    | null;
  postMessage(value: unknown, transfer: Transferable[]): void;
};
worker.onmessage = (event) => {
  const { epoch, request } = event.data;
  const color = new Float32Array([
    0.15 + (request % 3) * 0.2,
    0.65,
    0.85 - (request % 3) * 0.2,
  ]);
  worker.postMessage({ epoch, request, color }, [color.buffer]);
};
