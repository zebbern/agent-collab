# Changelog

Versions up to and including 1.0.6 are upstream releases of
[openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc). Entries from
`1.0.6+fork.1` onward are changes made in this community fork by
[@zebbern](https://github.com/zebbern).

## Unreleased

- Companion-enqueued `task --background` jobs now survive the Claude session
  that launched them. Persistent workers use a private app-server so
  SessionEnd can tear down its shared broker without killing the task; later
  sessions can discover, read, or cancel the job, while foreground reviews
  remain session-scoped. Session cleanup merges against fresh locked state
  after process teardown, so it cannot overwrite a worker's concurrent PID or
  remove a newly enqueued job.
- Signal-terminated subprocess probes retain their null exit status and fail
  closed instead of being reported as exit 0, preserving process-enumeration
  and ownership-verification guarantees.

## 1.0.6+fork.7

- The `fast` task profile now pins `--effort medium` instead of inheriting the user's `~/.codex` default. With `model_reasoning_effort = "ultra"` (or `max`) in the user config, every `--profile fast` task failed with an API 400 — the spark model supports only low/medium/high/xhigh (observed live 2026-08-08, first real `--profile fast` run on a configured machine). Profiles are now fully specified (model + effort) so user config can never produce an unsupported combination; an explicit `--effort` still overrides the profile default.
- **One canonical state root per user** (`~/.claude/codex-companion`, override `CODEX_COMPANION_STATE_ROOT` for test isolation): job state, startup metrics, broker session state, and the broker-ownership registry no longer resolve their root from ambient `CLAUDE_PLUGIN_DATA`. That var means "whichever plugin install's SessionStart hook exported it last" — with per-marketplace installs (`codex-inline` vs `codex-agent-collab` observed live), stale exports surviving an uninstall, hook processes seeing a different value than Bash, and cursor Bash inheriting codex's dir (a real cursor job was found stored inside codex's data dir), one workspace's jobs split across roots: `status`/`cancel` reported "No job found" for live jobs, SessionEnd cleanup looked in the wrong root (orphaned workers), and a broker registered under one root was invisible to sessions resolving another. The SessionStart hook no longer exports `CLAUDE_PLUGIN_DATA` session-wide (that export was the poison vector), and the broker-ownership registry is never disabled for lack of the var anymore.
- Legacy-shard healing, scoped to what can be re-homed honestly: on every job command (not `doctor`, which stays read-only) the companion imports its own plugin-stamped startup-metric rows from pre-canonical shards (ambient var, every `~/.claude/plugins/data/*` install dir, the old tmpdir fallback) into the canonical root — one-time per shard via a `metrics.jsonl.migrated-codex` marker, leaving the sibling plugin's rows in place — and adopts legacy config (the stop-review gate) only while the canonical index does not exist yet. Job records are deliberately NOT migrated: a merged shard cannot attribute a job to a plugin, live legacy workers keep updating their own root, and a re-homed cancel flag would sit where no worker polls it. Instead `/codex:doctor` gained `state-root-residue` (shard paths, job counts, active-job call-out) and a "No job found" miss now names the legacy shard and points at doctor.
- The stop-review-gate hook consolidates before its first config read, so a gate enabled before this migration keeps holding after it. the installer writes version 1.0.6+fork.6 into a directory named 1.0.6-fork.6, so the name-vs-version audit flagged the LIVE install as deletable residue. The registry's installPath is now authoritative, with a sanitized-name fallback for entries that lack it.

## 1.0.6+fork.6

