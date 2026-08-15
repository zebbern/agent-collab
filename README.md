<div align="center">

# agent-collab

**Delegate work from Claude Code to other AI coding agents.**

Run Codex and Cursor as background workers inside Claude Code — reviews, tasks, and rescues with tracked jobs, live progress, and session handoffs.

[![CI](https://github.com/zebbern/agent-collab/actions/workflows/pull-request-ci.yml/badge.svg)](https://github.com/zebbern/agent-collab/actions/workflows/pull-request-ci.yml)
[![Release](https://img.shields.io/github/v/tag/zebbern/agent-collab?label=release&sort=semver)](https://github.com/zebbern/agent-collab/tags)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Platforms](https://img.shields.io/badge/platform-Windows%20%7C%20Linux%20%7C%20macOS-lightgrey.svg)]()

[Quick start](#quick-start) •
[Codex plugin](#codex-plugin) •
[Cursor plugin](#cursor-plugin) •
[Ambient delegation](#ambient-delegation) •
[Goal plugin](#goal-plugin) •
[How it works](#how-it-works) •
[Development](#development) •
[License](#license--attribution)

</div>

---

One marketplace, three plugins:

| Plugin | Delegates to | Highlights |
| --- | --- | --- |
| **`codex`** | [OpenAI Codex](https://developers.openai.com/codex/) (`codex` CLI) | `/codex:task`, `/codex:review`, `/codex:adversarial-review`, `/codex:rescue`, session transfer, optional stop-review gate. Community fork of [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc) with Windows fixes. |
| **`cursor`** | [Cursor](https://cursor.com) (`cursor-agent` CLI) | `/cursor:review`, `/cursor:task`, ownership-verified cancel, WSL support on Windows, resolved-model + token-usage recording. |
| **`goal`** | Long-horizon goals | `/goal:set`, `/goal:step` — one increment per invocation, delegating through the other two plugins, with mechanical state and dispositions. |

The codex and cursor plugins share the same job chassis: background jobs with progress-aware `status`, stored `result` output, model recording, `resume` handoffs into the native tool, and cancel that never kills a process it can't prove it owns.

## Quick start

Add the marketplace in Claude Code:

```bash
/plugin marketplace add zebbern/agent-collab
```

Install any of the plugins:

```bash
/plugin install codex@agent-collab
/plugin install cursor@agent-collab
/plugin install goal@agent-collab
```

Reload, then check readiness:

```bash
/reload-plugins
/codex:setup
/cursor:setup
```

A first run that starts durable work you can collect after restarting Claude:

```bash
/codex:task --background --fresh map this repository's architecture and identify the main runtime entrypoints
```

Copy the returned job ID, close Claude, then reopen the same repository and run:

```bash
/codex:status <job-id> --wait
/codex:result <job-id>
```

> For the **official** OpenAI plugin instead of this fork, use `/plugin marketplace add openai/codex-plugin-cc`.

## Codex plugin

> [!IMPORTANT]
> **This is an unofficial fork.** It is not built, endorsed, or supported by OpenAI. It is a modified version of [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc) at v1.0.6, maintained by [@zebbern](https://github.com/zebbern). Report issues here, not to OpenAI.

<details>
<summary><b>What this fork changes</b> (see the <a href="plugins/codex/CHANGELOG.md">changelog</a> for detail)</summary>

- **Windows correctness**: the broker ownership registry works on win32 (POSIX permission checks gated off), registry lock contention handles Windows `EPERM` rename semantics, `taskkill`/`tasklist` bypass MSYS argument mangling, and the test suite passes on Windows (upstream fails 9 of its own tests there).
- **Durability**: `state.json` is written atomically under an exclusive lock; corrupt state/job files are quarantined and rebuilt; terminal jobs can never be resurrected by racing writers.
- **Observability**: `/codex:status` is progress-aware (file changes, command executions, token usage, `likely dead` detection); jobs record the model and reasoning effort they ran with; degraded transport is explicit and loud.
- **Quality of life**: `/codex:help`, richer `/codex:result` with `codex resume <session-id>` handoff, stale-CLI detection in `/codex:setup`, stderr noise collapsing.

</details>

**Requirements:** [Codex CLI](https://developers.openai.com/codex/cli/) (`npm install -g @openai/codex`) with a ChatGPT subscription or OpenAI API key, Node.js ≥ 20. (CI covers Linux and Windows; macOS is supported in code but not CI-verified.)

### Commands

| Command | What it does |
| --- | --- |
| `/codex:review` | Read-only review of your working tree or branch (`--base <ref>`, `--background`) |
| `/codex:adversarial-review` | Steerable challenge review — takes focus text, questions design decisions |
| `/codex:task` | Delegate investigation, fixes, or follow-up work directly to Codex (`--background`, `--write`, resume/fresh, profile/model/effort flags) |
| `/codex:rescue` | Hand a task to Codex (`--profile <deep|fast>`, `--model`, `--effort`, `--resume`, `--background`) |
| `/codex:transfer` | Turn the current Claude session into a resumable Codex thread |
| `/codex:status` / `/codex:result` / `/codex:cancel` | Track, read, and stop background jobs |
| `/codex:setup` | Readiness check, install help, and the optional review gate |
| `/codex:doctor` | Read-only health report: CLI, auth, broker residue, and job-state hygiene |
| `/codex:help` | Full CLI usage |

<details>
<summary><b>Usage details and examples</b></summary>

#### `/codex:review`

Same review quality as running `/review` inside Codex directly. Use `--base <ref>` for branch review; `--wait` / `--background` control blocking. Read-only.

```bash
/codex:review
/codex:review --base main
/codex:review --background
```

#### `/codex:adversarial-review`

Pressure-tests assumptions, tradeoffs, failure modes, and alternatives. It uses the same review target selection as `/codex:review` (including `--base <ref>`), plus free-form focus text:

```bash
/codex:adversarial-review --base main challenge whether this was the right caching and retry design
/codex:adversarial-review --background look for race conditions and question the chosen approach
```

#### `/codex:task`

Delegate investigation, a fix request, or follow-up work directly to Codex. Without `--background`, the command stays in the foreground and returns Codex's output when it finishes. With `--background`, the companion starts a detached persistent worker and returns a job ID that remains available after you close Claude and reopen the same repository; use `/codex:status <job-id> --wait` and then `/codex:result <job-id>` to collect it.

Use `--write` only when Codex may modify the repository. `--resume` and `--resume-last` are aliases that continue the latest task from the current Claude session; `--fresh` starts a new thread. `--profile <deep|fast>` chooses paired model and effort defaults; `--model <model|spark>` and `--effort <none|minimal|low|medium|high|xhigh|max>` select or override them.

```bash
/codex:task map this repository's architecture and identify the main runtime entrypoints
/codex:task --background --fresh investigate why the tests started failing
/codex:task --write fix the failing test
/codex:task --resume-last apply the top fix from the last run
```

#### `/codex:rescue`

Delegates investigation or fixes through the `codex:codex-rescue` subagent — investigate a bug, try a fix, continue a previous Codex task, or take a cheaper pass with a smaller model:

```bash
/codex:rescue investigate why the tests started failing
/codex:rescue --resume apply the top fix from the last run
/codex:rescue --model spark fix the issue quickly
/codex:rescue --model gpt-5.4-mini --effort medium investigate the flaky test
/codex:rescue --profile deep audit the retry logic for correctness
/codex:rescue --profile fast rename this variable everywhere
```

You can also just ask: *"Ask Codex to redesign the database connection to be more resilient."*

**Notes:**

- if you do not pass `--model` or `--effort`, Codex chooses its own defaults.
- if you say `spark`, the plugin maps that to `gpt-5.3-codex-spark`
- follow-up rescue requests can continue the latest Codex task in the repo

#### `--profile` (task/rescue only)

`--profile <deep|fast>` sets a named default for `--model` and `--effort` together, on `task` (and `rescue`, which forwards to `task`) only — `review` and `adversarial-review` reject `--profile`:

| Profile | Model | Effort |
| --- | --- | --- |
| `deep` | `gpt-5.6-sol` | `xhigh` |
| `fast` | `gpt-5.3-codex-spark` (same target as `--model spark`) | `medium` |

Precedence: `--profile` supplies the defaults; an explicit `--model` on the same invocation overrides the profile's model, and an explicit `--effort` overrides the profile's effort — independently, so `--profile deep --model gpt-5.4-mini` keeps the `deep` profile's `xhigh` effort with a different model. No `--profile` and no explicit flags behaves exactly as before: Codex's own defaults apply.

#### `/codex:transfer`

Creates a persistent Codex thread from the current Claude Code session and prints `codex resume <session-id>`. The `SessionStart` hook supplies the transcript path automatically; `--source <path>` overrides it (must live under `~/.claude/projects`).

### `/codex:status`

Shows running and recent Codex jobs for the current repository — progress on background work, the latest completed job, and whether a task is still running.

```bash
/codex:status
/codex:status task-abc123
```

### `/codex:result`

Shows the final stored output for a finished job, including the Codex session ID so you can reopen the run with `codex resume <session-id>`.

```bash
/codex:result
/codex:result task-abc123
```

### `/codex:cancel`

Cancels an active background Codex job.

```bash
/codex:cancel
/codex:cancel task-abc123
```

### `/codex:setup`

Checks whether Codex is installed and authenticated. If Codex is missing and npm is available, it can offer to install Codex for you. If Codex is installed but not logged in yet, run:

```bash
!codex login
```

#### Review gate (optional, off by default)

```bash
/codex:setup --enable-review-gate
/codex:setup --disable-review-gate
```

When enabled, a `Stop` hook runs a targeted Codex review of Claude's response and blocks the stop if it finds issues.

> [!WARNING]
> The review gate can create a long-running Claude/Codex loop and drain usage limits quickly. Enable it only when actively monitoring the session.

#### Configuration

The plugin uses your local `codex` binary and [its configuration](https://developers.openai.com/codex/config-basic): user-level `~/.codex/config.toml`, with project-level `.codex/config.toml` overrides for [trusted projects](https://developers.openai.com/codex/config-advanced#project-config-files-codexconfigtoml). For example:

```toml
model = "gpt-5.4-mini"
model_reasoning_effort = "high"
```

Jobs record the model (and effort) they ran with — visible in `/codex:status` and `/codex:result`.

</details>

## Cursor plugin

Drives Cursor's headless [`cursor-agent`](https://cursor.com/docs/cli) CLI. Every job is a single tracked `cursor-agent` process — no shared runtime.

**Requirements:** `cursor-agent` (`curl https://cursor.com/install -fsS | bash`) signed in via `cursor-agent login`, and a Cursor subscription.

> [!NOTE]
> **Windows:** Cursor ships no native Windows CLI build. The plugin runs `cursor-agent` through **WSL** automatically — install it inside your distro with the same command. Workspace paths are translated (`C:\…` → `/mnt/c/…`) and the Linux-side agent is tracked and reaped on cancel.

### Commands

| Command | What it does |
| --- | --- |
| `/cursor:review` | Review of your working tree or branch (requested read-only — see Safety model) (`--base <ref>`, `--background`) |
| `/cursor:adversarial-review` | Steerable challenge review with focus text |
| `/cursor:task` | Delegate a task (`--model`, `--resume <chat-id>`, `--write`, `--background`) |
| `/cursor:rescue` | Hand a problem to the `cursor:cursor-rescue` subagent — investigate, fix, or continue with `--resume <chat-id>` |
| `/cursor:status` / `/cursor:result` / `/cursor:cancel` | Track, read, and stop background jobs |
| `/cursor:setup` | Readiness check with per-platform install guidance |
| `/cursor:doctor` | Read-only health report: CLI, auth, and job-state hygiene |
| `/cursor:help` | Full CLI usage |

### Models

Cursor defaults to **`auto`** (its server-side router). Pin one per invocation with `--model`:

```bash
/cursor:review --model claude-opus-5-thinking-high
/cursor:task --model gpt-5.3-codex fix the failing test
```

`cursor-agent --list-models` shows the current roster. Jobs record the resolved model, token usage, and reasoning summaries from the stream.

### Safety model

- Reviews are **requested to run read-only**, but Cursor does not provide an
  enforced read-only sandbox in this mode (it runs with `--trust` and without
  `--force`). Two partial mitigations, described precisely because neither is
  a guarantee:
  - Reviews run **from a disposable git worktree**, so the agent's *default*
    write target is a throwaway copy — this stops stray relative-path writes
    (the failure actually observed). It is **not a sandbox**: absolute paths
    still reach anywhere, and a worktree shares your `.git`.
  - The plugin fingerprints the working tree around each review and
    **reports git-visible changes** the agent made. This is the real signal,
    and it does not cover git-ignored files (e.g. `.env`, build output).
  Tasks are not sandboxed either: Cursor can modify files even without
  `--write`, and task runs have no workspace-drift check. `--write` only
  removes Cursor's per-command confirmation by adding `--force`; use it only
  when the user clearly requested edits.
- Cancel **proves ownership before killing anything**: workers persist a process identity at start (Unix start-time identity, or `(pid, CreationDate)` on Windows), a stale or reused PID is never killed, and a job with no recorded proof fails closed as `cleanup-pending`.
- On WSL, cancel reaps the Linux-side agent **inside the distro first** (verifying `/proc` cmdline before signalling, TERM→KILL), because `taskkill` cannot terminate `wsl.exe` relay processes — then confirms the worker's exit by identity, not PID liveness.

## Trust, data, and cost boundaries

- Delegated prompts and any repository context the provider CLI reads leave
  Claude Code for OpenAI or Cursor under your existing local account and
  provider configuration. Apply the same data-handling rules you use when
  running those CLIs directly.
- Delegation job records and private logs can contain prompts, results, source
  excerpts, and local paths. They are retained under
  `~/.claude/codex-companion` and `~/.claude/cursor-companion`; Goal's local
  ledger lives under `~/.claude/goal-companion`. Treat all three as sensitive
  artifacts.
- Ambient delegation can start usage-billed work. It announces each handoff,
  but does not ask for a second confirmation; tell Claude not to delegate when
  you want the current session to stay within Claude. The opt-in review gate
  can also loop and consume Claude and Codex usage until its stop condition
  is satisfied.
- Goal files are repository content. A command-kind acceptance criterion runs
  through the shell with the same trust level as an npm script, so inspect
  goals from an untrusted checkout before running `/goal:step` or `check`.

## Ambient delegation

You don't have to type the commands yourself. Each plugin ships a delegation skill that triggers on task shape, so Claude can reach for Codex or Cursor on its own — a deep second opinion or security pass toward Codex, fast parallel implementation toward Cursor — announcing the handoff in one line, never silently. Jobs run in the background, and `status --wait` issued as a background task closes the loop: Claude picks up the result when the job finishes, without you polling.

`task --background` uses a companion-owned detached worker and survives the
Claude session that launched it. Reviews detach as Claude background tasks
instead; they remain session-scoped and should be collected before ending the
session.

```text
You:    While you refactor the lock, get a second opinion on the cancel path.
Claude: Delegating a review of the cancel path to Codex in the background.
        …keeps refactoring; the finished job wakes it up…
Claude: Codex found two issues in the cancel path. Findings below — nothing
        has been applied; tell me which ones to fix.
```

Review findings are never auto-applied, and if a delegated run fails, Claude reports the failure instead of passing off its own output as the delegate's.

## Goal plugin

Set a long-horizon goal once, then advance it one increment at a time — in
session, with you watching. `/goal:set` writes a schema-validated, git-tracked
goal file (`.claude/goals/<slug>.json`) with a ranked backlog and acceptance
criteria; `/goal:step` picks the next increment deterministically, executes it
(delegating to Codex or Cursor through the same skills as above), lands the
change as a PR through your normal gates, and records what actually happened
— merged, discarded, or blocked — in the goal file and an append-only ledger.
The companion enforces the honest parts mechanically: one in-progress item at
a time, refusals with specifics instead of silent repair, and a blocked goal
is a full stop until a human resolves it. `/goal:step` also runs unattended
(via `/loop` or a scheduled agent): it never merges a PR itself, and the next
wake reconciles that PR before starting another increment.

```bash
/plugin install goal@agent-collab
/goal:set    # interview → validated goal file
/goal:step   # advance exactly one increment
/goal:status
/goal:retro  # analyze the ledger, propose policy changes as a PR
```

## How it works

Both delegation plugins share a hardened job chassis:

- **Detached task jobs** — `task --background` is tracked outside the Claude session that started it, remains visible to later sessions, and can still be cancelled by verified process ownership.
- **Progress-aware status** — live phase, file-change/command/token telemetry, last-activity signals, and `likely dead` detection for stalled jobs.
- **Stored results** — `result` renders the final output with files changed, reasoning summaries, the model that produced it, and a resume command (`codex resume <id>` / `cursor-agent --resume <id>`) to continue in the native tool.
- **Race-safe state** — an exclusive lock plus a terminal-status merge guard make it impossible for a racing progress write to resurrect a cancelled job.

## Development

```bash
npm ci
npm test          # node --test tests/*.test.mjs
npm run build     # regenerates app-server types + tsc checkJs
npm run verify    # local gate: versions + build + native suite + dockerized Linux suite
```

- **CI** runs the full suite on `ubuntu-latest` and `windows-latest`, plus a required Node 20 floor leg, for every push and PR. Tests never require a real Codex/Cursor login — fake fixtures on `PATH` stand in for both CLIs.
- **Startup baseline gate** (opt-in, not part of `npm test`/`npm run verify` — see [ADR 0008](docs/adr/0008-startup-baseline-gate.md)):
  ```bash
  npm run startup:baseline   # pin docs/startup-baseline.json from this machine's accumulated startup metrics
  npm run startup:compare    # compare current metrics against that baseline; non-zero only past threshold
  ```
  Timings are machine-specific, so this never gates a merge — run it by hand when you care whether a change moved spawn→ready overhead. `--compare` refuses to judge a `(plugin, transport)` cell with fewer than 5 samples on either side (reported `UNCOMPARABLE`, never silently passed or failed); if no cell qualifies, it says so and exits 0 rather than implying a pass.
- **Layout:** `plugins/codex` and `plugins/cursor` are self-contained Claude Code plugins; `tests/` covers both; `.claude-plugin/marketplace.json` is the marketplace manifest.
- Windows contributors: everything works from Git Bash; npm scripts are shell-agnostic.

## License & attribution

[Apache-2.0](LICENSE). The `codex` plugin is a modified version of [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc) (© 2026 OpenAI, Apache-2.0) — see [NOTICE](NOTICE) and the per-plugin changelogs for the modification history. The `cursor` plugin is original to this repository. Not affiliated with, endorsed by, or supported by OpenAI or Cursor (Anysphere).
