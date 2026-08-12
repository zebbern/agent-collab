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
import { handleCancel, persistWslAgentIdentity } from "../plugins/cursor/scripts/cursor-companion.mjs";
import { readStoredJob, resolveCancelableJob, resolveResultJob } from "../plugins/cursor/scripts/lib/job-control.mjs";
import { listJobs, readStartupMetrics, resolveStateDir, upsertJob, writeJobFile } from "../plugins/cursor/scripts/lib/state.mjs";
import { createProgressReporter, runTrackedJob } from "../plugins/cursor/scripts/lib/tracked-jobs.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "plugins", "cursor", "scripts", "cursor-companion.mjs");

// Isolate cursor-companion state from any real plugin data dir on this host.
process.env.CURSOR_COMPANION_STATE_ROOT = makeTempDir("cursor-plugin-runtime-state-");

test("status --wait treats unresolved cleanup as active after a terminal write", () => {
  const repo = makeTempDir("cursor-cleanup-wait-");
  const job = {
    id: "task-cursor-cleanup-wait",
    workspaceRoot: repo,
    kind: "task",
    title: "Cursor Task",
    jobClass: "task",
    status: "failed",
    phase: "failed",
    cleanupOutcome: { verified: false },
    cleanupFailure: "owned process cleanup remains unverified",
    createdAt: "2026-08-12T10:00:00.000Z"
  };
  writeJobFile(repo, job.id, job);
  upsertJob(repo, job);

  const result = run("node", [SCRIPT, "status", job.id, "--wait", "--timeout-ms", "25", "--json"], {
    cwd: repo,
    env: process.env
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).waitTimedOut, true);
});

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

