# Dipping Bird

An opt-in Pi extension that keeps an authorized task moving until the agent
reports completion, a blocker, or a pause. Works in **jj workspaces**; plain Git
repositories are not supported.

This is a community package, not an official Pi-maintained extension. The first
release is being prepared; the repository and npm package are not published yet.

## Use

Requires Pi 1.5.2 (the tested SDK), Node.js 22.19+ and `jj` on Pi's PATH.
From a local checkout:

```sh
pi install ./
```

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

## Limits and safety

- At most **60 automatic continuations** or **two elapsed hours**, checked
  between runs. An in-flight tool is not forcibly preempted by these caps.
- Pins the real working directory and eight-character jj change ID. Identity
  checks use read-only `jj --ignore-working-copy log`, with a five-second timeout.
  Bird never switches directories or changes VCS state.
- Escape/aborted runs, `/bird stop`, and plain `stop` or `pause` input pause Bird.
- Reload, resume, fork, and tree navigation restore saved state **paused**.
  Compaction preserves the current supervision window.
- `bird_checkpoint` lets the model report `continue`, `blocked`, `pause`, or
  `complete`. Completion requires evidence references and means **completion
  reported for review**, not independent certification.
- Bird controls its own continuations, not other extensions or manual prompts.
  It does not enforce permissions on tools or verify evidence contents.

Starting Bird can incur additional model costs. It grants no new file, network,
credential, deployment, or publication authority. Existing approval gates remain
in force. The continuation prompt also forbids Git use, creating changes/commits/
workspaces/PRs, and spawning helper agents while Bird supervises the task.

## Privacy

Bird makes no direct network/model calls, reads no credentials, and starts no
background services or timers. It stores its goal, workspace/change pin, limits,
and checkpoint summaries/references as custom entries in Pi's session history.
Do not put secrets or raw sensitive output in goals or checkpoints. Control
characters are normalized; that is **not** secret redaction.

## Development

```sh
npm ci --ignore-scripts
just typecheck
just lint
just format-check
just test
```

Tests use Node's test runner. Core/state and lifecycle tests use a fake Pi host;
loader/package smoke tests use the real pinned Pi SDK without model requests.
The coverage gate measures all extension source, including unimported files.

See [the release plan](specs/public-release.md) for acceptance criteria.
