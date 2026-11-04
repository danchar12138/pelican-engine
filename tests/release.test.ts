/** Synthetic release fixtures test packaging rules only; they are not milestone/GPU evidence. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { promisify } from "node:util";
import { inflateRawSync, gunzipSync } from "node:zlib";
import { compressDist } from "../tools/compress-dist.ts";
import ts from "typescript";
import {
  checkRelease,
  packRelease,
  releaseCli,
  REQUIRED_CHECKS,
  M1_REQUIRED_CHECKS,
  M2_REQUIRED_CHECKS,
  M0_VERSION,
  type ReleaseManifest,
} from "../tools/release.ts";

import { sourceFingerprint } from "../tools/source-fingerprint.ts";

const directories: string[] = [];
after(async () => {
  const base = path.resolve(tmpdir());
  for (const directory of directories) {
    const relative = path.relative(base, path.resolve(directory));
    assert.ok(
      relative && !relative.startsWith("..") && !path.isAbsolute(relative),
    );
    assert.ok(path.basename(directory).startsWith("threecat 发布 "));
    await rm(directory, { recursive: true, force: true });
  }
});
async function temporary() {
  const directory = await mkdtemp(path.join(tmpdir(), "threecat 发布 "));
  directories.push(directory);
  return directory;
}
async function put(root: string, name: string, content: string | Buffer) {
  const file = path.join(root, name);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
}
async function putJson(root: string, name: string, value: unknown) {
  await put(root, name, JSON.stringify(value));
}
function acceptance() {
  return {
    protocolVersion: "0.1.0",
    engineVersion: M0_VERSION,
    milestone: "M0",
    status: "passed",
    scope: "risk-prototypes",
    checks: REQUIRED_CHECKS.map((id) => ({
      id,
      status: "passed",
      files: [`evidence/m0/${id}.json`],
    })),
    limitations: [
      "TEST FIXTURE ONLY. Not measured GPU evidence or a complete engine.",
    ],
  };
}
async function fixture() {
  const root = await temporary();
  await putJson(root, "package.json", {
    name: "threecat",
    version: M0_VERSION,
    license: "MIT",
  });
  await putJson(root, "package-lock.json", {
    name: "threecat",
    version: M0_VERSION,
    packages: { "": { version: M0_VERSION } },
  });
  await putJson(root, "engine.manifest.json", {
    name: "threecat",
    version: M0_VERSION,
    milestone: "M0",
    license: "MIT",
    protocolVersion: "0.1.0",
  });
  await put(
    root,
    "LICENSE",
    "MIT License\nPermission is hereby granted (synthetic fixture only).",
  );
  await put(
    root,
    "THIRD_PARTY_NOTICES.md",
    "Synthetic fixture with no bundled third-party code; not a legal notice for production.",
  );
  await put(root, "AGENTS.md", "Test-only AI entry.");
  await put(root, "README.md", "Synthetic release fixture.");
  await put(root, "threecat.ps1", "# Synthetic bootstrap fixture");
  await put(root, "docs/README.md", "Synthetic fixture documentation");
  await put(root, "assets/sample.txt", "Synthetic offline asset");
  await put(root, "src/tokens.ts", "export const tokenKinds = [];");
  await put(root, "assets/secrets.glb", Buffer.from([0x67, 0x6c, 0x54, 0x46]));
  await put(root, "src/中文 空格.ts", "export const example = 1;\n");
  await put(
    root,
    "dist/index.html",
    '<!doctype html><script src="./assets/main.js"></script>',
  );
  await put(root, "dist/assets/main.js", 'console.log("test-only");');
  for (const id of REQUIRED_CHECKS)
    await putJson(
      root,
      `evidence/m0/${id}.json`,
      id === "render"
        ? {
            fixture: true,
            backend: "WebGPUBackend",
            adapter: {
              vendor: "synthetic-test-device",
              isFallbackAdapter: false,
            },
            capabilities: {
              hardwareRT: false,
              tracer: "software-triangle-BVH",
            },
          }
        : { fixture: true, status: "passed", id },
    );
  await putJson(root, "evidence/m0/acceptance.json", acceptance());
  return root;
}
async function mutate(
  root: string,
  update: (value: ReturnType<typeof acceptance>) => void,
) {
  const value = acceptance();
  update(value);
  await putJson(root, "evidence/m0/acceptance.json", value);
}
function sha(content: Buffer) {
  return createHash("sha256").update(content).digest("hex");
}
/** Independent ZIP reader checks local headers, decompression and the end/central counts. */
function unzip(bytes: Buffer): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  let offset = 0;
  while (bytes.readUInt32LE(offset) === 0x04034b50) {
    assert.equal(bytes.readUInt16LE(offset + 6), 0x800, "UTF-8 flag");
    assert.equal(bytes.readUInt16LE(offset + 8), 8, "deflate");
    const length = bytes.readUInt32LE(offset + 18);
    const uncompressed = bytes.readUInt32LE(offset + 22);
    const nameLength = bytes.readUInt16LE(offset + 26);
    const extraLength = bytes.readUInt16LE(offset + 28);
    const name = bytes
      .subarray(offset + 30, offset + 30 + nameLength)
      .toString("utf8");
    const start = offset + 30 + nameLength + extraLength;
    const content = inflateRawSync(bytes.subarray(start, start + length));
    assert.equal(content.length, uncompressed);
    assert.ok(!files.has(name));
    files.set(name, content);
    offset = start + length;
  }
  assert.equal(bytes.readUInt32LE(offset), 0x02014b50, "central directory");
  assert.equal(bytes.readUInt32LE(bytes.length - 22), 0x06054b50);
  assert.equal(bytes.readUInt16LE(bytes.length - 12), files.size);
  assert.equal(bytes.readUInt32LE(bytes.length - 6), offset);
  return files;
}
function hasCode(
  result: Awaited<ReturnType<typeof checkRelease>>,
  code: string,
) {
  assert.equal(result.status, "failed");
  assert.equal(result.data, null);
  assert.ok(
    result.diagnostics.some((d) => d.code === code),
    JSON.stringify(result),
  );
}

test("missing acceptance actually fails check and pack without producing a release", async () => {
  const root = await fixture();
  await rm(path.join(root, "evidence/m0/acceptance.json"));
  hasCode(
    await checkRelease({ projectRoot: root }),
    "TCREL_ACCEPTANCE_MISSING",
  );
  hasCode(await packRelease({ projectRoot: root }), "TCREL_ACCEPTANCE_MISSING");
  await assert.rejects(lstat(path.join(root, "release")), { code: "ENOENT" });
});

test("acceptance status, individual failed/skipped checks and missing required IDs block release", async () => {
  const root = await fixture();
  await mutate(root, (a) => {
    a.status = "failed";
  });
  hasCode(await checkRelease({ projectRoot: root }), "TCREL_ACCEPTANCE_STATUS");
  for (const status of ["failed", "skipped", "pending"]) {
    await mutate(root, (a) => {
      a.checks[0]!.status = status;
    });
    hasCode(await checkRelease({ projectRoot: root }), "TCREL_CHECK_STATUS");
  }
  await mutate(root, (a) => {
    a.checks = a.checks.filter((c) => c.id !== "deploy");
  });
  hasCode(await checkRelease({ projectRoot: root }), "TCREL_CHECKS");
});

test("all checks need nonempty existing evidence and cannot cite acceptance itself", async () => {
  const root = await fixture();
  await mutate(root, (a) => {
    a.checks[0]!.files = [];
  });
  hasCode(await checkRelease({ projectRoot: root }), "TCREL_EVIDENCE_FILES");
  await mutate(root, (a) => {
    a.checks[0]!.files = ["evidence/m0/not-created.json"];
  });
  hasCode(await checkRelease({ projectRoot: root }), "TCREL_EVIDENCE_MISSING");
  await mutate(root, (a) => {
    a.checks[0]!.files = ["evidence/m0/acceptance.json"];
  });
  hasCode(await checkRelease({ projectRoot: root }), "TCREL_EVIDENCE_FILES");
  await mutate(root, (a) => {
    a.checks.push(a.checks[0]!);
  });
  hasCode(await checkRelease({ projectRoot: root }), "TCREL_CHECKS");
});

