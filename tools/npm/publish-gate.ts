// Historical release-event gate; current main-push OIDC publishing does not use it.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { checkRelease } from "../release.ts";
import { SDK_VERSION } from "../../packages/sdk/src/index.ts";

export function validatePublishIdentity(input: {
  eventName: string;
  action: string;
  draft: boolean;
  publishedAt?: string;
  tag: string;
  milestone: string;
  version: string;
  engineVersion: string;
  sdkVersion: string;
  head: string;
  tagCommit: string;
  eventCommit: string;
}) {
  if (
    input.eventName !== "release" ||
    input.action !== "published" ||
    input.draft ||
    !input.publishedAt
  )
    throw new Error(
      "TC_NPM_RELEASE_EVENT: npm publication requires a published GitHub release, never a push or manual CPU build.",
    );
  if (
    input.tag !== "v" + input.version ||
    input.engineVersion !== input.version ||
    input.sdkVersion !== input.version ||
    !/^M[0-8]$/.test(input.milestone)
  )
    throw new Error(
      "TC_NPM_RELEASE_VERSION: Milestone, release tag, package, manifest and SDK versions must match exactly.",
    );
  if (
    !/^[0-9a-f]{40}$/.test(input.head) ||
    input.head !== input.tagCommit ||
    input.head !== input.eventCommit
  )
    throw new Error(
      "TC_NPM_RELEASE_COMMIT: Checkout, milestone tag and published release must identify the same commit.",
    );
}

export async function publishGate(root: string, env = process.env) {
  if (!env.GITHUB_EVENT_PATH)
    throw new Error(
      "TC_NPM_RELEASE_EVENT: No GitHub published-release event is available.",
    );
  const event = JSON.parse(await readFile(env.GITHUB_EVENT_PATH, "utf8"));
  const pkg = JSON.parse(
    await readFile(path.join(root, "package.json"), "utf8"),
  );
  const engine = JSON.parse(
    await readFile(path.join(root, "engine.manifest.json"), "utf8"),
  );
  const tag = event.release?.tag_name;
  if (typeof tag !== "string" || !/^v\d+\.\d+\.\d+$/.test(tag))
    throw new Error(
      "TC_NPM_RELEASE_VERSION: Release tag is not an exact milestone tag.",
    );
  const git = (revision: string) =>
    execFileSync("git", ["rev-parse", "--verify", revision], {
      cwd: root,
      encoding: "utf8",
    }).trim();
  validatePublishIdentity({
    eventName: env.GITHUB_EVENT_NAME ?? "",
    action: event.action,
    draft: event.release?.draft !== false,
    publishedAt: event.release?.published_at,
    tag,
    milestone: engine.milestone,
    version: pkg.version,
    engineVersion: engine.version,
    sdkVersion: SDK_VERSION,
    head: git("HEAD"),
    tagCommit: git("refs/tags/" + tag + "^{commit}"),
    eventCommit: env.GITHUB_SHA ?? "",
  });
  const report = await checkRelease({ projectRoot: root });
  if (report.status !== "succeeded") {
    console.log(JSON.stringify(report, null, 2));
    throw new Error(
      "TC_NPM_ACCEPTANCE: Existing milestone acceptance/source-identity gates did not pass; npm publication is blocked.",
    );
  }
  return report;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  publishGate(fileURLToPath(new URL("../../", import.meta.url)))
    .then((report) => console.log(JSON.stringify(report, null, 2)))
    .catch((error) => {
      console.error(String(error));
      process.exitCode = 1;
    });
