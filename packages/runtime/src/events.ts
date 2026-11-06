import type { WorldAccess } from "./contracts.ts";
import { cloneSerializable, type JsonValue } from "./random.ts";

export type EventSource = "input" | "external" | "scheduled" | "system";
export interface RuntimeEvent {
  type: string;
  payload: JsonValue;
  tick: number;
  sequence: number;
  source: EventSource;
}
export interface EmitOptions {
  tick?: number;
  source?: EventSource;
}
export interface ListenerOptions {
  id?: string;
  access?: WorldAccess;
}
export interface EventFault {
  code: "TC_EVENT_LISTENER" | "TC_EVENT_ASYNC";
  listener: string;
  type: string;
  sequence: number;
  message: string;
}
export interface EventSnapshot {
  format: "pelican.events";
  version: 1;
  nextSequence: number;
  queue: RuntimeEvent[];
}
export interface DeliveryReport {
  delivered: number;
  notifications: number;
  faults: EventFault[];
}
export interface EventBusOptions {
  currentTick?: () => number;
  dispatch?: (id: string, access: WorldAccess, callback: () => void) => void;
  beforeEmit?: (event: RuntimeEvent) => void;
  beforeSubscribe?: () => void;
  onDelivery?: (events: RuntimeEvent[]) => void;
  defaultSource?: () => EventSource;
}

export function validateEventSnapshot(
  value: unknown,
  completedTick = 0,
): EventSnapshot {
  const data = cloneSerializable(value) as EventSnapshot;
  if (
    !data ||
    data.format !== "pelican.events" ||
    data.version !== 1 ||
    !Number.isSafeInteger(data.nextSequence) ||
    data.nextSequence < 0 ||
    !Array.isArray(data.queue)
  )
    throw new Error(
      "TC_EVENT_SNAPSHOT: Unsupported or malformed event snapshot.",
    );
  const sequences = new Set<number>();
  for (const e of data.queue) {
    if (
      !e ||
      typeof e.type !== "string" ||
      !e.type.trim() ||
      !Object.hasOwn(e, "payload") ||
      !Number.isSafeInteger(e.tick) ||
      e.tick <= completedTick ||
      !Number.isSafeInteger(e.sequence) ||
      e.sequence < 0 ||
      e.sequence >= data.nextSequence ||
      sequences.has(e.sequence) ||
      !["input", "external", "scheduled", "system"].includes(e.source)
    )
      throw new Error(
        "TC_EVENT_SNAPSHOT: Invalid queued event or duplicate sequence.",
      );
    sequences.add(e.sequence);
  }
  return data;
}

/** Due events are detached as a batch. Listener errors do not discard other
 * listeners/events: finish the batch, return all faults, scheduler then pauses.
 * Events emitted during delivery target a later tick, never recurse this batch. */
