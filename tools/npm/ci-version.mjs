import { readFile, writeFile } from 'node:fs/promises';

const runId = process.env.GITHUB_RUN_ID;
if (!runId || !/^[1-9][0-9]*$/.test(runId)) {
  throw new Error('GITHUB_RUN_ID must be a positive integer.');
}

const enginePath = 'engine.manifest.json';
const engine = JSON.parse(await readFile(enginePath, 'utf8'));
const match = /^(\d+)\.(\d+)\./.exec(engine.version);
if (!match) throw new Error('Engine version must include major and minor numbers.');
const version = `${match[1]}.${match[2]}.${runId}`;

for (const file of ['package.json', enginePath, 'packages/compiler/package.json']) {
  const data = JSON.parse(await readFile(file, 'utf8'));
  data.version = version;
  await writeFile(file, JSON.stringify(data, null, 2) + '\n');
}
const examplePath = 'examples/m3/pelican.project.json';
const example = JSON.parse(await readFile(examplePath, 'utf8'));
example.engine.version = version;
await writeFile(examplePath, JSON.stringify(example, null, 2) + '\n');

const sdkPath = 'packages/sdk/src/index.ts';
const sdk = await readFile(sdkPath, 'utf8');
const declaration = /export const SDK_VERSION = "[^"\r\n]+";/;
if (!declaration.test(sdk)) throw new Error('SDK_VERSION declaration not found.');
await writeFile(sdkPath, sdk.replace(declaration, `export const SDK_VERSION = "${version}";`));
console.log(`CI package version: ${version}`);
