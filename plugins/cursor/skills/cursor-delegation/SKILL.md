---
name: cursor-delegation
description: Use when a coding task would benefit from delegating work to Cursor in the background — fast parallel implementation, scaffolding, or an everyday review running while the session continues. Lets Claude drive the cursor companion itself (task, review, status --wait, result) without the user typing /cursor:* commands.
---

# Cursor Delegation

This skill is the policy and the loop for delegating work to Cursor without a `/cursor:*` command. Presenting output stays governed by the `cursor-result-handling` skill; prompt shape and model notes stay governed by the `cursor-prompting` skill. Do not duplicate either — defer to them.

## When to delegate — and when not

- Delegate when parallel speed adds real value: an implementation or scaffolding job that can run while the session continues on something else, or an everyday review of a substantive diff.
- Evidence note (portfolio retro, 2026-08-07): across the first 8 ledger dispositions Cursor was never exercised as a delegate, so its routing guidance rests on less evidence than Codex's — when an increment genuinely fits the profile above, prefer delegating it here over defaulting to local work, so the ledger accumulates the comparison the routing policy needs.
- Keep trivial work local. A rename, a one-file edit, a question Claude can answer directly — spawning a background agent there is overhead, not help.
- Bench evidence, 2026-08-08 (docs/bench-pilot-2026-08-08.md): on a well-localized single-file bugfix with a reproducible symptom, a delegation arm matched solo Claude's fix rate exactly while costing ~30% more wall time (measured on the codex arm; the shape lesson carries). Symptom-shaped bugfixes with a clear reproduction are solo work by default — this narrows the evidence note above to implementation and scaffolding increments, where the comparison data is still thin.
- Never delegate when the user explicitly asked Claude to do the work personally.
- Run one delegated job of a class at a time (one task, one review). Before firing a new one, run `status --json` and confirm nothing of the same class is still active.

## Disclosure

- Announce every delegation in one short line when starting it — what is being delegated and that it is going to Cursor. Never silently spawn CLI work.

## The loop: fire, await, collect

Fire — start the job in the background:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/cursor-companion.mjs" task --background [--write] [--profile deep|fast] [--model <model>] "<prompt>"
```

- The output line `started in the background as <jobId>` carries the job id. Record it.
- Add `--write` only when Cursor is supposed to edit files; it removes the per-command confirmation, so add it deliberately.
- This fire → await → collect loop is for `task` only. Reviews detach differently — see below.

Await — issue the wait as a background Bash task so the harness notifies on completion instead of blocking the session:

```typescript
Bash({
  command: `node "${CLAUDE_PLUGIN_ROOT}/scripts/cursor-companion.mjs" status <jobId> --wait --timeout-ms 1800000 --json`,
  description: "Await Cursor job",
  run_in_background: true
})
```

- On wake, parse the JSON. If `waitTimedOut` is true and the job is still active, re-issue the same wait instead of assuming failure — a timeout is not a verdict.

Collect — fetch the stored output once the job is terminal:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/cursor-companion.mjs" result <jobId> --json
```

- Present it per the `cursor-result-handling` skill — including its rule that review findings are never auto-applied: present them, stop, and ask which ones to fix.

## Reviews: one background step

`review` and `adversarial-review` have no companion-side enqueue: the companion parses `--background` but always runs the review in the foreground, and no `started in the background as <jobId>` line is printed. Delegate a review by running the whole command as a background Bash task — the wake IS the collect step, carrying the rendered review on stdout:

```typescript
Bash({
  command: `node "${CLAUDE_PLUGIN_ROOT}/scripts/cursor-companion.mjs" review [--base <ref>]`,
  description: "Cursor review in background",
  run_in_background: true
})
```

- `adversarial-review [--base <ref>] [focus text]` detaches the same way.
- The run still records a tracked job, so `status` and `result` work on it afterwards.

## Routing

- Fast implementation, scaffolding, everyday review → `task` or `review`.
- Leave the model unset by default — Cursor routes `auto` server-side. There is no `--effort` flag; depth is a model choice, and `--profile deep|fast` is a named shortcut for it on `task` only (`review`/`adversarial-review` reject `--profile`).

## Failure honesty

- If the companion errors, or Cursor was never actually invoked, report that plainly and stop. Never substitute Claude-authored output as the delegate's.
