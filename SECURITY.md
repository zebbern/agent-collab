# Security Policy

## Reporting a vulnerability

Please report vulnerabilities privately via GitHub:
**[Report a vulnerability](https://github.com/zebbern/agent-collab/security/advisories/new)**
(Security tab → "Report a vulnerability"). Do not open a public issue for
security problems.

You should get a first response within a week. Please include the OS
(Windows/WSL details matter here), the plugin (`codex` or `cursor`), and the
codex / cursor-agent CLI versions involved.

## Supported versions

Only the latest release on `main` is supported. There are no maintained
backport branches.

## Security-sensitive areas

If you are auditing this codebase, these are the places where a bug has
security consequences rather than just functional ones:

- `plugins/codex/scripts/lib/process.mjs` and
  `plugins/cursor/scripts/lib/process.mjs` — ownership-verified process
  termination. Every kill must prove `(pid, start time)` identity first;
  probe failure is never treated as evidence of death. A bug here can kill a
  process the plugin does not own.
- `plugins/cursor/scripts/lib/cursor.mjs` — the WSL relay and
  identity-verified agent reaping, plus the pidfile that crosses the
  DrvFs boundary. Headless cursor-agent runs use `--trust`, which suppresses
  its confirmation prompts; write mode additionally passes `--force`.
- The cancel paths in `plugins/codex/scripts/codex-companion.mjs` and
  `plugins/cursor/scripts/cursor-companion.mjs` — fail-closed cancellation
  gates and the job records they trust.
- The review workspace-drift check (`git.mjs`) — Cursor reviews have no
  enforced read-only sandbox, so this is a **drift-detection** layer, not a
  containment one: it snapshots the working tree around a review and reports
  git-visible changes the agent made. It does not cover git-ignored files
  (e.g. `.env`, build output), and it detects rather than prevents. (Codex
  reviews, by contrast, run in the app-server's enforced read-only sandbox.)
- `plugins/*/scripts/lib/state.mjs` — the state directory holds job records
  and logs containing prompts and results.

## Design principles

- Fail closed: no kill, cleanup, or cancel completes without proof of
  ownership; unknown state is reported as unknown, never as healthy or clean.
- Agents are treated as untrusted: their **git-visible** workspace writes are
  detected and reported (git-ignored paths are out of scope), and their output
  is parsed defensively.
- No process-name sweeps: only processes that wrote ownership records are
  ever touched.
