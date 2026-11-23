# Dipping Bird

An opt-in Pi extension that keeps an authorized task moving until the agent
reports completion, a blocker, or a pause. Works in **jj workspaces**; plain Git
repositories are not supported.

This is a community package, not an official Pi-maintained extension.

## Use

Tested with Pi 1.5.2. Requires Node.js 22.19+ and `jj` on Pi's PATH.
Install from npm:

```sh
pi install npm:@kolohelios/dipping-bird
```

For local development, use `pi install ./` from a checkout.

In Pi:

```text
/reload
/bird start Finish the current task against its existing acceptance criteria.
/bird status
/bird stop
```

`/bird start` uses the current conversation's task on first start; after that it
resumes the saved goal with the **remaining original limits**. Supplying a new
goal explicitly starts a new supervision window, not a new permission grant.

When upgrading from `0.1.4` or earlier, quit Pi before updating and start a new
process afterward. Old in-flight startups have no receipts to recover on reload.

## Limits and safety

- At most **60 automatic continuations** or **two elapsed hours**, checked
  between runs. An in-flight tool is not forcibly preempted by these caps.
- Pins the real working directory and eight-character jj change ID. Identity
  checks use read-only `jj --ignore-working-copy log`, with a five-second timeout.
  Bird never switches directories or changes VCS state.
- Escape/aborted runs pause active supervision. Use `/bird stop` to cancel a
  start still waiting for jj; Pi's idle Escape handling does not cancel commands.
  Plain `stop` or `pause` input also pauses Bird.
- Reload, resume, fork, and tree navigation restore saved state **paused**.
  Issued-start receipts reject exact canceled prompts when delayed preflight
  finishes after reload completes. Compaction preserves the current window.
- `bird_checkpoint` lets the model report `continue`, `blocked`, `pause`, or
  `complete`. Completion requires evidence references and means **completion
  reported for review**, not independent certification.
- Bird controls its own continuations, not other extensions or manual prompts.
  It does not enforce permissions on tools or verify evidence contents.

Starting Bird can incur additional model costs. It grants no new file, network,
credential, deployment, or publication authority. Existing approval gates remain
in force. The continuation prompt also forbids Git use, creating changes/commits/
workspaces/PRs, and spawning helper agents while Bird supervises the task.

## Known SDK limitations

This is a partial cancellation fix for Pi 1.5.2. Preflight completing during
resource replacement, or input extensions transforming startup text, can still
let canceled work reach the model. An old preflight can also abort a newer
manual run because the SDK's abort is session-wide. Restart Pi to cancel a stuck
preflight rather than relying on reload. Host-level cancellation fixes remain
necessary before this change is ready for release.

## Privacy

Bird makes no direct network/model calls, reads no credentials, and starts no
background services or timers. It stores its goal, workspace/change pin, limits,
checkpoint summaries/references, and issued/consumed startup prompts as custom
entries in Pi's session history.
Do not put secrets or raw sensitive output in goals or checkpoints. Control
characters are normalized; that is **not** secret redaction.

## Development

Use the locked Nix dev shell (Linux or Apple Silicon macOS, not Intel macOS),
or let direnv load `.envrc`:

```sh
nix develop
just install
just typecheck
just lint
just format-check
just test
just build
just validate
just compat
```

Tests use Node's test runner. Core/state and lifecycle tests use a fake Pi host;
loader/package smoke tests use the real pinned Pi SDK. Reload regressions run
real SDK sessions with isolated credentials and a stub provider, without model
requests.
The coverage gate measures all extension source, including unimported files.
`just build` packs the release into `dist/`, installs it offline without peer or
dev dependencies, and verifies its manifest, contents, and Pi discovery. Only
`extensions/index.ts` is registered; the helper module is not a second extension.

`just validate` also runs Shaka's repository preflight/whitespace checks and
Nix checks. Shaka is pinned from FlakeHub in `flake.lock`. Its current
`shaka build` command is a stub and it has no TypeScript project kind, so the
actual package assembly is an explicit npm recipe—not a claimed Shaka build.
`repo-checks` initializes colocated jj metadata if needed for Shaka's tracked-file
checks. No branch, remote, or source checkout is switched.

GitHub Actions runs the same validation on Linux (Node 22 and 24) and macOS
(Node 24), with Nix binary caching and lockfile-keyed npm download caching.
CI uploads coverage reports and verified tarballs. Merges to `main` rerun every
validation lane, stamp the next patch version into the release tarball, publish
to npm, and create a Git tag/GitHub release. No version-bump commits or release
PRs are needed. See
[Publishing](https://github.com/kolohelios/dipping-bird/blob/main/docs/publishing.md)
for npm trusted-publisher setup, versioning policy, and recovery. Use
`just bump minor`, `just bump major`, or `just bump 0.3.0` to prepare a version
change for a normal PR; patch releases require no local bump command.

## Main branch protection

`.shaka/repo.cue` declares the desired merge policy and requires `Gate` plus all
three explicitly named matrix checks, up-to-date with `main`. Force pushes and
deletion of `main` are forbidden. Tests keep workflow names, Shaka policy, and
`.github/main-ruleset.json` aligned.

The native ruleset additionally requires a PR, resolved review conversations,
and rebase-only merges, with no bypass actors. It requires no approving review
because a single maintainer cannot approve their own PR. This still forbids
direct pushes once the ruleset is active.

**These files are desired policy, not live enforcement.** Before PR delivery,
confirm the remote owner/host, enable protection, and verify the actual main
rules and hosted CI checks. Live settings may drift independently of these files.
Shaka cannot currently represent the PR requirement; its branch-protection
`--fix` path clears required PR reviews. Do not use it as the complete setup
operation or overwrite stronger existing settings.

See [architecture](architecture.md) and [decisions](architecture-decision-record.md)
for lifecycle and tooling details.

## License

Licensed under [MIT](LICENSE-MIT) OR [Apache-2.0](LICENSE-APACHE), at your option.
