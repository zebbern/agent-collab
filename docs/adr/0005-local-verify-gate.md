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

## Consequences

- Merges are gated locally before anything is pushed; PR CI (ubuntu +
  windows) remains the required remote check when it dispatches.
- Skipping the docker leg is possible but loud: the exit is 0, the verdict is
  INCOMPLETE, and the leg reads UNVERIFIED.
- "Gate: PASSED" means every leg actually ran and passed.
