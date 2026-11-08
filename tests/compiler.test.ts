import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { createServer } from "vite";
import ts from "typescript";
import {
  compileProject,
  SYSTEM_PHASES,
} from "../packages/compiler/src/index.ts";
import type { CompileResult, SceneIR } from "../packages/compiler/src/types.ts";
import { SDK_VERSION } from "../packages/sdk/src/index.ts";
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
            s.moduleSpecifier.text === "pelican-engine",
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
    path.join(os.tmpdir(), "pelican compiler \u4e2d\u6587 "),
  );
  t.after(async () => {
    const verified = path.resolve(root);
    assert.equal(
      path.dirname(verified).toLowerCase(),
      path.resolve(os.tmpdir()).toLowerCase(),
    );
    assert.ok(path.basename(verified).startsWith("pelican compiler "));
    await fs.rm(verified, { recursive: true, force: true });
  });
  await fs.writeFile(path.join(root, "game.ts"), text);
  await fs.writeFile(
    path.join(root, "pelican.project.json"),
    JSON.stringify({ engineVersion: SDK_VERSION }),
  );
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
  assert.equal(result.report.compilerVersion, ts.version);
  assert.equal(result.ir.engineVersion, SDK_VERSION);
  assert.equal(result.report.engineVersion, SDK_VERSION);
  assert.equal(result.ir.format, "pelican.scene");
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
  assert.doesNotMatch(js, /from ["'](?:three|@pelican|typescript)/);
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
  const marker = "__pelicanCompilerSideEffect";
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
    'import {definePrefab as prefab,defineMaterial} from "pelican-engine";const material=defineMaterial({id:"localMat"});const base=prefab({id:"base",transform:{scale:[2,2,2]},mesh:{geometry:{kind:"box"},material}});export const shape=prefab({id:"shape",extends:base,transform:{position:[1,2,3]}});',
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
    path.join(p.root, "pelican.project.json"),
    JSON.stringify({ entry: "src \u5b50\u76ee\u5f55/entry.ts" }),
  );
  const result = await p.compile();
  success(result);
  await assert.rejects(fs.access(path.join(p.root, ".git")));
  const moved = path.join(p.root, "\u642c\u79fb\u540e\u7684\u9879\u76ee");
  await fs.mkdir(moved);
  for (const name of [
    "src \u5b50\u76ee\u5f55",
    "pelican.project.json",
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
  await fs.writeFile(path.join(p.root, "pelican.project.json"), "{bad");
  result = await p.compile();
  assert.equal(result.success, false);
  assert.ok(result.diagnostics.some((d) => d.code === "TC_PROJECT_CONFIG"));
});

test("compiler: SDK source and installed tool versions participate in cache invalidation", async (t) => {
  const p = await project(t);
  const engine = path.join(p.root, "engine copy");
  const sdkDir = path.join(engine, "packages/sdk/src");
  await fs.mkdir(sdkDir, { recursive: true });
  await fs.copyFile(path.join(engineRoot, "packages/sdk/src/capabilities.ts"), path.join(sdkDir, "capabilities.ts"));
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
  const cachePath = path.join(p.out, ".pelican-cache.json");
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
    path.join(p.out, ".pelican-cache.json"),
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

function metadataGame(...systems: string[]): string {
  return `import { defineGame, defineScene, defineComponent, defineSystem } from "pelican-engine";
const Motion = defineComponent({ id: "Motion", schema: { speed: { type: "number", default: 1 } } });
${systems.map((s, i) => `const s${i} = defineSystem(${s});`).join("\n")}
export default defineGame({ id: "metadata-game", scene: defineScene({ id: "scene", entities: [] }),
 components: [Motion], systems: [${systems.map((_, i) => "s" + i).join(",")}] });`;
}
function expectCode(result: CompileResult, code: string) {
  assert.equal(result.success, false, JSON.stringify(result.report));
  const diagnostic = result.diagnostics.find((d) => d.code === code);
  assert.ok(diagnostic, JSON.stringify(result.diagnostics, null, 2));
  return diagnostic;
}

test("compiler M1: formal package owns implementation and M0 entries reexport the same API", async () => {
  const legacy = await import("../experiments/compiler/index.ts");
  assert.equal(legacy.compileProject, compileProject);
  for (const file of [
    "index.ts",
    "types.ts",
    "extract.ts",
    "normalize.ts",
    "source-map.ts",
    "version.ts",
  ]) {
    const text = await fs.readFile(
      path.join(engineRoot, "packages/compiler/src", file),
      "utf8",
    );
    assert.doesNotMatch(text, /(?:from|import\()\s*["'][^"']*experiments\//);
  }
});

test("compiler M1: six phases and all metadata survive IR and host scheduler dispatch", async (t) => {
  const text = metadataGame(
    ...SYSTEM_PHASES.map(
      (phase, i) => `{
    id: "sys${i}", phase: "${phase}", ${i ? `after: ["sys${i - 1}"],` : 'before: ["sys1"],'}
    reads: ["Motion"], writes: ["Transform"], structural: false, run() {}
  }`,
    ),
  );
  const p = await project(t, text);
  const result = await p.compile();
  success(result);
  assert.deepEqual(
    result.ir.systems.map((s) => s.phase),
    [...SYSTEM_PHASES],
  );
  for (const [i, system] of result.ir.systems.entries()) {
    assert.equal(system.id, "sys" + i);
    assert.deepEqual(system.reads, ["Motion"]);
    assert.deepEqual(system.writes, ["Transform"]);
    assert.equal(system.structural, false);
    assert.equal(system.source.file, "game.ts");
    assert.ok(
      system.source.line > 1 &&
        system.source.column > 0 &&
        system.source.length > 0,
    );
  }
  const host = facade(result.ir);
  const calls: { ids: string[]; dt: number }[] = [];
  host.runGameSystems = (systems, dt) => {
    calls.push({ ids: systems.map((s) => s.id), dt });
  };
  (await importGame(p.out)).createGame(host).update(0.25);
  assert.deepEqual(calls, [
    { ids: SYSTEM_PHASES.map((_, i) => "sys" + i), dt: 0.25 },
  ]);
  const version = JSON.parse(
    await fs.readFile(path.join(p.out, "version.json"), "utf8"),
  );
  assert.equal(version.sdkVersion, SDK_VERSION);
  assert.equal(version.engineVersion, SDK_VERSION);
  assert.equal(version.systemMetadataVersion, 1);
});

test("compiler M1: absent metadata remains legacy and explicit empty access lists remain empty", async (t) => {
  const p = await project(
    t,
    metadataGame(
      '{ id: "legacy", run() {} }',
      '{ id: "restricted", reads: [], writes: [], structural: false, run() {} }',
    ),
  );
  const result = await p.compile();
  success(result);
  assert.equal(result.ir.systems[0]!.phase, "update");
  for (const key of ["reads", "writes", "structural", "before", "after"])
    assert.equal(Object.hasOwn(result.ir.systems[0]!, key), false);
  assert.deepEqual(result.ir.systems[1]!.reads, []);
  assert.deepEqual(result.ir.systems[1]!.writes, []);
});

test("compiler M1: invalid system dependencies retain exact original metadata positions", async (t) => {
  for (const field of ["before", "after"]) {
    const text = metadataGame(`{ id: "a", ${field}: ["missing"], run() {} }`);
    const p = await project(t, text);
    const diagnostic = expectCode(await p.compile(), "TC_SYSTEM_DEPENDENCY");
    const source = parseFixture(text),
      start = text.indexOf('["missing"]');
    const position = source.getLineAndCharacterOfPosition(start);
    assert.deepEqual(diagnostic.source, {
      file: "game.ts",
      line: position.line + 1,
      column: position.character + 1,
      length: '["missing"]'.length,
    });
  }
});

test("compiler M1: duplicate IDs, cycles and self dependencies fail before game bundling", async (t) => {
  const cases = [
    ["TC_DUPLICATE_ID", '{ id: "a", run() {} }', '{ id: "a", run() {} }'],
    [
      "TC_SYSTEM_CYCLE",
      '{ id: "a", before: ["b"], run() {} }',
      '{ id: "b", before: ["a"], run() {} }',
    ],
    ["TC_SYSTEM_CYCLE", '{ id: "a", after: ["a"], run() {} }'],
  ];
  for (const [code, ...systems] of cases) {
    const p = await project(t, metadataGame(...systems));
    const diagnostic = expectCode(await p.compile(), code!);
    assert.equal(diagnostic.source?.file, "game.ts");
    await assert.rejects(fs.access(path.join(p.out, "game.js")));
  }
});

test("compiler M1: dependencies cannot reverse phases, valid forward phase edges are accepted", async (t) => {
  for (const [a, b] of [
    [
      '{ id: "a", phase: "input", after: ["b"], run() {} }',
      '{ id: "b", phase: "presentation", run() {} }',
    ],
    [
      '{ id: "a", phase: "presentation", before: ["b"], run() {} }',
      '{ id: "b", phase: "input", run() {} }',
    ],
  ]) {
    const p = await project(t, metadataGame(a!, b!));
    expectCode(await p.compile(), "TC_SYSTEM_PHASE_ORDER");
  }
  const p = await project(
    t,
    metadataGame(
      '{ id: "a", phase: "input", before: ["b"], run() {} }',
      '{ id: "b", phase: "presentation", after: ["a"], run() {} }',
    ),
  );
  success(await p.compile());
});

test("compiler M1: malformed phase, metadata, component access and unknown schema keys are rejected", async (t) => {
  for (const [field, code] of [
    ['phase: "invalid" as never', "TC_SYSTEM_PHASE"],
    ['reads: ["missing"]', "TC_SYSTEM_ACCESS"],
    ['writes: ["Motion", "Motion"]', "TC_SYSTEM_METADATA"],
    ["before: [1] as never", "TC_SYSTEM_METADATA"],
    ['after: "a" as never', "TC_SCHEMA_TYPE"],
    ['structural: "true" as never', "TC_SYSTEM_METADATA"],
    ["unexpectedCallback: () => 1", "TC_SYSTEM_METADATA"],
  ]) {
    const p = await project(
      t,
      metadataGame(
        `({ id: "a", ${field}, run() {} } as Parameters<typeof defineSystem>[0])`,
      ),
    );
    const diagnostic = expectCode(await p.compile(), code!);
    assert.equal(diagnostic.source?.file, "game.ts");
  }
});

test("compiler M1: async functions, Promise returns, generators and fake runtime markers cannot pass", async (t) => {
  for (const [run, code] of [
    ["async run() {}", "TC_SYSTEM_ASYNC"],
    ["run() { return Promise.resolve(1); }", "TC_SYSTEM_ASYNC"],
    ["*run() { yield 1; }", "TC_SYSTEM_GENERATOR"],
    ["run: ({ __runtime: true } as unknown as () => void)", "TC_SYSTEM_RUN"],
  ]) {
    const p = await project(
      t,
      metadataGame(`{ id: "a", phase: "physics", ${run} }`),
    );
    expectCode(await p.compile(), code!);
  }
});

test("compiler M1: private type imports, import types, type exports and dynamic imports obey public boundary", async (t) => {
  const sources = [
    'import type { Scene } from "three";',
    'type Internal = import("three").Scene;',
    'export type { Scene } from "three";',
    'const hidden = () => import("three");',
  ];
  for (const source of sources) {
    const p = await project(
      t,
      source + "\n" + metadataGame('{ id: "a", run() {} }'),
    );
    const diagnostic = expectCode(await p.compile(), "TC_PUBLIC_API");
    assert.equal(diagnostic.source?.file, "game.ts");
    assert.equal(diagnostic.source?.line, 1);
  }
});

test("compiler M1: exact project locks reject M0, ranges and conflicting engine declarations", async (t) => {
  const p = await project(t);
  for (const manifest of [
    { engineVersion: "0.0.1-m0.0" },
    { engine: { version: "0.0.1-m0.0" } },
    { engineVersion: "^" + SDK_VERSION },
    { engineVersion: SDK_VERSION, engine: { version: "0.0.1-m0.0" } },
  ]) {
    await fs.writeFile(
      path.join(p.root, "pelican.project.json"),
      JSON.stringify(manifest),
    );
    const diagnostic = expectCode(
      await p.compile(),
      "TC_ENGINE_VERSION_MISMATCH",
    );
    assert.match(diagnostic.suggestion, /Migrate/);
    assert.ok(diagnostic.suggestion.includes(SDK_VERSION));
  }
  await fs.writeFile(
    path.join(p.root, "pelican.project.json"),
    JSON.stringify({
      engineVersion: SDK_VERSION,
      engine: { version: SDK_VERSION },
    }),
  );
  success(await p.compile());
});

test("compiler M1: malformed lock schemas fail clearly; no-manifest M0 source API remains usable", async (t) => {
  const p = await project(t);
  for (const manifest of [
    [],
    { engineVersion: 1 },
    { engine: [] },
    { engine: { path: 7 } },
    { engine: null },
  ]) {
    await fs.writeFile(
      path.join(p.root, "pelican.project.json"),
      JSON.stringify(manifest),
    );
    expectCode(await p.compile(), "TC_PROJECT_CONFIG");
  }
  await fs.unlink(path.join(p.root, "pelican.project.json"));
  const result = await p.compile();
  success(result);
  assert.ok(
    result.diagnostics.some(
      (d) =>
        d.code === "TC_ENGINE_VERSION_UNLOCKED" && d.severity === "warning",
    ),
  );
});

test("compiler M1: relative and absolute engine paths resolve without Git and wrong roots fail", async (t) => {
  const p = await project(t);
  for (const enginePath of [path.relative(p.root, engineRoot), engineRoot]) {
    await fs.writeFile(
      path.join(p.root, "pelican.project.json"),
      JSON.stringify({ engine: { version: SDK_VERSION, path: enginePath } }),
    );
    success(await p.compile());
  }
  await fs.writeFile(
    path.join(p.root, "pelican.project.json"),
    JSON.stringify({ engine: { version: SDK_VERSION, path: "." } }),
  );
  expectCode(await p.compile(), "TC_ENGINE_PATH_MISMATCH");
});

test("compiler M1: selected engine SDK version is inspected without executing that SDK", async (t) => {
  const p = await project(t);
  const engine = path.join(p.root, "selected engine");
  await fs.mkdir(path.join(engine, "packages/sdk/src"), { recursive: true });
  await fs.copyFile(path.join(engineRoot, "packages/sdk/src/capabilities.ts"), path.join(engine, "packages/sdk/src/capabilities.ts"));
  const marker = path.join(p.root, "sdk-executed.txt");
  await fs.writeFile(
    path.join(engine, "packages/sdk/src/index.ts"),
    `import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(marker)}, "bad"); export const SDK_VERSION = "99.0.0";`,
  );
  const result = await compileProject({
    projectRoot: p.root,
    outDir: "dist",
    engineRoot: engine,
  });
  expectCode(result, "TC_ENGINE_SDK_VERSION");
  await assert.rejects(fs.access(marker));
});

test("compiler M1: runtime/schema additions, edits and removals invalidate project cache", async (t) => {
  const p = await project(t);
  const engine = path.join(p.root, "cache engine");
  await fs.mkdir(path.join(engine, "packages/sdk/src"), { recursive: true });
    await fs.copyFile(path.join(engineRoot, "packages/sdk/src/capabilities.ts"), path.join(engine, "packages/sdk/src/capabilities.ts"));
  await fs.copyFile(
    path.join(engineRoot, "packages/sdk/src/index.ts"),
    path.join(engine, "packages/sdk/src/index.ts"),
  );
  const compile = () =>
    compileProject({ projectRoot: p.root, outDir: "dist", engineRoot: engine });
  const initial = await compile();
  success(initial);
  assert.equal(
    initial.diagnostics.filter((d) => d.code === "TC_ENGINE_INPUT_MISSING")
      .length,
    3,
  );
  const hit = await compile();
  success(hit);
  assert.equal(hit.report.incremental.cacheHit, true);
  for (const name of ["runtime", "schema"]) {
    const relative = `packages/${name}/src/contract.ts`,
      file = path.join(engine, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, "export const contract = 1;\n");
    const added = await compile();
    success(added);
    assert.equal(added.report.incremental.cacheHit, false);
    assert.ok(added.report.incremental.changedInputs.includes(relative));
    assert.ok(
      added.report.inputs.some(
        (i) => i.root === "engine" && i.path === relative,
      ),
    );
    await fs.writeFile(file, "export const contract = 2;\n");
    const edited = await compile();
    success(edited);
    assert.equal(edited.report.incremental.cacheHit, false);
    assert.ok(edited.report.incremental.changedInputs.includes(relative));
    await fs.unlink(file);
    const removed = await compile();
    success(removed);
    assert.equal(removed.report.incremental.cacheHit, false);
    assert.ok(removed.report.incremental.changedInputs.includes(relative));
    assert.ok(!removed.report.inputs.some((i) => i.path === relative));
  }
});

test("compiler M1: default engine root resolves from the formal package", async (t) => {
  const p = await project(t);
  const result = await compileProject({ projectRoot: p.root, outDir: "dist" });
  success(result);
  assert.equal(result.ir.engineVersion, SDK_VERSION);
});

test("compiler M1: metadata from imported local definitions maps errors to the definition source", async (t) => {
  const p = await project(
    t,
    `import { defineGame, defineScene } from "pelican-engine";
import { failing } from "./systems.ts";
export default defineGame({ id: "local", scene: defineScene({ id: "scene", entities: [] }), systems: [failing] });`,
  );
  const declaration = `import { defineSystem } from "pelican-engine";
const metadata = { before: ["absent"] };
export const failing = defineSystem({ id: "failing", ...metadata, run() {} });`;
  await fs.writeFile(path.join(p.root, "systems.ts"), declaration);
  const diagnostic = expectCode(await p.compile(), "TC_SYSTEM_DEPENDENCY");
  const position = parseFixture(declaration).getLineAndCharacterOfPosition(
    declaration.indexOf('["absent"]'),
  );
  assert.deepEqual(diagnostic.source, {
    file: "systems.ts",
    line: position.line + 1,
    column: position.character + 1,
    length: '["absent"]'.length,
  });
});

test("compiler M1: changing a version lock cannot reuse a previous successful cache", async (t) => {
  const p = await project(t);
  success(await p.compile());
  const cached = await p.compile();
  success(cached);
  assert.equal(cached.report.incremental.cacheHit, true);
  await fs.writeFile(
    path.join(p.root, "pelican.project.json"),
    JSON.stringify({ engineVersion: "0.0.1-m0.0" }),
  );
  const failed = await p.compile();
  expectCode(failed, "TC_ENGINE_VERSION_MISMATCH");
  assert.equal(failed.report.incremental.cacheHit, false);
  assert.equal(
    JSON.parse(await fs.readFile(path.join(p.out, "build-report.json"), "utf8"))
      .artifactState,
    "previous-success-not-current",
  );
});

const m2SceneGame = (
  primaryScene: string,
  gameProperties = `scenes: [second],
  input: { move: ["ArrowUp", "W"] },
  ui: [{ id: "health", kind: "bar", value: 0.75, width: 220, color: "#0f0" }],`,
) => `
import { defineGame, defineScene } from "pelican-engine";
const first = defineScene(${primaryScene});
const second = defineScene({ id: "second", entities: [{ id: "other" }] });
export default defineGame({
  id: "m2-game",
  scene: first,
  ${gameProperties}
});
`;

test("compiler M2: resolves multiple scenes and fills SDK defaults while preserving IR v1", async (t) => {
  const p = await project(
    t,
    m2SceneGame(`{
      id: "first",
      follow: { entity: "hero" },
      entities: [{ id: "hero", character: { radius: 0.4, height: 1.8, speed: 3 } }]
    }`),
  );
  const result = await p.compile();
  success(result);
  assert.equal(result.ir.version, 1);
  assert.equal(result.ir.scene.id, "first");
  assert.deepEqual(result.ir.scene.gravity, [0, -9.81, 0]);
  assert.deepEqual(result.ir.scene.follow, {
    entity: "hero",
    distance: 5,
    height: 2,
    lookHeight: 1,
    yaw: 0,
    smoothing: 0.1,
  });
  assert.deepEqual(result.ir.scene.entities[0]!.character, {
    radius: 0.4,
    height: 1.8,
    speed: 3,
    jumpSpeed: 5,
    gravity: 9.81,
  });
  assert.equal(result.ir.scenes?.[0]?.id, "second");
  assert.equal(result.ir.scenes?.[0]?.entities[0]?.id, "other");
  assert.deepEqual(result.ir.input, { move: ["ArrowUp", "W"] });
  assert.equal(result.ir.ui?.[0]?.anchor, "top-left");
  assert.equal(result.ir.ui?.[0]?.visible, true);
});

test("compiler M2: validates scene identity, local follow targets and parent cycles", async (t) => {
  const duplicate = await project(
    t,
    m2SceneGame(`{ id: "first", entities: [] }`, `scenes: [first],`),
  );
  expectCode(await duplicate.compile(), "TC_DUPLICATE_ID");

  const follow = await project(
    t,
    m2SceneGame(
      `{ id: "first", follow: { entity: "elsewhere" }, entities: [] }`,
    ),
  );
  expectCode(await follow.compile(), "TC_CAMERA_FOLLOW_ENTITY");

  const parentCycle = await project(
    t,
    m2SceneGame(`{ id: "first", entities: [
      { id: "a", parent: "b" }, { id: "b", parent: "a" }
    ] }`),
  );
  expectCode(await parentCycle.compile(), "TC_SCENE_CYCLE");
});

test("compiler M2: rejects malformed input/UI and unreasonable physical dimensions", async (t) => {
  const malformed = await project(
    t,
    m2SceneGame(
      `{ id: "first", entities: [{ id: "hero", character: { radius: 1, height: 1, speed: 3 } }] }`,
      `scenes: [second], input: { "": ["W"] }, ui: [{ id: "panel", kind: "text", width: 0, color: "not a color" }],`,
    ),
  );
  const result = await malformed.compile();
  assert.equal(result.success, false);
  for (const code of [
    "TC_CHARACTER_CAPSULE",
    "TC_INPUT_ACTION",
    "TC_SCHEMA_RANGE",
    "TC_UI_COLOR",
  ])
    assert.ok(
      result.diagnostics.some((diagnostic) => diagnostic.code === code),
      code,
    );
});

test("compiler M2: typed text input and world UI anchors preserve metadata and reject missing targets", async (t) => {
  const p = await project(
    t,
    m2SceneGame(
      '{id:"first",entities:[{id:"hero"}]}',
      'ui:[{id:"name",kind:"input",text:"\\u4f60\\u597d",world:{entity:"hero"}}],',
    ),
  );
  const result = await p.compile();
  success(result);
  assert.equal(result.ir.ui![0].kind, "input");
  assert.deepEqual(result.ir.ui![0].world, {
    entity: "hero",
    offset: [0, 0, 0],
    occlude: true,
  });
  const invalid = await project(
    t,
    m2SceneGame(
      '{id:"first",entities:[]}',
      'ui:[{id:"world",kind:"button",world:{entity:"missing"}}],',
    ),
  );
  expectCode(await invalid.compile(), "TC_UI_WORLD_ENTITY");
});

test("compiler M3: public render settings and emissive/alpha material fields reach IR with defaults and diagnostics", async (t) => {
  const text =
    'import{defineGame,defineScene,defineMaterial}from"pelican-engine";const glow=defineMaterial({id:"glow",color:"#80a0c0",emissive:"#ff7040",emissiveIntensity:3,opacity:0.4,alphaTest:0.2,side:"double"});export default defineGame({id:"render",scene:defineScene({id:"scene",entities:[]}),materials:[glow],render:{mode:"path",samplesPerFrame:4,maxBounces:8,denoise:true,exposure:1.5}});';
  const p = await project(t, text),
    result = await p.compile();
  success(result);
  assert.equal(result.ir.render?.mode, "path");
  assert.equal(result.ir.render?.denoiseIterations, 3);
  assert.equal(result.ir.render?.directLighting, true);
  assert.equal(result.ir.materials[0].emissiveIntensity, 3);
  assert.equal(result.ir.materials[0].opacity, 0.4);
  assert.equal(result.ir.materials[0].side, "double");
  const invalid = await project(t, text.replace("exposure:1.5", "exposure:0"));
  const failed = await invalid.compile();
  expectCode(failed, "TC_RENDER_SETTINGS");
  assert.equal(
    failed.diagnostics.find((d) => d.code === "TC_RENDER_SETTINGS")?.source
      ?.file,
    "game.ts",
  );
});

test("compiler M3: physical transmission remains distinct from opacity and invalid combinations fail with source coordinates", async (t) => {
  const text =
    'import{defineGame,defineScene,defineMaterial}from"pelican-engine";const glass=defineMaterial({id:"glass",transmission:1,ior:1.5,attenuationColor:"#80c0ff",attenuationDistance:2,roughness:0.1,metalness:0});export default defineGame({id:"glass",scene:defineScene({id:"scene",entities:[]}),materials:[glass]});';
  const p = await project(t, text),
    result = await p.compile();
  success(result);
  const material = result.ir.materials[0];
  assert.equal(material.transmission, 1);
  assert.equal(material.ior, 1.5);
  assert.equal(material.attenuationDistance, 2);
  assert.equal(material.opacity, undefined);
  assert.equal(material.attenuationColor, "#80c0ff");
  for (const ior of [1.1, 1.5, 2]) {
    const opaque = await project(t, text.replace(/transmission:1,ior:1.5,attenuationColor:[^,]+,attenuationDistance:2/, `transmission:0,ior:${ior}`));
    const compiled = await opaque.compile();
    success(compiled);
    assert.equal(compiled.ir.materials[0].ior, ior);
  }
  for (const ior of [0, -1]) {
    const invalidIor = await project(t, text.replace("ior:1.5", `ior:${ior}`));
    expectCode(await invalidIor.compile(), "TC_SCHEMA_RANGE");
  }
  for (const source of [
    text.replace("metalness:0", "metalness:1"),
    text.replace("transmission:1", "transmission:0"),
  ]) {
    const invalid = await project(t, source),
      failed = await invalid.compile();
    expectCode(failed, "TC_MATERIAL_TRANSMISSION");
    assert.equal(
      failed.diagnostics.find((d) => d.code === "TC_MATERIAL_TRANSMISSION")
        ?.source?.file,
      "game.ts",
    );
  }
});
