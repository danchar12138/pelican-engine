import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface AuthorCommandRecord {
  started: number;
  ended: number;
  args: string[];
  exitCode: number | null;
  status?: string;
  stdoutBytes: number;
  stderrBytes: number;
}
const fail = (detail: string): never => {
  throw new Error(`TC_AUTHOR_EVALUATION: ${detail}`);
};

/** Derive check/query metrics from recorded commands, not from the model's claimed score. */
export function summarizeAuthorCommands(
  workspace: string,
  tasks: readonly string[],
  records: readonly AuthorCommandRecord[],
) {
  if (
    new Set(tasks).size !== tasks.length ||
    tasks.some((id) => !/^[a-z0-9-]+$/.test(id))
  )
    fail("Expected unique task IDs.");
  for (const [index, record] of records.entries()) {
    if (
      !record ||
      !Array.isArray(record.args) ||
      record.args.some((arg) => typeof arg !== "string") ||
      ![
        record.started,
        record.ended,
        record.stdoutBytes,
        record.stderrBytes,
      ].every((value) => Number.isSafeInteger(value) && value >= 0) ||
      record.ended < record.started ||
      (record.exitCode !== null && !Number.isInteger(record.exitCode))
    )
      fail(`Malformed command record ${index + 1}; preserve the original log.`);
  }
  const success = (record: AuthorCommandRecord) =>
    record.exitCode === 0 && record.status === "succeeded";
  const query = (record: AuthorCommandRecord) =>
    ["guide", "api", "capabilities", "recipe", "help", "--help", "-h"].includes(record.args[0]);
  const attributed = (record: AuthorCommandRecord, id: string) => {
    const index = record.args.indexOf("--project");
    if (index < 0 || !record.args[index + 1]) return false;
    const relative = path.relative(
      path.resolve(workspace),
      path.resolve(workspace, record.args[index + 1]),
    );
    return !path.isAbsolute(relative) && relative.split(path.sep)[0] === id;
  };
  const taskReports = tasks.map((id) => {
    const commands = records.filter((record) => attributed(record, id));
    const checks = commands.filter((record) => record.args[0] === "check");
    return {
      id,
      firstCheckSucceeded: checks.length ? success(checks[0]) : null,
      checks: checks.length,
      rechecks: Math.max(0, checks.length - 1),
      failedChecks: checks.filter((record) => !success(record)).length,
      successfulBuilds: commands.filter(
        (record) => record.args[0] === "build" && success(record),
      ).length,
      commandWallMs: commands.reduce(
        (sum, record) => sum + record.ended - record.started,
        0,
      ),
    };
  });
  const queries = records.filter(query),
    attempted = taskReports.filter((task) => task.firstCheckSucceeded !== null);
  return {
    format: "pelican.author-command-report",
    version: 1,
    commands: records.length,
    query: {
      count: queries.length,
      failed: queries.filter((record) => !success(record)).length,
      stdoutBytes: queries.reduce((sum, record) => sum + record.stdoutBytes, 0),
      stderrBytes: queries.reduce((sum, record) => sum + record.stderrBytes, 0),
      wallMs: queries.reduce(
        (sum, record) => sum + record.ended - record.started,
        0,
      ),
    },
    tasks: taskReports,
    firstCheck: {
      attemptedTasks: attempted.length,
      succeeded: attempted.filter((task) => task.firstCheckSucceeded).length,
      rate: attempted.length
        ? attempted.filter((task) => task.firstCheckSucceeded).length /
          attempted.length
        : null,
    },
    limits: [
      "First-check success is not first-attempt task completion or browser acceptance.",
      "Rechecks are measured; code repairs and infrastructure retries require the preserved author timeline.",
      "Command wall time excludes author thinking/editing and is not model compute time. Query bytes are UTF-8 output bytes, not token counts.",
      "Queries without --project contribute to total cost but are not attributed to an individual task. No missing runtime evidence is treated as a pass.",
    ],
  };
}

export async function readAuthorCommandReport(workspace: string) {
  const task = JSON.parse(
    await readFile(path.join(workspace, "TASK.json"), "utf8"),
  );
  if (
    !Array.isArray(task.tasks) ||
    task.tasks.some(
      (item: unknown) =>
        !item ||
        typeof item !== "object" ||
        !("id" in item) ||
        typeof item.id !== "string",
    )
  )
    fail("TASK.json must declare task IDs.");
  const text = await readFile(path.join(workspace, "commands.jsonl"), "utf8");
  const records = text
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line) as AuthorCommandRecord;
      } catch {
        return fail(
          `Invalid commands.jsonl line ${index + 1}; do not discard failed evidence.`,
        );
      }
    });
  return {
    ...summarizeAuthorCommands(
      workspace,
      task.tasks.map((item: { id: string }) => item.id),
      records,
    ),
    engineVersion: task.engineVersion,
  };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== "--workspace" || !args[1])
    fail(
      "Usage: npm run evaluate:author:report -- --workspace <evaluation-directory>",
    );
  readAuthorCommandReport(path.resolve(args[1]))
    .then((report) => console.log(JSON.stringify(report, null, 2)))
    .catch((error) => {
      console.error(String(error));
      process.exitCode = 1;
    });
}
