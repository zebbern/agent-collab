// Bench worktrees, mirroring the shape of
// plugins/cursor/scripts/lib/git.mjs's createReviewWorktree — but pinned to
// an ARBITRARY commit (parentSha or fixSha) rather than always HEAD, since
// the whole point of the bench is comparing behavior across two historical
// commits of this same repository.
//
// Same doctrine as createReviewWorktree's doc comment (adapted): this is a
// blast-radius reduction, NOT a sandbox. It stops an agent's relative-path
// writes from landing in the real repo, but a git worktree deliberately
// shares the real .git (refs, objects, hooks, config all reachable), and an
// absolute-path write is not contained at all. Workspace-drift detection
// (captureWorkingTreeFingerprint / detectWorkspaceDrift, re-exported below)
// on the REAL repo stays the actual containment signal for a live run.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runCommand } from "../../plugins/cursor/scripts/lib/process.mjs";
import {
  removeReviewWorktree,
  captureWorkingTreeFingerprint,
  captureWorkingTreeFingerprintSafe,
  detectWorkspaceDrift,
  diffWorkingTreeFingerprints
} from "../../plugins/cursor/scripts/lib/git.mjs";

export { removeReviewWorktree, captureWorkingTreeFingerprint, captureWorkingTreeFingerprintSafe, detectWorkspaceDrift, diffWorkingTreeFingerprints };

const BENCH_WORKTREE_PREFIX = "agent-collab-bench-wt-";
const STALE_BENCH_WORKTREE_MS = 6 * 60 * 60 * 1000;

function git(cwd, args) {
  return runCommand("git", args, { cwd, shell: false });
}

/**
 * Creates a disposable worktree of `repoRoot` checked out (detached) at
 * `sha`. Every failure path reports a reason so the caller can fall back and
 * say so, rather than silently proceeding against the wrong tree.
 */
export function createBenchWorktree(repoRoot, sha, tmpRoot) {
  if (!sha || typeof sha !== "string") {
    return { path: null, isolated: false, reason: "sha is required" };
  }
  const resolved = git(repoRoot, ["rev-parse", "--verify", `${sha}^{commit}`]);
  if (resolved.status !== 0) {
    return { path: null, isolated: false, reason: `sha "${sha}" does not resolve to a commit in this repository` };
  }

  let worktreePath = null;
  try {
    worktreePath = fs.mkdtempSync(path.join(tmpRoot ?? os.tmpdir(), BENCH_WORKTREE_PREFIX));
    // mkdtemp created the directory; git worktree add requires it absent.
    fs.rmdirSync(worktreePath);
    const add = git(repoRoot, ["worktree", "add", "--detach", worktreePath, sha]);
    if (add.status !== 0) {
      throw new Error(add.stderr?.trim() || "git worktree add failed");
    }
    return { path: worktreePath, isolated: true, reason: null, repoRoot };
  } catch (error) {
    if (worktreePath) {
      removeReviewWorktree({ path: worktreePath, repoRoot });
    }
    return {
      path: null,
      isolated: false,
      reason: error instanceof Error ? error.message : String(error)
    };
  }
}

// A killed run (cancel, SIGKILL, a crashed claude invocation) can leave a
// worktree behind. Sweeping old ones on every --calibrate/live invocation
// converges residue without a cron job, same self-healing doctrine as
// pruneStaleReviewWorktrees.
export function pruneStaleBenchWorktrees(repoRoot, options = {}) {
  const tmpRoot = options.tmpRoot ?? os.tmpdir();
  const maxAgeMs = options.maxAgeMs ?? STALE_BENCH_WORKTREE_MS;
  const now = options.now ?? Date.now();
  let entries = [];
  try {
    entries = fs.readdirSync(tmpRoot, { withFileTypes: true });
  } catch {
    return { pruned: 0 };
  }
  let pruned = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(BENCH_WORKTREE_PREFIX)) {
      continue;
    }
    const full = path.join(tmpRoot, entry.name);
    try {
      if (now - fs.statSync(full).mtimeMs <= maxAgeMs) {
        continue;
      }
    } catch {
      continue;
    }
    removeReviewWorktree({ path: full, repoRoot });
    pruned += 1;
  }
  return { pruned };
}
