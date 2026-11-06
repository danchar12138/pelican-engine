import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import ts from "typescript";

const source = await readFile(new URL("../tools/m3-development.ts", import.meta.url), "utf8");
const ast = ts.createSourceFile("probe.ts", source, ts.ScriptTarget.Latest, true);
const fn = (name: string) => ast.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === name)!.getText(ast).replace(/^export /, "");
const registered: string[] = [];
function visit(node: ts.Node) {
  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "check" && ts.isStringLiteral(node.arguments[0])) registered.push(node.arguments[0].text);
  ts.forEachChild(node, visit);
}
visit(ast);
const context = vm.createContext({ console: { log() {} }, selectedChecks: new Set(["typecheck"]), checks: [] as unknown[] });
vm.runInContext(ts.transpileModule(fn("planM3Checks") + "\n" + fn("check"), { compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.None } }).outputText, context);
const plan = (args: string[]) => JSON.parse(JSON.stringify(context.planM3Checks(args)));

test("default plan exactly matches actual registered M3 checks", () => {
  const selected = plan([]);
  assert.equal(selected.mode, "full");
  assert.deepEqual(selected.selected, registered);
  assert.deepEqual(selected.omitted, []);
});
test("narrow plans add only actual browser startup dependencies", () => {
  const selected = plan(["--checks", "image-history-lights,device-reconstruction"]);
  assert.deepEqual(selected.selected, ["compile-and-serve", "image-history-lights", "device-reconstruction"]);
  assert.deepEqual(selected.automatic, ["compile-and-serve"]);
  assert.equal(selected.omitted.length, registered.length - 3);
  assert.deepEqual(plan(["--checks", "surface-numeric,surface-numeric"]).selected, ["surface-numeric"]);
  assert.deepEqual(plan(["--checks", "typecheck"]).selected, ["typecheck"]);
  assert.deepEqual(plan(["--checks", "temporal-motion-history"]).selected, ["temporal-motion-history"]);
});
test("list/invalid selectors cannot implicitly launch the full suite", () => {
  assert.deepEqual(plan(["--list"]).selected, []);
  for (const args of [["--checks"], ["--checks", ""], ["--checks", "typo"], ["--checks", "typecheck,"], ["--check", "typecheck"], ["--list", "--checks", "typecheck"]])
    assert.throws(() => plan(args), /TC_PROBE_SELECTION/);
});
test("unselected operations are never invoked and omitted results never become passed", async () => {
  let calls = 0;
  await context.check("native-1080p-observation", () => { calls++; throw Error("must not run"); });
  assert.equal(calls, 0);
  assert.equal(context.checks.length, 0);
  await context.check("typecheck", async () => { calls++; return ["typecheck.txt"]; });
  assert.equal(calls, 1);
  assert.equal(context.checks.length, 1);
  assert.equal(context.checks[0].id, "typecheck");
});
