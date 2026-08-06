// Review isolation: cursor reviews run the agent inside a disposable git
// worktree so an agent that ignores "read-only" cannot write into the user's
// tree. These tests pin that the worktree reproduces what is being reviewed
// (including uncommitted state), that writes land in the throwaway copy, that
// failures fall back HONESTLY rather than silently, and that nothing leaks.
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { initGitRepo, makeTempDir, run } from "./helpers.mjs";
import {
  createReviewWorktree,
  pruneStaleReviewWorktrees,
  removeReviewWorktree
} from "../plugins/codex/scripts/lib/git.mjs";

function makeRepo({ dirty = false } = {}) {
  const repo = makeTempDir("wt-review-repo-");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "app.js"), "export const value = 1;\n");
  run("git", ["add", "app.js"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  if (dirty) {
    fs.writeFileSync(path.join(repo, "app.js"), "export const value = 2; // UNCOMMITTED\n");
    fs.writeFileSync(path.join(repo, "untracked.js"), "// UNTRACKED_MARKER\n");
    fs.mkdirSync(path.join(repo, "nested"), { recursive: true });
    fs.writeFileSync(path.join(repo, "nested", "deep.js"), "// NESTED_UNTRACKED\n");
  }
  return repo;
}

test("a branch-scope worktree checks out HEAD without the uncommitted state", (t) => {
  const repo = makeRepo({ dirty: true });
  const worktree = createReviewWorktree(repo, { includeUncommitted: false });
  t.after(() => removeReviewWorktree(worktree));
  assert.equal(worktree.isolated, true, worktree.reason ?? "");

  // Committed content only — the dirty edit and untracked files stay out.
  assert.match(fs.readFileSync(path.join(worktree.path, "app.js"), "utf8"), /value = 1/);
  assert.equal(fs.existsSync(path.join(worktree.path, "untracked.js")), false);
});

test("a working-tree worktree reproduces uncommitted tracked AND untracked state", (t) => {
  const repo = makeRepo({ dirty: true });
  const worktree = createReviewWorktree(repo, { includeUncommitted: true });
  t.after(() => removeReviewWorktree(worktree));
  assert.equal(worktree.isolated, true, worktree.reason ?? "");

  // Without this, a working-tree review would review the wrong content.
  assert.match(fs.readFileSync(path.join(worktree.path, "app.js"), "utf8"), /UNCOMMITTED/);
  assert.match(fs.readFileSync(path.join(worktree.path, "untracked.js"), "utf8"), /UNTRACKED_MARKER/);
  assert.match(fs.readFileSync(path.join(worktree.path, "nested", "deep.js"), "utf8"), /NESTED_UNTRACKED/);
  // The patch file used to materialize state must not be left behind.
  assert.equal(fs.existsSync(path.join(worktree.path, ".agent-collab-review.patch")), false);
});

test("incomplete materialization fails closed instead of claiming success", () => {
  const repo = makeTempDir("wt-review-untracked-fail-");
  const worktree = createReviewWorktree(repo, {
    includeUncommitted: true,
    gitImpl: (args) => {
      if (args[0] === "rev-parse") {
        return { status: 0, stdout: "abc123\n", stderr: "", error: null };
      }
      if (args.includes("ls-files")) {
        // Enumerating untracked files fails: reviewing a tree quietly missing
        // the user's new files while reporting success is a silent negative.
        return { status: 128, stdout: "", stderr: "fatal: simulated ls-files failure", error: null };
      }
      return { status: 0, stdout: "", stderr: "", error: null };
    }
  });

  assert.equal(worktree.isolated, false);
  assert.match(worktree.reason, /simulated ls-files failure/);
});

test("an untracked symlink is not copied through into the worktree", (t) => {
  const repo = makeRepo({ dirty: true });
  const outside = makeTempDir("wt-review-outside-");
  const secret = path.join(outside, "outside.txt");
  fs.writeFileSync(secret, "OUTSIDE_CONTENT\n");
  try {
    fs.symlinkSync(secret, path.join(repo, "link.txt"));
  } catch (error) {
    if (error?.code === "EPERM" || error?.code === "EACCES") {
      t.skip("Symlink creation requires elevated privileges on this platform.");
      return;
    }
    throw error;
  }

  const worktree = createReviewWorktree(repo, { includeUncommitted: true });
  t.after(() => removeReviewWorktree(worktree));
  assert.equal(worktree.isolated, true, worktree.reason ?? "");

  // Copying through the link would write outside the disposable tree.
  assert.equal(fs.existsSync(path.join(worktree.path, "link.txt")), false);
});

test("relative agent writes land in the worktree, not the real repository", (t) => {
  const repo = makeRepo({ dirty: true });
  const worktree = createReviewWorktree(repo, { includeUncommitted: true });
  t.after(() => removeReviewWorktree(worktree));

  // This is the blast-radius property the worktree actually provides: an
  // agent writing at RELATIVE paths (the observed live incident) lands in the
  // throwaway copy. It is not a sandbox — under --trust an absolute path
  // still reaches the real tree — which is why drift detection stays the
  // containment signal and the docs say so.
  fs.writeFileSync(path.join(worktree.path, "agent-scratch.sh"), "#!/bin/sh\n");
  fs.writeFileSync(path.join(worktree.path, "app.js"), "export const value = 999; // AGENT EDIT\n");

  assert.equal(fs.existsSync(path.join(repo, "agent-scratch.sh")), false);
  assert.doesNotMatch(fs.readFileSync(path.join(repo, "app.js"), "utf8"), /AGENT EDIT/);
  // The user's own uncommitted work is untouched.
  assert.match(fs.readFileSync(path.join(repo, "app.js"), "utf8"), /UNCOMMITTED/);
});

test("isolation reports failure honestly instead of pretending", () => {
  // A repo with no commits has no HEAD to check out.
  const empty = makeTempDir("wt-review-empty-");
  initGitRepo(empty);
  const worktree = createReviewWorktree(empty, { includeUncommitted: true });

  assert.equal(worktree.isolated, false);
  assert.equal(worktree.path, null);
  assert.match(worktree.reason, /no commits/i);
});

test("a failed worktree add reports the reason and leaves no directory behind", () => {
  // git is fully faked here, so no real repository is needed — keeping this
  // file's git load low matters: it runs alongside the state-lock contention
  // tests, which legitimately lose updates when the machine is starved.
  const repo = makeTempDir("wt-review-fake-");
  const created = [];
  const worktree = createReviewWorktree(repo, {
    includeUncommitted: false,
    gitImpl: (args, cwd) => {
      if (args[0] === "rev-parse") {
        return { status: 0, stdout: "abc123\n", stderr: "", error: null };
      }
      if (args[0] === "worktree" && args[1] === "add") {
        created.push(args[3]);
        return { status: 128, stdout: "", stderr: "fatal: simulated worktree failure", error: null };
      }
      return { status: 0, stdout: "", stderr: "", error: null };
    }
  });

  assert.equal(worktree.isolated, false);
  assert.match(worktree.reason, /simulated worktree failure/);
  // The temp directory reserved for the attempt is cleaned up.
  for (const dir of created) {
    assert.equal(fs.existsSync(dir), false, dir);
  }
});

test("removeReviewWorktree deletes the worktree and deregisters it", () => {
  const repo = makeRepo();
  const worktree = createReviewWorktree(repo, { includeUncommitted: false });
  assert.equal(worktree.isolated, true, worktree.reason ?? "");
  const worktreePath = worktree.path;

  removeReviewWorktree(worktree);

  assert.equal(fs.existsSync(worktreePath), false);
  const list = run("git", ["worktree", "list"], { cwd: repo });
  assert.doesNotMatch(list.stdout, /agent-collab-review-wt-/);
});

test("stale worktrees from killed runs are swept, fresh ones are kept", () => {
  // The sweep only shells out to deregister worktrees; fake git keeps this
  // test off the real git path entirely.
  const repo = makeTempDir("wt-review-sweep-repo-");
  const gitImpl = () => ({ status: 0, stdout: "", stderr: "", error: null });
  const tmpRoot = makeTempDir("wt-review-sweep-");
  const stale = path.join(tmpRoot, "agent-collab-review-wt-stale");
  const fresh = path.join(tmpRoot, "agent-collab-review-wt-fresh");
  const bystander = path.join(tmpRoot, "someone-elses-dir");
  for (const dir of [stale, fresh, bystander]) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "marker"), "x");
  }
  const old = new Date(Date.now() - 24 * 60 * 60 * 1000);
  fs.utimesSync(stale, old, old);

  const result = pruneStaleReviewWorktrees(repo, { tmpRoot, maxAgeMs: 60 * 60 * 1000, gitImpl });

  assert.equal(result.pruned, 1);
  assert.equal(fs.existsSync(stale), false);
  // A review still running must not have its worktree yanked away.
  assert.equal(fs.existsSync(fresh), true);
  // Unrelated directories are never touched.
  assert.equal(fs.existsSync(bystander), true);
});

