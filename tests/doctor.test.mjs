// Doctor check-runner and state-hygiene tests: aggregation picks the worst
// status, warnings never fail the command, a throwing check degrades to an
// error finding instead of aborting the report, and the hygiene sweep
// surfaces exactly the residue artifacts the failure paths write.
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";
import {
  buildLivenessProbe,
  buildProcessTableGuard,
  buildStateHygieneChecks,
  LIVENESS_SENTINEL_PID,
  renderDoctorReport,
  runDoctorChecks
} from "../plugins/codex/scripts/lib/doctor.mjs";
import { listJobs, resolveStateDir, upsertJob, writeJobFile } from "../plugins/codex/scripts/lib/state.mjs";

const SCRIPT = fileURLToPath(new URL("../plugins/codex/scripts/codex-companion.mjs", import.meta.url));

test("runDoctorChecks aggregates the worst status and keeps going past a throwing check", async () => {
  const report = await runDoctorChecks([
    { id: "fine", run: () => ({ status: "ok", message: "all good" }) },
    { id: "meh", run: async () => ({ status: "warning", message: "wobbly", details: ["specifics"] }) },
    {
      id: "broken",
      run: () => {
        throw new Error("boom");
      }
    }
  ]);

  assert.equal(report.schemaVersion, 1);
  assert.equal(report.overallStatus, "error");
  assert.equal(report.issueCount, 2);
  assert.equal(report.checks.length, 3);
  assert.equal(report.checks[2].status, "error");
  assert.match(report.checks[2].message, /boom/);

  const rendered = renderDoctorReport(report, { title: "Test Doctor" });
  assert.match(rendered, /# Test Doctor/);
  assert.match(rendered, /Overall: error \(2 issues\)\./);
  assert.match(rendered, /\[WARN\] meh: wobbly/);
  assert.match(rendered, /- specifics/);
});

test("runDoctorChecks reports ok overall when every check passes", async () => {
  const report = await runDoctorChecks([{ id: "fine", run: () => ({ status: "ok", message: "all good" }) }]);
  assert.equal(report.overallStatus, "ok");
  assert.equal(report.issueCount, 0);
  assert.match(renderDoctorReport(report), /Overall: ok — no issues found\./);
});

test("state hygiene checks surface cleanup-pending jobs, dead workers, stale locks, quarantine, and orphans", async () => {
  const workspace = makeTempDir();
  upsertJob(workspace, {
    id: "task-pending",
    status: "running",
    pid: 4242,
    phase: "cleanup-pending",
    cleanupFailure: "ownership records were preserved for retry"
  });
  upsertJob(workspace, { id: "task-dead", status: "running", pid: 5151 });
  writeJobFile(workspace, "task-pending", { id: "task-pending" });

  const stateDir = resolveStateDir(workspace);
  const lockFile = path.join(stateDir, "state.lock");
  fs.writeFileSync(lockFile, "9999");
  const past = new Date(Date.now() - 60_000);
  fs.utimesSync(lockFile, past, past);
  fs.writeFileSync(path.join(stateDir, "state.json.corrupt-20260805"), "{}");
  fs.writeFileSync(path.join(stateDir, "jobs", "task-orphan.json"), "{}");

  const report = await runDoctorChecks(
    buildStateHygieneChecks({
      stateDir,
      jobs: listJobs(workspace),
      getLiveJobPidsImpl: () => new Set(),
      commandPrefix: "/codex"
    })
  );
  const byId = new Map(report.checks.map((check) => [check.id, check]));

  assert.equal(byId.get("jobs-cleanup-pending").status, "warning");
  assert.match(byId.get("jobs-cleanup-pending").details.join(" "), /task-pending/);
  assert.match(byId.get("jobs-cleanup-pending").message, /\/codex:cancel/);
  assert.equal(byId.get("jobs-likely-dead").status, "warning");
  assert.match(byId.get("jobs-likely-dead").details.join(" "), /task-dead/);
  assert.equal(byId.get("state-lock").status, "warning");
  assert.match(byId.get("state-lock").message, /stale/);
  assert.equal(byId.get("state-quarantine").status, "warning");
  assert.match(byId.get("state-quarantine").details.join(" "), /corrupt-20260805/);
  assert.equal(byId.get("jobs-orphaned-files").status, "warning");
  assert.match(byId.get("jobs-orphaned-files").details.join(" "), /task-orphan/);
  assert.equal(report.overallStatus, "warning");
});

test("an unavailable process table reads as unknown liveness, never as healthy", async () => {
  const workspace = makeTempDir();
  upsertJob(workspace, { id: "task-live", status: "running", pid: 4242 });
  writeJobFile(workspace, "task-live", { id: "task-live" });

  // getLiveProcessPids fails closed for cancel by returning every candidate
  // when the table is unreadable; the sentinel wrapper must translate that
  // into null (unknown) instead of a fake-healthy set.
  const degradedProbe = buildLivenessProbe((jobs) => new Set(jobs.map((job) => job.pid)));
  assert.equal(degradedProbe([{ pid: 4242 }]), null);

  const healthyProbe = buildLivenessProbe((jobs) =>
    new Set(jobs.map((job) => job.pid).filter((pid) => pid !== LIVENESS_SENTINEL_PID))
  );
  assert.deepEqual([...healthyProbe([{ pid: 4242 }])], [4242]);

  const report = await runDoctorChecks(
    buildStateHygieneChecks({
      stateDir: resolveStateDir(workspace),
      jobs: listJobs(workspace),
      getLiveJobPidsImpl: () => null,
      commandPrefix: "/codex"
    })
  );
  const liveness = report.checks.find((check) => check.id === "jobs-likely-dead");
  assert.equal(liveness.status, "warning");
  assert.match(liveness.message, /could not be determined/);
});

test("buildProcessTableGuard throws on a fail-closed candidate echo instead of faking liveness", () => {
  // A degraded table echoes every candidate back; the broker owner
  // assessment maps a throwing impl to owner-liveness-unavailable, so the
  // guard must throw rather than let dead owners read as live.
  const guard = buildProcessTableGuard((pids) => [...pids]);
  assert.throws(() => guard([4242], {}), (error) => error.code === "PROCESS_TABLE_UNAVAILABLE");

  const healthyGuard = buildProcessTableGuard((pids) => pids.filter((pid) => pid === 4242));
  assert.deepEqual(healthyGuard([4242, 5151], {}), [4242]);
});

test("orphaned job files with an empty index are reported as a possibly lost index, not deletable residue", async () => {
  const workspace = makeTempDir();
  // Job files exist but nothing was ever indexed (or the index was lost):
  // the check must not coach deletion.
  writeJobFile(workspace, "task-stranded", { id: "task-stranded" });
  const report = await runDoctorChecks(
    buildStateHygieneChecks({
      stateDir: resolveStateDir(workspace),
      jobs: [],
      getLiveJobPidsImpl: () => new Set(),
      commandPrefix: "/codex"
    })
  );
  const orphans = report.checks.find((check) => check.id === "jobs-orphaned-files");
  assert.equal(orphans.status, "warning");
  assert.match(orphans.message, /index may have been lost/);
  assert.doesNotMatch(orphans.message, /safe to delete/);
});

test("state hygiene checks are all ok for a clean workspace", async () => {
  const workspace = makeTempDir();
  upsertJob(workspace, { id: "task-done", status: "completed", pid: null });
  writeJobFile(workspace, "task-done", { id: "task-done", status: "completed" });

  const report = await runDoctorChecks(
    buildStateHygieneChecks({
      stateDir: resolveStateDir(workspace),
      jobs: listJobs(workspace),
      getLiveJobPidsImpl: () => new Set(),
      commandPrefix: "/codex"
    })
  );

  assert.equal(report.overallStatus, "ok");
  assert.equal(report.issueCount, 0);
});

test("doctor --json reports a healthy environment against the fake codex", () => {
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const repo = makeTempDir();
  initGitRepo(repo);

  const result = run("node", [SCRIPT, "doctor", "--json"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.schemaVersion, 1);
  assert.equal(payload.overallStatus, "ok", result.stdout);
  const ids = payload.checks.map((check) => check.id);
  for (const expected of ["codex-cli", "codex-auth", "codex-cli-freshness", "broker-residue", "state-lock"]) {
    assert.ok(ids.includes(expected), `missing check ${expected}`);
  }
});
