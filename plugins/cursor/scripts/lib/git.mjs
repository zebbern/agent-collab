import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { isProbablyText } from "./fs.mjs";
import { formatCommandFailure, runCommand, runCommandChecked } from "./process.mjs";

const MAX_UNTRACKED_BYTES = 24 * 1024;
const DEFAULT_INLINE_DIFF_MAX_FILES = 2;
const DEFAULT_INLINE_DIFF_MAX_BYTES = 256 * 1024;

// Git is directly executable on Windows. Repository-derived arguments must never pass through a shell.
function git(cwd, args, options = {}) {
  return runCommand("git", args, { cwd, ...options, shell: false });
}

function gitChecked(cwd, args, options = {}) {
  return runCommandChecked("git", args, { cwd, ...options, shell: false });
}

function listUniqueFiles(...groups) {
  return [...new Set(groups.flat().filter(Boolean))].sort();
}

function normalizeMaxInlineFiles(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_INLINE_DIFF_MAX_FILES;
  }
  return Math.floor(parsed);
}

function normalizeMaxInlineDiffBytes(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_INLINE_DIFF_MAX_BYTES;
  }
  return Math.floor(parsed);
}

function measureGitOutputBytes(cwd, args, maxBytes) {
  const result = git(cwd, args, { maxBuffer: maxBytes + 1 });
  if (result.error && /** @type {NodeJS.ErrnoException} */ (result.error).code === "ENOBUFS") {
    return maxBytes + 1;
  }
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(formatCommandFailure(result));
  }
  return Buffer.byteLength(result.stdout, "utf8");
}

function measureCombinedGitOutputBytes(cwd, argSets, maxBytes) {
  let totalBytes = 0;
  for (const args of argSets) {
    const remainingBytes = maxBytes - totalBytes;
    if (remainingBytes < 0) {
      return maxBytes + 1;
    }
    totalBytes += measureGitOutputBytes(cwd, args, remainingBytes);
    if (totalBytes > maxBytes) {
      return totalBytes;
    }
  }
  return totalBytes;
}

function buildBranchComparison(cwd, baseRef) {
  const mergeBase = gitChecked(cwd, ["merge-base", "HEAD", baseRef]).stdout.trim();
  return {
    mergeBase,
    commitRange: `${mergeBase}..HEAD`,
    reviewRange: `${baseRef}...HEAD`
  };
}

export function ensureGitRepository(cwd) {
  const result = git(cwd, ["rev-parse", "--show-toplevel"]);
  const errorCode = result.error && "code" in result.error ? result.error.code : null;
  if (errorCode === "ENOENT") {
    throw new Error("git is not installed. Install Git and retry.");
  }
  if (result.status !== 0) {
    throw new Error("This command must run inside a Git repository.");
  }
  return result.stdout.trim();
}

export function getRepoRoot(cwd) {
  return gitChecked(cwd, ["rev-parse", "--show-toplevel"]).stdout.trim();
}

export function detectDefaultBranch(cwd) {
  const symbolic = git(cwd, ["symbolic-ref", "refs/remotes/origin/HEAD"]);
  if (symbolic.status === 0) {
    const remoteHead = symbolic.stdout.trim();
    if (remoteHead.startsWith("refs/remotes/origin/")) {
      return remoteHead.replace("refs/remotes/origin/", "");
    }
  }

  const candidates = ["main", "master", "trunk"];
  for (const candidate of candidates) {
    const local = git(cwd, ["show-ref", "--verify", "--quiet", `refs/heads/${candidate}`]);
    if (local.status === 0) {
      return candidate;
    }
    const remote = git(cwd, ["show-ref", "--verify", "--quiet", `refs/remotes/origin/${candidate}`]);
    if (remote.status === 0) {
      return `origin/${candidate}`;
    }
  }

  throw new Error("Unable to detect the repository default branch. Pass --base <ref> or use --scope working-tree.");
}

export function getCurrentBranch(cwd) {
  return gitChecked(cwd, ["branch", "--show-current"]).stdout.trim() || "HEAD";
}

