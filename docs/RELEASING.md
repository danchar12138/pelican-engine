# Releases

Pelican Engine has one npm package, `pelican-engine`, and one public import. The package version is a standard stable semantic version with no milestone suffix. The active version line maps the historical phase number to SemVer: M3 uses `0.3.x`, M4 uses `0.4.x`, and so on; `1.0.0` is the final stable line. Keep the versions in `package.json`, `package-lock.json`, `engine.manifest.json`, `packages/compiler/package.json`, `packages/sdk/src/index.ts`, and checked-in project locks consistent.

## Continuous npm publishing

Every push to `main` triggers `.github/workflows/npm-publish.yml`. GitHub Actions builds the game distribution and npm tarball, then publishes the exact repository version to npm's `latest` dist-tag using OIDC Trusted Publishing. The separate build-and-pack workflow runs for pull requests and manual dispatch, not for main pushes, so the release does not duplicate that build. The publishing workflow uses the npm dependency cache. The workflow does not generate or alter the version and does not require a long-lived npm token. Configure the npm trusted publisher to match GitHub owner `danchar12138`, repository `pelican-engine`, workflow `npm-publish.yml`, with no GitHub environment unless the workflow is deliberately updated to use one.

For each substantial release batch:

1. Increment the standard version consistently across the files listed above. Never reuse a version already published to npm or an existing release tag; these identities are immutable. If the intended version is occupied, use the next unoccupied patch version in the same minor line (D59).
2. Keep changes focused in the single `main` worktree. Related features and fixes may have separate Chinese Conventional Commits, accumulated locally until a substantial minor-version batch is ready.
3. Push `main` and inspect the Actions publish result. A failed workflow can occur after npm accepts a package, so do not infer registry state from the failure. Under the current build-only policy, registry verification is not run; report an uncertain outcome as uncertain. The publishing command itself rejects an already-published version instead of silently skipping it. Never overwrite a version; use a new one for the next release batch.

GitHub Releases are separate milestone announcements. They do not trigger npm publishing. Assets may be prepared after the allowed build with `node --import tsx tools/release.ts pack --compile-only-unverified`; this inventory does not establish runtime correctness or acceptance. Publish notes must state what was built and what remains unverified.

## Verification and claims

The current project decision allows compilation/build only. Do not run or write tests, or run browsers, GPU, performance, install smoke, registry verification, or other validation unless the user changes that decision. A successful npm publish confirms package publication, not runtime behavior, hardware support, graphics quality, performance, or complete engine capability.

Do not overwrite tags, releases, or npm versions. Preserve historical releases and evidence with their original identities. Historical release profiles in `tools/release.ts` remain for their original records; new package versions use standard semantic versions.