test("absolute, drive-relative, traversal and UNC evidence paths are rejected", async () => {
  const root = await fixture();
  for (const name of [
    "../outside.json",
    "evidence/../../outside.json",
    "/tmp/proof.json",
    "C:\\Users\\someone\\proof.json",
    "C:proof.json",
    "\\\\host\\proof.json",
    "evidence//m0/compiler.json",
  ]) {
    await mutate(root, (a) => {
      a.checks[0]!.files = [name];
    });
    hasCode(await checkRelease({ projectRoot: root }), "TCREL_PATH");
  }
});

test("render passed text or screenshot without recorded GPU facts cannot pass", async () => {
  const root = await fixture();
  await putJson(root, "evidence/m0/render.json", {
    status: "passed",
    screenshots: ["image.png"],
  });
  hasCode(await checkRelease({ projectRoot: root }), "TCREL_GPU_EVIDENCE");
  await putJson(root, "evidence/m0/render.json", {
    backend: "WebGPUBackend",
    adapter: { vendor: "test" },
  });
  hasCode(await checkRelease({ projectRoot: root }), "TCREL_GPU_EVIDENCE");
});

test("software/fallback adapters fail while software BVH on an explicit real adapter is allowed", async () => {
  const root = await fixture();
  for (const adapter of [
    { vendor: "test", isFallbackAdapter: true },
    { vendor: "Google", description: "SwiftShader", isFallbackAdapter: false },
    { vendor: "Microsoft", description: "WARP", isFallbackAdapter: false },
  ]) {
    await putJson(root, "evidence/m0/render.json", {
      backend: "WebGPUBackend",
      adapter,
    });
    hasCode(await checkRelease({ projectRoot: root }), "TCREL_GPU_SOFTWARE");
  }
  await putJson(root, "evidence/m0/render.json", {
    backend: "WebGPUBackend",
    adapter: { vendor: "synthetic-test-device", isFallbackAdapter: false },
    hardwareRT: false,
    tracer: "software-triangle-BVH",
  });
  assert.equal((await checkRelease({ projectRoot: root })).status, "succeeded");
});

test("engine/package/lock/acceptance versions, scope and protocol must agree", async () => {
  const root = await fixture();
  await mutate(root, (a) => {
    a.engineVersion = "0.0.2";
  });
  hasCode(await checkRelease({ projectRoot: root }), "TCREL_VERSION");
  await mutate(root, (a) => {
    a.protocolVersion = "9.0.0";
  });
  hasCode(await checkRelease({ projectRoot: root }), "TCREL_PROTOCOL");
  await mutate(root, (a) => {
    a.scope = "complete-engine";
  });
  hasCode(await checkRelease({ projectRoot: root }), "TCREL_ACCEPTANCE_SCOPE");
  await mutate(root, () => {});
  await putJson(root, "package-lock.json", {
    version: M0_VERSION,
    packages: { "": { version: "0.0.2" } },
  });
  hasCode(await checkRelease({ projectRoot: root }), "TCREL_VERSION");
});

test("the minimal acceptance shape is supported and a missing limitation list is rejected", async () => {
  const root = await fixture();
  const a = acceptance();
  const { protocolVersion: _protocol, engineVersion: _version, ...minimal } = a;
  await putJson(root, "evidence/m0/acceptance.json", minimal);
  const result = await checkRelease({ projectRoot: root });
  assert.equal(result.status, "succeeded");
  assert.equal(result.data?.engineVersion, M0_VERSION);
  await mutate(root, (value) => {
    value.limitations = [];
  });
  hasCode(await checkRelease({ projectRoot: root }), "TCREL_LIMITATIONS");
});

test("missing MIT license, third-party notice or dist fails without creating substitutes", async () => {
  for (const [name, code] of [
    ["LICENSE", "TCREL_LICENSE"],
    ["THIRD_PARTY_NOTICES.md", "TCREL_NOTICE"],
    ["dist/index.html", "TCREL_DIST"],
  ] as const) {
    const root = await fixture();
    await rm(path.join(root, name));
    hasCode(await packRelease({ projectRoot: root }), code);
    await assert.rejects(lstat(path.join(root, name)), { code: "ENOENT" });
  }
});

test("ZIP source without Git includes Chinese paths/evidence and excludes dependencies, secrets and temporary files", async () => {
  const root = await fixture();
  for (const name of [
    ".git/config",
    "node_modules/private/index.js",
    ".threecat/cache.json",
    "release/old.zip",
    "dist/.env",
    ".env",
    ".env.example",
    ".npmrc",
    ".ssh/id_rsa",
    "keys/signing.pem",
    "app.credentials.json",
    "tmp/private.json",
    "src/editor.ts.bak",
    "debug.log",
    "download.zip",
    "public/generated/temporary.json",
  ])
    await put(root, name, "DO-NOT-PUBLISH");
  // Sparse dependency file exceeds release limits: pruning must occur before reading it.
  const large = await open(path.join(root, "node_modules", "large.bin"), "w");
  await large.truncate(129 * 1024 * 1024);
  await large.close();
  const result = await packRelease({ projectRoot: root });
  assert.equal(result.status, "succeeded", JSON.stringify(result));
  const directory = path.join(root, result.data!.directory);
  const source = unzip(
    await readFile(path.join(directory, `threecat-${M0_VERSION}-source.zip`)),
  );
  const prefix = `threecat-${M0_VERSION}/`;
  assert.equal(
    source.get(`${prefix}src/中文 空格.ts`)?.toString("utf8"),
    "export const example = 1;\n",
  );
  assert.ok(source.has(`${prefix}evidence/m0/acceptance.json`));
  assert.ok(source.has(`${prefix}package-lock.json`));
  for (const name of [
    "threecat.ps1",
    "AGENTS.md",
    "docs/README.md",
    "assets/sample.txt",
    "src/tokens.ts",
    "assets/secrets.glb",
  ])
    assert.ok(source.has(`${prefix}${name}`));
  assert.ok(!source.has(`${prefix}public/generated/temporary.json`));
  for (const [name, content] of source) {
    assert.ok(name.startsWith(prefix));
    assert.doesNotMatch(
      name,
      /(?:^|\/)(?:node_modules|\.git|\.threecat|release|dist|tmp)(?:\/|$)/,
    );
    assert.doesNotMatch(content.toString("utf8"), /DO-NOT-PUBLISH/);
    assert.ok(!name.includes(root) && !name.includes("\\"));
  }
  const dist = unzip(
    await readFile(path.join(directory, `threecat-${M0_VERSION}-dist.zip`)),
  );
  assert.ok(
    dist.has("index.html") &&
      dist.has("assets/main.js") &&
      dist.has("LICENSE") &&
      dist.has("THIRD_PARTY_NOTICES.md"),
  );
  assert.ok(!dist.has("src/中文 空格.ts") && !dist.has(".env"));
  await assert.rejects(lstat(path.join(root, "dist/LICENSE")), {
    code: "ENOENT",
  });
});

test("SHA256SUMS and manifest verify every archive byte and every uncompressed file", async () => {
  const root = await fixture();
  const result = await packRelease({ projectRoot: root });
  assert.equal(result.status, "succeeded", JSON.stringify(result));
  const directory = path.join(root, result.data!.directory);
  const sums = (await readFile(path.join(directory, "SHA256SUMS"), "utf8"))
    .trim()
    .split("\n");
  assert.equal(sums.length, 5);
  for (const line of sums) {
    const [expected, name] = line.split("  ");
    assert.match(expected!, /^[0-9a-f]{64}$/);
    assert.equal(sha(await readFile(path.join(directory, name!))), expected);
  }
  const raw = await readFile(path.join(root, result.data!.manifest), "utf8");
  assert.ok(!raw.includes(root) && !raw.includes(tmpdir()));
  const manifest: ReleaseManifest = JSON.parse(raw);
  assert.equal(manifest.protocolVersion, "0.1.0");
  assert.equal(manifest.prerelease, true);
  assert.equal(manifest.scope, "risk-prototypes");
  for (const archive of manifest.archives) {
    const bytes = await readFile(path.join(directory, archive.path));
    assert.equal(archive.sha256, sha(bytes));
    assert.equal(archive.bytes, bytes.length);
    const files = unzip(bytes);
    assert.equal(files.size, archive.entries.length);
    for (const file of archive.entries) {
      const content = files.get(file.path)!;
      assert.equal(file.bytes, content.length);
      assert.equal(file.sha256, sha(content));
    }
    // Tampering is observable using the published digest.
    const altered = Buffer.from(bytes);
    altered[50] = altered[50]! ^ 1;
    assert.notEqual(sha(altered), archive.sha256);
  }
  const notes = await readFile(
    path.join(directory, "RELEASE_NOTES.md"),
    "utf8",
  );
  assert.match(notes, /not a complete game engine/);
  const second = await packRelease({ projectRoot: root });
  hasCode(second, "TCREL_OUTPUT_EXISTS");
  assert.equal(
    await readFile(path.join(directory, "SHA256SUMS"), "utf8"),
    sums.join("\n") + "\n",
  );
});

