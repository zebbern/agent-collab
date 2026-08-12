import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveWorkspaceRoot } from "./workspace.mjs";

const STATE_VERSION = 1;
// State root doctrine (2026-08-07): ONE canonical root per user, independent
// of the invocation context. Earlier versions resolved the root from ambient
// CLAUDE_PLUGIN_DATA, but that var means "whichever plugin install's
// SessionStart hook exported it last" — per-install data dirs (one per
// marketplace), stale exports from uninstalled instances, and hook processes
// seeing a different value than Bash all split one workspace's jobs across
// roots ("No job found", orphaned workers, split broker registries). The var
// survives below only as a legacy migration SOURCE. The override env var is
// plugin-specific (no harness sets it ambiently) and exists for test
// isolation.
const STATE_ROOT_ENV = "CURSOR_COMPANION_STATE_ROOT";
const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";
const METRICS_PLUGIN = "cursor";
const ENFORCE_POSIX_MODES = process.platform !== "win32";
const LEGACY_FALLBACK_STATE_ROOT_DIR = path.join(os.tmpdir(), "cursor-companion");

// Validate — and optionally create — a directory that must stay private to
// this user. Job records and logs carry prompts and results, so a symlinked
// or another user's directory in the path must be refused, not followed or
// trusted. This is the same private-dir doctrine the broker registry uses.
//
// Creation goes through a NON-recursive mkdir so an existing symlink at the
// leaf fails EEXIST instead of being followed — no write-through. A residual
// TOCTOU window (a swap between this check and the caller's next use) is
// accepted for this threat model rather than plumbing O_NOFOLLOW dir fds
// everywhere; the ownership + symlink refusal closes the pre-planted cases.
function ensurePrivateDir(dir, { create }) {
  let stat;
  try {
    stat = fs.lstatSync(dir);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
    if (!create) {
      return false;
    }
    fs.mkdirSync(dir, { mode: 0o700 });
    return true;
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`State path ${dir} is not a private directory; refusing to use it.`);
  }
  if (ENFORCE_POSIX_MODES) {
    if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
      throw new Error(`State path ${dir} is owned by another user; refusing to use it.`);
    }
    if ((stat.mode & 0o777) !== 0o700) {
      // Tighten a loose directory we own (e.g. one created by an older
      // version) instead of only protecting fresh installs.
      fs.chmodSync(dir, 0o700);
    }
  }
  return true;
}
const STATE_FILE_NAME = "state.json";
const STATE_LOCK_NAME = "state.lock";
const JOBS_DIR_NAME = "jobs";
const METRICS_FILE_NAME = "metrics.jsonl";
const METRICS_ROTATE_BYTES = 512 * 1024;
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
      fs.writeFileSync(lockFile, String(process.pid), { flag: "wx", mode: 0o600 });
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
  return path.join(resolveStateRoot(), `${slug}-${hash}`);
}

export function resolveStateFile(cwd) {
  return path.join(resolveStateDir(cwd), STATE_FILE_NAME);
}

export function resolveJobsDir(cwd) {
  return path.join(resolveStateDir(cwd), JOBS_DIR_NAME);
}

export function resolveStateRoot(env = process.env) {
  return env[STATE_ROOT_ENV] || path.join(os.homedir(), ".claude", "cursor-companion");
}

