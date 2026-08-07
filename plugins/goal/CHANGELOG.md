# Changelog

## Unreleased

- Unattended-operation recipe documented in `/goal:step`: work happens on a
  `goal/<slug>/<itemId>` branch, an unattended step never merges PRs, and the
  next wake reconciles the PR (merged/closed/still-open) before stepping
  again. Trigger-level only — no scheduling surface ships in this plugin.
- Retrospective reader: `goal-companion.mjs ledger [slug] [--json]` exposes
  the raw ledger (read-only, works on any goal status) and `/goal:retro`
  analyzes it — dispositions by delegate, elapsed time per step, how often
  refine-and-redelegate-once fired, and what caused blocks — then proposes
  policy-artifact changes as a reviewable PR, never auto-applied. An honesty
  floor refuses to draw conclusions from fewer than 5 disposition events.

## 0.1.0

- Initial release: attended `/goal` loop. A schema-validated, git-tracked goal file (`.claude/goals/<slug>.json`) with a ranked backlog; deterministic next-increment selection; mechanical one-increment-at-a-time enforcement; dispositions recorded in the goal file and an append-only machine-local ledger; `check` runs command-kind acceptance criteria by exit code. Delegation happens through the codex/cursor delegation skills — this plugin spawns no workers of its own.
