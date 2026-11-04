import {
  SYSTEM_PHASES,
  type RuntimeWorld,
  type ScheduledSystem,
  type SystemPhase,
  type WorldSnapshot,
} from "./contracts.ts";
import {
  createEventBus,
  validateEventSnapshot,
  type EventFault,
  type EventSnapshot,
  type RuntimeEvent,
} from "./events.ts";
import {
  cloneSerializable,
  createRandom,
  validateRandomSnapshot,
  type RandomSnapshot,
} from "./random.ts";
import {
  cloneSchema,
  identifier,
  record as worldRecord,
  values,
} from "./storage.ts";
import type { ComponentData, ComponentSchema } from "../../sdk/src/index.ts";

export interface SchedulerOptions {
  world: RuntimeWorld;
  systems?: readonly ScheduledSystem[];
  fixedDt?: number;
  maxSubsteps?: number;
  seed?: number;
}
export interface SystemDescriptor {
  id: string;
  phase: SystemPhase;
  before: string[];
  after: string[];
  reads?: string[];
  writes?: string[];
  structural?: boolean;
}
export interface SchedulerDiagnostic {
  code: "TC_SCHEDULER_CONFLICT";
  first: string;
  second: string;
  resources: string[];
  message: string;
}
export interface SchedulerFault {
  code: "TC_SCHEDULER_TICK" | "TC_SCHEDULER_LISTENER" | "TC_REPLAY_DIVERGENCE";
  tick: number;
  stage: string;
  message: string;
  partialState: true;
  eventFaults: EventFault[];
}
export interface SchedulerSnapshot {
  format: "threecat.scheduler";
  version: 1;
  fixedDt: number;
  maxSubsteps: number;
  tick: number;
  time: number;
  accumulator: number;
  compensation: number;
  paused: boolean;
  systems: SystemDescriptor[];
  listeners: ReturnType<
    ReturnType<typeof createEventBus>["inspect"]
  >["listeners"];
  world: WorldSnapshot;
  random: RandomSnapshot;
  events: EventSnapshot;
  delivered: RuntimeEvent[];
}
export type TraceAction =
  | { kind: "step"; count: number; atTick: number }
  | { kind: "advance"; seconds: number; atTick: number }
  | { kind: "pause" | "resume"; atTick: number }
  | { kind: "random"; value: number; atTick: number }
  | { kind: "emit"; event: RuntimeEvent; atTick: number };
/** Records external driver calls/input submissions, not arbitrary closure state,
 * wall-clock IO or GPU results. Replay requires matching system implementations
 * and registered listeners. Internal emissions/draws are regenerated per tick. */
export interface SchedulerTrace {
  format: "threecat.trace";
  version: 1;
  initial: SchedulerSnapshot;
  actions: TraceAction[];
  final: SchedulerSnapshot;
}
export interface StepReport {
  status: "completed" | "backlogged" | "paused" | "faulted";
  executed: number;
  tick: number;
  time: number;
  backlogTicks: number;
  backlogSeconds: number;
  interpolationAlpha: number;
  budgetExhausted: boolean;
  acceptedSeconds: number;
  ignoredSeconds: number;
  fault: SchedulerFault | null;
}

function integer(value: number, label: string, minimum = 0): void {
  if (!Number.isSafeInteger(value) || value < minimum)
    throw new Error(
      `TC_SCHEDULER_ARGUMENT: ${label} must be a safe integer >= ${minimum}.`,
    );
}
function seconds(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0)
    throw new Error(
      `TC_SCHEDULER_ARGUMENT: ${label} must be finite and non-negative.`,
    );
}
function canonical(value: unknown): string {
  const sort = (item: unknown): unknown =>
    Array.isArray(item)
      ? item.map(sort)
      : item && typeof item === "object"
        ? Object.fromEntries(
            Object.entries(item)
              .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
              .map(([key, val]) => [key, sort(val)]),
          )
        : item;
  return JSON.stringify(sort(value));
}

