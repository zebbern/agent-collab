// End-to-end tests for the cursor companion CLI: setup, task runs, stream
// telemetry, status/result rendering, reviews, and cancel — all backed by the
// fake cursor-agent fixture installed on a PATH-prepended bin dir, so the
// adapter's native transport is exercised on every platform and WSL is never
// touched. Review prompts are multi-line, so those tests additionally pin
// CURSOR_COMPANION_TEST_BINARY at the fixture's node-script twin; the Windows
// cmd.exe shim used for PATH discovery truncates arguments at the first
// newline, and the override keeps the spawn argv-only everywhere.
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { spawn } from "node:child_process";

import { buildCursorEnv, installFakeCursorAgent } from "./fake-cursor-agent-fixture.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";
import { readStartupMetrics, resolveStateDir, upsertJob, writeJobFile } from "../plugins/cursor/scripts/lib/state.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "plugins", "cursor", "scripts", "cursor-companion.mjs");

// Isolate cursor-companion state from any real plugin data dir on this host.
process.env.CLAUDE_PLUGIN_DATA = makeTempDir("cursor-plugin-runtime-state-");

function makeTaskRepo() {
  const repo = makeTempDir("cursor-plugin-test-");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  return repo;
}

function makeReviewRepo() {
  const repo = makeTempDir("cursor-plugin-test-");
  initGitRepo(repo);
  fs.mkdirSync(path.join(repo, "src"));
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = 1;\n");
  run("git", ["add", "src/app.js"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = 2;\n");
  return repo;
}

// Reviews interpolate multi-line prompts; route them through the fixture's
// node-script twin so the argv survives intact on Windows. PATH-based
// discovery stays covered by the setup and task tests.
function withTestBinaryOverride(binDir) {
  return {
    ...buildCursorEnv(binDir),
    CURSOR_COMPANION_TEST_BINARY: path.join(binDir, "cursor-agent.mjs")
  };
}

function readFakeState(binDir) {
  return JSON.parse(fs.readFileSync(path.join(binDir, "fake-cursor-state.json"), "utf8"));
}

function readLatestJob(repo) {
  const stateDir = resolveStateDir(repo);
  const state = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
  const job = state.jobs[0];
  const storedJob = JSON.parse(fs.readFileSync(path.join(stateDir, "jobs", `${job.id}.json`), "utf8"));
  return { stateDir, job, storedJob };
}

async function waitFor(predicate, { timeoutMs = 5000, intervalMs = 50 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = await predicate();
    if (value) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("Timed out waiting for condition.");
}

test("setup reports ready with the native transport when the fake cursor-agent is logged in", () => {
  const binDir = makeTempDir();
  installFakeCursorAgent(binDir);

  const result = run("node", [SCRIPT, "setup", "--json"], {
    cwd: ROOT,
    env: buildCursorEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ready, true);
  assert.equal(payload.cursor.available, true);
  assert.equal(payload.cursor.detail, "2026.07.23-fake");
  assert.equal(payload.cursor.transport, "native");
  assert.equal(payload.auth.loggedIn, true);
  assert.match(payload.auth.detail, /Logged in as fake@example\.com/);
  assert.equal(payload.platform, process.platform);
});

test("setup reports the login step when cursor-agent says it is not logged in", () => {
  const binDir = makeTempDir();
  installFakeCursorAgent(binDir, "logged-out");
  const env = buildCursorEnv(binDir);
  delete env.CURSOR_API_KEY;

  const result = run("node", [SCRIPT, "setup", "--json"], {
    cwd: ROOT,
    env
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ready, false);
  assert.equal(payload.cursor.available, true);
  assert.equal(payload.auth.loggedIn, false);
  assert.match(payload.auth.detail, /Not logged in/i);
  assert.ok(payload.nextSteps.some((step) => /cursor-agent login/.test(step)), JSON.stringify(payload.nextSteps));
});

test("setup trusts CURSOR_API_KEY when the status command alone says logged out", () => {
  const binDir = makeTempDir();
  installFakeCursorAgent(binDir, "logged-out");

  const result = run("node", [SCRIPT, "setup", "--json"], {
    cwd: ROOT,
    env: {
      ...buildCursorEnv(binDir),
      CURSOR_API_KEY: "test-key"
    }
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ready, true);
  assert.equal(payload.auth.loggedIn, true);
  assert.equal(payload.auth.method, "api-key");
  assert.equal(payload.auth.source, "env");
  assert.match(payload.auth.detail, /API key configured via CURSOR_API_KEY/);
});

test("task stores the init-resolved session id, model, and native transport", () => {
  const repo = makeTaskRepo();
  const binDir = makeTempDir();
  installFakeCursorAgent(binDir);

  const result = run("node", [SCRIPT, "task", "check the fake stream"], {
    cwd: repo,
    env: buildCursorEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    result.stdout,
    "Handled the requested task.\nTask prompt accepted.\n\nCursor session ID: sess-fake-1\nResume in Cursor: cursor-agent --resume sess-fake-1\n"
  );

  const { job, storedJob } = readLatestJob(repo);
  assert.equal(job.status, "completed");
  assert.equal(storedJob.status, "completed");
  assert.equal(storedJob.threadId, "sess-fake-1");
  assert.equal(storedJob.result.threadId, "sess-fake-1");
  // Foreground runs must carry the runner's ownership proof — a record
  // without it is uncancellable (cancel refuses unproven PIDs).
  assert.equal(typeof storedJob.processIdentity, "string", JSON.stringify(storedJob));
  assert.match(storedJob.processIdentity, /@/);
  // The stored model comes from the stream's init event, not the request.
  assert.equal(storedJob.result.model, "composer-2-fake");
  assert.equal(storedJob.result.transport, "native");
  assert.equal(storedJob.result.transportReason, null);
  assert.equal(storedJob.result.durationMs, 42);
  assert.equal(storedJob.result.rawOutput, "Handled the requested task.\nTask prompt accepted.");

  const args = readFakeState(binDir).lastArgs;
  assert.deepEqual(args.slice(0, 4), ["-p", "check the fake stream", "--output-format", "stream-json"]);
  assert.equal(args.includes("--force"), false);
  assert.equal(args.includes("--model"), false);
  const workspaceArg = args[args.indexOf("--workspace") + 1];
  assert.equal(fs.realpathSync.native(workspaceArg), fs.realpathSync.native(repo));
});

test("task --model passes --model through to cursor-agent", () => {
  const repo = makeTaskRepo();
  const binDir = makeTempDir();
  installFakeCursorAgent(binDir);

  const result = run("node", [SCRIPT, "task", "--model", "composer-1-test", "check the model flag"], {
    cwd: repo,
    env: buildCursorEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const args = readFakeState(binDir).lastArgs;
  const modelIndex = args.indexOf("--model");
  assert.notEqual(modelIndex, -1);
  assert.equal(args[modelIndex + 1], "composer-1-test");

  const { storedJob } = readLatestJob(repo);
  assert.equal(storedJob.result.model, "composer-1-test");
});

test("write-mode task passes --force while read mode never does", () => {
  const repo = makeTaskRepo();
  const binDir = makeTempDir();
  installFakeCursorAgent(binDir);

  const writeRun = run("node", [SCRIPT, "task", "--write", "apply the fix"], {
    cwd: repo,
    env: buildCursorEnv(binDir)
  });
  assert.equal(writeRun.status, 0, writeRun.stderr);
  assert.equal(readFakeState(binDir).lastArgs.includes("--force"), true);
  assert.equal(readLatestJob(repo).storedJob.write, true);

  const readRun = run("node", [SCRIPT, "task", "inspect the fix"], {
    cwd: repo,
    env: buildCursorEnv(binDir)
  });
  assert.equal(readRun.status, 0, readRun.stderr);
  assert.equal(readFakeState(binDir).lastArgs.includes("--force"), false);
});

test("task --resume passes --resume and keeps the prior chat id", () => {
  const repo = makeTaskRepo();
  const binDir = makeTempDir();
  installFakeCursorAgent(binDir);

  const result = run("node", [SCRIPT, "task", "--resume", "sess-prior"], {
    cwd: repo,
    env: buildCursorEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Resumed the prior chat\./);
  assert.match(result.stdout, /Resume in Cursor: cursor-agent --resume sess-prior/);

  const args = readFakeState(binDir).lastArgs;
  const resumeIndex = args.indexOf("--resume");
  assert.notEqual(resumeIndex, -1);
  assert.equal(args[resumeIndex + 1], "sess-prior");
  assert.match(args[args.indexOf("-p") + 1], /^Continue from the current chat state\./);

  const { storedJob } = readLatestJob(repo);
  assert.equal(storedJob.threadId, "sess-prior");

  // A resume run must still record a startup sample — the init-gated recorder
  // (not sessionId presence, which is pre-seeded on resume) fires when the
  // agent's init event lands.
  const metrics = readStartupMetrics(repo).filter((m) => m.kind === "startup");
  assert.equal(metrics.length, 1, JSON.stringify(metrics));
  assert.equal(metrics[0].plugin, "cursor");
  assert.ok(Number.isFinite(metrics[0].ms));
});

test("task surfaces the Cursor auth error when the run is rejected", () => {
  const repo = makeTaskRepo();
  const binDir = makeTempDir();
  installFakeCursorAgent(binDir, "auth-error");

  const result = run("node", [SCRIPT, "task", "check failed auth"], {
    cwd: repo,
    env: buildCursorEnv(binDir)
  });

  assert.equal(result.status, 1);
  assert.match(result.stdout, /Not authenticated\. Run cursor-agent login and retry\./);

  const { job, storedJob } = readLatestJob(repo);
  assert.equal(job.status, "failed");
  assert.equal(storedJob.result.status, 1);
});

test("assistant chunks are concatenated when the result event omits final text", () => {
  const repo = makeTaskRepo();
  const binDir = makeTempDir();
  installFakeCursorAgent(binDir, "streamed-answer");

  const result = run("node", [SCRIPT, "task", "check chunked answers"], {
    cwd: repo,
    env: buildCursorEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^Handled the requested task\.\nTask prompt accepted\.\n/);

  const { storedJob } = readLatestJob(repo);
  assert.equal(storedJob.result.rawOutput, "Handled the requested task.\nTask prompt accepted.");
});

test("tool_call telemetry maps to fileChanges and commandExecutions", () => {
  const repo = makeTaskRepo();
  const binDir = makeTempDir();
  installFakeCursorAgent(binDir, "with-file-edit");

  const result = run("node", [SCRIPT, "task", "--write", "edit a file"], {
    cwd: repo,
    env: buildCursorEnv(binDir)
  });
  assert.equal(result.status, 0, result.stderr);

  const { job, storedJob } = readLatestJob(repo);
  assert.equal(storedJob.result.fileChanges.length, 1);
  assert.equal(storedJob.result.fileChanges[0].path, "out.txt");
  assert.ok(Number.isFinite(Date.parse(storedJob.result.fileChanges[0].completedAt)));
  assert.deepEqual(storedJob.result.touchedFiles, ["out.txt"]);
  assert.equal(storedJob.result.commandExecutions.length, 1);
  assert.equal(storedJob.result.commandExecutions[0].command, "read README.md");

  const status = run("node", [SCRIPT, "status", job.id], {
    cwd: repo,
    env: buildCursorEnv(binDir)
  });
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /Progress signals:/);
  assert.match(status.stdout, /files changed: 1/);
  assert.match(status.stdout, /commands: 1 run \(1 distinct\)/);

  const stored = run("node", [SCRIPT, "result", job.id], {
    cwd: repo,
    env: buildCursorEnv(binDir)
  });
  assert.equal(stored.status, 0, stored.stderr);
  assert.match(stored.stdout, /Files changed:\n- out\.txt/);
});

test("status renders the model line and the cursor-agent resume handoff", () => {
  const repo = makeTaskRepo();
  const binDir = makeTempDir();
  installFakeCursorAgent(binDir);

  const taskRun = run("node", [SCRIPT, "task", "exercise status rendering"], {
    cwd: repo,
    env: buildCursorEnv(binDir)
  });
  assert.equal(taskRun.status, 0, taskRun.stderr);

  const { job } = readLatestJob(repo);
  const status = run("node", [SCRIPT, "status", job.id], {
    cwd: repo,
    env: buildCursorEnv(binDir)
  });

  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /# Cursor Job Status/);
  assert.match(status.stdout, /Transport: cursor-agent \(native\)/);
  assert.match(status.stdout, /Model: composer-2-fake/);
  assert.match(status.stdout, /Cursor session ID: sess-fake-1/);
  assert.match(status.stdout, /Resume in Cursor: cursor-agent --resume sess-fake-1/);

  const stored = run("node", [SCRIPT, "result"], {
    cwd: repo,
    env: buildCursorEnv(binDir)
  });
  assert.equal(stored.status, 0, stored.stderr);
  assert.match(stored.stdout, /^Handled the requested task\.\nTask prompt accepted\.\n/);
  assert.match(stored.stdout, /Model: composer-2-fake/);
  assert.match(stored.stdout, /Resume in Cursor: cursor-agent --resume sess-fake-1/);
  assert.match(stored.stdout, new RegExp(`Next: /cursor:status ${job.id} for job details`));
});

test("review runs read-only and renders structured findings", () => {
  const repo = makeReviewRepo();
  const binDir = makeTempDir();
  installFakeCursorAgent(binDir);

  const result = run("node", [SCRIPT, "review"], {
    cwd: repo,
    env: withTestBinaryOverride(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /# Cursor Review/);
  assert.match(result.stdout, /Verdict: needs-attention/);
  assert.match(result.stdout, /\[high\] Missing empty-state guard \(src\/app\.js:4-6\)/);
  assert.match(result.stdout, /Resume in Cursor: cursor-agent --resume sess-fake-1/);

  const args = readFakeState(binDir).lastArgs;
  assert.equal(args.includes("--force"), false);
  assert.match(args[args.indexOf("-p") + 1], /<output_schema>/);

  const { job, storedJob } = readLatestJob(repo);
  assert.equal(job.kind, "review");
  assert.equal(job.jobClass, "review");
  assert.equal(storedJob.threadId, "sess-fake-1");
  assert.equal(storedJob.result.result.verdict, "needs-attention");
  // In-process review runs must carry the runner's ownership proof — a
  // record without it is uncancellable (cancel refuses unproven PIDs).
  assert.equal(typeof storedJob.processIdentity, "string", JSON.stringify(storedJob));
  assert.match(storedJob.processIdentity, /@/);
  // A well-behaved agent leaves the workspace untouched: no drift section.
  assert.doesNotMatch(result.stdout, /Workspace changes during review/);
  assert.deepEqual(storedJob.result.workspaceDrift, []);
});

test("review surfaces files the agent wrote into the workspace", () => {
  const repo = makeReviewRepo();
  const binDir = makeTempDir();
  installFakeCursorAgent(binDir);

  const result = run("node", [SCRIPT, "review"], {
    cwd: repo,
    env: {
      ...withTestBinaryOverride(binDir),
      CURSOR_FAKE_WRITE_FILE: path.join(repo, "agent-scratch.txt")
    }
  });

  assert.equal(result.status, 0, result.stderr);
  // Reviews have no enforced read-only sandbox under --trust, so a write by
  // the agent must be reported loudly instead of slipping into the repo
  // unannounced (live incident: a review wrote git-diff helper scripts that
  // a blind `git add -A` then committed).
  assert.match(result.stdout, /## Workspace changes during review/);
  assert.match(result.stdout, /agent-scratch\.txt/);

  const { storedJob } = readLatestJob(repo);
  assert.deepEqual(storedJob.result.workspaceDrift, ["agent-scratch.txt"]);
});

test("review surfaces an agent rewrite of a file the user already had dirty", () => {
  const repo = makeReviewRepo();
  const binDir = makeTempDir();
  installFakeCursorAgent(binDir);

  // The user's own uncommitted work — the review target is dirty before the
  // agent ever runs, which is the common working-tree review shape.
  const dirtyFile = path.join(repo, "user-wip.txt");
  fs.writeFileSync(dirtyFile, "user work in progress\n");

  const result = run("node", [SCRIPT, "review"], {
    cwd: repo,
    env: {
      ...withTestBinaryOverride(binDir),
      CURSOR_FAKE_WRITE_FILE: dirtyFile
    }
  });

  assert.equal(result.status, 0, result.stderr);
  // Path-set membership alone would miss this: the file was dirty before
  // and after. Content fingerprinting must catch the rewrite.
  assert.match(result.stdout, /## Workspace changes during review/);
  assert.match(result.stdout, /user-wip\.txt/);

  const { storedJob } = readLatestJob(repo);
  assert.deepEqual(storedJob.result.workspaceDrift, ["user-wip.txt"]);
});

test("adversarial review passes focus text into the prompt", () => {
  const repo = makeReviewRepo();
  const binDir = makeTempDir();
  installFakeCursorAgent(binDir);

  const result = run("node", [SCRIPT, "adversarial-review", "focus on the auth flow"], {
    cwd: repo,
    env: withTestBinaryOverride(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /# Cursor Adversarial Review/);
  assert.match(result.stdout, /Missing empty-state guard/);

  const args = readFakeState(binDir).lastArgs;
  assert.equal(args.includes("--force"), false);
  assert.match(args[args.indexOf("-p") + 1], /focus on the auth flow/);

  const { job } = readLatestJob(repo);
  assert.equal(job.kind, "adversarial-review");
});

test("task --background enqueues a detached worker and result returns its output", async () => {
  const repo = makeTaskRepo();
  const binDir = makeTempDir();
  installFakeCursorAgent(binDir);

  const launched = run("node", [SCRIPT, "task", "--background", "--json", "investigate in the background"], {
    cwd: repo,
    env: buildCursorEnv(binDir)
  });

  assert.equal(launched.status, 0, launched.stderr);
  const launchPayload = JSON.parse(launched.stdout);
  assert.equal(launchPayload.status, "queued");
  assert.match(launchPayload.jobId, /^task-/);

  const waitedStatus = run(
    "node",
    [SCRIPT, "status", launchPayload.jobId, "--wait", "--timeout-ms", "60000", "--json"],
    {
      cwd: repo,
      env: buildCursorEnv(binDir)
    }
  );

  assert.equal(waitedStatus.status, 0, waitedStatus.stderr);
  const waitedPayload = JSON.parse(waitedStatus.stdout);
  assert.equal(waitedPayload.job.id, launchPayload.jobId);
  // The job payload rides in the failure message so a load-starved flake
  // self-documents instead of printing only 'failed' !== 'completed'.
  assert.equal(waitedPayload.job.status, "completed", JSON.stringify(waitedPayload.job));

  const result = run("node", [SCRIPT, "result", launchPayload.jobId, "--json"], {
    cwd: repo,
    env: buildCursorEnv(binDir)
  });
  assert.equal(result.status, 0, result.stderr);
  const resultPayload = JSON.parse(result.stdout);
  assert.equal(resultPayload.job.status, "completed");
  assert.match(resultPayload.storedJob.rendered, /Handled the requested task/);
  assert.equal(resultPayload.storedJob.result.transport, "native");
});

test("cancel refuses to kill a pid it cannot prove ownership of", async (t) => {
  const repo = makeTaskRepo();
  const binDir = makeTempDir();
  installFakeCursorAgent(binDir, "slow");

  // A live process the plugin does NOT own, standing in for a reused PID.
  const bystander = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], {
    stdio: "ignore"
  });
  t.after(() => {
    try {
      bystander.kill();
    } catch {
      // Already gone.
    }
  });

  // A legacy job record whose ownership capture failed: raw pid, no identity.
  upsertJob(repo, { id: "task-stale", status: "running", jobClass: "task", pid: bystander.pid });
  writeJobFile(repo, "task-stale", {
    id: "task-stale",
    status: "running",
    pid: bystander.pid,
    ownershipCaptureFailed: true,
    request: { cwd: repo, prompt: "stale" }
  });

  const cancelResult = run("node", [SCRIPT, "cancel", "task-stale", "--json"], {
    cwd: repo,
    env: buildCursorEnv(binDir)
  });

  // The cancel must fail closed: non-zero exit, ownership message, and the
  // bystander process must still be alive.
  assert.notEqual(cancelResult.status, 0);
  assert.match(`${cancelResult.stderr}\n${cancelResult.stdout}`, /could not be verified as owned|Unable to verify cleanup/);
  assert.doesNotThrow(() => process.kill(bystander.pid, 0));

  const state = JSON.parse(fs.readFileSync(path.join(resolveStateDir(repo), "state.json"), "utf8"));
  const staleJob = state.jobs.find((job) => job.id === "task-stale");
  assert.notEqual(staleJob.status, "cancelled");
  assert.equal(staleJob.phase, "cleanup-pending");
});

test("cancel stops an in-process review and survives a clobbered job file", async (t) => {
  const repo = makeReviewRepo();
  const binDir = makeTempDir();
  installFakeCursorAgent(binDir, "slow");

  // Claude backgrounds foreground commands with a detached shell; emulate
  // that shape: the review runs in-process in this child via
  // runForegroundCommand/runTrackedJob, never through a task-worker.
  const child = spawn("node", [SCRIPT, "review", "--wait"], {
    cwd: repo,
    env: withTestBinaryOverride(binDir),
    stdio: "ignore"
  });
  t.after(() => {
    try {
      child.kill();
    } catch {
      // Already gone.
    }
  });

  const stateDir = resolveStateDir(repo);
  // Gate on the precondition this test actually needs — ownership persisted —
  // not on threadId. runTrackedJob captures ownership and writes the running
  // record BEFORE executeReviewRun does its git context collection and spawns
  // cursor-agent, so waiting for threadId would couple this test to that
  // whole slow chain (a real flake source on loaded Windows CI). The
  // ownership snapshot is taken before any git child is spawned, so
  // cancelling this early cannot trip taskkill /T over transient descendants.
  const runningJob = await waitFor(() => {
    try {
      const state = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
      const job = state.jobs.find((candidate) => candidate.jobClass === "review");
      return job?.status === "running" && Number.isFinite(job.pid) && job.processIdentity
        ? job
        : null;
    } catch {
      return null;
    }
  }, { timeoutMs: 60000 });

  // In-process runs must persist the runner's ownership into BOTH stores.
  assert.match(runningJob.processIdentity, /@/);
  const jobFile = path.join(stateDir, "jobs", `${runningJob.id}.json`);
  const storedRunning = JSON.parse(fs.readFileSync(jobFile, "utf8"));
  assert.match(storedRunning.processIdentity ?? "", /@/, JSON.stringify(storedRunning));

  // Simulate the progress-updater race clobbering the job file: ownership
  // fields vanish from the file while the lock-serialized index keeps them.
  // Cancel must fall back to the index instead of fail-closing.
  const {
    processIdentity: _clobberedIdentity,
    ownershipSnapshot: _clobberedSnapshot,
    ownershipCaptureFailed: _clobberedCaptureFailed,
    ...clobbered
  } = storedRunning;
  fs.writeFileSync(jobFile, `${JSON.stringify(clobbered, null, 2)}\n`);

  const cancelResult = run("node", [SCRIPT, "cancel", runningJob.id, "--json"], {
    cwd: repo,
    env: withTestBinaryOverride(binDir)
  });
  assert.equal(cancelResult.status, 0, cancelResult.stderr);
  assert.equal(JSON.parse(cancelResult.stdout).status, "cancelled");

  await waitFor(() => {
    try {
      process.kill(runningJob.pid, 0);
      return false;
    } catch (error) {
      return error?.code === "ESRCH";
    }
  });

  const state = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
  const cancelled = state.jobs.find((job) => job.id === runningJob.id);
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.pid, null);
});

test("cancel stops a slow background task and marks it cancelled", async () => {
  const repo = makeTaskRepo();
  const binDir = makeTempDir();
  installFakeCursorAgent(binDir, "slow");

  const launched = run("node", [SCRIPT, "task", "--background", "--json", "investigate the slow path"], {
    cwd: repo,
    env: buildCursorEnv(binDir)
  });

  assert.equal(launched.status, 0, launched.stderr);
  const launchPayload = JSON.parse(launched.stdout);
  const jobId = launchPayload.jobId;
  assert.ok(jobId);

  // Wait for the threadId patched in by the stream's init event: it proves the
  // slow cursor-agent process is up and the worker's transient startup probes
  // (git, cursor-agent --version) have finished. Cancelling earlier makes
  // Windows taskkill /T trip over those already-exiting snapshot entries.
  const stateDir = resolveStateDir(repo);
  const runningJob = await waitFor(() => {
    const state = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
    const job = state.jobs.find((candidate) => candidate.id === jobId);
    return job?.status === "running" && Number.isFinite(job.pid) && job.threadId ? job : null;
  }, { timeoutMs: 60000 });
  assert.equal(runningJob.threadId, "sess-fake-1");

  const cancelResult = run("node", [SCRIPT, "cancel", jobId, "--json"], {
    cwd: repo,
    env: buildCursorEnv(binDir)
  });

  assert.equal(cancelResult.status, 0, cancelResult.stderr);
  assert.equal(JSON.parse(cancelResult.stdout).status, "cancelled");

  await waitFor(() => {
    try {
      process.kill(runningJob.pid, 0);
      return false;
    } catch (error) {
      return error?.code === "ESRCH";
    }
  });

  const state = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
  const cancelled = state.jobs.find((job) => job.id === jobId);
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.pid, null);

  const storedJob = JSON.parse(fs.readFileSync(path.join(stateDir, "jobs", `${jobId}.json`), "utf8"));
  assert.equal(storedJob.status, "cancelled");
  assert.match(fs.readFileSync(storedJob.logFile, "utf8"), /Cancelled by user/);
});
