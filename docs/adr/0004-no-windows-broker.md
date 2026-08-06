# 0004. No Windows broker (for now)

- Status: Accepted
- Date: 2026-08-07

## Context

The codex app-server broker (shared runtime) is Unix-only:
`ensureBrokerSession` returns null on win32 ("unsupported on Windows"), and
Windows jobs run a private process each. The open question was whether to
build a Windows named-pipe broker to amortize per-job startup. Nobody had the
data: the only duration persisted anywhere was cursor's self-reported turn
time (dominated by model thinking), and job records prune at 50, so nothing
accumulated.

## Decision

Instrument first, decide from data. `appendStartupMetric` /
`readStartupMetrics` (in `state.mjs`, both plugins) record spawn→ready
overhead durably: an append-only `metrics.jsonl` in the state dir, written
`0o600`, size-rotated once past 512KB under the state lock (readers span
`.old` plus current), kept deliberately outside the 50-job prune window, and
best-effort — metrics never sink the run that produced them. Codex times the
app-server connect (process spawn or broker socket attach plus the initialize
handshake) tagged by transport; cursor times spawn→init tagged wsl/native,
gated on the agent's `init` event so `--resume` runs are measured correctly.
Both segments exclude model time. The doctor `startup-overhead` check renders
n/median/p90 per transport — always informational, never a health failure.

The data so far: codex direct connect on this machine was 451ms; cursor WSL
spawn→init was 5807ms, with a later live-fired cold task at 5728ms and a
resume at 4297ms. Codex per-job startup on Windows is cheap — little for a
broker to amortize — and the dominant startup cost is the WSL agent boot on
the cursor side, which a codex broker cannot touch.

Decision: do not build the Windows broker. Revisit if the accumulated metrics
change the picture.

## Consequences

- Windows keeps the private-process transport; the broker remains Unix-only.
- The metrics corpus keeps growing and stays readable via `/codex:doctor` and
  `/cursor:doctor`, so the decision is revisable with data, not intuition.
