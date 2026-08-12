import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { spawn } from "node:child_process";

import { makeTempDir } from "./helpers.mjs";
import {
  appendStartupMetric,
  consolidateLegacyState,
  ensureStateDir,
  listJobs,
  listLegacyStateShards,
  loadState,
  readStartupMetrics,
  resolveMetricsFile,
  resolveJobFile,
  resolveJobLogFile,
  resolveJobsDir,
  resolveStateDir,
  resolveStateFile,
  saveState,
  setConfig,
  summarizeLegacyStateShards,
  updateState,
  upsertJob,
  writeCancelFlag,
  writeJobFile
} from "../plugins/codex/scripts/lib/state.mjs";
import { createJobLogFile } from "../plugins/codex/scripts/lib/tracked-jobs.mjs";

// Single-file runs (node --test tests/<f>) bypass scripts/run-tests.mjs's
// env scrub, so shed any ambient installed-plugin data dir here too. The
// canonical state root is per-user; the suite isolates by pointing the
// override at a temp dir (the same convention the goal suite uses for
// GOAL_COMPANION_STATE_ROOT).
delete process.env.CLAUDE_PLUGIN_DATA;
const suiteStateRoot = makeTempDir("codex-plugin-state-root-");
process.env.CODEX_COMPANION_STATE_ROOT = suiteStateRoot;

// Shape a legacy shard the way the pre-canonical versions laid state out:
// <plugin data dir>/state/<workspace-key>/. The workspace key is derived from
// the workspace path alone, so the canonical resolver's basename is the same
// key every root uses.
function writeLegacyShard(pluginDataDir, workspace, { metrics = [], state = null } = {}) {
  const shard = path.join(pluginDataDir, "state", path.basename(resolveStateDir(workspace)));
  fs.mkdirSync(shard, { recursive: true });
  if (metrics.length > 0) {
    fs.writeFileSync(
      path.join(shard, "metrics.jsonl"),
      `${metrics.map((row) => JSON.stringify(row)).join("\n")}\n`,
      "utf8"
    );
  }
  if (state) {
    fs.writeFileSync(path.join(shard, "state.json"), `${JSON.stringify(state, null, 2)}\n`, "utf8");
  }
  return shard;
}

test("resolveStateDir puts each workspace under the canonical state root", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);

  assert.equal(stateDir.startsWith(suiteStateRoot), true);
  assert.match(path.basename(stateDir), /.+-[a-f0-9]{16}$/);
});

test("resolveStateDir ignores ambient CLAUDE_PLUGIN_DATA — one root per workspace across invocation contexts", () => {
  const workspace = makeTempDir();
  const foreignData = makeTempDir();
  const canonical = resolveStateDir(workspace);
  process.env.CLAUDE_PLUGIN_DATA = foreignData;

  try {
    assert.equal(resolveStateDir(workspace), canonical);
    ensureStateDir(workspace);
    assert.equal(fs.existsSync(canonical), true);
    // The ambient dir must never even be created, let alone written to.
    assert.equal(fs.existsSync(path.join(foreignData, "state")), false);
  } finally {
    delete process.env.CLAUDE_PLUGIN_DATA;
  }
});

test("without the override, the canonical root lives under the user's home dir — never tmpdir, never plugin data", () => {
  const workspace = makeTempDir();
  const foreignData = makeTempDir();
  delete process.env.CODEX_COMPANION_STATE_ROOT;
  process.env.CLAUDE_PLUGIN_DATA = foreignData;

  try {
    // Pure path computation — nothing is created under the real home dir.
    const stateDir = resolveStateDir(workspace);
    assert.equal(stateDir.startsWith(path.join(os.homedir(), ".claude", "codex-companion")), true);
  } finally {
    process.env.CODEX_COMPANION_STATE_ROOT = suiteStateRoot;
    delete process.env.CLAUDE_PLUGIN_DATA;
  }
});

