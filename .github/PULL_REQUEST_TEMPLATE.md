## What and why

<!-- What changes, and what problem it solves. -->

## Checklist

- [ ] `npm test` passes, verified by exit code (not by grepping output)
- [ ] Chassis changes landed in BOTH `plugins/codex/scripts/lib/` and
      `plugins/cursor/scripts/lib/` (`process.mjs` stays byte-identical;
      intentional divergence updates the pin table in
      `tests/chassis-drift.test.mjs` in the same commit)
- [ ] Behavior changes come with tests, following the suite's existing idioms
      (fake CLI fixtures, temp-dir isolation, win32 skip guards)
- [ ] Doc edits ran the doc-contract tests (`tests/commands.test.mjs`,
      `tests/cursor-skills.test.mjs`)
- [ ] The changed feature was live-fired against a real CLI and the observed
      output is included below
- [ ] Plain commit messages — no AI attribution, in commits or this PR body

## Live-fire output

<!-- Paste the observed output of actually running the changed feature. -->
