# Changelog

## Unreleased

- One canonical ledger root, healed splits: the ledger state root no longer
  honors ambient `CLAUDE_PLUGIN_DATA`. Installed sessions export whichever
  plugin's data dir last set that var into every Bash environment (observed
  2026-08-07, the day the plugins were first really installed), so a single
  project's history silently split across roots — 9 pre-install dispositions
  were orphaned in the tmpdir fallback and the first portfolio retro honestly
  floor-refused against a 1-disposition shard. The root is now one stable
  per-user location (`~/.claude/goal-companion/`;
  `GOAL_COMPANION_STATE_ROOT` overrides it for test isolation only), and
  every ledger touch first consolidates legacy roots (tmpdir and the current
  environment's plugin-data dir, per project key) into the canonical file —
  merged by timestamp, corrupt lines preserved and still counted, each
  drained source left as a `.migrated` marker so nothing imports twice. A
  root-splitting regression guard pins that the state dir is identical
  across invocation contexts.
- Retro events and evaluate-prior-adoptions: `retro-record` appends a `retro`
  ledger event (scope, disposition count, floor verdict, optional proposal PR
  and findings count), and `/goal:retro` now requires evaluating prior
  adoptions before proposing new method changes — adopted method changes were
  previously unmeasurable, so successors could not tell whether a prior
  proposal helped, hurt, or should be reversed.

## 0.3.0

- The goal-runner skill gained a start-before-working rail from the first portfolio retrospective (PR #33): call start before any work on an increment begins, or the duration is untrustworthy and the retro discards it.
- The retrospective gained a portfolio scope: `ledger --all` pools every goal's events (each entry keeps its slug), and retro.md now runs at two scopes with distinct jobs and floors — per-goal is the process retro at close, portfolio is the policy retro whose 5-disposition floor counts machine-wide, with findings grouped by goal and the per-machine caveat mandatory. Explicit method-invention mandate: portfolio proposals may revise procedures (brief shapes, delegation patterns, retro.md's own analysis steps), not just parameters, each finding cited from disposition notes or merged PR bodies — the same policy-artifacts-only, never-auto-applied rails.

- Hardening pass on four items accepted as debt in the 0.2.0 review: (1)
  `ledger.mjs` now builds the sibling plugins' private-dir doctrine
  goal-locally — 0o700 root created recursively, the per-project leaf created
  non-recursively (so a pre-planted symlink or file fails instead of being
  followed), and, off win32, foreign-uid refusal plus tightening a loose mode
  back to 0o700; the state dir was previously documented as "default
  permissions, hardening is the known upgrade" — it is now built. (2)
  `args.mjs`'s `parseCommandInput` refuses any unrecognized `-`-prefixed
  token (e.g. a typo'd `-x`) instead of silently absorbing it as a
  positional; `-C` and bare `--` still pass through. (3) `goal-state.mjs`'s
  `validateGoal` now requires `createdAt`/`updatedAt`, when present, to be
  date-parseable strings, naming the exact field on failure. (4)
  `goal-companion.mjs`'s `check` renderer scopes the "its processes may
  still be running" caveat to details that actually indicate a timeout — a
  plain spawn failure (EACCES, ENOBUFS, ENOENT, …) no longer carries that
  claim.

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
