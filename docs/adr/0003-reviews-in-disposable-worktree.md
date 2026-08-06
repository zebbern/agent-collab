# 0003. Reviews run from a disposable git worktree

- Status: Accepted
- Date: 2026-08-07

## Context

Cursor provides no enforced read-only sandbox for reviews: `cursor-agent`
runs with `--trust` and without `--force`, and a live review once created
files in the user's tree. Workspace-drift detection (fingerprint the tree,
report git-visible changes) shipped earlier; it detects writes but does not
redirect them.

## Decision

The cursor review agent runs inside a throwaway git worktree checked out at
HEAD. Working-tree-scope reviews materialize the uncommitted state into it
(tracked changes as a binary patch, plus untracked files) so the reviewed
content is unchanged; review content is still collected from the real repo.
On WSL, the worktree's `.git` pointer file is rewritten to the translated
path, without which git inside the distro fails "not a git repository".
Isolation failures never pretend: any git error falls back to the real repo
and says so in the progress line, the rendered output, and the
`reviewWorkspace` payload field (`disposable-worktree` | `repository`).
Cleanup runs in a `finally`, and each review sweeps worktrees leaked by
previously killed runs. Codex reviews are deliberately unchanged: the
app-server already runs them with a read-only sandbox, so a worktree would
add cost, not containment.

What this guarantees — and does not: the worktree redirects the agent's
*default* write target, so relative-path writes (the failure actually
observed) land in the throwaway copy and are deleted with it. It is **not a
sandbox**: the worktree shares the real `.git`, and under `--trust` absolute
paths still reach the real tree. Drift detection on the real repo remains the
actual containment signal, and it does not cover git-ignored files.

## Consequences

- Blast-radius reduction, stated precisely everywhere — the first commit
  overclaimed ("physically impossible") and was corrected in review.
- Untracked symlinks are not copied through (that would write outside the
  disposable tree); materialization fails closed if untracked enumeration
  fails; `tests/review-worktree.test.mjs` pins the property that actually
  holds.