export function getWorkingTreeState(cwd) {
  const staged = gitChecked(cwd, ["diff", "--cached", "--name-only"]).stdout.trim().split("\n").filter(Boolean);
  const unstaged = gitChecked(cwd, ["diff", "--name-only"]).stdout.trim().split("\n").filter(Boolean);
  const untracked = gitChecked(cwd, ["ls-files", "--others", "--exclude-standard"]).stdout.trim().split("\n").filter(Boolean);

  return {
    staged,
    unstaged,
    untracked,
    isDirty: staged.length > 0 || unstaged.length > 0 || untracked.length > 0
  };
}

// Workspace-drift detection: catches an agent writing into the workspace
// during a run that was supposed to be read-mode. The fingerprint hashes the
// on-disk content of every git-visible dirty path, so both a NEW file and a
// rewrite of an already-dirty file are caught — path-set membership alone
// would miss the second, which is the worse failure (it corrupts the user's
// uncommitted work silently). Ignored paths stay out of scope: they cannot
// reach a commit through git add and hashing build output is not worth it.
export function captureWorkingTreeFingerprint(cwd) {
  const state = getWorkingTreeState(cwd);
  const repoRoot = getRepoRoot(cwd);
  const files = {};
  for (const file of new Set([...state.staged, ...state.unstaged, ...state.untracked])) {
    try {
      files[file] = createHash("sha256").update(fs.readFileSync(path.join(repoRoot, file))).digest("hex");
    } catch {
      files[file] = "unreadable";
    }
  }
  return { files };
}

export function diffWorkingTreeFingerprints(before, after) {
  const changed = [];
  for (const [file, hash] of Object.entries(after.files)) {
    if (before.files[file] !== hash) {
      changed.push(file);
    }
  }
  return changed.sort();
}

export function captureWorkingTreeFingerprintSafe(cwd) {
  try {
    return captureWorkingTreeFingerprint(cwd);
  } catch {
    // Drift detection is best-effort; a git failure must not sink the run —
    // but it must surface as unverifiable, never as clean.
    return null;
  }
}

/**
 * Returns the drifted paths, or null when containment could not be verified.
 * Null is deliberately distinct from []: an unreadable tree is unknown state,
 * not proof the agent behaved.
 */
export function detectWorkspaceDrift(fingerprintBefore, cwd) {
  if (!fingerprintBefore) {
    return null;
  }
  try {
    return diffWorkingTreeFingerprints(fingerprintBefore, captureWorkingTreeFingerprint(cwd));
  } catch {
    return null;
  }
}

export function renderWorkspaceDriftSection(drift) {
  if (drift === null) {
    return [
      "",
      "",
      "## Workspace containment unverified",
      "",
      "The working tree could not be snapshotted around this review, so agent writes cannot be ruled out. Inspect `git status` before staging or committing anything."
    ].join("\n");
  }
  if (!Array.isArray(drift) || drift.length === 0) {
    return "";
  }
  return [
    "",
    "",
    "## Workspace changes during review",
    "",
    `The review agent created or modified ${drift.length} file(s), which a review should not do. Inspect them before staging or committing anything:`,
    "",
    ...drift.map((file) => `- ${file}`)
  ].join("\n");
}

const REVIEW_WORKTREE_PREFIX = "agent-collab-review-wt-";
const STALE_REVIEW_WORKTREE_MS = 6 * 60 * 60 * 1000;