function schedule(input: readonly ScheduledSystem[]) {
  if (!Array.isArray(input))
    throw new Error("TC_SCHEDULER_SYSTEM: Expected a system array.");
  const systems = input.map((system) => {
    if (
      !system ||
      typeof system.id !== "string" ||
      !system.id.trim() ||
      typeof system.run !== "function"
    )
      throw new Error(
        "TC_SCHEDULER_SYSTEM: Expected a named synchronous system.",
      );
    if (system.run.constructor.name === "AsyncFunction")
      throw new Error("TC_SCHEDULER_ASYNC: Systems must be synchronous.");
    const phase = system.phase ?? "update";
    if (!(SYSTEM_PHASES as readonly string[]).includes(phase))
      throw new Error(`TC_SCHEDULER_PHASE: Unknown phase ${phase}.`);
    const array = (value: readonly string[] | undefined) => {
      if (
        value !== undefined &&
        (!Array.isArray(value) ||
          value.some((id) => typeof id !== "string" || !id.trim()))
      )
        throw new Error(
          `TC_SCHEDULER_SYSTEM: Invalid access/dependency list for ${system.id}.`,
        );
      return [...(value ?? [])];
    };
    if (
      system.structural !== undefined &&
      typeof system.structural !== "boolean"
    )
      throw new Error("TC_SCHEDULER_SYSTEM: Invalid structural access.");
    return {
      id: system.id,
      phase,
      before: array(system.before),
      after: array(system.after),
      ...(system.reads === undefined ? {} : { reads: array(system.reads) }),
      ...(system.writes === undefined ? {} : { writes: array(system.writes) }),
      ...(system.structural === undefined
        ? {}
        : { structural: system.structural }),
      run: system.run,
    };
  });
  const byId = new Map(systems.map((system) => [system.id, system]));
  if (byId.size !== systems.length)
    throw new Error("TC_SCHEDULER_DUPLICATE: Duplicate system id.");
  const edges = new Map(systems.map((s) => [s.id, new Set<string>()]));
  const indegree = new Map(systems.map((s) => [s.id, 0]));
  const edge = (from: string, to: string) => {
    const a = byId.get(from),
      b = byId.get(to);
    if (!a || !b)
      throw new Error(
        `TC_SCHEDULER_DEPENDENCY: Unknown dependency ${!a ? from : to}.`,
      );
    const ap = SYSTEM_PHASES.indexOf(a.phase),
      bp = SYSTEM_PHASES.indexOf(b.phase);
    if (ap > bp)
      throw new Error(
        `TC_SCHEDULER_PHASE_ORDER: ${from} cannot precede earlier phase ${to}.`,
      );
    if (ap === bp && !edges.get(from)!.has(to)) {
      edges.get(from)!.add(to);
      indegree.set(to, indegree.get(to)! + 1);
    }
  };
  for (const s of systems) {
    for (const id of s.before) edge(s.id, id);
    for (const id of s.after) edge(id, s.id);
  }
  const ordered: typeof systems = [];
  for (const phase of SYSTEM_PHASES) {
    const pending = systems.filter((s) => s.phase === phase);
    while (pending.length) {
      const index = pending.findIndex((s) => indegree.get(s.id) === 0);
      if (index < 0)
        throw new Error(
          `TC_SCHEDULER_CYCLE: Cyclic systems in phase ${phase}.`,
        );
      const [next] = pending.splice(index, 1);
      ordered.push(next);
      for (const id of edges.get(next.id)!)
        indegree.set(id, indegree.get(id)! - 1);
    }
  }
  const diagnostics: SchedulerDiagnostic[] = [];
  for (let i = 0; i < ordered.length; i++)
    for (let j = i + 1; j < ordered.length; j++) {
      const a = ordered[i],
        b = ordered[j];
      const resources = [
        ...new Set([
          ...(a.writes ?? []).filter(
            (key) => b.writes?.includes(key) || b.reads?.includes(key),
          ),
          ...(b.writes ?? []).filter((key) => a.reads?.includes(key)),
          ...(a.writes === undefined ||
          b.writes === undefined ||
          a.reads === undefined ||
          b.reads === undefined
            ? ["$undeclared-access"]
            : []),
          ...(a.structural !== false || b.structural !== false
            ? ["$structure"]
            : []),
        ]),
      ].sort();
      if (resources.length)
        diagnostics.push({
          code: "TC_SCHEDULER_CONFLICT",
          first: a.id,
          second: b.id,
          resources,
          message: `Sequential execution: ${a.id} before ${b.id}; shared access is not automatic parallelism.`,
        });
    }
  return {
    ordered,
    descriptors: ordered.map(({ run: _run, ...descriptor }) => descriptor),
    diagnostics,
  };
}

