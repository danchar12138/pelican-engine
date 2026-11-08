import type { WorldResidencyOwner } from "../../runtime/src/plugins.ts";
import type { EntityRecord } from "../../runtime/src/contracts.ts";
import { cloneSerializable } from "../../runtime/src/random.ts";

/** Park an entire solver only when every live native dependency belongs to the chunk. */
export function createMaterialResidency<T extends { definition: { id: string } }>(options: {
  entries(): Map<string, T>;
  beforeCapture(): void;
  references(entry: T): readonly string[];
  capture(entry: T): unknown;
  decode(value: unknown): Map<string, T>;
  validateWorld(entries: Map<string, T>, entities: readonly EntityRecord[]): void;
  bind(entry: T): void;
  dispose(entries: Map<string, T>): void;
  capacity: number;
}): WorldResidencyOwner {
  const fail = (detail: string): never => { throw new Error(`TC_SIMULATION_RESIDENCY: ${detail} Restore an intact checkpoint or detach the cross-chunk bindings.`); };
  return {
    capture(ids) {
      options.beforeCapture();
      const owned = new Set(ids), saved: unknown[] = [];
      for (const entry of options.entries().values()) {
        const refs = options.references(entry);
        if (!refs.some(id => owned.has(id))) continue;
        if (refs.some(id => !owned.has(id))) fail(`Simulation '${entry.definition.id}' has dependencies outside this chunk.`);
        saved.push(options.capture(entry));
      }
      return saved.length ? cloneSerializable(saved) : null;
    },
    validate(value, ids, entities) {
      const staged = options.decode(value), owned = new Set(ids);
      try {
        for (const entry of staged.values()) {
          const refs = options.references(entry);
          if (!refs.length || refs.some(id => !owned.has(id))) fail(`Parked simulation '${entry.definition.id}' is not owned by its chunk.`);
        }
        options.validateWorld(staged, entities);
      } finally { options.dispose(staged); }
    },
    suspend(value) {
      const staged = options.decode(value);
      try {
        for (const id of staged.keys()) {
          const entry = options.entries().get(id);
          if (!entry) fail(`Simulation '${id}' disappeared before suspension.`);
          options.dispose(new Map([[id, entry!]]));
          options.entries().delete(id);
        }
      } finally { options.dispose(staged); }
    },
    resume(value) {
      const staged = options.decode(value);
      try {
        if (options.entries().size + staged.size > options.capacity) fail("Loading would exceed the active simulation capacity.");
        for (const [id, entry] of staged) {
          if (options.entries().has(id)) fail(`Simulation ID '${id}' was reused while its chunk was inactive.`);
          options.bind(entry);
        }
        for (const [id, entry] of staged) options.entries().set(id, entry);
        staged.clear();
      } finally { options.dispose(staged); }
    },
  };
}
