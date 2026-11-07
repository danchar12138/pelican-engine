import {
  SDK_VERSION,
  type ComponentData,
  type ComponentDefinition,
  type ComponentSchema,
  type ComponentValue,
  type GameInstance,
  type SystemContext,
  type SystemDefinition,
} from "../../sdk/src/index.ts";
import type { SceneIR } from "../../compiler/src/types.ts";
import { createWorld } from "./world.ts";
import {
  createScheduler,
  type RuntimeScheduler,
  type SchedulerSnapshot,
  type SchedulerTrace,
} from "./scheduler.ts";
import type { RuntimeWorld, WorldSnapshot } from "./contracts.ts";
import type { RuntimeEvent } from "./events.ts";
import { cloneSerializable } from "./random.ts";
import { resolveEntityDefinition } from "./prefabs.ts";
import { diagnosticFrom, type RuntimeDiagnostic } from "./error.ts";
import type {
  RuntimePlugin,
  RuntimePluginFactory,
  RuntimeServices,
} from "./plugins.ts";

export interface HostOptions {
  fixedDt?: number;
  seed?: number;
  plugins?: readonly RuntimePluginFactory[];
}
export interface HostPluginSnapshot {
  version?: string;
  payload: unknown;
}
export interface HostTrace extends SchedulerTrace {
  plugins?: {
    initial: Record<string, HostPluginSnapshot>;
    final: Record<string, HostPluginSnapshot>;
  };
}
export interface HostSnapshot {
  format: "pelican.host";
  version: 1;
  engineVersion: string;
  world: WorldSnapshot;
  scheduler: SchedulerSnapshot;
  plugins?: Record<string, HostPluginSnapshot>;
}

function canonical(value: unknown): string {
  const sorted = (item: unknown): unknown =>
    Array.isArray(item)
      ? item.map(sorted)
      : item && typeof item === "object"
        ? Object.fromEntries(
            Object.entries(item)
              .filter(([, v]) => v !== undefined)
              .sort(([a], [b]) => a.localeCompare(b, "en"))
              .map(([k, v]) => [k, sorted(v)]),
          )
        : item;
  return JSON.stringify(sorted(value));
}

function metadata(system: SystemDefinition | SceneIR["systems"][number]) {
  return {
    id: system.id,
    phase: system.phase ?? "update",
    before: [...(system.before ?? [])],
    after: [...(system.after ?? [])],
    ...(system.reads === undefined ? {} : { reads: [...system.reads] }),
    ...(system.writes === undefined ? {} : { writes: [...system.writes] }),
    ...(system.structural === undefined
      ? {}
      : { structural: system.structural }),
  };
}

/** Authoritative CPU world; renderers consume copies. A configuration change needs a new host. */
export class RuntimeHost {
  readonly world: RuntimeWorld;
  readonly facade: SystemContext;
  readonly scene: SceneIR;
  private scheduler!: RuntimeScheduler;
  private systemIdentity?: readonly SystemDefinition[];
  private bindings: { run: SystemDefinition["run"]; contract: string }[] = [];
  private game?: GameInstance;
  private readonly errors: RuntimeDiagnostic[] = [];
  private released = false;
  private readonly fixedDt: number;
  private readonly seed: number;
  private readonly plugins: RuntimePlugin[] = [];
  private readonly services: Partial<RuntimeServices> = {};
  private recordingPlugins?: Record<string, HostPluginSnapshot>;
  private asyncActive = false;
  private drivingAsync = false;
  private disposing = false;

