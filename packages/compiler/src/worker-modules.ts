import ts from "typescript";
import { pathToFileURL, fileURLToPath } from "node:url";

/** Match Vite's standard module-worker form using the TypeScript AST, not source regexes. */
export function workerModuleEntries(program: ts.Program): string[] {
  const entries = new Set<string>();
  for (const source of program.getSourceFiles()) {
    if (
      source.isDeclarationFile ||
      program.isSourceFileFromExternalLibrary(source)
    )
      continue;
    const visit = (node: ts.Node) => {
      if (
        ts.isNewExpression(node) &&
        ts.isIdentifier(node.expression) &&
        ["Worker", "SharedWorker"].includes(node.expression.text)
      ) {
        const url = node.arguments?.[0];
        if (
          url &&
          ts.isNewExpression(url) &&
          ts.isIdentifier(url.expression) &&
          url.expression.text === "URL"
        ) {
          const [name, base] = url.arguments ?? [];
          if (
            name &&
            (ts.isStringLiteral(name) ||
              ts.isNoSubstitutionTemplateLiteral(name)) &&
            base &&
            ts.isPropertyAccessExpression(base) &&
            base.name.text === "url" &&
            ts.isMetaProperty(base.expression) &&
            base.expression.keywordToken === ts.SyntaxKind.ImportKeyword
          ) {
            const resolved = new URL(name.text, pathToFileURL(source.fileName));
            if (resolved.protocol === "file:")
              entries.add(fileURLToPath(resolved));
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return [...entries];
}
