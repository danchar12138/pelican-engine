import { mkdir, readFile, writeFile, copyFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import ts from "typescript";

const source = path.resolve(process.argv[2] ?? ".pelican/m4-rapier-wasm-source");
const bindgen = process.argv[3] ?? "wasm-bindgen";
const root = fileURLToPath(new URL("../../", import.meta.url));
const output = path.join(root, "packages/physics/vendor/rapier3d");
const bindings = path.join(source, "bindings/typescript");
const run = (command, args) => execFileSync(command, args, { cwd: bindings, stdio: "inherit", windowsHide: true });
const revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: source, encoding: "utf8", windowsHide: true }).trim();
if (revision !== "b716d375efc0201003f0cd9ef7168eee0b62c177") throw new Error("Expected the pinned Rapier source revision.");
const patch = await readFile(path.join(root, "packages/physics/vendor/rapier3d/bootstrap-before-observations.patch"), "utf8");
execFileSync("git", ["apply", "--reverse", "--check", "-"], { cwd: source, input: patch, stdio: ["pipe", "inherit", "inherit"], windowsHide: true });
// Compile only; no native, browser or test execution is part of this build.
run("cargo", ["run", "--locked", "-p", "prepare_builds", "--", "-d", "dim3", "-f", "non-deterministic"]);
run("cargo", ["build", "--locked", "--release", "--target", "wasm32-unknown-unknown", "-p", "dimforge_rapier3d"]);
const target = process.env.CARGO_TARGET_DIR ? path.resolve(bindings, process.env.CARGO_TARGET_DIR) : path.join(bindings, "target");
const generated = path.join(root, ".pelican/native/rapier3d");
await mkdir(generated, { recursive: true });
run(bindgen, ["--target", "web", "--out-dir", generated, path.join(target, "wasm32-unknown-unknown/release/rapier_wasm3d.wasm")]);
const wasm = await readFile(path.join(generated, "rapier_wasm3d_bg.wasm"));
const require = createRequire(path.join(bindings, "rapier-compat/package.json"));
const { rollup } = require("rollup");
const sourceDir = path.join(bindings, "src.ts");
function preprocess(text) {
  const stack = [true], lines = [];
  for (const line of text.split(/\r?\n/)) {
    const begin = line.match(/^\s*\/\/\s*#if\s+(DIM2|DIM3)\s*$/);
    if (begin) { stack.push(stack.at(-1) && begin[1] === "DIM3"); continue; }
    if (/^\s*\/\/\s*#endif\b/.test(line)) { if (stack.length === 1) throw new Error("Unbalanced dimension directive."); stack.pop(); continue; }
    if (stack.at(-1)) lines.push(line);
  }
  if (stack.length !== 1) throw new Error("Unclosed dimension directive.");
  return lines.join("\n");
}
const glue = path.join(generated, "rapier_wasm3d.js");
const bundle = await rollup({ input: path.join(sourceDir, "rapier.ts"), plugins: [{
  name: "pelican-rapier-bindings",
  resolveId(id, importer) {
    if (!id.startsWith(".") || !importer || importer.startsWith("\0")) return null;
    const target = path.resolve(path.dirname(importer), id);
    if (target === path.join(sourceDir, "raw")) return "\0raw";
    if (target === path.join(sourceDir, "init")) return "\0init";
    return this.resolve(id + ".ts", importer, { skipSelf: true }).then(found => found ?? this.resolve(id + "/index.ts", importer, { skipSelf: true }));
  },
  load(id) {
    if (id === "\0raw") return `export * from ${JSON.stringify(glue)};`;
    if (id === "\0init") return `import {initSync} from ${JSON.stringify(glue)};
      export function initNative(module){initSync({module});}
      export function init(){throw new Error("TC_PHYSICS_INIT: Initialize the engine-owned native factory.");}`;
    return null;
  },
  async transform(_code, id) {
    if (!id.endsWith(".ts")) return null;
    const text = preprocess(await readFile(id, "utf8"));
    return { code: ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText, map: null };
  },
}] });
await mkdir(output, { recursive: true });
try {
  const generated = await bundle.generate({ format: "iife", name: "bindings", exports: "named", sourcemap: false });
  const code = generated.output.find(item => item.type === "chunk").code;
  // Every call creates a fresh JS binding closure and a fresh WASM memory.
  // Only immutable compiled code is shared; no eval, workers or shared memory.
  await writeFile(path.join(output, "runtime.mjs"), `// Modified Rapier build. Apache-2.0; see LICENSE and build.json.\n
function createBindings(){\n${code}\nreturn bindings;}
const base=createBindings();
let compiledModule, pending;
async function initialize(){
 if(!pending) pending=(async()=>{
   const bytes=Uint8Array.from(atob(${JSON.stringify(wasm.toString("base64"))}), c=>c.charCodeAt(0));
   compiledModule=await WebAssembly.compile(bytes);
   base.initNative(compiledModule);
 })().catch(error=>{pending=undefined;compiledModule=undefined;throw error;});
 await pending;
}
export function createRapierInstance(){
 if(!compiledModule) throw new Error("TC_PHYSICS_INIT: Await createPhysicsFactory before creating native worlds.");
 const instance=createBindings();instance.initNative(compiledModule);return instance.default;
}
export default {...base.default,init:initialize};\n`);
}
finally { await bundle.close(); }
await copyFile(path.join(source, "LICENSE"), path.join(output, "LICENSE"));
const digest = value => createHash("sha256").update(value).digest("hex");
await writeFile(path.join(output, "build.json"), JSON.stringify({
  upstream: "https://github.com/dimforge/rapier", revision,
  patchSha256: digest(patch), wasmSha256: digest(wasm), wasmBytes: wasm.byteLength,
  runtimeSha256: digest(await readFile(path.join(output, "runtime.mjs"))),
  rustc: execFileSync("rustc", ["--version"], { encoding: "utf8", windowsHide: true }).trim(),
  bindgen: execFileSync(bindgen, ["--version"], { encoding: "utf8", windowsHide: true }).trim(),
  instancePolicy: "one JS binding closure and WebAssembly memory per physics world; compiled module shared",
  validation: "not-run; compile-only build",
}, null, 2) + "\n");
console.log(`Built full patched Rapier 3D bindings in ${path.relative(root, output)}`);
