// Runtime task behavior tests: background enqueueing, task run routing,
// resume/rescue threads, telemetry, and subagent/turn completion handling.
// Split from the former monolithic tests/runtime.test.mjs (unchanged test
// bodies) so node's per-file test parallelism spreads the suite across three
// files with similar wall time. Shared fixtures live in runtime-helpers.mjs.
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";

import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { initGitRepo, run } from "./helpers.mjs";
import { enqueueBackgroundTask, handleTaskWorker } from "../plugins/codex/scripts/codex-companion.mjs";
import { loadBrokerChildren } from "../plugins/codex/scripts/lib/broker-ownership.mjs";
import { loadBrokerSession } from "../plugins/codex/scripts/lib/broker-lifecycle.mjs";
import { readStoredJob } from "../plugins/codex/scripts/lib/job-control.mjs";
import { listJobs, resolveStateDir, upsertJob, writeJobFile } from "../plugins/codex/scripts/lib/state.mjs";
import { runTrackedJob } from "../plugins/codex/scripts/lib/tracked-jobs.mjs";
import { SCRIPT, SESSION_HOOK, makeTempDir, withBrokerOwner, waitFor, cleanupRuntimeBrokerSessions } from "./runtime-helpers.mjs";

test.after(async () => {
  assert.deepEqual(await cleanupRuntimeBrokerSessions(), []);
});

test("background task is persisted before its worker can start", () => {
  const workspace = makeTempDir();
  const job = {
    id: "task-persist-before-spawn",
    workspaceRoot: workspace,
    kind: "task",
    title: "Codex Task",
    jobClass: "task",
    summary: "Exercise the startup race",
    createdAt: "2026-07-28T08:00:00.000Z"
  };
  const request = {
    cwd: workspace,
    prompt: "Exercise the startup race",
    jobId: job.id
  };
  const workerProgress = {
    status: "running",
    phase: "investigating",
    pid: 43210,
    progressMarker: "worker-read-succeeded"
  };
  let observedQueuedRecord = null;

  enqueueBackgroundTask(workspace, job, request, {
    spawnDetachedTaskWorkerImpl() {
      observedQueuedRecord = readStoredJob(workspace, job.id);
      writeJobFile(workspace, job.id, {
        ...observedQueuedRecord,
        ...workerProgress
      });
      upsertJob(workspace, {
        id: job.id,
        ...workerProgress
      });
    }
  });

  assert.equal(observedQueuedRecord.status, "queued");
  assert.equal(observedQueuedRecord.phase, "queued");
  assert.equal(observedQueuedRecord.pid, null);
  assert.deepEqual(observedQueuedRecord.request, request);
  assert.equal(Object.hasOwn(observedQueuedRecord, "processIdentity"), false);
  assert.equal(Object.hasOwn(observedQueuedRecord, "ownershipSnapshot"), false);
  assert.equal(Object.hasOwn(observedQueuedRecord, "ownershipCaptureFailed"), false);

  const storedJob = readStoredJob(workspace, job.id);
  assert.equal(storedJob.status, workerProgress.status);
  assert.equal(storedJob.phase, workerProgress.phase);
  assert.equal(storedJob.pid, workerProgress.pid);
  assert.equal(storedJob.progressMarker, workerProgress.progressMarker);

  const indexedJob = listJobs(workspace).find((candidate) => candidate.id === job.id);
  assert.equal(indexedJob.status, workerProgress.status);
  assert.equal(indexedJob.phase, workerProgress.phase);
  assert.equal(indexedJob.pid, workerProgress.pid);
  assert.equal(indexedJob.progressMarker, workerProgress.progressMarker);
});

