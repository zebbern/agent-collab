import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveWorkspaceRoot } from "./workspace.mjs";

const STATE_VERSION = 1;
const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";
const FALLBACK_STATE_ROOT_DIR = path.join(os.tmpdir(), "codex-companion");
const STATE_FILE_NAME = "state.json";
const STATE_LOCK_NAME = "state.lock";
const JOBS_DIR_NAME = "jobs";
const MAX_JOBS = 50;
const STATE_LOCK_TIMEOUT_MS = 5_000;
const STATE_LOCK_STALE_MS = 10_000;
const STATE_LOCK_RETRY_MS = 25;
const TERMINAL_JOB_STATUSES = new Set(["completed", "failed", "cancelled"]);

export function isTerminalJobStatus(status) {
  return TERMINAL_JOB_STATUSES.has(status);
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function acquireStateLock(cwd) {
  ensureStateDir(cwd);
  const lockFile = path.join(resolveStateDir(cwd), STATE_LOCK_NAME);
  const deadline = Date.now() + STATE_LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      fs.writeFileSync(lockFile, String(process.pid), { flag: "wx" });
      return lockFile;
    } catch (error) {
      const code = /** @type {NodeJS.ErrnoException} */ (error)?.code;
      // EEXIST is plain contention. On Windows, racing a concurrent release
      // or stale-steal can also surface as EPERM/EBUSY/EACCES while the old
      // lock file is delete-pending — transient contention states, not
      // failures: retrying either wins the recreate or times out into the
      // warned unlocked path below.
      if (code !== "EEXIST" && code !== "EPERM" && code !== "EBUSY" && code !== "EACCES") {
        throw error;
      }
    }
    try {
      if (Date.now() - fs.statSync(lockFile).mtimeMs > STATE_LOCK_STALE_MS) {
        fs.unlinkSync(lockFile);
        continue;
      }
    } catch {
      // Lock vanished between the write attempt and the stat — retry.
      continue;
    }
    if (Date.now() > deadline) {
      // Availability over strictness: a wedged lock must not brick the CLI.
      // The terminal-status merge guard in saveState still prevents job
      // resurrection even on this unlocked path.
      process.stderr.write(`Warning: state lock at ${lockFile} was busy for ${STATE_LOCK_TIMEOUT_MS}ms; proceeding without it.\n`);
      return null;
    }
    sleepSync(STATE_LOCK_RETRY_MS);
  }
}

function releaseStateLock(lockFile) {
  if (!lockFile) {
    return;
  }
  try {
    fs.unlinkSync(lockFile);
  } catch {
    // Best-effort release: a missing lock file means a stale-steal occurred.
  }
}

function withStateLock(cwd, fn) {
  const lockFile = acquireStateLock(cwd);
  try {
    return fn();
  } finally {
    releaseStateLock(lockFile);
  }
}

function nowIso() {
  return new Date().toISOString();
}

function defaultState() {
  return {
    version: STATE_VERSION,
    config: {
      stopReviewGate: false
    },
    jobs: []
  };
}

export function resolveStateDir(cwd) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  let canonicalWorkspaceRoot = workspaceRoot;
  try {
    canonicalWorkspaceRoot = fs.realpathSync.native(workspaceRoot);
  } catch {
    canonicalWorkspaceRoot = workspaceRoot;
  }

  const slugSource = path.basename(workspaceRoot) || "workspace";
  const slug = slugSource.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "workspace";
  const hash = createHash("sha256").update(canonicalWorkspaceRoot).digest("hex").slice(0, 16);
  const pluginDataDir = process.env[PLUGIN_DATA_ENV];
  const stateRoot = pluginDataDir ? path.join(pluginDataDir, "state") : FALLBACK_STATE_ROOT_DIR;
  return path.join(stateRoot, `${slug}-${hash}`);
}

export function resolveStateFile(cwd) {
  return path.join(resolveStateDir(cwd), STATE_FILE_NAME);
}

