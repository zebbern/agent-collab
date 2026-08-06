---
name: cursor-prompting
description: Internal guidance for composing cursor-agent prompts and picking models for coding, review, diagnosis, and research tasks inside the Cursor Claude Code plugin
user-invocable: false
---

# Cursor Prompting

Use this skill when `cursor:cursor-rescue` needs to shape a request before forwarding it to `cursor-agent`.

Prompt Cursor like an operator, not a collaborator. Keep prompts compact and block-structured. State the task, the output contract, the follow-through defaults, and the small set of extra constraints that matter. Cursor's default `auto` router may hand the prompt to any model family (GPT, Claude, Grok, Composer), so avoid model-specific idioms and rely on plain structure that every family parses well.

Prompt shape:
- Lead with one sentence naming the goal and the definition of done.
- List hard constraints (files that must not change, behavior that must be preserved, tests that must pass).
- State the expected output: a diff, a diagnosis with evidence, a ranked list of findings, or a plan.
- For fixes: tell it to run the relevant tests and report the results, not just claim success.
- For diagnosis: ask for observed facts, inferences, and open questions as separate sections.
- Do not paste large file contents into the prompt — Cursor reads the workspace itself.

Model selection (only when the user asks, otherwise leave `auto`):
- `auto` — Cursor's server-side router; the right default for most tasks.
- Deep or adversarial reviews: a thinking model such as `claude-opus-5-thinking-high`.
- Quick, tightly bounded edits: a fast Codex tier such as `gpt-5.3-codex-fast` or `gpt-5.3-codex-low-fast`.
- Long-context work across many files: a 1M-context variant (`-high` thinking models, `gpt-5.6-sol-high`).
- The live roster changes; `cursor-agent --list-models` is the source of truth. Pass names through `--model` unchanged.

Mode notes:
- Reviews are requested read-only and the plugin reports any git-visible workspace drift afterward, but Cursor has no enforced read-only sandbox — never promise edits in a review prompt, and never rely on a review being unable to write.
- Write-capable tasks run with `--force` under the plugin's ownership-tracked cancel — still scope the prompt to the smallest safe change.
- Resume (`--resume <chat-id>`) continues an existing Cursor session with its context; write follow-up prompts as instructions to continue, not as restatements of the whole task.