test("consolidateLegacyState imports only this plugin's metrics rows from an ambient legacy shard, once", () => {
  const workspace = makeTempDir();
  const foreignData = makeTempDir();
  const shard = writeLegacyShard(foreignData, workspace, {
    metrics: [
      { at: "2026-08-01T00:00:00.000Z", kind: "startup", plugin: "codex", transport: "direct", ms: 11 },
      { at: "2026-08-02T00:00:00.000Z", kind: "startup", plugin: "cursor", transport: "wsl", ms: 22 },
      { at: "2026-08-03T00:00:00.000Z", kind: "startup", transport: "direct", ms: 33 }
    ]
  });
  process.env.CLAUDE_PLUGIN_DATA = foreignData;

  try {
    const summary = consolidateLegacyState(workspace);
    assert.equal(summary.importedMetrics, 1);
    // Only the codex-stamped row crosses; the sibling plugin's row and the
    // unattributable row stay behind for their own owners.
    assert.deepEqual(readStartupMetrics(workspace).map((m) => m.ms), [11]);
    assert.equal(fs.existsSync(path.join(shard, "metrics.jsonl.migrated-codex")), true);
    assert.equal(fs.existsSync(path.join(shard, "metrics.jsonl")), true);

    const again = consolidateLegacyState(workspace);
    assert.equal(again.importedMetrics, 0);
    assert.deepEqual(readStartupMetrics(workspace).map((m) => m.ms), [11]);
  } finally {
    delete process.env.CLAUDE_PLUGIN_DATA;
  }
});

test("consolidateLegacyState adopts legacy config only while the canonical state file does not exist", () => {
  const workspace = makeTempDir();
  const foreignData = makeTempDir();
  writeLegacyShard(foreignData, workspace, {
    state: { version: 1, config: { stopReviewGate: true }, jobs: [] }
  });
  process.env.CLAUDE_PLUGIN_DATA = foreignData;

  try {
    const summary = consolidateLegacyState(workspace);
    assert.equal(summary.adoptedConfig, true);
    assert.equal(loadState(workspace).config.stopReviewGate, true);

    // An established canonical file is never overwritten by residue.
    setConfig(workspace, "stopReviewGate", false);
    const secondData = makeTempDir();
    writeLegacyShard(secondData, workspace, {
      state: { version: 1, config: { stopReviewGate: true }, jobs: [] }
    });
    process.env.CLAUDE_PLUGIN_DATA = secondData;
    const again = consolidateLegacyState(workspace);
    assert.equal(again.adoptedConfig, false);
    assert.equal(loadState(workspace).config.stopReviewGate, false);
  } finally {
    delete process.env.CLAUDE_PLUGIN_DATA;
  }
});

test("the state-root override gates default legacy scans off — hermetic envs cannot mark real machine shards", () => {
  // Live regression (2026-08-07): e2e tests running the companion with the
  // repo as cwd consolidated the REAL machine's legacy shards — rows were
  // imported into a throwaway temp root and .migrated markers were stamped
  // onto the real shards, permanently suppressing the genuine migration.
  // With the override set (test isolation), only an explicitly planted
  // ambient CLAUDE_PLUGIN_DATA is a legacy source; the config-dir and
  // tmpdir-fallback scans need an explicit homedir opt-in.
  const workspace = makeTempDir();
  const legacyDir = path.join(os.tmpdir(), "codex-companion", path.basename(resolveStateDir(workspace)));
  fs.mkdirSync(legacyDir, { recursive: true });
  fs.writeFileSync(
    path.join(legacyDir, "metrics.jsonl"),
    `${JSON.stringify({ at: "2026-08-01T00:00:00.000Z", kind: "startup", plugin: "codex", transport: "direct", ms: 99 })}\n`,
    "utf8"
  );

  const gated = consolidateLegacyState(workspace);
  assert.deepEqual(gated.shards, []);
  assert.equal(fs.existsSync(path.join(legacyDir, "metrics.jsonl.migrated-codex")), false);

  // The explicit opt-in re-enables the default scans (production has no
  // override, so it always scans; this is the pre-install tmpdir import).
  const opted = consolidateLegacyState(workspace, { homedir: makeTempDir() });
  assert.equal(opted.importedMetrics, 1);
  assert.deepEqual(readStartupMetrics(workspace).map((m) => m.ms), [99]);
  assert.equal(fs.existsSync(path.join(legacyDir, "metrics.jsonl.migrated-codex")), true);
});

test("listLegacyStateShards discovers shards under the user's plugin-data dir without any ambient env", () => {
  const workspace = makeTempDir();
  const fakeHome = makeTempDir();
  const pluginDataDir = path.join(fakeHome, ".claude", "plugins", "data", "codex-old-marketplace");
  const shard = writeLegacyShard(pluginDataDir, workspace, {
    state: { version: 1, config: { stopReviewGate: false }, jobs: [] }
  });

  const shards = listLegacyStateShards(workspace, { env: {}, homedir: fakeHome });
  assert.deepEqual(shards, [shard]);

  // A relocated harness config dir (CLAUDE_CONFIG_DIR) is honored for the
  // scan, since plugins/data lives under it.
  const shardsViaConfigDir = listLegacyStateShards(workspace, {
    env: { CLAUDE_CONFIG_DIR: path.join(fakeHome, ".claude") },
    homedir: makeTempDir()
  });
  assert.deepEqual(shardsViaConfigDir, [shard]);
});

