// Moves file content between the real repository and a bench worktree
// without ever `git checkout`-ing the fix commit into that worktree — the
// worktree stays pinned at whatever sha createBenchWorktree checked out
// (parentSha for the arms under test, fixSha for GREEN calibration), and
// individual paths are transplanted in as plain file writes via `git show`.
import fs from "node:fs";
import path from "node:path";

import { runCommand } from "../../plugins/cursor/scripts/lib/process.mjs";

function git(cwd, args) {
  return runCommand("git", args, { cwd, shell: false });
}

/**
 * Writes the content of each `path` as it existed at `fixSha` into
 * `worktreePath`, read via `git show <fixSha>:<path>` against `repoRoot`
 * (never a checkout of the fix commit). Throws naming the exact path on any
 * failure — a silently-skipped transplant would make a GREEN calibration
 * lie about what actually got fixed.
 */
export function transplantFromFix(repoRoot, fixSha, paths, worktreePath) {
  const written = [];
  for (const relPath of paths ?? []) {
    const show = git(repoRoot, ["show", `${fixSha}:${relPath}`]);
    if (show.status !== 0) {
      throw new Error(
        `git show ${fixSha}:${relPath} failed: ${show.stderr?.trim() || show.error?.message || `exit ${show.status}`}`
      );
    }
    const destination = path.join(worktreePath, relPath);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, show.stdout, "utf8");
    written.push(relPath);
  }
  return written;
}

function copyPairs(taskDir, worktreePath, pairs) {
  const copied = [];
  for (const { from, to } of pairs ?? []) {
    const source = path.join(taskDir, from);
    const destination = path.join(worktreePath, to);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination);
    copied.push(to);
  }
  return copied;
}

/**
 * Copies manifest.groundTruth.tests, manifest.groundTruth.fixtures, and (if
 * present) manifest.classBonus.tests from the task directory to their "to"
 * paths inside the worktree.
 */
export function copyGroundTruth(taskDir, manifest, worktreePath) {
  return [
    ...copyPairs(taskDir, worktreePath, manifest?.groundTruth?.tests),
    ...copyPairs(taskDir, worktreePath, manifest?.groundTruth?.fixtures),
    ...copyPairs(taskDir, worktreePath, manifest?.classBonus?.tests)
  ];
}

/**
 * Undoes manifest.originalStrict.transplantFromFix inside a worktree: a path
 * that git considers tracked-and-modified is restored via `git checkout --`
 * (returning it to whatever the worktree's own checked-out sha holds); a
 * path git considers untracked (the transplant introduced a file that did
 * not exist at the worktree's sha) is deleted outright. A path with no
 * pending change is left alone.
 */
export function removeTransplants(worktreePath, manifest) {
  const paths = manifest?.originalStrict?.transplantFromFix ?? [];
  const restored = [];
  const deleted = [];
  for (const relPath of paths) {
    const status = git(worktreePath, ["status", "--porcelain", "--", relPath]);
    const line = status.stdout.trim();
    if (line === "") {
      continue;
    }
    if (line.startsWith("??")) {
      fs.rmSync(path.join(worktreePath, relPath), { force: true });
      deleted.push(relPath);
    } else {
      git(worktreePath, ["checkout", "--", relPath]);
      restored.push(relPath);
    }
  }
  return { restored, deleted };
}
