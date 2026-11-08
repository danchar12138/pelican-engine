import type { RopeDynamicCoupling, Vec3 } from "./rope.ts";

export interface CoupledView<State> { state: State; previous: Vec3[] }
/** Keeps a fixed tick open while the host interleaves native and material substeps. */
export function createCoupledSchedule<Entry extends { definition: { id: string; autoStep?: boolean; substeps?: number } }, View, Saved>(
  entries: () => Iterable<Entry>, defaults: number,
  capture: (entry: Entry) => Saved, restore: (entry: Entry, state: Saved) => void,
  iterate: (entry: Entry, count: number, sample: () => RopeDynamicCoupling | undefined) => Generator<View, void, unknown>,
) {
  let running = false;
  let faulted = false;
  let checkpoints: { entry: Entry; state: Saved }[] = [];
  const runners = new Map<string, { iterator: Generator<View, void, unknown>; coupling?: RopeDynamicCoupling }>();
  const automatic = () => [...entries()].filter(entry => entry.definition.autoStep).sort((a, b) => a.definition.id.localeCompare(b.definition.id, "en"));
  const reset = () => { runners.clear(); checkpoints = []; running = false; faulted = false; };
  return {
    get active() { return running; },
    get faulted() { return faulted; },
    substeps: () => Math.max(0, ...automatic().map(entry => entry.definition.substeps ?? defaults)),
    begin(count: number) {
      if (running || faulted) throw new Error("TC_SIMULATION_SCHEDULE: A fixed tick is active or requires checkpoint recovery.");
      reset(); running = true;
      for (const entry of automatic()) {
        checkpoints.push({ entry, state: capture(entry) });
        const runner = { iterator: undefined!, coupling: undefined as RopeDynamicCoupling | undefined } as { iterator: Generator<View, void, unknown>; coupling?: RopeDynamicCoupling };
        runner.iterator = iterate(entry, count, () => runner.coupling); runners.set(entry.definition.id, runner);
      }
    },
    next(id: string, coupling?: RopeDynamicCoupling): View | undefined {
      if (!running) return;
      const runner = runners.get(id);
      if (!runner) throw new Error(`TC_SIMULATION_SCHEDULE: Missing automatic participant '${id}'.`);
      runner.coupling = coupling;
      const next = runner.iterator.next();
      if (next.done) throw new Error(`TC_SIMULATION_SCHEDULE: '${id}' completed before the shared clock.`);
      return next.value;
    },
    finish() {
      for (const [id, runner] of runners) if (!runner.iterator.next().done) throw new Error(`TC_SIMULATION_SCHEDULE: '${id}' has unfinished substeps.`);
    },
    commit: reset,
    abort() {
      const failures: unknown[] = [];
      for (const runner of runners.values()) try { runner.iterator.return(); } catch (error) { failures.push(error); }
      for (const { entry, state } of [...checkpoints].reverse()) try { restore(entry, state); } catch (error) { failures.push(error); }
      reset();
      if (failures.length) { faulted = true; throw new AggregateError(failures, "TC_SIMULATION_SCHEDULE_ROLLBACK: Restore a known-good host checkpoint."); }
    },
    reset,
  };
}