test("summarizeLegacyStateShards reports job counts and pending metrics per shard", () => {
  const workspace = makeTempDir();
  const foreignData = makeTempDir();
  const shard = writeLegacyShard(foreignData, workspace, {
    metrics: [{ at: "2026-08-01T00:00:00.000Z", kind: "startup", plugin: "codex", transport: "direct", ms: 5 }],
    state: {
      version: 1,
      config: { stopReviewGate: false },
      jobs: [
        { id: "job-live", status: "running" },
        { id: "job-done", status: "completed" }
      ]
    }
  });
  process.env.CLAUDE_PLUGIN_DATA = foreignData;

  try {
    const [summary] = summarizeLegacyStateShards(workspace);
    assert.equal(summary.dir, shard);
    assert.equal(summary.jobs.total, 2);
    assert.equal(summary.jobs.active, 1);
    assert.equal(summary.pendingMetrics, true);

    consolidateLegacyState(workspace);
    const [after] = summarizeLegacyStateShards(workspace);
    assert.equal(after.pendingMetrics, false);
  } finally {
    delete process.env.CLAUDE_PLUGIN_DATA;
  }
});

test("saveState prunes dropped job artifacts when indexed jobs exceed the cap", () => {
  const workspace = makeTempDir();
  const stateFile = resolveStateFile(workspace);
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });

  const jobs = Array.from({ length: 51 }, (_, index) => {
    const jobId = `job-${index}`;
    const updatedAt = new Date(Date.UTC(2026, 0, 1, 0, index, 0)).toISOString();
    const logFile = resolveJobLogFile(workspace, jobId);
    const jobFile = resolveJobFile(workspace, jobId);
    fs.writeFileSync(logFile, `log ${jobId}\n`, "utf8");
    fs.writeFileSync(jobFile, JSON.stringify({ id: jobId, status: "completed" }, null, 2), "utf8");
    return {
      id: jobId,
      status: "completed",
      logFile,
      updatedAt,
      createdAt: updatedAt
    };
  });

  fs.writeFileSync(
    stateFile,
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  saveState(workspace, {
    version: 1,
    config: { stopReviewGate: false },
    jobs
  });

  const prunedJobFile = resolveJobFile(workspace, "job-0");
  const prunedLogFile = resolveJobLogFile(workspace, "job-0");
  const retainedJobFile = resolveJobFile(workspace, "job-50");
  const retainedLogFile = resolveJobLogFile(workspace, "job-50");
  const jobsDir = path.dirname(prunedJobFile);

  assert.equal(fs.existsSync(retainedJobFile), true);
  assert.equal(fs.existsSync(retainedLogFile), true);

  const savedState = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  assert.equal(savedState.jobs.length, 50);
  assert.deepEqual(
    savedState.jobs.map((job) => job.id),
    Array.from({ length: 50 }, (_, index) => `job-${50 - index}`)
  );
  assert.deepEqual(
    fs.readdirSync(jobsDir).sort(),
    Array.from({ length: 50 }, (_, index) => `job-${index + 1}`)
      .flatMap((jobId) => [`${jobId}.json`, `${jobId}.log`])
      .sort()
  );
});

test("saveState preserves the cancel flag of a pruned job", () => {
  const workspace = makeTempDir();
  const stateFile = resolveStateFile(workspace);
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });

  const jobs = Array.from({ length: 51 }, (_, index) => {
    const jobId = `job-${index}`;
    const updatedAt = new Date(Date.UTC(2026, 0, 1, 0, index, 0)).toISOString();
    return {
      id: jobId,
      status: "completed",
      updatedAt,
      createdAt: updatedAt
    };
  });

  fs.writeFileSync(
    stateFile,
    `${JSON.stringify({ version: 1, config: { stopReviewGate: false }, jobs }, null, 2)}\n`,
    "utf8"
  );
  writeJobFile(workspace, "job-0", jobs[0]);
  writeCancelFlag(workspace, "job-0");

  saveState(workspace, { version: 1, config: { stopReviewGate: false }, jobs });

  const jobsDir = resolveJobsDir(workspace);
  assert.equal(fs.existsSync(resolveJobFile(workspace, "job-0")), false);
  assert.equal(fs.existsSync(path.join(jobsDir, "job-0.cancelled")), true);
});

