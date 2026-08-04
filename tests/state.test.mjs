import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir } from "./helpers.mjs";
import {
  ensureStateDir,
  loadState,
  resolveJobFile,
  resolveJobLogFile,
  resolveJobsDir,
  resolveStateDir,
  resolveStateFile,
  saveState,
  writeCancelFlag,
  writeJobFile
} from "../plugins/codex/scripts/lib/state.mjs";

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
  assert.equal(fs.existsSync(stateFile), false);
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
