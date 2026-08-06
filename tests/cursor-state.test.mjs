// Mirrors the codex state concurrency tests for the cursor plugin's copy of
// the chassis: the state index must never resurrect a terminal job, and
// cross-process updates must serialize through the state lock.
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { spawn } from "node:child_process";

import { makeTempDir } from "./helpers.mjs";
import {
  ensureStateDir,
  listJobs,
  loadState,
  resolveStateDir,
  saveState,
  updateState,
  upsertJob,
  writeCancelFlag,
  writeJobFile
} from "../plugins/cursor/scripts/lib/state.mjs";
import { createJobLogFile } from "../plugins/cursor/scripts/lib/tracked-jobs.mjs";

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
  assert.equal(fs.existsSync(path.join(elsewhere, "jobs")), false);
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

test("a corrupt state.json is quarantined and the rebuilt index is persisted", () => {
  const workspace = makeTempDir();
  upsertJob(workspace, { id: "task-survivor", status: "completed", pid: null });
  writeJobFile(workspace, "task-survivor", { id: "task-survivor", status: "completed" });

  const stateFile = path.join(resolveStateDir(workspace), "state.json");
  fs.writeFileSync(stateFile, "{ not valid json");

  const rebuilt = loadState(workspace);
  assert.equal(rebuilt.jobs.some((job) => job.id === "task-survivor"), true);
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
    import { updateState } from ${JSON.stringify(new URL("../plugins/cursor/scripts/lib/state.mjs", import.meta.url).href)};
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
