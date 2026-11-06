# Releases

Pelican Engine has one npm package, `pelican-engine`, and one public import. The package version is a standard stable semantic version with no milestone suffix. Keep the versions in `package.json`, `package-lock.json`, `engine.manifest.json`, `packages/compiler/package.json`, `packages/sdk/src/index.ts`, and checked-in project locks consistent.

## Continuous npm publishing

Every push to `main` triggers `.github/workflows/npm-publish.yml`. GitHub Actions builds the game distribution and npm tarball, then publishes the exact repository version to npm's `latest` dist-tag using OIDC Trusted Publishing. The workflow does not generate or alter the version and does not require a long-lived npm token. Configure the npm trusted publisher to match GitHub owner `danchar12138`, repository `pelican-engine`, workflow `npm-publish.yml`, with no GitHub environment unless the workflow is deliberately updated to use one.

For each feature or fix release:

1. Increment the standard version consistently across the files listed above. Never reuse a version already published to npm; npm versions are immutable.
2. Keep the change focused in the single `main` worktree and commit it with a Chinese Conventional Commit message.
3. Push `main`. The resulting Actions run is the authoritative publish result. A failed build or publish means the version is not published; fix the cause and use a new version if npm already accepted it.

GitHub Releases are separate milestone announcements. They do not trigger npm publishing. Assets may be prepared after the allowed build with `node --import tsx tools/release.ts pack --compile-only-unverified`; this inventory does not establish runtime correctness or acceptance. Publish notes must state what was built and what remains unverified.

## Verification and claims

The current project decision allows compilation/build only. Do not run tests, browsers, GPU, performance, install smoke, registry verification, or other validation unless the user changes that decision. A successful npm publish confirms package publication, not runtime behavior, hardware support, graphics quality, performance, or complete engine capability.

Do not overwrite tags, releases, or npm versions. Preserve historical releases and evidence with their original identities. Historical release profiles in `tools/release.ts` remain for their original records; new package versions use standard semantic versions.
