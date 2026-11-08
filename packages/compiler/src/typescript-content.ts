/** Trusted project construction in an owned process. This is not a security sandbox. */
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { InlineConfig, Rollup } from "vite";
import type { ObjectValue } from "./extract.ts";
import type { SourceLocation } from "./types.ts";

const factories = [
  "defineComponent",
  "defineMaterial",
  "defineCompute",
  "definePostProcess",
  "defineAsset",
  "definePrefab",
  "defineScene",
  "defineSystem",
  "defineGame",
];
export class ContentError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
interface Packet {
  game: ObjectValue;
  definitions: ObjectValue[];
  locations: Record<string, SourceLocation>;
}
export async function typescriptContent(options: {
  entry: string;
  sdk: string;
  projectRoot: string;
  timeoutMs: number;
  build: (config: InlineConfig) => Promise<unknown>;
}) {
  const dependencies = new Set<string>();
  const sdkId = "\0pelican:content-sdk",
    entryId = "\0pelican:content-entry";
  const slash = (file: string) => file.replaceAll("\\", "/");
  const sdkPath = slash(options.sdk);
  const virtualEntry = slash(
    path.join(options.projectRoot, "__pelican_content__.js"),
  );
  const output = (await options.build({
    configFile: false,
    envFile: false,
    root: options.projectRoot,
    publicDir: false,
    logLevel: "silent",
    mode: "production",
    plugins: [
      {
        name: "pelican-typescript-content",
        enforce: "pre",
        resolveId(id) {
          if (id === "pelican-engine") return sdkId;
          if (slash(id) === virtualEntry) return entryId;
        },
        load(id) {
          if (id === sdkId)
            return `
          import * as sdk from ${JSON.stringify(sdkPath)};
          export * from ${JSON.stringify(sdkPath)};
          export const collected = [], locations = {};
          function record(value) {
            collected.push(value);
            locations[value.kind + ':' + value.id] = new Error().stack;
            return value;
          }
          ${factories.map((name) => `export const ${name} = input => record(sdk.${name}(input));`).join("\n")}
        `;
          if (id === entryId)
            return `
          import game from ${JSON.stringify(slash(options.entry))};
          import { collected, locations } from 'pelican-engine';
          let count = 0, characters = 0;
          const active = new Set();
          function clean(value, depth = 0, runtime = false) {
            if (++count > 200000 || depth > 128) throw new Error('TC_CONTENT_BUDGET: Content exceeds 200000 values or 128 levels.');
            if (typeof value === 'string') { characters += value.length; if (characters > 8 * 1024 * 1024) throw new Error('TC_CONTENT_BUDGET: Content strings exceed 8 MiB.'); }
            if (value === undefined) return undefined;
            if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
            if (typeof value === 'number' && Number.isFinite(value)) return value;
            if (typeof value === 'function' && runtime) {
              if (value.constructor.name !== 'Function') throw new Error('TC_SYSTEM_ASYNC: Systems must be synchronous ordinary functions.');
              return { __runtime: true };
            }
            if (typeof value !== 'object' || active.has(value)) throw new Error('TC_CONTENT_VALUE: Content must contain finite data without cycles; functions belong in system.run.');
            if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new Error('TC_CONTENT_VALUE: Export plain declaration data, not class instances, Map or Set.');
            active.add(value);
            const result = Array.isArray(value) ? value.map(v => clean(v, depth + 1)) : Object.fromEntries(Object.entries(value).filter(([,v]) => v !== undefined).map(([k,v]) => [k, clean(v, depth + 1, value.kind === 'system' && k === 'run')]));
            active.delete(value);
            return result;
          }
          try {
            if (!game || game.kind !== 'game') throw new Error('TC_GAME_ENTRY: Default-export a defineGame declaration.');
            const result = { game: clean(game), definitions: collected.map(value => clean(value)), locations };
            if (!process.send) throw new Error('TC_CONTENT_PROCESS: Missing compiler IPC channel.');
            process.send({ result }, () => process.exit(0));
          } catch (error) {
            process.send({ error: String(error) }, () => process.exit(1));
          }
        `;
          const file = id.split("?")[0];
          if (path.isAbsolute(file)) {
            if (
              file !== options.sdk &&
              !file.startsWith(path.dirname(options.sdk) + path.sep)
            )
              dependencies.add(file);
          }
        },
      },
    ],
    build: {
      write: false,
      target: "esnext",
      minify: false,
      sourcemap: "inline",
      lib: { entry: virtualEntry, formats: ["es"], fileName: "content" },
      rolldownOptions: { treeshake: false, output: { codeSplitting: false } },
    },
  })) as Rollup.RollupOutput | Rollup.RollupOutput[];
  const chunk = (Array.isArray(output) ? output : [output])
    .flatMap((result) => result.output)
    .find((item) => item.type === "chunk" && item.isEntry);
  if (!chunk || chunk.type !== "chunk")
    throw new ContentError(
      "TC_CONTENT_BUILD",
      "Content bundle did not produce an entry.",
    );
  const directory = await mkdtemp(path.join(tmpdir(), "pelican-content-"));
  let packet: Packet;
  try {
    const file = path.join(directory, "content.mjs");
    const map = chunk.map && JSON.parse(chunk.map.toString());
    let code = chunk.code;
    if (map) {
      map.sources = map.sources.map((source: string) =>
        source.startsWith("\0") || source.startsWith("file:")
          ? source
          : pathToFileURL(path.resolve(options.projectRoot, "dist", source))
              .href,
      );
      code = code.replace(
        /\/\/# sourceMappingURL=data:[^\n]+/,
        "//# sourceMappingURL=data:application/json;base64," +
          Buffer.from(JSON.stringify(map)).toString("base64"),
      );
    }
    await writeFile(file, code);
    packet = await new Promise<Packet>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        ["--enable-source-maps", "--max-old-space-size=512", file],
        {
          cwd: options.projectRoot,
          windowsHide: true,
          stdio: ["ignore", "ignore", "pipe", "ipc"],
          // tsx loaders inherited via NODE_OPTIONS are unnecessary for the self-contained JS bundle.
          env: { ...process.env, NODE_OPTIONS: "" },
        },
      );
      let stderr = "",
        received: Packet | undefined,
        failure: ContentError | undefined;
      const deadline = setTimeout(() => {
        failure = new ContentError(
          "TC_CONTENT_TIMEOUT",
          `Content construction exceeded ${options.timeoutMs} ms. Move long-running work into systems or increase contentTimeoutMs up to 120000.`,
        );
        child.kill("SIGKILL");
        child.stderr?.destroy();
        if (child.connected) child.disconnect();
        child.unref();
        reject(failure);
      }, options.timeoutMs);
      child.stderr!.on("data", (bytes) => {
        if (stderr.length < 16384)
          stderr += String(bytes).slice(0, 16384 - stderr.length);
      });
      child.on("message", (message: any) => {
        if (message?.error) {
          const code =
            /TC_[A-Z_]+/.exec(message.error)?.[0] ?? "TC_CONTENT_EXECUTION";
          failure = new ContentError(
            code,
            String(message.error).slice(0, 4096),
          );
        } else if (message?.result) received = message.result;
      });
      child.on("error", (error) => {
        failure = new ContentError("TC_CONTENT_PROCESS", error.message);
      });
      child.on("close", (code) => {
        clearTimeout(deadline);
        if (failure) reject(failure);
        else if (code !== 0 || !received)
          reject(
            new ContentError(
              "TC_CONTENT_EXECUTION",
              stderr.slice(-4096) ||
                "Content process exited without declaration data.",
            ),
          );
        else resolve(received);
      });
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
  const fallback: SourceLocation = {
    file: slash(path.relative(options.projectRoot, options.entry)),
    line: 1,
    column: 1,
    length: 1,
  };
  const locations = new Map<string, SourceLocation>();
  for (const [id, stack] of Object.entries(packet.locations)) {
    for (const line of String(stack).split("\n")) {
      const match =
        /(?:\(|at )(file:\/\/\/.*|[A-Za-z]:[\\/].*|\/.*):(\d+):(\d+)\)?$/.exec(
          line,
        );
      if (!match) continue;
      let file = match[1];
      if (file.startsWith("file:")) {
        try {
          file = fileURLToPath(file);
        } catch {
          continue;
        }
      }
      const relative = path.relative(options.projectRoot, file);
      if (
        relative.startsWith("..") ||
        path.isAbsolute(relative) ||
        relative.split(path.sep).includes("node_modules")
      )
        continue;
      locations.set(id, {
        file: slash(relative),
        line: +match[2],
        column: +match[3],
        length: 1,
      });
      break;
    }
  }
  // Export maps and workspace/hoisted package metadata can change resolution even
  // when a previously bundled JS file did not change. Include them in the cache.
  const directories = new Set<string>();
  for (const file of dependencies) {
    let directory = path.dirname(file);
    while (!directories.has(directory)) {
      directories.add(directory);
      const parent = path.dirname(directory);
      if (parent === directory || directory === options.projectRoot) break;
      directory = parent;
    }
  }
  for (const directory of directories) {
    const manifest = path.join(directory, "package.json");
    if (
      await stat(manifest)
        .then((item) => item.isFile())
        .catch(() => false)
    )
      dependencies.add(manifest);
  }
  const origins = new WeakMap<object, SourceLocation>();
  const locate = (value: unknown, parent: SourceLocation): void => {
    if (!value || typeof value !== "object" || origins.has(value)) return;
    const definition = value as Record<string, unknown>;
    const location =
      locations.get(definition.kind + ":" + definition.id) ?? parent;
    origins.set(value, location);
    for (const child of Object.values(value)) locate(child, location);
  };
  locate(packet.game, fallback);
  for (const definition of packet.definitions) locate(definition, fallback);
  return {
    game: packet.game,
    definitions: packet.definitions,
    dependencies: [...dependencies],
    source(value: object) {
      return origins.get(value) ?? fallback;
    },
  };
}