test("embedded credential-like content fails rather than publishing a renamed secret", async () => {
  const root = await fixture();
  await put(
    root,
    "src/ordinary.ts",
    'export const value = "' + "ghp_" + "A".repeat(40) + '";',
  );
  hasCode(await packRelease({ projectRoot: root }), "TCREL_SECRET");
});

test("junctions are never followed and acceptance cannot be loaded through a linked evidence directory", async () => {
  const root = await fixture();
  const outside = await temporary();
  await put(outside, "private.json", "DO-NOT-PUBLISH");
  await symlink(
    outside,
    path.join(root, "linked-content"),
    process.platform === "win32" ? "junction" : "dir",
  );
  const result = await packRelease({ projectRoot: root });
  assert.equal(result.status, "succeeded", JSON.stringify(result));
  const source = unzip(
    await readFile(
      path.join(
        root,
        result.data!.directory,
        `threecat-${M0_VERSION}-source.zip`,
      ),
    ),
  );
  assert.ok(
    [...source.keys()].every((name) => !name.includes("linked-content")),
  );
  const linkedRoot = await fixture();
  await rm(path.join(linkedRoot, "evidence"), { recursive: true });
  await symlink(
    path.join(root, "evidence"),
    path.join(linkedRoot, "evidence"),
    process.platform === "win32" ? "junction" : "dir",
  );
  hasCode(
    await checkRelease({ projectRoot: linkedRoot }),
    "TCREL_ACCEPTANCE_MISSING",
  );
});

test("release output junction is rejected without writing outside the project", async () => {
  const root = await fixture();
  const outside = await temporary();
  await symlink(
    outside,
    path.join(root, "release"),
    process.platform === "win32" ? "junction" : "dir",
  );
  hasCode(await packRelease({ projectRoot: root }), "TCREL_OUTPUT_LINK");
  await assert.rejects(lstat(path.join(outside, `v${M0_VERSION}`)), {
    code: "ENOENT",
  });
});

test(
  "Windows Expand-Archive can extract the source ZIP and preserve Unicode names",
  { skip: process.platform !== "win32" },
  async () => {
    const root = await fixture();
    const result = await packRelease({ projectRoot: root });
    assert.equal(result.status, "succeeded");
    const archive = path.join(
      root,
      result.data!.directory,
      `threecat-${M0_VERSION}-source.zip`,
    );
    const destination = path.join(root, "解压 结果");
    await promisify(execFile)(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Expand-Archive -LiteralPath $env:TC_TEST_RELEASE_ZIP -DestinationPath $env:TC_TEST_RELEASE_DEST -ErrorAction Stop",
      ],
      {
        timeout: 30_000,
        windowsHide: true,
        env: {
          ...process.env,
          TC_TEST_RELEASE_ZIP: archive,
          TC_TEST_RELEASE_DEST: destination,
        },
      },
    );
    assert.equal(
      await readFile(
        path.join(destination, `threecat-${M0_VERSION}`, "src/中文 空格.ts"),
        "utf8",
      ),
      "export const example = 1;\n",
    );
  },
);

test("CLI accepts explicit project roots, rejects unknown flags and returns structured failure", async () => {
  const root = await fixture();
  assert.equal(
    (await releaseCli(["check", "--root", root])).status,
    "succeeded",
  );
  hasCode(await releaseCli(["publish"]), "TCREL_USAGE");
  hasCode(await releaseCli(["pack", "--force"]), "TCREL_USAGE");
  const { stdout } = await promisify(execFile)(
    process.execPath,
    ["--import", "tsx", "tools/release.ts", "check", "--root", root],
    {
      cwd: path.resolve(import.meta.dirname, ".."),
      timeout: 30_000,
      windowsHide: true,
    },
  );
  const result = JSON.parse(stdout);
  assert.equal(result.status, "succeeded");
  assert.equal(result.protocolVersion, "0.1.0");
});

test("main verifier evidence arrays and environment check are canonical; legacy files cannot conflict", async () => {
  const root = await fixture();
  const original = acceptance();
  const canonical = {
    ...original,
    checks: original.checks.map(({ files, ...check }) => ({
      ...check,
      evidence: files,
    })),
  };
  await putJson(root, "evidence/m0/acceptance.json", canonical);
  const result = await checkRelease({ projectRoot: root });
  assert.equal(result.status, "succeeded", JSON.stringify(result));
  assert.ok(result.data?.checks.some((check) => check.id === "environment"));
  assert.ok(
    result.data?.checks.every(
      (check) =>
        Array.isArray(check.evidence) &&
        check.evidence.length > 0 &&
        !("files" in check),
    ),
  );
  await putJson(root, "evidence/m0/acceptance.json", {
    ...canonical,
    checks: canonical.checks.filter((check) => check.id !== "environment"),
  });
  hasCode(await checkRelease({ projectRoot: root }), "TCREL_CHECKS");
  await putJson(root, "evidence/m0/acceptance.json", {
    ...canonical,
    checks: canonical.checks.map((check) => ({
      ...check,
      files: ["evidence/m0/another.json"],
    })),
  });
  hasCode(await checkRelease({ projectRoot: root }), "TCREL_EVIDENCE_FILES");
});

test("actual CLI failure exits nonzero with a structured missing-acceptance diagnostic", async () => {
  const root = await fixture();
  await rm(path.join(root, "evidence/m0/acceptance.json"));
  await assert.rejects(
    promisify(execFile)(
      process.execPath,
      ["--import", "tsx", "tools/release.ts", "check", "--root", root],
      {
        cwd: path.resolve(import.meta.dirname, ".."),
        timeout: 30_000,
        windowsHide: true,
      },
    ),
    (error) => {
      const detail = error as Error & { code: number; stdout: string };
      assert.equal(detail.code, 1);
      const output = JSON.parse(detail.stdout);
      assert.equal(output.status, "failed");
      assert.equal(output.diagnostics[0].code, "TCREL_ACCEPTANCE_MISSING");
      assert.ok(!detail.stdout.includes(root));
      return true;
    },
  );
});

test("a recorded source fingerprint cannot claim acceptance for changed executable sources", async () => {
  const root = await fixture();
  const acceptance = JSON.parse(
    await readFile(path.join(root, "evidence/m0/acceptance.json"), "utf8"),
  );
  acceptance.sourceIdentity = { sha256: "0".repeat(64) };
  await putJson(root, "evidence/m0/acceptance.json", acceptance);
  const result = await checkRelease({ projectRoot: root });
  assert.equal(result.status, "failed");
  assert.ok(result.diagnostics.some((d) => d.code === "TCREL_EVIDENCE_STALE"));
});

