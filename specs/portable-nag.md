# Portable reminders and agent controls

Port Scott Parish's reminder workflow and agent controls alongside supervised
Bird. Both modes remain opt-in and share one extension and status slot.

## Contracts

- `/nag <prompt>`, `/bird nag <prompt>`, and the `nag` tool share session state.
  Support on, set, off, and status. Session/lifecycle restoration leaves Nag off.
  Enabling doesn't
  launch a turn; a successful idle boundary may request the next reminder.
- Nag has no jj requirement, evidence report, or automatic turn/time cap. State
  retains its prompt and projection count when off and resets count on enable.
  Agent instructions require stopping before completion or asking for input.
- `/nag off` preserves current work and queues. Escape disables reminders, and
  provider errors don't request another turn. Explicit user stops cannot be
  bypassed by agent tools before fresh user input.
- Supervised Bird retains its jj pin, original budget, checkpoint format, and
  startup receipt protections. The `bird` tool can start a first window during
  the current authorized turn, resume remaining limits, pause, and inspect.
  Agent tools cannot replace a saved window or switch modes after a stop or
  refused resume until matching fresh human input reaches the conversation.
- Reminders yield to native user queues and other boundary continuations.
  Custom-message producers must synchronously claim `bird:yield-to-input` while
  their work is pending; those queues aren't exposed by Pi's public counter.
  No dependency on external inbox CLIs or private integrations is introduced.
- Recheck priority before projecting a pending reminder. Suppressed prompts stay
  out of future model context and compaction and don't increment the count.
  Count means context projection, not confirmed provider delivery.
- A projected reminder may append timestamp, session path, and entry ID to a
  private `.nags` sidecar beside the session file, without prompt contents.

## Verification and delivery

Keep every existing validation gate and at least 90% coverage per runtime file.
Exercise state transitions, mode exclusion, stop/abort races, late queue claims,
sidecar contents, and the actual Pi loader/session with an offline provider.
Preserve the documented SDK cancellation limitations rather than claiming a
host-level fix. Credit Scott Parish (@srp) in the README.

Create a public PR only. Don't merge, publish npm packages, activate local
extensions, or modify the Home Manager checkout.