// Windows paths compare case-insensitively; treating the canonical root as a
// legacy source would import state into itself.
function samePath(a, b) {
  const left = path.resolve(a);
  const right = path.resolve(b);
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

// Roots older versions wrote under: whatever plugin data dir the current
// environment still carries, every per-install data dir the harness keeps
// under ~/.claude/plugins/data (the same workspace may have state under
// several installs of this plugin), and the pre-install tmpdir fallback.
//
// When the state-root OVERRIDE is set (test isolation — production never
// sets it), the config-dir and tmpdir scans are disabled unless a homedir
// is explicitly injected: a hermetic test env running the companion against
// a real workspace must never discover — and mark — the machine's real
// legacy shards (that happened live 2026-08-07: e2e runs stamped .migrated
// markers onto real shards while importing into a throwaway temp root).
// A planted ambient CLAUDE_PLUGIN_DATA stays honored either way.
function listLegacyStateRoots(options = {}) {
  const env = options.env ?? process.env;
  const canonicalRoot = resolveStateRoot(env);
  const defaultScansAllowed = options.homedir != null || !env[STATE_ROOT_ENV];
  const roots = [];
  const push = (dir) => {
    if (samePath(dir, canonicalRoot) || roots.some((seen) => samePath(seen, dir))) {
      return;
    }
    roots.push(dir);
  };
  const ambient = env[PLUGIN_DATA_ENV];
  if (typeof ambient === "string" && ambient !== "" && path.isAbsolute(ambient)) {
    push(path.join(ambient, "state"));
  }
  if (!defaultScansAllowed) {
    return roots;
  }
  const homedir = options.homedir ?? os.homedir();
  const pluginsDataDir = path.join(env.CLAUDE_CONFIG_DIR || path.join(homedir, ".claude"), "plugins", "data");
  let entries = [];
  try {
    entries = fs.readdirSync(pluginsDataDir);
  } catch {
    // No harness plugin-data dir on this machine.
  }
  for (const entry of entries) {
    push(path.join(pluginsDataDir, entry, "state"));
  }
  push(LEGACY_FALLBACK_STATE_ROOT_DIR);
  return roots;
}

export function listLegacyStateShards(cwd, options = {}) {
  const canonicalDir = resolveStateDir(cwd);
  const key = path.basename(canonicalDir);
  const shards = [];
  for (const root of listLegacyStateRoots(options)) {
    const shard = path.join(root, key);
    if (samePath(shard, canonicalDir)) {
      continue;
    }
    try {
      if (fs.statSync(shard).isDirectory()) {
        shards.push(shard);
      }
    } catch {
      // Missing shard — nothing was ever written under this root.
    }
  }
  return shards;
}

function importShardMetrics(cwd, shard) {
  const sourceFile = path.join(shard, METRICS_FILE_NAME);
  const marker = `${sourceFile}.migrated-${METRICS_PLUGIN}`;
  const sources = [`${sourceFile}.old`, sourceFile].filter((file) => fs.existsSync(file));
  if (sources.length === 0 || fs.existsSync(marker)) {
    return 0;
  }
  // Rows self-identify via the plugin field stamped at the append call site.
  // A merged shard (both plugins wrote under one exported data dir) is split
  // by that field: this plugin's rows cross, the sibling's stay for its own
  // consolidation pass, and unattributable rows stay behind entirely.
  const rows = sources
    .flatMap((file) => readMetricsLines(file))
    .filter((row) => row?.plugin === METRICS_PLUGIN)
    .sort((left, right) => String(left.at ?? "").localeCompare(String(right.at ?? "")));
  if (rows.length > 0) {
    fs.appendFileSync(resolveMetricsFile(cwd), rows.map((row) => `${JSON.stringify(row)}\n`).join(""), { mode: 0o600 });
  }
  // The source file itself must survive for the sibling plugin; the marker is
  // what makes this a one-time import.
  try {
    fs.writeFileSync(marker, "", { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (error?.code !== "EEXIST") {
      throw error;
    }
  }
  return rows.length;
}

function adoptShardConfig(cwd, shards) {
  if (fs.existsSync(resolveStateFile(cwd))) {
    return false;
  }
  for (const shard of shards) {
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(path.join(shard, STATE_FILE_NAME), "utf8"));
    } catch {
      continue;
    }
    const config = { ...defaultState().config, ...(parsed?.config ?? {}) };
    if (JSON.stringify(config) === JSON.stringify(defaultState().config)) {
      continue;
    }
    saveStateUnlocked(cwd, { ...defaultState(), config });
    return true;
  }
  return false;
}

// Heal a context split for the parts that can be re-homed honestly: startup
// metrics (append-only, plugin-stamped — the broker-decision dataset) and
// user config when the canonical index does not exist yet. Job RECORDS are
// deliberately left in place: a merged shard cannot attribute a job to a
// plugin, live legacy workers keep updating their own root, and cancel flags
// re-homed away from a worker's polling path would be silently ignored. Jobs
// are transient; residue is surfaced by doctor instead of migrated.
export function consolidateLegacyState(cwd, options = {}) {
  const shards = listLegacyStateShards(cwd, options);
  if (shards.length === 0) {
    return { shards, importedMetrics: 0, adoptedConfig: false };
  }
  ensureStateDir(cwd);
  return withStateLock(cwd, () => {
    let importedMetrics = 0;
    for (const shard of shards) {
      importedMetrics += importShardMetrics(cwd, shard);
    }
    const adoptedConfig = adoptShardConfig(cwd, shards);
    return { shards, importedMetrics, adoptedConfig };
  });
}

export function summarizeLegacyStateShards(cwd, options = {}) {
  return listLegacyStateShards(cwd, options).map((dir) => {
    let jobs = { total: 0, active: 0 };
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(dir, STATE_FILE_NAME), "utf8"));
      const list = Array.isArray(parsed?.jobs) ? parsed.jobs : [];
      jobs = {
        total: list.length,
        active: list.filter((job) => !isTerminalJobStatus(job?.status)).length
      };
    } catch {
      // Unreadable index: still report the shard, with zero counts.
    }
    const metricsFile = path.join(dir, METRICS_FILE_NAME);
    const pendingMetrics =
      (fs.existsSync(metricsFile) || fs.existsSync(`${metricsFile}.old`)) &&
      !fs.existsSync(`${metricsFile}.migrated-${METRICS_PLUGIN}`);
    return { dir, jobs, pendingMetrics };
  });
}