  constructor(ir: SceneIR, options: HostOptions = {}) {
    if (ir.format !== "pelican.scene" || ir.version !== 1)
      throw new Error(
        "TC_RUNTIME_IR_VERSION: Unsupported scene representation.",
      );
    if (ir.engineVersion !== SDK_VERSION)
      throw new Error(
        "TC_RUNTIME_ENGINE_VERSION: Compiled content must match the active engine.",
      );
    this.fixedDt = options.fixedDt ?? 1 / 60;
    this.seed = options.seed ?? 12345;
    this.scene = structuredClone(ir);
    const world = createWorld({
      components: ir.components.map((component) => ({
        id: component.id,
        schema: component.schema,
      })),
      entities: ir.scene.entities.map((entity) => ({
        id: entity.id,
        prefab: entity.prefab,
        parent: entity.parent,
        transform: entity.transform,
        components: entity.components as Record<string, ComponentData>,
      })),
    });
    const mutations = new Set<keyof RuntimeWorld>([
      "registerComponent",
      "spawn",
      "destroy",
      "setTransform",
      "setComponent",
      "addComponent",
      "removeComponent",
      "queue",
      "flush",
      "runSystem",
      "restore",
      "dispose",
    ]);
    this.world = new Proxy(world, {
      get: (target, key: keyof RuntimeWorld) => {
        const value = target[key];
        if (!mutations.has(key)) return value;
        return (...args: unknown[]) => {
          this.assertAsyncMutation();
          return Reflect.apply(
            value as (...args: unknown[]) => unknown,
            target,
            args,
          );
        };
      },
    });
    let createdScheduler: RuntimeScheduler | undefined;
    try {
      createdScheduler = createScheduler({
        world: this.world,
        fixedDt: this.fixedDt,
        seed: this.seed,
        afterPhysics: () => this.afterPhysics(),
      });
      this.scheduler = createdScheduler;
      for (const factory of options.plugins ?? []) {
        const plugin = factory({
          fixedDt: this.fixedDt,
          getRopePhysicsBridge: () => this.plugins.find((plugin) => plugin.id === "$engine.physics")?.ropePhysicsBridge,
          world: this.world,
          scene: this.scene,
          events: (type) => this.scheduler.events(type),
          emit: (type, payload) =>
            this.scheduler.emit(type, payload, { source: "system" }),
        });
        this.registerPlugin(plugin);
      }
    } catch (error) {
      const failures: string[] = [];
      for (const plugin of [...this.plugins].reverse()) {
        try {
          plugin.dispose();
        } catch (disposeError) {
          failures.push(String(disposeError));
        }
      }
      try {
        createdScheduler?.dispose();
      } catch (disposeError) {
        failures.push(String(disposeError));
      }
      this.world.dispose();
      if (failures.length)
        throw new Error(
          `TC_PLUGIN_INIT: ${String(error)}; cleanup failures: ${failures.join("; ")}`,
        );
      throw error;
    }
    const host = this;
    const id = (component: string | ComponentDefinition) =>
      typeof component === "string" ? component : component.id;
    this.facade = {
      getTransform: (entity) => this.world.getTransform(entity),
      setTransform: (entity, value) => this.world.setTransform(entity, value),
      getComponent<S extends ComponentSchema>(
        entity: string,
        component: string | ComponentDefinition<S>,
      ): ComponentValue<S> & ComponentData {
        return host.world.getComponent(
          entity,
          id(component),
        ) as ComponentValue<S> & ComponentData;
      },
      setComponent: (
        entity: string,
        component: string | ComponentDefinition,
        value: ComponentData,
      ) => this.world.setComponent(entity, id(component), value),
      query: (component) => this.world.query(id(component)),
      runGameSystems: (systems, dt) => this.runSystems(systems, dt),
      configureGameSystems: (systems) => this.configureSystems(systems),
      get time() {
        host.assertAlive();
        return {
          tick: host.scheduler.tick,
          elapsed: host.scheduler.time,
          fixedDt: host.fixedDt,
        };
      },
      random: () => {
        this.assertMutation();
        return this.scheduler.random();
      },
      emit: (type, payload) => {
        this.assertMutation();
        this.scheduler.emit(type, payload, { source: "system" });
      },
      events: (type) => {
        this.assertAlive();
        return this.scheduler.events(type);
      },
      get input() {
        return host.service("input");
      },
      get physics() {
        return host.service("physics");
      },
      get animation() {
        return host.service("animation");
      },
      get camera() {
        return host.service("camera");
      },
      get ui() {
        return host.service("ui");
      },
      get audio() {
        return host.service("audio");
      },
      get storage() {
        return host.service("storage");
      },
      get scenes() {
        return host.service("scenes");
      },
      get render() {
        return host.service("render");
      },
      get compute() {
        return host.service("compute");
      },
      get navigation() {
        return host.service("navigation");
      },
      get ropes() {
        return host.service("ropes");
      },
      get cloth() {
        return host.service("cloth");
      },
      get fluid() {
        return host.service("fluid");
      },
      entities: {
        resolve: (entity) => this.world.resolve(entity),
        isAlive: (entity) => this.world.isAlive(entity),
        getTransform: (entity) => this.world.getTransform(entity),
        setTransform: (entity, value) => this.world.setTransform(entity, value),
        getComponent: (entity, component) =>
          this.world.getComponent(entity, component),
        setComponent: (entity, component, value) =>
          this.world.setComponent(entity, component, value),
        spawn: (entity) => {
          const captured = cloneSerializable(entity);
          if (captured.prefab !== undefined) {
            const definition = this.scene.prefabs.find(
              (entry) => entry.id === captured.prefab,
            );
            if (!definition)
              throw new Error("TC_PREFAB_MISSING: " + captured.prefab);
            this.world.queue({
              type: "spawn",
              entity: {
                id: captured.id,
                prefab: captured.prefab,
                ...(captured.parent === undefined
                  ? {}
                  : { parent: captured.parent }),
                transform: {
                  ...structuredClone(definition.transform),
                  ...captured.transform,
                },
                components: Object.fromEntries(
                  [
                    ...new Set([
                      ...Object.keys(definition.components),
                      ...Object.keys(captured.components ?? {}),
                    ]),
                  ].map((id) => [
                    id,
                    {
                      ...(definition.components[id] as ComponentData),
                      ...captured.components?.[id],
                    },
                  ]),
                ),
              },
            });
          } else this.world.queue({ type: "spawn", entity: captured });
        },
        destroy: (entity) => this.world.queue({ type: "destroy", entity }),
        addComponent: (entity, component, data) =>
          this.world.queue({
            type: "addComponent",
            entity,
            component,
            ...(data === undefined ? {} : { data }),
          }),
        removeComponent: (entity, component) =>
          this.world.queue({ type: "removeComponent", entity, component }),
      },
    };
  }

