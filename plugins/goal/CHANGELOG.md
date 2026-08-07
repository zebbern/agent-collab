# Changelog

## 0.2.0

- Ledger corrections: dogfooding this plugin surfaced two dispositions
  recorded with a wrong `--delegate` value (claiming codex/cursor for work
  Claude subagents actually did). The goal file was hand-corrected, but the
  ledger is append-only with no way to fix the poisoned entries in place —
  `/goal:retro` would have read the wrong values as fact. `set` now loads
  whatever goal is on disk before overwriting it, diffs terminal backlog
  items present in both, and appends one `{ event: "correction", slug,
  itemId, field, from, to }` line per changed `status` /
  `disposition.delegate` / `disposition.pr` / `disposition.notes` — an
  accounting-style reversal, never a rewrite (long `notes` values are
  truncated to ~120 chars in the correction line). A first-time `set` with
  no prior goal on disk records no corrections. `close` now also appends a
  `{ event: "closed", slug, status }` line so goal-level outcomes (done /
  abandoned) live in the ledger, not only in git. `/goal:retro` is updated
  to treat the goal file as ground truth: a `correction` supersedes the
  `disposition` it corrects, and attribution must be computed from
  corrected values, never the raw first write.
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