// Reviews run the agent from a disposable git worktree so its DEFAULT write
// target is a throwaway copy instead of the user's tree. This is a blast
// radius reduction, NOT a sandbox, and the difference matters:
//
//   - It does stop the observed failure mode — an agent writing scratch files
//     at relative paths into its working directory (which happened live).
//   - It does NOT stop a determined or confused agent. Cursor runs with
//     --trust and there is no filesystem boundary, so absolute paths still
//     reach anywhere, and a git worktree deliberately SHARES the user's .git
//     (the gitdir pointer is what makes git usable in there at all), so refs,
//     objects, hooks, and config remain reachable.
//
// Workspace-drift detection on the real repo stays the actual containment
// signal. Say all of this plainly rather than implying a boundary that does
// not exist — overclaiming here is the exact trap this repo keeps correcting.
//
// The worktree is checked out at HEAD; for working-tree-scope reviews the
// uncommitted state (tracked changes as a binary patch, plus untracked
// files) is materialized into it, or the agent would review the wrong
// content. Every failure path reports the reason so the caller can fall back
// to the real repo and SAY SO.
export function createReviewWorktree(repoRoot, options = {}) {
  const runGit = options.gitImpl ?? ((args, cwd) => runCommand("git", args, { cwd, shell: false }));
  const head = runGit(["rev-parse", "HEAD"], repoRoot);
  if (head.status !== 0) {
    // No commits yet: nothing to check out.
    return { path: null, isolated: false, reason: "repository has no commits" };
  }

  let worktreePath = null;
  try {
    worktreePath = fs.mkdtempSync(path.join(options.tmpRoot ?? os.tmpdir(), REVIEW_WORKTREE_PREFIX));
    // mkdtemp created the directory; git worktree add requires it absent.
    fs.rmdirSync(worktreePath);
    const add = runGit(["worktree", "add", "--detach", worktreePath, "HEAD"], repoRoot);
    if (add.status !== 0) {
      throw new Error(add.stderr?.trim() || "git worktree add failed");
    }

    if (options.includeUncommitted) {
      materializeUncommittedState(repoRoot, worktreePath, runGit);
    }

    // The worktree's .git is a pointer FILE holding an absolute gitdir path.
    // When the agent runs inside WSL, a Windows path there resolves to
    // nothing ("fatal: not a git repository"), so rewrite it to the
    // translated path — verified working: status/log/diff all succeed.
    if (typeof options.translateGitdir === "function") {
      const pointerFile = path.join(worktreePath, ".git");
      const pointer = fs.readFileSync(pointerFile, "utf8").trim();
      const gitdir = pointer.replace(/^gitdir:\s*/, "");
      // Rewrite in place through an r+ handle: git marks this file hidden on
      // Windows, and writeFileSync's create-always open fails EPERM on a
      // hidden file.
      const contents = Buffer.from(`gitdir: ${options.translateGitdir(gitdir)}\n`, "utf8");
      const handle = fs.openSync(pointerFile, "r+");
      try {
        fs.writeSync(handle, contents, 0, contents.length, 0);
        fs.ftruncateSync(handle, contents.length);
      } finally {
        fs.closeSync(handle);
      }
    }

    return { path: worktreePath, isolated: true, reason: null, repoRoot };
  } catch (error) {
    if (worktreePath) {
      removeReviewWorktree({ path: worktreePath, repoRoot }, { gitImpl: options.gitImpl });
    }
    return {
      path: null,
      isolated: false,
      reason: error instanceof Error ? error.message : String(error)
    };
  }
}

// Config that must be pinned on every plumbing call here. User gitconfig can
// otherwise make the patch unusable — `diff.noprefix`/`mnemonicPrefix` break
// `-p1` parsing, `color.ui=always` injects ANSI escapes, a `diff.external`
// or textconv driver replaces hunks with arbitrary text, and the default
// `core.quotepath=true` C-quotes non-ASCII paths so untracked files get
// silently dropped. All verified failure modes, none reproducible on a
// machine whose gitconfig happens to be tame.
const PATCH_SAFE_CONFIG = [
  "-c", "color.ui=false",
  "-c", "diff.noprefix=false",
  "-c", "diff.mnemonicPrefix=false",
  "-c", "diff.external=",
  "-c", "core.quotepath=false"
];

