import ts from "typescript";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SDK_VERSION } from "../packages/sdk/src/index.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export function queryApiSymbol<T extends { name: string }>(symbols: T[], args: string[]) {
  const positions = args.flatMap((arg, i) => arg === "--symbol" ? [i] : []);
  if (positions.length === 0) return undefined;
  if (positions.length !== 1)
    throw new Error("TC_API_SYMBOL_DUPLICATE: Supply --symbol exactly once.");
  const name = args[positions[0] + 1];
  if (!name || name.startsWith("--"))
    throw new Error("TC_API_SYMBOL_REQUIRED: Supply a public symbol name after --symbol.");
  const matches = symbols.filter((symbol) => symbol.name === name);
  if (matches.length === 0)
    throw new Error("TC_API_SYMBOL_UNKNOWN: Symbol not found; use pelican api to inspect the public index and check exact spelling and case.");
  return matches;
}
/** Public SDK source is the sole signature source; this file does not maintain duplicate API declarations. */
export async function generateApiIndex(engineRoot = root) {
  const filename = path.join(engineRoot, "packages/sdk/src/index.ts");
  const source = await readFile(filename, "utf8");
  const sf = ts.createSourceFile(
    filename,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const symbols: {
    name: string;
    kind: string;
    signature: string;
    line: number;
    fields?: string[];
  }[] = [];
  for (const statement of sf.statements) {
    if (
      !ts.canHaveModifiers(statement) ||
      !ts
        .getModifiers(statement)
        ?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
    )
      continue;
    const location = sf.getLineAndCharacterOfPosition(statement.getStart());
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations)
        symbols.push({
          name: declaration.name.getText(sf),
          kind: "constant",
          signature: declaration.getText(sf),
          line: location.line + 1,
        });
    } else if (
      ts.isInterfaceDeclaration(statement) ||
      ts.isTypeAliasDeclaration(statement) ||
      ts.isFunctionDeclaration(statement)
    ) {
      const name = statement.name?.text;
      if (!name) continue;
      const signature =
        ts.isFunctionDeclaration(statement) && statement.body
          ? statement
              .getText(sf)
              .slice(0, statement.body.getStart() - statement.getStart())
              .trim() + ";"
          : statement.getText(sf);
      symbols.push({
        name,
        kind: ts.SyntaxKind[statement.kind],
        signature,
        line: location.line + 1,
        ...(ts.isInterfaceDeclaration(statement)
          ? {
              fields: statement.members
                .map((m) => m.name?.getText(sf))
                .filter((v): v is string => !!v),
            }
          : {}),
      });
    }
  }
  const index = {
    format: "pelican.api-index",
    version: 1,
    engineVersion: SDK_VERSION,
    entry: "pelican-engine",
    source: "packages/sdk/src/index.ts",
    symbols,
  };
  const output = path.join(engineRoot, "docs/api");
  await mkdir(output, { recursive: true });
  await writeFile(
    path.join(output, "index.json"),
    JSON.stringify(index, null, 2) + "\n",
  );
  const reference = [
    `# pelican ${SDK_VERSION} API 索引`,
    "",
    "由公开 SDK 源码生成。签名以源码和 TypeScript 检查为准，不在文档维护第二套声明。",
    "",
    ...symbols.flatMap((symbol) => [
      `## ${symbol.name}`,
      "",
      `来源：\`${index.source}:${symbol.line}\``,
      "",
      "```ts",
      symbol.signature,
      "```",
      "",
    ]),
  ].join("\n");
  await writeFile(path.join(output, "REFERENCE.md"), reference);
  return index;
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  generateApiIndex()
    .then((index) =>
      console.log(
        JSON.stringify({
          status: "succeeded",
          engineVersion: SDK_VERSION,
          symbols: index.symbols.length,
          artifacts: ["docs/api/index.json", "docs/api/REFERENCE.md"],
        }),
      ),
    )
    .catch((error) => {
      console.error(String(error));
      process.exitCode = 1;
    });
}
