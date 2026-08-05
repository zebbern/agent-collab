---
description: Diagnose the Codex plugin environment and surface residue that needs attention
argument-hint: ''
allowed-tools: Bash(node:*)
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" doctor
```

Operating rules:

- Return the companion stdout verbatim to the user. Do not paraphrase, summarize, or add commentary.
- This command never installs anything, never kills processes, and never deletes files. (Loading a corrupt state index triggers the same quarantine-and-rebuild recovery every companion command shares; the rebuilt index is persisted.) Each warning line carries its own remediation hint; leave acting on them to the user.
- A `warning` overall status is informational, not a failure — do not escalate it or offer to "fix" anything unless the user asks.
- If the report shows the codex CLI missing or unauthenticated, point the user at `/codex:setup` for the guided install flow.
