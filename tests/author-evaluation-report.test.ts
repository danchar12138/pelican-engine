import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import {
  summarizeAuthorCommands,
  type AuthorCommandRecord,
} from "../tools/author-evaluation-report.ts";

const record = (args: string[], succeeded = true): AuthorCommandRecord => ({
  started: 100,
  ended: 150,
  args,
  exitCode: succeeded ? 0 : 1,
  status: succeeded ? "succeeded" : "failed",
  stdoutBytes: 200,
  stderrBytes: 0,
});
test("author metrics derive from commands and distinguish absent checks, rechecks and runtime claims", () => {
  const workspace = path.resolve(".pelican/eval");
  const report = summarizeAuthorCommands(
    workspace,
    ["collect", "extension", "unstarted"],
    [
      record(["guide"]),
      record(["api", "--search", "wrong"], false),
      record(["check", "--project", "collect"]),
      record(["build", "--project", path.join(workspace, "collect")]),
      record(["check", "--project", "extension"], false),
      record(["check", "--project", "extension"]),
      record(["check", "--project", "../outside/collect"]),
    ],
  );
  assert.deepEqual(report.firstCheck, {
    attemptedTasks: 2,
    succeeded: 1,
    rate: 0.5,
  });
  assert.deepEqual(report.query, {
    count: 2,
    failed: 1,
    stdoutBytes: 400,
    stderrBytes: 0,
    wallMs: 100,
  });
  assert.equal(report.tasks[0].successfulBuilds, 1);
  assert.equal(report.tasks[1].rechecks, 1);
  assert.equal(report.tasks[2].firstCheckSucceeded, null);
  assert.ok(
    report.limits.some((limit) =>
      limit.includes("not first-attempt task completion"),
    ),
  );
});
test("author report rejects malformed logs instead of hiding failures or inventing a rate", () => {
  assert.equal(summarizeAuthorCommands(".", [], [record(["--help"]), record(["-h"])]).query.count, 2);
  assert.equal(
    summarizeAuthorCommands(".", ["game"], []).firstCheck.rate,
    null,
  );
  for (const mutate of [
    (input: AuthorCommandRecord) => {
      input.ended = 0;
    },
    (input: AuthorCommandRecord) => {
      input.stdoutBytes = -1;
    },
    (input: AuthorCommandRecord) => {
      input.args = [0] as never;
    },
  ]) {
    const input = record(["check"]);
    mutate(input);
    assert.throws(
      () => summarizeAuthorCommands(".", ["game"], [input]),
      /TC_AUTHOR_EVALUATION/,
    );
  }
  assert.throws(
    () => summarizeAuthorCommands(".", ["game", "game"], []),
    /TC_AUTHOR_EVALUATION/,
  );
});