/** One scheduler per world. step() is the already-fixed driver entry point;
 * advance() is an alternative wall-clock driver, never a second fixed-step layer.
 * Flush boundaries: start tick, after input events, end each phase. Failed ticks
 * may have changed world/random/events: pause and require a known-good restore. */
export function createScheduler({
  world,
  systems = [],
  fixedDt = 1 / 60,
  maxSubsteps = 8,
  seed = 0,
}: SchedulerOptions) {
  if (!Number.isFinite(fixedDt) || fixedDt <= 0)
    throw new Error("TC_SCHEDULER_DT: fixedDt must be positive and finite.");
  integer(maxSubsteps, "maxSubsteps", 1);
  const random = createRandom(seed);
  let plan = schedule(systems);
  let completedTick = 0,
    accumulator = 0,
    compensation = 0,
    paused = false,
    running = false;
  let fault: SchedulerFault | null = null,
    delivered: RuntimeEvent[] = [];
  let recording: { initial: SchedulerSnapshot; actions: TraceAction[] } | null =
      null,
    replaying = false,
    disposed = false;
  const currentTick = () => completedTick + (running ? 1 : 0);
  const ensure = () => {
    if (disposed)
      throw new Error("TC_SCHEDULER_DISPOSED: Scheduler is disposed.");
  };
  const safe = () => {
    ensure();
    if (running)
      throw new Error(
        "TC_SCHEDULER_SAFE_POINT: Operation requires a tick boundary.",
      );
  };
  const record = (action: TraceAction) => {
    if (recording && !running && !replaying)
      recording.actions.push(cloneSerializable(action));
  };
  const bus = createEventBus({
    currentTick,
    defaultSource: () => (running ? "system" : "external"),
    dispatch: (id, access, callback) =>
      world.runSystem(`event:${id}`, access, callback),
    beforeSubscribe: () => {
      safe();
      if (recording || replaying)
        throw new Error(
          "TC_TRACE_SUBSCRIPTION: Register listeners before recording/replay.",
        );
    },
    beforeEmit: (event) => {
      ensure();
      if (fault)
        throw new Error(
          "TC_SCHEDULER_FAULT: Restore a known-good snapshot before emitting.",
        );
      record({ kind: "emit", event, atTick: currentTick() });
    },
    onDelivery: (events) => {
      delivered = events;
    },
  });
  const events = Object.assign(
    (type?: string) => {
      ensure();
      return cloneSerializable(
        type === undefined
          ? delivered
          : delivered.filter((e) => e.type === type),
      );
    },
    { on: bus.on, emit: bus.emit },
  );
  const backlog = () =>
    Math.max(
      0,
      Math.floor((accumulator + fixedDt * Number.EPSILON * 16) / fixedDt),
    );
  const addTime = (amount: number) => {
    const adjusted = amount - compensation,
      sum = accumulator + adjusted;
    compensation = sum - accumulator - adjusted;
    accumulator = sum;
    if (Math.abs(accumulator) < fixedDt * Number.EPSILON * 16) {
      accumulator = 0;
      compensation = 0;
    }
  };
  const report = (
    executed: number,
    budgetExhausted = false,
    acceptedSeconds = 0,
    ignoredSeconds = 0,
  ): StepReport => ({
    status: fault
      ? "faulted"
      : paused
        ? "paused"
        : budgetExhausted
          ? "backlogged"
          : "completed",
    executed,
    tick: completedTick,
    time: completedTick * fixedDt,
    backlogTicks: backlog(),
    backlogSeconds: accumulator,
    interpolationAlpha: Math.min(1, Math.max(0, accumulator / fixedDt)),
    budgetExhausted,
    acceptedSeconds,
    ignoredSeconds,
    fault: cloneSerializable(fault),
  });
  const tick = (): boolean => {
    if (
      !Number.isSafeInteger(completedTick + 1) ||
      !Number.isFinite((completedTick + 1) * fixedDt)
    )
      throw new Error("TC_SCHEDULER_LIMIT: Tick/time range exhausted.");
    let stage = "tick:start";
    running = true;
    try {
      world.flush();
      stage = "events";
      const delivery = bus.deliver(currentTick());
      if (delivery.faults.length) {
        fault = {
          code: "TC_SCHEDULER_LISTENER",
          tick: currentTick(),
          stage,
          message:
            "Input event listeners failed; batch completed; no rollback.",
          partialState: true,
          eventFaults: delivery.faults,
        };
        paused = true;
        return false;
      }
      world.flush();
      for (const phase of SYSTEM_PHASES) {
        for (const system of plan.ordered) {
          if (system.phase !== phase) continue;
          stage = `system:${system.id}`;
          world.runSystem(
            system.id,
            {
              ...(system.reads === undefined ? {} : { reads: system.reads }),
              ...(system.writes === undefined ? {} : { writes: system.writes }),
              ...(system.structural === undefined
                ? {}
                : { structural: system.structural }),
            },
            () => {
              const result: unknown = system.run(fixedDt);
              if (
                result &&
                (typeof result === "object" || typeof result === "function") &&
                "then" in result
              ) {
                void Promise.resolve(result).catch(() => {});
                throw new Error(
                  "TC_SCHEDULER_ASYNC: Systems must complete synchronously.",
                );
              }
            },
          );
        }
        stage = `flush:${phase}`;
        world.flush();
      }
      completedTick++;
      return true;
    } catch (error) {
      paused = true;
      fault = {
        code: "TC_SCHEDULER_TICK",
        tick: currentTick(),
        stage,
        message: error instanceof Error ? error.message : String(error),
        partialState: true,
        eventFaults: [],
      };
      return false;
    } finally {
      running = false;
    }
  };

  const validateSnapshot = (value: unknown): SchedulerSnapshot => {
    const data = cloneSerializable(value) as SchedulerSnapshot;
    if (
      !data ||
      data.format !== "threecat.scheduler" ||
      data.version !== 1 ||
      data.fixedDt !== fixedDt ||
      data.maxSubsteps !== maxSubsteps
    )
      throw new Error(
        "TC_SCHEDULER_SNAPSHOT_VERSION: Unsupported snapshot/configuration.",
      );
    integer(data.tick, "snapshot tick");
    seconds(data.accumulator, "snapshot accumulator");
    if (
      !Number.isFinite(data.compensation) ||
      Math.abs(data.compensation) >
        Math.max(fixedDt, data.accumulator) * Number.EPSILON * 4 ||
      !Number.isFinite(data.time) ||
      data.time !== data.tick * fixedDt ||
      !Number.isSafeInteger(Math.floor(data.accumulator / fixedDt)) ||
      Math.floor(data.accumulator / fixedDt) >
        Number.MAX_SAFE_INTEGER - data.tick ||
      typeof data.paused !== "boolean"
    )
      throw new Error("TC_SCHEDULER_SNAPSHOT: Invalid clock state.");
    if (
      canonical(data.systems) !== canonical(plan.descriptors) ||
      canonical(data.listeners) !== canonical(bus.inspect().listeners)
    )
      throw new Error(
        "TC_SCHEDULER_SNAPSHOT_SYSTEMS: Snapshot requires the same systems/listener contract.",
      );
    validateRandomSnapshot(data.random);
    validateEventSnapshot(data.events, data.tick);
    if (!Array.isArray(data.delivered))
      throw new Error("TC_SCHEDULER_SNAPSHOT: Invalid delivered events.");
    const history = validateEventSnapshot(
      {
        format: "threecat.events",
        version: 1,
        nextSequence: data.events.nextSequence,
        queue: data.delivered,
      },
      -1,
    );
    if (
      (data.tick === 0 && data.delivered.length > 0) ||
      history.queue.some((e) => e.tick !== data.tick) ||
      data.delivered.some((e) =>
        data.events.queue.some((q) => q.sequence === e.sequence),
      )
    )
      throw new Error(
        "TC_SCHEDULER_SNAPSHOT: Inconsistent delivered event history.",
      );
    if (
      !data.world ||
      data.world.format !== "threecat.world" ||
      data.world.version !== 1 ||
      !Array.isArray(data.world.components) ||
      !Array.isArray(data.world.entities)
    )
      throw new Error(
        "TC_SCHEDULER_WORLD_VERSION: Unsupported or malformed world snapshot.",
      );
    // Reuse World's field/schema validators, and validate graph identity without
    // touching the live World. This also preflights BOTH trace endpoints.
    const definitions = new Map<string, ComponentSchema>();
    for (const definition of data.world.components) {
      worldRecord(definition, "Snapshot component");
      identifier(definition.id, "Component id");
      if (definition.id === "Transform" || definitions.has(definition.id))
        throw new Error("TC_SCHEDULER_SNAPSHOT: Duplicate/reserved component.");
      if (definition.version !== undefined)
        integer(definition.version as number, "component version", 1);
      definitions.set(
        definition.id,
        cloneSchema(definition.schema as ComponentSchema),
      );
    }
    const transforms: ComponentSchema = {
      position: { type: "vec3", default: [0, 0, 0] },
      rotation: { type: "vec3", default: [0, 0, 0] },
      scale: { type: "vec3", default: [1, 1, 1] },
    };
    const parents = new Map<string, string | undefined>();
    for (const entity of data.world.entities) {
      worldRecord(entity, "Snapshot entity");
      identifier(entity.id, "Entity id");
      if (parents.has(entity.id))
        throw new Error("TC_SCHEDULER_SNAPSHOT: Duplicate entity.");
      if (entity.parent !== undefined) identifier(entity.parent, "Parent id");
      parents.set(entity.id, entity.parent as string | undefined);
      values(
        transforms,
        entity.transform as unknown as ComponentData,
        true,
        true,
      );
      worldRecord(entity.components, "Snapshot components");
      for (const [name, fields] of Object.entries(entity.components)) {
        const schema = definitions.get(name);
        if (!schema)
          throw new Error(
            `TC_SCHEDULER_SNAPSHOT: Unknown/reserved component ${name}.`,
          );
        values(schema, fields as ComponentData, true, true);
      }
    }
    const visited = new Set<string>();
    for (const id of parents.keys()) {
      const path = new Set<string>();
      let current: string | undefined = id;
      while (current !== undefined && !visited.has(current)) {
        if (!parents.has(current))
          throw new Error("TC_SCHEDULER_SNAPSHOT: Missing parent entity.");
        if (path.has(current))
          throw new Error("TC_SCHEDULER_SNAPSHOT: Parent cycle.");
        path.add(current);
        current = parents.get(current);
      }
      for (const entity of path) visited.add(entity);
    }
    return data;
  };
  const snapshot = (): SchedulerSnapshot => {
    safe();
    if (fault)
      throw new Error(
        "TC_SCHEDULER_FAULT: Failed partial tick cannot be captured as a successful checkpoint.",
      );
    if (world.inspect().pendingCommands)
      throw new Error(
        "TC_SCHEDULER_PENDING: Snapshot requires an empty structural command queue.",
      );
    return cloneSerializable({
      format: "threecat.scheduler",
      version: 1,
      fixedDt,
      maxSubsteps,
      tick: completedTick,
      time: completedTick * fixedDt,
      accumulator,
      compensation,
      paused,
      systems: plan.descriptors,
      listeners: bus.inspect().listeners,
      world: world.snapshot(),
      random: random.snapshot(),
      events: bus.snapshot(),
      delivered,
    });
  };
  const restore = (value: unknown): void => {
    safe();
    if (recording)
      throw new Error(
        "TC_TRACE_RESTORE: Stop recording before restoring a checkpoint.",
      );
    const data = validateSnapshot(value);
    // World.restore builds/validates a candidate before commit. All scheduler
    // fields are validated before calling it; malformed input changes neither.
    world.restore(data.world);
    random.restore(data.random);
    bus.restore(data.events, data.tick);
    completedTick = data.tick;
    accumulator = data.accumulator;
    compensation = data.compensation;
    paused = data.paused;
    delivered = data.delivered;
    fault = null;
  };
  const step = (count = 1): StepReport => {
    safe();
    integer(count, "count");
    if (
      count > Number.MAX_SAFE_INTEGER - completedTick ||
      !Number.isFinite((completedTick + count) * fixedDt)
    )
      throw new Error("TC_SCHEDULER_LIMIT: Step count exceeds clock range.");
    record({ kind: "step", count, atTick: completedTick });
    let executed = 0;
    while (executed < count && !paused && !fault) {
      if (!tick()) break;
      executed++;
    }
    return report(executed);
  };
  const advance = (realSeconds: number): StepReport => {
    safe();
    seconds(realSeconds, "realSeconds");
    if (
      !Number.isFinite(accumulator + realSeconds) ||
      Math.floor((accumulator + realSeconds) / fixedDt) >
        Number.MAX_SAFE_INTEGER - completedTick
    )
      throw new Error(
        "TC_SCHEDULER_LIMIT: Wall-clock backlog exceeds clock range.",
      );
    record({ kind: "advance", seconds: realSeconds, atTick: completedTick });
    if (paused || fault) return report(0, false, 0, realSeconds);
    addTime(realSeconds);
    let executed = 0;
    while (backlog() && executed < maxSubsteps && !paused && !fault) {
      if (!tick()) break;
      addTime(-fixedDt);
      executed++;
    }
    return report(
      executed,
      !fault && !paused && executed === maxSubsteps && backlog() > 0,
      realSeconds,
    );
  };
  const pause = (): void => {
    ensure();
    record({ kind: "pause", atTick: currentTick() });
    paused = true;
  };
  const resume = (): void => {
    safe();
    if (fault)
      throw new Error(
        "TC_SCHEDULER_FAULT: Cannot resume a partial failed tick; restore a known-good checkpoint.",
      );
    record({ kind: "resume", atTick: completedTick });
    paused = false;
  };
  const nextRandom = (): number => {
    ensure();
    if (fault)
      throw new Error(
        "TC_SCHEDULER_FAULT: Restore a known-good checkpoint before drawing random values.",
      );
    const value = random.next();
    record({ kind: "random", value, atTick: currentTick() });
    return value;
  };
  const validateTrace = (value: unknown): SchedulerTrace => {
    const trace = cloneSerializable(value) as SchedulerTrace;
    if (
      !trace ||
      trace.format !== "threecat.trace" ||
      trace.version !== 1 ||
      !Array.isArray(trace.actions)
    )
      throw new Error(
        "TC_TRACE_VERSION: Unsupported or malformed recorded trace.",
      );
    validateSnapshot(trace.initial);
    validateSnapshot(trace.final);
    for (const action of trace.actions) {
      if (!action || typeof action !== "object")
        throw new Error("TC_TRACE_ACTION: Invalid recorded action.");
      integer(action.atTick, "recorded atTick");
      if (action.kind === "step") {
        integer(action.count, "recorded count");
        if (
          action.count > Number.MAX_SAFE_INTEGER - action.atTick ||
          !Number.isFinite((action.atTick + action.count) * fixedDt)
        )
          throw new Error(
            "TC_TRACE_ACTION: Recorded step exceeds clock range.",
          );
      } else if (action.kind === "advance") {
        seconds(action.seconds, "recorded seconds");
        if (
          Math.floor(action.seconds / fixedDt) >
          Number.MAX_SAFE_INTEGER - action.atTick
        )
          throw new Error(
            "TC_TRACE_ACTION: Recorded advance exceeds clock range.",
          );
      } else if (action.kind === "random") {
        if (
          !Number.isFinite(action.value) ||
          action.value < 0 ||
          action.value >= 1
        )
          throw new Error("TC_TRACE_ACTION: Invalid recorded random value.");
      } else if (action.kind === "emit") {
        const e = action.event;
        if (
          !e ||
          !Number.isSafeInteger(e.sequence) ||
          e.sequence < 0 ||
          !Number.isSafeInteger(e.sequence + 1)
        )
          throw new Error("TC_TRACE_ACTION: Invalid recorded event.");
        validateEventSnapshot(
          {
            format: "threecat.events",
            version: 1,
            nextSequence: e.sequence + 1,
            queue: [e],
          },
          action.atTick,
        );
      } else if (action.kind !== "pause" && action.kind !== "resume")
        throw new Error("TC_TRACE_ACTION: Unknown recorded action.");
    }
    return trace;
  };
  return {
    get tick() {
      return currentTick();
    },
    get time() {
      return currentTick() * fixedDt;
    },
    events,
    emit: bus.emit,
    random: nextRandom,
    step,
    advance,
    pause,
    resume,
    snapshot,
    restore,
    dispose(): void {
      if (disposed) return;
      safe();
      bus.dispose();
      plan = schedule([]);
      delivered = [];
      recording = null;
      paused = true;
      disposed = true;
    },
    setSystems(next: readonly ScheduledSystem[]): void {
      safe();
      if (recording || replaying)
        throw new Error(
          "TC_TRACE_SYSTEMS: Cannot replace systems during recording/replay.",
        );
      const candidate = schedule(next);
      plan = candidate;
    },
    inspect() {
      return {
        tick: completedTick,
        activeTick: running ? currentTick() : null,
        time: completedTick * fixedDt,
        fixedDt,
        maxSubsteps,
        paused,
        running,
        disposed,
        backlogTicks: backlog(),
        backlogSeconds: accumulator,
        recording: recording !== null,
        replaying,
        fault: cloneSerializable(fault),
        systems: cloneSerializable(plan.descriptors),
        diagnostics: cloneSerializable(plan.diagnostics),
        events: bus.inspect(),
        random: random.snapshot(),
      };
    },
    startRecording(): void {
      safe();
      if (recording || replaying)
        throw new Error("TC_TRACE_ACTIVE: Recording/replay already active.");
      recording = { initial: snapshot(), actions: [] };
    },
    stopRecording(): SchedulerTrace {
      safe();
      if (!recording)
        throw new Error("TC_TRACE_INACTIVE: No active recording.");
      const final = snapshot();
      const trace: SchedulerTrace = {
        format: "threecat.trace",
        version: 1,
        initial: recording.initial,
        actions: recording.actions,
        final,
      };
      recording = null;
      return cloneSerializable(trace);
    },
    cancelRecording(): void {
      safe();
      recording = null;
    },
    replay(value: unknown): {
      status: "passed" | "failed";
      actionsExecuted: number;
      fault: SchedulerFault | null;
    } {
      safe();
      if (recording || replaying)
        throw new Error(
          "TC_TRACE_ACTIVE: Cannot replay during recording/replay.",
        );
      const trace = validateTrace(value); // Complete shape/version preflight before any write.
      let actionsExecuted = 0;
      restore(trace.initial);
      replaying = true;
      try {
        for (const action of trace.actions) {
          if (action.atTick !== completedTick)
            throw new Error(
              "TC_REPLAY_DIVERGENCE: Recorded operation tick differs.",
            );
          switch (action.kind) {
            case "step":
              step(action.count);
              break;
            case "advance":
              advance(action.seconds);
              break;
            case "pause":
              pause();
              break;
            case "resume":
              resume();
              break;
            case "random":
              if (nextRandom() !== action.value)
                throw new Error("TC_REPLAY_DIVERGENCE: Random stream differs.");
              break;
            case "emit": {
              const actual = events.emit(
                action.event.type,
                action.event.payload,
                { tick: action.event.tick, source: action.event.source },
              );
              if (actual.sequence !== action.event.sequence)
                throw new Error(
                  "TC_REPLAY_DIVERGENCE: Event sequence differs.",
                );
              break;
            }
          }
          actionsExecuted++;
          if (fault) break;
        }
        if (!fault && canonical(snapshot()) !== canonical(trace.final))
          throw new Error(
            "TC_REPLAY_DIVERGENCE: Final state differs; use identical system code and controlled external inputs.",
          );
      } catch (error) {
        fault = {
          code: "TC_REPLAY_DIVERGENCE",
          tick: completedTick,
          stage: "replay",
          partialState: true,
          eventFaults: [],
          message: error instanceof Error ? error.message : String(error),
        };
        paused = true;
      } finally {
        replaying = false;
      }
      return {
        status: fault ? "failed" : "passed",
        actionsExecuted,
        fault: cloneSerializable(fault),
      };
    },
  };
}

export type RuntimeScheduler = ReturnType<typeof createScheduler>;