  private afterPhysics(): void {
    for (const plugin of this.plugins) {
      const result: unknown = plugin.afterPhysics?.();
      if (result && (typeof result === "object" || typeof result === "function") && "then" in result) {
        void Promise.resolve(result).catch(() => {});
        throw new Error(`TC_PLUGIN_ASYNC: afterPhysics for ${plugin.id} must complete synchronously.`);
      }
    }
  }

  private registerPlugin(plugin: RuntimePlugin): void {
    if (!plugin || typeof plugin !== "object")
      throw new Error("TC_PLUGIN_ID: Plugin must have a stable non-empty id.");
    if (this.plugins.some((entry) => entry.id === plugin.id))
      throw new Error(`TC_PLUGIN_DUPLICATE: Duplicate plugin id ${plugin.id}.`);
    this.plugins.push(plugin);
    if (typeof plugin.id !== "string" || !plugin.id.trim())
      throw new Error("TC_PLUGIN_ID: Plugin must have a stable non-empty id.");
    if (
      typeof plugin.snapshot !== "function" ||
      typeof plugin.validateSnapshot !== "function" ||
      typeof plugin.restore !== "function" ||
      typeof plugin.dispose !== "function" ||
      (plugin.settle !== undefined && typeof plugin.settle !== "function") ||
      (plugin.afterPhysics !== undefined && typeof plugin.afterPhysics !== "function")
    )
      throw new Error(
        `TC_PLUGIN_CONTRACT: Plugin ${plugin.id} is missing lifecycle methods.`,
      );
    for (const [key, service] of Object.entries(plugin.services ?? {})) {
      if (service === undefined) continue;
      if (this.services[key as keyof RuntimeServices] !== undefined)
        throw new Error(
          `TC_SERVICE_DUPLICATE: Multiple plugins provide ${key}.`,
        );
      const nested = new WeakMap<object, object>();
      const guarded = (value: object): object => {
        const previous = nested.get(value);
        if (previous) return previous;
        const proxy = new Proxy(value, {
          get: (target, property) => {
            const member = Reflect.get(target, property);
            if (key === "render" && (property === "effects" || property === "buffers" || property === "textures") && member && typeof member === "object") return guarded(member);
            if (typeof member !== "function") return member;
            return (...args: unknown[]) => {
              this.assertAsyncMutation();
              return Reflect.apply(member, target, args);
            };
          },
        });
        nested.set(value, proxy);
        return proxy;
      };
      this.services[key as keyof RuntimeServices] = guarded(service) as never;
    }
    for (const system of plugin.systems ?? [])
      if (!system.id.startsWith("$engine."))
        throw new Error(
          `TC_PLUGIN_SYSTEM_ID: Engine system ${system.id} must use the $engine. prefix.`,
        );
  }

  private service<K extends keyof RuntimeServices>(key: K): RuntimeServices[K] {
    this.assertMutation();
    const service = this.services[key];
    if (service === undefined)
      throw new Error(
        `TC_SERVICE_UNAVAILABLE: No runtime plugin provides '${key}'.`,
      );
    return service as RuntimeServices[K];
  }

