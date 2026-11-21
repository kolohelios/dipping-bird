# Dipping Bird architecture decisions

## Offer MIT or Apache-2.0 at the recipient's option

Use SPDX `MIT OR Apache-2.0` and ship both full license texts. The Apache text
comes from the [Apache Foundation](https://www.apache.org/licenses/LICENSE-2.0.txt),
with the copyright placeholder filled in. Package checks pin the normalized text
hashes so accidental clause edits cannot retain the same SPDX claim unnoticed.

## Declare main protection separately from applying it

Shaka's desired policy requires every matrix check and the aggregate `Gate`,
strictly up-to-date, and rejects force pushes and deletion. Native ruleset JSON
adds PR-only changes, resolved conversations, rebase merges, and no bypass
actors. No approving review is mandatory for a single-maintainer repository.
Tests compare these requirements with the actual workflow names.

Shaka's current branch-protection fixer clears required PR reviews and cannot
express the complete policy. Live configuration therefore needs separate,
authorized application and verification at the confirmed destination, preserving
any stronger existing protection. Local configuration alone is not enforcement.

## Keep the first release jj-only

The installed extension pins a jj change as well as the canonical working
directory. The extracted package preserves that contract rather than inventing
a Git equivalent during release preparation. This excludes plain Git workspaces
but keeps resume and drift behavior predictable.

## Separate supervision from permission and certification

Continuation requests can spend more model tokens but must not broaden task
authority. Bird therefore keeps permission boundaries in its prompt, treats
completion as a report for review, and restores paused state. It does not inspect
evidence artifacts or implement a tool permission gate. Stronger enforcement
would require a separate design and cannot be implied by installation.

## Use Shaka's real gates without pretending it builds TypeScript

The pinned Shaka binary provides repository preflight and whitespace checks.
Upstream has no TypeScript project kind, and `shaka build` is currently a stub.
The root Justfile therefore runs mandatory language checks, coverage, and package
assembly explicitly, alongside Shaka's repository checks. The hand-authored CI
workflow is accounted for in `.shaka/repo.cue` rather than masquerading as a
generated Rust project.

This costs a small language-specific build recipe. It avoids changing upstream
Shaka or silently accepting a no-op build as release verification. Both Nix tools
and npm dependencies are locked, and the workflow pins action revisions.
