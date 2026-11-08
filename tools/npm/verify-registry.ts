import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const registry = "https://registry.npmjs.org";
const limit = 128 * 1024 * 1024;
const versionPattern = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
const digest = (algorithm: "sha1" | "sha256" | "sha512", bytes: Uint8Array, encoding: "hex" | "base64") =>
  createHash(algorithm).update(bytes).digest(encoding);

/** Verify that npm installed the exact public registry archive, not a cache alias or local file. */
export function verifyRegistryInstallLock(lock: unknown, version: string, localTarball: Uint8Array): void {
  if (!versionPattern.test(version)) throw new Error("TC_NPM_REGISTRY_VERSION: Expected the exact package version.");
  const entry = (lock as any)?.packages?.["node_modules/pelican-engine"];
  const integrity = `sha512-${digest("sha512", localTarball, "base64")}`;
  if (entry?.version !== version || entry?.integrity !== integrity ||
      entry?.resolved !== `${registry}/pelican-engine/-/pelican-engine-${version}.tgz`)
    throw new Error("TC_NPM_REGISTRY_INSTALL_MISMATCH: Registry install lock must resolve the accepted tarball and exact version.");
}

/** Verify public registry bytes after publication; never creates a release or changes a tag. */
export async function verifyRegistryPackage(options: {
  version: string;
  tarball: string;
  fetcher?: typeof fetch;
  wait?: (ms: number) => Promise<void>;
}) {
  const { version, tarball } = options;
  if (!versionPattern.test(version)) throw new Error("TC_NPM_REGISTRY_VERSION: Expected the exact package version.");
  const info = await stat(tarball);
  if (!info.isFile() || info.size < 1 || info.size > limit) throw new Error("TC_NPM_REGISTRY_PACKAGE: Expected a bounded local tarball.");
  const local = await readFile(tarball);
  if (local.length !== info.size || local.length > limit) throw new Error("TC_NPM_REGISTRY_PACKAGE: Local tarball changed during verification.");
  const sha512 = digest("sha512", local, "base64"), sha256 = digest("sha256", local, "hex"), sha1 = digest("sha1", local, "hex");
  const request = options.fetcher ?? fetch;
  const wait = options.wait ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)));
  let metadata: Response | undefined;
  for (let attempt = 0; attempt < 16; attempt++) {
    try {
      metadata = await request(`${registry}/pelican-engine/${encodeURIComponent(version)}`, { signal: AbortSignal.timeout(15000), redirect: "error" });
      if (metadata.ok) break;
      await metadata.body?.cancel().catch(() => {});
      if (![404, 408, 429].includes(metadata.status) && metadata.status < 500)
        throw new Error(`TC_NPM_REGISTRY_HTTP: Registry returned ${metadata.status}.`);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("TC_NPM_REGISTRY_HTTP")) throw error;
      metadata = undefined;
    }
    if (attempt < 15) await wait(Math.min(1000 * 2 ** attempt, 30000));
  }
  if (!metadata?.ok) throw new Error("TC_NPM_REGISTRY_UNAVAILABLE: Published version is not available yet; it may already be published. Verify it before retrying publication.");
  if (!metadata.body) throw new Error("TC_NPM_REGISTRY_METADATA: Missing registry metadata body.");
  const metaReader = metadata.body.getReader(), chunks: Uint8Array[] = [];
  let metaBytes = 0;
  try {
    while (true) {
      const item = await metaReader.read();
      if (item.done) break;
      metaBytes += item.value.byteLength;
      if (metaBytes > 1024 * 1024) {
        await metaReader.cancel().catch(() => {});
        throw new Error("TC_NPM_REGISTRY_METADATA: Registry metadata is too large.");
      }
      chunks.push(item.value);
    }
  } finally { metaReader.releaseLock(); }
  const text = Buffer.concat(chunks).toString("utf8");
  let record: any;
  try { record = JSON.parse(text); } catch { throw new Error("TC_NPM_REGISTRY_METADATA: Invalid registry metadata."); }
  if (record?.name !== "pelican-engine" || record?.version !== version ||
      record?.dist?.integrity !== `sha512-${sha512}` || record?.dist?.shasum !== sha1)
    throw new Error("TC_NPM_REGISTRY_MISMATCH: Published identity or integrity differs from the accepted local tarball; do not republish blindly.");
  let url: URL;
  try { url = new URL(record.dist.tarball); } catch { throw new Error("TC_NPM_REGISTRY_METADATA: Invalid tarball URL."); }
  if (url.origin !== registry || url.username || url.password || url.search || url.hash ||
      url.pathname !== `/pelican-engine/-/pelican-engine-${version}.tgz`)
    throw new Error("TC_NPM_REGISTRY_METADATA: Unexpected registry tarball location.");
  let response: Response | undefined;
  for (let attempt = 0; attempt < 16; attempt++) {
    try {
      response = await request(url.href, { signal: AbortSignal.timeout(30000), redirect: "error" });
      if (response.ok && response.body) break;
      if (![404, 408, 429].includes(response.status) && response.status < 500)
        throw new Error(`TC_NPM_REGISTRY_DOWNLOAD: Registry returned ${response.status}; do not republish blindly.`);
      await response.body?.cancel().catch(() => {});
      response = undefined;
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("TC_NPM_REGISTRY_DOWNLOAD")) throw error;
      response = undefined;
    }
    if (attempt < 15) await wait(Math.min(1000 * 2 ** attempt, 30000));
  }
  if (!response?.ok || !response.body) throw new Error("TC_NPM_REGISTRY_DOWNLOAD: Unable to download the published tarball; do not republish blindly.");
  const reader = response.body.getReader(), remote512 = createHash("sha512"), remote256 = createHash("sha256");
  let length = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      length += item.value.byteLength;
      if (length > limit || length > local.length) {
        await reader.cancel().catch(() => {});
        throw new Error("TC_NPM_REGISTRY_MISMATCH: Published tarball size differs.");
      }
      remote512.update(item.value); remote256.update(item.value);
    }
  } finally { reader.releaseLock(); }
  if (length !== local.length || remote512.digest("base64") !== sha512 || remote256.digest("hex") !== sha256)
    throw new Error("TC_NPM_REGISTRY_MISMATCH: Downloaded tarball differs from the accepted local tarball; do not republish blindly.");
  return { status: "verified" as const, package: "pelican-engine", version, bytes: length, sha256, integrity: `sha512-${sha512}`,
    scope: "post-publication registry byte parity", formalMilestoneAccepted: false as const };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const root = fileURLToPath(new URL("../../", import.meta.url));
    const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
    if (pkg.name !== "pelican-engine" || typeof pkg.version !== "string" || !versionPattern.test(pkg.version))
      throw new Error("TC_NPM_REGISTRY_VERSION: Package name and package version must match.");
    const result = await verifyRegistryPackage({ version: pkg.version, tarball: path.join(root, ".pelican/npm/artifacts", `pelican-engine-${pkg.version}.tgz`) });
    console.log(JSON.stringify(result, null, 2));
  } catch (error) { console.error(String(error)); process.exitCode = 1; }
}