export function resolveJobsDir(cwd) {
  return path.join(resolveStateDir(cwd), JOBS_DIR_NAME);
}

export function ensureStateDir(cwd) {
  fs.mkdirSync(resolveJobsDir(cwd), { recursive: true });
}

export function loadState(cwd) {
  const stateFile = resolveStateFile(cwd);
  if (!fs.existsSync(stateFile)) {
    return defaultState();
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    return {
      ...defaultState(),
      ...parsed,
      config: {
        ...defaultState().config,
        ...(parsed.config ?? {})
      },
      jobs: Array.isArray(parsed.jobs) ? parsed.jobs : []
    };
  } catch {
    // Copy-then-replace recovery: the corrupt file stays in place until the
    // rebuilt index atomically renames over it, so no reader ever observes
    // a missing state file (a missing file reads as an empty default index
    // and strands every jobs/*.json as an orphan). If persisting fails, the
    // corrupt original remains on disk and the next reader retries this
    // same recovery instead of inheriting silent loss. writeJsonFileAtomic,
    // not saveStateUnlocked — the latter re-enters loadState.
    preserveCorruptStateCopy(stateFile);
    const rebuiltJobs = rebuildJobsFromJobFiles(cwd);
    const rebuiltState = {
      ...defaultState(),
      jobs: rebuiltJobs
    };
    let persisted = true;
    try {
      ensureStateDir(cwd);
      writeJsonFileAtomic(stateFile, rebuiltState);
    } catch {
      persisted = false;
    }
    process.stderr.write(
      persisted
        ? `Warning: ${stateFile} was corrupt; a copy was quarantined and the index was rebuilt from ${rebuiltJobs.length} job file(s).\n`
        : `Warning: ${stateFile} is corrupt and the rebuilt index could not be persisted; recovery will retry on the next read.\n`
    );
    return rebuiltState;
  }
}

function preserveCorruptStateCopy(stateFile) {
  try {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    fs.copyFileSync(stateFile, `${stateFile}.corrupt-${timestamp}`);
  } catch {
    // Best-effort quarantine copy: recovery must never throw.
  }
}

function rebuildJobsFromJobFiles(cwd) {
  let entries;
  try {
    entries = fs.readdirSync(resolveJobsDir(cwd));
  } catch {
    return [];
  }

  const jobs = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) {
      continue;
    }
    try {
      const job = JSON.parse(fs.readFileSync(path.join(resolveJobsDir(cwd), entry), "utf8"));
      if (job && typeof job === "object" && typeof job.id === "string") {
        jobs.push(job);
      }
    } catch {
      // Skip unreadable job files.
    }
  }
  return pruneJobs(jobs);
}

