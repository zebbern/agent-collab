---
description: Delegate investigation, a fix request, or follow-up work to the Cursor CLI
argument-hint: "[--background|--wait] [--write] [--model <model>] [--resume <chat-id>] [what Cursor should investigate, solve, or continue]"
allowed-tools: Bash(node:*), AskUserQuestion
---

Forward the user's request to the Cursor companion CLI and return its stdout verbatim.

Raw user request:
$ARGUMENTS

Execution mode:

- If the request includes `--background`, launch the task with `Bash` in the background:
```typescript
Bash({
  command: `node "${CLAUDE_PLUGIN_ROOT}/scripts/cursor-companion.mjs" task "$ARGUMENTS"`,
  description: "Cursor task",
  run_in_background: true
})
```
- Do not call `BashOutput` or wait for completion in this turn. After launching, tell the user: "Cursor task started in the background. Check `/cursor:status` for progress."
- Otherwise (including `--wait`), run in the foreground:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/cursor-companion.mjs" task "$ARGUMENTS"
```

Operating rules:

- `--background` and `--wait` are execution flags for Claude Code. The companion script accepts `--background` for job bookkeeping, but Claude Code's `Bash(..., run_in_background: true)` is what actually detaches the run.
- `--write` lets Cursor modify files; without it the run stays sandboxed and read-only. Only add `--write` when the user clearly asked for changes to be made.
- `--model` is a runtime-selection flag. Preserve it for the forwarded `task` call, but do not treat it as part of the natural-language task text. Leave the model unset unless the user explicitly asks for one.
- `--resume <chat-id>` continues an existing Cursor chat. Preserve it verbatim.
- Return the companion stdout verbatim to the user. Do not paraphrase, summarize, rewrite, or add commentary before or after it.
- If the command reports that cursor-agent is missing or unauthenticated, stop and tell the user to run `/cursor:setup`.
- If the user did not supply a request, ask what Cursor should investigate or fix.