function materializeUncommittedState(repoRoot, worktreePath, runGit) {
  // Tracked changes (staged + unstaged) as one binary-safe patch. NOTE the
  // deliberate `--submodule=short`: the display diff uses `--submodule=diff`,
  // whose hunks target paths inside submodules, but `git worktree add` leaves
  // submodule directories empty, so applying that patch fails outright.
  const diff = runGit(
    [...PATCH_SAFE_CONFIG, "diff", "HEAD", "--binary", "--no-color", "--no-ext-diff", "--no-textconv", "--submodule=short"],
    repoRoot
  );
  if (diff.status !== 0) {
    throw new Error(diff.stderr?.trim() || "git diff HEAD failed");
  }
  if (diff.stdout.trim()) {
    const patchFile = path.join(worktreePath, ".agent-collab-review.patch");
    fs.writeFileSync(patchFile, diff.stdout);
    // Tolerate CRLF/whitespace differences rather than failing the review.
    const applied = runGit([...PATCH_SAFE_CONFIG, "apply", "-p1", "--whitespace=nowarn", patchFile], worktreePath);
    fs.rmSync(patchFile, { force: true });
    if (applied.status !== 0) {
      throw new Error(applied.stderr?.trim() || "could not apply uncommitted changes");
    }
  }

  // Untracked files are invisible to git diff; copy them in explicitly.
  // Failing to enumerate them must fail the whole materialization: reviewing
  // a tree that is quietly missing the user's new files, while reporting
  // success, is a silent negative.
  const untracked = runGit([...PATCH_SAFE_CONFIG, "ls-files", "--others", "--exclude-standard"], repoRoot);
  if (untracked.status !== 0) {
    throw new Error(untracked.stderr?.trim() || "could not enumerate untracked files");
  }
  for (const relative of untracked.stdout.split("\n").map((line) => line.trim()).filter(Boolean)) {
    const source = path.join(repoRoot, relative);
    const destination = path.join(worktreePath, relative);
    let stat;
    try {
      stat = fs.lstatSync(source);
    } catch {
      // Raced away between enumeration and copy; nothing to reproduce.
      continue;
    }
    if (!stat.isFile()) {
      // Directories are implied by their files; symlinks are not followed —
      // copying through one would write outside the disposable tree.
      continue;
    }
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination);
  }
}

export function removeReviewWorktree(handle, options = {}) {
  if (!handle?.path) {
    return { removed: true };
  }
  const runGit = options.gitImpl ?? ((args, cwd) => runCommand("git", args, { cwd, shell: false }));
  if (handle.repoRoot) {
    runGit(["worktree", "remove", "--force", handle.path], handle.repoRoot);
  }
  try {
    fs.rmSync(handle.path, { recursive: true, force: true });
  } catch {
    // Windows can hold a file open briefly; prune below keeps git consistent
    // and the stale-sweep reclaims the directory on a later review.
  }
  if (handle.repoRoot) {
    runGit(["worktree", "prune"], handle.repoRoot);
  }
  return { removed: !fs.existsSync(handle.path) };
}

// A killed worker (cancel, SIGKILL) can leave a worktree behind. Each review
// sweeps old ones first, so residue converges without a cron job — the same
// self-healing doctrine the broker reaper uses.
export function pruneStaleReviewWorktrees(repoRoot, options = {}) {
  const runGit = options.gitImpl ?? ((args, cwd) => runCommand("git", args, { cwd, shell: false }));
  const tmpRoot = options.tmpRoot ?? os.tmpdir();
  const maxAgeMs = options.maxAgeMs ?? STALE_REVIEW_WORKTREE_MS;
  const now = options.now ?? Date.now();
  let entries = [];
  try {
    entries = fs.readdirSync(tmpRoot, { withFileTypes: true });
  } catch {
    return { pruned: 0 };
  }
  let pruned = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(REVIEW_WORKTREE_PREFIX)) {
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
    removeReviewWorktree({ path: full, repoRoot }, { gitImpl: options.gitImpl });
    pruned += 1;
  }
  return { pruned };
}

