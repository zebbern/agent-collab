---
name: codex-delegation
description: Use when a coding task would benefit from delegating work to Codex in the background — a deep independent second opinion, security or architecture analysis, or a parallel implementation running while the session continues. Lets Claude drive the codex companion itself (task, review, status --wait, result) without the user typing /codex:* commands.
---

# Codex Delegation

This skill is the policy and the loop for delegating work to Codex without a `/codex:*` command. Presenting output stays governed by the `codex-result-handling` skill; prompt shape stays governed by the `gpt-5-4-prompting` skill. Do not duplicate either — defer to them.

## When to delegate — and when not

- Delegate when an independent deep pass adds real value: a second opinion on a risky change, security or architecture analysis, an adversarial review of a substantive diff, or an implementation that can run in parallel while the session continues on something else.
- Keep trivial work local. A rename, a one-file edit, a question Claude can answer directly — spawning a background agent there is overhead, not help.
- Bench evidence, 2026-08-08 (docs/bench-pilot-2026-08-08.md): on a well-localized single-file bugfix with a reproducible symptom, a Codex-delegation arm matched solo Claude's fix rate exactly (3/3 both arms) while costing ~30% more wall time. Symptom-shaped bugfixes with a clear reproduction are solo work by default; delegation earns its overhead in the niches above — independent deep review, second opinions on risky changes, parallel work the session does not wait on.
- Never delegate when the user explicitly asked Claude to do the work personally.
- Run one delegated job of a class at a time (one task, one review). Before firing a new one, run `status --json` and confirm nothing of the same class is still active.

## Disclosure

- Announce every delegation in one short line when starting it — what is being delegated and that it is going to Codex. Never silently spawn CLI work.

## The loop: fire, await, collect

Fire — start the job in the background:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" task --background [--write] [--profile <deep|fast>] [--effort <tier>] "<prompt>"
```

- The output line `started in the background as <jobId>` carries the job id. Record it.
- Add `--write` only when Codex is supposed to edit files; leave it off for analysis and second opinions.
- `--profile <deep|fast>` is accepted on `task` (and its `rescue` forwarder) only; `review` and `adversarial-review` reject it.
- This fire → await → collect loop is for `task` only. Reviews detach differently — see below.

Await — issue the wait as a background Bash task so the harness notifies on completion instead of blocking the session:

```typescript
Bash({
  command: `node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" status <jobId> --wait --timeout-ms 1800000 --json`,
  description: "Await Codex job",
  run_in_background: true
})
```

- On wake, parse the JSON. If `waitTimedOut` is true and the job is still active, re-issue the same wait instead of assuming failure — a timeout is not a verdict.

Collect — fetch the stored output once the job is terminal:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" result <jobId> --json
```

- Present it per the `codex-result-handling` skill — including its rule that review findings are never auto-applied: present them, stop, and ask which ones to fix.

## Reviews: one background step

`review` and `adversarial-review` have no companion-side enqueue: the companion parses `--background` but always runs the review in the foreground, and no `started in the background as <jobId>` line is printed. Delegate a review by running the whole command as a background Bash task — the wake IS the collect step, carrying the rendered review on stdout:

```typescript
Bash({
  command: `node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" review [--base <ref>]`,
  description: "Codex review in background",
  run_in_background: true
})
```

- `adversarial-review [--base <ref>] [focus text]` detaches the same way.
- The run still records a tracked job, so `status` and `result` work on it afterwards.

## Brief shape

- Prefer a **design-to-verdict** brief for analysis delegations — hand Codex a
  concrete design and ask for numbered verdicts and corrections — over an
  open-ended "design everything" ask. When a delegated run goes likely-dead
  or hangs, refine by **narrowing** the ask (and dropping to `--effort high`
  for verdict checks), never by re-sending the same brief. Ledger evidence,
  2026-08-07: two open-ended `xhigh` analysis briefs died or hung; both
  narrowed re-delegations returned approve-with-corrections and merged.

## Routing

- Deep analysis, security review, architecture validation → `task` or `adversarial-review`; raise `--effort` when a verdict needs more depth.
- Leave model and effort unset by default — Codex chooses its own defaults.

## Failure honesty

- If the companion errors, or Codex was never actually invoked, report that plainly and stop. Never substitute Claude-authored output as the delegate's.
