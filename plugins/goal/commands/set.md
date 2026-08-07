---
description: Create or update a long-horizon goal for this project
argument-hint: "[description of the goal]"
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

Create or update a goal file for this project.

1. Interview briefly if needed: the goal statement, acceptance criteria
   (mechanically checkable commands where possible, `manual` otherwise), a
   ranked backlog of increments (each `[a-z0-9-]+` id, title, detail), and
   `budget.perStepDelegations` (default 2).
2. Draft the goal JSON (schemaVersion 1) to a temp file.
3. Run: `node "${CLAUDE_PLUGIN_ROOT}/scripts/goal-companion.mjs" set --file <temp-path>`
   The companion validates and writes `.claude/goals/<slug>.json`; if it
   refuses, fix exactly what it names and re-run — never bypass validation.
   Renaming a slug: `set` writes the new file and never deletes the old one —
   remove `.claude/goals/<old-slug>.json` yourself, or `status`/`next` will
   refuse listing both.
4. Show the result of `node "${CLAUDE_PLUGIN_ROOT}/scripts/goal-companion.mjs" status <slug>`.
5. Remind the user the goal file is git-tracked project content: commit it.

Trust note: `check` runs command criteria via the shell — the same trust
level as npm scripts. Review goal files in untrusted repos before running.