// These records deliberately use synthetic adapters. They exercise rejection and
// packaging behavior only; no fixture represents actual GPU/milestone acceptance.
const M1_FIXTURE_VERSION = "0.1.0-m1.0";
async function readJson(root: string, name: string) {
  return JSON.parse(await readFile(path.join(root, name), "utf8"));
}
async function refreshIdentity(root: string, milestone = "m1") {
  const file = `evidence/${milestone}/acceptance.json`;
  const report = await readJson(root, file);
  report.sourceIdentity = await sourceFingerprint(root);
  await putJson(root, file, report);
}
async function m1Fixture() {
  const root = await fixture();
  for (const file of [
    "package.json",
    "package-lock.json",
    "engine.manifest.json",
  ]) {
    const data = await readJson(root, file);
    data.version = M1_FIXTURE_VERSION;
    if (file === "package-lock.json")
      data.packages[""].version = M1_FIXTURE_VERSION;
    if (file === "engine.manifest.json") {
      data.milestone = "M1";
      data.releaseScope = "runtime-foundation";
    }
    await putJson(root, file, data);
  }
  // Keep an old M0 acceptance in place to prove selection never falls back to it.
  for (const id of M1_REQUIRED_CHECKS) {
    const report =
      id === "render"
        ? await readJson(root, "evidence/m0/render.json")
        : { fixture: true, status: "passed", id };
    await putJson(root, `evidence/m1/${id}.json`, report);
  }
  await put(
    root,
    "packages/shared/src/index.ts",
    "export const protocol = 'fixture';\n",
  );
  await putJson(root, "evidence/m1/acceptance.json", {
    protocolVersion: "0.1.0",
    engineVersion: M1_FIXTURE_VERSION,
    milestone: "M1",
    scope: "runtime-foundation",
    status: "passed",
    checks: M1_REQUIRED_CHECKS.map((id) => ({
      id,
      status: "passed",
      evidence: [`evidence/m1/${id}.json`],
    })),
    limitations: [
      "SYNTHETIC RULE TEST ONLY; not measured GPU or completed M1 evidence.",
    ],
  });
  await refreshIdentity(root);
  return root;
}

test("M1 selects its own acceptance and never falls back to a passing M0 report", async () => {
  const root = await m1Fixture();
  await rm(path.join(root, "evidence/m1/acceptance.json"));
  hasCode(
    await checkRelease({ projectRoot: root }),
    "TCREL_ACCEPTANCE_MISSING",
  );
  hasCode(await packRelease({ projectRoot: root }), "TCREL_ACCEPTANCE_MISSING");
  await assert.rejects(lstat(path.join(root, "release")), { code: "ENOENT" });
});

test("M1 requires the exact manifest scope and matching acceptance scope/milestone", async () => {
  const root = await m1Fixture();
  const manifest = await readJson(root, "engine.manifest.json");
  for (const scope of [undefined, "risk-prototypes", "typo-foundation"]) {
    await putJson(root, "engine.manifest.json", {
      ...manifest,
      releaseScope: scope,
    });
    hasCode(await checkRelease({ projectRoot: root }), "TCREL_RELEASE_SCOPE");
  }
  await putJson(root, "engine.manifest.json", manifest);
  const report = await readJson(root, "evidence/m1/acceptance.json");
  for (const change of [{ scope: "risk-prototypes" }, { milestone: "M0" }]) {
    await putJson(root, "evidence/m1/acceptance.json", {
      ...report,
      ...change,
    });
    hasCode(
      await checkRelease({ projectRoot: root }),
      "TCREL_ACCEPTANCE_SCOPE",
    );
  }
});

test("M1 package, lockfile roots, manifest and explicit acceptance version must agree", async () => {
  const root = await m1Fixture();
  for (const file of [
    "package.json",
    "package-lock.json",
    "engine.manifest.json",
  ]) {
    const original = await readJson(root, file);
    await putJson(root, file, { ...original, version: "0.1.1-m1.0" });
    hasCode(await checkRelease({ projectRoot: root }), "TCREL_VERSION");
    await putJson(root, file, original);
  }
  const lock = await readJson(root, "package-lock.json");
  await putJson(root, "package-lock.json", {
    ...lock,
    packages: { "": { version: M0_VERSION } },
  });
  hasCode(await checkRelease({ projectRoot: root }), "TCREL_VERSION");
  await putJson(root, "package-lock.json", lock);
  const report = await readJson(root, "evidence/m1/acceptance.json");
  for (const engineVersion of [undefined, M0_VERSION]) {
    await putJson(root, "evidence/m1/acceptance.json", {
      ...report,
      engineVersion,
    });
    hasCode(await checkRelease({ projectRoot: root }), "TCREL_VERSION");
  }
});

test("M1 requires current sourceIdentity and detects changes in shared packages", async () => {
  const root = await m1Fixture();
  const report = await readJson(root, "evidence/m1/acceptance.json");
  for (const sourceIdentity of [undefined, {}, { sha256: "invalid" }]) {
    await putJson(root, "evidence/m1/acceptance.json", {
      ...report,
      sourceIdentity,
    });
    hasCode(await checkRelease({ projectRoot: root }), "TCREL_SOURCE_IDENTITY");
  }
  await putJson(root, "evidence/m1/acceptance.json", report);
  assert.equal((await checkRelease({ projectRoot: root })).status, "succeeded");
  await put(
    root,
    "packages/shared/src/index.ts",
    "export const protocol = 'changed';\n",
  );
  hasCode(await checkRelease({ projectRoot: root }), "TCREL_EVIDENCE_STALE");
  hasCode(await packRelease({ projectRoot: root }), "TCREL_EVIDENCE_STALE");
  await assert.rejects(lstat(path.join(root, "release")), { code: "ENOENT" });
  await refreshIdentity(root);
  assert.equal((await checkRelease({ projectRoot: root })).status, "succeeded");
});

test("all M1 gate IDs include unattended startup and reject missing, duplicate or failed checks", async () => {
  const root = await m1Fixture();
  const report = await readJson(root, "evidence/m1/acceptance.json");
  for (const id of M1_REQUIRED_CHECKS) {
    await putJson(root, "evidence/m1/acceptance.json", {
      ...report,
      checks: report.checks.filter((c: { id: string }) => c.id !== id),
    });
    hasCode(await checkRelease({ projectRoot: root }), "TCREL_CHECKS");
  }
  await putJson(root, "evidence/m1/acceptance.json", {
    ...report,
    checks: [...report.checks, report.checks[0]],
  });
  hasCode(await checkRelease({ projectRoot: root }), "TCREL_CHECKS");
  for (const status of ["failed", "skipped", "pending"]) {
    await putJson(root, "evidence/m1/acceptance.json", {
      ...report,
      checks: report.checks.map((c: { id: string }) =>
        c.id === "runtime" ? { ...c, status } : c,
      ),
    });
    hasCode(await checkRelease({ projectRoot: root }), "TCREL_CHECK_STATUS");
  }
});

test("M1 rejects missing evidence, self-citation and false GPU claims", async () => {
  const root = await m1Fixture();
  const report = await readJson(root, "evidence/m1/acceptance.json");
  for (const [evidence, code] of [
    [[], "TCREL_EVIDENCE_FILES"],
    [["evidence/m1/absent.json"], "TCREL_EVIDENCE_MISSING"],
    [["evidence/m1/acceptance.json"], "TCREL_EVIDENCE_FILES"],
    [["../outside.json"], "TCREL_PATH"],
  ] as const) {
    await putJson(root, "evidence/m1/acceptance.json", {
      ...report,
      checks: report.checks.map((c: { id: string }) =>
        c.id === "runtime" ? { ...c, evidence } : c,
      ),
    });
    hasCode(await checkRelease({ projectRoot: root }), code);
  }
  await putJson(root, "evidence/m1/acceptance.json", report);
  for (const [render, code] of [
    [{ status: "passed" }, "TCREL_GPU_EVIDENCE"],
    [
      {
        backend: "WebGLBackend",
        adapter: { vendor: "test", isFallbackAdapter: false },
      },
      "TCREL_GPU_EVIDENCE",
    ],
    [
      {
        backend: "WebGPUBackend",
        adapter: { vendor: "test", isFallbackAdapter: true },
      },
      "TCREL_GPU_SOFTWARE",
    ],
    [
      {
        backend: "WebGPUBackend",
        adapter: { description: "SwiftShader", isFallbackAdapter: false },
      },
      "TCREL_GPU_SOFTWARE",
    ],
  ] as const) {
    await putJson(root, "evidence/m1/render.json", render);
    hasCode(await checkRelease({ projectRoot: root }), code);
  }
});

