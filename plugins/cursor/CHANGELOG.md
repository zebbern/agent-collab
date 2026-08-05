# Changelog

## 0.1.0

Initial release.

- `/cursor:setup`, `/cursor:task`, `/cursor:review`, `/cursor:adversarial-review`, `/cursor:status`, `/cursor:result`, `/cursor:cancel`, and `/cursor:help` commands that delegate to the Cursor CLI (`cursor-agent`).
- One process per job: every task and review runs a single `cursor-agent -p <prompt> --output-format stream-json` turn and parses the newline-delimited event stream (init, assistant, tool_call, result).
- Windows support through WSL: there is no native Windows build of cursor-agent, so on win32 the adapter resolves the binary inside WSL, translates the workspace path (`C:\foo` -> `/mnt/c/foo`), and spawns `wsl -e <binary> ...` with pure argv passing. A PATH-resolved binary or the `CURSOR_COMPANION_TEST_BINARY` override takes precedence, so tests never touch WSL.
- Background jobs with durable state, progress logs, liveness markers, and cancel support, sharing the job-tracking chassis of the codex plugin but with a separate state directory (`cursor-companion`) so the two plugins never share state.
- Reviews reuse the adversarial review prompt and structured JSON review schema, with the schema embedded in the prompt because cursor-agent has no structured-output flag.
- Human handoff via `cursor-agent --resume <session-id>` printed with every finished job.

This plugin is derived from the codex plugin chassis in this repository, itself a
fork of the OpenAI Codex plugin for Claude Code (Apache-2.0). See NOTICE.

## 0.2.0

- Cancel now proves ownership before killing anything. Workers persist a
  process identity at start (Unix start-time identity, or `(pid, CreationDate)`
  via CIM on Windows) plus a POSIX ownership snapshot, and the Windows kill
  path verifies the identity before `taskkill` — a stale or reused PID is never
  killed, and a job with no recorded proof fails closed as `cleanup-pending`
  instead of being blindly terminated.
- WSL jobs record the Linux-side `cursor-agent` PID (a bash exec wrapper writes
  it to a pidfile the Windows side can read) and cancel reaps the agent inside
  the distro first — verifying `/proc` cmdline before signalling, escalating
  TERM→KILL, and failing closed if the agent survives. The Windows relay tree
  is then collapsed and the worker's exit is verified by identity poll, since
  `taskkill` cannot terminate `wsl.exe` relay processes directly.
