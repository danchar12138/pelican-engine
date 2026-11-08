import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { verifyRegistryPackage } from "./verify-registry.ts";

const versionPattern = /^\d+\.\d+\.\d+$/;
export function releaseNotes(
  changelog: string,
  version: string,
  commit: string,
): string {
  if (!versionPattern.test(version) || !/^[a-f0-9]{40}$/.test(commit))
    throw new Error(
      "TC_RELEASE_IDENTITY: Use an explicit stable version and full source commit SHA.",
    );
  const lines = changelog.replace(/\r\n?/g, "\n").split("\n");
  const start = lines.findIndex(
    (line) => line === `## ${version}` || line.startsWith(`## ${version} - `),
  );
  if (start < 0)
    throw new Error(`TC_RELEASE_NOTES: No CHANGELOG section for ${version}.`);
  const end = lines.findIndex(
    (line, index) => index > start && line.startsWith("## "),
  );
  const section = lines
    .slice(start + 1, end < 0 ? undefined : end)
    .join("\n")
    .trim();
  if (!section)
    throw new Error(
      "TC_RELEASE_NOTES: Release notes must describe actual changes.",
    );
  return `## Pelican Engine ${version}\n\n${section}\n\n## 使用 npm 开发游戏\n\n\`\`\`sh\nnpm --prefix . install --save-dev --save-exact pelican-engine@${version}\nnpx pelican dev\n\`\`\`\n\n无需克隆引擎仓库。普通 TypeScript、游戏自有 npm 依赖与自定义模块可自由组合；私有 GPU/Three.js/WASM 对象不构成稳定插件协议。\n\n- [npm 精确版本](https://www.npmjs.com/package/pelican-engine/v/${version})\n- [此版本作者指南](https://github.com/danchar12138/pelican-engine/blob/${commit}/docs/npm/GAME-AUTHOR.md)\n- [依赖与自定义扩展](https://github.com/danchar12138/pelican-engine/blob/${commit}/docs/npm/INTEGRATIONS.md)\n\n源提交：\`${commit}\`。分发以已核验的 npm tarball 为准；GitHub 自动源码归档面向引擎贡献者，不是游戏安装入口。\n`;
}

/** Called only after npm byte verification. Never moves an existing version tag. */
export async function syncGitHubRelease(options: {
  repository: string;
  token: string;
  version: string;
  commit: string;
  notes: string;
  historical?: boolean;
  fetcher?: typeof fetch;
}) {
  const {
    repository,
    token,
    version,
    commit,
    notes,
    historical = false,
    fetcher = fetch,
  } = options;
  if (
    !/^[\w.-]+\/[\w.-]+$/.test(repository) ||
    !token ||
    !versionPattern.test(version) ||
    !/^[a-f0-9]{40}$/.test(commit)
  )
    throw new Error(
      "TC_RELEASE_IDENTITY: Explicit repository, token, stable version and full commit are required.",
    );
  const request = async (
    endpoint: string,
    method = "GET",
    body?: unknown,
    missing = false,
  ): Promise<any> => {
    const response = await fetcher(
      `https://api.github.com/repos/${repository}/${endpoint}`,
      {
        method,
        signal: AbortSignal.timeout(30000),
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "X-GitHub-Api-Version": "2022-11-28",
          "Content-Type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
    );
    if (missing && response.status === 404) return undefined;
    if (!response.ok)
      throw new Error(
        `TC_RELEASE_GITHUB: ${method} ${endpoint} returned HTTP ${response.status}; inspect repository permissions and retry explicitly. npm is not republished.`,
      );
    return response.json();
  };
  const tag = `v${version}`;
  const verifyTag = async (optional: boolean) => {
    const reference = await request(
      `git/ref/tags/${tag}`,
      "GET",
      undefined,
      optional,
    );
    if (!reference) return;
    let object = reference.object;
    for (let depth = 0; object?.type === "tag" && depth < 8; depth++)
      object = (await request(`git/tags/${object.sha}`)).object;
    if (object?.type !== "commit" || object.sha !== commit)
      throw new Error(
        `TC_RELEASE_TAG_MISMATCH: ${tag} is not pinned to ${commit}; existing tags are never moved.`,
      );
  };
  await verifyTag(true);
  const existing = await request(
    `releases/tags/${tag}`,
    "GET",
    undefined,
    true,
  );
  if (
    existing &&
    (existing.draft || existing.prerelease || existing.tag_name !== tag)
  )
    throw new Error(
      "TC_RELEASE_EXISTING: Existing release identity/state requires explicit review.",
    );
  const body = {
    tag_name: tag,
    target_commitish: commit,
    name: `Pelican Engine ${version}`,
    body: notes,
    draft: false,
    prerelease: false,
    make_latest: historical ? "false" : "true",
  };
  const release = existing
    ? await request(`releases/${existing.id}`, "PATCH", body)
    : await request("releases", "POST", body);
  await verifyTag(false);
  return {
    status: "succeeded",
    version,
    commit,
    tag,
    release: release.html_url,
    updated: !!existing,
  };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const args = process.argv.slice(2),
      values = new Map<string, string>();
    let historical = false;
    for (let i = 0; i < args.length; i++) {
      const key = args[i];
      if (key === "--historical" && !historical) {
        historical = true;
        continue;
      }
      if (
        !["--version", "--commit", "--tarball"].includes(key) ||
        values.has(key) ||
        !args[i + 1] ||
        args[i + 1].startsWith("--")
      )
        throw new Error(
          "TC_RELEASE_OPTIONS: Use --version <version> --commit <full-sha> --tarball <tgz> [--historical].",
        );
      values.set(key, args[++i]);
    }
    const root = fileURLToPath(new URL("../../", import.meta.url));
    const pkg = JSON.parse(
      await readFile(path.join(root, "package.json"), "utf8"),
    );
    const version = values.get("--version") ?? pkg.version;
    const commit = values.get("--commit") ?? process.env.GITHUB_SHA ?? "";
    const changelog = await readFile(path.join(root, "CHANGELOG.md"), "utf8");
    const notes = releaseNotes(changelog, version, commit);
    const tarball =
      values.get("--tarball") ??
      path.join(
        root,
        ".pelican/npm/artifacts",
        `pelican-engine-${version}.tgz`,
      );
    const registry = await verifyRegistryPackage({ version, tarball });
    const release = await syncGitHubRelease({
      repository:
        process.env.GITHUB_REPOSITORY ?? "danchar12138/pelican-engine",
      token: process.env.GH_TOKEN ?? "",
      version,
      commit,
      notes,
      historical,
    });
    console.log(JSON.stringify({ ...release, registry }, null, 2));
  } catch (error) {
    console.error(String(error));
    process.exitCode = 1;
  }
}
