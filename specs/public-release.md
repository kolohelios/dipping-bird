# Dipping Bird public release

## Intent

Publish the existing opt-in Pi continuation extension as a portable community
package owned by `kolohelios`. Keep the first release jj-only. Publication,
remote repository creation, and changes to the installed extension remain
separate approval steps.

## Behavior to preserve

Bird supervises the current session, not a helper agent. Loading is inert.
Only `/bird start [goal]` queues an initial prompt; arming waits for that exact
prompt and its verified directory/change identity. Stops, cancellation, failed
identity checks, and restoration must not revive automatic work. Completion
requires evidence references and means reported for human review, not certified.
The continuation and elapsed limits remain bounded; resume keeps their origin.
No prompt grants additional file, network, credential, or publication authority.

## Release boundary

Only the extension source, manifest, public documentation, changelog, and license
belong in the npm tarball. Do not include personal session history, backups,
corporate tasks, Nix store paths, development dependencies, or test fixtures.
Declare Pi-provided imports as peers rather than bundling a second Pi runtime.

## Commit plan and acceptance

1. Extract a portable package and repair the inherited test harness to model
   the initial-run handshake. Typecheck, lint, format, and existing tests pass
   with locked dependencies and no machine-local paths.
2. Add state-machine boundary, cancellation/race, and malformed-persistence
   regressions. Enforce at least 90% statements, branches, functions, and lines
   per runtime file, including files not imported by tests. Correct defects
   exposed by these tests in focused commits.
3. Add release-content and installed-package smoke checks through Pi's actual
   loader without model requests or global configuration changes.
4. Add pinned Shaka/Nix tooling and GitHub Actions with dependency caches and
   reports/artifacts. Local and CI checks use the same recipes. Checks run on
   every PR and main push; no automatic npm publication.

## Shaka integration

The current upstream `shaka build` command is a stub that prints `build`.
There is no TypeScript project kind. Use real `shaka preflight` and whitespace
checks for repository gates, with explicit package validation/assembly recipes;
do not mislabel the extension as Rust or claim the stub builds a package.
Keep this limitation visible until upstream supports the language directly.
