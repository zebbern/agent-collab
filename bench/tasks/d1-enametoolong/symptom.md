Running `/cursor:review` over a large working-tree diff dies before the agent
starts: `spawn ENAMETOOLONG`; small diffs are fine; observed live 2026-08-07
on Windows.

Fix the underlying defect in this repository. Run the relevant existing tests
to check your work.
