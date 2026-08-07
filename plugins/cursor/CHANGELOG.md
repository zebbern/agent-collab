# Changelog

## Unreleased

- `/cursor:doctor` gained `model-roster-pins`: warns when a pinned `--profile` model id (`deep` = `gpt-5.6-sol-xhigh`, `fast` = `cursor-grok-4.5-high-fast`) no longer exists in the live `cursor-agent --list-models` roster, naming the stale profile and id and pointing at updating the profile table or passing `--model` explicitly. The probe runs through the plugin's already-resolved invocation plan (native PATH binary or the WSL fallback), so it never diverges from how a real turn is spawned. A roster the probe cannot read — CLI unavailable, the command failing, or empty/unparseable output — is always reported as unauditable (warning), never as "every id is missing" and never as a false "ok"; unknown is not healthy. The check builder (`buildModelRosterCheck`, shared chassis with the codex plugin) is provider-free and takes the profile table and roster-probe function as injected context, so tests never invoke a real CLI.
- Fixed a misleading `/cursor:result <job-id>` refusal (mirrored chassis fix — see the codex entry): a job that was still RUNNING or QUEUED was reported as "No job found" because the terminal-status match threw before the active-job fallback ever ran. `result` on an active job now reports "Job X is still running/queued" and points at `/cursor:status`; `result` on a finished job whose per-job result file went missing (pruned or quarantined) now fails loudly with the job id and status instead of silently rendering an empty "no captured result payload". The same bucket-before-match bug hid `/cursor:cancel` on an already-finished job behind the same "No job found" wording; it now says the job is already completed/failed/cancelled and there is nothing to cancel.
- Atomic state writes tolerate Windows rename contention (mirrored chassis fix — see the codex entry): bounded retry of `EPERM`/`EACCES`/`EBUSY` on the state-file rename, loud failure on exhaustion, cleanup failures never mask the original error.
- New `cursor-delegation` skill makes delegation ambient: Claude can reach for Cursor on task shape — firing `task --background` itself, awaiting it with `status <jobId> --wait` as a background Bash task, and collecting with `result`; reviews delegate as a single background Bash step. Same pinned policy as the codex twin (one-line disclosure, one job per class, no auto-applied review findings), minus effort tiers — Cursor has none.
- The agent prompt travels over stdin, never argv. Review prompts rode `wsl.exe`'s ~32K CreateProcess command line, and a live review over a large diff died with `spawn ENAMETOOLONG` before the agent started. Verified against the real cursor-agent (print mode reads the prompt from stdin when no positional is given); the fake fixture pins the stdin contract with a 64KB regression case.
- Progress lines now say `[cursor]`, not `[codex]`. The stderr prefix is a plugin-name literal the chassis mirror's swap table missed, so the mirror faithfully copied the codex prefix; the pair is now swapped by `npm run sync-chassis`, pinned by the drift guard, and covered by a behavioral test.
- `/cursor:doctor` gained the same installation-hygiene checks as the codex doctor: `/cursor:*` command-namespace collision detection across installed marketplaces, and a stale plugin-cache audit that also finds residue from uninstalled marketplaces — with unreadable registry/cache state reported as unauditable, never as healthy.
- `/cursor:task` (and `/cursor:rescue`, which forwards to it) gained `--profile deep|fast`, a named shortcut for `--model` (`deep` = `gpt-5.6-sol-xhigh`, `fast` = `cursor-grok-4.5-high-fast`; both live-verified against `cursor-agent --list-models`). An explicit `--model` still overrides the profile's model; Cursor has no effort concept, so a profile carries a model choice only. An unknown or empty `--profile` fails loudly before any cursor-agent invocation or background enqueue instead of silently falling back. `review` and `adversarial-review` reject `--profile` outright — profiles are task/rescue only.

## 0.4.0

- Added `/cursor:doctor`: a read-only health report covering cursor-agent availability (WSL-aware), auth, and the same state-hygiene checks as the codex doctor, plus a spawn→init startup-overhead summary.
- Every in-process run now carries the ownership proof cancel requires. Reviews, adversarial reviews, and foreground tasks previously wrote job records with a bare PID and no identity, so `/cursor:cancel` on them fail-closed as `cleanup-pending` and left the WSL agent running; `runTrackedJob` now captures the runner's identity, and cancel binds proof from the merged index+file record so a progress-updater write cannot strand it.
- The WSL agent is reaped by `(pid, /proc starttime)` identity, not just a cmdline substring, so a recycled PID running a different `cursor-agent` is never signalled. The pidfile records the starttime at spawn (survives `exec`), read via a torn-read-proof double read; a failed WSL probe is treated as unknown state, never death.
- Reviews detect and report agent writes into the workspace. Cursor has **no enforced read-only sandbox** under `--trust` (a live review once created files), so the plugin fingerprints the working tree around each review and reports git-visible changes — documented honestly as drift detection, not containment, and it does not cover git-ignored files. The review prompt gained a `<trust_boundary>` section backed by delimiter neutralization so reviewed code cannot forge the section closer.
- Spawn→init startup overhead is recorded durably and summarized by doctor. Recording is gated on the agent's `init` event (not the first stdout byte, which `--resume` would pre-satisfy), so resume runs are measured correctly.
- Shares the codex plugin's private-state hardening (`0o700` dir, symlink refusal, `0o600` lock/flag/log, durable corrupt-state recovery) and the `min(cores, 8)` test-concurrency cap.

## 0.3.0

- Skill and rescue parity with the codex plugin: `/cursor:rescue` hands a task
  to the new `cursor:cursor-rescue` forwarder subagent, guided by three new
  internal skills — `cursor-cli-runtime` (the forwarder contract),
  `cursor-prompting` (prompt shaping and model selection across Cursor's
  router; `auto` by default, `cursor-agent --list-models` as the roster), and
  `cursor-result-handling` (presentation rules, including the hard stop
  against auto-applying review fixes). Cursor has no resume-last shortcut, so
  rescue resume always takes an explicit `--resume <chat-id>`.

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
