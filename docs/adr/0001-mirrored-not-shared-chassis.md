# 0001. Mirrored, not shared, chassis

- Status: Accepted
- Date: 2026-08-07

## Context

The codex and cursor plugins share a job chassis (background jobs, progress
status, stored results, ownership-verified cancel). A marketplace install
copies a single plugin directory, so each plugin must run standalone — no
imports across `plugins/*`. A shared lib would break that; independent copies
would silently diverge.

## Decision

Each plugin carries its own copy of the chassis modules under
`plugins/<name>/scripts/lib/`. Divergence is policed, not prevented:

- `tests/chassis-drift.test.mjs` diffs each module pair and hashes only the
  `+/-` payload lines against a `PINNED_DIVERGENCE` digest table (the
  empty-diff digest pins byte-identical pairs). A change mirrored identically
  into both copies leaves the payload untouched; a one-sided change fails the
  build. Every lib module must be either provider-only or a pinned pair, so
  new modules cannot escape the guard. Intentional divergence requires
  updating the pin in the same commit — every delta is a visible, reviewed
  decision.
- `npm run sync-chassis` mechanizes the mirror at author time: verbatim copies
  for identical modules, literal swaps for plugin-name literals (with a
  staleness check on the swap table), and a refusal to touch the genuinely
  divergent modules (`fs.mjs`, `job-control.mjs`, `render.mjs`), which are
  mirrored by hand.

The sync tool is deliberately not wired into the test pipeline: an auto-sync
at test time would turn the drift guard's loud tripwire into silent
working-tree mutation, and could revert an edit made to the non-canonical copy
while the suite goes green.

## Consequences

- Chassis fixes must land in both copies or the drift test fails.
- Duplication is the accepted cost of standalone installability.
- The drift guard stays an independent tripwire; the sync tool runs it as a
  check after copying, but never the other way around.
