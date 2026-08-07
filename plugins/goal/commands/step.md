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
