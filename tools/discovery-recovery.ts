import { engineTasks } from "../packages/sdk/src/index.ts";

/** Shared fallback for failed API/capability queries. Candidates are navigation, not implementation claims. */
export function discoveryRecovery(error: unknown, args: readonly string[]) {
  if (
    !/TC_(?:API_(?:SEARCH|SYMBOL)_UNKNOWN|CAPABILITY_UNKNOWN)/.test(
      String(error),
    )
  )
    return {};
  const flag = args.findIndex((arg) =>
    ["--symbol", "--search", "--feature"].includes(arg),
  );
  const goal = flag < 0 ? "" : (args[flag + 1] ?? "");
  const matches = engineTasks(goal);
  const tasks = matches.length ? matches : engineTasks();
  return {
    candidates: tasks
      .slice(0, 8)
      .map((task) => ({
        kind: "task" as const,
        id: task.id,
        query: `pelican guide --goal ${task.id}`,
        matchedIntent: matches.length > 0,
      })),
    remediation:
      "These candidates are navigation choices, not claims that the failed query is supported. Query a task, inspect its exact API and limits, or report the concrete missing contract.",
  };
}