  private pluginSnapshot(): Record<string, HostPluginSnapshot> {
    const result: Record<string, HostPluginSnapshot> = {};
    for (const plugin of this.plugins) {
      const payload = cloneSerializable(plugin.snapshot());
      const version = (plugin as RuntimePlugin & { version?: unknown }).version;
      if (version !== undefined && typeof version !== "string")
        throw new Error(
          `TC_PLUGIN_VERSION: Plugin ${plugin.id} version must be a string.`,
        );
      result[plugin.id] = {
        ...(version === undefined ? {} : { version }),
        payload,
      };
    }
    return result;
  }

  private validatePlugins(value: unknown): Record<string, HostPluginSnapshot> {
    const snapshots = cloneSerializable(value) as Record<
      string,
      HostPluginSnapshot
    >;
    if (!snapshots || typeof snapshots !== "object" || Array.isArray(snapshots))
      throw new Error("TC_PLUGIN_SNAPSHOT: Expected a plugin snapshot map.");
    for (const plugin of this.plugins) {
      if (!(plugin.id in snapshots) && plugin.legacySnapshot)
        snapshots[plugin.id] = { ...(plugin.version === undefined ? {} : { version: plugin.version }), payload: plugin.legacySnapshot() };
    }
    const ids = this.plugins.map((plugin) => plugin.id).sort();
    if (canonical(Object.keys(snapshots).sort()) !== canonical(ids))
      throw new Error(
        "TC_PLUGIN_SNAPSHOT_SET: Snapshot plugins do not match active plugins.",
      );
    for (const plugin of this.plugins) {
      const entry = snapshots[plugin.id];
      const version = (plugin as RuntimePlugin & { version?: unknown }).version;
      if (
        !entry ||
        typeof entry !== "object" ||
        !("payload" in entry) ||
        entry.version !== version
      )
        throw new Error(
          `TC_PLUGIN_SNAPSHOT_VERSION: Incompatible snapshot for plugin ${plugin.id}.`,
        );
      plugin.validateSnapshot(entry.payload);
    }
    for (const plugin of this.plugins) plugin.validatePeers?.(snapshots[plugin.id]!.payload, snapshots);
    return snapshots;
  }

  private restorePlugins(snapshots: Record<string, HostPluginSnapshot>): void {
    for (const plugin of this.plugins)
      plugin.restore(cloneSerializable(snapshots[plugin.id]!.payload));
  }

  attach(game: GameInstance): void {
    this.assertBoundary();
    if (
      !game ||
      typeof game.update !== "function" ||
      typeof game.dispose !== "function"
    )
      throw new Error("TC_RUNTIME_GAME: Expected a game instance.");
    if (this.game && this.game !== game)
      throw new Error(
        "TC_RUNTIME_GAME_CHANGED: Create a new host to replace a game; clock/state are not implicitly reset.",
      );
    if (!this.systemIdentity)
      throw new Error(
        "TC_RUNTIME_NOT_CONFIGURED: Instantiate the game with host.facade before attach.",
      );
    this.game = game;
  }

  private configureSystems(systems: readonly SystemDefinition[]): void {
    this.assertBoundary();
    if (this.systemIdentity) {
      this.assertSystems(systems);
      return;
    }
    if (this.scheduler.tick !== 0 || this.scheduler.inspect().recording)
      throw new Error(
        "TC_RUNTIME_SYSTEMS_CHANGED: Initial configuration requires a fresh host.",
      );
    const contracts = systems.map((system) => canonical(metadata(system)));
    if (
      canonical(contracts) !==
      canonical(this.scene.systems.map((system) => canonical(metadata(system))))
    )
      throw new Error(
        "TC_RUNTIME_SYSTEM_CONTRACT: Game system metadata must match compiled scene metadata.",
      );
    for (const system of systems)
      if (
        [
          "AsyncFunction",
          "GeneratorFunction",
          "AsyncGeneratorFunction",
        ].includes(system.run.constructor.name)
      )
        throw new Error(
          "TC_RUNTIME_SYSTEM_ASYNC: Systems must be synchronous functions.",
        );
    for (const system of systems) {
      if (system.id.startsWith("$engine."))
        throw new Error(
          "TC_RUNTIME_RESERVED_SYSTEM: Game system ids cannot use the $engine. prefix.",
        );
      if (
        [...(system.before ?? []), ...(system.after ?? [])].some((id) =>
          id.startsWith("$engine."),
        )
      )
        throw new Error(
          `TC_RUNTIME_RESERVED_SYSTEM: Game system ${system.id} cannot reference engine systems.`,
        );
    }
    const engineSystems = this.plugins.flatMap((plugin) => [
      ...(plugin.systems ?? []),
    ]);
    const allIds = new Set<string>();
    for (const system of [...engineSystems, ...systems]) {
      if (allIds.has(system.id))
        throw new Error(
          `TC_RUNTIME_SYSTEM_COLLISION: Duplicate system id ${system.id}.`,
        );
      allIds.add(system.id);
    }
    const gameInputIds = systems
      .filter((system) => (system.phase ?? "update") === "input")
      .map((system) => system.id);
    const gameSystems = systems.map((system) => {
      const run = system.run;
      return {
        ...metadata(system),
        run: (delta: number) => run(this.facade, delta),
      };
    });
    const candidate = createScheduler({
      world: this.world,
      fixedDt: this.fixedDt,
      seed: this.seed,
      afterPhysics: () => this.afterPhysics(),
      systems: [
        ...engineSystems.map((system) => ({
          ...system,
          ...(system.phase === "input" && gameInputIds.length
            ? { before: [...(system.before ?? []), ...gameInputIds] }
            : {}),
        })),
        ...gameSystems,
      ],
    });
    this.scheduler.dispose();
    this.scheduler = candidate;
    this.bindings = systems.map((system, index) => ({
      run: system.run,
      contract: contracts[index]!,
    }));
    this.systemIdentity = systems;
  }

