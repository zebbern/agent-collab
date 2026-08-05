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
[How it works](#how-it-works) •
[Development](#development) •
[License](#license--attribution)

</div>

---

One marketplace, two plugins:

| Plugin | Delegates to | Highlights |
| --- | --- | --- |
| **`codex`** | [OpenAI Codex](https://developers.openai.com/codex/) (`codex` CLI) | `/codex:review`, `/codex:adversarial-review`, `/codex:rescue`, session transfer, optional stop-review gate. Community fork of [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc) with Windows fixes. |
| **`cursor`** | [Cursor](https://cursor.com) (`cursor-agent` CLI) | `/cursor:review`, `/cursor:task`, ownership-verified cancel, WSL support on Windows, resolved-model + token-usage recording. |

Both share the same job chassis: background jobs with progress-aware `status`, stored `result` output, model recording, `resume` handoffs into the native tool, and cancel that never kills a process it can't prove it owns.

## Quick start

Add the marketplace in Claude Code:

```bash
/plugin marketplace add zebbern/agent-collab
```

Install one or both plugins:

```bash
/plugin install codex@agent-collab
/plugin install cursor@agent-collab
```

Reload, then check readiness:

```bash
/reload-plugins
/codex:setup
/cursor:setup
```

A first run that shows the whole loop:

```bash
/codex:review --background
/codex:status
/codex:result
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

**Requirements:** [Codex CLI](https://developers.openai.com/codex/cli/) (`npm install -g @openai/codex`) with a ChatGPT subscription or OpenAI API key, Node.js ≥ 18.18.

### Commands

| Command | What it does |
| --- | --- |
| `/codex:review` | Read-only review of your working tree or branch (`--base <ref>`, `--background`) |
| `/codex:adversarial-review` | Steerable challenge review — takes focus text, questions design decisions |
| `/codex:rescue` | Hand a task to Codex (`--model`, `--effort`, `--resume`, `--background`) |
| `/codex:transfer` | Turn the current Claude session into a resumable Codex thread |
| `/codex:status` / `/codex:result` / `/codex:cancel` | Track, read, and stop background jobs |
| `/codex:setup` | Readiness check, install help, and the optional review gate |
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

#### `/codex:rescue`

Delegates investigation or fixes through the `codex:codex-rescue` subagent — investigate a bug, try a fix, continue a previous Codex task, or take a cheaper pass with a smaller model:

```bash
/codex:rescue investigate why the tests started failing
/codex:rescue --resume apply the top fix from the last run
/codex:rescue --model spark fix the issue quickly
/codex:rescue --model gpt-5.4-mini --effort medium investigate the flaky test
```

You can also just ask: *"Ask Codex to redesign the database connection to be more resilient."*

**Notes:**

- if you do not pass `--model` or `--effort`, Codex chooses its own defaults.
- if you say `spark`, the plugin maps that to `gpt-5.3-codex-spark`
- follow-up rescue requests can continue the latest Codex task in the repo

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
| `/cursor:review` | Read-only review of your working tree or branch (`--base <ref>`, `--background`) |
| `/cursor:adversarial-review` | Steerable challenge review with focus text |
| `/cursor:task` | Delegate a task (`--model`, `--resume <chat-id>`, `--write`, `--background`) |
| `/cursor:status` / `/cursor:result` / `/cursor:cancel` | Track, read, and stop background jobs |
| `/cursor:setup` | Readiness check with per-platform install guidance |
| `/cursor:help` | Full CLI usage |

### Models

Cursor defaults to **`auto`** (its server-side router). Pin one per invocation with `--model`:

```bash
/cursor:review --model claude-opus-5-thinking-high
/cursor:task --model gpt-5.3-codex fix the failing test
```

`cursor-agent --list-models` shows the current roster. Jobs record the resolved model, token usage, and reasoning summaries from the stream.

### Safety model

- Reviews run **read-only**; write mode is opt-in per task (`--write`).
- Cancel **proves ownership before killing anything**: workers persist a process identity at start (Unix start-time identity, or `(pid, CreationDate)` on Windows), a stale or reused PID is never killed, and a job with no recorded proof fails closed as `cleanup-pending`.
- On WSL, cancel reaps the Linux-side agent **inside the distro first** (verifying `/proc` cmdline before signalling, TERM→KILL), because `taskkill` cannot terminate `wsl.exe` relay processes — then confirms the worker's exit by identity, not PID liveness.

## How it works

Both plugins share a hardened job chassis:

- **Background jobs** — spawn, track, and detach; jobs survive the Claude session that started them.
- **Progress-aware status** — live phase, file-change/command/token telemetry, last-activity signals, and `likely dead` detection for stalled jobs.
- **Stored results** — `result` renders the final output with files changed, reasoning summaries, the model that produced it, and a resume command (`codex resume <id>` / `cursor-agent --resume <id>`) to continue in the native tool.
- **Race-safe state** — an exclusive lock plus a terminal-status merge guard make it impossible for a racing progress write to resurrect a cancelled job.

## Development

```bash
npm ci
npm test          # node --test tests/*.test.mjs
npm run build     # regenerates app-server types + tsc checkJs
```

- **CI** runs the full suite on `ubuntu-latest` and `windows-latest` for every push and PR (~300 tests). Tests never require a real Codex/Cursor login — fake fixtures on `PATH` stand in for both CLIs.
- **Layout:** `plugins/codex` and `plugins/cursor` are self-contained Claude Code plugins; `tests/` covers both; `.claude-plugin/marketplace.json` is the marketplace manifest.
- Windows contributors: everything works from Git Bash; npm scripts are shell-agnostic.

## License & attribution

[Apache-2.0](LICENSE). The `codex` plugin is a modified version of [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc) (© 2026 OpenAI, Apache-2.0) — see [NOTICE](NOTICE) and the per-plugin changelogs for the modification history. The `cursor` plugin is original to this repository. Not affiliated with, endorsed by, or supported by OpenAI or Cursor (Anysphere).
