import fs from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir } from "./helpers.mjs";
import { boundTelemetryItems } from "../plugins/codex/scripts/codex-companion.mjs";
import {
  buildProgressSignals,
  buildStatusSnapshot,
  enrichJob,
  STALE_QUEUED_JOB_THRESHOLD_MS
} from "../plugins/codex/scripts/lib/job-control.mjs";
import { listJobs, saveState, upsertJob } from "../plugins/codex/scripts/lib/state.mjs";

test("boundTelemetryItems keeps short lists untouched", () => {
  const items = [{ id: "cmd-1" }, { id: "cmd-2" }];
  assert.equal(boundTelemetryItems(items), items);
  assert.deepEqual(boundTelemetryItems(undefined), []);
  assert.deepEqual(boundTelemetryItems(null), []);
});

test("boundTelemetryItems bounds long lists with a truncation marker", () => {
  const items = Array.from({ length: 130 }, (_, index) => ({ id: `cmd-${index}` }));
  const bounded = boundTelemetryItems(items);

  assert.equal(bounded.length, 101);
  assert.equal(bounded[0].id, "cmd-0");
  assert.equal(bounded[49].id, "cmd-49");
  assert.deepEqual(bounded[50], { truncated: 30 });
  assert.equal(bounded[51].id, "cmd-80");
  assert.equal(bounded[100].id, "cmd-129");
});

test("buildProgressSignals summarizes telemetry with a loop marker", () => {
  const signals = buildProgressSignals(
    { id: "task-1", status: "completed" },
    {
      storedResult: {
        fileChanges: [
          { changes: [{ path: "src/a.js" }], completedAt: "2026-03-24T20:00:00.000Z" },
          { truncated: 3 },
          { changes: [{ path: "src/b.js" }], completedAt: "2026-03-24T20:01:00.000Z" }
        ],
        commandExecutions: [
          { command: "npm test", completedAt: "2026-03-24T20:00:10.000Z" },
          { command: "npm test", completedAt: "2026-03-24T20:00:20.000Z" },
          { command: "npm test", completedAt: "2026-03-24T20:00:30.000Z" },
          { command: "git status", completedAt: "2026-03-24T20:00:40.000Z" }
        ],
        tokenUsage: { totalTokens: 100, inputTokens: 80, outputTokens: 20 }
      }
    }
  );

  assert.equal(signals[0], "files changed: 2");
  assert.match(signals[1], /^last activity: .+ ago$/);
  assert.equal(signals[2], "commands: 4 run (2 distinct), possible loop: npm test x3");
  assert.equal(signals[3], "tokens: 100 total (input 80, output 20)");
  assert.equal(signals.length, 4);
});

test("buildProgressSignals renders snake_case token usage and skips empty usage objects", () => {
  const job = { id: "task-tokens", status: "completed" };

  const snakeCase = buildProgressSignals(job, {
    storedResult: { tokenUsage: { total_tokens: 9, output_tokens: 4 } }
  });
  assert.deepEqual(snakeCase, ["tokens: 9 total (output 4)"]);

  const emptyUsage = buildProgressSignals(job, { storedResult: { tokenUsage: {} } });
  assert.deepEqual(emptyUsage, []);
});

test("buildProgressSignals omits gracefully without telemetry or a log file", () => {
  assert.deepEqual(
    buildProgressSignals({ id: "task-quiet", status: "running", workspaceRoot: makeTempDir() }, { storedResult: null }),
    []
  );
  assert.deepEqual(buildProgressSignals({ id: "task-queued", status: "queued" }), []);
});

test("buildProgressSignals falls back to the log file mtime for last activity", () => {
  const workspace = makeTempDir();
  const logFile = `${workspace}/task-logged.log`;
  const signals = buildProgressSignals(
    { id: "task-logged", status: "running", logFile },
    { storedResult: null }
  );

  // The log file does not exist yet, so no signal can be derived.
  assert.deepEqual(signals, []);

  fs.writeFileSync(logFile, "[2026-03-24T20:00:00.000Z] Working.\n", "utf8");
  const withLog = buildProgressSignals({ id: "task-logged", status: "running", logFile }, { storedResult: null });
  assert.deepEqual(withLog.length, 1);
  assert.match(withLog[0], /^last activity: .+ ago$/);
});

test("enrichJob marks a running job with a dead pid as likely dead without mutating the job", () => {
  const job = {
    id: "task-dead",
    status: "running",
    pid: 424242,
    createdAt: "2026-03-24T20:00:00.000Z"
  };

  const enriched = enrichJob(job, {
    storedResult: null,
    getLiveProcessPidsImpl: () => []
  });

  assert.equal(enriched.liveness, "likely dead");
  assert.equal(Object.hasOwn(job, "liveness"), false);
  assert.equal(Object.hasOwn(job, "progressSignals"), false);
});

test("enrichJob leaves a running job with a live pid unmarked", () => {
  const enriched = enrichJob(
    { id: "task-live", status: "running", pid: 424243, createdAt: "2026-03-24T20:00:00.000Z" },
    { storedResult: null, getLiveProcessPidsImpl: (pids) => pids }
  );

  assert.equal(enriched.liveness, null);
});