test("background task marks the queued record failed when worker spawn throws", () => {
  const workspace = makeTempDir();
  const job = {
    id: "task-sync-spawn-failure",
    workspaceRoot: workspace,
    kind: "task",
    title: "Codex Task",
    jobClass: "task",
    summary: "Exercise synchronous spawn failure",
    createdAt: "2026-07-30T03:00:00.000Z"
  };
  const request = {
    cwd: workspace,
    prompt: "Exercise synchronous spawn failure",
    jobId: job.id
  };
  const spawnError = Object.assign(new Error("spawn EAGAIN"), { code: "EAGAIN" });

  assert.throws(
    () =>
      enqueueBackgroundTask(workspace, job, request, {
        spawnDetachedTaskWorkerImpl() {
          throw spawnError;
        }
      }),
    spawnError
  );

  const storedJob = readStoredJob(workspace, job.id);
  assert.equal(storedJob.status, "failed");
  assert.equal(storedJob.phase, "failed");
  assert.equal(storedJob.pid, null);
  assert.equal(storedJob.errorMessage, "spawn EAGAIN");
  assert.ok(storedJob.completedAt);

  const indexedJob = listJobs(workspace).find((candidate) => candidate.id === job.id);
  assert.equal(indexedJob.status, "failed");
  assert.equal(indexedJob.phase, "failed");
  assert.equal(indexedJob.pid, null);
  assert.equal(indexedJob.errorMessage, "spawn EAGAIN");
});

test("background task marks the queued record failed when worker emits a spawn error", () => {
  const workspace = makeTempDir();
  const job = {
    id: "task-async-spawn-failure",
    workspaceRoot: workspace,
    kind: "task",
    title: "Codex Task",
    jobClass: "task",
    summary: "Exercise asynchronous spawn failure",
    createdAt: "2026-07-30T03:01:00.000Z"
  };
  const request = {
    cwd: workspace,
    prompt: "Exercise asynchronous spawn failure",
    jobId: job.id
  };
  let spawnErrorHandler = null;
  const worker = {
    once(event, handler) {
      if (event === "error") {
        spawnErrorHandler = handler;
      }
      return this;
    }
  };

  enqueueBackgroundTask(workspace, job, request, {
    spawnDetachedTaskWorkerImpl() {
      return worker;
    }
  });
  assert.equal(typeof spawnErrorHandler, "function");
  spawnErrorHandler(Object.assign(new Error("spawn EMFILE"), { code: "EMFILE" }));

  const storedJob = readStoredJob(workspace, job.id);
  assert.equal(storedJob.status, "failed");
  assert.equal(storedJob.phase, "failed");
  assert.equal(storedJob.pid, null);
  assert.equal(storedJob.errorMessage, "spawn EMFILE");
  assert.ok(storedJob.completedAt);

  const indexedJob = listJobs(workspace).find((candidate) => candidate.id === job.id);
  assert.equal(indexedJob.status, "failed");
  assert.equal(indexedJob.phase, "failed");
  assert.equal(indexedJob.pid, null);
  assert.equal(indexedJob.errorMessage, "spawn EMFILE");
});

test("background task stays runnable when worker identity capture fails", async () => {
  const workspace = makeTempDir();
  const job = {
    id: "task-capture-failure",
    workspaceRoot: workspace,
    kind: "task",
    title: "Codex Task",
    jobClass: "task",
    summary: "Exercise ownership capture failure",
    createdAt: "2026-07-28T08:01:00.000Z"
  };
  const request = {
    cwd: workspace,
    prompt: "Exercise ownership capture failure",
    jobId: job.id
  };
  let workerJob = null;
  let workPerformed = false;

  enqueueBackgroundTask(workspace, job, request, {
    spawnDetachedTaskWorkerImpl() {}
  });
  await handleTaskWorker(["--cwd", workspace, "--job-id", job.id], {
    getProcessIdentityImpl() {
      throw new Error("injected ownership capture failure");
    },
    runTrackedJobImpl(candidate, _runner, options) {
      workerJob = candidate;
      return runTrackedJob(
        candidate,
        async () => {
          workPerformed = true;
          return {
            exitStatus: 0,
            payload: { ok: true },
            rendered: "Worker completed.",
            summary: "Worker completed."
          };
        },
        options
      );
    }
  });

  assert.equal(workPerformed, true);
  assert.equal(workerJob.ownershipCaptureFailed, true);
  assert.equal(Object.hasOwn(workerJob, "processIdentity"), false);
  assert.equal(Object.hasOwn(workerJob, "ownershipSnapshot"), false);

  const storedJob = readStoredJob(workspace, job.id);
  assert.equal(storedJob.status, "completed");
  assert.equal(storedJob.ownershipCaptureFailed, true);
  assert.equal(Object.hasOwn(storedJob, "processIdentity"), false);
  assert.equal(Object.hasOwn(storedJob, "ownershipSnapshot"), false);
});