  private assertSystems(systems: readonly SystemDefinition[]): void {
    if (
      systems !== this.systemIdentity ||
      systems.length !== this.bindings.length ||
      systems.some(
        (system, index) =>
          system.run !== this.bindings[index]!.run ||
          canonical(metadata(system)) !== this.bindings[index]!.contract,
      )
    )
      throw new Error(
        "TC_RUNTIME_SYSTEMS_CHANGED: System configuration is immutable; create a new host for reload.",
      );
  }

  private runSystems(systems: readonly SystemDefinition[], dt: number): void {
    this.assertMutation();
    if (
      !Number.isFinite(dt) ||
      dt < 0 ||
      (dt !== 0 && Math.abs(dt - this.fixedDt) > 1e-12)
    )
      throw new Error(
        "TC_RUNTIME_FIXED_DT: Host uses a configured fixed simulation interval.",
      );
    if (!this.systemIdentity) this.configureSystems(systems);
    else this.assertSystems(systems);
    if (dt === 0) return;
    const result = this.scheduler.step(1);
    if (result.status === "faulted")
      throw new Error(
        `TC_RUNTIME_SYSTEM: tick=${result.fault?.tick}, stage=${result.fault?.stage}, partialState=true; ${result.fault?.message}`,
      );
    if (result.executed !== 1 || result.status !== "completed")
      throw new Error(
        "TC_RUNTIME_TICK_NOT_COMPLETED: Scheduler did not execute one complete tick.",
      );
  }

  private validateStep(count: number): void {
    this.assertBoundary();
    if (!Number.isInteger(count) || count < 1 || count > 10000)
      throw new Error("TC_RUNTIME_STEPS: Expected count in [1,10000].");
    if (!this.game)
      throw new Error(
        "TC_RUNTIME_NOT_ATTACHED: Attach a compiled game before stepping.",
      );
  }

  private updateTick(): void {
    const previous = this.scheduler.tick;
    this.game!.update(this.fixedDt);
    if (this.scheduler.tick !== previous + 1 || this.scheduler.inspect().fault)
      throw new Error(
        "TC_RUNTIME_TICK_NOT_COMPLETED: Game update did not execute exactly one complete scheduler tick; state may be partial.",
      );
  }

  private recordStepFailure(error: unknown): void {
    const fault = this.scheduler.inspect().fault;
    const system = fault?.stage.startsWith("system:")
      ? fault.stage.slice(7)
      : undefined;
    const source = this.scene.systems.find(
      (item) => item.id === system,
    )?.source;
    this.errors.push(
      diagnosticFrom(error, {
        ...(system ? { system } : {}),
        ...(source ? { source } : {}),
      }),
    );
  }

  step(count = 1): void {
    this.validateStep(count);
    try {
      for (let i = 0; i < count; i++) this.updateTick();
    } catch (error) {
      this.recordStepFailure(error);
      throw error;
    }
  }

