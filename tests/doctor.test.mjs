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
  buildModelRosterCheck,
  buildPluginInstallChecks,
  buildProcessTableGuard,
  buildStartupOverheadCheck,
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

test("the startup-overhead check summarizes per transport and stays informational", async () => {
  const empty = await runDoctorChecks([buildStartupOverheadCheck(() => [])]);
  assert.equal(empty.overallStatus, "ok");
  assert.match(empty.checks[0].message, /No startup samples yet/);

  const report = await runDoctorChecks([
    buildStartupOverheadCheck(() => [
      { kind: "startup", transport: "direct", ms: 100 },
      { kind: "startup", transport: "direct", ms: 300 },
      { kind: "startup", transport: "direct", ms: 200 },
      { kind: "startup", transport: "wsl", ms: 5000 },
      { kind: "other", transport: "direct", ms: 999999 },
      { kind: "startup", transport: "direct", ms: Number.NaN }
    ])
  ]);
  const check = report.checks[0];
  // Slow startup is decision input, never a health failure.
  assert.equal(check.status, "ok");
  assert.match(check.message, /4 sample\(s\)/);
  assert.ok(check.details.some((line) => /direct: n=3, median 200ms/.test(line)), JSON.stringify(check.details));
  assert.ok(check.details.some((line) => /wsl: n=1, median 5000ms/.test(line)), JSON.stringify(check.details));
});

// buildModelRosterCheck: fake roster probes only, never a real CLI. Covers
// the full contract — all ids present, a missing id, probe failure/absence,
// garbage/empty output (never read as "all missing"), and the codex
// no-roster-surface rendering.
const FAKE_PROFILES = [
  { name: "deep", id: "gpt-5.6-sol" },
  { name: "fast", id: "gpt-5.3-codex-spark" }
];

test("model roster check reports ok and names the verified profiles when every id is present", async () => {
  const report = await runDoctorChecks([
    buildModelRosterCheck({
      providerLabel: "fake-cli",
      profiles: FAKE_PROFILES,
      probeRoster: () => ({ status: "ok", ids: ["gpt-5.6-sol", "gpt-5.3-codex-spark", "auto"] })
    })
  ]);
  const check = report.checks[0];
  assert.equal(check.status, "ok");
  assert.match(check.message, /deep, fast/);
  assert.match(check.message, /verified/);
});

test("model roster check warns and names the profile and id when one is missing from the roster", async () => {
  const report = await runDoctorChecks([
    buildModelRosterCheck({
      providerLabel: "fake-cli",
      profiles: FAKE_PROFILES,
      probeRoster: () => ({ status: "ok", ids: ["gpt-5.3-codex-spark"] })
    })
  ]);
  const check = report.checks[0];
  assert.equal(check.status, "warning");
  assert.match(check.message, /1 pinned profile/);
  assert.match(check.message, /--model/);
  assert.deepEqual(check.details, ["deep: gpt-5.6-sol"]);
});

test("model roster check warns the roster is unauditable when the probe fails or is absent, never ok", async () => {
  const failing = await runDoctorChecks([
    buildModelRosterCheck({
      providerLabel: "fake-cli",
      profiles: FAKE_PROFILES,
      probeRoster: () => ({ status: "error", detail: "fake-cli: command not found" })
    })
  ]);
  assert.equal(failing.checks[0].status, "warning");
  assert.match(failing.checks[0].message, /unauditable/);
  assert.match(failing.checks[0].message, /command not found/);

  const throwing = await runDoctorChecks([
    buildModelRosterCheck({
      providerLabel: "fake-cli",
      profiles: FAKE_PROFILES,
      probeRoster: () => {
        throw new Error("probe exploded");
      }
    })
  ]);
  assert.equal(throwing.checks[0].status, "warning");
  assert.match(throwing.checks[0].message, /unauditable/);
  assert.match(throwing.checks[0].message, /probe exploded/);
});

test("model roster check treats empty or garbage roster output as unauditable, not as every id missing", async () => {
  const empty = await runDoctorChecks([
    buildModelRosterCheck({
      providerLabel: "fake-cli",
      profiles: FAKE_PROFILES,
      probeRoster: () => ({ status: "empty", detail: "no parseable ids" })
    })
  ]);
  assert.equal(empty.checks[0].status, "warning");
  assert.match(empty.checks[0].message, /unauditable/);
  assert.doesNotMatch(empty.checks[0].message, /pinned profile id\(s\) are missing/);
  assert.equal(empty.checks[0].details, undefined);

  const garbage = await runDoctorChecks([
    buildModelRosterCheck({
      providerLabel: "fake-cli",
      profiles: FAKE_PROFILES,
      probeRoster: () => ({ status: "ok", ids: [] })
    })
  ]);
  assert.equal(garbage.checks[0].status, "warning");
  assert.match(garbage.checks[0].message, /unauditable/);
});

