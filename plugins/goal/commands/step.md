---
description: Advance the project goal by exactly one increment
argument-hint: "[slug]"
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

Advance the goal one increment. One increment per invocation — when step 7
completes, stop. Do not start another increment; repetition is the user's
call (or `/loop` while they watch).

1. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/goal-companion.mjs" next [slug] --json`.
   If it refuses (goal blocked/done, an item already in progress, nothing
   todo), surface the reason verbatim and stop.
2. Announce the increment in one line — what it is and whether you intend to
   delegate it.
3. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/goal-companion.mjs" start <slug> <itemId>`.
4. Execute with judgment: trivial work stays local; otherwise delegate via
   the `codex-delegation` / `cursor-delegation` skills. Analysis and implementation are separate delegations when both are needed, within the
   goal's `budget.perStepDelegations` (advisory: say so if you exceed it).
5. Verify through the project's own gates (this repo: `npm run verify`) and
   land the change as a PR; the user merges.
6. If delegated work fails verification: refine the brief with the failure evidence and re-delegate once (it counts against the step budget). If it
   fails again, record the item as blocked:
   `node "${CLAUDE_PLUGIN_ROOT}/scripts/goal-companion.mjs" record <slug> <itemId> --disposition blocked --notes "<evidence>"`
7. Record the real disposition (`merged` with `--pr <n>` and `--delegate`,
   or `discarded`/`blocked` with `--notes`), show the one-line output of
   `status`, and stop.

## Unattended (scheduled) operation

The same one-increment choreography can be driven without a human watching —
by `/loop` or a Claude Code scheduled agent. Only the trigger changes; the
architecture does not. Extra rails for that mode:

- **One writer per project.** Prevent overlapping scheduled wakes and manual
  `/goal:step` invocations. If another runner may still be active, stop before
  changing goal state.
- **Branch naming.** Do the increment's work on a branch named
  `goal/<slug>/<itemId>`, so a later wake can find its PR mechanically.
- **An unattended step never merges PRs.** It opens the PR, leaves the item
  in-progress, and stops. Merging stays human.
- **Reconcile before stepping.** On wake, if an item is in-progress, find its
  PR from the project's repository before doing anything else:
  `gh pr list --state all --head "goal/<slug>/<itemId>" --json number,state,headRefName,mergedAt`.
  Require exit code 0 and a JSON array containing exactly one PR with a
  positive integer `number` and `headRefName` exactly equal to
  `goal/<slug>/<itemId>`. A failed query, invalid or incomplete JSON, no PR,
  multiple PRs, a different head branch, or inconsistent `state`/`mergedAt`
  is unresolved: report the evidence and stop without recording a disposition
  or starting another item. Never infer a disposition from an absent PR or
  choose among multiple PRs.
  - `state: MERGED` with a non-null `mergedAt` →
    `record <slug> <itemId> --disposition merged --pr <n>`.
  - `state: CLOSED` with `mergedAt: null` →
    `record <slug> <itemId> --disposition discarded --notes "PR #<n> closed without merge"`.
  - `state: OPEN` with `mergedAt: null` → stop and wait; do not start another
    increment.
  Any other state is unresolved. After recording merged or discarded, show
  `status` and stop this wake; only a later invocation may select another item.
- **Blocked halts the loop.** A blocked goal stops every subsequent wake
  until a human resolves it — exactly as in attended mode.
- **Budget stays advisory**, but every delegation is still announced into
  the session log, so the wake's transcript carries the same disclosure a
  watching user would have seen.