export function resolveReviewTarget(cwd, options = {}) {
  ensureGitRepository(cwd);

  const requestedScope = options.scope ?? "auto";
  const baseRef = options.base ?? null;
  const state = getWorkingTreeState(cwd);
  const supportedScopes = new Set(["auto", "working-tree", "branch"]);

  if (baseRef) {
    return {
      mode: "branch",
      label: `branch diff against ${baseRef}`,
      baseRef,
      explicit: true
    };
  }

  if (requestedScope === "working-tree") {
    return {
      mode: "working-tree",
      label: "working tree diff",
      explicit: true
    };
  }

  if (!supportedScopes.has(requestedScope)) {
    throw new Error(
      `Unsupported review scope "${requestedScope}". Use one of: auto, working-tree, branch, or pass --base <ref>.`
    );
  }

  if (requestedScope === "branch") {
    const detectedBase = detectDefaultBranch(cwd);
    return {
      mode: "branch",
      label: `branch diff against ${detectedBase}`,
      baseRef: detectedBase,
      explicit: true
    };
  }

  if (state.isDirty) {
    return {
      mode: "working-tree",
      label: "working tree diff",
      explicit: false
    };
  }

  const detectedBase = detectDefaultBranch(cwd);
  return {
    mode: "branch",
    label: `branch diff against ${detectedBase}`,
    baseRef: detectedBase,
    explicit: false
  };
}

function formatSection(title, body) {
  return [`## ${title}`, "", body.trim() ? body.trim() : "(none)", ""].join("\n");
}

function formatUntrackedFile(cwd, relativePath) {
  const absolutePath = path.join(cwd, relativePath);
  let stat;
  try {
    stat = fs.statSync(absolutePath);
  } catch {
    return `### ${relativePath}\n(skipped: broken symlink or unreadable file)`;
  }
  if (stat.isDirectory()) {
    return `### ${relativePath}\n(skipped: directory)`;
  }
  if (stat.size > MAX_UNTRACKED_BYTES) {
    return `### ${relativePath}\n(skipped: ${stat.size} bytes exceeds ${MAX_UNTRACKED_BYTES} byte limit)`;
  }

  let buffer;
  try {
    buffer = fs.readFileSync(absolutePath);
  } catch {
    return `### ${relativePath}\n(skipped: broken symlink or unreadable file)`;
  }
  if (!isProbablyText(buffer)) {
    return `### ${relativePath}\n(skipped: binary file)`;
  }

  return [`### ${relativePath}`, "```", buffer.toString("utf8").trimEnd(), "```"].join("\n");
}

function collectWorkingTreeContext(cwd, state, options = {}) {
  const includeDiff = options.includeDiff !== false;
  const status = gitChecked(cwd, ["status", "--short", "--untracked-files=all"]).stdout.trim();
  const changedFiles = listUniqueFiles(state.staged, state.unstaged, state.untracked);

  let parts;
  if (includeDiff) {
    const stagedDiff = gitChecked(cwd, ["diff", "--cached", "--binary", "--no-ext-diff", "--submodule=diff"]).stdout;
    const unstagedDiff = gitChecked(cwd, ["diff", "--binary", "--no-ext-diff", "--submodule=diff"]).stdout;
    const untrackedBody = state.untracked.map((file) => formatUntrackedFile(cwd, file)).join("\n\n");
    parts = [
      formatSection("Git Status", status),
      formatSection("Staged Diff", stagedDiff),
      formatSection("Unstaged Diff", unstagedDiff),
      formatSection("Untracked Files", untrackedBody)
    ];
  } else {
    const stagedStat = gitChecked(cwd, ["diff", "--shortstat", "--cached"]).stdout.trim();
    const unstagedStat = gitChecked(cwd, ["diff", "--shortstat"]).stdout.trim();
    const untrackedBody = state.untracked.map((file) => formatUntrackedFile(cwd, file)).join("\n\n");
    parts = [
      formatSection("Git Status", status),
      formatSection("Staged Diff Stat", stagedStat),
      formatSection("Unstaged Diff Stat", unstagedStat),
      formatSection("Changed Files", changedFiles.join("\n")),
      formatSection("Untracked Files", untrackedBody)
    ];
  }

  return {
    mode: "working-tree",
    summary: `Reviewing ${state.staged.length} staged, ${state.unstaged.length} unstaged, and ${state.untracked.length} untracked file(s).`,
    content: parts.join("\n"),
    changedFiles
  };
}

