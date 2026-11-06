import test from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, cp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { generateApiIndex, queryApiSymbol } from "../tools/api-index.ts";
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
    assert.ok(!fn.signature.includes('kind: "system"'));
    for (const symbol of index.symbols)
      assert.doesNotMatch(
        symbol.signature,
        /\b(GPUDevice|Object3D|WebGPURenderer|WebGPUBackend)\b/,
      );
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
  for (const [args, code] of [
    [["--symbol"], "TC_API_SYMBOL_REQUIRED"],
    [["--symbol", "--unused"], "TC_API_SYMBOL_REQUIRED"],
    [["--symbol", "--project"], "TC_API_SYMBOL_REQUIRED"],
    [["--symbol", "x", "--symbol", "y"], "TC_API_SYMBOL_DUPLICATE"],
    [["--symbol", "NotAPublicSymbol"], "TC_API_SYMBOL_UNKNOWN"],
  ] as const) {
    const failed = run(...args);
    assert.equal(failed.status, 1);
    assert.equal(failed.output.diagnostics[0].code, code);
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
