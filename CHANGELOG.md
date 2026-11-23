# Changelog

## [Unreleased]

- Keep canceled or reload-paused startups rejected when delayed preflight
  finishes in a replacement extension runtime.
- Persist exact issued/consumed startup receipts without claiming unrelated
  pasted markers or later manual copies of consumed prompts.

## [0.1.0]

- Prepare the jj-only continuation extension as a portable Pi package.
- Preserve opt-in startup, bounded continuation, paused restoration, and
  evidence-bearing completion reports.
- Reject negative persisted start times and prevent settled or expired initial
  preflights from arming the loop.
