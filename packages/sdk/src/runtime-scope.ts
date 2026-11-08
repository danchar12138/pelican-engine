import type { EngineFacade, GameRuntimeScope } from "./index.ts";
import { isAsyncValue, handleNativeRejection } from "./runtime-async.ts";

type Register = (release: () => void) => () => void;
const registrations = new WeakMap<GameRuntimeScope, Register>();
type ResourceOwners = WeakMap<
  object,
  { scope: GameRuntimeScope; label: string }
>;
// Compiled scene modules each contain an SDK copy; ownership must still be shared per realm.
const ownerKey = Symbol.for("pelican.runtime.external-resource-owners.v1");

export function claimRuntimeResource(
  scope: GameRuntimeScope,
  resource: object,
  label: string,
) {
  const realm = globalThis as typeof globalThis & {
    [ownerKey]?: ResourceOwners;
  };
  if (!realm[ownerKey])
    Object.defineProperty(realm, ownerKey, {
      value: new WeakMap(),
      enumerable: false,
    });
  const resourceOwners = realm[ownerKey]!;
  const previous = resourceOwners.get(resource);
  if (previous)
    throw new Error(
      `TC_GAME_RUNTIME_OWNERSHIP: ${label}; resource is already owned by ${previous.label}. Borrow it explicitly or use a separate resource.`,
    );
  const claim = { scope, label };
  resourceOwners.set(resource, claim);
  let target: object | undefined = resource;
  let record: typeof claim | undefined = claim;
  return () => {
    if (target && resourceOwners.get(target) === record)
      resourceOwners.delete(target);
    target = undefined;
    record = undefined;
  };
}

/** Internal early-release token; public defer keeps its original void contract. */
export function trackRuntimeRelease(
  scope: GameRuntimeScope,
  release: () => void,
) {
  const register = registrations.get(scope);
  if (register) return register(release);
  let active = true;
  let operation: (() => void) | undefined = release;
  const once = () => {
    if (active) {
      active = false;
      const cleanup = operation!;
      operation = undefined;
      cleanup();
    }
  };
  scope.defer(once);
  return once;
}

export function createRuntimeScope(engine: EngineFacade, id: string) {
  const controller = new AbortController();
  const releases = new Set<() => void>();
  const owned = new WeakMap<object, Function>();
  const pendingErrors: unknown[] = [];
  let disposed = false;
  const sync = (release: () => unknown) => {
    const result = release();
    if (isAsyncValue(result)) {
      handleNativeRejection(result);
      throw new Error(
        `TC_GAME_RUNTIME_ASYNC: ${id}/dispose must be synchronous; start asynchronous shutdown before releasing ownership.`,
      );
    }
  };
  const register: Register = (release) => {
    let active = true;
    let operation: (() => void) | undefined = release;
    const once = () => {
      if (!active) return;
      active = false;
      releases.delete(once);
      const cleanup = operation!;
      operation = undefined;
      sync(cleanup);
    };
    if (controller.signal.aborted) once();
    else releases.add(once);
    return once;
  };
  const scope: GameRuntimeScope = {
    engine,
    signal: controller.signal,
    cleanup(release) {
      if (typeof release !== "function")
        throw new Error(`TC_GAME_RUNTIME_DISPOSE: ${id}; cleanup expects a release function.`);
      return register(release);
    },
    defer(release) {
      if (typeof release !== "function")
        throw new Error(
          `TC_GAME_RUNTIME_DISPOSE: ${id}; defer expects a release function.`,
        );
      register(release);
    },
    own<T extends object>(resource: T, release?: (resource: T) => void): T {
      if (!resource || !["object", "function"].includes(typeof resource))
        throw new Error(
          `TC_GAME_RUNTIME_DISPOSE: ${id}; own expects an object and a synchronous release adapter.`,
        );
      const dispose =
        release === undefined
          ? (resource as { dispose?: () => void }).dispose
          : undefined;
      const identity = release ?? dispose;
      if (typeof identity !== "function")
        throw new Error(
          `TC_GAME_RUNTIME_DISPOSE: ${id}; supply dispose() or own(resource, release).`,
        );
      if (owned.has(resource)) {
        if (owned.get(resource) !== identity)
          throw new Error(
            `TC_GAME_RUNTIME_OWNERSHIP: ${id}; the same resource already has a different release adapter.`,
          );
        return resource;
      }
      const unclaim = claimRuntimeResource(scope, resource, id);
      owned.set(resource, identity);
      register(() => {
        try {
          return release ? release(resource) : dispose!.call(resource);
        } finally {
          unclaim();
        }
      });
      return resource;
    },
    listen(target, type, listener, options) {
      if (
        !target ||
        typeof target.addEventListener !== "function" ||
        typeof target.removeEventListener !== "function" ||
        typeof type !== "string" ||
        !type ||
        !listener ||
        (typeof listener !== "function" &&
          typeof listener.handleEvent !== "function")
      )
        throw new Error(
          `TC_GAME_RUNTIME_LISTENER: ${id}; supply an EventTarget, event type and listener.`,
        );
      const capture =
        typeof options === "boolean" ? options : !!options?.capture;
      const signal = typeof options === "object" ? options.signal : undefined;
      if (controller.signal.aborted || signal?.aborted) return () => {};
      let detach = () => {};
      const invoke: EventListener = (event) => {
        if (controller.signal.aborted && target !== controller.signal) return;
        if (typeof options === "object" && options.once) detach();
        try {
          if (typeof listener === "function") listener.call(target, event);
          else listener.handleEvent(event);
        } catch (error) {
          if (target === controller.signal && controller.signal.aborted)
            pendingErrors.push(error);
          else throw error;
        }
      };
      const cancelled = () => {
        try {
          detach();
        } catch (error) {
          pendingErrors.push(error);
        }
      };
      detach = register(() => {
        signal?.removeEventListener("abort", cancelled);
        target.removeEventListener(type, invoke, capture);
      });
      try {
        target.addEventListener(type, invoke, options);
        signal?.addEventListener("abort", cancelled, { once: true });
        if (controller.signal.aborted || signal?.aborted) detach();
      } catch (error) {
        try {
          detach();
        } catch (cleanup) {
          throw new AggregateError(
            [error, cleanup],
            `TC_GAME_RUNTIME_LISTENER: ${id}; registration and cleanup failed.`,
          );
        }
        throw error;
      }
      return detach;
    },
  };
  registrations.set(scope, register);
  return {
    scope,
    dispose() {
      if (disposed) return;
      disposed = true;
      controller.abort();
      const errors: unknown[] = pendingErrors.splice(0);
      const pending = [...releases].reverse();
      for (const release of pending)
        try {
          release();
        } catch (error) {
          errors.push(error);
        }
      if (errors.length)
        throw new AggregateError(
          errors,
          `TC_GAME_RUNTIME_DISPOSE: ${id}; inspect cleanup causes and fix the registered release.`,
        );
    },
  };
}
