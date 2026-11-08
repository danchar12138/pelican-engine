import ts from "typescript";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SDK_VERSION } from "../packages/sdk/src/index.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export interface ApiSymbol {
  name: string;
  kind: string;
  signature: string;
  source: string;
  line: number;
  fields?: string[];
  owner?: string;
  member?: string;
  inheritedFrom?: string;
}
export function queryApiSymbol<T extends { name: string }>(symbols: T[], args: string[], members: T[] = []) {
  const positions = args.flatMap((arg, i) => arg === "--symbol" ? [i] : []);
  if (positions.length === 0) return undefined;
  if (positions.length !== 1)
    throw new Error("TC_API_SYMBOL_DUPLICATE: Supply --symbol exactly once.");
  const name = args[positions[0] + 1];
  if (!name || name.startsWith("--"))
    throw new Error("TC_API_SYMBOL_REQUIRED: Supply a public symbol name after --symbol.");
  const matches = [...symbols, ...members].filter((symbol) => symbol.name === name);
  if (matches.length === 0)
    throw new Error("TC_API_SYMBOL_UNKNOWN: Symbol not found; use pelican api to inspect the public index and check exact spelling and case.");
  return matches;
}

/** Query both collections without changing the legacy top-level symbols array. */
export function queryApi(index: { symbols: ApiSymbol[]; members?: ApiSymbol[] }, args: string[]) {
  const value = (flag: string, code: string) => {
    const positions = args.flatMap((arg, i) => arg === flag ? [i] : []);
    if (!positions.length) return undefined;
    if (positions.length > 1) throw new Error(`${code}: Supply ${flag} exactly once.`);
    const input = args[positions[0] + 1];
    if (!input || input.startsWith("--")) throw new Error(`${code}: Supply a value after ${flag}.`);
    return input;
  };
  const exact = queryApiSymbol(index.symbols, args, index.members);
  const search = value("--search", "TC_API_SEARCH");
  const limitInput = value("--limit", "TC_API_LIMIT");
  for (let i = 0; i < args.length; i++) {
    if (["--symbol", "--search", "--limit"].includes(args[i])) { i++; continue; }
    if (args[i] !== "--member") throw new Error(`TC_API_QUERY: Unexpected argument '${args[i]}'. Use --symbol <Type.member> or --search <query> [--member] [--limit 20].`);
  }
  const memberOnly = args.includes("--member");
  if (args.filter(arg => arg === "--member").length > 1) throw new Error("TC_API_MEMBER: Supply --member exactly once.");
  if (memberOnly && (exact || search === undefined)) throw new Error("TC_API_MEMBER: Use --member with --search <query> to search member declarations.");
  if (exact && search !== undefined) throw new Error("TC_API_SEARCH: Use either --symbol or --search, not both.");
  const limit = Number(limitInput ?? "20");
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("TC_API_LIMIT: Supply --limit in [1,100].");
  if (limitInput !== undefined && search === undefined) throw new Error("TC_API_LIMIT: Use --limit with --search <query>.");
  if (exact) return { symbols: exact, total: exact.length, truncated: false };
  if (search === undefined) return { symbols: index.symbols.length, members: index.members?.length ?? 0, total: index.symbols.length + (index.members?.length ?? 0), truncated: false };
  const query = search.normalize("NFKC").toLowerCase().trim();
  if (!query) throw new Error("TC_API_SEARCH: Supply a nonempty query after --search.");
  const terms = query.split(/\s+/);
  const candidates = memberOnly ? index.members ?? [] : [...index.symbols, ...(index.members ?? [])];
  const score = (symbol: ApiSymbol) => {
    const name = symbol.name.toLowerCase(), member = symbol.member?.toLowerCase();
    if (name === query) return 0;
    if (member === query) return 1;
    if (name.startsWith(query) || member?.startsWith(query)) return 2;
    if (terms.every(term => name.includes(term))) return 3;
    return 4;
  };
  const matches = candidates.filter(symbol => {
    const text = `${symbol.name} ${symbol.signature}`.toLowerCase();
    return terms.every(term => text.includes(term));
  }).sort((a, b) => score(a) - score(b) || a.name.localeCompare(b.name, "en") || a.line - b.line);
  if (!matches.length) throw new Error(`TC_API_SEARCH_UNKNOWN: No public declaration matches '${search}'. Run pelican api or use another SDK name; an absent declaration does not prove a capability is unsupported.`);
  return { symbols: matches.slice(0, limit), total: matches.length, truncated: matches.length > limit };
}
/** Public SDK source is the sole signature source; this file does not maintain duplicate API declarations. */
export async function generateApiIndex(engineRoot = root) {
  const filename = path.join(engineRoot, "packages/sdk/src/index.ts");
  const source = (await readFile(filename, "utf8")).replace(/\r\n?/g, "\n");
  const sf = ts.createSourceFile(
    filename,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const sourcePath = "packages/sdk/src/index.ts";
  const symbols: ApiSymbol[] = [];
  const members: ApiSymbol[] = [];
  const declarations = new Map<string, ts.InterfaceDeclaration | ts.TypeAliasDeclaration>();
  for (const statement of sf.statements)
    if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) declarations.set(statement.name.text, statement);
  const elements = (node: ts.Node, seen = new Set<ts.Node>()): ts.TypeElement[] => {
    if (seen.has(node)) return [];
    const next = new Set(seen).add(node);
    if (ts.isInterfaceDeclaration(node)) {
      const own = new Set(node.members.map(member => member.name?.getText(sf)));
      return [...node.members, ...(node.heritageClauses ?? []).flatMap(clause => clause.types.flatMap(type => {
        const parent = declarations.get(type.expression.getText(sf));
        return parent ? elements(parent, next).filter(member => !own.has(member.name?.getText(sf))) : [];
      }))];
    }
    if (ts.isTypeAliasDeclaration(node)) return elements(node.type, next);
    if (ts.isTypeLiteralNode(node)) return [...node.members];
    if (ts.isIntersectionTypeNode(node)) return node.types.flatMap(type => elements(type, next));
    if (ts.isParenthesizedTypeNode(node)) return elements(node.type, next);
    if (ts.isTypeReferenceNode(node)) {
      const referenced = declarations.get(node.typeName.getText(sf));
      return referenced ? elements(referenced, next) : [];
    }
    return [];
  };
  const addMembers = (owner: string, nodes: ts.TypeElement[], seen = new Set<ts.Node>()) => {
    for (const node of nodes) {
      if (!node.name || seen.has(node)) continue;
      const member = ts.isStringLiteral(node.name) ? node.name.text : node.name.getText(sf);
      const declaredOwner = ts.isInterfaceDeclaration(node.parent) ? node.parent.name.text : undefined;
      members.push({
        name: `${owner}.${member}`, owner, member,
        kind: ts.SyntaxKind[node.kind], signature: node.getText(sf), source: sourcePath,
        line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
        ...(declaredOwner && !owner.includes(".") && declaredOwner !== owner ? { inheritedFrom: declaredOwner } : {}),
      });
      // Inline records, such as SystemContext.time, are queryable at the same granularity.
      if (ts.isPropertySignature(node) && node.type)
        addMembers(`${owner}.${member}`, elements(node.type), new Set(seen).add(node));
    }
  };
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
          source: sourcePath,
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
        source: sourcePath,
        line: location.line + 1,
        ...(ts.isInterfaceDeclaration(statement)
          ? {
              fields: statement.members
                .map((m) => m.name?.getText(sf))
                .filter((v): v is string => !!v),
            }
          : {}),
      });
      if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) addMembers(name, elements(statement));
    }
  }
  const index = {
    format: "pelican.api-index",
    version: 2,
    engineVersion: SDK_VERSION,
    entry: "pelican-engine",
    source: sourcePath,
    symbols,
    members,
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
    "## Member declarations",
    "",
    ...members.flatMap(member => [
      `### ${member.name}`, "",
      `Owner: \`${member.owner}\`; source: \`${member.source}:${member.line}\``, "",
      "```ts", member.signature, "```", "",
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
