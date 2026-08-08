---
description: Analyze the goal ledger and propose policy improvements
argument-hint: "[slug|--all]"
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

Analyze the goal ledger's history and propose policy improvements — never
code changes, and never auto-applied.

The ledger speaks five events: `step-started`, `disposition`, `closed`,
`correction`, and `retro`. `retro` is a retrospective's own trace: scope,
disposition count, floor verdict, proposal PR. `step-started` and
`disposition` track one backlog item's
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
   Before trusting the count either way, cross-check it against the goal
   files' recorded dispositions: if the ledger sees materially fewer than
   the goal files carry, the ledger view is local — a split or unmigrated
   state root — and a verdict computed from a shard is wrong even when the
   refusal itself is procedurally correct. Say which view disagreed and
   stop. (Precedent: the 2026-08-07 portfolio retro recorded
   `dispositions=1` while the goal files carried 9 — a split-state shard,
   later unified by the canonical-root ledger migration.)
4. Cross-reference every recorded PR number against reality: `git log` and
   `gh pr view <n>` (or `gh pr list`) for the branch/merge history — a
   disposition of `merged` whose PR number the repo does not actually show
   merged is itself a finding.
5. Analyze the ledger, using corrected values throughout:
   - Dispositions grouped by `delegate` (codex / cursor / none) — merge rate,
     block rate. In portfolio scope, also grouped by goal.
   - Elapsed time between each item's `step-started` event and its matching
     `disposition` event — and whether that duration is trustworthy. Both
     extremes lie: work started before `start` was called reads as an
     implausibly short gap, and a step that contains unattended or
     background phases (a scheduled run, an overnight benchmark matrix)
     reads as an implausibly long one. Flag both rather than averaging
     them in. PR open-to-merge spans are review-inclusive calendar time,
     not work duration — cite one only labeled as such, and never mix it
     into a before/after adoption comparison unless both sides use the
     same metric under the same label.
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
6. **Evaluate prior adoptions first.** Read prior `retro` events; for each
   with a proposal PR, find that PR's `mergedAt` via `gh`, and compare
   outcomes before vs after it (merge rate, blocked rate, step durations,
   refine-once frequency, delegate mix). Its own honesty floor: fewer than
   3 dispositions on either side of an adoption point means say 'too thin
   to judge this adoption yet' and move on — no verdict. A prior proposal
   showing no improvement, or regression, makes proposing its REVERSAL a
   legitimate finding. A retro must not propose new method changes while
   ignoring the results of old ones.
7. Write the proposal, citing the specific ledger entries (and PR bodies)
   behind each claim.
8. Record the run via
   `node "${CLAUDE_PLUGIN_ROOT}/scripts/goal-companion.mjs" retro-record [slug|--all] --pr <n> --findings <n>`
   — a retro that leaves no trace cannot be evaluated by its successor;
   record floor-refused runs too.

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
