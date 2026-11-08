import { createWebSocketAdapter, type GameRuntimeScope } from "pelican-engine";

/** Native WebSocket is one possible transport; npm clients can use the same send/subscribe contract. */
export async function connectSocket(scope: GameRuntimeScope, url: string) {
  scope.signal.throwIfAborted();
  const socket = new WebSocket(url);
  const adapter = createWebSocketAdapter<{ value: number }, { value: number }>(
    scope,
    {
      id: "external-socket",
      version: "1",
      endpoint: socket,
      ownership: "owned",
      decode(value) {
        if (typeof value !== "string" || value.length > 16384)
          throw new Error(
            "SOCKET_PROTOCOL: Expected a JSON text message of at most 16384 characters.",
          );
        const record = JSON.parse(value);
        if (
          !record ||
          typeof record.value !== "number" ||
          !Number.isFinite(record.value)
        )
          throw new Error("SOCKET_PROTOCOL: Expected {value: finite number}.");
        return { value: record.value };
      },
      encode: JSON.stringify,
    },
  );
  try {
    await new Promise<void>((resolve, reject) => {
      const removers: (() => void)[] = [];
      const finish = (error?: unknown) => {
        clearTimeout(timer);
        for (const remove of removers) remove();
        error ? reject(error) : resolve();
      };
      const timer = setTimeout(
        () =>
          finish(
            new Error("SOCKET_TIMEOUT: Connection did not open in 8000ms"),
          ),
        8000,
      );
      removers.push(scope.listen(socket, "open", () => finish()));
      removers.push(
        scope.listen(socket, "error", () =>
          finish(new Error("SOCKET_OPEN: Connection failed")),
        ),
      );
      removers.push(
        scope.listen(socket, "close", () =>
          finish(new Error("SOCKET_CLOSED: Connection closed before ready")),
        ),
      );
      removers.push(
        scope.listen(scope.signal, "abort", () =>
          finish(new Error("SOCKET_CANCELLED: Game instance disposed")),
        ),
      );
      if (scope.signal.aborted)
        finish(new Error("SOCKET_CANCELLED: Game instance disposed"));
      else if (socket.readyState === WebSocket.OPEN) finish();
    });
    return adapter;
  } catch (error) {
    adapter.dispose();
    throw error;
  }
}
