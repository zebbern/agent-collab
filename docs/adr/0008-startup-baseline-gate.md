# 0008. Startup baseline/compare regression gate

- Status: Accepted
- Date: 2026-08-07

## Context

ADR 0004 instrumented spawn→ready startup overhead (`appendStartupMetric` /
`readStartupMetrics`, both plugins' `state.mjs`) to inform the Windows-broker
decision, and `/codex:doctor` / `/cursor:doctor` render the accumulated
n/median/p90 per transport. That made the data readable, but nothing pinned
a baseline: a regression — a broker change, a codex/cursor CLI upgrade, a
Windows update that slows process spawn — was visible only to someone who
happened to read the doctor numbers before and after. The data existed; the
gate did not.

## Decision

`scripts/startup-baseline.mjs` adds two opt-in modes, exposed as
`npm run startup:baseline` (`--save-baseline`) and `npm run startup:compare`
(`--compare`):

- **`--save-baseline`** reads current metrics from both plugins' state dirs
  for the workspace, computes n/median/p90 per `(plugin, transport)` cell
  using the *same* quantile pick `doctor.mjs`'s `buildStartupOverheadCheck`
  already renders, and writes it to the committed `docs/startup-baseline.json`.
  One statistics vocabulary, not two.
- **`--compare`** recomputes the current cells and reports per-cell deltas.
  A cell fails the gate only when its p90 regressed by more than 50% **and**
  by more than 250ms absolute (both flags overridable) — the AND keeps tiny,
  fast numbers (a few ms baseline) from tripping the gate on ordinary noise.

**Honesty floor.** A cell compares only when both the baseline and the
current run have at least 5 samples (`--min-samples`); short of that it is
reported `UNCOMPARABLE` and can never fail *or* silently pass the gate — a
cell missing entirely from one side reads as `n=0` on that side, which the
same floor naturally routes to `UNCOMPARABLE` rather than needing special
casing. If every cell in a run is `UNCOMPARABLE`, the report says so in
plain words ("nothing was verified") and exits 0 — never an implied pass. A
missing baseline file is a legitimate first-run state (same treatment); an
unreadable or malformed one is not, and is refused loudly (exit 1) rather
than silently treated as absent — "unknown is not healthy" applies to the
baseline file exactly as it does to the runtime code's own probes.

**Opt-in, not wired into `npm run verify`.** Startup timings are
machine-specific — a machine that happens to be under load, or just slower
than whatever machine cut the baseline, is not evidence of a code
regression. A merge gate that fails on machine variance trains people to
ignore it (cry wolf), which is worse than no gate. This stays a deliberate,
by-hand check, run when a change plausibly affects spawn→ready overhead.

## Consequences

- `docs/startup-baseline.json` is committed and updated deliberately via
  `npm run startup:baseline`, the same way `sync-chassis` output is
  regenerated deliberately rather than auto-applied.
- CI does not run this gate; it is a contributor tool, documented in
  README.md's Development section.
- The ADR 0004 data corpus now has a second consumer beyond `doctor`: it can
  be pinned and checked, not just read.
