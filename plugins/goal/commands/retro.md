---
description: Analyze the goal ledger and propose policy improvements
argument-hint: "[slug]"
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

Analyze the goal ledger's history and propose policy improvements — never
code changes, and never auto-applied.

The ledger speaks four events: `step-started`, `disposition`, `closed`, and
`correction`. `step-started` and `disposition` track one backlog item's
work; `closed` records a goal-level outcome (`done` or `abandoned`) and its
timing; `correction` is an accounting-style reversal appended after an
earlier `disposition` (or `closed`) line when the goal file was hand-edited
to fix a wrong value — it never rewrites history, it only supersedes it.

1. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/goal-companion.mjs" ledger [slug] --json`
   and `node "${CLAUDE_PLUGIN_ROOT}/scripts/goal-companion.mjs" status [slug] --json`.
   If either refuses (no goals, ambiguous slug), relay the refusal and the
   listed slugs verbatim and stop.
2. **The goal file wins.** The goal file is portable ground truth: when the
   ledger and the goal file disagree about an item's disposition, the goal
   file wins. A `correction` event supersedes the earlier `disposition`
   record it corrects — read the ledger in order and apply every
   `correction` before computing any grouping, rate, or attribution. Never
   compute attribution (which `delegate` actually did the work) from the raw
   first write when a later `correction` exists for that field.
3. **Honesty floor.** Count the ledger's `disposition` events. If there are
   fewer than 5, say the ledger is too thin for conclusions and stop — no
   vibes-based findings, no partial proposal.
4. Cross-reference every recorded PR number against reality: `git log` and
   `gh pr view <n>` (or `gh pr list`) for the branch/merge history — a
   disposition of `merged` whose PR number the repo does not actually show
   merged is itself a finding.
5. Analyze the ledger, using corrected values throughout:
   - Dispositions grouped by `delegate` (codex / cursor / none) — merge rate,
     block rate.
   - Elapsed time between each item's `step-started` event and its matching
     `disposition` event.
   - Goal-level outcomes and their timing: each goal's `closed` event
     (`done` or `abandoned`) and the elapsed time from its first
     `step-started` to that `closed` event.
   - How often refine-and-redelegate-once actually fired (a `blocked`
     disposition that followed a retry, versus one that fired on the first
     attempt).
   - What caused each `blocked` disposition — read the `notes`.
6. Write the proposal, citing the specific ledger entries behind each claim.

## Hard rules

- **Policy artifacts only.** A proposal may change policy artifacts only:
  skill wording, routing guidance, effort tiers, budgets. It never touches
  code or the companion itself, and it lands as a reviewable PR; it is never
  auto-applied.
- **Honesty floor.** Fewer than 5 disposition events in the ledger means the
  ledger is too thin for conclusions. Say so and stop instead of guessing.
- **The goal file wins.** A `correction` event supersedes the `disposition`
  (or `closed`) record it corrects; compute every conclusion from corrected
  values, never from a superseded raw write.
