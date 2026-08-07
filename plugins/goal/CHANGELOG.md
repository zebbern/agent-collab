# Changelog

## 0.1.0

- Initial release: attended `/goal` loop. A schema-validated, git-tracked goal file (`.claude/goals/<slug>.json`) with a ranked backlog; deterministic next-increment selection; mechanical one-increment-at-a-time enforcement; dispositions recorded in the goal file and an append-only machine-local ledger; `check` runs command-kind acceptance criteria by exit code. Delegation happens through the codex/cursor delegation skills — this plugin spawns no workers of its own.
