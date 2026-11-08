import type {
  EngineFacade,
  GameDefinition,
  GameInstance,
  GameRuntimeSnapshot,
  GameRuntimeState,
  JsonValue,
  SystemContext,
  SystemDefinition,
} from "./index.ts";
import { cloneJsonValue } from "../../schema/src/json-value.ts";

/** Internal implementation; public contracts live in index.ts. */
export function createGameInstance(
  game: GameDefinition,
  engine: EngineFacade,
): GameInstance {
  let status: NonNullable<GameInstance["status"]> = "initializing";
  let failure: unknown;
  let state: GameRuntimeState = {};
  let bindings: Readonly<Record<string, SystemDefinition["run"]>> = {};
  const controller = new AbortController();
  const releases: (() => void)[] = [];
  const owned = new WeakSet<object>();
  const sync = (operation: () => unknown, label: string) => {
    const result = operation();
    if (
      result &&
      (typeof result === "object" || typeof result === "function") &&
      "then" in result
    ) {
      void Promise.resolve(result).catch(() => {});
      throw new Error(
        `TC_GAME_RUNTIME_ASYNC: ${game.id}/${label} must be synchronous; await dependencies inside runtime.create.`,
      );
    }
  };
  const cleanup = () => {
    controller.abort();
    const errors: unknown[] = [];
    for (const release of releases.splice(0).reverse()) {
      try {
        sync(release, "dispose");
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length)
      throw new AggregateError(
        errors,
        `TC_GAME_RUNTIME_DISPOSE: ${game.id}; inspect cleanup causes and fix the registered release.`,
      );
  };
  const assertReady = () => {
    if (status === "disposed")
      throw new Error(
        `TC_RUNTIME_DISPOSED: ${game.id}; create a new game instance.`,
      );
    if (status === "failed") throw failure;
    if (status !== "ready")
      throw new Error(
        `TC_GAME_RUNTIME_NOT_READY: ${game.id}; await game.ready or host.stepAsync().`,
      );
  };
  const systems: SystemDefinition[] = (game.systems ?? []).map((declaration) =>
    game.runtime
      ? {
          ...declaration,
          run(ctx, dt) {
            assertReady();
            const run =
              bindings[declaration.id] ?? (declaration as SystemDefinition).run;
            sync(() => run(ctx, dt), `system:${declaration.id}`);
          },
        }
      : (declaration as SystemDefinition),
  );
  const install = (created: GameRuntimeState | void) => {
    const candidate = created ?? {};
    if (typeof candidate !== "object" || Array.isArray(candidate))
      throw new Error(
        `TC_GAME_RUNTIME_STATE: ${game.id}; create must return a runtime state object or void.`,
      );
    // A late async result still owns resources, even after dispose cancelled initialization.
    if (candidate.dispose) {
      if (status === "disposed") sync(() => candidate.dispose!(), "dispose");
      else releases.push(() => candidate.dispose!());
    }
    if (status === "disposed")
      throw new Error(
        `TC_RUNTIME_DISPOSED: ${game.id}; initialization was cancelled.`,
      );
    state = candidate;
    const hooks = [state.snapshot, state.validateSnapshot, state.restore];
    if (
      hooks.some(Boolean) &&
      !hooks.every(
        (hook) =>
          typeof hook === "function" && hook.constructor.name === "Function",
      )
    )
      throw new Error(
        `TC_GAME_RUNTIME_STATE: ${game.id}; supply snapshot, validateSnapshot and restore together.`,
      );
    bindings = Object.freeze(Object.assign(Object.create(null), state.systems));
    if (
      Object.keys(bindings).some(
        (id) => !systems.some((system) => system.id === id),
      )
    )
      throw new Error(
        `TC_GAME_RUNTIME_SYSTEM: ${game.id}; declare every runtime system ID in game.systems.`,
      );
    for (const [index, system] of systems.entries()) {
      const run =
        bindings[system.id] ?? (game.systems![index] as SystemDefinition).run;
      if (typeof run !== "function" || run.constructor.name !== "Function")
        throw new Error(
          `TC_GAME_RUNTIME_SYSTEM: ${game.id}/${system.id}; bind a synchronous ordinary run function in runtime.create.`,
        );
    }
    status = "ready";
  };
  const failed = (cause: unknown): never => {
    failure = new Error(
      `TC_GAME_RUNTIME_INIT: ${game.id}; fix runtime.create or its dependency. ${String(cause)}`,
      { cause },
    );
    if (status !== "disposed") {
      status = "failed";
      try {
        cleanup();
      } catch (error) {
        failure = new AggregateError(
          [failure, error],
          `TC_GAME_RUNTIME_INIT: ${game.id}; initialization and cleanup failed.`,
        );
      }
    }
    throw failure;
  };
  let ready: Promise<void>;
  // Configure immutable forwarding functions before async initialization so host.attach stays synchronous.
  engine.configureGameSystems?.(
    systems,
    game.runtime ? { version: game.runtime.version } : undefined,
  );
  try {
    if (
      game.runtime &&
      (typeof game.runtime.version !== "string" ||
        !game.runtime.version.trim() ||
        typeof game.runtime.create !== "function" ||
        !["Function", "AsyncFunction"].includes(
          game.runtime.create.constructor.name,
        ))
    )
      throw new Error(
        `TC_GAME_RUNTIME_CONTRACT: ${game.id}; supply a non-empty version and create(scope).`,
      );
    const created = game.runtime?.create({
      engine,
      signal: controller.signal,
      defer(release) {
        if (typeof release !== "function")
          throw new Error(
            `TC_GAME_RUNTIME_DISPOSE: ${game.id}; defer expects a release function.`,
          );
        if (controller.signal.aborted) sync(release, "dispose");
        else releases.push(release);
      },
      own(resource) {
        if (!resource || typeof resource.dispose !== "function")
          throw new Error(
            `TC_GAME_RUNTIME_DISPOSE: ${game.id}; own expects a disposable resource.`,
          );
        if (!owned.has(resource)) {
          owned.add(resource);
          if (controller.signal.aborted)
            sync(() => resource.dispose(), "dispose");
          else releases.push(() => resource.dispose());
        }
        return resource;
      },
    });
    if (created && "then" in created)
      ready = Promise.resolve(created).then(install).catch(failed);
    else {
      install(created);
      ready = Promise.resolve();
    }
  } catch (error) {
    try {
      failed(error);
    } catch (cause) {
      ready = Promise.reject(cause);
    }
  }
  // Hosts may dispose before a consumer awaits readiness; keep that rejection handled.
  void ready!.catch(() => {});
  const snapshot = (): GameRuntimeSnapshot | undefined => {
    assertReady();
    if (!game.runtime) return undefined;
    let payload: JsonValue = null;
    if (state.snapshot) {
      let value: JsonValue = null;
      sync(() => (value = state.snapshot!()), "snapshot");
      payload = cloneJsonValue(value);
    }
    return {
      format: "pelican.game-runtime",
      version: 1,
      game: game.id,
      runtimeVersion: game.runtime.version,
      payload,
    };
  };
  const validate = (value: unknown): GameRuntimeSnapshot | undefined => {
    assertReady();
    if (!game.runtime && value === undefined) return undefined;
    if (value === undefined)
      throw new Error(
        `TC_GAME_RUNTIME_SNAPSHOT: ${game.id}; checkpoint is missing author runtime state.`,
      );
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    )
      throw new Error(
        `TC_GAME_RUNTIME_SNAPSHOT: ${game.id}; expected an intact runtime checkpoint envelope.`,
      );
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = ["format", "version", "game", "runtimeVersion", "payload"];
    if (
      Reflect.ownKeys(value).length !== keys.length ||
      keys.some(
        (key) =>
          !descriptors[key] ||
          !("value" in descriptors[key]) ||
          !descriptors[key].enumerable,
      )
    )
      throw new Error(
        `TC_GAME_RUNTIME_SNAPSHOT: ${game.id}; expected a plain runtime checkpoint without accessors.`,
      );
    const data = Object.fromEntries(
      keys.map((key) => [key, descriptors[key]!.value]),
    ) as unknown as GameRuntimeSnapshot;
    if (
      !game.runtime ||
      !data ||
      data.format !== "pelican.game-runtime" ||
      data.version !== 1 ||
      data.game !== game.id ||
      data.runtimeVersion !== game.runtime.version
    )
      throw new Error(
        `TC_GAME_RUNTIME_SNAPSHOT: ${game.id}; restore a checkpoint with matching game and runtime version.`,
      );
    data.payload = cloneJsonValue(data.payload);
    if (state.validateSnapshot)
      sync(
        () => state.validateSnapshot!(cloneJsonValue(data.payload)),
        "validateSnapshot",
      );
    else if (data.payload !== null)
      throw new Error(
        `TC_GAME_RUNTIME_SNAPSHOT: ${game.id}; stateless runtime requires null payload.`,
      );
    return data;
  };
  const context = new Proxy(engine, {
    get(target, key, receiver) {
      if (
        ["time", "entities", "random", "emit", "events"].includes(String(key))
      )
        throw new Error(
          `TC_RUNTIME_SERVICE_UNAVAILABLE: ${String(key)} requires a pelican runtime host.`,
        );
      return Reflect.get(target, key, receiver);
    },
  }) as SystemContext;
  return {
    ready: ready!,
    get status() {
      return status;
    },
    snapshot,
    validateSnapshot(value) {
      validate(value);
    },
    restore(value) {
      const data = validate(value);
      if (data && state.restore)
        sync(() => state.restore!(cloneJsonValue(data.payload)), "restore");
    },
    update(dt) {
      assertReady();
      if (!Number.isFinite(dt) || dt < 0)
        throw new Error(
          "TC_RUNTIME_DT: Expected a finite, non-negative timestep.",
        );
      if (engine.runGameSystems) engine.runGameSystems(systems, dt);
      else for (const system of systems) system.run(context, dt);
    },
    dispose() {
      if (status === "disposed") return;
      status = "disposed";
      cleanup();
    },
  };
}
