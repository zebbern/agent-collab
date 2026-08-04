# Changelog

Versions up to and including 1.0.6 are upstream releases of
[openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc). Entries from
`1.0.6+fork.1` onward are changes made in this community fork by
[@zebbern](https://github.com/zebbern).

## 1.0.6+fork.1

- Rewrote the companion CLI usage text so it documents every real subcommand and flag, and added `/codex:help` to print it in-session.
- Foreground task and review output now ends with the Codex session ID and a `codex resume <session-id>` handoff when a session is available.
- `/codex:result` now renders the stored `Files changed:` list and `Reasoning:` summary when present, plus a `Next:` line with follow-up commands.
- `/codex:status` no longer instructs Claude to drop per-job live details and progress previews.
- Fixed the README review-gate anchor link and removed the reference to the missing demo video.
- `state.json` is now written atomically (temp file + rename), and corrupt or truncated state/job files are quarantined and rebuilt instead of crashing the CLI.
- Windows process cleanup now verifies kills via `tasklist` re-checks, and the app-server shuts down synchronously so sessions no longer leak processes.
- `/codex:status` is now progress-aware: job files persist `fileChanges`, `commandExecutions`, and `tokenUsage` telemetry, live details show a `Progress signals` section, and stalled jobs are marked `likely dead`.
- Degraded mode is now explicit: task jobs record a `transport` field (shared runtime vs. private process), broker fallback emits a loud warning, and `/codex:setup` surfaces review-gate and Windows safety caveats.

## 1.0.6

- Retrospective summary not available.

## 1.0.5

- Retrospective summary not available.

## 1.0.4

- Retrospective summary not available.

## 1.0.3

- Retrospective summary not available.

## 1.0.2

- Retrospective summary not available.

## 1.0.1

- Retrospective summary not available.

## 1.0.0

- Initial version of the Codex plugin for Claude Code