export function ensureStateDir(cwd) {
  const stateDir = resolveStateDir(cwd);
  const jobsDir = path.join(stateDir, JOBS_DIR_NAME);
  // Build the tree from the root down, validating each level before creating
  // the next. The root is created recursively (its parents — ~/.claude or a
  // test-provided override dir — are out of our threat model), then
  // validated so a squatted or symlinked root is refused before anything is
  // written beneath it. The leaf and jobs dirs are created non-recursively so
  // a pre-planted symlink at either fails EEXIST rather than being followed.
  fs.mkdirSync(resolveStateRoot(), { recursive: true, mode: 0o700 });
  ensurePrivateDir(resolveStateRoot(), { create: false });
  ensurePrivateDir(stateDir, { create: true });
  ensurePrivateDir(jobsDir, { create: true });
}

export function resolveMetricsFile(cwd) {
  return path.join(resolveStateDir(cwd), METRICS_FILE_NAME);
}

// Startup metrics deliberately accumulate OUTSIDE the 50-job prune window:
// the per-job spawn->ready overhead is the dataset that decides whether a
// persistent Windows broker is worth building, and a rolling 50 jobs is not
// a dataset. Append-only JSONL, rotated once to .old past the size cap so
// growth stays bounded; readers span .old plus current, so rotation never
// hides history from doctor. Rotate+append run under the state lock so
// concurrent jobs cannot double-rotate and destroy the archive. Best-effort:
// metrics must never sink the run that produced them.
export function appendStartupMetric(cwd, record) {
  try {
    ensureStateDir(cwd);
    const metricsFile = resolveMetricsFile(cwd);
    withStateLock(cwd, () => {
      try {
        if (fs.statSync(metricsFile).size > METRICS_ROTATE_BYTES) {
          const archived = `${metricsFile}.old`;
          // Two generations are retained by design. The lock prevents the
          // concurrent double-rotate that could wipe a just-rotated archive;
          // a rare failed rename here costs only the OLDER generation (the
          // one being replaced), never the current file, which stays intact
          // and rotates on a later attempt.
          fs.rmSync(archived, { force: true });
          fs.renameSync(metricsFile, archived);
        }
      } catch {
        // Missing file or failed rotation: append regardless.
      }
      fs.appendFileSync(metricsFile, `${JSON.stringify({ at: nowIso(), ...record })}\n`, { mode: 0o600 });
    });
  } catch {
    // Best-effort only.
  }
}