test("M1 packages the current version, source root, evidence and independent root dist", async () => {
  const root = await m1Fixture();
  // Any nested build must not substitute for root/dist.
  await put(root, "examples/game/dist/index.html", "wrong nested build");
  await refreshIdentity(root);
  const checked = await checkRelease({ projectRoot: root });
  assert.equal(checked.status, "succeeded", JSON.stringify(checked));
  assert.equal(checked.taskId, "M1-release");
  assert.equal(checked.data?.milestone, "M1");
  assert.equal(checked.data?.scope, "runtime-foundation");
  assert.equal(checked.data?.prerelease, true);
  assert.deepEqual(
    checked.data?.checks.map((c) => c.id),
    [...M1_REQUIRED_CHECKS],
  );
  assert.equal(
    checked.data?.sourceIdentity?.sha256,
    (await sourceFingerprint(root)).sha256,
  );
  await assert.rejects(lstat(path.join(root, ".git")), { code: "ENOENT" });
  const packed = await packRelease({ projectRoot: root });
  assert.equal(packed.status, "succeeded", JSON.stringify(packed));
  assert.equal(packed.data?.directory, `release/v${M1_FIXTURE_VERSION}`);
  const directory = path.join(root, packed.data!.directory);
  const prefix = `threecat-${M1_FIXTURE_VERSION}`;
  const source = unzip(
    await readFile(path.join(directory, `${prefix}-source.zip`)),
  );
  assert.ok([...source.keys()].every((name) => name.startsWith(`${prefix}/`)));
  assert.ok(source.has(`${prefix}/evidence/m1/acceptance.json`));
  assert.ok(source.has(`${prefix}/packages/shared/src/index.ts`));
  const dist = unzip(
    await readFile(path.join(directory, `${prefix}-dist.zip`)),
  );
  assert.match(dist.get("index.html")!.toString(), /assets\/main.js/);
  assert.ok(!dist.get("index.html")!.toString().includes("wrong nested build"));
  const manifest: ReleaseManifest = await readJson(
    directory,
    `${prefix}-manifest.json`,
  );
  assert.equal(manifest.engineVersion, M1_FIXTURE_VERSION);
  assert.equal(manifest.milestone, "M1");
  assert.equal(manifest.scope, "runtime-foundation");
  assert.equal(manifest.prerelease, true);
  for (const archive of manifest.archives) {
    const bytes = await readFile(path.join(directory, archive.path));
    assert.equal(sha(bytes), archive.sha256);
    const entries = unzip(bytes);
    for (const entry of archive.entries) {
      const content = entries.get(entry.path)!;
      assert.ok(content);
      assert.equal(content.length, entry.bytes);
      assert.equal(sha(content), entry.sha256);
    }
  }
  const evidence = await readJson(directory, `${prefix}-evidence.json`);
  assert.equal(evidence.engineVersion, M1_FIXTURE_VERSION);
  assert.equal(
    evidence.sourceIdentity.sha256,
    checked.data!.sourceIdentity!.sha256,
  );
  assert.ok(evidence.evidenceFiles.length > 0);
  assert.ok(
    evidence.evidenceFiles.every((f: { path: string }) =>
      f.path.startsWith("evidence/m1/"),
    ),
  );
  const notes = await readFile(
    path.join(directory, "RELEASE_NOTES.md"),
    "utf8",
  );
  assert.match(notes, /M1 runtime-foundation/);
  assert.match(notes, /not a complete game engine/);
  assert.ok(!notes.includes("M0 risk prototypes"));
  const sums = await readFile(path.join(directory, "SHA256SUMS"), "utf8");
  for (const line of sums.trim().split("\n")) {
    const [expected, name] = line.split("  ");
    assert.equal(sha(await readFile(path.join(directory, name!))), expected);
  }
  hasCode(await packRelease({ projectRoot: root }), "TCREL_OUTPUT_EXISTS");
});

test("M1 refuses to replace missing or empty root dist with nested builds", async () => {
  const root = await m1Fixture();
  await put(root, "examples/game/dist/index.html", "nested build");
  await rm(path.join(root, "dist/index.html"));
  await refreshIdentity(root);
  hasCode(await packRelease({ projectRoot: root }), "TCREL_DIST");
  await put(root, "dist/index.html", "");
  hasCode(await checkRelease({ projectRoot: root }), "TCREL_DIST");
});

test("future milestones need explicit scopes and implemented profiles; M8 cannot self-declare a full release", async () => {
  const root = await m1Fixture();
  const manifest = await readJson(root, "engine.manifest.json");
  for (let stage = 3; stage <= 8; stage++) {
    const milestone = `M${stage}`;
    await putJson(root, "engine.manifest.json", {
      ...manifest,
      milestone,
      releaseScope: undefined,
    });
    hasCode(await checkRelease({ projectRoot: root }), "TCREL_RELEASE_SCOPE");
    await putJson(root, "engine.manifest.json", {
      ...manifest,
      milestone,
      releaseScope: `phase-${stage}`,
      prerelease: false,
      capabilityGate: { status: "passed", allCapabilitiesPassed: true },
    });
    hasCode(await checkRelease({ projectRoot: root }), "TCREL_PROFILE");
    hasCode(await packRelease({ projectRoot: root }), "TCREL_PROFILE");
  }
  await putJson(root, "engine.manifest.json", { ...manifest, milestone: "M9" });
  hasCode(await checkRelease({ projectRoot: root }), "TCREL_MILESTONE");
  await assert.rejects(lstat(path.join(root, "release")), { code: "ENOENT" });
});

test("manifest version drives patch release names; a flag cannot promote M1 to a final release", async () => {
  const root = await m1Fixture();
  const version = "0.1.1-m1.2";
  for (const file of [
    "package.json",
    "package-lock.json",
    "engine.manifest.json",
  ]) {
    const data = await readJson(root, file);
    data.version = version;
    if (file === "package-lock.json") data.packages[""].version = version;
    if (file === "engine.manifest.json") data.prerelease = false;
    await putJson(root, file, data);
  }
  const report = await readJson(root, "evidence/m1/acceptance.json");
  await putJson(root, "evidence/m1/acceptance.json", {
    ...report,
    engineVersion: version,
  });
  await refreshIdentity(root);
  const result = await packRelease({ projectRoot: root });
  assert.equal(result.status, "succeeded", JSON.stringify(result));
  assert.equal(result.data?.engineVersion, version);
  assert.equal(result.data?.prerelease, true);
  assert.equal(result.data?.directory, `release/v${version}`);
  const directory = path.join(root, result.data!.directory);
  const source = unzip(
    await readFile(path.join(directory, `threecat-${version}-source.zip`)),
  );
  assert.ok(source.has(`threecat-${version}/engine.manifest.json`));
  const manifest = await readJson(
    directory,
    `threecat-${version}-manifest.json`,
  );
  assert.equal(manifest.prerelease, true);
});

