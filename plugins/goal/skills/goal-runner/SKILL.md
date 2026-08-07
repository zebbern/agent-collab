---
name: goal-runner
description: Use when the user asks to advance, continue, or work on the project's long-horizon goal (or to set one up) — the policy for goal-driven increments driven through the goal companion, one increment at a time, delegated via the codex/cursor delegation skills, honestly recorded.
---

# Goal Runner

The companion (`goal-companion.mjs`) owns state, selection, and dispositions;
you own judgment. Follow the `/goal:step` choreography exactly — never
reimplement its bookkeeping by editing the goal file ad hoc.

Policy:

- **One increment at a time.** `next` → `start` → execute → verify → PR →
  `record` → stop. The companion refuses a second in-progress item; do not
  work around the refusal.
- **Disclose.** Announce each increment (and each delegation) in one line.
- **Delegate with judgment.** Trivial work stays local. Deep analysis or a
  second opinion goes to Codex, fast parallel implementation to Cursor, via
  the `codex-delegation` / `cursor-delegation` skills. Analysis and
  implementation are separate delegations when both are needed.
- **Refine once.** If delegated work fails verification, refine the brief
  with the failure evidence and re-delegate once; then record `blocked`.
- **Blocked is a full stop.** A blocked item blocks the goal; `next` refuses
  until a human resolves it. Surface the reason; never guess past it.
- **Honest dispositions.** `merged` means the PR merged. Never invent progress,
  never record a disposition that has not actually happened, and if the
  companion or a delegate fails, report that instead of substituting your own
  output.