test("enrichJob guards liveness with the stored process identity", () => {
  const job = {
    id: "task-identity",
    status: "running",
    pid: 424244,
    processIdentity: "424244@started-earlier",
    createdAt: "2026-03-24T20:00:00.000Z"
  };

  const observed = [];
  const mismatch = enrichJob(job, {
    storedResult: null,
    getLiveProcessPidsImpl: (pids, options) => {
      observed.push({ pids, identities: options?.identities });
      return [];
    }
  });

  assert.equal(mismatch.liveness, "likely dead");
  assert.deepEqual(observed, [{ pids: [424244], identities: ["424244@started-earlier"] }]);

  const match = enrichJob(job, {
    storedResult: null,
    getLiveProcessPidsImpl: (pids) => pids
  });
  assert.equal(match.liveness, null);
});

test("enrichJob falls back to bare pid liveness when ownership capture failed", () => {
  const observed = [];
  const enriched = enrichJob(
    {
      id: "task-unverified",
      status: "running",
      pid: 424245,
      ownershipCaptureFailed: true,
      createdAt: "2026-03-24T20:00:00.000Z"
    },
    {
      storedResult: null,
      getLiveProcessPidsImpl: (pids, options) => {
        observed.push(options?.identities ?? null);
        return pids;
      }
    }
  );

  assert.equal(enriched.liveness, null);
  assert.deepEqual(observed, [[]]);
});

test("enrichJob surfaces the stored transport only when the result payload carries it", () => {
  const withFallback = enrichJob(
    { id: "task-transport", status: "completed", createdAt: "2026-03-24T20:00:00.000Z" },
    { storedResult: { transport: "direct", transportReason: "broker busy" } }
  );
  assert.equal(withFallback.transport, "direct");
  assert.equal(withFallback.transportReason, "broker busy");

  const sharedOnly = enrichJob(
    { id: "task-shared", status: "completed", createdAt: "2026-03-24T20:00:00.000Z" },
    { storedResult: { transport: "broker", transportReason: null } }
  );
  assert.equal(sharedOnly.transport, "broker");
  assert.equal(Object.hasOwn(sharedOnly, "transportReason"), false);

  const legacy = enrichJob(
    { id: "task-legacy", status: "completed", createdAt: "2026-03-24T20:00:00.000Z" },
    { storedResult: null }
  );
  assert.equal(Object.hasOwn(legacy, "transport"), false);
  assert.equal(Object.hasOwn(legacy, "transportReason"), false);
});

test("enrichJob marks stale queued jobs without a pid as likely dead", () => {
  const nowMs = Date.parse("2026-03-24T20:00:00.000Z");
  const stale = enrichJob(
    { id: "task-stale", status: "queued", pid: null, createdAt: "2026-03-24T19:00:00.000Z" },
    { storedResult: null, nowMs }
  );
  assert.equal(stale.liveness, "likely dead");

  const fresh = enrichJob(
    { id: "task-fresh", status: "queued", pid: null, createdAt: "2026-03-24T19:59:30.000Z" },
    { storedResult: null, nowMs }
  );
  assert.equal(fresh.liveness, null);
});

test("buildStatusSnapshot queries the process table once and never mutates stored state", () => {
  const workspace = makeTempDir();
  saveState(workspace, { jobs: [] });
  upsertJob(workspace, { id: "task-live", status: "running", pid: 111, title: "Codex Task" });
  upsertJob(workspace, {
    id: "task-dead",
    status: "running",
    pid: 222,
    processIdentity: "222@started-earlier",
    title: "Codex Task"
  });
  upsertJob(workspace, {
    id: "task-stale-queued",
    status: "queued",
    pid: null,
    createdAt: new Date(Date.now() - STALE_QUEUED_JOB_THRESHOLD_MS - 1000).toISOString(),
    title: "Codex Task"
  });
  const storedBefore = JSON.stringify(listJobs(workspace));

  let processTableCalls = 0;
  const snapshot = buildStatusSnapshot(workspace, {
    getLiveProcessPidsImpl: (pids, options) => {
      processTableCalls += 1;
      assert.deepEqual([...pids].sort((left, right) => left - right), [111, 222]);
      assert.deepEqual(options?.identities, ["222@started-earlier"]);
      return [111];
    }
  });

  assert.equal(processTableCalls, 1);
  const runningById = new Map(snapshot.running.map((job) => [job.id, job]));
  assert.equal(runningById.get("task-live").liveness, null);
  assert.equal(runningById.get("task-dead").liveness, "likely dead");
  assert.equal(runningById.get("task-stale-queued").liveness, "likely dead");

  const storedAfter = listJobs(workspace);
  assert.equal(JSON.stringify(storedAfter), storedBefore);
  for (const job of storedAfter) {
    assert.equal(Object.hasOwn(job, "liveness"), false);
    assert.equal(Object.hasOwn(job, "progressSignals"), false);
  }
});