function readMetricsLines(file) {
  try {
    return fs
      .readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

export function readStartupMetrics(cwd) {
  const metricsFile = resolveMetricsFile(cwd);
  return [...readMetricsLines(`${metricsFile}.old`), ...readMetricsLines(metricsFile)];
}

export function loadState(cwd) {
  const stateDir = resolveStateDir(cwd);
  const stateFile = path.join(stateDir, STATE_FILE_NAME);
  if (!fs.existsSync(stateFile)) {
    return defaultState();
  }
  // Read paths must validate too: a pre-planted symlinked or foreign-owned
  // state dir would otherwise feed attacker-controlled state.json to readers
  // (listJobs/getConfig/status/result) that never call ensureStateDir.
  ensurePrivateDir(stateDir, { create: false });

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

function requiresCleanup(job) {
  const hasAppServerOwnership =
    Number.isFinite(job?.appServerPid) ||
    Boolean(job?.appServerProcessIdentity) ||
    Boolean(job?.appServerOwnershipSnapshot);
  return (
    job?.status === "queued" ||
    job?.status === "running" ||
    job?.phase === "cleanup-pending" ||
    (typeof job?.cleanupFailure === "string" && job.cleanupFailure.length > 0) ||
    job?.cleanupOutcome?.verified === false ||
    job?.appServerCleanupOutcome?.verified === false ||
    (hasAppServerOwnership && job?.appServerCleanupOutcome?.verified !== true) ||
    (job?.status === "cancelled" && Number.isFinite(job?.wslAgentPid) && job?.wslReap?.reaped !== true)
  );
}

function pruneJobs(jobs) {
  const sorted = [...jobs].sort((left, right) =>
    String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? ""))
  );
  const active = sorted.filter(requiresCleanup);
  const terminal = sorted.filter((job) => !requiresCleanup(job));
  // Cleanup ownership is a recovery contract, not history. Never evict it to
  // make room for inert terminal records; the cap applies to retained history
  // after every unresolved job has been preserved.
  return [...active, ...terminal.slice(0, Math.max(0, MAX_JOBS - active.length))];
}

function preferVerifiedOutcome(current, candidate) {
  if (candidate?.verified === true) {
    return candidate;
  }
  if (current?.verified === true) {
    return current;
  }
  return candidate ?? current;
}

function preferReapedOutcome(current, candidate) {
  if (candidate?.reaped === true) {
    return candidate;
  }
  if (current?.reaped === true) {
    return current;
  }
  return candidate ?? current;
}

function ownershipSnapshotKey(snapshot) {
  if (!snapshot || typeof snapshot !== "object") {
    return "";
  }
  const members = Array.isArray(snapshot.members)
    ? snapshot.members
        .map((member) => `${member?.pid ?? "?"}@${member?.identity ?? "?"}`)
        .sort()
        .join(",")
    : "";
  return [
    snapshot.rootPid ?? "?",
    snapshot.rootIdentity ?? "?",
    snapshot.processGroupId ?? "?",
    snapshot.sessionId ?? "?",
    members
  ].join("|");
}

function workerOwnershipKey(job) {
  const identity = job?.processIdentity ?? job?.ownershipSnapshot?.rootIdentity ?? null;
  const pid = Number.isFinite(job?.pid) ? job.pid : job?.ownershipSnapshot?.rootPid;
  const root = identity ? `identity:${identity}` : Number.isFinite(pid) ? `pid:${pid}` : null;
  return root ? `${root}|snapshot:${identity ? ownershipSnapshotKey(job?.ownershipSnapshot) : ""}` : null;
}

function appServerOwnershipKey(job) {
  const identity = job?.appServerProcessIdentity ?? job?.appServerOwnershipSnapshot?.rootIdentity ?? null;
  const pid = Number.isFinite(job?.appServerPid) ? job.appServerPid : job?.appServerOwnershipSnapshot?.rootPid;
  const root = identity ? `identity:${identity}` : Number.isFinite(pid) ? `pid:${pid}` : null;
  return root ? `${root}|snapshot:${ownershipSnapshotKey(job?.appServerOwnershipSnapshot)}` : null;
}

function wslOwnershipKey(job) {
  return Number.isFinite(job?.wslAgentPid)
    ? `${job.wslAgentPid}|${job.wslAgentStartTime ?? "?"}`
    : null;
}

function ownershipGenerationChanged(current, previous) {
  return [workerOwnershipKey, appServerOwnershipKey, wslOwnershipKey].some((keyFor) => {
    const currentKey = keyFor(current);
    return currentKey !== null && currentKey !== keyFor(previous);
  });
}

function snapshotMemberKeys(snapshot) {
  return new Set(
    Array.isArray(snapshot?.members)
      ? snapshot.members.map((member) => `${member?.pid ?? "?"}@${member?.identity ?? "?"}`)
      : []
  );
}

function containsEveryMember(container, subset) {
  for (const member of subset) {
    if (!container.has(member)) {
      return false;
    }
  }
  return true;
}

function resolveSnapshotCleanupGeneration(
  recordRoot,
  otherRoot,
  recordSnapshot,
  otherSnapshot,
  recordOutcome,
  otherOutcome
) {
  if (!recordRoot) {
    return otherRoot
      ? { source: "other", snapshot: otherSnapshot, outcome: otherOutcome }
      : { source: "record", snapshot: recordSnapshot, outcome: recordOutcome };
  }
  if (otherRoot && recordRoot !== otherRoot) {
    // A job has one worker and, for persistent Codex tasks, one direct
    // app-server root. A different already-canonical root is therefore newer
    // than a whole-record stale write and must not be replaced.
    return { source: "other", snapshot: otherSnapshot, outcome: otherOutcome };
  }
  if (!otherRoot) {
    return { source: "record", snapshot: recordSnapshot, outcome: recordOutcome };
  }
  if (!recordSnapshot && otherSnapshot) {
    return { source: "other", snapshot: otherSnapshot, outcome: otherOutcome };
  }
  if (recordSnapshot && !otherSnapshot) {
    return { source: "record", snapshot: recordSnapshot, outcome: recordOutcome };
  }
  if (recordSnapshot && otherSnapshot) {
    const recordMembers = snapshotMemberKeys(recordSnapshot);
    const otherMembers = snapshotMemberKeys(otherSnapshot);
    const recordContainsOther = containsEveryMember(recordMembers, otherMembers);
    const otherContainsRecord = containsEveryMember(otherMembers, recordMembers);
    if (recordContainsOther && otherContainsRecord) {
      return {
        source: "record",
        snapshot: recordSnapshot,
        outcome: preferVerifiedOutcome(otherOutcome, recordOutcome)
      };
    }
    if (recordContainsOther) {
      return { source: "record", snapshot: recordSnapshot, outcome: recordOutcome };
    }
    if (otherContainsRecord) {
      return { source: "other", snapshot: otherSnapshot, outcome: otherOutcome };
    }
    {
      const members = new Map();
      for (const member of [...(otherSnapshot.members ?? []), ...(recordSnapshot.members ?? [])]) {
        members.set(`${member?.pid ?? "?"}@${member?.identity ?? "?"}`, member);
      }
      return {
        source: "merged",
        snapshot: { ...otherSnapshot, ...recordSnapshot, members: [...members.values()] },
        outcome: null
      };
    }
  }
  return {
    source: "record",
    snapshot: recordSnapshot,
    outcome: preferVerifiedOutcome(otherOutcome, recordOutcome)
  };
}

function mergeDurableCleanupFacts(record, other) {
  const merged = { ...record };
  const recordWorkerRoot = workerOwnershipKey(record)?.split("|snapshot:")[0] ?? null;
  const otherWorkerRoot = workerOwnershipKey(other)?.split("|snapshot:")[0] ?? null;
  const worker = !recordWorkerRoot && !other?.processIdentity && !other?.ownershipSnapshot
    ? { source: "record", snapshot: record?.ownershipSnapshot ?? null, outcome: record?.cleanupOutcome }
    : resolveSnapshotCleanupGeneration(
        recordWorkerRoot,
        otherWorkerRoot,
        record?.ownershipSnapshot ?? null,
        other?.ownershipSnapshot ?? null,
        record?.cleanupOutcome,
        other?.cleanupOutcome
      );
  if (worker.source === "other") {
    merged.pid = other?.pid;
    merged.processIdentity = other?.processIdentity;
  }
  if (
    worker.snapshot != null ||
    Object.hasOwn(record ?? {}, "ownershipSnapshot") ||
    Object.hasOwn(other ?? {}, "ownershipSnapshot")
  ) {
    merged.ownershipSnapshot = worker.snapshot;
  } else {
    delete merged.ownershipSnapshot;
  }
  merged.cleanupOutcome = worker.outcome ?? null;

  const appServer = resolveSnapshotCleanupGeneration(
    appServerOwnershipKey(record)?.split("|snapshot:")[0] ?? null,
    appServerOwnershipKey(other)?.split("|snapshot:")[0] ?? null,
    record?.appServerOwnershipSnapshot ?? null,
    other?.appServerOwnershipSnapshot ?? null,
    record?.appServerCleanupOutcome,
    other?.appServerCleanupOutcome
  );
  if (appServer.source === "other") {
    merged.appServerPid = other?.appServerPid;
    merged.appServerProcessIdentity = other?.appServerProcessIdentity;
  }
  if (
    appServer.snapshot != null ||
    Object.hasOwn(record ?? {}, "appServerOwnershipSnapshot") ||
    Object.hasOwn(other ?? {}, "appServerOwnershipSnapshot")
  ) {
    merged.appServerOwnershipSnapshot = appServer.snapshot;
  } else {
    delete merged.appServerOwnershipSnapshot;
  }
  merged.appServerCleanupOutcome = appServer.outcome ?? null;

  const recordWslKey = wslOwnershipKey(record);
  const otherWslKey = wslOwnershipKey(other);
  if ((!recordWslKey && otherWslKey) || (recordWslKey && otherWslKey && recordWslKey !== otherWslKey)) {
    merged.wslAgentPid = other?.wslAgentPid;
    merged.wslAgentStartTime = other?.wslAgentStartTime;
    merged.wslReap = other?.wslReap ?? null;
  } else {
    merged.wslReap = recordWslKey === otherWslKey
      ? preferReapedOutcome(other?.wslReap, record?.wslReap) ?? null
      : record?.wslReap ?? null;
  }
  return merged;
}

function removeFileIfExists(filePath) {
  if (filePath && fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

const ATOMIC_RENAME_RETRIES = 10;
const ATOMIC_RENAME_RETRY_MS = 15;

// On Windows, a rename onto a target that another process is concurrently
// replacing (or that AV/indexing briefly holds) fails with EPERM/EACCES/
// EBUSY — the same transient set acquireStateLock already tolerates. Two
// writers on the warned unlocked path used to crash here on the first
// collision (observed live 2026-08-07). The tmp file is unique to this
// writer, so a bounded retry is safe; exhaustion still fails loudly.
// Scope: this covers the atomic JSON writes (state.json, job files) — the
// metrics rotation rename has its own non-crashing catch. On the unlocked
// path a retried payload can overwrite a writer that landed inside the
// retry window; that race predates the retry (any unlocked writer can be
// overtaken), which is why the path is warned and the merge guard still
// caps the damage — the retry widens the window by at most ~240ms.
function renameWithContentionRetry(temporaryFile, filePath) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      fs.renameSync(temporaryFile, filePath);
      return;
    } catch (error) {
      const code = /** @type {NodeJS.ErrnoException} */ (error)?.code;
      if ((code !== "EPERM" && code !== "EACCES" && code !== "EBUSY") || attempt >= ATOMIC_RENAME_RETRIES) {
        throw error;
      }
      sleepSync(ATOMIC_RENAME_RETRY_MS + Math.floor(Math.random() * 10));
    }
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
    renameWithContentionRetry(temporaryFile, filePath);
  } finally {
    // Best-effort reap: a cleanup failure must never mask the original
    // rename/write error — the tmp name is unique, so residue is inert.
    try {
      if (fs.existsSync(temporaryFile)) {
        fs.unlinkSync(temporaryFile);
      }
    } catch {
      // Deliberately swallowed.
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
  const previousById = new Map(previousJobs.map((job) => [job.id, job]));
  const terminalById = new Map(
    previousJobs.filter((job) => isTerminalJobStatus(job?.status)).map((job) => [job.id, job])
  );
  const guardedJobs = (state.jobs ?? []).map((job) => {
    const terminal = terminalById.get(job?.id);
    const previous = previousById.get(job?.id);
    let merged = mergeDurableCleanupFacts(job, previous);
    const ownershipChanged = ownershipGenerationChanged(merged, previous);
    if (!terminal) {
      return merged;
    }
    // Cancellation is the authoritative outcome once cleanup has verified.
    // A worker that finishes concurrently may still attempt a completed or
    // failed terminal write after cancel committed; that later writer must
    // not replace the cancellation merely because both statuses are terminal.
    if (terminal.status === "cancelled" && job?.status !== "cancelled") {
      return mergeDurableCleanupFacts(terminal, job);
    }
    if (
      terminal.status === "cancelled" &&
      terminal.phase === "cancelled" &&
      job?.status === "cancelled" &&
      !ownershipChanged
    ) {
      // A successful cancellation is final. A slower concurrent cleanup may
      // still report an unverified root, but it cannot put the job back into
      // cleanup-pending or restore a pid/failure after another actor verified
      // every required root.
      return mergeDurableCleanupFacts(terminal, job);
    }
    if (!isTerminalJobStatus(job?.status)) {
      merged = mergeDurableCleanupFacts(terminal, job);
    }
    return merged;
  });
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
    if (
      isTerminalJobStatus(existing.status) &&
      jobPatch.status != null &&
      (!isTerminalJobStatus(jobPatch.status) || (existing.status === "cancelled" && jobPatch.status !== "cancelled"))
    ) {
      // Refuse to revive a terminal job: a late worker or progress writer
      // must never flip cancelled/failed/completed back to running/queued,
      // and a late terminal worker write must never replace cancellation.
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
    fs.writeFileSync(cancelFlag, "", { flag: "wx", mode: 0o600 });
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
