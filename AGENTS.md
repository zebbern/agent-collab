# agent-collab — Agent Guide

Claude Code marketplace with two plugins that delegate work to other AI coding
agents: `plugins/codex` (community fork of openai/codex-plugin-cc) and
`plugins/cursor` (drives Cursor's `cursor-agent` CLI). Plain Node `.mjs` with
JSDoc types — no build step for runtime code, no dependencies beyond dev tools.

## Commands

```bash
npm run verify                          # THE pre-merge gate: versions + build + native suite + Linux suite in docker
npm test                                # full suite (~2 min; caps file concurrency at 8)
node --test tests/<file>.test.mjs       # one file
node --test --test-name-pattern="..." tests/<file>.test.mjs   # one test
npm run build                           # regenerates app-server types + tsc checkJs
```

- Verify test results by **exit code**, never by grepping output.
- `tests/runtime-*.test.mjs` and the cancel e2e tests spawn real detached
  processes; prefer targeted patterns while iterating, but run the full suite
  (or rely on CI) before claiming a semantics change is safe — "targeted" has
  missed pinned contracts before.
- `npm test` runs `scripts/run-tests.mjs`, which caps file concurrency at
  `min(cores, 8)`. The process-spawning e2e tests starve their detached
  workers under unbounded parallelism on high-core machines (a 32-core box
  would run 32 files at once), so a ceiling is required — but a hardcoded
  `--test-concurrency=8` is an absolute value, not a max, and would *raise*
  concurrency on a 2-core CI runner, oversubscribing it and blowing the state
  lock's warn-and-proceed timeout (lost updates in the concurrency test). The
  runner's `min(cores, 8)` caps high-core boxes without ever inflating
  low-core ones. Run a single file directly with `node --test tests/<f>`.
- Linux behavior is reproduced exactly by `docker run node:22` with the repo
  copied in; ubuntu CI will agree with it.
- **`npm run verify` is the local merge gate; `Required CI` is the
  complementary remote gate and must be required in branch protection.** The local gate runs version metadata, build,
  the native suite, and the full suite on Linux in docker (the Linux leg runs
  the ~40 win32-guarded tests the Windows run skips, so the two legs together
  cover more than either alone). A leg that cannot run is reported
  `UNVERIFIED`, the gate prints `INCOMPLETE`, and the process exits 2 — never
  silently "passed" to a human or automation. Run
  `npm run verify:no-linux` only when deliberately skipping docker.
- Do **not** stream the docker leg's TAP output back over inherited stdio.
  Doing so reproducibly failed 7 timing-sensitive shared-broker e2e tests that
  pass every time otherwise — the pipe backpressure was being measured, not
  the code. `scripts/verify.mjs` keeps that output inside the container and
  echoes only a summary.

## Hard rules

- **`main` is branch-protected.** Direct pushes are rejected, even for admins.
  Work on a branch, open a PR, and use `gh pr merge --auto --squash`; the
  `Required CI` aggregate (Ubuntu, Windows, and the Node 20 floor) must pass. Watch runs with
  `gh run watch --exit-status <run-id>` for the head SHA — do not poll
  PR-level check summaries (they show stale results right after a push).
- **Plain commit messages. No AI attribution** — no Co-Authored-By trailers,
  no "Generated with" lines, in commits or PR bodies.
- **The chassis is mirrored, not shared.** Plugin directories must be
  self-contained (no imports across `plugins/*`), so both plugins carry copies
  of the shared lib modules. Any chassis change must land in BOTH
  `plugins/codex/scripts/lib/` and `plugins/cursor/scripts/lib/`, or
  `tests/chassis-drift.test.mjs` fails. Intentional divergence requires
  updating that file's pin table in the same commit. After editing a chassis
  module, run `npm run sync-chassis` (codex → cursor; `-- --from cursor` to
  reverse): it copies the byte-identical and literal-swap modules, refuses to
  touch the genuinely-divergent ones (`fs.mjs`, `job-control.mjs`,
  `render.mjs` — mirror those by hand), and runs the drift guard. The drift
  test remains an independent tripwire; do not wire the sync into it.
- **Docs are contract-tested.** `tests/commands.test.mjs` pins exact strings in
  README.md, command files, and skills; `tests/cursor-skills.test.mjs` pins the
  cursor trio. Editing docs can break tests — run them.
- **Tests are required** for behavior changes, mirroring the suite's existing
  idioms (fake CLI fixtures, temp-dir isolation, win32 skip guards). Tests
  that cannot hold on Windows use the sibling skip style
  (`t.skip("Unix ... are required for this contract.")`) — never delete or
  weaken a guard to make a platform pass.
- The two plugins' state dirs stay separate: ONE canonical per-user root each
  (`~/.claude/codex-companion` vs `~/.claude/cursor-companion`; goal uses
  `~/.claude/goal-companion`). Ambient `CLAUDE_PLUGIN_DATA` is NEVER consulted
  for root selection — it names whichever install's hook exported it last and
  split state across invocation contexts (fixed 2026-08-07); it survives only
  as a legacy migration source. Tests isolate via
  `CODEX_COMPANION_STATE_ROOT`/`CURSOR_COMPANION_STATE_ROOT`/
  `GOAL_COMPANION_STATE_ROOT` pointed at temp dirs — a state-touching test
  file without the override writes to the real per-user root.

## Platform facts (learned the hard way — do not rediscover)

- Cursor ships **no native Windows CLI**; the cursor plugin runs `cursor-agent`
  through WSL (`wsl -e`, argv only, never a shell string). Headless runs need
  `--trust`. The npm package named `cursor-agent` is third-party — not Cursor.
- `taskkill` cannot terminate `wsl.exe` relay processes or sandboxed
  `codex.exe` children ("operation is not supported"). Cancel therefore kills
  the payload first (WSL reap / cancel flag) and confirms the worker's own
  exit by identity, never by raw PID liveness.
- Windows process identity is `(pid, CreationDate)`: exact values come from a
  CIM probe (`probeWindowsProcessIdentity`, tri-state ok/absent/unavailable —
  probe failure is NOT evidence of death); a process's own identity is
  self-computed without a shell (`~`-marked, compared with ±5s tolerance).
  Never blind-kill a bare PID; the only exemption is a live ChildProcess
  handle (`ownerHoldsLiveHandle`).
- Tests never invoke the real codex/cursor CLIs: fake fixtures
  (`tests/fake-codex-fixture.mjs`, `tests/fake-cursor-agent-fixture.mjs`) go
  on a prepended PATH. Synthetic job records in tests must carry the same
  ownership fields real workers write (identity, snapshot) or cancel paths
  will correctly refuse them.
- npm scripts must stay shell-agnostic (cmd.exe is npm's default shell on
  Windows — no `mkdir -p`, no POSIX-isms).

## Working style

- **Live-fire what you change.** After tests pass, run the actual feature —
  a real `/codex:*` or `/cursor:*` invocation against this repo — and report
  observed output. Every major defect in this repo's history was found by a
  live run, not a test. Cursor reviews are cheap on
  `--model cursor-grok-4.5-high-fast`; substantive diffs get one before merge.
- Real runs over green mocks: a large green suite is not evidence that
  integrations work. Watch for silent negatives (empty results that mean
  "never checked", not "nothing there").
- Fix the class, not the instance: when a bug follows a pattern, search for
  and fix the other occurrences in the same change — proportionally, without
  turning a fix into a refactor.
- Claimed vs wired: no half-features. Either the call sites, control paths,
  and cancel/status handling exist end-to-end, or the claim doesn't land.
- Think before coding: state assumptions, surface tradeoffs, ask when
  interpretations diverge. Simplicity first — minimum code that solves the
  problem, no speculative flexibility. Surgical changes — every changed line
  traces to the task; clean up only your own orphans.
- Verify against current reality, not memory: for SDKs, CLIs, and protocol
  surfaces, probe the real tool or fetch current docs before building on
  assumptions (this repo exists because upstream docs and reality diverged).
