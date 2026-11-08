import test from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, cp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { generateApiIndex, queryApiSymbol, queryApi, type ApiSymbol } from "../tools/api-index.ts";
import ts from "typescript";
import { componentJSONSchema } from "../packages/schema/src/index.ts";
import { defineComponent, SDK_VERSION } from "../packages/sdk/src/index.ts";

test("API index derives real public signatures and omits function implementations and private backend types", async () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const folder = await mkdtemp(path.join(tmpdir(), "pelican-api-index-"));
  try {
    await mkdir(path.join(folder, "packages/sdk/src"), { recursive: true });
    await cp(
      path.join(root, "packages/sdk/src/index.ts"),
      path.join(folder, "packages/sdk/src/index.ts"),
    );
    const index = await generateApiIndex(folder);
    assert.equal(index.engineVersion, SDK_VERSION);
    assert.ok(
      index.symbols
        .find((item) => item.name === "SystemContext")
        ?.fields?.includes("entities"),
    );
    assert.ok(index.symbols.some((item) => item.name === "EntityHandle"));
    const audio = index.symbols.find((item) => item.name === "AudioService");
    assert.ok(audio?.fields?.includes("pause") && audio.fields.includes("resume") && audio.fields.includes("busVolume") && audio.fields.includes("fadeBus"));
    const navigation = index.symbols.find((item) => item.name === "NavigationService");
    assert.ok(navigation?.fields?.includes("getGrid") && navigation.fields.includes("isBlocked"));
    const fn = index.symbols.find((item) => item.name === "defineSystem")!;
    assert.ok(fn.signature.endsWith(";"));
    assert.ok(!fn.signature.includes("return {"));
    for (const symbol of [...index.symbols, ...index.members])
      assert.doesNotMatch(
        symbol.signature,
        /\b(GPUDevice|GPUBuffer|GPUTexture|Object3D|WebGPURenderer|WebGPUBackend)\b/,
      );
    assert.equal(index.version, 2);
    const play = index.members.find(item => item.name === "AudioService.play")!;
    assert.equal(play.owner, "AudioService");
    assert.equal(play.member, "play");
    assert.match(play.signature, /^play\(/);
    assert.doesNotMatch(play.signature, /stop\(voice/);
    assert.deepEqual(queryApiSymbol(index.symbols, ["--symbol", "AudioService.play"], index.members), [play]);
    const source = await readFile(path.join(folder, "packages/sdk/src/index.ts"), "utf8");
    const sf = ts.createSourceFile("index.ts", source, ts.ScriptTarget.Latest, true);
    // Exhaust every directly declared member against the original AST, not a handwritten API list.
    for (const declaration of sf.statements) {
      if (!ts.isInterfaceDeclaration(declaration)) continue;
      for (const member of declaration.members) {
        if (!member.name) continue;
        const match: ApiSymbol | undefined = index.members.find(item => item.name === `${declaration.name.text}.${member.name!.getText(sf)}` && item.signature === member.getText(sf));
        assert.ok(match, `${declaration.name.text}.${member.name.getText(sf)}`);
        assert.equal(match.line, sf.getLineAndCharacterOfPosition(member.getStart(sf)).line + 1);
        assert.equal(match.source, "packages/sdk/src/index.ts");
      }
    }
    const inherited = index.members.find(item => item.name === "AnimationControlService.play")!;
    assert.equal(inherited.inheritedFrom, "AnimationService");
    assert.ok(index.members.some(item => item.name === "SystemContext.time.tick"));
    assert.ok(index.members.some(item => item.name === "SystemContext.audio.play"));
    const exact = queryApi(index, ["--search", "AudioService.play", "--member", "--limit", "1"]);
    assert.ok(Array.isArray(exact.symbols));
    assert.equal(exact.symbols[0].name, "AudioService.play");
    const limited = queryApi(index, ["--search", "play", "--member", "--limit", "1"]);
    assert.ok(Array.isArray(limited.symbols));
    assert.equal(limited.symbols.length, 1);
    assert.equal(limited.symbols[0].member, "play");
    assert.ok(limited.total > 1);
    assert.equal(limited.truncated, true);
    const file = JSON.parse(
      await readFile(path.join(folder, "docs/api/index.json"), "utf8"),
    );
    assert.deepEqual(file, index);
    assert.equal(queryApiSymbol(index.symbols, []), undefined);
    assert.deepEqual(queryApiSymbol(index.symbols, ["--symbol", "defineSystem"]), [fn]);
    assert.deepEqual(queryApiSymbol(file.symbols, ["--symbol", "defineSystem"]), [fn]);
    assert.throws(() => queryApiSymbol(index.symbols, ["--symbol"]), /TC_API_SYMBOL_REQUIRED/);
    assert.throws(() => queryApiSymbol(index.symbols, ["--symbol", "--project"]), /TC_API_SYMBOL_REQUIRED/);
    assert.throws(() => queryApiSymbol(index.symbols, ["--symbol", "defineSystem", "--symbol", "defineGame"]), /TC_API_SYMBOL_DUPLICATE/);
    assert.throws(() => queryApiSymbol(index.symbols, ["--symbol", "definesystem"]), /TC_API_SYMBOL_UNKNOWN/);
  } finally {
    if (path.dirname(path.resolve(folder)) !== path.resolve(tmpdir()))
      throw new Error("Invalid temporary cleanup target");
    await rm(folder, { recursive: true, force: true });
  }
});
test("API CLI returns exact symbols and machine-readable failures", () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const run = (...args: string[]) => {
    const result = spawnSync(process.execPath, ["--import", "tsx", "tools/cli.ts", "api", ...args], {
      cwd: root, encoding: "utf8", timeout: 30000,
    });
    assert.equal(result.error, undefined);
    return { status: result.status, output: JSON.parse(result.stdout) };
  };
  const plain = run();
  assert.equal(plain.status, 0);
  assert.equal(typeof plain.output.data.symbols, "number");
  const found = run("--symbol", "defineGame");
  assert.equal(found.status, 0);
  assert.equal(found.output.data.symbols[0].name, "defineGame");
  assert.equal(found.output.data.total, 1);
  assert.equal(found.output.data.truncated, false);
  const member = run("--symbol", "AudioService.play");
  assert.equal(member.status, 0);
  assert.equal(member.output.data.symbols[0].owner, "AudioService");
  assert.equal(typeof member.output.data.symbols[0].line, "number");
  const search = run("--search", "play", "--member", "--limit", "1");
  assert.equal(search.status, 0);
  assert.equal(search.output.data.symbols[0].member, "play");
  assert.ok(search.output.data.total > 1);
  assert.equal(search.output.data.truncated, true);
  for (const [args, code] of [
    [["--symbol"], "TC_API_SYMBOL_REQUIRED"],
    [["--symbol", "--unused"], "TC_API_SYMBOL_REQUIRED"],
    [["--symbol", "--project"], "TC_API_SYMBOL_REQUIRED"],
    [["--symbol", "x", "--symbol", "y"], "TC_API_SYMBOL_DUPLICATE"],
    [["--symbol", "NotAPublicSymbol"], "TC_API_SYMBOL_UNKNOWN"],
    [["--symbol", "AudioService.missing"], "TC_API_SYMBOL_UNKNOWN"],
    [["--search"], "TC_API_SEARCH"],
    [["--search", "   "], "TC_API_SEARCH"],
    [["--search", "noSuchPublicMemberXYZ", "--member"], "TC_API_SEARCH_UNKNOWN"],
    [["--search", "play", "--limit"], "TC_API_LIMIT"],
    [["--search", "play", "--limit", "0"], "TC_API_LIMIT"],
    [["--search", "play", "--limit", "101"], "TC_API_LIMIT"],
    [["--search", "play", "--search", "pause"], "TC_API_SEARCH"],
    [["--symbol", "AudioService", "--search", "play"], "TC_API_SEARCH"],
    [["--member"], "TC_API_MEMBER"],
    [["--search", "play", "--member", "play"], "TC_API_QUERY"],
  ] as const) {
    const failed = run(...args);
    assert.equal(failed.status, 1);
    assert.equal(failed.output.diagnostics[0].code, code);
  }
});
test("member index preserves overloads, inline records, aliases and inherited source positions", async () => {
  const folder = await mkdtemp(path.join(tmpdir(), "pelican-api-members-"));
  try {
    await mkdir(path.join(folder, "packages/sdk/src"), { recursive: true });
    await writeFile(path.join(folder, "packages/sdk/src/index.ts"), `
export interface Base {
  play(id: string): string;
  play(id: number): number;
}
export interface Child extends Base { nested: { stop(): void }; }
export type Alias = Child & { pause(): void };
interface Private { secret(): void }
`);
    const index = await generateApiIndex(folder);
    const result = queryApi(index, ["--symbol", "Child.play"]);
    assert.ok(Array.isArray(result.symbols));
    assert.equal(result.total, 2);
    assert.equal(result.truncated, false);
    assert.deepEqual(result.symbols.map(item => item.line), [3, 4]);
    assert.ok(index.members.some(item => item.name === "Child.nested.stop"));
    assert.ok(index.members.some(item => item.name === "Alias.pause"));
    assert.ok(index.members.some(item => item.name === "Alias.play"));
    assert.ok(!index.members.some(item => item.name.startsWith("Private.")));
  } finally {
    assert.equal(path.dirname(path.resolve(folder)), path.resolve(tmpdir()));
    assert.ok(path.basename(folder).startsWith("pelican-api-members-"));
    await rm(folder, { recursive: true, force: true });
  }
});
test("component JSON Schema follows the SDK declaration defaults without aliasing vectors", () => {
  const component = defineComponent({
    id: "Example",
    schema: {
      hp: { type: "number", default: 10 },
      position: { type: "vec3", default: [1, 2, 3] },
    },
  });
  const schema = componentJSONSchema(component);
  assert.equal(schema.title, "Example");
  assert.deepEqual(schema.required, ["hp", "position"]);
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.properties.position.default, [1, 2, 3]);
  (schema.properties.position.default as number[])[0] = 99;
  assert.deepEqual(component.schema.position.default, [1, 2, 3]);
});
