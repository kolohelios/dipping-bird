# Releases on merge

Every push to `main` starts the `Publish` workflow
(`.github/workflows/publish.yml`). With PR-only protection enabled, merging a PR
is all you need to do. No Release Please, GitHub App, personal access token, or
release PR is required.

## One-time setup

The existing npm environment and trusted publisher are sufficient:

1. GitHub repository `kolohelios/dipping-bird` → Settings → Environments → `npm`:
   under deployment branches and tags, select **Selected branches and tags**,
   then add a **Branch** rule for `main`. Required environment reviewers are
   optional; omit them if you want fully unattended publication.
2. npm package `@kolohelios/dipping-bird` → Settings → Trusted publishing:
   - Owner: `kolohelios`
   - Repository: `dipping-bird`
   - Workflow filename: `publish.yml`
   - Environment: `npm`
   - Allow **npm publish**; standalone dist-tag permission is not required.
3. Prefer npm's publishing-access setting that requires 2FA and disallows token
   publishing, while retaining trusted publishing. No `NPM_TOKEN`,
   `NODE_AUTH_TOKEN`, App key, or additional GitHub secret is needed.

GitHub provides the short-lived token used to create the release tag and GitHub
release. npm uses OIDC (`id-token: write`) and publishes with provenance from a
GitHub-hosted Ubuntu runner. Keep the Nix toolchain at npm 11.5.1+ and Node 22.14+
when updating it; the current shell supplies Node 24 and a compatible npm.

## What happens on merge

1. All three CI lanes run through the reusable CI workflow: Linux/Node 22,
   Linux/Node 24, and macOS/Node 24. Every lane and the aggregate gate must pass.
2. The release job reads the public npm registry and chooses the next patch
   after the greatest stable published version: `0.1.0` → `0.1.1` → `0.1.2`.
   This applies to all merged changes, including docs and chores. Conventional
   Commit types do not affect the automatic bump.
3. It stamps that version into `package.json` and both lockfile version fields
   **in the disposable CI checkout only**, with an `x-release-commit` marker.
4. It assembles the tarball, installs it offline without peer/dev dependencies,
   and tests discovery through Pi's real loader. It publishes that verified
   tarball publicly to npm with the `latest` tag and provenance.
5. After confirming npm has accepted the version and source commit, it creates
   a `vX.Y.Z` tag pointing at the workflow commit and a GitHub release with
   automatically generated PR-based release notes.

**npm and release tags are the released-version ledger.** CI does not commit
version bumps back to `main`, bypass branch protection, or alter source history.
The checked-in manifest stays at its baseline, so local-checkout builds retain
that baseline version. `CHANGELOG.md` is not rewritten by CI; ongoing release
notes are on GitHub.

### Minor and major bumps

In the dev shell, use the Just recipe instead of calculating from the checkout's
potentially stale baseline:

```sh
just bump minor   # e.g. published 0.1.37 -> prepare 0.2.0
just bump major   # e.g. published 0.1.37 -> prepare 1.0.0
# Or choose an exact stable version:
just bump 0.3.0
```

Choose one command, review the changes to `package.json` and `package-lock.json`,
and include them in your normal PR. The command reads npm's greatest stable
published version, updates both manifests, and leaves dependencies alone. It
never publishes, creates a tag, or commits. No npm login is required. Invalid or
already-published targets, inconsistent manifests, registry errors, and lowering
an already-pending source version are rejected without changing the files.

The next merge uses the prepared version if it still exceeds every published
version; subsequent releases resume patch bumps. Recheck the target if other
releases happen before your PR merges. Patch bumps need no command—they are
already automatic.

Releases are serialized and never cancel an in-progress publication. GitHub
concurrency can replace pending runs during a burst of merges, so intermediate
commits may be coalesced into the next release. An older queued run is refused
if a newer or unrelated commit has already been published. Each release uses
its immutable workflow SHA, not a later moving `main` checkout.

## Verify or retry

Inspect the **Publish** workflow after merging. Approve the `npm` environment
if required, then verify:

```sh
npm view @kolohelios/dipping-bird version dist-tags dist.attestations --json
pi install npm:@kolohelios/dipping-bird
```

For transient failures, rerun the original failed workflow/jobs to preserve the
same source commit. A manual run on `main` is also available:

```sh
gh workflow run publish.yml --ref main
```

The script recognizes already-published commits by their immutable npm metadata.
Retries skip npm publication and finish creating the same tag/GitHub release,
without another version bump or resetting `latest`. Existing tags are verified
against the source SHA and never moved. After publishing, confirmation tolerates
npm propagation 404s for up to two minutes before failing; a wrong source marker
or another API error fails immediately. Errors include the failed endpoint and
HTTP status without credentials. Rerun after a longer outage or propagation
delay rather than guessing a version. Do not publish manually in parallel with CI, as external publishers do
not share the workflow's serialization.

If `main` has advanced, a manual dispatch releases the new commit, not the old
one. Use the original workflow run to recover a missing GitHub release for an
older publication. Never unpublish merely to retry or attempt to overwrite a
version. Any correction to published contents needs another merge and release.