test("saveState preserves unresolved jobs ahead of terminal history at the cap", () => {
  const workspace = makeTempDir();
  const unresolved = {
    id: "job-unresolved-oldest",
    status: "failed",
    phase: "cleanup-pending",
    pid: 47401,
    cleanupOutcome: { verified: false },
    cleanupFailure: "cleanup remains unverified",
    updatedAt: "2026-07-28T07:00:00.000Z"
  };
  writeJobFile(workspace, unresolved.id, unresolved);
  const terminal = Array.from({ length: 50 }, (_, index) => ({
    id: `job-terminal-${index}`,
    status: "completed",
    phase: "done",
    updatedAt: new Date(Date.UTC(2026, 6, 28, 8, index)).toISOString()
  }));

  saveState(workspace, {
    version: 1,
    config: { stopReviewGate: false },
    jobs: [unresolved, ...terminal]
  });

  const saved = loadState(workspace);
  assert.equal(saved.jobs.length, 50);
  assert.equal(saved.jobs.some((job) => job.id === unresolved.id), true);
  assert.equal(fs.existsSync(resolveJobFile(workspace, unresolved.id)), true);
  assert.equal(saved.jobs.some((job) => job.id === "job-terminal-0"), false);
});

test("atomic writes leave no temporary files behind", () => {
  const workspace = makeTempDir();
  const updatedAt = "2026-01-01T00:00:00.000Z";
  const state = saveState(workspace, {
    version: 1,
    config: { stopReviewGate: false },
    jobs: [{ id: "job-1", status: "completed", updatedAt, createdAt: updatedAt }]
  });
  writeJobFile(workspace, "job-1", state.jobs[0]);

  const stateDirEntries = fs.readdirSync(resolveStateDir(workspace));
  const jobsDirEntries = fs.readdirSync(resolveJobsDir(workspace));
  assert.deepEqual(stateDirEntries.filter((entry) => entry.endsWith(".tmp")), []);
  assert.deepEqual(jobsDirEntries.filter((entry) => entry.endsWith(".tmp")), []);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(resolveStateFile(workspace), "utf8")).jobs.map((job) => job.id),
    ["job-1"]
  );
});

test("saveState writes state.json atomically via temp file and rename", () => {
  const workspace = makeTempDir();
  ensureStateDir(workspace);
  const stateFile = resolveStateFile(workspace);
  const originalContent = `${JSON.stringify({ version: 1, config: { stopReviewGate: false }, jobs: [] }, null, 2)}\n`;
  fs.writeFileSync(stateFile, originalContent, "utf8");

  const renameCalls = [];
  const originalRenameSync = fs.renameSync;
  fs.renameSync = (from, to) => {
    renameCalls.push([from, to]);
    throw new Error("simulated rename failure");
  };

  try {
    assert.throws(
      () =>
        saveState(workspace, {
          version: 1,
          config: { stopReviewGate: false },
          jobs: [
            {
              id: "job-1",
              status: "completed",
              updatedAt: "2026-01-01T00:00:00.000Z",
              createdAt: "2026-01-01T00:00:00.000Z"
            }
          ]
        }),
      /simulated rename failure/
    );
  } finally {
    fs.renameSync = originalRenameSync;
  }

  assert.equal(renameCalls.length, 1);
  assert.equal(renameCalls[0][1], stateFile);
  assert.match(path.basename(renameCalls[0][0]), /\.tmp$/);
  assert.equal(fs.readFileSync(stateFile, "utf8"), originalContent);
  assert.deepEqual(
    fs.readdirSync(resolveStateDir(workspace)).filter((entry) => entry.endsWith(".tmp")),
    []
  );
});

test("loadState quarantines a corrupt state file and rebuilds from surviving job files", () => {
  const workspace = makeTempDir();
  ensureStateDir(workspace);
  const stateFile = resolveStateFile(workspace);

  writeJobFile(workspace, "job-older", {
    id: "job-older",
    status: "completed",
    updatedAt: "2026-01-01T00:00:00.000Z",
    createdAt: "2026-01-01T00:00:00.000Z"
  });
  writeJobFile(workspace, "job-newer", {
    id: "job-newer",
    status: "completed",
    updatedAt: "2026-01-02T00:00:00.000Z",
    createdAt: "2026-01-02T00:00:00.000Z"
  });
  fs.writeFileSync(stateFile, '{"version":1,"config":{"stopReviewGate":true},"jobs":[{', "utf8");

  const warnings = [];
  const originalStderrWrite = process.stderr.write;
  process.stderr.write = (chunk) => {
    warnings.push(String(chunk));
    return true;
  };

  let state;
  try {
    state = loadState(workspace);
  } finally {
    process.stderr.write = originalStderrWrite;
  }

  assert.deepEqual(state.jobs.map((job) => job.id), ["job-newer", "job-older"]);
  assert.equal(state.config.stopReviewGate, false);
  // The rebuild is persisted durably in the same call: the state file is
  // rewritten, not left missing for the next reader to see an empty default.
  assert.equal(fs.existsSync(stateFile), true);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(stateFile, "utf8")).jobs.map((job) => job.id),
    ["job-newer", "job-older"]
  );
  assert.equal(
    fs.readdirSync(path.dirname(stateFile)).filter((entry) => entry.startsWith("state.json.corrupt-")).length,
    1
  );
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Warning: .*corrupt/);

  const saved = saveState(workspace, state);
  assert.deepEqual(saved.jobs.map((job) => job.id), ["job-newer", "job-older"]);
  const persisted = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  assert.deepEqual(persisted.jobs.map((job) => job.id), ["job-newer", "job-older"]);
});