- The codex-delegation skill gained a Brief shape section from the first portfolio retrospective (PR #33): prefer design-to-verdict briefs for analysis delegations and refine by narrowing on a dead run — cited from ledger evidence (0/2 open-ended xhigh briefs survived; 2/2 narrowed retries merged).

## 1.0.6+fork.5

- `/codex:doctor` gained `model-roster-pins`: a check meant to warn when a pinned `--profile` model id no longer exists in the provider's live model roster. Live-verified 2026-08-07 that codex-cli 0.146.0 exposes no model-roster surface at all (its subcommands are exec/review/login/logout/mcp/plugin/mcp-server/app-server/remote-control/app/completion/update/doctor/sandbox/debug/apply/resume — no `models`/`list`), so for codex this always renders an honest `ok` stating the pinned ids (`deep`, `fast`) are unverifiable because no roster command exists to check them against — never a warning that would cry wolf on every healthy install, and never wording that implies the ids were confirmed. The check builder itself (`buildModelRosterCheck`, shared chassis) is provider-free and takes the profile table and a roster-probe function, so cursor's copy (see the cursor changelog) gets real verification against `cursor-agent --list-models` for free.
- Added `--profile <deep|fast>` to `task` (and `/codex:rescue`, which forwards to `task`): `deep` resolves to `--model gpt-5.6-sol --effort xhigh`, `fast` to `--model gpt-5.3-codex-spark` (the same target the shipped `spark` alias already maps to, effort left at Codex's default). An explicit `--model` or `--effort` on the same invocation overrides the matching profile default independently; an unknown or empty `--profile` is rejected before any Codex invocation or background enqueue. `review` and `adversarial-review` explicitly reject `--profile` (profiles are task/rescue only) so it can never be swallowed into focus text. codex-cli exposes no model-roster command (verified live against 0.146.0), so the profile ids cannot be machine-checked at runtime.
- Fixed a misleading `/codex:result <job-id>` refusal: a job that was still RUNNING or QUEUED was reported as "No job found" (observed live 2026-08-07), because the terminal-status match threw before the active-job fallback ever ran. `result` on an active job now reports "Job X is still running/queued" and points at `/codex:status`; `result` on a finished job whose per-job result file went missing (pruned or quarantined) now fails loudly with the job id and status instead of silently rendering an empty "no captured result payload". The same bucket-before-match bug hid `/codex:cancel` on an already-finished job behind the same "No job found" wording; it now says the job is already completed/failed/cancelled and there is nothing to cancel.
- Atomic state writes tolerate Windows rename contention: two workers on the state lock's warned unlocked path could collide renaming `state.json` and crash with `EPERM` (observed live 2026-08-07). The rename now retries the transient set the lock's own acquire path already tolerates (`EPERM`/`EACCES`/`EBUSY`, bounded, ~240ms worst case) and still fails loudly on exhaustion; a tmp-cleanup failure can no longer mask the original error.
- New `codex-delegation` skill makes delegation ambient: Claude can reach for Codex on task shape — firing `task --background` itself, awaiting it with `status <jobId> --wait` as a background Bash task (the harness notification closes the loop), and collecting with `result`; reviews delegate as a single background Bash step (they have no companion-side enqueue). Policy rides in the skill and is pinned by tests: every delegation announced in one line, one job of a class at a time, review findings never auto-applied, failures reported instead of substituted.
- `/codex:doctor` now audits the installation itself. `plugin-name-collision`: this fork ships a plugin literally named `codex`, so installed alongside the official OpenAI plugin both claim the `/codex:*` commands — the check names every claimant and says to uninstall all but one. `plugin-cache-stale`: cached plugin copies no install records — including residue from uninstalled marketplaces — are surfaced as verify-before-deleting warnings; an unreadable registry or cache reports as unauditable, never as healthy.

## 1.0.6+fork.4

- Added `/codex:doctor`: a read-only health report covering CLI availability and version freshness, auth, registered-broker residue (report-only), and state hygiene (cleanup-pending jobs, likely-dead workers, stale locks, quarantined corrupt state, orphaned job files), each with inline remediation. Warnings never fail the command.
- Process identity is now locale-stable: `readUnixProcessTable` pins `LC_ALL=C` so the `pid@lstart` identity cannot differ between spawn and cancel under a changed locale, and the Windows identity probe passes `-NonInteractive` so it can never block. `--effort max` is now accepted end to end (codex-cli 0.146.0 supports `model_reasoning_effort=max`).
- The state directory is now private and validated on every use: created `0o700`, a symlinked or another user's directory is refused, the lock file/cancel flags/job logs are `0o600`, and a corrupt `state.json` is recovered copy-then-replace (no missing-file window) with the rebuilt index persisted durably. Doctor's liveness is tri-state — an unreadable process table reports "unknown", never "healthy".
- Fixed a broker launch-lock crash: the greeting server handed connections a socket with no error handler, so a probing client's reset became an uncaught exception that could kill the lock holder mid-launch. `npm test` now caps file concurrency at `min(cores, 8)` so the process-spawning e2e tests don't starve their workers on high-core machines.
- Spawn→ready startup overhead is now recorded durably (an append-only, size-rotated `metrics.jsonl` outside the job-prune window) and summarized per transport by the doctor `startup-overhead` check, to inform the persistent-broker decision.
- Documentation and review-prompt accuracy: the review prompt gained a `<trust_boundary>` section (repository contents are untrusted data, not instructions) backed by delimiter neutralization so reviewed code cannot forge the section closer; the Node requirement is corrected to `>= 20`.
- Author-time tooling: `npm run sync-chassis` mechanizes the mirrored-lib copy (refusing the genuinely divergent modules), and `npm run reap-test-residue` reports and (with `--clean`) removes the test suite's temp-directory residue.

## 1.0.6+fork.3

- Codex cancel proves ownership before killing on Windows: a `(pid, CreationDate.ToFileTimeUtc)` identity from a CIM probe, tri-state `ok`/`absent`/`unavailable` results where probe failure is never treated as death, and a fail-closed refusal to kill a bare PID without a proven identity or a live process handle. The same identity discipline is shared with the cursor plugin.

## 1.0.6+fork.2

- Version checkpoint bundling the `fork.1` Windows-hardening and green-suite work; no distinct feature changes were recorded for this bump.

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
- The broker ownership registry now works on Windows: exact POSIX permission checks (0o700/0o600) are enforced only off win32 — Windows reads modes back as 0o666, so every registry operation used to throw `BROKER_OWNERSHIP_PERMISSIONS`; symlink and file-type checks still apply everywhere. Same gating in the registered-broker reaper.
- Registry lock contention is classified correctly on Windows: rename-onto-existing-directory raises `EPERM` there (not `EEXIST`/`ENOTEMPTY`), which is now treated as contention/retry instead of a fatal error, in both the acquisition and stale-lock-quarantine paths.
- `taskkill`/`tasklist` are invoked with `shell: false` (inherited upstream bug): under Git Bash the MSYS layer rewrote `/PID` into a filesystem path, making every cancel-path kill fail with "Invalid argument".
- `createBrokerEndpoint` uses `path.posix.join` for its non-Windows branch, honoring the injected platform (inherited upstream bug).
- `/codex:setup` now detects a stale Codex CLI: version-skew error signatures (an outdated parser rejecting newer config values or backend responses, e.g. ``unknown variant `max```) add a next step suggesting `npm install -g @openai/codex`.
- Stored job stderr is no longer flooded by repeated CLI noise: runs of near-identical lines (e.g. hundreds of skill-load errors differing only in path) collapse to the first occurrence plus a suppression count, and cleaned stderr is capped at 32KB with middle truncation.
- `/codex:result` shows the `Model:` line too, and task jobs also record their `--effort` level, shown as `Model: <name> (effort: <level>)`.
- The 15-minute `runtime.test.mjs` is split into three duration-balanced files so the test runner's per-file parallelism roughly halves suite wall-clock time.
- Jobs now record which model they were handed to: task and review results persist a `model` field (the explicit `--model` value, or `null` for the Codex config default), and `/codex:status` renders a `Model:` line — `Model: gpt-5.4-codex` or `Model: default (Codex config)`. Job files from before this change simply show no line.
- The test suite is now green on Windows: POSIX-only contracts (socket paths, permission-mode assertions, unprivileged symlinks, shared-broker lifecycle) are platform-gated or skipped in the suite's existing skip style, transfer tests are hermetic on Windows (`USERPROFILE` was leaking the real profile into sandboxes), and fixtures avoid symlink-privilege and `spawn` PATHEXT pitfalls.

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