test("setup rejects a Cursor version probe terminated by a signal", (t) => {
  if (process.platform === "win32") {
    t.skip("Unix signal termination semantics are required for this contract.");
    return;
  }

  const binDir = makeTempDir();
  installFakeCursorAgent(binDir, "signal-on-version");

  const result = run("node", [SCRIPT, "setup", "--json"], {
    cwd: ROOT,
    env: withTestBinaryOverride(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.cursor.available, false);
  assert.equal(payload.auth.loggedIn, false);
  assert.equal(payload.ready, false);
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

  const fakeState = readFakeState(binDir);
  const args = fakeState.lastArgs;
  assert.deepEqual(args.slice(0, 3), ["-p", "--output-format", "stream-json"]);
  assert.equal(fakeState.lastPrompt, "check the fake stream");
  assert.equal(args.includes("--force"), false);
  assert.equal(args.includes("--model"), false);
  const workspaceArg = args[args.indexOf("--workspace") + 1];
  assert.equal(fs.realpathSync.native(workspaceArg), fs.realpathSync.native(repo));
});

test("normal Cursor completion with historical WSL ownership is terminal", async () => {
  const repo = makeTaskRepo();
  const job = {
    id: "task-cursor-normal-wsl-completion",
    workspaceRoot: repo,
    kind: "task",
    title: "Cursor Task",
    jobClass: "task",
    status: "queued",
    phase: "queued",
    pid: null,
    wslAgentPid: 47001,
    wslAgentStartTime: "987654320",
    transport: "wsl",
    createdAt: "2026-07-28T08:00:00.000Z"
  };
  writeJobFile(repo, job.id, job);
  upsertJob(repo, job);

  await runTrackedJob(job, async () => ({
    exitStatus: 0,
    threadId: "sess-wsl-complete",
    payload: { ok: true },
    rendered: "done",
    summary: "done"
  }));

  const indexed = listJobs(repo).find((candidate) => candidate.id === job.id);
  const stored = readStoredJob(repo, job.id);
  for (const record of [indexed, stored]) {
    assert.equal(record.status, "completed");
    assert.equal(record.phase, "done");
    assert.equal(record.wslAgentPid, job.wslAgentPid);
  }
  assert.equal(resolveResultJob(repo, job.id).job.id, job.id);
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

test("task prompt travels over stdin, never argv (wsl.exe command-line limit)", () => {
  const repo = makeTaskRepo();
  const binDir = makeTempDir();
  installFakeCursorAgent(binDir);

  // Far beyond the ~32K chars a Windows command line can carry: if the prompt
  // ever rides argv again — directly or through the WSL wrapper — a real run
  // dies with ENAMETOOLONG (observed live, 2026-08-07). The fixture reads the
  // prompt from stdin only, so an argv regression also fails the content pin.
  const marker = "ENAMETOOLONG-guard";
  const prompt = `${marker}-head ${"x".repeat(64 * 1024)} ${marker}-tail`;
  const promptFile = path.join(makeTempDir(), "prompt.txt");
  fs.writeFileSync(promptFile, prompt);

  const result = run("node", [SCRIPT, "task", "--prompt-file", promptFile], {
    cwd: repo,
    env: buildCursorEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const fakeState = readFakeState(binDir);
  assert.equal(fakeState.lastPrompt, prompt);
  assert.equal(fakeState.lastArgs.some((arg) => arg.includes(marker)), false);
});

test("cursor progress lines carry the [cursor] prefix, not the codex one", () => {
  const written = [];
  const original = process.stderr.write;
  process.stderr.write = (chunk) => {
    written.push(String(chunk));
    return true;
  };
  try {
    createProgressReporter({ stderr: true })("probe line");
  } finally {
    process.stderr.write = original;
  }
  assert.deepEqual(written, ["[cursor] probe line\n"]);
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

test("task --profile resolves each named profile to its Cursor model", () => {
  const repo = makeTaskRepo();
  const binDir = makeTempDir();
  installFakeCursorAgent(binDir);

  const expectedModels = {
    deep: "gpt-5.6-sol-xhigh",
    fast: "cursor-grok-4.5-high-fast"
  };

  for (const [profile, expectedModel] of Object.entries(expectedModels)) {
    const result = run("node", [SCRIPT, "task", "--profile", profile, `check the ${profile} profile`], {
      cwd: repo,
      env: buildCursorEnv(binDir)
    });

    assert.equal(result.status, 0, result.stderr);
    const args = readFakeState(binDir).lastArgs;
    const modelIndex = args.indexOf("--model");
    assert.notEqual(modelIndex, -1, JSON.stringify(args));
    assert.equal(args[modelIndex + 1], expectedModel);
    // Cursor has no effort concept: a profile carries a model only.
    assert.equal(args.includes("--effort"), false);
  }
});

test("task --model overrides the selected profile's model", () => {
  const repo = makeTaskRepo();
  const binDir = makeTempDir();
  installFakeCursorAgent(binDir);

  const result = run(
    "node",
    [SCRIPT, "task", "--profile", "deep", "--model", "composer-1-test", "check the override"],
    {
      cwd: repo,
      env: buildCursorEnv(binDir)
    }
  );

  assert.equal(result.status, 0, result.stderr);
  const args = readFakeState(binDir).lastArgs;
  const modelIndex = args.indexOf("--model");
  assert.notEqual(modelIndex, -1);
  assert.equal(args[modelIndex + 1], "composer-1-test");

  const { storedJob } = readLatestJob(repo);
  assert.equal(storedJob.result.model, "composer-1-test");
});

test("task rejects an unknown profile before invoking cursor-agent", () => {
  const repo = makeTaskRepo();
  const binDir = makeTempDir();
  installFakeCursorAgent(binDir);

  const result = run("node", [SCRIPT, "task", "--profile", "bogus", "do something"], {
    cwd: repo,
    env: buildCursorEnv(binDir)
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Unsupported task profile "bogus"\. Use one of: deep, fast\./);

  // The fake cursor-agent only records state once invoked with -p; a rejected
  // profile must never reach that point.
  assert.equal(fs.existsSync(path.join(binDir, "fake-cursor-state.json")), false);
});

test("task rejects an explicitly empty --profile before invoking cursor-agent", () => {
  const repo = makeTaskRepo();
  const binDir = makeTempDir();
  installFakeCursorAgent(binDir);

  const result = run("node", [SCRIPT, "task", "--profile=", "do something"], {
    cwd: repo,
    env: buildCursorEnv(binDir)
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Unsupported task profile ""\. Use one of: deep, fast\./);
  assert.equal(fs.existsSync(path.join(binDir, "fake-cursor-state.json")), false);
});

test("review rejects --profile as task/rescue-only", () => {
  const repo = makeReviewRepo();
  const binDir = makeTempDir();
  installFakeCursorAgent(binDir);

  const result = run("node", [SCRIPT, "review", "--profile", "deep"], {
    cwd: repo,
    env: withTestBinaryOverride(binDir)
  });

  assert.notEqual(result.status, 0);
  // Both plugins word this rule identically apart from their own command
  // names — a user switching plugins must not meet two phrasings of one rule.
  assert.match(
    result.stderr,
    /--profile.*not supported by review or adversarial-review.*only.*\/cursor:task.*\/cursor:rescue/is
  );
  assert.equal(fs.existsSync(path.join(binDir, "fake-cursor-state.json")), false);
});

test("adversarial-review rejects --profile as task/rescue-only", () => {
  const repo = makeReviewRepo();
  const binDir = makeTempDir();
  installFakeCursorAgent(binDir);

  const result = run("node", [SCRIPT, "adversarial-review", "--profile", "fast", "focus text"], {
    cwd: repo,
    env: withTestBinaryOverride(binDir)
  });

  assert.notEqual(result.status, 0);
  // Both plugins word this rule identically apart from their own command
  // names — a user switching plugins must not meet two phrasings of one rule.
  assert.match(
    result.stderr,
    /--profile.*not supported by review or adversarial-review.*only.*\/cursor:task.*\/cursor:rescue/is
  );
  assert.equal(fs.existsSync(path.join(binDir, "fake-cursor-state.json")), false);
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

  const fakeState = readFakeState(binDir);
  const args = fakeState.lastArgs;
  const resumeIndex = args.indexOf("--resume");
  assert.notEqual(resumeIndex, -1);
  assert.equal(args[resumeIndex + 1], "sess-prior");
  assert.match(fakeState.lastPrompt, /^Continue from the current chat state\./);

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

// resolveResultJob's terminal-status match used to throw "No job found" for
// any reference outside that predicate, which pre-empted the active-job
// check below it — a RUNNING or QUEUED job id read back as if it did not
// exist at all (observed live 2026-08-07 on the codex plugin; mirrored fix
// applied here by hand). These pin the honest wording.
test("result on a job id that is still running reports it as running, not missing", () => {
  const repo = makeTempDir("cursor-plugin-test-");
  upsertJob(repo, { id: "task-running", status: "running", jobClass: "task", pid: 999999, title: "Cursor Task" });
  writeJobFile(repo, "task-running", { id: "task-running", status: "running" });

  const result = run("node", [SCRIPT, "result", "task-running"], {
    cwd: repo
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /still running/);
  assert.match(result.stderr, /\/cursor:status/);
  assert.doesNotMatch(result.stderr, /No job found/);
});

test("result on a job id that is still queued reports it as queued, not missing", () => {
  const repo = makeTempDir("cursor-plugin-test-");
  upsertJob(repo, { id: "task-queued", status: "queued", jobClass: "task", pid: null, title: "Cursor Task" });
  writeJobFile(repo, "task-queued", { id: "task-queued", status: "queued" });

  const result = run("node", [SCRIPT, "result", "task-queued"], {
    cwd: repo
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /still queued/);
  assert.match(result.stderr, /\/cursor:status/);
  assert.doesNotMatch(result.stderr, /No job found/);
});

test("result on a finished job whose stored result file is missing reports it honestly", () => {
  const repo = makeTempDir("cursor-plugin-test-");
  // Index the job as completed via upsertJob, but never call writeJobFile —
  // the per-job result file is gone (pruned or quarantined) while the index
  // still lists it.
  upsertJob(repo, { id: "task-done", status: "completed", jobClass: "task", title: "Cursor Task" });

  const result = run("node", [SCRIPT, "result", "task-done"], {
    cwd: repo
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /task-done/);
  assert.match(result.stderr, /completed/);
  assert.match(result.stderr, /(pruned|quarantined)/);
  assert.match(result.stderr, /\/cursor:status/);
  assert.doesNotMatch(result.stderr, /No job found/);
});

// Same class as the result path: resolveCancelableJob filtered to active jobs
// before matching, so cancelling an already-finished id reported it as
// unknown. A finished job is not a missing job.
test("cancel on an already-finished job id says it is finished, not missing", () => {
  const repo = makeTempDir("cursor-plugin-test-");
  upsertJob(repo, { id: "task-finished", status: "completed", jobClass: "task", title: "Cursor Task" });

  const cancelled = run("node", [SCRIPT, "cancel", "task-finished"], { cwd: repo });
  assert.notEqual(cancelled.status, 0);
  assert.match(cancelled.stderr, /task-finished is already completed/);
  assert.doesNotMatch(cancelled.stderr, /No job found/);

  const unknown = run("node", [SCRIPT, "cancel", "task-nope"], { cwd: repo });
  assert.notEqual(unknown.status, 0);
  assert.match(unknown.stderr, /No active job found for "task-nope"/);
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

  const fakeState = readFakeState(binDir);
  const args = fakeState.lastArgs;
  assert.equal(args.includes("--force"), false);
  assert.match(fakeState.lastPrompt, /<output_schema>/);

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

  const fakeState = readFakeState(binDir);
  const args = fakeState.lastArgs;
  assert.equal(args.includes("--force"), false);
  assert.match(fakeState.lastPrompt, /focus on the auth flow/);

  const { job } = readLatestJob(repo);
  assert.equal(job.kind, "adversarial-review");
});

test("task --background enqueues a detached worker and result returns its output", async () => {
  const repo = makeTaskRepo();
  const binDir = makeTempDir();
  installFakeCursorAgent(binDir);
  const launchEnv = {
    ...buildCursorEnv(binDir),
    CURSOR_COMPANION_SESSION_ID: "cursor-background-launch"
  };

  const launched = run(
    "node",
    [SCRIPT, "task", "--background", "--profile", "fast", "--json", "investigate in the background"],
    {
      cwd: repo,
      env: launchEnv
    }
  );

  assert.equal(launched.status, 0, launched.stderr);
  const launchPayload = JSON.parse(launched.stdout);
  assert.equal(launchPayload.status, "queued");
  assert.match(launchPayload.jobId, /^task-/);

  const nextSessionEnv = {
    ...launchEnv,
    CURSOR_COMPANION_SESSION_ID: "cursor-background-next"
  };

  const waitedStatus = run(
    "node",
    [SCRIPT, "status", launchPayload.jobId, "--wait", "--timeout-ms", "60000", "--json"],
    {
      cwd: repo,
      env: nextSessionEnv
    }
  );

  assert.equal(waitedStatus.status, 0, waitedStatus.stderr);
  const waitedPayload = JSON.parse(waitedStatus.stdout);
  assert.equal(waitedPayload.job.id, launchPayload.jobId);
  // The job payload rides in the failure message so a load-starved flake
  // self-documents instead of printing only 'failed' !== 'completed'.
  assert.equal(waitedPayload.job.status, "completed", JSON.stringify(waitedPayload.job));

  const status = run("node", [SCRIPT, "status", "--json"], {
    cwd: repo,
    env: nextSessionEnv
  });
  assert.equal(status.status, 0, status.stderr);
  assert.equal(JSON.parse(status.stdout).latestFinished?.id, launchPayload.jobId);

  const result = run("node", [SCRIPT, "result", "--json"], {
    cwd: repo,
    env: nextSessionEnv
  });
  assert.equal(result.status, 0, result.stderr);
  const resultPayload = JSON.parse(result.stdout);
  assert.equal(resultPayload.job.status, "completed");
  assert.match(resultPayload.storedJob.rendered, /Handled the requested task/);
  assert.equal(resultPayload.storedJob.result.transport, "native");

  // The background worker's request payload must carry the profile-resolved
  // model, not just the foreground path.
  const fakeState = readFakeState(binDir);
  const args = fakeState.lastArgs;
  const modelIndex = args.indexOf("--model");
  assert.notEqual(modelIndex, -1, JSON.stringify(args));
  assert.equal(args[modelIndex + 1], "cursor-grok-4.5-high-fast");
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

test("a successful Cursor cleanup retry derives the Windows worker pid from exact identity", async () => {
  const repo = makeTaskRepo();
  const job = {
    id: "task-cursor-cleanup-retry",
    workspaceRoot: repo,
    kind: "task",
    title: "Cursor Task",
    jobClass: "task",
    status: "running",
    phase: "running",
    pid: 46001,
    processIdentity: "46001@win32:123456789",
    ownershipSnapshot: null,
    createdAt: "2026-07-28T08:06:00.000Z"
  };
  writeJobFile(repo, job.id, job);
  upsertJob(repo, job);

  await assert.rejects(
    handleCancel([job.id, "--cwd", repo, "--json"], {
      async terminateProcessTreeImpl() {
        return {
          attempted: true,
          delivered: true,
          verified: false,
          degraded: true,
          survivors: [job.pid],
          survivorIdentities: [job.processIdentity]
        };
      },
      probeWindowsProcessIdentityImpl() {
        return { status: "unavailable", identity: null };
      },
      workerExitWaitMs: 0
    }),
    /ownership records were preserved for retry/
  );

  const pending = readStoredJob(repo, job.id);
  const lateFailure = {
    ...pending,
    status: "failed",
    phase: "failed",
    pid: null,
    errorMessage: "late worker failure"
  };
  writeJobFile(repo, job.id, lateFailure);
  upsertJob(repo, lateFailure);

  const retryPids = [];
  await handleCancel([job.id, "--cwd", repo, "--json"], {
    async terminateProcessTreeImpl(pid) {
      retryPids.push(pid);
      return {
        attempted: true,
        delivered: true,
        verified: true,
        degraded: false,
        survivors: [],
        survivorIdentities: []
      };
    },
    probeWindowsProcessIdentityImpl(pid) {
      retryPids.push(pid);
      return { status: "absent", identity: null };
    },
    workerExitWaitMs: 0
  });

  const retried = readStoredJob(repo, job.id);
  assert.equal(retried.status, "cancelled");
  assert.equal(retried.cleanupOutcome.verified, true);
  assert.equal(retried.cleanupFailure, null);
  assert.ok(retryPids.length >= 1);
  assert.deepEqual(new Set(retryPids), new Set([job.pid]));
  assert.throws(() => resolveCancelableJob(repo, job.id), /already cancelled/);
  assert.equal(resolveResultJob(repo, job.id).job.id, job.id);
});

test("concurrent Cursor cancels keep verified worker cleanup monotonic", async () => {
  const repo = makeTaskRepo();
  const job = {
    id: "task-cursor-concurrent-cancel",
    workspaceRoot: repo,
    kind: "task",
    title: "Cursor Task",
    jobClass: "task",
    sessionLifetime: "persistent",
    status: "running",
    phase: "running",
    pid: 46002,
    processIdentity: "46002@worker",
    ownershipSnapshot: {
      rootPid: 46002,
      rootIdentity: "46002@worker",
      members: [{ pid: 46002, identity: "46002@worker", depth: 0 }]
    },
    createdAt: "2026-07-28T08:06:05.000Z"
  };
  writeJobFile(repo, job.id, job);
  upsertJob(repo, job);

  /** @type {() => void} */
  let markSlowStarted = () => {};
  const slowStarted = new Promise((resolve) => {
    markSlowStarted = resolve;
  });
  /** @type {(outcome: object) => void} */
  let releaseSlow = () => {};
  const slowOutcome = new Promise((resolve) => {
    releaseSlow = resolve;
  });
  const verified = {
    attempted: true,
    delivered: true,
    verified: true,
    degraded: false,
    survivors: [],
    survivorIdentities: []
  };

  const slowCancel = handleCancel([job.id, "--cwd", repo, "--json"], {
    async terminateProcessTreeImpl() {
      markSlowStarted();
      return slowOutcome;
    }
  });
  await slowStarted;
  await handleCancel([job.id, "--cwd", repo, "--json"], {
    async terminateProcessTreeImpl() {
      return verified;
    }
  });
  releaseSlow({
    attempted: true,
    delivered: false,
    verified: false,
    degraded: true,
    survivors: [job.pid],
    survivorIdentities: [job.processIdentity]
  });
  await slowCancel;

  const indexed = listJobs(repo).find((candidate) => candidate.id === job.id);
  const stored = readStoredJob(repo, job.id);
  for (const record of [indexed, stored]) {
    assert.equal(record.status, "cancelled");
    assert.equal(record.phase, "cancelled");
    assert.equal(record.cleanupFailure, null);
    assert.equal(record.cleanupOutcome.verified, true);
  }
});

test("Cursor cancel reaps WSL ownership published during worker teardown", async () => {
  const repo = makeTaskRepo();
  const job = {
    id: "task-cursor-late-wsl-owner",
    workspaceRoot: repo,
    kind: "task",
    title: "Cursor Task",
    jobClass: "task",
    sessionLifetime: "persistent",
    status: "running",
    phase: "running",
    pid: 46003,
    processIdentity: "46003@worker",
    ownershipSnapshot: {
      rootPid: 46003,
      rootIdentity: "46003@worker",
      members: [{ pid: 46003, identity: "46003@worker", depth: 0 }]
    },
    createdAt: "2026-07-28T08:06:07.000Z"
  };
  writeJobFile(repo, job.id, job);
  upsertJob(repo, job);

  const verified = {
    attempted: true,
    delivered: true,
    verified: true,
    degraded: false,
    survivors: [],
    survivorIdentities: []
  };
  let published = false;
  let workerCleanupCalls = 0;
  const wslReapPids = [];
  await handleCancel([job.id, "--cwd", repo, "--json"], {
    async reapWslAgentImpl(pid) {
      wslReapPids.push(pid);
      return { reaped: true, signal: "TERM" };
    },
    async terminateProcessTreeImpl() {
      workerCleanupCalls += 1;
      if (!published) {
        published = true;
        persistWslAgentIdentity(repo, job.id)(46004, "987654324");
      }
      return verified;
    }
  });

  assert.deepEqual(wslReapPids, [46004]);
  assert.equal(workerCleanupCalls, 2);
  const indexed = listJobs(repo).find((candidate) => candidate.id === job.id);
  const stored = readStoredJob(repo, job.id);
  for (const record of [indexed, stored]) {
    assert.equal(record.status, "cancelled");
    assert.equal(record.phase, "cancelled");
    assert.equal(record.wslAgentPid, 46004);
    assert.equal(record.wslReap.reaped, true);
    assert.equal(record.cleanupOutcome.verified, true);
  }
});

test("first WSL ownership published after cancellation reopens both stores", () => {
  const repo = makeTaskRepo();
  const job = {
    id: "task-cursor-post-cancel-wsl-owner",
    workspaceRoot: repo,
    kind: "task",
    title: "Cursor Task",
    jobClass: "task",
    sessionLifetime: "persistent",
    status: "cancelled",
    phase: "cancelled",
    pid: null,
    processIdentity: "46005@worker",
    cleanupOutcome: { attempted: true, delivered: true, verified: true },
    cleanupFailure: null,
    createdAt: "2026-07-28T08:06:07.500Z"
  };
  writeJobFile(repo, job.id, job);
  upsertJob(repo, job);

  persistWslAgentIdentity(repo, job.id)(46006, "987654326");

  for (const record of [
    listJobs(repo).find((candidate) => candidate.id === job.id),
    readStoredJob(repo, job.id)
  ]) {
    assert.equal(record.status, "cancelled");
    assert.equal(record.phase, "cleanup-pending");
    assert.equal(record.wslAgentPid, 46006);
    assert.equal(record.wslReap, null);
  }
  assert.equal(resolveCancelableJob(repo, job.id).job.id, job.id);
});

test("Cursor cancel stays retryable when late WSL ownership cannot be reaped", async () => {
  const repo = makeTaskRepo();
  const job = {
    id: "task-cursor-late-wsl-unverified",
    workspaceRoot: repo,
    kind: "task",
    title: "Cursor Task",
    jobClass: "task",
    sessionLifetime: "persistent",
    status: "running",
    phase: "running",
    pid: 46013,
    processIdentity: "46013@worker",
    ownershipSnapshot: {
      rootPid: 46013,
      rootIdentity: "46013@worker",
      members: [{ pid: 46013, identity: "46013@worker", depth: 0 }]
    },
    createdAt: "2026-07-28T08:06:08.000Z"
  };
  writeJobFile(repo, job.id, job);
  upsertJob(repo, job);

  let published = false;
  await assert.rejects(
    handleCancel([job.id, "--cwd", repo, "--json"], {
      async reapWslAgentImpl(pid) {
        return { reaped: false, survivors: [pid] };
      },
      async terminateProcessTreeImpl() {
        if (!published) {
          published = true;
          persistWslAgentIdentity(repo, job.id)(46014, "987654325");
        }
        return {
          attempted: true,
          delivered: true,
          verified: true,
          degraded: false,
          survivors: [],
          survivorIdentities: []
        };
      }
    }),
    /not marking cancelled/
  );

  for (const record of [
    listJobs(repo).find((candidate) => candidate.id === job.id),
    readStoredJob(repo, job.id)
  ]) {
    assert.equal(record.status, "running");
    assert.equal(record.phase, "cleanup-pending");
    assert.equal(record.wslAgentPid, 46014);
    assert.equal(record.wslReap.reaped, false);
  }
});

test("Cursor cleanup retry persists a verified WSL reap and retries only the worker root", async () => {
  const repo = makeTaskRepo();
  const job = {
    id: "task-cursor-wsl-reap-retry",
    workspaceRoot: repo,
    kind: "task",
    title: "Cursor Task",
    jobClass: "task",
    status: "running",
    phase: "running",
    pid: 46101,
    processIdentity: "46101@win32:123456790",
    ownershipSnapshot: null,
    wslAgentPid: 47101,
    wslAgentStartTime: "987654321",
    createdAt: "2026-07-28T08:06:10.000Z"
  };
  writeJobFile(repo, job.id, job);
  upsertJob(repo, job);

  const verifiedWslReap = { reaped: true, signal: "TERM" };
  let wslReapCalls = 0;
  let workerCleanupCalls = 0;
  await assert.rejects(
    handleCancel([job.id, "--cwd", repo, "--json"], {
      async reapWslAgentImpl(pid, options) {
        wslReapCalls += 1;
        assert.equal(pid, job.wslAgentPid);
        assert.equal(options.expectedStartTime, job.wslAgentStartTime);
        return verifiedWslReap;
      },
      async terminateProcessTreeImpl(pid) {
        workerCleanupCalls += 1;
        assert.equal(pid, job.pid);
        return {
          attempted: true,
          delivered: true,
          verified: false,
          degraded: true,
          survivors: [job.pid],
          survivorIdentities: [job.processIdentity]
        };
      },
      probeWindowsProcessIdentityImpl() {
        return { status: "unavailable", identity: null };
      },
      workerExitWaitMs: 0
    }),
    /ownership records were preserved for retry/
  );

  assert.deepEqual(readStoredJob(repo, job.id).wslReap, verifiedWslReap);
  assert.deepEqual(
    listJobs(repo).find((candidate) => candidate.id === job.id)?.wslReap,
    verifiedWslReap
  );

  await handleCancel([job.id, "--cwd", repo, "--json"], {
    async reapWslAgentImpl() {
      assert.fail("a verified WSL reap must not be repeated");
    },
    async terminateProcessTreeImpl(pid) {
      workerCleanupCalls += 1;
      assert.equal(pid, job.pid);
      return {
        attempted: true,
        delivered: true,
        verified: true,
        degraded: false,
        survivors: [],
        survivorIdentities: []
      };
    }
  });

  const cancelled = readStoredJob(repo, job.id);
  assert.equal(cancelled.status, "cancelled");
  assert.deepEqual(cancelled.wslReap, verifiedWslReap);
  assert.equal(cancelled.cleanupOutcome.verified, true);
  assert.equal(wslReapCalls, 1);
  assert.equal(workerCleanupCalls, 2);
});

test("Cursor cleanup retry skips an already verified worker root", async () => {
  const repo = makeTaskRepo();
  const verifiedWorkerCleanup = {
    attempted: true,
    delivered: true,
    verified: true,
    degraded: false,
    survivors: [],
    survivorIdentities: []
  };
  const job = {
    id: "task-cursor-worker-clean-retry",
    workspaceRoot: repo,
    kind: "task",
    title: "Cursor Task",
    jobClass: "task",
    status: "running",
    phase: "cleanup-pending",
    pid: 46102,
    processIdentity: "46102@win32:123456791",
    ownershipSnapshot: null,
    cleanupOutcome: verifiedWorkerCleanup,
    wslAgentPid: 47102,
    wslAgentStartTime: "987654322",
    wslReap: { reaped: false, survivors: [47102] },
    cleanupFailure: "WSL cleanup remains unverified",
    createdAt: "2026-07-28T08:06:20.000Z"
  };
  writeJobFile(repo, job.id, job);
  upsertJob(repo, job);

  let workerCleanupCalls = 0;
  await handleCancel([job.id, "--cwd", repo, "--json"], {
    async reapWslAgentImpl(pid, options) {
      assert.equal(pid, job.wslAgentPid);
      assert.equal(options.expectedStartTime, job.wslAgentStartTime);
      return { reaped: true, signal: "KILL" };
    },
    async terminateProcessTreeImpl() {
      workerCleanupCalls += 1;
      assert.fail("an already verified worker root must not be terminated again");
    }
  });

  const cancelled = readStoredJob(repo, job.id);
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.wslReap.reaped, true);
  assert.deepEqual(cancelled.cleanupOutcome, verifiedWorkerCleanup);
  assert.equal(workerCleanupCalls, 0);
});

test("Cursor cleanup finalizes an already verified WSL-only root without worker cleanup", async () => {
  const repo = makeTaskRepo();
  const verifiedWslReap = { reaped: true, signal: "TERM" };
  const job = {
    id: "task-cursor-wsl-only-clean",
    workspaceRoot: repo,
    kind: "task",
    title: "Cursor Task",
    jobClass: "task",
    status: "running",
    phase: "cleanup-pending",
    pid: null,
    wslAgentPid: 47103,
    wslAgentStartTime: "987654323",
    wslReap: verifiedWslReap,
    cleanupFailure: "worker ownership was never published",
    createdAt: "2026-07-28T08:06:30.000Z"
  };
  writeJobFile(repo, job.id, job);
  upsertJob(repo, job);

  await handleCancel([job.id, "--cwd", repo, "--json"], {
    async reapWslAgentImpl() {
      assert.fail("a verified WSL root must not be reaped again");
    },
    async terminateProcessTreeImpl() {
      assert.fail("an absent worker root must not invoke process cleanup");
    }
  });

  const cancelled = readStoredJob(repo, job.id);
  assert.equal(cancelled.status, "cancelled");
  assert.deepEqual(cancelled.wslReap, verifiedWslReap);
  assert.deepEqual(cancelled.cleanupOutcome, {
    attempted: false,
    delivered: false,
    verified: true,
    degraded: false,
    survivors: [],
    survivorIdentities: []
  });
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
  const launchEnv = {
    ...buildCursorEnv(binDir),
    CURSOR_COMPANION_SESSION_ID: "cursor-cancel-launch"
  };

  const launched = run("node", [SCRIPT, "task", "--background", "--json", "investigate the slow path"], {
    cwd: repo,
    env: launchEnv
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

  const cancelResult = run("node", [SCRIPT, "cancel", "--json"], {
    cwd: repo,
    env: {
      ...launchEnv,
      CURSOR_COMPANION_SESSION_ID: "cursor-cancel-next"
    }
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
