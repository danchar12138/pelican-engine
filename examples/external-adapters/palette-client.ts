import { createRuntimeAdapter, type GameRuntimeScope } from "pelican-engine";

export interface PaletteRequest {
  epoch: number;
  request: number;
}
export interface PaletteReply extends PaletteRequest {
  color: Float32Array;
}
export function connectPaletteWorker(scope: GameRuntimeScope) {
  scope.signal.throwIfAborted();
  const worker = new Worker(new URL("./palette-worker.ts", import.meta.url), {
    type: "module",
  });
  let released = false;
  const release = () => {
    if (!released) {
      released = true;
      worker.terminate();
    }
  };
  try {
    return createRuntimeAdapter<PaletteReply, PaletteRequest>(scope, {
      id: "palette-worker",
      version: "1",
      endpoint: worker,
      ownership: "owned",
      capacity: 16,
      release,
      decode(value) {
        const reply = value as PaletteReply;
        if (
          !reply ||
          !Number.isSafeInteger(reply.epoch) ||
          reply.epoch < 0 ||
          !Number.isSafeInteger(reply.request) ||
          reply.request < 0 ||
          !(reply.color instanceof Float32Array) ||
          reply.color.length !== 3 ||
          !reply.color.every(
            (channel) =>
              Number.isFinite(channel) && channel >= 0 && channel <= 1,
          )
        )
          throw new Error(
            "PALETTE_PROTOCOL: Expected epoch/request and three finite color channels.",
          );
        return reply;
      },
      send: (request) => worker.postMessage(request),
      subscribe(receive, fail) {
        const message = scope.listen(worker, "message", (event) =>
          receive((event as MessageEvent).data),
        );
        const error = scope.listen(worker, "error", (event) =>
          fail((event as ErrorEvent).message),
        );
        const malformed = scope.listen(worker, "messageerror", () =>
          fail("Worker message could not be decoded"),
        );
        return () => {
          malformed();
          error();
          message();
        };
      },
    });
  } catch (error) {
    release();
    throw error;
  }
}
