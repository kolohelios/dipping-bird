# Dipping Bird architecture

## Purpose and boundaries

Bird requests additional work in the current Pi session after a user explicitly
starts supervision. It does not run another agent, execute task tools, verify
acceptance evidence, or authorize operations. The user reviews completion.

## Components

```mermaid
flowchart LR
    U[User: /bird] --> S[Pi lifecycle adapter]
    S --> C[Pure state transitions]
    S --> J[Read-only jj identity]
    S --> H[Pi session entries]
    C --> S
    S --> P[Pi continuation boundary]
    P --> A[Current agent]
    A --> T[bird_checkpoint]
    T --> S
```

- `extensions/core.ts` owns immutable state transitions, input bounds, prompt
  text, budget checks, and parsing persisted state.
- `extensions/index.ts` registers `/bird`, `bird_checkpoint`, and Pi lifecycle
  handlers. Its revision counter discards stale asynchronous identity results.
- Pi owns message scheduling, tool permissions, model calls, and persistence.
  The manifest exposes only `extensions/index.ts` as an extension entry point.

## State and lifecycle

The `dipping-bird-v1` custom entry contains the goal, canonical directory, jj
change pin, original start time, continuation count, checkpoint, and mode.
Restoration reads only the active session branch and always yields paused state.
Malformed latest state clears earlier state rather than falling back to an older
armed window. Checkpoints are session data, not independent proof.

A start queues a nonce-bearing user prompt while Bird remains paused. Only the
exact prompt with a verified pin and remaining budget can arm at `agent_start`.
Stop, lifecycle replacement, and final settlement invalidate pending lookups.
`dipping-bird-start-v1` entries record each exact issued prompt and its consumption.
The active branch retains these receipts across extension reloads, unlike a
factory-local set. A receipt can reject a delayed prompt but cannot arm Bird.
Once consumed, it no longer claims a later manual copy of that prompt.
`agent_before_settle` appends its proposal after earlier extensions' entries;
it does not duplicate work when another continuation or message is pending.

`running`, `paused`, `blocked`, and `review` are the persisted modes. `review`
means completion reported. Blocked, paused, and review states require an explicit
user restart before Bird supervises further work. Compaction keeps the current
window; reload and tree navigation do not re-arm it.

## Operation

See [the README](README.md#limits-and-safety) for limits and operator commands.
Identity lookup fails closed on timeout, process failure, malformed output, or
pin drift. Elapsed limits are checked between runs and again when queued initial
work arms, not by an interrupting timer. Bird cannot preempt an in-flight tool
when its elapsed cap expires.

Builds ship TypeScript source. Pi supplies the peer imports. The package smoke
check installs the real tarball without peers or development dependencies and
loads it with the pinned SDK in an isolated agent directory. CI uses the same
validation recipes as local development. CI results and live protection must
be observed separately from the configuration committed here.
