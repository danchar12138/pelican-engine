import type {
  GameInput,
  GameRuntimeDefinition,
  GameRuntimeState,
  JsonValue,
  RenderExtensionDefinition,
} from "./index.ts";

/** Resolve extension declarations into the existing resource/runtime contracts. */
export function expandRenderExtensions(input: GameInput): GameInput {
  if (!input.extensions?.length) return input;
  const { extensions, ...base } = input;
  const ids = new Set<string>();
  for (const extension of extensions) {
    if (
      extension.apiVersion !== 1 ||
      !extension.id?.trim() ||
      extension.id === "$game" ||
      !extension.version?.trim() ||
      ids.has(extension.id)
    )
      throw new Error(
        "TC_RENDER_EXTENSION_CONTRACT: Extensions require API version 1, unique id and an explicit version.",
      );
    ids.add(extension.id);
  }
  const runtimes: { id: string; runtime: GameRuntimeDefinition }[] = [];
  if (base.runtime) runtimes.push({ id: "$game", runtime: base.runtime });
  for (const extension of extensions)
    if (extension.create)
      runtimes.push({
        id: extension.id,
        runtime: { version: extension.version, create: extension.create },
      });
  const runtime: GameRuntimeDefinition | undefined = runtimes.length
    ? {
        version: JSON.stringify(
          runtimes.map((entry) => [entry.id, entry.runtime.version]),
        ),
        async create(scope) {
          const states: { id: string; state: GameRuntimeState }[] = [];
          for (const entry of runtimes) {
            const state = (await entry.runtime.create(scope)) ?? {};
            // Register immediately: a later extension can fail during async setup.
            if (state.dispose) scope.defer(() => state.dispose!());
            const hooks = [
              state.snapshot,
              state.validateSnapshot,
              state.restore,
            ];
            if (
              hooks.some(Boolean) &&
              !hooks.every((hook) => typeof hook === "function")
            )
              throw new Error(
                `TC_RENDER_EXTENSION_STATE: ${entry.id} must provide all snapshot hooks together.`,
              );
            states.push({ id: entry.id, state });
            if (scope.signal.aborted)
              throw new Error(
                "TC_RUNTIME_DISPOSED: Render extension initialization cancelled.",
              );
          }
          const systems: NonNullable<GameRuntimeState["systems"]> &
            Record<string, NonNullable<GameRuntimeState["systems"]>[string]> =
            {};
          for (const entry of states)
            for (const [id, run] of Object.entries(entry.state.systems ?? {})) {
              if (systems[id])
                throw new Error(
                  `TC_RENDER_EXTENSION_SYSTEM: Duplicate runtime system '${id}'.`,
                );
              systems[id] = run;
            }
          const saved = states.filter((entry) => entry.state.snapshot);
          if (!saved.length) return { systems };
          const object = (value: JsonValue) => {
            if (
              !value ||
              typeof value !== "object" ||
              Array.isArray(value) ||
              Object.keys(value).sort().join("\0") !==
                saved
                  .map((entry) => entry.id)
                  .sort()
                  .join("\0")
            )
              throw new Error(
                "TC_RENDER_EXTENSION_STATE: Saved extension set differs from the active extension versions.",
              );
            return value as Record<string, JsonValue>;
          };
          return {
            systems,
            snapshot: () =>
              Object.fromEntries(
                saved.map((entry) => [entry.id, entry.state.snapshot!()]),
              ),
            validateSnapshot(value) {
              const record = object(value);
              for (const entry of saved)
                entry.state.validateSnapshot!(record[entry.id]!);
            },
            restore(value) {
              const record = object(value);
              for (const entry of saved)
                entry.state.validateSnapshot!(record[entry.id]!);
              const previous = saved.map((entry) => entry.state.snapshot!());
              try {
                for (const entry of saved)
                  entry.state.restore!(record[entry.id]!);
              } catch (error) {
                const errors: unknown[] = [error];
                for (const [index, entry] of saved.entries())
                  try {
                    entry.state.restore!(previous[index]!);
                  } catch (rollback) {
                    errors.push(rollback);
                  }
                throw new AggregateError(
                  errors,
                  "TC_RENDER_EXTENSION_RESTORE: Extension restore failed; inspect rollback causes.",
                );
              }
            },
          };
        },
      }
    : undefined;
  return {
    ...base,
    systems: [
      ...(base.systems ?? []),
      ...extensions.flatMap((extension) => extension.systems ?? []),
    ],
    materials: [
      ...(base.materials ?? []),
      ...extensions.flatMap((extension) => extension.materials ?? []),
    ],
    assets: [
      ...(base.assets ?? []),
      ...extensions.flatMap((extension) => extension.assets ?? []),
    ],
    computes: [
      ...(base.computes ?? []),
      ...extensions.flatMap((extension) => extension.computes ?? []),
    ],
    postProcesses: [
      ...(base.postProcesses ?? []),
      ...extensions.flatMap((extension) => extension.postProcesses ?? []),
    ],
    computeBuffers: [
      ...(base.computeBuffers ?? []),
      ...extensions.flatMap((extension) => extension.computeBuffers ?? []),
    ],
    computeTextures: [
      ...(base.computeTextures ?? []),
      ...extensions.flatMap((extension) => extension.computeTextures ?? []),
    ],
    ...(runtime ? { runtime } : {}),
  };
}
