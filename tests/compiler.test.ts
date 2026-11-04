import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { createServer } from "vite";
import ts from "typescript";
import { compileProject } from "../experiments/compiler/index.ts";
import type { CompileResult, SceneIR } from "../experiments/compiler/types.ts";
import type {
  ComponentDefinition,
  ComponentSchema,
  ComponentValue,
  ComponentData,
  EngineFacade,
  GameInstance,
} from "../packages/sdk/src/index.ts";
const engineRoot = fileURLToPath(new URL("../", import.meta.url));
const template = await fs.readFile(
  new URL("../examples/m0/game.ts", import.meta.url),
  "utf8",
);
type FixtureSelector<T extends ts.Node = ts.Node> = (
  source: ts.SourceFile,
) => T;
const parseFixture = (text: string) =>
  ts.createSourceFile(
    "game.ts",
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
function exactlyOne<T>(items: readonly T[], label: string): T {
  assert.equal(
    items.length,
    1,
    "Fixture error: expected exactly one " +
      label +
      ", found " +
      items.length +
      ".",
  );
  return items[0]!;
}
function fixtureProperty(object: ts.Node, name: string): ts.PropertyAssignment {
  assert.ok(
    ts.isObjectLiteralExpression(object),
    "Fixture error: " + name + " requires an object literal.",
  );
  return exactlyOne(
    object.properties.filter(
      (p): p is ts.PropertyAssignment =>
        ts.isPropertyAssignment(p) &&
        (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) &&
        p.name.text === name,
    ),
    "property " + name,
  );
}
function definition(
  source: ts.SourceFile,
  api: string,
  id: string,
): ts.ObjectLiteralExpression {
  const matches: ts.ObjectLiteralExpression[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === api
    ) {
      const input = node.arguments[0];
      if (input && ts.isObjectLiteralExpression(input)) {
        const value = fixtureProperty(input, "id").initializer;
        if (ts.isStringLiteral(value) && value.text === id) matches.push(input);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return exactlyOne(matches, api + "(" + id + ") declaration");
}
const definitionValue =
  (
    api: string,
    id: string,
    ...keys: string[]
  ): FixtureSelector<ts.Expression> =>
  (source) => {
    let value: ts.Expression = definition(source, api, id);
    for (const key of keys) value = fixtureProperty(value, key).initializer;
    return value;
  };
const graphNode =
  (id: string): FixtureSelector<ts.ObjectLiteralExpression> =>
  (source) => {
    const nodes = definitionValue(
      "defineMaterial",
      "animated",
      "graph",
      "nodes",
    )(source);
    assert.ok(
      ts.isArrayLiteralExpression(nodes),
      "Fixture error: animated graph nodes must be an array.",
    );
    return exactlyOne(
      nodes.elements.filter((n): n is ts.ObjectLiteralExpression => {
        if (!ts.isObjectLiteralExpression(n)) return false;
        const value = fixtureProperty(n, "id").initializer;
        return ts.isStringLiteral(value) && value.text === id;
      }),
      "animated graph node " + id,
    );
  };
const graphValue =
  (id: string, key: string): FixtureSelector<ts.Expression> =>
  (source) =>
    fixtureProperty(graphNode(id)(source), key).initializer;
const sceneEntity =
  (id: string): FixtureSelector<ts.ObjectLiteralExpression> =>
  (source) => {
    const entities = definitionValue(
      "defineScene",
      "m0-scene",
      "entities",
    )(source);
    assert.ok(
      ts.isArrayLiteralExpression(entities),
      "Fixture error: scene entities must be an array.",
    );
    return exactlyOne(
      entities.elements.filter((n): n is ts.ObjectLiteralExpression => {
        if (!ts.isObjectLiteralExpression(n)) return false;
        const value = fixtureProperty(n, "id").initializer;
        return ts.isStringLiteral(value) && value.text === id;
      }),
      "scene entity " + id,
    );
  };
const systemRun: FixtureSelector<ts.MethodDeclaration> = (source) => {
  const system = definition(source, "defineSystem", "spin");
  return exactlyOne(
    system.properties.filter(
      (p): p is ts.MethodDeclaration =>
        ts.isMethodDeclaration(p) &&
        ts.isIdentifier(p.name) &&
        p.name.text === "run",
    ),
    "spin run method",
  );
};
// Change only the selected AST range; fixture formatting and quote style are irrelevant.
function mutateFixture<T extends ts.Node>(
  text: string,
  label: string,
  select: FixtureSelector<T>,
  change: string | ((node: T) => ts.Node | string),
): string {
  const source = parseFixture(text);
  const node = select(source);
  const updated = typeof change === "string" ? change : change(node);
  const replacement =
    typeof updated === "string"
      ? updated
      : ts.createPrinter().printNode(ts.EmitHint.Unspecified, updated, source);
  const before = text.slice(node.getStart(source), node.end);
  assert.notEqual(
    replacement,
    before,
    "Fixture error: " + label + " did not change its target.",
  );
  const changed =
    text.slice(0, node.getStart(source)) + replacement + text.slice(node.end);
  assert.notEqual(
    changed,
    text,
    "Fixture error: " + label + " did not change the source.",
  );
  return changed;
}
function addFixtureProperty(
  text: string,
  label: string,
  select: FixtureSelector<ts.ObjectLiteralExpression>,
  name: string,
  value: ts.Expression,
): string {
  return mutateFixture(text, label, select, (object) => {
    assert.ok(
      !object.properties.some(
        (p) => p.name && ts.isIdentifier(p.name) && p.name.text === name,
      ),
      "Fixture error: " + label + " property already exists.",
    );
    return ts.factory.updateObjectLiteralExpression(object, [
      ...object.properties,
      ts.factory.createPropertyAssignment(name, value),
    ]);
  });
}
function withAssetImport(text: string): string {
  return mutateFixture(
    text,
    "add defineAsset import",
    (source) => {
      const declaration = exactlyOne(
        source.statements.filter(
          (s): s is ts.ImportDeclaration =>
            ts.isImportDeclaration(s) &&
            ts.isStringLiteral(s.moduleSpecifier) &&
            s.moduleSpecifier.text === "@threecat/sdk",
        ),
        "SDK import",
      );
      const bindings = declaration.importClause?.namedBindings;
      assert.ok(
        bindings && ts.isNamedImports(bindings),
        "Fixture error: SDK requires named imports.",
      );
      return bindings;
    },
    (bindings) => {
      assert.ok(
        !bindings.elements.some((e) => e.name.text === "defineAsset"),
        "Fixture error: defineAsset already imported.",
      );
      return ts.factory.updateNamedImports(bindings, [
        ...bindings.elements,
        ts.factory.createImportSpecifier(
          false,
          undefined,
          ts.factory.createIdentifier("defineAsset"),
        ),
      ]);
    },
  );
}
function withRunStatements(text: string, statements: string): string {
  assert.ok(
    parseFixture(statements).statements.length,
    "Fixture error: run mutation must insert statements.",
  );
  const source = parseFixture(text);
  const body = systemRun(source).body;
  assert.ok(body, "Fixture error: run method has no body.");
  const replacement =
    "{\n" +
    statements +
    "\n" +
    text.slice(body.getStart(source) + 1, body.end - 1) +
    "}";
  return mutateFixture(
    text,
    "insert run statements",
    (current) => {
      const selected = systemRun(current).body;
      assert.ok(selected, "Fixture error: run method has no body.");
      return selected;
    },
    replacement,
  );
}
async function project(
  t: { after(fn: () => Promise<void>): void },
  text = template,
) {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "threecat compiler \u4e2d\u6587 "),
  );
  t.after(async () => {
    const verified = path.resolve(root);
    assert.equal(
      path.dirname(verified).toLowerCase(),
      path.resolve(os.tmpdir()).toLowerCase(),
    );
    assert.ok(path.basename(verified).startsWith("threecat compiler "));
    await fs.rm(verified, { recursive: true, force: true });
  });
  await fs.writeFile(path.join(root, "game.ts"), text);
  return {
    root,
    out: path.join(root, "dist"),
    compile: () =>
      compileProject({ projectRoot: root, outDir: "dist", engineRoot }),
  };
}
function success(
  result: CompileResult,
): asserts result is CompileResult & { ir: SceneIR } {
  assert.equal(
    result.success,
    true,
    JSON.stringify(result.diagnostics, null, 2),
  );
  assert.ok(result.ir);
}
function facade(ir: SceneIR): EngineFacade {
  const entities = new Map(
    ir.scene.entities.map((e) => [e.id, structuredClone(e)]),
  );
  const entity = (id: string) => {
    const e = entities.get(id);
    assert.ok(e, "Unknown entity: " + id);
    return e;
  };
  const componentId = (c: ComponentDefinition | string) =>
    typeof c === "string" ? c : c.id;
  return {
    getTransform(id) {
      return structuredClone(entity(id).transform);
    },
    setTransform(id, patch) {
      Object.assign(entity(id).transform, structuredClone(patch));
    },
    getComponent<S extends ComponentSchema>(
      id: string,
      c: ComponentDefinition<S> | string,
    ): ComponentValue<S> & ComponentData {
      return structuredClone(
        entity(id).components[componentId(c)],
      ) as ComponentValue<S> & ComponentData;
    },
    setComponent(id: string, c: ComponentDefinition | string, value: object) {
      Object.assign(
        entity(id).components[componentId(c)]!,
        structuredClone(value),
      );
    },
    query(c) {
      return [...entities.values()]
        .filter((e) => componentId(c) in e.components)
        .map((e) => e.id);
    },
  };
}
async function importGame(
  out: string,
): Promise<{ createGame(engine: EngineFacade): GameInstance }> {
  return import(
    pathToFileURL(path.join(out, "game.js")).href +
      "?test=" +
      Date.now() +
      Math.random()
  );
}

test("compiler: real TS to IR and standalone JS executes component-driven gameplay", async (t) => {
  const p = await project(t);
  const result = await p.compile();
  success(result);
  assert.equal(result.report.compilerVersion, "6.0.3");
  assert.equal(result.ir.format, "threecat.scene");
  assert.equal(result.ir.scene.entities.length, 6);
  assert.equal(
    result.ir.scene.entities.find((e) => e.id === "m0-spinner")?.components
      .Motion?.speed,
    0.8,
  );
  assert.equal(
    result.ir.materials.find((m) => m.id === "animated")?.graph?.outputType,
    "vec3",
  );
  assert.equal(result.ir.computes[0]?.graph.outputType, "float");
  for (const artifact of [
    "scene.ir.json",
    "game.js",
    "game.js.map",
    "build-report.json",
    "version.json",
  ])
    assert.ok((await fs.stat(path.join(p.out, artifact))).size > 0);
  const gameModule = await importGame(p.out);
  const world = facade(result.ir);
  const game = gameModule.createGame(world);
  assert.equal(world.getTransform("m0-spinner").rotation[1], 0);
  game.update(0.5);
  assert.equal(world.getTransform("m0-spinner").rotation[1], 0.4);
  world.setComponent("m0-spinner", "Motion", { speed: 2 });
  game.update(0.5);
  assert.equal(world.getTransform("m0-spinner").rotation[1], 1.4);
  world.setComponent("m0-spinner", "Motion", { enabled: false });
  game.update(1);
  assert.equal(world.getTransform("m0-spinner").rotation[1], 1.4);
  assert.throws(() => game.update(NaN), /TC_RUNTIME_DT/);
  game.dispose();
  assert.throws(() => game.update(1), /TC_RUNTIME_DISPOSED/);
  const js = await fs.readFile(path.join(p.out, "game.js"), "utf8");
  assert.doesNotMatch(js, /from ["'](?:three|@threecat|typescript)/);
  const map = JSON.parse(
    await fs.readFile(path.join(p.out, "game.js.map"), "utf8"),
  );
  assert.ok(map.sources.includes("game.ts"));
  assert.ok(
    map.sourcesContent.some((s: string) => s.includes("engine.setTransform")),
  );
  assert.ok(
    map.sources.every(
      (s: string) => !path.isAbsolute(s) && !s.includes(p.root),
    ),
  );
});

test("compiler: arbitrary module side effects are rejected, never executed", async (t) => {
  const marker = "__threecatCompilerSideEffect";
  const global = globalThis as unknown as Record<string, unknown>;
  delete global[marker];
  const p = await project(
    t,
    "const bad = (() => { (globalThis as unknown as Record<string, unknown>)." +
      marker +
      " = true; return 1; })();\n" +
      template,
  );
  const result = await p.compile();
  assert.equal(result.success, false);
  assert.ok(result.diagnostics.some((d) => d.code === "TC_STATIC_SIDE_EFFECT"));
  assert.equal(global[marker], undefined);
  await assert.rejects(fs.access(path.join(p.out, "game.js")));
});

test("compiler: imported module side effects are detected before bundling", async (t) => {
  const p = await project(
    t,
    'import { unused } from "./side.ts";\n' + template,
  );
  await fs.writeFile(
    path.join(p.root, "side.ts"),
    'export const unused = 1; throw new Error("must never execute");',
  );
  const result = await p.compile();
  assert.equal(result.success, false);
  assert.ok(
    result.diagnostics.some(
      (d) => d.code === "TC_STATIC_SIDE_EFFECT" && d.source?.file === "side.ts",
    ),
  );
});

test("compiler: private engine and platform dependency imports produce public API diagnostics", async (t) => {
  const p = await project(t, 'import { Mesh } from "three";\n' + template);
  const result = await p.compile();
  assert.equal(result.success, false);
  assert.ok(result.diagnostics.some((d) => d.code === "TC_PUBLIC_API"));
});

test("compiler: TS type errors retain stable codes and source coordinates", async (t) => {
  const p = await project(t, 'const wrong: number = "text";\n' + template);
  const result = await p.compile();
  assert.equal(result.success, false);
  const d = result.diagnostics.find((d) => d.code === "TC_TS_2322");
  assert.ok(d?.source);
  assert.equal(d.source.file, "game.ts");
  assert.equal(d.source.line, 1);
  assert.equal(d.source.column, 7);
});

test("compiler: bad graph types point at the original inputs expression", async (t) => {
  const text = mutateFixture(
    template,
    "tint multiply becomes add",
    graphValue("tint", "op"),
    (node) => {
      assert.ok(
        ts.isStringLiteral(node) && node.text === "multiply",
        "Fixture error: tint must initially multiply.",
      );
      return ts.factory.createStringLiteral("add");
    },
  );
  assert.throws(
    () =>
      mutateFixture(text, "no-op guard", graphValue("tint", "op"), (node) =>
        node.getText(),
      ),
    /Fixture error:.*did not change/,
  );
  assert.throws(
    () =>
      mutateFixture(
        text,
        "missing target guard",
        graphValue("absent", "op"),
        '"add"',
      ),
    /Fixture error:.*found 0/,
  );
  const p = await project(t, text);
  const result = await p.compile();
  assert.equal(result.success, false);
  const d = result.diagnostics.find((d) => d.code === "TC_GRAPH_TYPE");
  assert.ok(d?.source);
  const source = parseFixture(text);
  const inputs = graphValue("tint", "inputs")(source);
  const position = source.getLineAndCharacterOfPosition(
    inputs.getStart(source),
  );
  assert.deepEqual(d.source, {
    file: "game.ts",
    line: position.line + 1,
    column: position.character + 1,
    length: inputs.end - inputs.getStart(source),
  });
});

test("compiler: graph cycles and missing nodes are rejected", async (t) => {
  const p = await project(
    t,
    mutateFixture(
      template,
      "self-referencing wave",
      graphValue("wave", "inputs"),
      '["wave"]',
    ),
  );
  let result = await p.compile();
  assert.equal(result.success, false);
  assert.ok(result.diagnostics.some((d) => d.code === "TC_GRAPH_CYCLE"));
  await fs.writeFile(
    path.join(p.root, "game.ts"),
    mutateFixture(
      template,
      "missing tint input",
      graphValue("tint", "inputs"),
      '["base", "absent"]',
    ),
  );
  result = await p.compile();
  assert.equal(result.success, false);
  assert.ok(result.diagnostics.some((d) => d.code === "TC_GRAPH_REFERENCE"));
});

test("compiler: missing material, missing asset and parent cycles are explicit failures", async (t) => {
  const p = await project(
    t,
    mutateFixture(
      template,
      "missing prefab material",
      definitionValue("definePrefab", "Spinner", "mesh", "material"),
      '"absent"',
    ),
  );
  let result = await p.compile();
  assert.equal(result.success, false);
  assert.ok(result.diagnostics.some((d) => d.code === "TC_RESOURCE_MISSING"));
  await fs.writeFile(
    path.join(p.root, "game.ts"),
    withAssetImport(template) +
      '\nconst missing = defineAsset({id:"missing",path:"absent.png",type:"texture"});',
  );
  result = await p.compile();
  assert.equal(result.success, false);
  assert.ok(result.diagnostics.some((d) => d.code === "TC_ASSET_MISSING"));
  const withParent = addFixtureProperty(
    template,
    "spinner parent",
    sceneEntity("m0-spinner"),
    "parent",
    ts.factory.createStringLiteral("m0-orb"),
  );
  const parentCycle = addFixtureProperty(
    withParent,
    "orb parent",
    sceneEntity("m0-orb"),
    "parent",
    ts.factory.createStringLiteral("m0-spinner"),
  );
  await fs.writeFile(path.join(p.root, "game.ts"), parentCycle);
  result = await p.compile();
  assert.equal(result.success, false);
  assert.ok(result.diagnostics.some((d) => d.code === "TC_SCENE_CYCLE"));
});

test("compiler: static const and string-referenced prefab cycles cannot recurse indefinitely", async (t) => {
  const p = await project(
    t,
    "const a: unknown = b; const b: unknown = a;\n" + template,
  );
  let result = await p.compile();
  assert.equal(result.success, false);
  assert.ok(result.diagnostics.some((d) => d.code === "TC_DECLARATION_CYCLE"));
  await fs.writeFile(
    path.join(p.root, "game.ts"),
    template +
      '\nconst pa=definePrefab({id:"pa",extends:"pb"});const pb=definePrefab({id:"pb",extends:"pa"});',
  );
  result = await p.compile();
  assert.equal(result.success, false);
  assert.ok(result.diagnostics.some((d) => d.code === "TC_PREFAB_CYCLE"));
});

test("compiler: local definition modules, aliases and inherited prefabs resolve without evaluation", async (t) => {
  const p = await project(
    t,
    'import { shape as inherited } from "./defs.ts";\n' +
      mutateFixture(
        template,
        "inherited scene prefab",
        (source) =>
          fixtureProperty(sceneEntity("m0-spinner")(source), "prefab")
            .initializer,
        "inherited",
      ),
  );
  await fs.writeFile(
    path.join(p.root, "defs.ts"),
    'import {definePrefab as prefab,defineMaterial} from "@threecat/sdk";const material=defineMaterial({id:"localMat"});const base=prefab({id:"base",transform:{scale:[2,2,2]},mesh:{geometry:{kind:"box"},material}});export const shape=prefab({id:"shape",extends:base,transform:{position:[1,2,3]}});',
  );
  const result = await p.compile();
  success(result);
  assert.deepEqual(
    result.ir.scene.entities.find((e) => e.id === "m0-spinner")?.transform
      .scale,
    [2, 2, 2],
  );
  assert.ok(result.report.inputs.some((i) => i.path === "defs.ts"));
  const map = JSON.parse(
    await fs.readFile(path.join(p.out, "game.js.map"), "utf8"),
  );
  assert.ok(map.sources.includes("defs.ts"));
});

test("compiler: cache reuses valid artifacts, source edits invalidate and schema/default policy is explicit", async (t) => {
  const p = await project(t);
  const first = await p.compile();
  success(first);
  assert.equal(first.report.incremental.cacheHit, false);
  const jsPath = path.join(p.out, "game.js");
  const mtime = (await fs.stat(jsPath)).mtimeMs;
  const second = await p.compile();
  success(second);
  assert.equal(second.report.incremental.cacheHit, true);
  assert.equal(second.report.hotReload.strategy, "reuse");
  assert.equal((await fs.stat(jsPath)).mtimeMs, mtime);
  await fs.writeFile(
    path.join(p.root, "game.ts"),
    mutateFixture(
      template,
      "Motion speed default",
      definitionValue(
        "defineComponent",
        "Motion",
        "schema",
        "speed",
        "default",
      ),
      "1.2",
    ),
  );
  const defaults = await p.compile();
  success(defaults);
  assert.equal(defaults.report.incremental.cacheHit, false);
  assert.equal(
    defaults.report.incremental.schemaHash,
    first.report.incremental.schemaHash,
  );
  assert.notEqual(
    defaults.report.incremental.defaultsHash,
    first.report.incremental.defaultsHash,
  );
  assert.equal(defaults.report.hotReload.strategy, "patch");
  assert.equal(defaults.report.hotReload.defaults, "new-entities-only");
  const extraField = ts.factory.createObjectLiteralExpression([
    ts.factory.createPropertyAssignment(
      "type",
      ts.factory.createStringLiteral("boolean"),
    ),
    ts.factory.createPropertyAssignment("default", ts.factory.createFalse()),
  ]);
  const changedSchema = addFixtureProperty(
    template,
    "Motion schema field",
    (source) => {
      const schema = definitionValue(
        "defineComponent",
        "Motion",
        "schema",
      )(source);
      assert.ok(
        ts.isObjectLiteralExpression(schema),
        "Fixture error: Motion schema must be an object.",
      );
      return schema;
    },
    "extra",
    extraField,
  );
  await fs.writeFile(path.join(p.root, "game.ts"), changedSchema);
  const layout = await p.compile();
  success(layout);
  assert.equal(layout.report.hotReload.strategy, "restart");
  assert.equal(layout.report.hotReload.preserveState, false);
  await fs.appendFile(jsPath, "\n// corrupted output");
  const corrupt = await p.compile();
  success(corrupt);
  assert.equal(corrupt.report.incremental.cacheHit, false);
  assert.ok(
    corrupt.report.incremental.changedInputs.includes("<generated-output>"),
  );
});

test("compiler: asset and imported-source content hashes invalidate cache", async (t) => {
  const extra =
    '\nconst payload=defineAsset({id:"payload",type:"binary",path:"data.bin"});';
  const assetTemplate = mutateFixture(
    withAssetImport(template),
    "imported Motion default",
    definitionValue("defineComponent", "Motion", "schema", "speed", "default"),
    "value",
  );
  const p = await project(
    t,
    'import {value} from "./value.ts";\n' + assetTemplate + extra,
  );
  await fs.writeFile(path.join(p.root, "value.ts"), "export const value=0.8;");
  await fs.writeFile(path.join(p.root, "data.bin"), "one");
  const first = await p.compile();
  success(first);
  const second = await p.compile();
  success(second);
  assert.equal(second.report.incremental.cacheHit, true);
  await fs.writeFile(path.join(p.root, "data.bin"), "two");
  const changed = await p.compile();
  success(changed);
  assert.equal(changed.report.incremental.cacheHit, false);
  assert.notEqual(changed.ir.assets[0]!.hash, first.ir.assets[0]!.hash);
  assert.equal(
    await fs.readFile(path.join(p.out, changed.ir.assets[0]!.path), "utf8"),
    "two",
  );
  await fs.writeFile(path.join(p.root, "value.ts"), "export const value=1.5;");
  const imported = await p.compile();
  success(imported);
  assert.equal(imported.report.incremental.cacheHit, false);
  assert.ok(imported.report.incremental.changedInputs.includes("value.ts"));
});

test("compiler: no-Git external Chinese/space directory supports configured entry and relocation", async (t) => {
  const p = await project(t);
  await fs.mkdir(path.join(p.root, "src \u5b50\u76ee\u5f55"));
  await fs.rename(
    path.join(p.root, "game.ts"),
    path.join(p.root, "src \u5b50\u76ee\u5f55", "entry.ts"),
  );
  await fs.writeFile(
    path.join(p.root, "threecat.project.json"),
    JSON.stringify({ entry: "src \u5b50\u76ee\u5f55/entry.ts" }),
  );
  const result = await p.compile();
  success(result);
  await assert.rejects(fs.access(path.join(p.root, ".git")));
  const moved = path.join(p.root, "\u642c\u79fb\u540e\u7684\u9879\u76ee");
  await fs.mkdir(moved);
  for (const name of [
    "src \u5b50\u76ee\u5f55",
    "threecat.project.json",
    "dist",
  ])
    await fs.rename(path.join(p.root, name), path.join(moved, name));
  const relocated = await compileProject({
    projectRoot: moved,
    outDir: "dist",
    engineRoot,
  });
  success(relocated);
  assert.equal(relocated.report.incremental.cacheHit, true);
  const game = (await importGame(path.join(moved, "dist"))).createGame(
    facade(relocated.ir),
  );
  game.update(1);
  game.dispose();
});

test("compiler: failed rebuild reports stale artifacts and preserves previous successful JS", async (t) => {
  const p = await project(t);
  const valid = await p.compile();
  success(valid);
  const previous = await fs.readFile(path.join(p.out, "game.js"), "utf8");
  await fs.writeFile(
    path.join(p.root, "game.ts"),
    mutateFixture(
      template,
      "stale build missing material",
      definitionValue("definePrefab", "Spinner", "mesh", "material"),
      '"missing"',
    ),
  );
  const failed = await p.compile();
  assert.equal(failed.success, false);
  assert.equal(
    await fs.readFile(path.join(p.out, "game.js"), "utf8"),
    previous,
  );
  const report = JSON.parse(
    await fs.readFile(path.join(p.out, "build-report.json"), "utf8"),
  );
  assert.equal(report.success, false);
  assert.equal(report.artifactState, "previous-success-not-current");
});

test("compiler: invalid graph values, missing outputs, async systems and malformed manifests do not silently pass", async (t) => {
  const p = await project(
    t,
    mutateFixture(
      template,
      "float node without value",
      graphNode("clock"),
      '({ id: "clock", op: "float" } as unknown as {id:string;op:"float";value:number})',
    ),
  );
  let result = await p.compile();
  assert.equal(result.success, false);
  assert.ok(result.diagnostics.some((d) => d.code === "TC_GRAPH_VALUE"));
  await fs.writeFile(
    path.join(p.root, "game.ts"),
    mutateFixture(
      template,
      "missing material graph output",
      definitionValue("defineMaterial", "animated", "graph", "output"),
      '"absent"',
    ),
  );
  result = await p.compile();
  assert.equal(result.success, false);
  assert.ok(result.diagnostics.some((d) => d.code === "TC_GRAPH_REFERENCE"));
  await fs.writeFile(
    path.join(p.root, "game.ts"),
    mutateFixture(template, "async update system", systemRun, (run) => {
      assert.ok(
        !run.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword),
        "Fixture error: run is already async.",
      );
      return ts.factory.updateMethodDeclaration(
        run,
        [
          ...(run.modifiers ?? []),
          ts.factory.createModifier(ts.SyntaxKind.AsyncKeyword),
        ],
        run.asteriskToken,
        run.name,
        run.questionToken,
        run.typeParameters,
        run.parameters,
        run.type,
        run.body,
      );
    }),
  );
  result = await p.compile();
  assert.equal(result.success, false);
  assert.ok(result.diagnostics.some((d) => d.code === "TC_SYSTEM_ASYNC"));
  await fs.writeFile(path.join(p.root, "threecat.project.json"), "{bad");
  result = await p.compile();
  assert.equal(result.success, false);
  assert.ok(result.diagnostics.some((d) => d.code === "TC_PROJECT_CONFIG"));
});

test("compiler: SDK source and installed tool versions participate in cache invalidation", async (t) => {
  const p = await project(t);
  const engine = path.join(p.root, "engine copy");
  const sdkDir = path.join(engine, "packages/sdk/src");
  await fs.mkdir(sdkDir, { recursive: true });
  await fs.copyFile(
    path.join(engineRoot, "packages/sdk/src/index.ts"),
    path.join(sdkDir, "index.ts"),
  );
  const compile = () =>
    compileProject({ projectRoot: p.root, outDir: "dist", engineRoot: engine });
  const first = await compile();
  success(first);
  const hit = await compile();
  success(hit);
  assert.equal(hit.report.incremental.cacheHit, true);
  await fs.appendFile(
    path.join(sdkDir, "index.ts"),
    "\n// Changed public API source.",
  );
  const changed = await compile();
  success(changed);
  assert.equal(changed.report.incremental.cacheHit, false);
  assert.ok(
    changed.report.incremental.changedInputs.includes(
      "packages/sdk/src/index.ts",
    ),
  );
  const cachePath = path.join(p.out, ".threecat-cache.json");
  const cache = JSON.parse(await fs.readFile(cachePath, "utf8"));
  cache.compilerVersion = "0.0.0-test-old";
  await fs.writeFile(cachePath, JSON.stringify(cache));
  const tools = await compile();
  success(tools);
  assert.equal(tools.report.incremental.cacheHit, false);
  assert.ok(tools.report.incremental.changedInputs.includes("<tool-version>"));
});

test("compiler: moved no-Git project rebuilds from source after cache invalidation", async (t) => {
  const p = await project(t);
  const first = await p.compile();
  success(first);
  const moved = path.join(p.root, "moved game \u6e38\u620f");
  await fs.mkdir(moved);
  await fs.rename(path.join(p.root, "game.ts"), path.join(moved, "game.ts"));
  await fs.rename(p.out, path.join(moved, "dist"));
  await fs.appendFile(
    path.join(moved, "game.ts"),
    "\n// Rebuild from relocated source.",
  );
  const result = await compileProject({
    projectRoot: moved,
    outDir: "dist",
    engineRoot,
  });
  success(result);
  assert.equal(result.report.incremental.cacheHit, false);
  const world = facade(result.ir);
  const game = (await importGame(path.join(moved, "dist"))).createGame(world);
  game.update(0.5);
  assert.equal(world.getTransform("m0-spinner").rotation[1], 0.4);
  game.dispose();
  const map = JSON.parse(
    await fs.readFile(path.join(moved, "dist/game.js.map"), "utf8"),
  );
  assert.ok(map.sources.includes("game.ts"));
  assert.ok(map.sources.every((s: string) => !path.isAbsolute(s)));
});

test("compiler: corrupt caches rebuild safely and unwritable output is diagnosed", async (t) => {
  const p = await project(t);
  const first = await p.compile();
  success(first);
  await fs.writeFile(
    path.join(p.out, ".threecat-cache.json"),
    JSON.stringify({ format: 1 }),
  );
  const rebuilt = await p.compile();
  success(rebuilt);
  assert.equal(rebuilt.report.incremental.cacheHit, false);
  const blocked = path.join(p.root, "output-is-file");
  await fs.writeFile(blocked, "keep");
  const failed = await compileProject({
    projectRoot: p.root,
    outDir: blocked,
    engineRoot,
  });
  assert.equal(failed.success, false);
  assert.ok(failed.diagnostics.some((d) => d.code === "TC_OUTPUT_WRITE"));
  assert.equal(await fs.readFile(blocked, "utf8"), "keep");
});

test("compiler: production bundles restore unset/development/test/empty NODE_ENV and do not disable later Vite dev hooks", async (t) => {
  const original = process.env.NODE_ENV;
  t.after(async () => {
    if (original === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = original;
  });
  const types =
    "export {}; declare global { interface ImportMeta { readonly env: {DEV:boolean;PROD:boolean;MODE:string}; glob(pattern:string):Record<string,unknown>; } }";
  const text =
    'import type {} from "./env.d.ts";\n' +
    withRunStatements(
      template,
      'if(import.meta.env.DEV) throw new Error("TC_DEV_ONLY_BRANCH"); if(!import.meta.env.PROD || import.meta.env.MODE!=="production") throw new Error("TC_NON_PRODUCTION_BUNDLE");',
    );
  for (const initial of [undefined, "development", "test", ""]) {
    if (initial === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = initial;
    const p = await project(t, text);
    await fs.writeFile(path.join(p.root, "env.d.ts"), types);
    // Implicit .env files must not influence deterministic compiler output.
    await fs.writeFile(path.join(p.root, ".env"), "NODE_ENV=development");
    const result = await p.compile();
    success(result);
    assert.equal(process.env.NODE_ENV, initial);
    const game = (await importGame(p.out)).createGame(facade(result.ir));
    game.update(0.5);
    game.dispose();
    const js = await fs.readFile(path.join(p.out, "game.js"), "utf8");
    assert.doesNotMatch(js, /TC_DEV_ONLY_BRANCH|TC_NON_PRODUCTION_BUNDLE/);
    const cached = await p.compile();
    success(cached);
    assert.equal(cached.report.incremental.cacheHit, true);
    assert.equal(process.env.NODE_ENV, initial);
  }
  process.env.NODE_ENV = "development";
  const p = await project(t);
  const result = await p.compile();
  success(result);
  assert.equal(process.env.NODE_ENV, "development");
  await fs.writeFile(
    path.join(p.root, "probe.ts"),
    "export const flags={dev:import.meta.env.DEV,prod:import.meta.env.PROD};",
  );
  const server = await createServer({
    root: p.root,
    configFile: false,
    envFile: false,
    server: { middlewareMode: true, watch: null },
    logLevel: "silent",
  });
  try {
    const probe = await server.ssrLoadModule("/probe.ts");
    assert.equal(probe.flags.dev, true);
    assert.equal(probe.flags.prod, false);
  } finally {
    await server.close();
  }
  // Force a bundler-stage failure after valid AST/type analysis; finally must still run.
  await fs.writeFile(
    path.join(p.root, "absent-runtime.d.ts"),
    "export declare function runtimeOnly(): number;",
  );
  await fs.writeFile(
    path.join(p.root, "game.ts"),
    'import {runtimeOnly} from "./absent-runtime.js";\n' +
      withRunStatements(
        template,
        'engine.setComponent("m0-spinner", "Motion", {speed:runtimeOnly()});',
      ),
  );
  const failed = await p.compile();
  assert.equal(failed.success, false);
  assert.ok(
    failed.diagnostics.some(
      (d) =>
        d.code === "TC_COMPILER_FAILURE" && /resolve|runtime/i.test(d.message),
    ),
  );
  assert.equal(process.env.NODE_ENV, "development");
});

test("compiler: concurrent production builds serialize their NODE_ENV transactions", async (t) => {
  const original = process.env.NODE_ENV;
  t.after(async () => {
    if (original === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = original;
  });
  process.env.NODE_ENV = "test";
  const a = await project(t);
  const b = await project(t);
  const results = await Promise.all([a.compile(), b.compile()]);
  for (const result of results) success(result);
  assert.equal(process.env.NODE_ENV, "test");
});