test("model roster check renders the honest no-roster-surface ok for codex without implying the ids were checked", async () => {
  const report = await runDoctorChecks([
    buildModelRosterCheck({
      providerLabel: "codex-cli",
      profiles: FAKE_PROFILES,
      probeRoster: () => ({ status: "no-surface" })
    })
  ]);
  const check = report.checks[0];
  assert.equal(check.status, "ok");
  assert.match(check.message, /no model-roster command/);
  assert.match(check.message, /not because the ids were verified/);
  assert.doesNotMatch(check.message, /every pinned profile id is present/i);
});

// Fake <configDir>/plugins layout matching the real installer:
// installed_plugins.json maps "<name>@<marketplace>" keys to install-record
// arrays, and cached copies live under cache/<marketplace>/<name>/<version>/.
function writePluginRegistry(pluginsDir, plugins) {
  fs.mkdirSync(pluginsDir, { recursive: true });
  fs.writeFileSync(path.join(pluginsDir, "installed_plugins.json"), JSON.stringify({ version: 2, plugins }));
}

test("plugin install checks flag a namespace collision and a stale cached copy", async () => {
  const pluginsDir = path.join(makeTempDir(), "plugins");
  writePluginRegistry(pluginsDir, {
    "codex@agent-collab": [{ scope: "user", version: "1.0.6" }],
    "codex@official-marketplace": [{ scope: "user", version: "1.0.2" }],
    "unrelated@agent-collab": [{ scope: "user", version: "0.1.0" }]
  });
  // 1.0.6 is registered; 1.0.5 is residue an update left behind. The second
  // marketplace has no cache dir at all, which is not a finding.
  fs.mkdirSync(path.join(pluginsDir, "cache", "agent-collab", "codex", "1.0.6"), { recursive: true });
  fs.mkdirSync(path.join(pluginsDir, "cache", "agent-collab", "codex", "1.0.5"), { recursive: true });

  const report = await runDoctorChecks(buildPluginInstallChecks({ pluginName: "codex", pluginsDir }));
  const byId = new Map(report.checks.map((check) => [check.id, check]));

  assert.equal(byId.get("plugin-name-collision").status, "warning");
  assert.match(byId.get("plugin-name-collision").message, /\/codex:\*/);
  assert.deepEqual(byId.get("plugin-name-collision").details, ["codex@agent-collab", "codex@official-marketplace"]);
  assert.equal(byId.get("plugin-cache-stale").status, "warning");
  assert.match(byId.get("plugin-cache-stale").details.join(" "), /1\.0\.5/);
  assert.doesNotMatch(byId.get("plugin-cache-stale").details.join(" "), /1\.0\.6/);
});

test("a single-marketplace install with a fully registered cache is healthy", async () => {
  const pluginsDir = path.join(makeTempDir(), "plugins");
  // Two install records (user + project scope): both versions are
  // legitimate, so neither cached copy may read as stale.
  writePluginRegistry(pluginsDir, {
    "codex@agent-collab": [
      { scope: "user", version: "1.0.6" },
      { scope: "project", version: "1.0.5" }
    ]
  });
  fs.mkdirSync(path.join(pluginsDir, "cache", "agent-collab", "codex", "1.0.6"), { recursive: true });
  fs.mkdirSync(path.join(pluginsDir, "cache", "agent-collab", "codex", "1.0.5"), { recursive: true });

  const report = await runDoctorChecks(buildPluginInstallChecks({ pluginName: "codex", pluginsDir }));
  assert.equal(report.overallStatus, "ok");
  assert.equal(report.issueCount, 0);
  assert.match(report.checks.find((check) => check.id === "plugin-name-collision").message, /codex@agent-collab/);
});

test("a missing plugin registry reads as not-installed, never a failure", async () => {
  const pluginsDir = path.join(makeTempDir(), "plugins");
  const report = await runDoctorChecks(buildPluginInstallChecks({ pluginName: "codex", pluginsDir }));
  assert.equal(report.overallStatus, "ok");
  assert.match(
    report.checks.find((check) => check.id === "plugin-name-collision").message,
    /not installed via a marketplace/
  );
});

