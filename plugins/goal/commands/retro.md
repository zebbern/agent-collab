---
description: Analyze the goal ledger and propose policy improvements
argument-hint: "[slug]"
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

Analyze the goal ledger's history and propose policy improvements — never
code changes, and never auto-applied.

1. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/goal-companion.mjs" ledger [slug] --json`
   and `node "${CLAUDE_PLUGIN_ROOT}/scripts/goal-companion.mjs" status [slug] --json`.
   If either refuses (no goals, ambiguous slug), relay the refusal and the
   listed slugs verbatim and stop.
2. **Honesty floor.** Count the ledger's `disposition` events. If there are
   fewer than 5, say the ledger is too thin for conclusions and stop — no
   vibes-based findings, no partial proposal.
3. Cross-reference every recorded PR number against reality: `git log` and
   `gh pr view <n>` (or `gh pr list`) for the branch/merge history — a
   disposition of `merged` whose PR number the repo does not actually show
   merged is itself a finding.
4. Analyze the ledger:
   - Dispositions grouped by `delegate` (codex / cursor / none) — merge rate,
     block rate.
   - Elapsed time between each item's `step-started` event and its matching
     `disposition` event.
   - How often refine-and-redelegate-once actually fired (a `blocked`
     disposition that followed a retry, versus one that fired on the first
     attempt).
   - What caused each `blocked` disposition — read the `notes`.
5. Write the proposal, citing the specific ledger entries behind each claim.

## Hard rules

- **Policy artifacts only.** A proposal may change policy artifacts only:
  skill wording, routing guidance, effort tiers, budgets. It never touches
  code or the companion itself, and it lands as a reviewable PR; it is never
  auto-applied.
- **Honesty floor.** Fewer than 5 disposition events in the ledger means the
  ledger is too thin for conclusions. Say so and stop instead of guessing.
