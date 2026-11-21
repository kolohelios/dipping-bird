# Dipping Bird

An opt-in Pi continuation extension for **jj workspaces**, not plain Git.
This is a community package, not an official Pi-maintained extension.
The first release is not published yet. Tested SDK: Pi 1.5.2; Node.js 22.19+.

From this checkout, run `pi install ./`, then `/reload` inside Pi.
Use `/bird start [goal]`, `/bird status`, and `/bird stop`.
No-goal restart preserves the original limits; an explicit goal starts a new
supervision window, not new permission. Limits: 60 automatic continuations or
two elapsed hours, checked between runs rather than preempting an in-flight tool.
Bird pins the real directory and jj change; identity failure pauses supervision.
Escape, stop/pause, reload, and tree navigation cannot automatically resume it.
Checkpoint completion means evidence reported for review, not certification.
Bird stores goals, workspace pins, and checkpoints in Pi session history; keep
sensitive data out of them. Control normalization is not secret redaction.

## Development

```sh
nix develop
just install
just validate
just compat
```

These run typing, lint, formatting, per-file coverage, package assembly, and real
Shaka repository gates. `shaka build` is a stub, so npm performs assembly.
The Shaka policy and native main ruleset are desired configuration, not proof of
live enforcement. Native rules require PRs, resolved threads, and strict matrix
checks without bypasses. Shaka's branch-protection fixer clears PR requirements;
do not use it to overwrite stronger live settings. Hosted CI must be observed.

Licensed under [MIT](LICENSE-MIT) OR [Apache-2.0](LICENSE-APACHE), at your option.
