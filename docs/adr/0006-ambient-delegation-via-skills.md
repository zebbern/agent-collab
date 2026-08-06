# 0006. Ambient delegation via skills, not an MCP server

- Status: Accepted
- Date: 2026-08-07

## Context

Delegation today rides slash commands: `/codex:*` and `/cursor:*` have Claude
run the companion CLIs (`codex-companion.mjs` / `cursor-companion.mjs`) via
Bash. We want delegation to become ambient — Claude reaching for Codex or
Cursor when the task shape warrants it, without the user typing a command.
Two routes were considered: an MCP server exposing typed delegation tools, or
skills layered over the existing Bash mechanics.

## Decision

Ambient delegation uses skills plus the wait mechanics that already exist,
shipped as the `codex-delegation` and `cursor-delegation` skills:

- Always-visible skill descriptions trigger on task shape ("a coding task
  would benefit from delegating work ... in the background"), not on a
  command name.
- Claude fires the companion CLIs via Bash exactly as the slash commands do
  (`task --background` enqueues a detached worker; reviews, which have no
  companion-side enqueue, run as a single background Bash step); no new
  invocation path.
- Completion awareness comes from `status <jobId> --wait --timeout-ms ...
  --json` run as a background Bash task, so the harness notifies Claude when
  the job lands; a `waitTimedOut` wake on a still-active job re-issues the
  wait rather than assuming failure.
- Policy rides in the skill: every delegation is announced in one line (never
  silently spawn CLI work), one delegated job of a class at a time, no
  delegation when the user asked Claude to do the work personally, and a
  companion error is reported plainly — Claude-authored output is never
  substituted as the delegate's.

An MCP server was considered — typed tools and always-on discoverability —
and rejected for now. Its costs: a resident process per session, schema token
cost in every session, and a second control surface that would have to
re-prove the cancel/ownership invariants the CLIs already enforce. All of
that buys capabilities already reachable via Bash.

## Consequences

- No new process, protocol surface, or invocation path; the companion CLI
  remains the single enforcement point for ownership, cancel, and state.
- Presentation and prompt shape stay governed by the existing
  result-handling and prompting skills — the delegation skill defers rather
  than duplicating them.
- Discoverability rests on skill descriptions triggering reliably; that is
  the weak point to watch. Revisit the MCP route if skill-triggered
  delegation proves unreliable at firing on the right task shapes.