test("loadState rebuild skips corrupt job files and keeps the valid ones", () => {
  const workspace = makeTempDir();
  ensureStateDir(workspace);
  const stateFile = resolveStateFile(workspace);
  const jobsDir = resolveJobsDir(workspace);

  writeJobFile(workspace, "job-valid", {
    id: "job-valid",
    status: "completed",
    updatedAt: "2026-01-01T00:00:00.000Z",
    createdAt: "2026-01-01T00:00:00.000Z"
  });
  fs.writeFileSync(path.join(jobsDir, "job-broken.json"), '{"id":"job-broken","status":', "utf8");
  fs.writeFileSync(path.join(jobsDir, "job-valid.log"), "log line\n", "utf8");
  fs.writeFileSync(stateFile, "not json at all", "utf8");

  const warnings = [];
  const originalStderrWrite = process.stderr.write;
  process.stderr.write = (chunk) => {
    warnings.push(String(chunk));
    return true;
  };

  let state;
  try {
    state = loadState(workspace);
  } finally {
    process.stderr.write = originalStderrWrite;
  }

  assert.deepEqual(state.jobs.map((job) => job.id), ["job-valid"]);
  assert.equal(warnings.length, 1);
});

test("loadState falls back to defaults when a corrupt state file has no job files to rebuild from", () => {
  const workspace = makeTempDir();
  ensureStateDir(workspace);
  const stateFile = resolveStateFile(workspace);
  fs.writeFileSync(stateFile, "{", "utf8");

  const warnings = [];
  const originalStderrWrite = process.stderr.write;
  process.stderr.write = (chunk) => {
    warnings.push(String(chunk));
    return true;
  };

  let state;
  try {
    state = loadState(workspace);
  } finally {
    process.stderr.write = originalStderrWrite;
  }

  assert.deepEqual(state.jobs, []);
  assert.equal(state.version, 1);
  assert.equal(state.config.stopReviewGate, false);
  assert.equal(warnings.length, 1);
});

test("a stale snapshot save cannot resurrect a cancelled job", () => {
  const workspace = makeTempDir();
  upsertJob(workspace, { id: "task-race", status: "running", pid: 4242 });

  // Simulate the cancel-vs-progress race: the progress path captured its
  // snapshot before cancel landed, then writes the whole file last.
  const staleSnapshot = loadState(workspace);
  upsertJob(workspace, { id: "task-race", status: "cancelled", pid: null });

  const staleJob = staleSnapshot.jobs.find((job) => job.id === "task-race");
  staleJob.status = "completed";
  staleJob.phase = "done";
  saveState(workspace, staleSnapshot);

  const finalJob = listJobs(workspace).find((job) => job.id === "task-race");
  assert.equal(finalJob.status, "cancelled");
  assert.equal(finalJob.pid ?? null, null);
});

test("upsertJob keeps cancellation authoritative over later transitions", () => {
  const workspace = makeTempDir();
  upsertJob(workspace, { id: "task-terminal", status: "cancelled", pid: null });
  upsertJob(workspace, { id: "task-terminal", status: "running", pid: 5151, phase: "starting" });
  upsertJob(workspace, { id: "task-terminal", status: "completed", pid: null, phase: "done" });

  const job = listJobs(workspace).find((entry) => entry.id === "task-terminal");
  assert.equal(job.status, "cancelled");
  assert.equal(job.pid ?? null, null);
});

