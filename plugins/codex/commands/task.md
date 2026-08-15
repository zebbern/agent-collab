---
description: Delegate investigation, a fix request, or follow-up work directly to the Codex CLI
argument-hint: '[--background] [--write] [--resume-last|--resume|--fresh] [--profile <deep|fast>] [--model <model|spark>] [--effort <none|minimal|low|medium|high|xhigh|max>] [prompt]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" task "$ARGUMENTS"`

Present the command output to the user exactly as returned. Do not paraphrase, summarize, rewrite, or add commentary before or after it.

Preserve the raw arguments unchanged. Do not remove `--background` or turn it into Claude-side background execution. When `--background` is present, the companion enqueues the detached persistent worker and returns its job ID; this slash command remains inline.

Do not invoke any other helper, a Claude background task, or a subagent.
