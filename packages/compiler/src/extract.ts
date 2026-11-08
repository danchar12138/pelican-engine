import ts from "typescript";
import path from "node:path";
import type { Diagnostic, SourceLocation } from "./types.ts";
export type Value =
  | null
  | boolean
  | string
  | number
  | Value[]
  | { [key: string]: Value };
export type ObjectValue = { [key: string]: Value };
interface Module {
  source: ts.SourceFile;
  bindings: Map<string, ts.Expression | ts.FunctionDeclaration>;
  imports: Map<string, { file?: string; name: string; runtimeOnly?: boolean }>;
  exports: Map<string, string | ts.Expression>;
}
const declarations: Record<string, string> = {
  defineComponent: "component",
  defineMaterial: "material",
  defineCompute: "compute",
  definePostProcess: "postprocess",
  defineAsset: "asset",
  definePrefab: "prefab",
  defineScene: "scene",
  defineSystem: "system",
  defineGame: "game",
};
const staticMath: Readonly<Record<string, { arity: number; evaluate: (...args: number[]) => number }>> = {
  abs: { arity: 1, evaluate: Math.abs },
  acos: { arity: 1, evaluate: Math.acos },
  asin: { arity: 1, evaluate: Math.asin },
  atan: { arity: 1, evaluate: Math.atan },
  atan2: { arity: 2, evaluate: Math.atan2 },
  ceil: { arity: 1, evaluate: Math.ceil },
  cos: { arity: 1, evaluate: Math.cos },
  floor: { arity: 1, evaluate: Math.floor },
  pow: { arity: 2, evaluate: Math.pow },
  round: { arity: 1, evaluate: Math.round },
  sin: { arity: 1, evaluate: Math.sin },
  sqrt: { arity: 1, evaluate: Math.sqrt },
  tan: { arity: 1, evaluate: Math.tan },
};
export class ExtractionFailure extends Error {}
export class Extractor {
  readonly diagnostics: Diagnostic[] = [];
  readonly definitions: ObjectValue[] = [];
  readonly origins = new WeakMap<object, ts.Node>();
  readonly propertyOrigins = new WeakMap<object, Map<string, ts.Node>>();
  private modules = new Map<string, Module>();
  private memo = new Map<string, Value>();
  private active = new Set<string>();
  private scopes: Map<string, Value>[] = [];
  private closures = new WeakMap<object, { module: Module; scopes: Map<string, Value>[] }>();
  private fuel = 200000;
  private callDepth = 0;
  constructor(
    readonly program: ts.Program,
    readonly projectRoot: string,
    readonly sdkPath: string,
    readonly libraries: ReadonlySet<string> = new Set(),
  ) {}
  private library(specifier: string): boolean {
    const parts = specifier.split("/");
    return this.libraries.has(specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]);
  }
  location(node: ts.Node): SourceLocation {
    const source = node.getSourceFile();
    const start = node.getStart(source);
    const pos = source.getLineAndCharacterOfPosition(start);
    return {
      file: path
        .relative(this.projectRoot, source.fileName)
        .replaceAll("\\", "/"),
      line: pos.line + 1,
      column: pos.character + 1,
      length: Math.max(1, node.end - start),
    };
  }
  source(value: object, key?: string): SourceLocation | undefined {
    const node =
      (key !== undefined
        ? this.propertyOrigins.get(value)?.get(key)
        : undefined) ?? this.origins.get(value);
    return node ? this.location(node) : undefined;
  }
  fail(
    code: string,
    message: string,
    node: ts.Node,
    suggestion = "Use literal data and supported pelican-engine declaration calls.",
  ): never {
    this.diagnostics.push({
      code,
      severity: "error",
      message,
      suggestion,
      source: this.location(node),
    });
    throw new ExtractionFailure(message);
  }
  private key(file: string) {
    return path.resolve(file).toLowerCase();
  }
  private module(file: string): Module {
    const key = this.key(file);
    const cached = this.modules.get(key);
    if (cached) return cached;
    const source = this.program.getSourceFile(file);
    if (!source) throw new Error("Compiler could not load source: " + file);
    const mod: Module = {
      source,
      bindings: new Map(),
      imports: new Map(),
      exports: new Map(),
    };
    this.modules.set(key, mod);
    const inspectImports = (node: ts.Node) => {
      const argument =
        ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)
          ? node.argument.literal
          : ts.isCallExpression(node) &&
              node.expression.kind === ts.SyntaxKind.ImportKeyword
            ? node.arguments[0]
            : ts.isExportDeclaration(node)
              ? node.moduleSpecifier
              : undefined;
      if (argument) {
        if (!ts.isStringLiteral(argument))
          this.fail(
            "TC_PUBLIC_API",
            "Module references must be static strings.",
            argument,
          );
        const specifier = argument.text;
        if (specifier !== "pelican-engine" && !this.library(specifier)) {
          if (!specifier.startsWith("."))
            this.fail(
              "TC_PUBLIC_API",
              "Only the public SDK and project-local modules may be referenced.",
              argument,
            );
          const resolved = ts.resolveModuleName(
            specifier,
            file,
            this.program.getCompilerOptions(),
            ts.sys,
          ).resolvedModule?.resolvedFileName;
          if (resolved) {
            const relative = path.relative(this.projectRoot, resolved);
            if (
              relative.startsWith("..") ||
              path.isAbsolute(relative) ||
              relative.split(path.sep).includes("node_modules")
            )
              this.fail(
                "TC_PUBLIC_API",
                "Module reference leaves the game project.",
                argument,
              );
          }
        }
      }
      ts.forEachChild(node, inspectImports);
    };
    inspectImports(source);
    const addExport = (name: string, node: ts.Node) => {
      if (
        ts.canHaveModifiers(node) &&
        ts
          .getModifiers(node)
          ?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
      )
        mod.exports.set(name, name);
    };
    for (const statement of source.statements) {
      if (ts.isImportDeclaration(statement)) {
        const specifier = (statement.moduleSpecifier as ts.StringLiteral).text;
        if (!statement.importClause)
          this.fail(
            "TC_STATIC_SIDE_EFFECT",
            "Side-effect imports are not allowed in declaration modules.",
            statement,
            "Use named imports of declarations or gameplay functions.",
          );
        const clause = statement.importClause!;
        if (this.library(specifier)) {
          if (!clause.isTypeOnly) {
            if (clause.name) mod.imports.set(clause.name.text, { name: "default", runtimeOnly: true });
            if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
              for (const item of clause.namedBindings.elements) if (!item.isTypeOnly) mod.imports.set(item.name.text, { name: item.propertyName?.text ?? item.name.text, runtimeOnly: true });
            } else if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) this.fail("TC_PUBLIC_API", "Runtime library imports must be named or default imports.", clause.namedBindings);
          }
          continue;
        }
        let resolved: string | undefined;
        if (specifier !== "pelican-engine") {
          if (!specifier.startsWith("."))
            this.fail(
              "TC_PUBLIC_API",
              "Game code may import pelican-engine and project-local modules only: " +
                specifier,
              statement,
              "Access engine capabilities through pelican-engine.",
            );
          resolved = ts.resolveModuleName(
            specifier,
            file,
            this.program.getCompilerOptions(),
            ts.sys,
          ).resolvedModule?.resolvedFileName;
          if (!resolved)
            this.fail(
              "TC_MODULE_MISSING",
              "Cannot resolve local module: " + specifier,
              statement,
              "Check the relative import path and file name.",
            );
          const relative = path.relative(this.projectRoot, resolved!);
          if (
            relative.startsWith("..") ||
            path.isAbsolute(relative) ||
            relative.split(path.sep).includes("node_modules")
          )
            this.fail(
              "TC_PUBLIC_API",
              "Local imports must remain inside the game project.",
              statement,
              "Reference engine functionality through pelican-engine.",
            );
        }
        // Type-only imports obey the same public API boundary as value imports.
        if (clause.isTypeOnly) continue;
        if (clause.name)
          mod.imports.set(clause.name.text, {
            file: resolved,
            name: "default",
          });
        if (clause.namedBindings) {
          if (!ts.isNamedImports(clause.namedBindings))
            this.fail(
              "TC_STATIC_SYNTAX",
              "Namespace imports are not supported by the M0 declaration extractor.",
              clause.namedBindings,
              "Use named imports.",
            );
          for (const item of clause.namedBindings.elements)
            if (!item.isTypeOnly)
              mod.imports.set(item.name.text, {
                file: resolved,
                name: item.propertyName?.text ?? item.name.text,
              });
        }
      } else if (ts.isVariableStatement(statement)) {
        if (!(statement.declarationList.flags & ts.NodeFlags.Const))
          this.fail(
            "TC_STATIC_SIDE_EFFECT",
            "Top-level declaration bindings must be const.",
            statement,
            "Keep mutable state in components or inside system functions.",
          );
        for (const decl of statement.declarationList.declarations) {
          if (!ts.isIdentifier(decl.name) || !decl.initializer)
            this.fail(
              "TC_STATIC_SYNTAX",
              "Use initialized const identifiers for definitions.",
              decl,
            );
          mod.bindings.set(decl.name.text, decl.initializer);
          addExport(decl.name.text, statement);
        }
      } else if (ts.isFunctionDeclaration(statement)) {
        if (statement.name) {
          mod.bindings.set(statement.name.text, statement);
          addExport(statement.name.text, statement);
        }
        if (
          statement.modifiers?.some(
            (m) => m.kind === ts.SyntaxKind.DefaultKeyword,
          )
        )
          mod.exports.set(
            "default",
            statement.name?.text ?? (statement as unknown as ts.Expression),
          );
      } else if (ts.isExportAssignment(statement)) {
        if (statement.isExportEquals)
          this.fail(
            "TC_STATIC_SYNTAX",
            "CommonJS export assignments are not supported.",
            statement,
          );
        mod.exports.set("default", statement.expression);
      } else if (ts.isExportDeclaration(statement)) {
        if (statement.isTypeOnly) continue;
        if (statement.moduleSpecifier)
          this.fail(
            "TC_STATIC_SYNTAX",
            "M0 does not statically extract re-exported declarations.",
            statement,
            "Import a local definition and export the imported identifier.",
          );
        if (statement.exportClause && ts.isNamedExports(statement.exportClause))
          for (const e of statement.exportClause.elements)
            mod.exports.set(e.name.text, e.propertyName?.text ?? e.name.text);
      } else if (
        ts.isInterfaceDeclaration(statement) ||
        ts.isTypeAliasDeclaration(statement) ||
        ts.isEmptyStatement(statement)
      ) {
        // Type declarations are erased; no executable source is evaluated.
      } else
        this.fail(
          "TC_STATIC_SIDE_EFFECT",
          "Unsupported executable top-level statement; no source module is executed during compilation.",
          statement,
          "Move gameplay behavior into a system run function.",
        );
    }
    return mod;
  }
  private binding(mod: Module, name: string): Value {
    const key = this.key(mod.source.fileName) + ":" + name;
    if (this.memo.has(key)) return this.memo.get(key)!;
    if (this.active.has(key))
      this.fail(
        "TC_DECLARATION_CYCLE",
        "Cyclic static declaration: " + name,
        mod.bindings.get(name) ?? mod.source,
        "Remove the circular const or prefab reference.",
      );
    this.active.add(key);
    try {
      const imported = mod.imports.get(name);
      let value: Value;
      if (imported) {
        if (!imported.file)
          this.fail(
            "TC_STATIC_REFERENCE",
            "SDK functions are only permitted as supported declaration calls.",
            mod.source,
          );
        const target = this.module(imported.file);
        const exported = target.exports.get(imported.name);
        if (exported === undefined)
          this.fail(
            "TC_STATIC_REFERENCE",
            "Local module does not export: " + imported.name,
            mod.source,
          );
        value =
          typeof exported === "string"
            ? this.binding(target, exported)
            : this.evaluate(exported, target);
      } else {
        const expression = mod.bindings.get(name);
        if (!expression)
          this.fail(
            "TC_STATIC_REFERENCE",
            "Unknown static identifier: " + name,
            mod.source,
          );
        const callerScopes = this.scopes;
        this.scopes = [];
        try { value = this.evaluate(expression as ts.Expression, mod); }
        finally { this.scopes = callerScopes; }
      }
      this.memo.set(key, value);
      return value;
    } finally {
      this.active.delete(key);
    }
  }
  private evaluate(node: ts.Expression, mod: Module): Value {
    if (--this.fuel < 0) this.fail("TC_STATIC_BUDGET", "Static content exceeds 200000 evaluation steps.", node, "Split content into smaller declared chunks.");
    if (
      ts.isParenthesizedExpression(node) ||
      ts.isAsExpression(node) ||
      ts.isSatisfiesExpression(node) ||
      ts.isTypeAssertionExpression(node)
    )
      return this.evaluate(node.expression, mod);
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
      return node.text;
    if (ts.isNumericLiteral(node)) return Number(node.text);
    if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
    if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
    if (node.kind === ts.SyntaxKind.NullKeyword) return null;
    if (ts.isPropertyAccessExpression(node) && !node.questionDotToken &&
        ts.isIdentifier(node.expression) && node.expression.text === "Math" &&
        !mod.bindings.has("Math") && !mod.imports.has("Math")) {
      const constants: Readonly<Record<string, number>> = {
        E: Math.E, LN2: Math.LN2, LN10: Math.LN10, LOG2E: Math.LOG2E,
        LOG10E: Math.LOG10E, PI: Math.PI, SQRT1_2: Math.SQRT1_2, SQRT2: Math.SQRT2,
      };
      if (Object.hasOwn(constants, node.name.text)) return constants[node.name.text];
    }
    if (ts.isIdentifier(node)) {
      for (const scope of [...this.scopes].reverse()) if (scope.has(node.text)) return scope.get(node.text)!;
      return this.binding(mod, node.text);
    }
    if (ts.isTemplateExpression(node)) {
      let result = node.head.text;
      for (const span of node.templateSpans) {
        const value = this.evaluate(span.expression, mod);
        if (value !== null && typeof value === "object") this.fail("TC_STATIC_TYPE", "Template substitutions must be scalar values.", span.expression);
        result += String(value) + span.literal.text;
      }
      if (result.length > 65536) this.fail("TC_STATIC_BUDGET", "Generated string exceeds 65536 characters.", node);
      return result;
    }
    if (ts.isConditionalExpression(node)) return this.evaluate(this.evaluate(node.condition, mod) ? node.whenTrue : node.whenFalse, mod);
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const value = this.evaluate(node.expression, mod);
      const key = ts.isPropertyAccessExpression(node) ? node.name.text : this.evaluate(node.argumentExpression!, mod);
      if (Array.isArray(value) && key === "length") return value.length;
      if (value && typeof value === "object" && (typeof key === "string" || typeof key === "number") &&
          !["constructor", "prototype", "__proto__"].includes(String(key)) && Object.hasOwn(value, key)) return (value as ObjectValue)[key];
      this.fail("TC_STATIC_REFERENCE", "Static property is missing or not permitted.", node);
    }
    if (
      ts.isArrowFunction(node) ||
      ts.isFunctionExpression(node) ||
      ts.isFunctionDeclaration(node) ||
      ts.isMethodDeclaration(node)
    ) {
      const result = { __runtime: true };
      this.origins.set(result, node);
      this.closures.set(result, { module: mod, scopes: this.scopes.map(scope => new Map(scope)) });
      return result;
    }
    if (ts.isArrayLiteralExpression(node)) {
      const result: Value[] = [];
      const origins = new Map<string, ts.Node>();
      for (const element of node.elements) {
        if (ts.isSpreadElement(element)) {
          const value = this.evaluate(element.expression, mod);
          if (!Array.isArray(value))
            this.fail(
              "TC_STATIC_TYPE",
              "Array spread requires a static array.",
              element,
            );
          for (const item of value) {
            origins.set(String(result.length), element);
            result.push(item);
          }
        } else {
          origins.set(String(result.length), element);
          result.push(this.evaluate(element, mod));
        }
      }
      this.origins.set(result, node);
      this.propertyOrigins.set(result, origins);
      return result;
    }
    if (ts.isObjectLiteralExpression(node)) {
      const result: ObjectValue = Object.create(null);
      const origins = new Map<string, ts.Node>();
      for (const prop of node.properties) {
        if (ts.isSpreadAssignment(prop)) {
          const value = this.evaluate(prop.expression, mod);
          if (!value || Array.isArray(value) || typeof value !== "object")
            this.fail(
              "TC_STATIC_TYPE",
              "Object spread requires static object data.",
              prop,
            );
          Object.assign(result, value);
          for (const k of Object.keys(value))
            origins.set(k, this.propertyOrigins.get(value)?.get(k) ?? prop);
          continue;
        }
        if (!prop.name || ts.isComputedPropertyName(prop.name))
          this.fail(
            "TC_STATIC_SYNTAX",
            "Computed property names and accessors are not supported.",
            prop,
          );
        const name = prop.name.getText().replace(/^['"]|['"]$/g, "");
        if (
          name === "__proto__" ||
          name === "constructor" ||
          name === "prototype"
        )
          this.fail(
            "TC_STATIC_SYNTAX",
            "Reserved declaration property: " + name,
            prop,
          );
        if (ts.isPropertyAssignment(prop)) {
          result[name] = this.evaluate(prop.initializer, mod);
          origins.set(name, prop.initializer);
        } else if (ts.isShorthandPropertyAssignment(prop)) {
          result[name] = this.evaluate(prop.name, mod);
          origins.set(name, prop);
        } else if (ts.isMethodDeclaration(prop) && name === "run") {
          result[name] = this.evaluate(prop as unknown as ts.Expression, mod);
          origins.set(name, prop);
        } else
          this.fail(
            "TC_STATIC_SYNTAX",
            "Only data properties and system run functions are supported.",
            prop,
          );
      }
      this.origins.set(result, node);
      this.propertyOrigins.set(result, origins);
      return result;
    }
    if (ts.isCallExpression(node)) {
      const target = node.expression;
      if (ts.isPropertyAccessExpression(target) && ts.isIdentifier(target.expression) && target.expression.text === "Array" &&
          target.name.text === "from" && !mod.bindings.has("Array") && !mod.imports.has("Array")) {
        if (node.arguments.length < 1 || node.arguments.length > 2) this.fail("TC_STATIC_TYPE", "Array.from requires a bounded source and optional mapper.", node);
        const input = this.evaluate(node.arguments[0], mod);
        const length = Array.isArray(input) ? input.length : input && typeof input === "object" ? (input as ObjectValue).length : undefined;
        if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0 || length > 16384) this.fail("TC_STATIC_BUDGET", "Array.from length must be in [0,16384].", node);
        if (!node.arguments[1]) {
          if (!Array.isArray(input)) this.fail("TC_STATIC_TYPE", "Array.from of a length descriptor requires a mapper.", node);
          return [...input];
        }
        const mapper = this.evaluate(node.arguments[1], mod);
        return Array.from({ length }, (_, i) => this.callStatic(mapper, [Array.isArray(input) ? input[i] : null, i], node));
      }
      if (ts.isPropertyAccessExpression(target) && ["map", "flatMap", "filter", "concat"].includes(target.name.text)) {
        const source = this.evaluate(target.expression, mod);
        if (!Array.isArray(source) || source.length > 16384) this.fail("TC_STATIC_TYPE", "Static collection methods require arrays of at most 16384 entries.", node);
        if (target.name.text === "concat") {
          const result = source.concat(...node.arguments.map(arg => this.evaluate(arg, mod)));
          if (result.length > 16384) this.fail("TC_STATIC_BUDGET", "Generated collection exceeds 16384 entries.", node);
          return result;
        }
        if (node.arguments.length !== 1) this.fail("TC_STATIC_TYPE", "Static array methods require one pure callback.", node);
        const fn = this.evaluate(node.arguments[0], mod);
        const mapped = source.map((item, index) => this.callStatic(fn, [item, index, source], node));
        const result = target.name.text === "filter" ? source.filter((_, i) => !!mapped[i]) : target.name.text === "flatMap" ? mapped.flat() : mapped;
        if (result.length > 16384) this.fail("TC_STATIC_BUDGET", "Generated collection exceeds 16384 entries.", node);
        this.origins.set(result, node); return result;
      }
      const expression = node.expression;
      if (!node.questionDotToken && ts.isPropertyAccessExpression(expression) &&
          !expression.questionDotToken && ts.isIdentifier(expression.expression) &&
          expression.expression.text === "Math" && !mod.bindings.has("Math") && !mod.imports.has("Math") &&
          Object.hasOwn(staticMath, expression.name.text)) {
        const operation = staticMath[expression.name.text];
        if (node.typeArguments?.length || node.arguments.length !== operation.arity || node.arguments.some(ts.isSpreadElement))
          this.fail("TC_STATIC_TYPE", `Math.${expression.name.text} requires ${operation.arity} static numeric argument(s).`, node);
        const values = node.arguments.map(argument => this.evaluate(argument, mod));
        if (values.some(value => typeof value !== "number" || !Number.isFinite(value)))
          this.fail("TC_STATIC_TYPE", `Math.${expression.name.text} requires finite numeric arguments.`, node);
        const result = operation.evaluate(...values as number[]);
        if (!Number.isFinite(result))
          this.fail("TC_STATIC_TYPE", `Math.${expression.name.text} must produce a finite number.`, node);
        return result;
      }
      const name = ts.isIdentifier(node.expression)
        ? mod.imports.get(node.expression.text)
        : undefined;
      const kind = name && !name.file && !name.runtimeOnly ? declarations[name.name] : undefined;
      if (!kind && ts.isIdentifier(target) && (mod.bindings.has(target.text) || mod.imports.get(target.text)?.file || this.scopes.some(scope => scope.has(target.text))))
        return this.callStatic(this.evaluate(target, mod), node.arguments.map(arg => this.evaluate(arg, mod)), node);
      if (!kind || node.arguments.length !== 1)
        this.fail(
          "TC_STATIC_SIDE_EFFECT",
          "Arbitrary function calls are not evaluated in definitions.",
          node,
          "Use a supported define* call from pelican-engine; put executable behavior inside systems.",
        );
      const input = this.evaluate(node.arguments[0]!, mod);
      if (!input || Array.isArray(input) || typeof input !== "object")
        this.fail("TC_STATIC_TYPE", "A declaration requires an object.", node);
      if (kind === "system" && input.run && typeof input.run === "object") {
        const run = this.origins.get(input.run);
        if (
          !run ||
          !(
            ts.isArrowFunction(run) ||
            ts.isFunctionExpression(run) ||
            ts.isFunctionDeclaration(run) ||
            ts.isMethodDeclaration(run)
          )
        )
          this.fail(
            "TC_SYSTEM_RUN",
            "System run must be an actual function declaration.",
            run ?? node,
          );
        if (
          run &&
          ts.canHaveModifiers(run) &&
          ts
            .getModifiers(run)
            ?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)
        )
          this.fail(
            "TC_SYSTEM_ASYNC",
            "Game systems must be synchronous in every phase.",
            run,
            "Move asynchronous preparation outside the update loop; apply ready data synchronously.",
          );
        if (run && "asteriskToken" in run && run.asteriskToken)
          this.fail(
            "TC_SYSTEM_GENERATOR",
            "M0 update systems cannot be generator functions.",
            run,
          );
        const checker = this.program.getTypeChecker();
        const signature = checker.getSignatureFromDeclaration(run);
        if (signature) {
          const result = checker.getReturnTypeOfSignature(signature);
          const results = result.isUnion() ? result.types : [result];
          if (results.some((type) => type.getProperty("then")))
            this.fail(
              "TC_SYSTEM_ASYNC",
              "System run cannot return a Promise/thenable.",
              run,
              "Prepare asynchronous data outside systems and apply it synchronously at a safe boundary.",
            );
        }
      }
      const result: ObjectValue = { ...input, kind };
      this.origins.set(result, node);
      this.propertyOrigins.set(
        result,
        this.propertyOrigins.get(input) ?? new Map(),
      );
      this.definitions.push(result);
      return result;
    }
    if (ts.isPrefixUnaryExpression(node)) {
      const value = this.evaluate(node.operand, mod);
      if (node.operator === ts.SyntaxKind.ExclamationToken) return !value;
      if (
        typeof value === "number" &&
        [ts.SyntaxKind.PlusToken, ts.SyntaxKind.MinusToken].includes(
          node.operator,
        )
      )
        return node.operator === ts.SyntaxKind.MinusToken ? -value : value;
    }
    if (ts.isBinaryExpression(node)) {
      const a = this.evaluate(node.left, mod);
      if (node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) return a ? this.evaluate(node.right, mod) : a;
      if (node.operatorToken.kind === ts.SyntaxKind.BarBarToken) return a ? a : this.evaluate(node.right, mod);
      const b = this.evaluate(node.right, mod);
      if (node.operatorToken.kind === ts.SyntaxKind.PlusToken && (typeof a === "string" || typeof b === "string") && (a === null || typeof a !== "object") && (b === null || typeof b !== "object")) {
        const result = String(a) + String(b);
        if (result.length > 65536) this.fail("TC_STATIC_BUDGET", "Generated string exceeds 65536 characters.", node);
        return result;
      }
      if (node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken) return a === b;
      if (node.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken) return a !== b;
      let value: number | undefined;
      if (typeof a === "number" && typeof b === "number") {
        switch (node.operatorToken.kind) {
          case ts.SyntaxKind.PlusToken:
            value = a + b;
            break;
          case ts.SyntaxKind.MinusToken:
            value = a - b;
            break;
          case ts.SyntaxKind.AsteriskToken:
            value = a * b;
            break;
          case ts.SyntaxKind.SlashToken:
            value = a / b;
            break;
          case ts.SyntaxKind.PercentToken: value = a % b; break;
          case ts.SyntaxKind.AsteriskAsteriskToken: value = a ** b; break;
          case ts.SyntaxKind.LessThanToken: return a < b;
          case ts.SyntaxKind.LessThanEqualsToken: return a <= b;
          case ts.SyntaxKind.GreaterThanToken: return a > b;
          case ts.SyntaxKind.GreaterThanEqualsToken: return a >= b;
        }
      }
      if (value !== undefined && Number.isFinite(value)) return value;
      this.fail(
        "TC_STATIC_TYPE",
        "Static arithmetic must produce a finite number.",
        node,
      );
    }
    this.fail(
      "TC_STATIC_SYNTAX",
      "Unsupported static expression: " + ts.SyntaxKind[node.kind],
      node,
    );
  }
  private callStatic(value: Value, args: Value[], at: ts.Node): Value {
    const fn = value && typeof value === "object" ? this.origins.get(value) : undefined;
    const closure = value && typeof value === "object" ? this.closures.get(value) : undefined;
    if (!fn || !closure || !(ts.isFunctionDeclaration(fn) || ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) || !fn.body || fn.asteriskToken ||
        ts.getModifiers(fn)?.some(m => m.kind === ts.SyntaxKind.AsyncKeyword)) this.fail("TC_STATIC_SIDE_EFFECT", "Only bounded pure local content functions may be evaluated.", at);
    if (++this.callDepth > 32) this.fail("TC_STATIC_BUDGET", "Static function nesting exceeds 32 calls.", at);
    const previous = this.scopes, locals = new Map<string, Value>();
    this.scopes = [...closure.scopes, locals];
    try {
      for (const [index, parameter] of fn.parameters.entries()) {
        if (!ts.isIdentifier(parameter.name) || parameter.dotDotDotToken) this.fail("TC_STATIC_SYNTAX", "Static function parameters must be named values.", parameter);
        const argument = index < args.length ? args[index] : parameter.initializer ? this.evaluate(parameter.initializer, closure.module) : null;
        locals.set(parameter.name.text, argument);
      }
      if (!ts.isBlock(fn.body)) return this.evaluate(fn.body, closure.module);
      for (const statement of fn.body.statements) {
        if (ts.isReturnStatement(statement) && statement.expression) return this.evaluate(statement.expression, closure.module);
        if (ts.isVariableStatement(statement) && (statement.declarationList.flags & ts.NodeFlags.Const)) {
          for (const declaration of statement.declarationList.declarations) {
            if (!ts.isIdentifier(declaration.name) || !declaration.initializer) this.fail("TC_STATIC_SYNTAX", "Content functions require initialized const bindings.", declaration);
            locals.set(declaration.name.text, this.evaluate(declaration.initializer, closure.module));
          }
        } else this.fail("TC_STATIC_SIDE_EFFECT", "Content functions support const bindings and a return; I/O, mutation and loops are not executed.", statement);
      }
      this.fail("TC_STATIC_TYPE", "Content function must return a value.", fn);
    } finally { this.scopes = previous; this.callDepth--; }
  }
  extract(entry: string): ObjectValue | undefined {
    try {
      const mod = this.module(entry);
      // Every project source is inspected, including imports unused by the bundler.
      for (const sf of this.program.getSourceFiles()) {
        if (
          sf.isDeclarationFile ||
          path.resolve(sf.fileName) === path.resolve(this.sdkPath)
        )
          continue;
        const rel = path.relative(this.projectRoot, sf.fileName);
        if (!rel.startsWith("..") && !path.isAbsolute(rel) && !rel.split(path.sep).includes("node_modules"))
          this.module(sf.fileName);
      }
      for (const item of this.modules.values())
        for (const name of item.bindings.keys()) this.binding(item, name);
      const exported = mod.exports.get("default");
      if (!exported)
        this.fail(
          "TC_GAME_ENTRY",
          "Entry must default-export defineGame(...).",
          mod.source,
        );
      const result =
        typeof exported === "string"
          ? this.binding(mod, exported)
          : this.evaluate(exported, mod);
      if (
        !result ||
        Array.isArray(result) ||
        typeof result !== "object" ||
        result.kind !== "game"
      )
        this.fail(
          "TC_GAME_ENTRY",
          "Default export must be a defineGame declaration.",
          mod.source,
        );
      let nodes = 0, characters = 0;
      const bounded = (value: Value, depth: number): void => {
        if (++nodes > 200000 || depth > 128) this.fail("TC_STATIC_BUDGET", "Expanded content exceeds 200000 values or 128 levels.", mod.source);
        if (typeof value === "string") characters += value.length;
        if (characters > 8 * 1024 * 1024) this.fail("TC_STATIC_BUDGET", "Expanded content strings exceed 8 MiB.", mod.source);
        if (value && typeof value === "object") for (const child of Object.values(value)) bounded(child, depth + 1);
      };
      bounded(result, 0);
      return result;
    } catch (error) {
      if (!(error instanceof ExtractionFailure)) throw error;
      return undefined;
    }
  }
}