  async stepAsync(count = 1): Promise<void> {
    this.validateStep(count);
    this.asyncActive = true;
    try {
      for (let i = 0; i < count; i++) {
        this.assertAlive();
        this.drivingAsync = true;
        try {
          this.updateTick();
        } finally {
          this.drivingAsync = false;
        }
        await this.scheduler.settle(() => this.settlePlugins());
        this.assertAlive();
      }
    } catch (error) {
      this.recordStepFailure(error);
      throw error;
    } finally {
      this.asyncActive = false;
    }
  }

  private async settlePlugins(): Promise<void> {
    this.assertAlive();
    for (const plugin of this.plugins) {
      if (!plugin.settle) continue;
      try {
        await plugin.settle();
      } catch (error) {
        this.assertAlive();
        throw new Error(
          `TC_RUNTIME_SETTLE: Plugin ${plugin.id}; partialState=true; ${String(error)}`,
        );
      }
      this.assertAlive();
    }
  }

  /** External commands enqueue next-tick events, never mutate game state directly. */
  emitExternal(type: string, payload: unknown): RuntimeEvent {
    this.assertConfigured();
    if (
      typeof type !== "string" ||
      !type.trim() ||
      type.length > 128 ||
      /[\u0000-\u001f\u007f]/.test(type)
    )
      throw new Error(
        "TC_RUNTIME_INPUT: Event type must be 1..128 printable characters.",
      );
    const data = cloneSerializable(payload);
    if (
      JSON.stringify(data).length > 65536 ||
      this.scheduler.inspect().events.queued >= 4096
    )
      throw new Error(
        "TC_RUNTIME_INPUT_LIMIT: External event payload/queue limit exceeded.",
      );
    return this.scheduler.emit(type, data, { source: "external" });
  }

  input(key: string, pressed: boolean): RuntimeEvent {
    this.assertConfigured();
    if (
      typeof key !== "string" ||
      !key.length ||
      key.length > 64 ||
      /[\u0000-\u001f\u007f]/.test(key) ||
      typeof pressed !== "boolean"
    )
      throw new Error(
        "TC_RUNTIME_INPUT: Expected a 1..64 character key and boolean pressed state.",
      );
    return this.emitExternal("input.key", { key, pressed });
  }

  inspect() {
    const pluginStates: Record<string, unknown> = {};
    for (const plugin of this.plugins) {
      try {
        pluginStates[plugin.id] = cloneSerializable(plugin.inspect?.() ?? null);
      } catch (error) {
        pluginStates[plugin.id] = { error: String(error) };
      }
    }
    return {
      engineVersion: SDK_VERSION,
      world: this.world.inspect(),
      records: this.released ? [] : this.world.records(),
      scheduler: this.scheduler.inspect(),
      plugins: {
        ids: this.plugins.map((plugin) => plugin.id),
        states: pluginStates,
        services: Object.keys(this.services).sort(),
      },
      diagnostics: structuredClone(this.errors),
      disposed: this.released,
    };
  }

  snapshot(): HostSnapshot {
    this.assertBoundary();
    const scheduler = this.scheduler.snapshot();
    return {
      format: "pelican.host",
      version: 1,
      engineVersion: SDK_VERSION,
      world: structuredClone(scheduler.world),
      scheduler,
      ...(this.plugins.length ? { plugins: this.pluginSnapshot() } : {}),
    };
  }

