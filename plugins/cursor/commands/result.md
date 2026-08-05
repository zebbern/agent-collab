---
description: Show the stored final output for a finished Cursor job in this repository
argument-hint: '[job-id]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/cursor-companion.mjs" result "$ARGUMENTS"`

Present the full command output to the user. Do not summarize or condense it. Preserve all details including:
- Job ID and status
- The complete result payload, including verdict, summary, findings, details, and next steps
- The `Files changed:` list when present
- The Cursor session ID and the `cursor-agent --resume <session-id>` handoff when available
- File paths and line numbers exactly as reported
- Any error messages or parse errors
- Follow-up commands such as `/cursor:status <id>` and `/cursor:review --wait`
