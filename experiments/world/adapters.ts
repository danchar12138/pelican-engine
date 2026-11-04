import { clone } from "./geometry.ts";
import type {
  PreparedWorldUpdate,
  WorldAdapter,
  WorldTransaction,
} from "./types.ts";
/** Reference consumers prepare real derived data, then swap one reference synchronously. */
export function createConsumer<T>(
  name: string,
  initial: T,
  build: (t: WorldTransaction) => T,
): WorldAdapter & { read(): T } {
  let current = initial;
  return {
    name,
    read: () => current,
    prepare(t): PreparedWorldUpdate {
      let prepared: T | undefined = build(t);
      const previous = current;
      return {
        commit() {
          if (prepared === undefined)
            throw new Error("WORLD_PREPARED: preparation was discarded");
          current = prepared;
        },
        rollback() {
          current = previous;
          prepared = undefined;
        },
        discard() {
          prepared = undefined;
        },
      };
    },
    dispose() {
      current = clone(initial);
    },
  };
}
