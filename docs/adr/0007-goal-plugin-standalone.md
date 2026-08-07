# 0007. Goal plugin opts out of the mirrored chassis

- Status: Accepted
- Date: 2026-08-07

## Context

The codex and cursor plugins mirror a job chassis (ADR 0001) because both
spawn and track background worker processes: job-control, cancel-by-identity,
and race-safe state all exist to make that safe. The goal plugin (ADR 0006's
next step — long-horizon goals advanced one increment at a time) needs none
of that. It never spawns a worker of its own; when an increment warrants
delegation, Claude invokes the existing `codex-delegation` / `cursor-delegation`
skills exactly as it would ambiently, and the goal companion only reads and
writes a schema-validated goal file plus an append-only ledger. The question
was whether to fold the goal plugin into the mirrored-chassis pattern anyway
for consistency, or let it stand apart.

## Decision

The goal plugin is architecturally standalone, deliberately:

- **No chassis.** It carries none of `job-control.mjs`, cancel, or process
  identity — there is no process to own or kill. Claude is the coupling layer:
  it executes increments with judgment and reaches for a delegate plugin when
  warranted, but the goal companion itself never shells out to `codex` or
  `cursor-agent`. Either delegate plugin can be absent; the goal plugin
  degrades to local work or an honest `blocked` disposition.
- **Attended-only v1 with single-writer state.** The companion assumes one
  session at a time and skips the siblings' lock machinery entirely — writes
  are tmp-file-plus-rename atomic, but nothing arbitrates concurrent writers.
  Git catches the rest: the goal file is ordinary project content, so a
  conflicting edit surfaces as a merge conflict, not silent corruption. The
  unattended, multi-writer case is a bounded, known upgrade (adopt the
  sibling lock pattern) — not a gap this version pretends to close.
- **`blocked` is a full stop, enforced twice.** `validateGoal` refuses to load
  or save a goal that is `active` while any backlog item is `blocked`, and
  `close --done` independently refuses on any blocked item even if a
  hand-edited file slipped past the first gate. Resolution requires a human
  to edit the file (move the item back to `todo`, or drop it) and re-run
  `set` — there is no mechanical unblock.

## Consequences

- The chassis drift guard (`tests/chassis-drift.test.mjs`) never gains a goal
  entry — there is nothing to mirror, so the pin table stays untouched.
- `goal` still joins the import-closure guard: no imports across
  `plugins/*`, same self-containment rule as the mirrored plugins, for a
  different reason (it has no sibling copy to drift from, but it must still
  install standalone from the marketplace).
- If the goal plugin ever needs to spawn its own long-running work instead of
  routing through the delegation skills, that is a new architectural
  decision, not an extension of this one — it would need to adopt (or
  re-derive) the ownership and cancel invariants ADR 0001/0002 exist to
  provide.