test("verified cleanup facts and a completed cancellation are monotonic", () => {
  const workspace = makeTempDir();
  const verified = { attempted: true, delivered: true, verified: true };
  upsertJob(workspace, {
    id: "task-cleanup-monotonic",
    status: "cancelled",
    phase: "cancelled",
    pid: null,
    processIdentity: "5152@worker",
    cleanupOutcome: verified,
    appServerCleanupOutcome: verified,
    wslReap: { reaped: true },
    cleanupFailure: null
  });
  upsertJob(workspace, {
    id: "task-cleanup-monotonic",
    status: "cancelled",
    phase: "cleanup-pending",
    pid: 5152,
    processIdentity: "5152@worker",
    cleanupOutcome: { attempted: true, delivered: false, verified: false },
    appServerCleanupOutcome: { attempted: false, delivered: false, verified: false },
    wslReap: { reaped: false, survivors: [5252] },
    cleanupFailure: "stale concurrent cleanup failure"
  });

  const job = listJobs(workspace).find((entry) => entry.id === "task-cleanup-monotonic");
  assert.equal(job.status, "cancelled");
  assert.equal(job.phase, "cancelled");
  assert.equal(job.pid, null);
  assert.equal(job.cleanupFailure, null);
  assert.equal(job.cleanupOutcome.verified, true);
  assert.equal(job.appServerCleanupOutcome.verified, true);
  assert.equal(job.wslReap.reaped, true);
});

test("the state dir is private: 0o700 dir, 0o600 lock/cancel/log", (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX modes are required for this contract.");
    return;
  }
  const workspace = makeTempDir();
  upsertJob(workspace, { id: "task-private", status: "completed", pid: null });
  const stateDir = resolveStateDir(workspace);
  assert.equal(fs.statSync(stateDir).mode & 0o777, 0o700);

  const flag = writeCancelFlag(workspace, "task-private");
  assert.equal(fs.statSync(flag).mode & 0o777, 0o600);

  const logFile = createJobLogFile(workspace, "task-private", "Title");
  assert.equal(fs.statSync(logFile).mode & 0o777, 0o600);

  // A loose pre-existing dir from an older version is tightened on touch.
  fs.chmodSync(stateDir, 0o755);
  upsertJob(workspace, { id: "task-private-2", status: "completed", pid: null });
  assert.equal(fs.statSync(stateDir).mode & 0o777, 0o700);
});

test("a symlinked state dir is refused on both write and read, without write-through", (t) => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  fs.mkdirSync(path.dirname(stateDir), { recursive: true, mode: 0o700 });
  const elsewhere = makeTempDir();
  try {
    fs.symlinkSync(elsewhere, stateDir, "dir");
  } catch (error) {
    if (error?.code === "EPERM" || error?.code === "EACCES") {
      t.skip("Symlink creation requires elevated privileges on this platform.");
      return;
    }
    throw error;
  }

  assert.throws(
    () => upsertJob(workspace, { id: "task-redirected", status: "queued", pid: null }),
    /not a private directory/
  );
  // The symlink target must gain no jobs/ tree — the refusal comes before any
  // create, so nothing was written through the link.
  assert.equal(fs.existsSync(path.join(elsewhere, "jobs")), false);
  // Readers refuse the same way instead of trusting redirected state.
  fs.writeFileSync(path.join(elsewhere, "state.json"), '{"jobs":[{"id":"planted"}]}');
  assert.throws(() => loadState(workspace), /not a private directory/);
});

test("a state root owned by another user is refused (squat resistance)", (t) => {
  if (process.platform === "win32" || typeof process.getuid !== "function") {
    t.skip("POSIX ownership is required for this contract.");
    return;
  }
  if (process.getuid() !== 0) {
    t.skip("Simulating a foreign-owned root requires chown, i.e. root.");
    return;
  }
  // Isolate to a private root so chowning it to another uid never poisons
  // the suite-wide canonical override the other tests in this file use.
  const workspace = makeTempDir();
  const stateRoot = makeTempDir();
  const previous = process.env.CODEX_COMPANION_STATE_ROOT;
  process.env.CODEX_COMPANION_STATE_ROOT = stateRoot;
  try {
    fs.chownSync(stateRoot, 65534, 65534); // nobody
    assert.throws(() => ensureStateDir(workspace), /owned by another user/);
  } finally {
    process.env.CODEX_COMPANION_STATE_ROOT = previous;
  }
});

