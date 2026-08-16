# Direct Codex Task Command Design

## Problem

The Codex plugin can already enqueue a detached background task that survives
the Claude session which launched it, but ordinary users do not have a direct
slash command for that path. The README Quick Start currently demonstrates
`/codex:review --background`; reviews are session-scoped, so the onboarding
flow does not demonstrate the plugin's most valuable new behavior.

## Goal

Give users one obvious command that starts useful Codex work, lets them close
Claude, and lets them retrieve the result from a later session in the same
repository.

The first-run flow is:

```text
/codex:task --background --fresh "Read-only: map this repository and recommend its highest-leverage next improvement. Do not edit files."
close Claude and later reopen the same repository
/codex:status <job-id> --wait
/codex:result <job-id>
```

## Command Contract

Add `plugins/codex/commands/task.md` as a deterministic runtime entrypoint.
It invokes exactly one command:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" task "$ARGUMENTS"
```

The command passes the raw arguments once and unchanged. In particular,
`--background` reaches the companion, which already enqueues the detached,
persistent worker and immediately returns a job id. The slash command itself
stays inline; it must not use Claude-side background Bash, a subagent,
`task-resume-candidate`, or any additional helper.

The exposed flags match the existing companion task surface:
`--background`, `--write`, `--resume-last|--resume|--fresh`,
`--profile <deep|fast>`, `--model <model|spark>`, and
`--effort <none|minimal|low|medium|high|xhigh|max>`. There is no `--wait` flag
because the companion task command does not implement one. The command returns
the companion output verbatim, including validation and readiness errors.

`/codex:rescue` remains unchanged. It continues to provide its specialist
Claude subagent and resume-choice workflow; `/codex:task` is the simpler direct
path for users who want predictable delegation and cross-session persistence.

## Documentation

Replace the review-based Quick Start with the direct background task flow and
state the benefit before the mechanics: the user may close Claude and collect
the result later. Add `/codex:task` to the Codex command table and usage details.
Keep review documentation intact and continue to describe reviews as
session-scoped.

## Testing

Extend `tests/commands.test.mjs` before implementation to pin:

- the new command file is shipped;
- the companion invocation occurs exactly once with `$ARGUMENTS` exactly once;
- `--background` is preserved for companion-owned persistence;
- Claude background execution, subagents, and resume-candidate routing are
  absent;
- the Quick Start demonstrates close, reopen, status, and result; and
- the command table and usage section expose `/codex:task`.

The runtime persistence path is already covered by the real-process task and
session-lifecycle tests, so this feature adds command/documentation contract
tests rather than another duplicate lifecycle test.

## Release and Acceptance

Ship the product wiring as marketplace version `1.3.2` and Codex plugin version
`1.0.6+fork.9`; Cursor remains `0.5.3` and Goal remains `0.3.2`. Add a concise
Codex changelog entry.

Acceptance requires the focused command tests, version check, build, full local
`npm run verify` gate, required PR CI, and a live installed-marketplace smoke:
launch the read-only example in the background, end the Claude session, reopen
the same repository, and retrieve a substantive result without changing the
working tree.

## Non-Goals

- No changes to task runtime, cancellation, ownership, brokers, or persistence.
- No changes to `/codex:rescue`, Cursor, or Goal behavior.
- No new dependencies, configuration, telemetry, or optional hardening.
- No automatic polling or result retrieval inside `/codex:task`.
