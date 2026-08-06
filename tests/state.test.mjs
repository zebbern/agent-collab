import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { spawn } from "node:child_process";

import { makeTempDir } from "./helpers.mjs";
import {
  appendStartupMetric,
  ensureStateDir,
  listJobs,
  loadState,
  readStartupMetrics,
  resolveMetricsFile,
  resolveJobFile,
  resolveJobLogFile,
  resolveJobsDir,
  resolveStateDir,
  resolveStateFile,
  saveState,
  updateState,
  upsertJob,
  writeCancelFlag,
  writeJobFile
} from "../plugins/codex/scripts/lib/state.mjs";
import { createJobLogFile } from "../plugins/codex/scripts/lib/tracked-jobs.mjs";

test("resolveStateDir uses a temp-backed per-workspace directory", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);

  assert.equal(stateDir.startsWith(os.tmpdir()), true);
  assert.match(path.basename(stateDir), /.+-[a-f0-9]{16}$/);
  assert.match(stateDir, new RegExp(`^${os.tmpdir().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
});

test("resolveStateDir uses CLAUDE_PLUGIN_DATA when it is provided", () => {
  const workspace = makeTempDir();
  const pluginDataDir = makeTempDir();
  const previousPluginDataDir = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginDataDir;

  try {
    const stateDir = resolveStateDir(workspace);

    assert.equal(stateDir.startsWith(path.join(pluginDataDir, "state")), true);
    assert.match(path.basename(stateDir), /.+-[a-f0-9]{16}$/);
    assert.match(
      stateDir,
      new RegExp(`^${path.join(pluginDataDir, "state").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`)
    );
  } finally {
    if (previousPluginDataDir == null) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previousPluginDataDir;
    }
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
  staleJob.phase = "verifying";
  saveState(workspace, staleSnapshot);

  const finalJob = listJobs(workspace).find((job) => job.id === "task-race");
  assert.equal(finalJob.status, "cancelled");
  assert.equal(finalJob.pid ?? null, null);
});

test("upsertJob refuses to revive a terminal job", () => {
  const workspace = makeTempDir();
  upsertJob(workspace, { id: "task-terminal", status: "cancelled", pid: null });
  upsertJob(workspace, { id: "task-terminal", status: "running", pid: 5151, phase: "starting" });

  const job = listJobs(workspace).find((entry) => entry.id === "task-terminal");
  assert.equal(job.status, "cancelled");
  assert.equal(job.pid ?? null, null);
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
  // Isolate to a private plugin-data root so chowning it to another uid never
  // poisons the shared /tmp fallback that the other tests in this file use.
  const workspace = makeTempDir();
  const pluginData = makeTempDir();
  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginData;
  try {
    const stateRoot = path.join(pluginData, "state");
    fs.mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
    fs.chownSync(stateRoot, 65534, 65534); // nobody
    assert.throws(() => ensureStateDir(workspace), /owned by another user/);
  } finally {
    if (previous === undefined) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previous;
    }
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