export function createEventBus(options: EventBusOptions = {}) {
  let queue: RuntimeEvent[] = [],
    nextSequence = 0,
    nextListener = 0,
    cursor = 0,
    delivering = false,
    disposed = false;
  const tick = () => Math.max(cursor, options.currentTick?.() ?? 0);
  const ensure = () => {
    if (disposed) throw new Error("TC_EVENT_DISPOSED: Event bus is disposed.");
  };
  const listeners = new Map<
    string,
    {
      type: string;
      callback: (event: RuntimeEvent) => unknown;
      access: WorldAccess;
    }
  >();
  return {
    on(
      type: string,
      callback: (event: RuntimeEvent) => unknown,
      config: ListenerOptions = {},
    ): () => void {
      ensure();
      options.beforeSubscribe?.();
      if (
        typeof type !== "string" ||
        !type.trim() ||
        typeof callback !== "function"
      )
        throw new Error("TC_EVENT_LISTENER: Expected event type and callback.");
      if (callback.constructor.name === "AsyncFunction")
        throw new Error("TC_EVENT_ASYNC: Listeners must be synchronous.");
      const id = config.id ?? `listener:${nextListener++}`;
      if (!id.trim() || listeners.has(id))
        throw new Error(
          `TC_EVENT_LISTENER: Duplicate or empty listener id ${id}.`,
        );
      const listener = {
        type,
        callback,
        access: cloneSerializable(config.access ?? {}),
      };
      listeners.set(id, listener);
      return () => {
        if (disposed) return;
        options.beforeSubscribe?.();
        if (listeners.get(id) === listener) listeners.delete(id);
      };
    },
    emit(
      type: string,
      payload: unknown,
      config: EmitOptions = {},
    ): RuntimeEvent {
      ensure();
      const target = config.tick ?? tick() + 1;
      const source = config.source ?? options.defaultSource?.() ?? "external";
      if (
        typeof type !== "string" ||
        !type.trim() ||
        !Number.isSafeInteger(target) ||
        target <= tick() ||
        !["input", "external", "scheduled", "system"].includes(source)
      )
        throw new Error(
          "TC_EVENT_EMIT: Expected a named event targeting a future integer tick.",
        );
      if (!Number.isSafeInteger(nextSequence + 1))
        throw new Error("TC_EVENT_LIMIT: Event sequence exhausted.");
      const event: RuntimeEvent = {
        type,
        payload: cloneSerializable(payload) as JsonValue,
        tick: target,
        sequence: nextSequence,
        source,
      };
      options.beforeEmit?.(cloneSerializable(event));
      queue.push(event);
      nextSequence++;
      return cloneSerializable(event);
    },
    deliver(targetTick: number): DeliveryReport {
      ensure();
      if (delivering)
        throw new Error("TC_EVENT_REENTRANT: Nested delivery is forbidden.");
      if (!Number.isSafeInteger(targetTick) || targetTick < tick())
        throw new Error(
          "TC_EVENT_TICK: Delivery requires a non-decreasing integer tick.",
        );
      const due = queue
        .filter((e) => e.tick <= targetTick)
        .sort((a, b) => a.tick - b.tick || a.sequence - b.sequence);
      queue = queue.filter((e) => e.tick > targetTick);
      const batchListeners = [...listeners];
      const report: DeliveryReport = {
        delivered: due.length,
        notifications: 0,
        faults: [],
      };
      delivering = true;
      cursor = targetTick;
      try {
        options.onDelivery?.(cloneSerializable(due));
        for (const event of due)
          for (const [id, listener] of batchListeners) {
            if (listener.type !== event.type) continue;
            let asynchronous = false;
            try {
              const call = () => {
                const result = listener.callback(cloneSerializable(event));
                if (
                  result &&
                  (typeof result === "object" ||
                    typeof result === "function") &&
                  "then" in result
                ) {
                  asynchronous = true;
                  void Promise.resolve(result).catch(() => {});
                  throw new Error(
                    "Event listeners must complete synchronously.",
                  );
                }
              };
              if (options.dispatch) options.dispatch(id, listener.access, call);
              else call();
            } catch (error) {
              report.faults.push({
                code: asynchronous ? "TC_EVENT_ASYNC" : "TC_EVENT_LISTENER",
                listener: id,
                type: event.type,
                sequence: event.sequence,
                message: error instanceof Error ? error.message : String(error),
              });
            }
            report.notifications++;
          }
      } finally {
        delivering = false;
      }
      return report;
    },
    snapshot(): EventSnapshot {
      ensure();
      return cloneSerializable({
        format: "pelican.events",
        version: 1,
        nextSequence,
        queue,
      });
    },
    restore(value: unknown, completedTick = tick()): void {
      ensure();
      if (delivering)
        throw new Error("TC_EVENT_REENTRANT: Cannot restore during delivery.");
      if (!Number.isSafeInteger(completedTick) || completedTick < 0)
        throw new Error("TC_EVENT_TICK: Invalid checkpoint tick.");
      const data = validateEventSnapshot(value, completedTick);
      queue = data.queue;
      nextSequence = data.nextSequence;
      cursor = completedTick;
    },
    inspect() {
      return {
        queued: queue.length,
        nextSequence,
        listeners: [...listeners].map(([id, listener]) => ({
          id,
          type: listener.type,
          access: cloneSerializable(listener.access),
        })),
      };
    },
    dispose(): void {
      if (delivering)
        throw new Error("TC_EVENT_REENTRANT: Cannot dispose during delivery.");
      queue = [];
      listeners.clear();
      disposed = true;
    },
  };
}
