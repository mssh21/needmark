# Releasing

[Documentation index](README.md) · [Testing](testing.md)

NeedMark is published to npm by GitHub Actions. Changing `version` in `package.json` on `main` is the release trigger.

## How a release runs

`.github/workflows/release.yml` runs on every push to `main`. When the `package.json` version is already on npm it stops without doing anything, so ordinary commits never publish. When the version is new it:

1. installs dependencies and runs `pnpm build`, `pnpm typecheck`, `pnpm test` and `pnpm test:package-managers`;
2. publishes with `npm publish` through npm trusted publishing, so no npm token is stored in GitHub and npm attaches a provenance attestation;
3. creates the Git tag and GitHub release `v<version>` with generated release notes.

The release workflow does not run E2E tests; the CI workflow runs them on every pull request and push to `main`.

## Making a release

1. On a branch, make sure `pnpm test:e2e` passes and user-facing changes were checked in the demo.
2. Bump the version without creating a tag, choosing the [semantic version](https://semver.org) step: `patch` for fixes, `minor` for backward-compatible features, `major` for breaking changes.

   ```sh
   pnpm version patch --no-git-tag-version
   ```

3. Commit it as `Release <version>` and merge it into `main`. Do not create the tag yourself; the workflow does.
4. After the workflow finishes, check the published package: `pnpm test:package-managers -- --spec=needmark@<version>`.

If the workflow fails before `npm publish`, fix the cause and push again; the same version is retried. A published version can never be published again, so a fix after publishing needs a new version.

## One-time npm setup

On npmjs.com, open the `needmark` package, then **Settings → Trusted publishing**, and add a GitHub Actions publisher:

| Field | Value |
| --- | --- |
| Organization or user | `mssh21` |
| Repository | `needmark` |
| Workflow filename | `release.yml` |
| Environment | empty |
| Allowed actions | include `npm publish` |

Under **Publishing access**, choose **Require two-factor authentication and disallow tokens**. Trusted publishing keeps working, while tokens can no longer publish.

To review every version before it becomes public, allow only staging for the trusted publisher and change the workflow's `npm publish` to `npm stage publish`. Each release then waits until a maintainer runs `npm stage approve <stage-id>` with two-factor authentication or approves it under **Staged Packages** on npmjs.com.