test("startup metrics append durably, rotate at the size cap, and tolerate junk lines", (t) => {
  const workspace = makeTempDir();
  appendStartupMetric(workspace, { kind: "startup", plugin: "codex", transport: "direct", ms: 123 });
  appendStartupMetric(workspace, { kind: "startup", plugin: "codex", transport: "direct", ms: 456 });
  const metricsFile = resolveMetricsFile(workspace);
  fs.appendFileSync(metricsFile, "not json\n");
  appendStartupMetric(workspace, { kind: "startup", plugin: "codex", transport: "broker", ms: 7 });

  const metrics = readStartupMetrics(workspace);
  assert.deepEqual(metrics.map((m) => m.ms), [123, 456, 7]);
  assert.ok(metrics.every((m) => typeof m.at === "string"));
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(metricsFile).mode & 0o777, 0o600);
  }

  // Push past the rotation cap: the current file rotates to .old and appends
  // continue fresh, but readers span BOTH generations, so rotation never
  // hides the history doctor and the broker decision read.
  appendStartupMetric(workspace, { kind: "startup", plugin: "codex", transport: "direct", ms: 111 });
  fs.appendFileSync(metricsFile, `${"x".repeat(600 * 1024)}\n`);
  appendStartupMetric(workspace, { kind: "startup", plugin: "codex", transport: "direct", ms: 222 });
  assert.equal(fs.existsSync(`${metricsFile}.old`), true);
  // The pre-rotation 111 survives via .old; the post-rotation 222 is in the
  // current file; the giant junk line parses to null and is dropped.
  const afterRotation = readStartupMetrics(workspace).map((m) => m.ms);
  assert.ok(afterRotation.includes(111), JSON.stringify(afterRotation));
  assert.ok(afterRotation.includes(222), JSON.stringify(afterRotation));
});

test("a corrupt state.json is quarantined and the rebuilt index is persisted", () => {
  const workspace = makeTempDir();
  upsertJob(workspace, { id: "task-survivor", status: "completed", pid: null });
  writeJobFile(workspace, "task-survivor", { id: "task-survivor", status: "completed" });

  const stateFile = path.join(resolveStateDir(workspace), "state.json");
  fs.writeFileSync(stateFile, "{ not valid json");

  const rebuilt = loadState(workspace);
  assert.equal(rebuilt.jobs.some((job) => job.id === "task-survivor"), true);

  // The rebuild must be durable: a fresh read of the (rewritten) state file
  // must still know the job, and the corrupt original must be quarantined
  // alongside it — otherwise the next reader sees an empty default index
  // and every jobs/*.json becomes an orphan.
  assert.equal(fs.existsSync(stateFile), true);
  const reread = loadState(workspace);
  assert.equal(reread.jobs.some((job) => job.id === "task-survivor"), true);
  const quarantined = fs.readdirSync(resolveStateDir(workspace)).filter((name) => name.includes(".corrupt-"));
  assert.equal(quarantined.length, 1);
});

test("concurrent state updates are serialized by the state lock", async () => {
  const workspace = makeTempDir();
  updateState(workspace, (state) => {
    state.config.counter = 0;
  });

  // The workers must genuinely overlap or the lock is never contended: spawn
  // them all before awaiting any (sequential spawnSync would serialize the
  // increments without ever exercising the lock's retry path).
  const workers = 6;
  const incrementsPerWorker = 5;
  const script = `
    import { updateState } from ${JSON.stringify(new URL("../plugins/codex/scripts/lib/state.mjs", import.meta.url).href)};
    for (let i = 0; i < ${incrementsPerWorker}; i += 1) {
      updateState(${JSON.stringify(workspace)}, (state) => {
        state.config.counter = (state.config.counter ?? 0) + 1;
      });
    }
  `;
  const results = await Promise.all(
    Array.from({ length: workers }, () =>
      new Promise((resolve) => {
        const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
          env: process.env,
          stdio: ["ignore", "ignore", "pipe"]
        });
        let stderr = "";
        child.stderr.setEncoding("utf8");
        child.stderr.on("data", (chunk) => {
          stderr += chunk;
        });
        child.on("close", (status) => resolve({ status, stderr }));
        child.on("error", (error) => resolve({ status: -1, stderr: String(error) }));
      })
    )
  );
  for (const result of results) {
    assert.equal(result.status, 0, result.stderr);
  }

  // The lock is deliberately availability-over-strictness: after
  // STATE_LOCK_TIMEOUT_MS it warns and proceeds unlocked rather than bricking
  // the CLI. On a starved machine that path can legitimately fire and drop
  // increments, so a lower count there is DESIGNED behavior, not a lost-update
  // bug. Only assert strict serialization when no worker took that escape
  // hatch — conflating the two produces a flaky test that cries wolf about a
  // real race it is meant to guard.
  const proceededUnlocked = results.some((result) => /proceeding without it/.test(result.stderr));
  const counter = loadState(workspace).config.counter;
  if (proceededUnlocked) {
    assert.ok(counter > 0 && counter <= workers * incrementsPerWorker, `unexpected counter ${counter}`);
    return;
  }
  assert.equal(counter, workers * incrementsPerWorker);
});

