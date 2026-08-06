# 0002. Cancel by process identity, never by bare PID

- Status: Accepted
- Date: 2026-08-07

## Context

Cancelling a background job means killing a process recorded earlier — but a
recorded PID is not a process. PIDs are reused, so by cancel time a bare PID
may name an unrelated process. On Windows, `taskkill` cannot terminate
`wsl.exe` relay processes or sandboxed `codex.exe` children ("operation is not
supported"), so "kill the PID and check liveness" fails twice over: the kill
may not land, and liveness of the PID proves nothing about the worker.

## Decision

Cancel proves ownership before killing anything.

- Workers persist a process identity at start: a Unix start-time identity, or
  `(pid, CreationDate)` on Windows from a CIM probe
  (`probeWindowsProcessIdentity`). The probe is tri-state —
  `ok`/`absent`/`unavailable` — and probe failure is never treated as evidence
  of death. A process's own identity is self-computed without a shell
  (`~`-marked, compared with ±5s tolerance).
- On WSL, cancel reaps the Linux-side agent inside the distro first, verified
  by `(pid, /proc starttime)` identity — not just a cmdline substring — with
  TERM→KILL escalation; the Windows worker's exit is then confirmed by
  identity, never by raw PID liveness.
- A job with no recorded proof fails closed as `cleanup-pending` instead of
  being blindly terminated. The only exemption from the identity requirement
  is a live `ChildProcess` handle the owner still holds
  (`ownerHoldsLiveHandle`).

## Consequences

- A stale or reused PID is never killed; cancel prefers refusing
  (`cleanup-pending`) over guessing.
- Synthetic job records in tests must carry the same ownership fields real
  workers write, or cancel paths correctly refuse them.
- Both plugins share this identity discipline; it is part of the mirrored
  chassis contract.