const M2_FIXTURE_VERSION = "0.2.0-m2.0";
// File mapping mirrors verify-m2, especially text reports and shared compiler proof.
const M2_EVIDENCE: Record<string, string[]> = {
  environment: ["evidence/m2/environment.json"],
  typecheck: ["evidence/m2/typecheck.txt"],
  "unit-tests": ["evidence/m2/unit-tests.txt"],
  compiler: ["evidence/m2/compiler.json", "docs/api/index.json"],
  assets: ["evidence/m2/assets.json", "evidence/m2/asset-tests.txt"],
  physics: ["evidence/m2/physics-tests.txt"],
  runtime: ["evidence/m2/runtime-tests.txt"],
  "ui-prototype": [
    "evidence/m2/ui-prototype.json",
    "evidence/m2/ui-world-occluded.png",
    "evidence/m2/ui-composition.png",
    "evidence/m2/ui-focus-world.png",
  ],
  "dev-server": ["evidence/m2/compiler.json"],
  protocol: ["evidence/m2/protocol.json", "evidence/m2/control.png"],
  unattended: ["evidence/m2/unattended.json"],
  render: [
    "evidence/m2/render.json",
    "evidence/m2/journey.json",
    "evidence/m2/first-relic.png",
    "evidence/m2/all-relics.png",
    "evidence/m2/sanctuary.png",
  ],
  deploy: ["evidence/m2/deploy.json", "evidence/m2/dist.png"],
  "ai-workflow": ["evidence/m2/ai-workflow.json"],
  "source-freeze": ["evidence/m2/compiler.json"],
};
const M2_ASSET_NOTICES = {
  format: "threecat.asset-notices",
  version: 1,
  assets: [
    {
      id: "model",
      path: "assets/model.glb",
      license: "CC-BY-4.0",
      attribution: "Synthetic asset author; rule test only",
      source: "synthetic model",
    },
    {
      id: "chime",
      path: "assets/chime.wav",
      license: "MIT",
      source: "synthetic PCM",
    },
  ],
};
async function m2Fixture() {
  const root = await m1Fixture();
  for (const file of [
    "package.json",
    "package-lock.json",
    "engine.manifest.json",
  ]) {
    const data = await readJson(root, file);
    data.version = M2_FIXTURE_VERSION;
    if (file === "package-lock.json")
      data.packages[""].version = M2_FIXTURE_VERSION;
    if (file === "engine.manifest.json") {
      data.milestone = "M2";
      data.releaseScope = "playable-game-slice";
      data.prerelease = false; // A manifest flag cannot promote the milestone.
    }
    await putJson(root, file, data);
  }
  await put(
    root,
    "examples/m2/assets/model.glb",
    Buffer.from([0x67, 0x6c, 0x54, 0x46, 0, 1]),
  );
  await put(
    root,
    "examples/m2/assets/chime.wav",
    Buffer.from([0x52, 0x49, 0x46, 0x46, 0, 1]),
  );
  for (const file of new Set(Object.values(M2_EVIDENCE).flat())) {
    if (file.endsWith(".json")) await putJson(root, file, { fixture: true });
    else
      await put(
        root,
        file,
        "SYNTHETIC RULE TEST ONLY; not measured evidence.\n",
      );
  }
  await putJson(root, "evidence/m2/render.json", {
    fixture: true,
    passed: true,
    initial: await readJson(root, "evidence/m0/render.json"),
  });
  // Content follows actual verifier envelopes; no invented dev-server/source-freeze reports.
  await putJson(root, "evidence/m2/compiler.json", {
    format: "threecat.build-report",
    version: 1,
    success: true,
    engineVersion: M2_FIXTURE_VERSION,
    diagnostics: [],
    fixture: true,
  });
  await putJson(root, "evidence/m2/deploy.json", {
    passed: true,
    base: "/games/m2/",
    hooks: { control: "undefined", failure: "undefined" },
    score: "Relics 1 / 3   Hearts 3 / 3",
    errors: [],
    fixture: true,
  });
  await put(
    root,
    "dist/THREE-LICENSE.txt",
    "Synthetic Three.js license fixture; no dependency code bundled.",
  );
  await put(
    root,
    "dist/RAPIER-LICENSE.txt",
    "Synthetic Rapier license fixture; no dependency code bundled.",
  );
  await put(
    root,
    "dist/THIRDPARTY-NOTICES.txt",
    "Synthetic runtime notice; rule test only.\n" +
      JSON.stringify(M2_ASSET_NOTICES.assets),
  );
  await putJson(root, "dist/generated/asset-notices.json", M2_ASSET_NOTICES);
  await putJson(root, "evidence/m2/acceptance.json", {
    protocolVersion: "0.1.0",
    engineVersion: M2_FIXTURE_VERSION,
    milestone: "M2",
    scope: "playable-game-slice",
    status: "passed",
    checks: Object.entries(M2_EVIDENCE).map(([id, evidence]) => ({
      id,
      status: "passed",
      evidence,
    })),
    limitations: [
      "SYNTHETIC RULE TEST ONLY; not measured GPU or completed M2 evidence.",
      "M2 game slice is not a complete engine; M3-M8 capabilities remain incomplete.",
      "Textured GLB uses raster; full material hybrid/path tracing belongs to M3.",
      "Synthetic scope boundary carried unchanged from acceptance.",
    ],
  });
  await refreshIdentity(root, "m2");
  return root;
}

test("M2 gate profile stays aligned with the implemented verifier", async () => {
  const verifier = await readFile(
    path.resolve(import.meta.dirname, "../tools/verify-m2.ts"),
    "utf8",
  );
  const source = ts.createSourceFile(
    "verify-m2.ts",
    verifier,
    ts.ScriptTarget.Latest,
  );
  const actual: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "check" &&
      node.arguments[0] &&
      ts.isStringLiteral(node.arguments[0])
    )
      actual.push(node.arguments[0].text);
    ts.forEachChild(node, visit);
  };
  visit(source);
  assert.deepEqual(M2_REQUIRED_CHECKS, actual);
  assert.deepEqual(Object.keys(M2_EVIDENCE), actual);
});

test("M2 check and fixture pack use manifest version, game-slice scope and acceptance limitations", async () => {
  const root = await m2Fixture();
  const report = await readJson(root, "evidence/m2/acceptance.json");
  const checked = await checkRelease({ projectRoot: root });
  assert.equal(checked.status, "succeeded", JSON.stringify(checked));
  assert.equal(checked.taskId, "M2-release");
  assert.equal(checked.data!.scope, "playable-game-slice");
  assert.equal(checked.data!.prerelease, true);
  assert.deepEqual(
    checked.data!.checks.map((c) => c.id),
    M2_REQUIRED_CHECKS,
  );
  assert.deepEqual(checked.data!.limitations, report.limitations);
  assert.equal(
    checked.data!.sourceIdentity!.sha256,
    report.sourceIdentity.sha256,
  );
  await assert.rejects(lstat(path.join(root, "release")), { code: "ENOENT" });
  const packed = await packRelease({ projectRoot: root });
  assert.equal(packed.status, "succeeded", JSON.stringify(packed));
  assert.equal(packed.taskId, "M2-release");
  assert.equal(packed.data!.directory, `release/v${M2_FIXTURE_VERSION}`);
  const directory = path.join(root, packed.data!.directory),
    prefix = `threecat-${M2_FIXTURE_VERSION}`;
  const manifest: ReleaseManifest = await readJson(
    directory,
    `${prefix}-manifest.json`,
  );
  assert.equal(manifest.engineVersion, M2_FIXTURE_VERSION);
  assert.equal(manifest.milestone, "M2");
  assert.equal(manifest.scope, "playable-game-slice");
  assert.equal(manifest.prerelease, true);
  for (const archive of manifest.archives) {
    const bytes = await readFile(path.join(directory, archive.path));
    assert.equal(sha(bytes), archive.sha256);
    const entries = unzip(bytes);
    assert.equal(entries.size, archive.entries.length);
    for (const entry of archive.entries) {
      assert.equal(entries.get(entry.path)!.length, entry.bytes);
      assert.equal(sha(entries.get(entry.path)!), entry.sha256);
    }
  }
  const source = unzip(
    await readFile(path.join(directory, `${prefix}-source.zip`)),
  );
  for (const name of [
    "evidence/m2/acceptance.json",
    "examples/m2/assets/model.glb",
    "examples/m2/assets/chime.wav",
  ])
    assert.ok(source.has(`${prefix}/${name}`));
  const dist = unzip(
    await readFile(path.join(directory, `${prefix}-dist.zip`)),
  );
  for (const name of [
    "THREE-LICENSE.txt",
    "RAPIER-LICENSE.txt",
    "THIRDPARTY-NOTICES.txt",
    "generated/asset-notices.json",
  ])
    assert.deepEqual(
      dist.get(name),
      await readFile(path.join(root, "dist", name)),
    );
  const evidence = await readJson(directory, `${prefix}-evidence.json`);
  assert.deepEqual(evidence.limitations, report.limitations);
  assert.equal(evidence.sourceIdentity.sha256, report.sourceIdentity.sha256);
  assert.ok(evidence.evidenceFiles.length > 0);
  assert.ok(
    evidence.evidenceFiles.every((file: { path: string }) =>
      file.path.startsWith("evidence/m2/"),
    ),
  );
  const notes = await readFile(
    path.join(directory, "RELEASE_NOTES.md"),
    "utf8",
  );
  assert.match(notes, /M2 playable-game-slice/);
  assert.match(notes, /not a complete game engine/);
  assert.match(notes, /Textured GLB content currently uses raster/);
  assert.match(notes, /M3-M8 capabilities are not complete/);
  assert.doesNotMatch(notes, /M1 runtime-foundation|M1 foundation/);
  for (const limitation of report.limitations)
    assert.ok(notes.includes(limitation));
  for (const line of (
    await readFile(path.join(directory, "SHA256SUMS"), "utf8")
  )
    .trim()
    .split("\n")) {
    const [expected, name] = line.split("  ");
    assert.equal(sha(await readFile(path.join(directory, name!))), expected);
  }
  hasCode(await packRelease({ projectRoot: root }), "TCREL_OUTPUT_EXISTS");
});

