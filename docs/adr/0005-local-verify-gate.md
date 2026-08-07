# 0005. Local verify gate

- Status: Accepted
- Date: 2026-08-07

## Context

GitHub Actions dispatch is intermittent for this repo: on 2026-08-07 alone it
both dispatched runs normally (morning) and silently failed to dispatch for
new pushes (afternoon, observed while merging the PRs this ADR shipped with).
Availability is not something a merge gate may assume. A single-platform run also under-covers: the Windows suite skips ~40
win32-guarded tests, which only actually execute on Linux, so nothing forced
the full two-platform picture to exist before a merge was proposed.

## Decision

`npm run verify` (`scripts/verify.mjs`) is the pre-merge gate, with three
legs: the build (app-server types + tsc checkJs), the native suite on the
host platform, and the full suite inside docker `node:22` — the same image
that reproduces ubuntu CI behavior exactly. The two suite legs together cover
more than either platform alone.

Reporting rule: a skipped leg is never reported as a pass. If the Linux leg
cannot run (`--no-linux`, or docker unavailable), the summary says UNVERIFIED
and the gate is INCOMPLETE — the same "unknown is not healthy" doctrine the
runtime code follows. A leg killed by a signal is reported as an error, not
conflated with a test failure.

Operational details, each found the hard way: the repo is mounted read-only
and copied inside the container so the container never writes into the
working tree; the suite's TAP output stays inside the container with only a
summary echoed (streaming it back reproducibly flaked 7 timing-sensitive
broker e2e tests — pipe backpressure, not correctness); a short settle window
separates the legs because the suites spawn real detached processes and
back-to-back legs measure contention instead of correctness.

## Known blind spot: checkout conversion

Both suite legs read the same bytes — the native run reads the working tree
directly, and the docker run reads a copy of it. Neither observes what git
hands a *fresh checkout on another platform*. So the gate is evidence about
**content**, never about **checkout conversion**.

This is not hypothetical. On 2026-08-07, hours after this ADR landed, a doc
pin matching a literal `\n` across a line break turned `windows-latest` CI
red while the local gate stayed fully green: CI checks out CRLF, the working
tree was LF, and `and\n` cannot match `and\r\n`. A `.gitattributes`
normalizing all text to LF now removes that class repo-wide, which matters
here more than in most repos — doc tests pin exact strings, and
`tests/chassis-drift.test.mjs` hashes the payload of a `git diff` between the
two mirrored lib copies, so byte-level guards must not vary by platform.

The general lesson stands regardless of that particular fix: a green local
gate is not a substitute for CI, it is a filter that makes CI's answer
cheaper to reach. Where the two disagree, CI is looking at something the
gate structurally cannot see.

## Consequences

- Merges are gated locally before anything is pushed; PR CI (ubuntu +
  windows) remains the required remote check when it dispatches, and it is
  the authority on anything checkout-shaped.
- Skipping the docker leg is possible but loud: the exit is 0, the verdict is
  INCOMPLETE, and the leg reads UNVERIFIED.
- "Gate: PASSED" means every leg actually ran and passed — over one set of
  bytes, on one checkout.
