import { spawnSync } from "node:child_process";
const args = process.argv.slice(2),
  separator = args.indexOf("--");
if (separator < 0)
  throw new Error(
    "Usage: node tools/run-with-env.mjs NAME=value -- node <arguments>",
  );
const env = { ...process.env };
for (const setting of args.slice(0, separator)) {
  const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(setting);
  if (!match) throw new Error("Invalid environment assignment.");
  env[match[1]] = match[2];
}
const [command, ...parameters] = args.slice(separator + 1);
if (command !== "node")
  throw new Error(
    "This helper runs Node entry points; pass -- node <arguments>.",
  );
const result = spawnSync(process.execPath, parameters, {
  env,
  stdio: "inherit",
  windowsHide: true,
});
if (result.error) console.error(result.error.message);
process.exitCode = result.status ?? 1;