test("M2 never substitutes M0/M1 acceptance or runtime-foundation scope", async () => {
  const root = await m2Fixture(),
    manifest = await readJson(root, "engine.manifest.json");
  for (const releaseScope of [
    undefined,
    "runtime-foundation",
    "risk-prototypes",
    "complete-engine",
  ]) {
    await putJson(root, "engine.manifest.json", { ...manifest, releaseScope });
    hasCode(await checkRelease({ projectRoot: root }), "TCREL_RELEASE_SCOPE");
    hasCode(await packRelease({ projectRoot: root }), "TCREL_RELEASE_SCOPE");
  }
  await putJson(root, "engine.manifest.json", manifest);
  const report = await readJson(root, "evidence/m2/acceptance.json");
  for (const change of [
    { scope: "runtime-foundation" },
    { scope: "complete-engine" },
    { milestone: "M1" },
  ]) {
    await putJson(root, "evidence/m2/acceptance.json", {
      ...report,
      ...change,
    });
    hasCode(
      await checkRelease({ projectRoot: root }),
      "TCREL_ACCEPTANCE_SCOPE",
    );
  }
  await rm(path.join(root, "evidence/m2/acceptance.json"));
  hasCode(
    await checkRelease({ projectRoot: root }),
    "TCREL_ACCEPTANCE_MISSING",
  );
  hasCode(await packRelease({ projectRoot: root }), "TCREL_ACCEPTANCE_MISSING");
  await assert.rejects(lstat(path.join(root, "release")), { code: "ENOENT" });
});

test("every M2 gate is mandatory and failed, skipped, pending, absent or duplicate status blocks release", async () => {
  const root = await m2Fixture(),
    report = await readJson(root, "evidence/m2/acceptance.json");
  for (const id of M2_REQUIRED_CHECKS) {
    await putJson(root, "evidence/m2/acceptance.json", {
      ...report,
      checks: report.checks.filter((c: { id: string }) => c.id !== id),
    });
    hasCode(await checkRelease({ projectRoot: root }), "TCREL_CHECKS");
    hasCode(await packRelease({ projectRoot: root }), "TCREL_CHECKS");
    for (const status of ["failed", "skipped", "pending", undefined]) {
      await putJson(root, "evidence/m2/acceptance.json", {
        ...report,
        checks: report.checks.map((c: { id: string }) =>
          c.id === id ? { ...c, status } : c,
        ),
      });
      hasCode(await checkRelease({ projectRoot: root }), "TCREL_CHECK_STATUS");
    }
  }
  await putJson(root, "evidence/m2/acceptance.json", {
    ...report,
    checks: [...report.checks, report.checks[0]],
  });
  hasCode(await checkRelease({ projectRoot: root }), "TCREL_CHECKS");
  await putJson(root, "evidence/m2/acceptance.json", {
    ...report,
    status: "failed",
  });
  hasCode(await checkRelease({ projectRoot: root }), "TCREL_ACCEPTANCE_STATUS");
  await assert.rejects(lstat(path.join(root, "release")), { code: "ENOENT" });
});

test("M2 needs current source identity and rejects stale executable, GLB and WAV bytes", async () => {
  const root = await m2Fixture(),
    report = await readJson(root, "evidence/m2/acceptance.json");
  for (const sourceIdentity of [undefined, {}, { sha256: "INVALID" }]) {
    await putJson(root, "evidence/m2/acceptance.json", {
      ...report,
      sourceIdentity,
    });
    hasCode(await checkRelease({ projectRoot: root }), "TCREL_SOURCE_IDENTITY");
  }
  await putJson(root, "evidence/m2/acceptance.json", {
    ...report,
    sourceIdentity: { sha256: "0".repeat(64) },
  });
  hasCode(await checkRelease({ projectRoot: root }), "TCREL_EVIDENCE_STALE");
  await putJson(root, "evidence/m2/acceptance.json", report);
  for (const name of [
    "packages/shared/src/index.ts",
    "examples/m2/assets/model.glb",
    "examples/m2/assets/chime.wav",
  ]) {
    const original = await readFile(path.join(root, name)),
      altered = Buffer.from(original);
    altered[altered.length - 1] = altered[altered.length - 1]! ^ 1;
    await put(root, name, altered);
    hasCode(await checkRelease({ projectRoot: root }), "TCREL_EVIDENCE_STALE");
    hasCode(await packRelease({ projectRoot: root }), "TCREL_EVIDENCE_STALE");
    await put(root, name, original);
    assert.equal(
      (await checkRelease({ projectRoot: root })).status,
      "succeeded",
    );
  }
  await assert.rejects(lstat(path.join(root, "release")), { code: "ENOENT" });
});

test("M2 package, both lock roots, manifest and acceptance versions cannot drift", async () => {
  const root = await m2Fixture();
  for (const file of [
    "package.json",
    "package-lock.json",
    "engine.manifest.json",
  ]) {
    const original = await readJson(root, file);
    await putJson(root, file, { ...original, version: "0.2.1-m2.0" });
    hasCode(await checkRelease({ projectRoot: root }), "TCREL_VERSION");
    await putJson(root, file, original);
  }
  const lock = await readJson(root, "package-lock.json");
  await putJson(root, "package-lock.json", {
    ...lock,
    packages: { "": { version: M1_FIXTURE_VERSION } },
  });
  hasCode(await checkRelease({ projectRoot: root }), "TCREL_VERSION");
  await putJson(root, "package-lock.json", lock);
  const report = await readJson(root, "evidence/m2/acceptance.json");
  for (const change of [
    { engineVersion: undefined },
    { engineVersion: M1_FIXTURE_VERSION },
    { version: M1_FIXTURE_VERSION },
  ]) {
    await putJson(root, "evidence/m2/acceptance.json", {
      ...report,
      ...change,
    });
    hasCode(await checkRelease({ projectRoot: root }), "TCREL_VERSION");
  }
});

test("M2 patch filenames remain manifest-driven and cannot be promoted by prerelease false", async () => {
  const root = await m2Fixture(),
    version = "0.2.7-m2.4";
  for (const file of [
    "package.json",
    "package-lock.json",
    "engine.manifest.json",
  ]) {
    const data = await readJson(root, file);
    data.version = version;
    if (file === "package-lock.json") data.packages[""].version = version;
    await putJson(root, file, data);
  }
  const report = await readJson(root, "evidence/m2/acceptance.json");
  await putJson(root, "evidence/m2/acceptance.json", {
    ...report,
    engineVersion: version,
  });
  await refreshIdentity(root, "m2");
  const result = await packRelease({ projectRoot: root });
  assert.equal(result.status, "succeeded", JSON.stringify(result));
  assert.equal(result.data!.directory, `release/v${version}`);
  assert.equal(result.data!.prerelease, true);
  const manifest = await readJson(root, result.data!.manifest);
  assert.equal(manifest.engineVersion, version);
  assert.equal(manifest.prerelease, true);
  assert.deepEqual(
    manifest.archives.map((a: { path: string }) => a.path),
    [`threecat-${version}-source.zip`, `threecat-${version}-dist.zip`],
  );
});

test("M2 rejects software adapters and render text that lacks actual WebGPU adapter fields", async () => {
  const root = await m2Fixture();
  for (const adapter of [
    { vendor: "fixture", isFallbackAdapter: true },
    { vendor: "Google", description: "SwiftShader", isFallbackAdapter: false },
    { vendor: "Mesa", description: "llvmpipe", isFallbackAdapter: false },
    { vendor: "Microsoft", description: "WARP", isFallbackAdapter: false },
    { vendor: "fixture", isFallbackAdapter: false, hardware: false },
  ]) {
    await putJson(root, "evidence/m2/render.json", {
      passed: true,
      initial: { backend: "WebGPUBackend", adapter },
    });
    hasCode(await checkRelease({ projectRoot: root }), "TCREL_GPU_SOFTWARE");
    hasCode(await packRelease({ projectRoot: root }), "TCREL_GPU_SOFTWARE");
  }
  for (const initial of [
    { passed: true },
    { backend: "WebGPUBackend", adapter: { vendor: "fixture" } },
    {
      backend: "WebGLBackend",
      adapter: { vendor: "fixture", isFallbackAdapter: false },
    },
  ]) {
    await putJson(root, "evidence/m2/render.json", { passed: true, initial });
    hasCode(await checkRelease({ projectRoot: root }), "TCREL_GPU_EVIDENCE");
  }
});