test("materialization survives hostile gitconfig and non-ASCII untracked paths", (t) => {
  const repo = makeRepo();
  // Config values that are individually reasonable but each break a naive
  // diff/apply round trip: verified to produce "git diff header lacks
  // filename information", ANSI escapes in the patch, and C-quoted paths.
  for (const [key, value] of [
    ["diff.noprefix", "true"],
    ["diff.mnemonicPrefix", "true"],
    ["color.ui", "always"],
    ["core.quotepath", "true"]
  ]) {
    run("git", ["config", key, value], { cwd: repo });
  }
  fs.writeFileSync(path.join(repo, "app.js"), "export const value = 2; // UNCOMMITTED\n");
  fs.writeFileSync(path.join(repo, "café.txt"), "// NON_ASCII_UNTRACKED\n");

  const worktree = createReviewWorktree(repo, { includeUncommitted: true });
  t.after(() => removeReviewWorktree(worktree));

  assert.equal(worktree.isolated, true, worktree.reason ?? "");
  assert.match(fs.readFileSync(path.join(worktree.path, "app.js"), "utf8"), /UNCOMMITTED/);
  // A C-quoted path would have been silently dropped — a silent negative.
  assert.match(fs.readFileSync(path.join(worktree.path, "café.txt"), "utf8"), /NON_ASCII_UNTRACKED/);
});

test("the WSL gitdir pointer is translated so git works inside the distro", (t) => {
  const repo = makeRepo();
  const worktree = createReviewWorktree(repo, {
    includeUncommitted: false,
    // Mirrors winPathToWsl: C:\foo -> /mnt/c/foo. A Windows path in the
    // pointer file makes git inside WSL fail "not a git repository"
    // (verified live), so the translation is load-bearing on win32.
    translateGitdir: (gitdir) => {
      const normalized = gitdir.replace(/\\/g, "/");
      const match = normalized.match(/^([A-Za-z]):(\/.*)?$/);
      return match ? `/mnt/${match[1].toLowerCase()}${match[2] ?? "/"}` : normalized;
    }
  });
  t.after(() => removeReviewWorktree(worktree));
  assert.equal(worktree.isolated, true, worktree.reason ?? "");

  const pointer = fs.readFileSync(path.join(worktree.path, ".git"), "utf8");
  assert.match(pointer, /^gitdir: /);
  assert.doesNotMatch(pointer, /^gitdir: [A-Za-z]:/);
});
