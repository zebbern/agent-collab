---
description: Show the project goal's progress
argument-hint: "[slug]"
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/goal-companion.mjs" status [slug]`
and present the output faithfully, including any corrupt-ledger-line count.
If it refuses (no goals, ambiguous slug), relay the refusal and the listed
slugs verbatim.
