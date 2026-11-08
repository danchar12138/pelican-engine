import test from "node:test";
import assert from "node:assert/strict";
import { releaseNotes, syncGitHubRelease } from "./github-release.ts";

const commit = "a".repeat(40),
  version = "1.4.0";
test("release notes select only the exact version and describe npm as the install channel", () => {
  const notes = releaseNotes(
    "# Changelog\n\n## 1.4.0\n\n- New guide.\n\n## 1.3.0\n\n- Old.\n",
    version,
    commit,
  );
  assert.match(notes, /New guide/);
  assert.doesNotMatch(notes, /Old\./);
  assert.match(notes, /pelican-engine@1\.4\.0/);
  assert.match(notes, new RegExp(commit));
  assert.throws(
    () => releaseNotes("## 1.4.0\n", version, commit),
    /TC_RELEASE_NOTES/,
  );
  assert.throws(
    () => releaseNotes("## 1.40.0\n- no", version, commit),
    /TC_RELEASE_NOTES/,
  );
});

test("GitHub synchronization creates a pinned release only, with explicit latest policy", async () => {
  const calls: { path: string; method: string; body: any }[] = [];
  let created = false;
  const fetcher: typeof fetch = async (url, init) => {
    const pathname = new URL(String(url)).pathname;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ path: pathname, method: init?.method ?? "GET", body });
    if (pathname.includes("git/ref/"))
      return created
        ? Response.json({ object: { type: "commit", sha: commit } })
        : new Response(null, { status: 404 });
    if (pathname.includes("releases/tags/"))
      return new Response(null, { status: 404 });
    created = true;
    return Response.json({
      html_url: "https://github.com/owner/repo/releases/tag/v1.4.0",
    });
  };
  const result = await syncGitHubRelease({
    repository: "owner/repo",
    token: "test",
    version,
    commit,
    notes: "notes",
    fetcher,
    historical: true,
  });
  assert.equal(result.status, "succeeded");
  const write = calls.find((call) => call.method === "POST")!;
  assert.equal(write.body.target_commitish, commit);
  assert.equal(write.body.make_latest, "false");
  assert.equal(write.body.tag_name, "v1.4.0");
});

test("existing annotated tags are checked and releases update idempotently without tag movement", async () => {
  let writes = 0;
  const fetcher: typeof fetch = async (url, init) => {
    const endpoint = String(url);
    if (endpoint.includes("git/ref/"))
      return Response.json({ object: { type: "tag", sha: "b".repeat(40) } });
    if (endpoint.includes("git/tags/"))
      return Response.json({ object: { type: "commit", sha: commit } });
    if (endpoint.includes("releases/tags/"))
      return Response.json({
        id: 5,
        tag_name: "v1.4.0",
        draft: false,
        prerelease: false,
      });
    assert.equal(init?.method, "PATCH");
    writes++;
    return Response.json({
      html_url: "https://github.com/owner/repo/releases/tag/v1.4.0",
    });
  };
  const result = await syncGitHubRelease({
    repository: "owner/repo",
    token: "test",
    version,
    commit,
    notes: "notes",
    fetcher,
  });
  assert.equal(result.updated, true);
  assert.equal(writes, 1);
  const wrong: typeof fetch = async () =>
    Response.json({ object: { type: "commit", sha: "c".repeat(40) } });
  await assert.rejects(
    syncGitHubRelease({
      repository: "owner/repo",
      token: "test",
      version,
      commit,
      notes: "notes",
      fetcher: wrong,
    }),
    /TC_RELEASE_TAG_MISMATCH/,
  );
  const forbidden: typeof fetch = async () =>
    new Response(null, { status: 403 });
  await assert.rejects(
    syncGitHubRelease({
      repository: "owner/repo",
      token: "test",
      version,
      commit,
      notes: "notes",
      fetcher: forbidden,
    }),
    /TC_RELEASE_GITHUB/,
  );
});