function pruneJobs(jobs) {
  return [...jobs]
    .sort((left, right) => String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")))
    .slice(0, MAX_JOBS);
}

function removeFileIfExists(filePath) {
  if (filePath && fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

function writeJsonFileAtomic(filePath, payload) {
  const temporaryFile = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporaryFile, `${JSON.stringify(payload, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600
    });
    fs.renameSync(temporaryFile, filePath);
  } finally {
    if (fs.existsSync(temporaryFile)) {
      fs.unlinkSync(temporaryFile);
    }
  }
}

function saveStateUnlocked(cwd, state) {
  const previousJobs = loadState(cwd).jobs;
  ensureStateDir(cwd);
  // Terminal-status merge guard: a writer holding a snapshot taken before a
  // job reached a terminal status must not resurrect it — for each incoming
  // non-terminal job whose on-disk record is already terminal, the on-disk
  // record wins wholesale (status, pid, and all).
  const terminalById = new Map(
    previousJobs.filter((job) => isTerminalJobStatus(job?.status)).map((job) => [job.id, job])
  );
  const guardedJobs = (state.jobs ?? []).map((job) =>
    terminalById.has(job?.id) && !isTerminalJobStatus(job?.status) ? terminalById.get(job.id) : job
  );
  const nextJobs = pruneJobs(guardedJobs);
  const nextState = {
    version: STATE_VERSION,
    config: {
      ...defaultState().config,
      ...(state.config ?? {})
    },
    jobs: nextJobs
  };

  const retainedIds = new Set(nextJobs.map((job) => job.id));
  for (const job of previousJobs) {
    if (retainedIds.has(job.id)) {
      continue;
    }
    removeJobFile(cwd, job.id, { preserveCancelFlag: hasCancelFlag(cwd, job.id) });
    removeFileIfExists(job.logFile);
  }

  writeJsonFileAtomic(resolveStateFile(cwd), nextState);
  return nextState;
}

export function saveState(cwd, state) {
  return withStateLock(cwd, () => saveStateUnlocked(cwd, state));
}

export function updateState(cwd, mutate) {
  // Load inside the lock so the mutation always applies to the freshest
  // on-disk state rather than a snapshot another process may have replaced.
  return withStateLock(cwd, () => {
    const state = loadState(cwd);
    mutate(state);
    return saveStateUnlocked(cwd, state);
  });
}

export function generateJobId(prefix = "job") {
  const random = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now().toString(36)}-${random}`;
}

export function upsertJob(cwd, jobPatch) {
  return updateState(cwd, (state) => {
    const timestamp = nowIso();
    const existingIndex = state.jobs.findIndex((job) => job.id === jobPatch.id);
    if (existingIndex === -1) {
      state.jobs.unshift({
        createdAt: timestamp,
        updatedAt: timestamp,
        ...jobPatch
      });
      return;
    }
    const existing = state.jobs[existingIndex];
    if (isTerminalJobStatus(existing.status) && jobPatch.status != null && !isTerminalJobStatus(jobPatch.status)) {
      // Refuse to revive a terminal job: a late worker or progress writer
      // must never flip cancelled/failed/completed back to running/queued.
      return;
    }
    state.jobs[existingIndex] = {
      ...existing,
      ...jobPatch,
      updatedAt: timestamp
    };
  });
}

export function listJobs(cwd) {
  return loadState(cwd).jobs;
}

export function setConfig(cwd, key, value) {
  return updateState(cwd, (state) => {
    state.config = {
      ...state.config,
      [key]: value
    };
  });
}

export function getConfig(cwd) {
  return loadState(cwd).config;
}

export function writeJobFile(cwd, jobId, payload) {
  ensureStateDir(cwd);
  const jobFile = resolveJobFile(cwd, jobId);
  writeJsonFileAtomic(jobFile, payload);
  return jobFile;
}

export function readJobFile(jobFile) {
  return JSON.parse(fs.readFileSync(jobFile, "utf8"));
}

export function writeCancelFlag(cwd, jobId) {
  const cancelFlag = resolveCancelFlag(cwd, jobId);
  try {
    fs.writeFileSync(cancelFlag, "", { flag: "wx" });
  } catch (error) {
    if (error?.code !== "EEXIST") {
      throw error;
    }
  }
  return cancelFlag;
}

export function hasCancelFlag(cwd, jobId) {
  return fs.existsSync(resolveCancelFlag(cwd, jobId));
}

export function removeCancelFlag(cwd, jobId) {
  removeFileIfExists(resolveCancelFlag(cwd, jobId));
}

function removeJobFile(cwd, jobId, options = {}) {
  removeFileIfExists(resolveJobFile(cwd, jobId));
  if (options.preserveCancelFlag !== true) {
    removeCancelFlag(cwd, jobId);
  }
}

export function resolveJobLogFile(cwd, jobId) {
  ensureStateDir(cwd);
  return path.join(resolveJobsDir(cwd), `${jobId}.log`);
}

export function resolveJobFile(cwd, jobId) {
  ensureStateDir(cwd);
  return path.join(resolveJobsDir(cwd), `${jobId}.json`);
}

function resolveCancelFlag(cwd, jobId) {
  return resolveJobFile(cwd, jobId).replace(/\.json$/, ".cancelled");
}
