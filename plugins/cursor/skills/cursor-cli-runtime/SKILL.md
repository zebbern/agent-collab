---
name: cursor-cli-runtime
description: Internal helper contract for calling the cursor-companion runtime from Claude Code
user-invocable: false
---

# Cursor Runtime

Use this skill only inside the `cursor:cursor-rescue` subagent.

Primary helper:
- `node "${CLAUDE_PLUGIN_ROOT}/scripts/cursor-companion.mjs" task "<raw arguments>"`

Execution rules:
- The rescue subagent is a forwarder, not an orchestrator. Its only job is to invoke `task` once and return that stdout unchanged.
- Prefer the helper over hand-rolled `git`, direct `cursor-agent` CLI strings, or any other Bash activity.
- Do not call `setup`, `review`, `adversarial-review`, `status`, `result`, or `cancel` from `cursor:cursor-rescue`.
- Use `task` for every rescue request, including diagnosis, planning, research, and explicit fix requests.
- You may use the `cursor-prompting` skill to rewrite the user's request into a tighter Cursor prompt before the single `task` call.
- That prompt drafting is the only Claude-side work allowed. Do not inspect the repo, solve the task yourself, or add independent analysis outside the forwarded prompt text.
- Leave the model unset by default (Cursor routes `auto` server-side). Add `--model` only when the user explicitly asks for one, and pass the name through unchanged.
- If the forwarded request names a task profile (`--profile deep` or `--profile fast`), pass `--profile <name>` through to `task` unchanged and strip it from the task text, mirroring how `--model` is handled. An explicit `--model` overrides the profile's model — pass both through and let `task` resolve which wins.
- There is no `--effort` flag: Cursor encodes depth in model names (for example `gpt-5.3-codex-high`, `claude-opus-5-thinking-high`) or in the `deep`/`fast` task profiles. If the user asks for more or less depth, choose via `--model` or `--profile`, not an effort flag.
- Default to a write-capable Cursor run by adding `--write` unless the user explicitly asks for read-only behavior or only wants review, diagnosis, or research without edits.

Command selection:
- Use exactly one `task` invocation per rescue handoff.
- If the forwarded request includes `--background` or `--wait`, treat that as Claude-side execution control only. Strip it before calling `task`, and do not treat it as part of the natural-language task text.
- If the forwarded request includes `--model <name>`, pass it through to `task` and strip it from the task text.
- If the forwarded request includes `--profile <deep|fast>`, pass it through to `task` and strip it from the task text.
- If the forwarded request includes `--resume <chat-id>`, pass it through to `task` and strip it from the task text. Cursor resume always needs the explicit chat id — there is no resume-last shortcut.
- Without `--resume`, every rescue is a fresh Cursor session.

Safety rules:
- Default to write-capable Cursor work in `cursor:cursor-rescue` unless the user explicitly asks for read-only behavior.
- Preserve the user's task text as-is apart from stripping routing flags.
- Do not inspect the repository, read files, grep, monitor progress, poll status, fetch results, cancel jobs, summarize output, or do any follow-up work of your own.
- Return the stdout of the `task` command exactly as-is.
- If the Bash call fails or Cursor cannot be invoked, return nothing.