  restore(value: unknown): void {
    this.assertBoundary();
    const data = cloneSerializable(value) as HostSnapshot;
    if (
      !data ||
      data.format !== "pelican.host" ||
      data.version !== 1 ||
      data.engineVersion !== SDK_VERSION ||
      !data.scheduler
    )
      throw new Error(
        "TC_RUNTIME_SNAPSHOT_VERSION: Incompatible host snapshot.",
      );
    if (canonical(data.world) !== canonical(data.scheduler.world))
      throw new Error(
        "TC_RUNTIME_SNAPSHOT_WORLD: Host and scheduler world snapshots disagree.",
      );
    if (!Array.isArray(data.world?.entities))
      throw new Error("TC_RUNTIME_SNAPSHOT_WORLD: Missing entity records.");
    for (const record of data.world.entities)
      resolveEntityDefinition(this.scene, record);
    let pluginSnapshots: Record<string, HostPluginSnapshot> | undefined;
    if (this.plugins.length) {
      if (data.plugins === undefined && this.plugins.some((plugin) => !plugin.legacySnapshot))
        throw new Error(
          "TC_PLUGIN_SNAPSHOT_SET: Plugin snapshots are required.",
        );
      pluginSnapshots = this.validatePlugins(data.plugins ?? {});
      for (const plugin of this.plugins)
        plugin.validateWorld?.(
          cloneSerializable(pluginSnapshots[plugin.id].payload),
          structuredClone(data.world),
        );
    } else if (data.plugins !== undefined) {
      if (
        !data.plugins ||
        typeof data.plugins !== "object" ||
        Array.isArray(data.plugins) ||
        Object.keys(data.plugins).length > 0
      )
        throw new Error(
          "TC_PLUGIN_SNAPSHOT_SET: Snapshot contains plugins but this host has none.",
        );
    }
    if (!pluginSnapshots && this.plugins.length)
      throw new Error("TC_PLUGIN_SNAPSHOT_SET: Plugin snapshots are required.");
    if (!this.plugins.length) {
      this.scheduler.restore(data.scheduler);
      return;
    }
    // A failed settle may leave in-flight sidecars, not a capturable checkpoint.
    // Recovery can restore a known-good checkpoint, but cannot roll back to it.
    const faulted = this.scheduler.inspect().fault !== null;
    const previousScheduler = faulted ? undefined : this.scheduler.snapshot();
    const previousPlugins =
      !faulted && this.plugins.length ? this.pluginSnapshot() : undefined;
    try {
      this.scheduler.restore(data.scheduler);
      if (pluginSnapshots) this.restorePlugins(pluginSnapshots);
    } catch (error) {
      const rollbackErrors: string[] = [];
      if (previousScheduler) {
        try {
          this.scheduler.restore(previousScheduler);
        } catch (rollbackError) {
          rollbackErrors.push(String(rollbackError));
        }
      } else
        rollbackErrors.push(
          "No successful checkpoint exists for the faulted state; restore a known-good checkpoint again.",
        );
      if (previousPlugins) {
        for (const plugin of this.plugins) {
          try {
            plugin.restore(
              cloneSerializable(previousPlugins[plugin.id]!.payload),
            );
          } catch (rollbackError) {
            rollbackErrors.push(`${plugin.id}: ${String(rollbackError)}`);
          }
        }
      }
      const partial = rollbackErrors.length > 0;
      const wrapped = new Error(
        `TC_PLUGIN_RESTORE: ${String(error)}${partial ? `; partialState=true; rollback failures: ${rollbackErrors.join("; ")}` : "; previous state restored."}`,
      );
      this.errors.push(diagnosticFrom(wrapped));
      throw wrapped;
    }
  }

  startRecording(): void {
    this.assertConfigured();
    this.recordingPlugins = this.plugins.length
      ? this.pluginSnapshot()
      : undefined;
    this.scheduler.startRecording();
  }
  stopRecording(): HostTrace {
    this.assertConfigured();
    const trace = this.scheduler.stopRecording() as HostTrace;
    if (this.recordingPlugins) {
      trace.plugins = {
        initial: this.recordingPlugins,
        final: this.pluginSnapshot(),
      };
    }
    this.recordingPlugins = undefined;
    return trace;
  }
  cancelRecording(): void {
    this.assertConfigured();
    this.recordingPlugins = undefined;
    this.scheduler.cancelRecording();
  }
  private preflightReplay(trace: unknown) {
    const data = this.scheduler.preflightReplay(trace) as HostTrace;
    for (const snapshot of [data.initial, data.final])
      for (const entity of snapshot.world.entities)
        resolveEntityDefinition(this.scene, entity);
    let initial: Record<string, HostPluginSnapshot> | undefined;
    let final: Record<string, HostPluginSnapshot> | undefined;
    if (this.plugins.length) {
      if (!data.plugins)
        throw new Error(
          "TC_PLUGIN_TRACE_REQUIRED: Trace does not contain plugin state.",
        );
      initial = this.validatePlugins(data.plugins.initial);
      final = this.validatePlugins(data.plugins.final);
      for (const plugin of this.plugins) {
        plugin.validateWorld?.(
          cloneSerializable(initial[plugin.id].payload),
          structuredClone(data.initial.world),
        );
        plugin.validateWorld?.(
          cloneSerializable(final[plugin.id].payload),
          structuredClone(data.final.world),
        );
      }
    } else if (data.plugins) {
      for (const snapshots of [data.plugins.initial, data.plugins.final])
        if (
          !snapshots ||
          typeof snapshots !== "object" ||
          Array.isArray(snapshots) ||
          Object.keys(snapshots).length
        )
          throw new Error(
            "TC_PLUGIN_TRACE_SET: Trace requires plugins not present in this host.",
          );
    }
    return { data, initial, final };
  }

