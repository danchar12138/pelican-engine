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
import { diagnosticFrom, type RuntimeDiagnostic } from "./error.ts";

export interface HostOptions {
  fixedDt?: number;
  seed?: number;
}
export interface HostSnapshot {
  format: "threecat.host";
  version: 1;
  engineVersion: string;
  world: WorldSnapshot;
  scheduler: SchedulerSnapshot;
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
  private scheduler: RuntimeScheduler;
  private systemIdentity?: readonly SystemDefinition[];
  private bindings: { run: SystemDefinition["run"]; contract: string }[] = [];
  private game?: GameInstance;
  private readonly errors: RuntimeDiagnostic[] = [];
  private released = false;
  private readonly fixedDt: number;
  private readonly seed: number;

  constructor(ir: SceneIR, options: HostOptions = {}) {
    if (ir.format !== "threecat.scene" || ir.version !== 1)
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
    this.world = createWorld({
      components: ir.components.map((component) => ({
        id: component.id,
        schema: component.schema,
      })),
      entities: ir.scene.entities.map((entity) => ({
        id: entity.id,
        parent: entity.parent,
        transform: entity.transform,
        components: entity.components as Record<string, ComponentData>,
      })),
    });
    try {
      this.scheduler = createScheduler({
        world: this.world,
        fixedDt: this.fixedDt,
        seed: this.seed,
      });
    } catch (error) {
      this.world.dispose();
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
        this.assertAlive();
        return this.scheduler.random();
      },
      emit: (type, payload) => {
        this.assertAlive();
        this.scheduler.emit(type, payload, { source: "system" });
      },
      events: (type) => {
        this.assertAlive();
        return this.scheduler.events(type);
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
        spawn: (entity) => this.world.queue({ type: "spawn", entity }),
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
    const candidate = createScheduler({
      world: this.world,
      fixedDt: this.fixedDt,
      seed: this.seed,
      systems: systems.map((system) => {
        const run = system.run;
        return {
          ...metadata(system),
          run: (delta: number) => run(this.facade, delta),
        };
      }),
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
    this.assertAlive();
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

  step(count = 1): void {
    this.assertBoundary();
    if (!Number.isInteger(count) || count < 1 || count > 10000)
      throw new Error("TC_RUNTIME_STEPS: Expected count in [1,10000].");
    if (!this.game)
      throw new Error(
        "TC_RUNTIME_NOT_ATTACHED: Attach a compiled game before stepping.",
      );
    try {
      for (let i = 0; i < count; i++) {
        const previous = this.scheduler.tick;
        this.game.update(this.fixedDt);
        if (
          this.scheduler.tick !== previous + 1 ||
          this.scheduler.inspect().fault
        )
          throw new Error(
            "TC_RUNTIME_TICK_NOT_COMPLETED: Game update did not execute exactly one complete scheduler tick; state may be partial.",
          );
      }
    } catch (error) {
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
      throw error;
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
    return {
      engineVersion: SDK_VERSION,
      world: this.world.inspect(),
      records: this.released ? [] : this.world.records(),
      scheduler: this.scheduler.inspect(),
      diagnostics: structuredClone(this.errors),
      disposed: this.released,
    };
  }

  snapshot(): HostSnapshot {
    this.assertAlive();
    const scheduler = this.scheduler.snapshot();
    return {
      format: "threecat.host",
      version: 1,
      engineVersion: SDK_VERSION,
      world: structuredClone(scheduler.world),
      scheduler,
    };
  }

  restore(value: unknown): void {
    this.assertBoundary();
    const data = cloneSerializable(value) as HostSnapshot;
    if (
      !data ||
      data.format !== "threecat.host" ||
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
    // Scheduler preflights clock/random/events/contracts before atomically restoring the world.
    this.scheduler.restore(data.scheduler);
  }

  startRecording(): void {
    this.assertConfigured();
    this.scheduler.startRecording();
  }
  stopRecording(): SchedulerTrace {
    this.assertConfigured();
    return this.scheduler.stopRecording();
  }
  cancelRecording(): void {
    this.assertConfigured();
    this.scheduler.cancelRecording();
  }
  replay(trace: unknown): ReturnType<RuntimeScheduler["replay"]> {
    this.assertConfigured();
    const result = this.scheduler.replay(trace);
    if (result.status === "failed")
      this.errors.push(
        diagnosticFrom(
          new Error(`TC_REPLAY_DIVERGENCE: ${result.fault?.message}`),
        ),
      );
    return result;
  }

  dispose(): void {
    if (this.released) return;
    this.assertBoundary();
    try {
      this.game?.dispose();
    } finally {
      this.scheduler.dispose();
      this.world.dispose();
      this.released = true;
    }
  }
  private assertAlive(): void {
    if (this.released)
      throw new Error("TC_RUNTIME_DISPOSED: Create a new runtime host.");
  }
  private assertBoundary(): void {
    this.assertAlive();
    if (this.scheduler.inspect().running)
      throw new Error(
        "TC_RUNTIME_SAFE_POINT: Operation requires a tick boundary.",
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