test("a malformed plugin registry degrades to a warning instead of crashing doctor", async () => {
  const pluginsDir = path.join(makeTempDir(), "plugins");
  fs.mkdirSync(pluginsDir, { recursive: true });
  fs.writeFileSync(path.join(pluginsDir, "installed_plugins.json"), "{not json");

  const report = await runDoctorChecks(buildPluginInstallChecks({ pluginName: "codex", pluginsDir }));
  const byId = new Map(report.checks.map((check) => [check.id, check]));

  assert.equal(byId.get("plugin-name-collision").status, "warning");
  assert.match(byId.get("plugin-name-collision").message, /installs cannot be audited/);
  // Unknown is not healthy: an unauditable cache is a warning, not a pass.
  assert.equal(byId.get("plugin-cache-stale").status, "warning");
  assert.match(byId.get("plugin-cache-stale").message, /cannot be audited/);
  // Described, not crashed: a broken registry is a warning, never an error.
  assert.equal(report.overallStatus, "warning");
});

test("an unreadable plugin registry is a warning, never absence", async () => {
  const pluginsDir = path.join(makeTempDir(), "plugins");
  // A directory where the registry file should be: readFileSync fails with a
  // non-ENOENT error (EISDIR), the class that must not read as "not installed".
  fs.mkdirSync(path.join(pluginsDir, "installed_plugins.json"), { recursive: true });

  const report = await runDoctorChecks(buildPluginInstallChecks({ pluginName: "codex", pluginsDir }));
  const byId = new Map(report.checks.map((check) => [check.id, check]));

  assert.equal(byId.get("plugin-name-collision").status, "warning");
  assert.match(byId.get("plugin-name-collision").message, /installs cannot be audited/);
  assert.equal(byId.get("plugin-cache-stale").status, "warning");
});

test("cache residue from an uninstalled marketplace is still found", async () => {
  const pluginsDir = path.join(makeTempDir(), "plugins");
  // The registry no longer mentions gone-marketplace at all (uninstalled),
  // but its cached copy is still on disk — exactly the residue to surface.
  writePluginRegistry(pluginsDir, {
    "codex@agent-collab": [{ scope: "user", version: "1.0.6" }]
  });
  fs.mkdirSync(path.join(pluginsDir, "cache", "agent-collab", "codex", "1.0.6"), { recursive: true });
  fs.mkdirSync(path.join(pluginsDir, "cache", "gone-marketplace", "codex", "1.0.1"), { recursive: true });

  const report = await runDoctorChecks(buildPluginInstallChecks({ pluginName: "codex", pluginsDir }));
  const stale = report.checks.find((check) => check.id === "plugin-cache-stale");

  assert.equal(stale.status, "warning");
  assert.match(stale.details.join(" "), /gone-marketplace/);
  assert.doesNotMatch(stale.details.join(" "), /1\.0\.6/);
});

test("a registry entry with no readable versions makes its cache unauditable, not stale", async () => {
  const pluginsDir = path.join(makeTempDir(), "plugins");
  // Records exist but carry no usable version strings: declaring every cached
  // copy stale (and deletable) on that evidence would overclaim.
  writePluginRegistry(pluginsDir, {
    "codex@agent-collab": [{ scope: "user" }, { scope: "project", version: 42 }]
  });
  fs.mkdirSync(path.join(pluginsDir, "cache", "agent-collab", "codex", "1.0.6"), { recursive: true });

  const report = await runDoctorChecks(buildPluginInstallChecks({ pluginName: "codex", pluginsDir }));
  const stale = report.checks.find((check) => check.id === "plugin-cache-stale");

  assert.equal(stale.status, "warning");
  assert.match(stale.message, /could not be audited/);
  assert.match(stale.details.join(" "), /no readable versions/);
  assert.doesNotMatch(stale.message, /not recorded in the plugin registry/);
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
    // Point the install checks at an empty config dir so the report stays
    // hermetic no matter what plugins the host machine really has installed.
    env: { ...buildEnv(binDir), CLAUDE_CONFIG_DIR: makeTempDir() }
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.schemaVersion, 1);
  assert.equal(payload.overallStatus, "ok", result.stdout);
  const ids = payload.checks.map((check) => check.id);
  for (const expected of [
    "codex-cli",
    "codex-auth",
    "codex-cli-freshness",
    "broker-residue",
    "model-roster-pins",
    "plugin-name-collision",
    "plugin-cache-stale",
    "state-lock"
  ]) {
    assert.ok(ids.includes(expected), `missing check ${expected}`);
  }
  // codex-cli has no roster surface at all, so the check is always the
  // honest no-surface "ok" rendering, independent of the fake CLI's behavior.
  const rosterCheck = payload.checks.find((check) => check.id === "model-roster-pins");
  assert.equal(rosterCheck.status, "ok");
  assert.match(rosterCheck.message, /no model-roster command/);
});