  private checkReplay(
    result: ReturnType<RuntimeScheduler["replay"]>,
    final?: Record<string, HostPluginSnapshot>,
  ) {
    if (
      result.status === "passed" &&
      final &&
      canonical(this.pluginSnapshot()) !== canonical(final)
    )
      throw new Error("TC_REPLAY_DIVERGENCE: Final plugin state differs.");
    if (result.status === "failed")
      this.errors.push(
        diagnosticFrom(
          new Error(
            result.fault?.code === "TC_SCHEDULER_SETTLE"
              ? result.fault.message
              : `TC_REPLAY_DIVERGENCE: ${result.fault?.message}`,
          ),
        ),
      );
    return result;
  }

  replay(trace: unknown): ReturnType<RuntimeScheduler["replay"]> {
    this.assertConfigured();
    try {
      if (this.plugins.some((plugin) => plugin.settle !== undefined))
        throw new Error(
          "TC_RUNTIME_REPLAY_ASYNC_REQUIRED: Use replayAsync for plugins with settle boundaries.",
        );
      const { data, initial, final } = this.preflightReplay(trace);
      if (initial) this.restorePlugins(initial);
      return this.checkReplay(this.scheduler.replay(data), final);
    } catch (error) {
      this.errors.push(diagnosticFrom(error));
      return { status: "failed", actionsExecuted: 0, fault: null };
    }
  }

  async replayAsync(
    trace: unknown,
  ): Promise<ReturnType<RuntimeScheduler["replay"]>> {
    this.assertConfigured();
    try {
      const { data, initial, final } = this.preflightReplay(trace);
      if (initial) this.restorePlugins(initial);
      this.asyncActive = true;
      this.drivingAsync = true;
      let pending: ReturnType<RuntimeScheduler["replayAsync"]>;
      try {
        pending = this.scheduler.replayAsync(data, () => {
          this.drivingAsync = false;
          return this.settlePlugins();
        });
      } finally {
        this.drivingAsync = false;
      }
      const result = await pending;
      this.assertAlive();
      return this.checkReplay(result, final);
    } catch (error) {
      this.errors.push(diagnosticFrom(error));
      return { status: "failed", actionsExecuted: 0, fault: null };
    } finally {
      this.asyncActive = false;
    }
  }

  dispose(): void {
    if (this.released || this.disposing) return;
    this.assertAlive();
    if (this.scheduler.inspect().running)
      throw new Error(
        "TC_RUNTIME_SAFE_POINT: Operation requires a tick boundary.",
      );
    this.disposing = true;
    const failures: unknown[] = [];
    try {
      this.game?.dispose();
    } catch (error) {
      failures.push(error);
    }
    for (const plugin of [...this.plugins].reverse()) {
      try {
        plugin.dispose();
      } catch (error) {
        failures.push(error);
      }
    }
    try {
      this.scheduler.dispose();
    } catch (error) {
      failures.push(error);
    }
    try {
      this.world.dispose();
    } catch (error) {
      failures.push(error);
    }
    this.released = true;
    this.disposing = false;
    if (failures.length) {
      for (const error of failures) this.errors.push(diagnosticFrom(error));
      throw new AggregateError(
        failures,
        `TC_RUNTIME_DISPOSE: ${failures.map(String).join("; ")}`,
      );
    }
  }
  private assertAlive(): void {
    if (this.released)
      throw new Error("TC_RUNTIME_DISPOSED: Create a new runtime host.");
  }
  private assertBoundary(): void {
    this.assertAlive();
    if (this.asyncActive)
      throw new Error(
        "TC_RUNTIME_ASYNC_ACTIVE: An async step/replay is pending.",
      );
    if (this.scheduler.inspect().running)
      throw new Error(
        "TC_RUNTIME_SAFE_POINT: Operation requires a tick boundary.",
      );
  }
  private assertMutation(): void {
    this.assertAlive();
    this.assertAsyncMutation();
  }
  private assertAsyncMutation(): void {
    if (
      !this.released &&
      this.asyncActive &&
      !this.drivingAsync &&
      !this.disposing &&
      !this.scheduler.inspect().running
    )
      throw new Error(
        "TC_RUNTIME_ASYNC_ACTIVE: An async step/replay is pending.",
      );
  }
  private assertConfigured(): void {
    this.assertBoundary();
    if (!this.systemIdentity)
      throw new Error(
        "TC_RUNTIME_NOT_CONFIGURED: Instantiate matching game systems first.",
      );
  }
}