test("task --resume-last resumes the latest persisted task thread", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const firstRun = run("node", [SCRIPT, "task", "initial task"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(firstRun.status, 0, firstRun.stderr);

  const result = run("node", [SCRIPT, "task", "--resume-last", "follow up"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "Resumed the prior run.\nFollow-up prompt accepted.\n\nCodex session ID: thr_1\nResume in Codex: codex resume thr_1\n");
});

test("task-resume-candidate returns the latest rescue thread from the current session", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: "task-current",
            status: "completed",
            title: "Codex Task",
            jobClass: "task",
            sessionId: "sess-current",
            threadId: "thr_current",
            summary: "Investigate the flaky test",
            updatedAt: "2026-03-24T20:00:00.000Z"
          },
          {
            id: "task-other-session",
            status: "completed",
            title: "Codex Task",
            jobClass: "task",
            sessionId: "sess-other",
            threadId: "thr_other",
            summary: "Old rescue run",
            updatedAt: "2026-03-24T20:05:00.000Z"
          },
          {
            id: "review-current",
            status: "completed",
            title: "Codex Review",
            jobClass: "review",
            sessionId: "sess-current",
            threadId: "thr_review",
            summary: "Review main...HEAD",
            updatedAt: "2026-03-24T20:10:00.000Z"
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const result = run("node", [SCRIPT, "task-resume-candidate", "--json"], {
    cwd: workspace,
    env: {
      ...process.env,
      CODEX_COMPANION_SESSION_ID: "sess-current"
    }
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.available, true);
  assert.equal(payload.sessionId, "sess-current");
  assert.equal(payload.candidate.id, "task-current");
  assert.equal(payload.candidate.threadId, "thr_current");
});

test("task --resume-last does not resume a task from another Claude session", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const statePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const otherEnv = {
    ...buildEnv(binDir),
    CODEX_COMPANION_SESSION_ID: "sess-other"
  };
  const currentEnv = {
    ...buildEnv(binDir),
    CODEX_COMPANION_SESSION_ID: "sess-current"
  };

  const firstRun = run("node", [SCRIPT, "task", "initial task"], {
    cwd: repo,
    env: otherEnv
  });
  assert.equal(firstRun.status, 0, firstRun.stderr);

  const candidate = run("node", [SCRIPT, "task-resume-candidate", "--json"], {
    cwd: repo,
    env: currentEnv
  });
  assert.equal(candidate.status, 0, candidate.stderr);
  assert.equal(JSON.parse(candidate.stdout).available, false);

  const resume = run("node", [SCRIPT, "task", "--resume-last", "follow up"], {
    cwd: repo,
    env: currentEnv
  });
  assert.equal(resume.status, 1);
  assert.match(resume.stderr, /No previous Codex task thread was found for this repository\./);

  const fakeState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(fakeState.lastTurnStart.threadId, "thr_1");
  assert.equal(fakeState.lastTurnStart.prompt, "initial task");
});

test("task --resume-last ignores running tasks from other Claude sessions", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const stateDir = resolveStateDir(repo);
  fs.mkdirSync(path.join(stateDir, "jobs"), { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: "task-other-running",
            status: "running",
            title: "Codex Task",
            jobClass: "task",
            sessionId: "sess-other",
            threadId: "thr_other",
            summary: "Other session active task",
            updatedAt: "2026-03-24T20:05:00.000Z"
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const env = {
    ...buildEnv(binDir),
    CODEX_COMPANION_SESSION_ID: "sess-current"
  };
  const status = run("node", [SCRIPT, "status", "--json"], {
    cwd: repo,
    env
  });
  assert.equal(status.status, 0, status.stderr);
  assert.deepEqual(JSON.parse(status.stdout).running, []);

  const resume = run("node", [SCRIPT, "task", "--resume-last", "follow up"], {
    cwd: repo,
    env
  });
  assert.equal(resume.status, 1);
  assert.match(resume.stderr, /No previous Codex task thread was found for this repository\./);
});

test("session start hook exports session context and a stable owner when available", () => {
  const repo = makeTempDir();
  const envFile = path.join(makeTempDir(), "claude-env.sh");
  fs.writeFileSync(envFile, "", "utf8");
  const pluginDataDir = makeTempDir();
  const transcriptPath = path.join(repo, "session.jsonl");

  const result = run("node", [SESSION_HOOK, "SessionStart"], {
    cwd: repo,
    env: {
      ...process.env,
      CLAUDE_ENV_FILE: envFile,
      CLAUDE_PLUGIN_DATA: pluginDataDir
    },
    input: JSON.stringify({
      hook_event_name: "SessionStart",
      session_id: "sess-current",
      transcript_path: transcriptPath,
      cwd: repo
    })
  });

  assert.equal(result.status, 0, result.stderr);
  const exported = fs.readFileSync(envFile, "utf8");
  assert.match(exported, /export CODEX_COMPANION_SESSION_ID='sess-current'/);
  assert.match(exported, new RegExp(`export CODEX_COMPANION_TRANSCRIPT_PATH='${transcriptPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}'`));
  assert.match(exported, new RegExp(`export CLAUDE_PLUGIN_DATA='${pluginDataDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}'`));
  if (process.platform !== "win32") {
    assert.match(exported, /export CODEX_COMPANION_SESSION_OWNER_PID='\d+'/);
    assert.match(exported, /export CODEX_COMPANION_SESSION_OWNER_IDENTITY='\d+@[^']+'/);
  }
});

test("write task output focuses on the Codex result without generic follow-up hints", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run("node", [SCRIPT, "task", "--write", "fix the failing test"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "Handled the requested task.\nTask prompt accepted.\n\nCodex session ID: thr_1\nResume in Codex: codex resume thr_1\n");
});

test("task --resume acts like --resume-last without leaking the flag into the prompt", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const statePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const firstRun = run("node", [SCRIPT, "task", "initial task"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(firstRun.status, 0, firstRun.stderr);

  const result = run("node", [SCRIPT, "task", "--resume", "follow up"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const fakeState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(fakeState.lastTurnStart.threadId, "thr_1");
  assert.equal(fakeState.lastTurnStart.prompt, "follow up");
});

test("task --fresh is treated as routing control and does not leak into the prompt", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const statePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run("node", [SCRIPT, "task", "--fresh", "diagnose the flaky test"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const fakeState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(fakeState.lastTurnStart.prompt, "diagnose the flaky test");
});

test("task forwards model selection and reasoning effort to app-server turn/start", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const statePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run("node", [SCRIPT, "task", "--model", "spark", "--effort", "low", "diagnose the failing test"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const fakeState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(fakeState.lastTurnStart.model, "gpt-5.3-codex-spark");
  assert.equal(fakeState.lastTurnStart.effort, "low");
});

test("task --profile deep resolves to gpt-5.6-sol at xhigh effort", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const statePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run("node", [SCRIPT, "task", "--profile", "deep", "diagnose the failing test"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const fakeState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(fakeState.lastTurnStart.model, "gpt-5.6-sol");
  assert.equal(fakeState.lastTurnStart.effort, "xhigh");
});

test("task --profile fast resolves to gpt-5.3-codex-spark and leaves effort unset", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const statePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run("node", [SCRIPT, "task", "--profile", "fast", "diagnose the failing test"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const fakeState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(fakeState.lastTurnStart.model, "gpt-5.3-codex-spark");
  assert.equal(fakeState.lastTurnStart.effort, null);
});

test("task explicit --model and --effort override the profile defaults", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const statePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run(
    "node",
    [SCRIPT, "task", "--profile", "deep", "--model", "gpt-5.4-mini", "--effort", "low", "diagnose the failing test"],
    {
      cwd: repo,
      env: buildEnv(binDir)
    }
  );

  assert.equal(result.status, 0, result.stderr);
  const fakeState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(fakeState.lastTurnStart.model, "gpt-5.4-mini");
  assert.equal(fakeState.lastTurnStart.effort, "low");
});

test("task --profile deep --model spark still expands the spark alias", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const statePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run("node", [SCRIPT, "task", "--profile", "deep", "--model", "spark", "diagnose the failing test"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const fakeState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(fakeState.lastTurnStart.model, "gpt-5.3-codex-spark");
  assert.equal(fakeState.lastTurnStart.effort, "xhigh");
});

test("task rejects an unknown profile before invoking Codex", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const statePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run("node", [SCRIPT, "task", "--profile", "medium", "diagnose the failing test"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Unsupported task profile "medium"\. Use one of: deep, fast\./);
  // No app-server child was ever spawned: the fake codex fixture only writes
  // its state file once the process boots.
  assert.equal(fs.existsSync(statePath), false);
});

test("task rejects an invalid explicit effort even when a profile supplies a valid effort", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const statePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run(
    "node",
    [SCRIPT, "task", "--profile", "deep", "--effort", "nonsense", "diagnose the failing test"],
    {
      cwd: repo,
      env: buildEnv(binDir)
    }
  );

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Unsupported reasoning effort "nonsense"/);
  assert.equal(fs.existsSync(statePath), false);
});

test("task logs reasoning summaries and assistant messages to the job log", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "with-reasoning");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run("node", [SCRIPT, "task", "investigate the failing test"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const stateDir = resolveStateDir(repo);
  const state = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
  const log = fs.readFileSync(state.jobs[0].logFile, "utf8");
  assert.match(log, /Reasoning summary/);
  assert.match(log, /Inspected the prompt, gathered evidence, and checked the highest-risk paths first/);
  assert.match(log, /Assistant message/);
  assert.match(log, /Handled the requested task/);
});

test("task logs subagent reasoning and messages with a subagent prefix", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "with-subagent");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run("node", [SCRIPT, "task", "challenge the current design"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const stateDir = resolveStateDir(repo);
  const state = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
  const log = fs.readFileSync(state.jobs[0].logFile, "utf8");
  assert.match(log, /Starting subagent design-challenger via collaboration tool: wait\./);
  assert.match(log, /Subagent design-challenger reasoning:/);
  assert.match(log, /Questioned the retry strategy and the cache invalidation boundaries\./);
  assert.match(log, /Subagent design-challenger:/);
  assert.match(
    log,
    /The design assumes retries are harmless, but they can duplicate side effects without stronger idempotency guarantees\./
  );
});

test("task waits for the main thread to complete before returning the final result", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "with-subagent");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run("node", [SCRIPT, "task", "challenge the current design"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "Handled the requested task.\nTask prompt accepted.\n\nCodex session ID: thr_1\nResume in Codex: codex resume thr_1\n");
});

test("task ignores later subagent messages when choosing the final returned output", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "with-late-subagent-message");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run("node", [SCRIPT, "task", "challenge the current design"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "Handled the requested task.\nTask prompt accepted.\n\nCodex session ID: thr_1\nResume in Codex: codex resume thr_1\n");
});

test("task can finish after subagent work even if the parent turn/completed event is missing", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "with-subagent-no-main-turn-completed");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run("node", [SCRIPT, "task", "challenge the current design"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "Handled the requested task.\nTask prompt accepted.\n\nCodex session ID: thr_1\nResume in Codex: codex resume thr_1\n");
});

test("task using the shared broker still completes when Codex spawns subagents", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "with-subagent");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");

  const env = withBrokerOwner(buildEnv(binDir), "subagent-task");
  const review = run("node", [SCRIPT, "review"], {
    cwd: repo,
    env
  });
  assert.equal(review.status, 0, review.stderr);

  if (!loadBrokerSession(repo)) {
    return;
  }

  const result = run("node", [SCRIPT, "task", "challenge the current design"], {
    cwd: repo,
    env
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "Handled the requested task.\nTask prompt accepted.\n\nCodex session ID: thr_2\nResume in Codex: codex resume thr_2\n");
});

test("inferred shared turn completion releases broker stream state and its idle child", async (t) => {
  if (process.platform === "win32") {
    return;
  }
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "with-subagent-no-main-turn-completed");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  const env = withBrokerOwner({
    ...buildEnv(binDir),
    CODEX_COMPANION_BROKER_CHILD_IDLE_MS: "100"
  }, "inferred-completion");

  const result = run("node", [SCRIPT, "task", "challenge the current design"], {
    cwd: repo,
    env
  });
  assert.equal(result.status, 0, result.stderr);
  const brokerSession = loadBrokerSession(repo);
  assert.equal(brokerSession?.registry?.registered, true);
  t.after(() => {
    run("node", [SESSION_HOOK, "SessionEnd"], {
      cwd: repo,
      env,
      input: JSON.stringify({ hook_event_name: "SessionEnd", cwd: repo })
    });
  });

  await waitFor(() => {
    const children = loadBrokerChildren(brokerSession.registry);
    return children.valid === true && children.children.length === 0 && children.releasedChildren.length === 1;
  }, { timeoutMs: 2500, intervalMs: 25 });
});

test("task --background enqueues a detached worker and exposes per-job status", async () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "slow-task");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const launched = run(
    "node",
    [SCRIPT, "task", "--background", "--profile", "deep", "--json", "investigate the failing test"],
    {
      cwd: repo,
      env: buildEnv(binDir)
    }
  );

  assert.equal(launched.status, 0, launched.stderr);
  const launchPayload = JSON.parse(launched.stdout);
  assert.equal(launchPayload.status, "queued");
  assert.match(launchPayload.jobId, /^task-/);

  const waitedStatus = run(
    "node",
    [SCRIPT, "status", launchPayload.jobId, "--wait", "--timeout-ms", "45000", "--json"],
    {
      cwd: repo,
      env: buildEnv(binDir)
    }
  );

  assert.equal(waitedStatus.status, 0, waitedStatus.stderr);
  const waitedPayload = JSON.parse(waitedStatus.stdout);
  assert.equal(waitedPayload.job.id, launchPayload.jobId);
  // The job payload rides in the failure message so a load-starved flake
  // self-documents instead of printing only 'queued' !== 'completed'.
  assert.equal(waitedPayload.job.status, "completed", JSON.stringify(waitedPayload.job));

  const resultPayload = await waitFor(() => {
    const result = run("node", [SCRIPT, "result", launchPayload.jobId, "--json"], {
      cwd: repo,
      env: buildEnv(binDir)
    });
    if (result.status !== 0) {
      return null;
    }
    return JSON.parse(result.stdout);
  });

  assert.equal(resultPayload.job.id, launchPayload.jobId);
  assert.equal(resultPayload.job.status, "completed");
  assert.match(resultPayload.storedJob.rendered, /Handled the requested task/);
  // The resolved profile defaults (not raw "deep") must survive the
  // background enqueue -> worker -> stored result round trip.
  assert.equal(resultPayload.storedJob.result.model, "gpt-5.6-sol");
  assert.equal(resultPayload.storedJob.result.effort, "xhigh");
});

test("cancel refuses to kill a pid it cannot prove ownership of", async (t) => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);

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
    env: buildEnv(binDir)
  });

  // The cancel must fail closed: non-zero exit, ownership message, and the
  // bystander process must still be alive.
  assert.notEqual(cancelResult.status, 0);
  assert.match(`${cancelResult.stderr}\n${cancelResult.stdout}`, /could not be verified as owned|Unable to verify cleanup/);
  assert.doesNotThrow(() => process.kill(bystander.pid, 0));

  const staleJob = listJobs(repo).find((job) => job.id === "task-stale");
  assert.notEqual(staleJob.status, "cancelled");
  assert.equal(staleJob.phase, "cleanup-pending");
});