test("the warned unlocked path survives rename contention instead of crashing", async () => {
  // Regression for a live 2026-08-07 failure: two workers timed out on the
  // lock, both proceeded unlocked, and their concurrent state.json renames
  // collided — EPERM from renameSync crashed a worker. Hold the lock with a
  // fresh mtime (well under STATE_LOCK_STALE_MS, so nobody steals it) and
  // every worker times out into the warned unlocked path on the SAME 5s
  // deadline — synchronized renames, the exact collision shape observed.
  // A collision on any given run is probabilistic, so this is a tripwire,
  // not a proof: it can never false-fail, because unlocked lost updates are
  // designed behavior and asserted only as bounds.
  const workspace = makeTempDir();
  updateState(workspace, (state) => {
    state.config.counter = 0;
  });
  const lockFile = path.join(resolveStateDir(workspace), "state.lock");
  fs.writeFileSync(lockFile, "held-by-test", { mode: 0o600 });
  // A FUTURE mtime makes the stale check (now - mtime > STATE_LOCK_STALE_MS)
  // unsatisfiable for the whole test, so no worker can steal the lock even
  // under heavy process-start skew — every worker must take the warned
  // unlocked path deterministically.
  const future = new Date(Date.now() + 60_000);
  fs.utimesSync(lockFile, future, future);
  try {
    const workers = 4;
    const script = `
      import { updateState } from ${JSON.stringify(new URL("../plugins/codex/scripts/lib/state.mjs", import.meta.url).href)};
      updateState(${JSON.stringify(workspace)}, (state) => {
        state.config.counter = (state.config.counter ?? 0) + 1;
      });
    `;
    const results = await Promise.all(
      Array.from({ length: workers }, () =>
        new Promise((resolve) => {
          const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
            env: process.env,
            stdio: ["ignore", "ignore", "pipe"]
          });
          let stderr = "";
          child.stderr.setEncoding("utf8");
          child.stderr.on("data", (chunk) => {
            stderr += chunk;
          });
          child.on("close", (status) => resolve({ status, stderr }));
          child.on("error", (error) => resolve({ status: -1, stderr: String(error) }));
        })
      )
    );
    for (const result of results) {
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stderr, /proceeding without it/);
    }
    const counter = loadState(workspace).config.counter;
    assert.ok(counter > 0 && counter <= workers, `unexpected counter ${counter}`);
  } finally {
    fs.unlinkSync(lockFile);
  }
});

test("a transient rename failure is retried once and the write lands", (t) => {
  const workspace = makeTempDir();
  updateState(workspace, (state) => {
    state.config.counter = 1;
  });

  const realRenameSync = fs.renameSync;
  let calls = 0;
  fs.renameSync = (from, to) => {
    calls += 1;
    if (calls === 1) {
      const error = /** @type {NodeJS.ErrnoException} */ (new Error("EPERM: operation not permitted"));
      error.code = "EPERM";
      throw error;
    }
    return realRenameSync(from, to);
  };
  t.after(() => {
    fs.renameSync = realRenameSync;
  });

  updateState(workspace, (state) => {
    state.config.counter = 2;
  });
  assert.equal(calls, 2);
  assert.equal(loadState(workspace).config.counter, 2);
});

test("persistent rename failure exhausts the bounded retry loudly, leaving no residue", (t) => {
  const workspace = makeTempDir();
  updateState(workspace, (state) => {
    state.config.counter = 7;
  });

  const realRenameSync = fs.renameSync;
  let calls = 0;
  fs.renameSync = () => {
    calls += 1;
    const error = /** @type {NodeJS.ErrnoException} */ (new Error("EACCES: permission denied"));
    error.code = "EACCES";
    throw error;
  };
  t.after(() => {
    fs.renameSync = realRenameSync;
  });

  assert.throws(
    () =>
      updateState(workspace, (state) => {
        state.config.counter = 8;
      }),
    /EACCES/
  );
  // 1 initial attempt + 10 retries = 11 calls, then the loud failure.
  assert.equal(calls, 11);
  fs.renameSync = realRenameSync;
  assert.equal(loadState(workspace).config.counter, 7);
  const residue = fs.readdirSync(resolveStateDir(workspace)).filter((entry) => entry.endsWith(".tmp"));
  assert.deepEqual(residue, []);
});