test("M2 evidence paths must exist, remain nonempty and cannot cite acceptance", async () => {
  const root = await m2Fixture(),
    report = await readJson(root, "evidence/m2/acceptance.json");
  for (const [evidence, code] of [
    [[], "TCREL_EVIDENCE_FILES"],
    [["evidence/m2/missing.json"], "TCREL_EVIDENCE_MISSING"],
    [["evidence/m2/acceptance.json"], "TCREL_EVIDENCE_FILES"],
    [["../outside.json"], "TCREL_PATH"],
  ] as const) {
    await putJson(root, "evidence/m2/acceptance.json", {
      ...report,
      checks: report.checks.map((c: { id: string }) =>
        c.id === "ai-workflow" ? { ...c, evidence } : c,
      ),
    });
    hasCode(await checkRelease({ projectRoot: root }), code);
  }
  await putJson(root, "evidence/m2/acceptance.json", report);
  for (const file of [
    "evidence/m2/typecheck.txt",
    "evidence/m2/physics-tests.txt",
    "evidence/m2/dist.png",
  ]) {
    const original = await readFile(path.join(root, file));
    await put(root, file, "");
    hasCode(
      await checkRelease({ projectRoot: root }),
      "TCREL_EVIDENCE_MISSING",
    );
    await rm(path.join(root, file));
    hasCode(await packRelease({ projectRoot: root }), "TCREL_EVIDENCE_MISSING");
    await put(root, file, original);
  }
});

test("M2 requires both dependency licenses and asset notices without creating replacements", async () => {
  const root = await m2Fixture();
  for (const [name, code] of [
    ["THREE-LICENSE.txt", "TCREL_LICENSE"],
    ["RAPIER-LICENSE.txt", "TCREL_LICENSE"],
    ["THIRDPARTY-NOTICES.txt", "TCREL_NOTICE"],
    ["generated/asset-notices.json", "TCREL_NOTICE"],
  ]) {
    const file = `dist/${name}`,
      original = await readFile(path.join(root, file));
    for (const content of ["", " \n\t"]) {
      await put(root, file, content);
      hasCode(await checkRelease({ projectRoot: root }), code!);
      hasCode(await packRelease({ projectRoot: root }), code!);
    }
    await rm(path.join(root, file));
    hasCode(await checkRelease({ projectRoot: root }), code!);
    hasCode(await packRelease({ projectRoot: root }), code!);
    await assert.rejects(lstat(path.join(root, file)), { code: "ENOENT" });
    await put(root, file, original);
  }
  await assert.rejects(lstat(path.join(root, "release")), { code: "ENOENT" });
});

test("M2 asset notice validation matches compiler format and retains nullable licenses", async () => {
  const root = await m2Fixture(),
    file = "dist/generated/asset-notices.json";
  for (const value of [
    {},
    { ...M2_ASSET_NOTICES, format: "wrong" },
    { ...M2_ASSET_NOTICES, version: 2 },
    { ...M2_ASSET_NOTICES, assets: {} },
    { ...M2_ASSET_NOTICES, assets: [null] },
    {
      ...M2_ASSET_NOTICES,
      assets: [{ id: "model", path: "assets/model.glb" }],
    },
    {
      ...M2_ASSET_NOTICES,
      assets: [{ id: "model", path: "assets/model.glb", license: " " }],
    },
    {
      ...M2_ASSET_NOTICES,
      assets: [{ ...M2_ASSET_NOTICES.assets[0], attribution: 42 }],
    },
  ]) {
    await putJson(root, file, value);
    hasCode(await checkRelease({ projectRoot: root }), "TCREL_NOTICE");
  }
  await put(root, file, "{broken");
  hasCode(await checkRelease({ projectRoot: root }), "TCREL_JSON");
  await putJson(root, file, {
    ...M2_ASSET_NOTICES,
    assets: [{ id: "unknown", path: "assets/unknown.glb", license: null }],
  });
  assert.equal((await checkRelease({ projectRoot: root })).status, "succeeded");
  await putJson(root, file, { ...M2_ASSET_NOTICES, assets: [] });
  assert.equal((await checkRelease({ projectRoot: root })).status, "succeeded");
});

test("M2 requires acceptance limitations, the supported protocol and a nonempty root dist", async () => {
  const root = await m2Fixture();
  const report = await readJson(root, "evidence/m2/acceptance.json");
  for (const limitations of [undefined, [], [" "], [42]]) {
    await putJson(root, "evidence/m2/acceptance.json", {
      ...report,
      limitations,
    });
    hasCode(await checkRelease({ projectRoot: root }), "TCREL_LIMITATIONS");
    hasCode(await packRelease({ projectRoot: root }), "TCREL_LIMITATIONS");
  }
  await putJson(root, "evidence/m2/acceptance.json", {
    ...report,
    protocolVersion: "9.0.0",
  });
  hasCode(await checkRelease({ projectRoot: root }), "TCREL_PROTOCOL");
  await putJson(root, "evidence/m2/acceptance.json", report);
  await put(root, "examples/game/dist/index.html", "wrong nested build");
  await refreshIdentity(root, "m2");
  await rm(path.join(root, "dist/index.html"));
  hasCode(await checkRelease({ projectRoot: root }), "TCREL_DIST");
  hasCode(await packRelease({ projectRoot: root }), "TCREL_DIST");
  await put(root, "dist/index.html", "");
  hasCode(await checkRelease({ projectRoot: root }), "TCREL_DIST");
  await assert.rejects(lstat(path.join(root, "release")), { code: "ENOENT" });
});

test("M2 archive retains negotiated compressed runtime files and rejects missing, stale or inconsistent encodings", async () => {
  const root = await m2Fixture();
  await put(
    root,
    "dist/assets/runtime.js",
    "const vertices=" + JSON.stringify("mesh ".repeat(2000)) + ";",
  );
  const report = await compressDist(path.join(root, "dist"));
  const entry = report.entries.find(
    (item) => item.path === "assets/runtime.js",
  )!;
  assert.ok(entry.encodings.gz);
  const original = await readFile(path.join(root, "dist/assets/runtime.js.gz"));
  const manifest = await readJson(root, "dist/compression-manifest.json");
  assert.equal((await checkRelease({ projectRoot: root })).status, "succeeded");
  await rm(path.join(root, "dist/assets/runtime.js.gz"));
  hasCode(await checkRelease({ projectRoot: root }), "TCREL_DIST_COMPRESSION");
  await put(root, "dist/assets/runtime.js.gz", original);
  await put(root, "dist/assets/runtime.js.gz", Buffer.from("bad gzip"));
  hasCode(await checkRelease({ projectRoot: root }), "TCREL_DIST_COMPRESSION");
  await put(root, "dist/assets/runtime.js.gz", original);
  const bad = structuredClone(manifest);
  bad.entries.find((item: any) => item.path === "assets/runtime.js").encodings
    .gz.bytes++;
  await putJson(root, "dist/compression-manifest.json", bad);
  hasCode(await checkRelease({ projectRoot: root }), "TCREL_DIST_COMPRESSION");
  await putJson(root, "dist/compression-manifest.json", manifest);
  const packed = await packRelease({ projectRoot: root });
  assert.equal(packed.status, "succeeded", JSON.stringify(packed));
  const archive = unzip(
    await readFile(
      path.join(
        root,
        packed.data!.directory,
        "threecat-" + M2_FIXTURE_VERSION + "-dist.zip",
      ),
    ),
  );
  const name =
    [...archive.keys()].find((file) =>
      file.endsWith("/assets/runtime.js.gz"),
    ) ?? [...archive.keys()].find((file) => file === "assets/runtime.js.gz");
  assert.ok(name);
  assert.deepEqual(
    gunzipSync(archive.get(name)!),
    await readFile(path.join(root, "dist/assets/runtime.js")),
  );
});
