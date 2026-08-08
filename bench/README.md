# resurrection-bench

A bench for one question: **when a real historical bug in this repository has
already been fixed, does an agent that can delegate to Codex reproduce that
fix faster / more completely than an agent working alone?**

Each bench task picks one real commit `fixSha` that resolved a real bug, and
its immediate parent `parentSha` (the bug's last-known-bad state). An agent is
handed `parentSha` and a symptom description (`symptom.md`, deliberately
scrubbed of any string in the task's `forbiddenSymptomStrings` so it cannot
just quote the fix back), then scored against ground-truth tests the fix
actually made pass. Two arms are compared per task: **solo** (every
delegation plugin disabled) and **codex** (the codex plugin enabled). See
`bench/tasks/<id>/manifest.json` for the exact per-task contract (owned by a
separate agent/PR from this harness).

## What this increment ships

Everything except spawning a live `claude` process:

- `bench/lib/manifest.mjs` — the manifest schema and loader.
- `bench/lib/worktree.mjs` — disposable git worktrees pinned at an arbitrary
  commit (parentSha or fixSha), not always HEAD.
- `bench/lib/transplant.mjs` — moving individual files between the real repo
  and a worktree via `git show`, never a checkout of the fix commit.
- `bench/lib/headless.mjs` — the pure pieces of a headless `claude` invocation
  (arm settings, exact argv, environment scrubbing, result parsing).
- `bench/lib/score.mjs` — running `node --test`, parsing TAP, diffing two TAP
  runs for newly-passing tests.
- `bench/lib/telemetry.mjs` — harvesting delegated-job token/model/effort data
  out of an isolated `CLAUDE_PLUGIN_DATA` directory.
- `bench/lib/report.mjs` — the JSONL run-record schema.
- `bench/run-bench.mjs` — `--calibrate` (fully implemented: proves every
  task's manifest is RED at `parentSha` and GREEN at `fixSha`) and the
  live-run orchestration skeleton (guarded off — see below).
- `bench/aggregate.mjs` — turns `bench/results/*.jsonl` into a per-(task, arm)
  report.

Running `run-bench.mjs` without `--calibrate` prints `live runs land in
increment 2` and exits 1. The orchestration for that path — seed a worktree
per arm, invoke `claude`, score against ground truth, harvest telemetry,
append a record — is designed across the lib modules above but is not yet
wired to an actual `claude` subprocess; see the `TODO(increment 2)` block in
`run-bench.mjs`'s `runLive`.

## Usage

```bash
# Prove every task's manifest is trustworthy (RED at parentSha, GREEN at
# fixSha) before ever running an agent against it.
node bench/run-bench.mjs --calibrate
node bench/run-bench.mjs --calibrate --task <id>

# Turn accumulated run records into a report (once increment 2 ships).
node bench/aggregate.mjs
node bench/aggregate.mjs --file bench/results/records.jsonl --min-samples 2
```

## Honesty caveats

**A bench worktree is blast-radius reduction, not a sandbox.** Running an
agent inside a disposable `git worktree` stops the observed failure mode — an
agent writing scratch files or edits at *relative* paths landing in the real
repository — but it does **not** stop a determined or confused agent: a
worktree deliberately shares the real repo's `.git` (refs, objects, hooks,
config are all reachable from inside it), and an *absolute*-path write is not
contained at all. `--driftCheckRequired` tasks fingerprint the real repo's
working tree before and after a run specifically because the worktree cannot
be trusted as a boundary on its own — the fingerprint diff is the actual
containment signal, and a failure to snapshot it is reported as
`mainRepoDrift: unverified`, never as "clean."

**Subscription-account cost is structurally unmeasured, not "free."** When the
`claude` CLI runs against a flat-rate/subscription account, `claude -p
--output-format json` reports `total_cost_usd: 0` for a run that clearly took
turns and tokens. `parseClaudeResult` in `bench/lib/headless.mjs` flags this
as `costMeasurable: false` rather than recording it as a genuinely zero-cost
run — a report that averaged it in as $0 would be actively misleading, not
merely incomplete.

**Delegated (Codex) tokens are never priced by this bench.** `telemetry.mjs`
sums whatever `totalTokens` a delegated job recorded, but that number has no
dollar figure attached here — Codex/Codex-CLI pricing is a separate account
and a separate rate card from the Claude subscription the bench measures. The
`codex` arm's `delegation.totalTokens` in a run record is a raw token count
for later manual costing, not a cost the bench itself claims to know.