function collectBranchContext(cwd, baseRef, options = {}) {
  const includeDiff = options.includeDiff !== false;
  const comparison = options.comparison ?? buildBranchComparison(cwd, baseRef);
  const currentBranch = getCurrentBranch(cwd);
  const changedFiles = gitChecked(cwd, ["diff", "--name-only", comparison.commitRange]).stdout.trim().split("\n").filter(Boolean);
  const logOutput = gitChecked(cwd, ["log", "--oneline", "--decorate", comparison.commitRange]).stdout.trim();
  const diffStat = gitChecked(cwd, ["diff", "--stat", comparison.commitRange]).stdout.trim();

  return {
    mode: "branch",
    summary: `Reviewing branch ${currentBranch} against ${baseRef} from merge-base ${comparison.mergeBase}.`,
    content: includeDiff
      ? [
          formatSection("Commit Log", logOutput),
          formatSection("Diff Stat", diffStat),
          formatSection(
            "Branch Diff",
            gitChecked(cwd, ["diff", "--binary", "--no-ext-diff", "--submodule=diff", comparison.commitRange]).stdout
          )
        ].join("\n")
      : [
          formatSection("Commit Log", logOutput),
          formatSection("Diff Stat", diffStat),
          formatSection("Changed Files", changedFiles.join("\n"))
        ].join("\n"),
    changedFiles,
    comparison
  };
}

function buildAdversarialCollectionGuidance(options = {}) {
  if (options.includeDiff !== false) {
    return "Use the repository context below as primary evidence.";
  }

  return "The repository context below is a lightweight summary. Inspect the target diff yourself with read-only git commands before finalizing findings.";
}

export function collectReviewContext(cwd, target, options = {}) {
  const repoRoot = getRepoRoot(cwd);
  const currentBranch = getCurrentBranch(repoRoot);
  const maxInlineFiles = normalizeMaxInlineFiles(options.maxInlineFiles);
  const maxInlineDiffBytes = normalizeMaxInlineDiffBytes(options.maxInlineDiffBytes);
  let details;
  let includeDiff;
  let diffBytes;

  if (target.mode === "working-tree") {
    const state = getWorkingTreeState(repoRoot);
    diffBytes = measureCombinedGitOutputBytes(
      repoRoot,
      [
        ["diff", "--cached", "--binary", "--no-ext-diff", "--submodule=diff"],
        ["diff", "--binary", "--no-ext-diff", "--submodule=diff"]
      ],
      maxInlineDiffBytes
    );
    includeDiff =
      options.includeDiff ??
      (listUniqueFiles(state.staged, state.unstaged, state.untracked).length <= maxInlineFiles &&
        diffBytes <= maxInlineDiffBytes);
    details = collectWorkingTreeContext(repoRoot, state, { includeDiff });
  } else {
    const comparison = buildBranchComparison(repoRoot, target.baseRef);
    const fileCount = gitChecked(repoRoot, ["diff", "--name-only", comparison.commitRange]).stdout.trim().split("\n").filter(Boolean).length;
    diffBytes = measureGitOutputBytes(
      repoRoot,
      ["diff", "--binary", "--no-ext-diff", "--submodule=diff", comparison.commitRange],
      maxInlineDiffBytes
    );
    includeDiff = options.includeDiff ?? (fileCount <= maxInlineFiles && diffBytes <= maxInlineDiffBytes);
    details = collectBranchContext(repoRoot, target.baseRef, { includeDiff, comparison });
  }

  return {
    cwd: repoRoot,
    repoRoot,
    branch: currentBranch,
    target,
    fileCount: details.changedFiles.length,
    diffBytes,
    inputMode: includeDiff ? "inline-diff" : "self-collect",
    collectionGuidance: buildAdversarialCollectionGuidance({ includeDiff }),
    ...details,
    content: neutralizePromptDelimiters(details.content)
  };
}

// The review prompt wraps this content in a <repository_context> section and
// tells the model everything inside is untrusted data. Reviewed code could
// otherwise embed a literal </repository_context> to forge the section closer
// and appear to escape into trusted-instruction space, so neutralize any
// repository_context tag in the content by stripping its angle brackets. The
// text stays readable; it just can no longer close the real section.
export function neutralizePromptDelimiters(content) {
  if (typeof content !== "string") {
    return content;
  }
  return content.replace(/<(\/?)repository_context>/gi, "[$1repository_context]");
}
