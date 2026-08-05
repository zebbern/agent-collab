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
  listJobs,
  loadState,
  resolveStateDir,
  saveState,
  updateState,
  upsertJob,
  writeJobFile
} from "../plugins/cursor/scripts/lib/state.mjs";

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

  assert.equal(loadState(workspace).config.counter, workers * incrementsPerWorker);
});
