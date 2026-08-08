# Resurrection bench — pilot report (2026-08-08)

The first controlled experiment on this repo's orchestration layer: 3
resurrection tasks (real defects from this repo's own history, all past every
model's training cutoff), 2 arms (solo Claude vs Claude+codex-delegation),
3 repeats, headless `claude -p` runs at the pre-fix commit with symptom-only
prompts, mechanically scored against bench-owned behavior-level ground truth.

**Verdict up front: the floor did its job.** One task produced a comparable
result; two were honestly refused. Where comparison was possible, delegation
added no fix-rate benefit and cost ~30% more wall time.

## The one comparable cell pair

| d3-eperm-rename | solo | codex |
|---|---|---|
| valid runs | 3/3 | 3/3 |
| primary (ground truth) | **3/3** | **3/3** |
| median duration | 369s | 480s |
| median claude cost | $0.95 | $0.85 |
| delegated jobs | 0 (proven) | 3/3 runs delegated (proven) |

Both arms fixed the Windows rename-contention crash every single time, from
the symptom alone. On this task the delegation arm's extra machinery bought
nothing measurable and cost ~110s of median wall time. n=3 per cell — a
direction, not a law.

## The two refused tasks, and why (this is data too)

- **d1-enametoolong: UNCOMPARABLE — the 10-minute cap is the binding
  constraint, not ability.** Solo fixed it in *3 of 3* runs — but not one
  run *exited* inside the cap (`timeout` status with `groundTruth.pass:
  true`, all three). Codex-arm: 2/3 ground-truth passes (1 complete, 1
  timeout-with-pass). The aggregate counts only `complete` runs as valid, so
  the cell is refused — correctly: "fixed but couldn't stop verifying in
  time" is a different claim than "fixed within protocol."
- **d2-job-refs: UNCOMPARABLE — the solo cell died to harness environment,
  not agent performance.** All 3 solo runs went `invalid-baseline`: the
  parent-era cursor suite (pre-hermeticity, pre-#35) flaked under load even
  with a settled retry. Codex-arm ran (1/3 ground-truth pass — notably weak
  on the archaeologically "fairest" task) but with no solo cell there is no
  comparison to report.

## Timeout-with-pass, stated explicitly

4 runs across d1 carry `timeout` status with passing ground truth. They are
excluded from primary fractions by protocol, and reported here so the signal
is not buried: the agents could fix d1; they could not finish inside 10
minutes.

## Cost

$8.38 total claude spend across the 18 current records (145 turns), plus
$1.22 for the smoke run. Cost was **measurable** on this account (API
billing). Delegated codex tokens are recorded in the raw records and are
**not priced** — no invented rate card.

## Caveats (inherited from the bench's design, stated per doctrine)

- The worktree is blast-radius reduction, **not a sandbox**; main-repo
  fingerprints were captured around every run and recorded no drift.
- Results are one machine, one day, n=3 per cell. Nothing here generalizes
  beyond "on these tasks, on this setup."
- Two wave-1 d1-solo records predate the phantom-delegation fix; their
  `delegation` fields are contaminated by parent-era test residue (their
  ground-truth/cost/duration fields are unaffected). All post-fix solo
  records show zero delegated jobs; all 9 codex-arm runs show ≥1 — the arms
  provably differed.
- Contamination: the defects are days old (past training cutoffs) and runs
  had no web access, but the agents DO see the repo's overall style and the
  fix-adjacent code that shipped before the parent commits.

## What the pilot proved about the harness itself

Three confounds were caught by the validity machinery, fixed, and the
affected runs redone (all raw waves archived in the records):

1. Parent-era suites absorb the live session's env (the #35 class, replayed
   through a time machine) → every scoring phase now runs isolated.
2. The agent *running the repo's own tests* wrote job records that read as
   phantom delegations → 6 false arm-leaks; the state-root era split now
   separates agent-ambient writes from harvested delegation roots.
3. The pre-run baseline gate lacked the settled retry the post-run check
   had → added; d2's parent suite still flaked through it (see follow-ups).

## Follow-ups the data itself proposes

1. **Raise d1's `claudeMs`** (manifest property) to ~20 min and rerun d1
   both arms — the current cap measures patience, not capability.
2. **Stabilize d2's baseline**: pin the parent-era regression suite for d2
   to its state-focused tests, or pre-warm the suite once before gating —
   the full cursor e2e suite at 59e190c is not load-stable on this machine.
3. Only after both: a rerun matrix where all three tasks can report.

Raw records: `bench-pilot-2026-08-08.records.jsonl` beside this file
(current wave; earlier waves archived with their confounds intact in
`bench/results/records-*archive*.jsonl`, gitignored). Aggregate output
reproducible via `node bench/aggregate.mjs --results bench/results`.
