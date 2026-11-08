import type {
  GameRuntimeInput,
  GameRuntimeDefinition,
  JsonValue,
  RuntimeState,
  SystemMetadata,
} from "./index.ts";
import { cloneJsonValue } from "../../schema/src/json-value.ts";
import { handleNativeRejection, isAsyncValue } from "./runtime-async.ts";

export function composeGameRuntime<T extends JsonValue>(
  input: GameRuntimeInput<T>,
): { systems: readonly SystemMetadata[]; runtime: GameRuntimeDefinition } {
  const definitions = input.systems.map((system) => ({ ...system }));
  if (
    new Set(definitions.map((system) => system.id)).size !== definitions.length
  )
    throw new Error(
      "TC_GAME_RUNTIME_SYSTEM: Duplicate system ID; give each runtime system a unique ID.",
    );
  const systems = definitions.map(({ run: _run, ...metadata }) => ({
    ...metadata,
    kind: "system" as const,
  }));
  return {
    systems,
    runtime: {
      version: input.version,
      async create(scope) {
        const checked = (value: unknown): T => {
          const candidate = cloneJsonValue(value);
          const result = input.validateState(cloneJsonValue(candidate));
          if (isAsyncValue(result)) {
            handleNativeRejection(result);
            throw new Error(
              "TC_GAME_RUNTIME_ASYNC: validateState must be synchronous and must not mutate state.",
            );
          }
          return candidate as T;
        };
        const initial = input.state();
        if (isAsyncValue(initial)) {
          handleNativeRejection(initial);
          throw new Error(
            "TC_GAME_RUNTIME_ASYNC: state() must return synchronous JSON; use setup for asynchronous preparation.",
          );
        }
        const state: RuntimeState<T> = { value: checked(initial) };
        await input.setup?.(scope, state);
        scope.signal.throwIfAborted();
        return {
          systems: Object.fromEntries(
            definitions.map((system) => [
              system.id,
              (ctx, dt) => system.run(ctx, dt, state, scope),
            ]),
          ),
          snapshot: () => checked(state.value),
          validateSnapshot(value) {
            checked(value);
          },
          restore(value) {
            state.value = checked(value);
          },
        };
      },
    },
  };
}
