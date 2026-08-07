---
description: Analyze the goal ledger and propose policy improvements
argument-hint: "[slug|--all]"
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

## Two scopes, two jobs

A retrospective runs at one of two scopes, and the scope decides what it may
conclude:

- **Per-goal** (`retro <slug>`) is a **process retro**: how did this body of
  work go — blocked causes, whether the rails held, duration fidelity,
  goal-file hygiene. Run it when a goal closes. Its honesty floor counts the
  dispositions **within that goal**.
- **Portfolio** (`retro --all`) is the **policy retro** — the outer loop.
  Routing guidance, profiles, budgets, and the methods themselves are
  project-wide artifacts, so the evidence for changing them must be the
  pooled, project-wide ledger. Its honesty floor counts dispositions
  **across every goal**. The report MUST group findings by goal so
  task-type heterogeneity stays visible (a docs goal and a concurrency goal
  are not the same evidence), and it MUST state that the ledger is
  per-project and per-machine — this is this machine's history, not the
  project's whole truth.

A per-goal retro whose goal clears its own floor may still only propose
goal-local hygiene unless the portfolio floor is also met — global artifacts
change on global evidence.

1. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/goal-companion.mjs" ledger [slug|--all] --json`
   and, for a per-goal run, `node "${CLAUDE_PLUGIN_ROOT}/scripts/goal-companion.mjs" status [slug] --json`.
   If either refuses (no goals, ambiguous slug), relay the refusal and the
   listed slugs verbatim and stop.
2. **The goal file wins.** The goal file is portable ground truth: when the
   ledger and the goal file disagree about an item's disposition, the goal
   file wins. A `correction` event supersedes the earlier `disposition`
   record it corrects — read the ledger in order and apply every
   `correction` before computing any grouping, rate, or attribution. Never
   compute attribution (which `delegate` actually did the work) from the raw
   first write when a later `correction` exists for that field.
3. **Honesty floor.** Count the ledger's `disposition` events at the scope
   you are running. If there are fewer than 5, say the ledger is too thin
   for conclusions and stop — no vibes-based findings, no partial proposal.
4. Cross-reference every recorded PR number against reality: `git log` and
   `gh pr view <n>` (or `gh pr list`) for the branch/merge history — a
   disposition of `merged` whose PR number the repo does not actually show
   merged is itself a finding.
5. Analyze the ledger, using corrected values throughout:
   - Dispositions grouped by `delegate` (codex / cursor / none) — merge rate,
     block rate. In portfolio scope, also grouped by goal.
   - Elapsed time between each item's `step-started` event and its matching
     `disposition` event — and whether that duration is trustworthy (work
     started before `start` was called reads as an implausibly short gap;
     flag it rather than averaging it in).
   - Goal-level outcomes and their timing: each goal's `closed` event
     (`done` or `abandoned`) and the elapsed time from its first
     `step-started` to that `closed` event.
   - How often refine-and-redelegate-once actually fired (a `blocked`
     disposition that followed a retry, versus one that fired on the first
     attempt).
   - What caused each `blocked` disposition — read the `notes`.
   - **Method evidence.** Read the disposition `notes` and the merged PR
     bodies the ledger points at: they carry how the work was actually done
     — brief shapes that hung versus succeeded, delegation patterns, retry
     narrowings. A method observation cited from notes or a PR body is
     evidence; a method opinion without a citation is not.
6. Write the proposal, citing the specific ledger entries (and PR bodies)
   behind each claim.

## Hard rules

- **Policy artifacts only.** A proposal may change policy artifacts only:
  skill wording, routing guidance, effort tiers, budgets. It never touches
  code or the companion itself, and it lands as a reviewable PR; it is never
  auto-applied.
- **Methods are policy artifacts too.** A portfolio retro may propose better
  *procedures*, not just parameter values: brief shapes, delegation
  patterns, choreography steps — including revisions to this command's own
  analysis method. The system is allowed to invent better ways of searching
  for solutions; every such proposal rides the same rails (a cited,
  reviewable PR, never auto-applied, never code).
- **Honesty floor.** Fewer than 5 disposition events at the running scope
  means the ledger is too thin for conclusions. Say so and stop instead of
  guessing.
- **The goal file wins.** A `correction` event supersedes the `disposition`
  (or `closed`) record it corrects; compute every conclusion from corrected
  values, never from a superseded raw write.
