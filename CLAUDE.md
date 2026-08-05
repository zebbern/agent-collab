# CLAUDE.md

@AGENTS.md

Claude-specific notes on top of the shared agent guide:

- Model delegation (repo-specific working preferences, not plugin defaults):
  - Deep code analysis, architecture validation, security review, and
    high-stakes refactors → Codex with `--model gpt-5.6-sol --effort xhigh`;
    escalate to `--effort max` when a verdict still feels shallow.
  - Fast iteration, everyday implementation, scaffolding, and the standing
    pre-merge reviews → Cursor with `--model cursor-grok-4.5-high-fast`.
  - Escalation rule: when a task that started on the Cursor model turns out
    to need deep analysis or security judgement, hand it to Codex Sol
    rather than pushing the faster model further.
  - Both model ids and the `max` effort tier were live-verified against the
    real CLIs on 2026-08-05 (codex-cli 0.146.0); re-verify before assuming
    newer names.
- Key references (read on demand, not imported): README.md for the user-facing
  docs, plugins/*/CHANGELOG.md for history, tests/chassis-drift.test.mjs for
  the current divergence pins.
