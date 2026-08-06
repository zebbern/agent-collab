// Mirrors the doctor tests for the cursor plugin's copy of the chassis and
// pins the cursor companion's doctor CLI surface against the fake agent.
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { buildCursorEnv, installFakeCursorAgent } from "./fake-cursor-agent-fixture.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";
import {
  buildPluginInstallChecks,
  renderDoctorReport,
  runDoctorChecks
} from "../plugins/cursor/scripts/lib/doctor.mjs";

const SCRIPT = fileURLToPath(new URL("../plugins/cursor/scripts/cursor-companion.mjs", import.meta.url));

test("cursor doctor runner aggregates statuses like the codex copy", async () => {
  const report = await runDoctorChecks([
    { id: "fine", run: () => ({ status: "ok", message: "all good" }) },
    { id: "meh", run: () => ({ status: "warning", message: "wobbly" }) }
  ]);
  assert.equal(report.overallStatus, "warning");
  assert.match(renderDoctorReport(report, { title: "Cursor Doctor" }), /# Cursor Doctor/);
});

test("cursor doctor --json reports a healthy environment against the fake agent", () => {
  const binDir = makeTempDir();
  installFakeCursorAgent(binDir);
  const repo = makeTempDir();
  initGitRepo(repo);

  const result = run("node", [SCRIPT, "doctor", "--json"], {
    cwd: repo,
    // Point the install checks at an empty config dir so the report stays
    // hermetic no matter what plugins the host machine really has installed.
    env: { ...buildCursorEnv(binDir), CLAUDE_CONFIG_DIR: makeTempDir() }
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.overallStatus, "ok", result.stdout);
  const ids = payload.checks.map((check) => check.id);
  for (const expected of ["cursor-cli", "cursor-auth", "plugin-name-collision", "plugin-cache-stale", "jobs-cleanup-pending", "state-lock"]) {
    assert.ok(ids.includes(expected), `missing check ${expected}`);
  }
});

// Fake <configDir>/plugins layout matching the real installer:
// installed_plugins.json maps "<name>@<marketplace>" keys to install-record
// arrays, and cached copies live under cache/<marketplace>/<name>/<version>/.
function writePluginRegistry(pluginsDir, plugins) {
  fs.mkdirSync(pluginsDir, { recursive: true });
  fs.writeFileSync(path.join(pluginsDir, "installed_plugins.json"), JSON.stringify({ version: 2, plugins }));
}

test("cursor plugin install checks flag a namespace collision and a stale cached copy", async () => {
  const pluginsDir = path.join(makeTempDir(), "plugins");
  writePluginRegistry(pluginsDir, {
    "cursor@agent-collab": [{ scope: "user", version: "0.4.0" }],
    "cursor@official-marketplace": [{ scope: "user", version: "0.3.0" }]
  });
  // 0.4.0 is registered; 0.3.9 is residue an update left behind.
  fs.mkdirSync(path.join(pluginsDir, "cache", "agent-collab", "cursor", "0.4.0"), { recursive: true });
  fs.mkdirSync(path.join(pluginsDir, "cache", "agent-collab", "cursor", "0.3.9"), { recursive: true });

  const report = await runDoctorChecks(buildPluginInstallChecks({ pluginName: "cursor", pluginsDir }));
  const byId = new Map(report.checks.map((check) => [check.id, check]));

  assert.equal(byId.get("plugin-name-collision").status, "warning");
  assert.match(byId.get("plugin-name-collision").message, /\/cursor:\*/);
  assert.deepEqual(byId.get("plugin-name-collision").details, ["cursor@agent-collab", "cursor@official-marketplace"]);
  assert.equal(byId.get("plugin-cache-stale").status, "warning");
  assert.match(byId.get("plugin-cache-stale").details.join(" "), /0\.3\.9/);
  assert.doesNotMatch(byId.get("plugin-cache-stale").details.join(" "), /0\.4\.0/);
});

test("cursor plugin install checks pass for a single-marketplace install with a clean cache", async () => {
  const pluginsDir = path.join(makeTempDir(), "plugins");
  writePluginRegistry(pluginsDir, { "cursor@agent-collab": [{ scope: "user", version: "0.4.0" }] });
  fs.mkdirSync(path.join(pluginsDir, "cache", "agent-collab", "cursor", "0.4.0"), { recursive: true });

  const report = await runDoctorChecks(buildPluginInstallChecks({ pluginName: "cursor", pluginsDir }));
  assert.equal(report.overallStatus, "ok");
  assert.equal(report.issueCount, 0);
});

test("cursor plugin install checks read a missing registry as not-installed", async () => {
  const pluginsDir = path.join(makeTempDir(), "plugins");
  const report = await runDoctorChecks(buildPluginInstallChecks({ pluginName: "cursor", pluginsDir }));
  assert.equal(report.overallStatus, "ok");
  assert.match(
    report.checks.find((check) => check.id === "plugin-name-collision").message,
    /not installed via a marketplace/
  );
});

test("cursor plugin install checks degrade a malformed registry to a warning, not a crash", async () => {
  const pluginsDir = path.join(makeTempDir(), "plugins");
  fs.mkdirSync(pluginsDir, { recursive: true });
  fs.writeFileSync(path.join(pluginsDir, "installed_plugins.json"), "{not json");

  const report = await runDoctorChecks(buildPluginInstallChecks({ pluginName: "cursor", pluginsDir }));
  const byId = new Map(report.checks.map((check) => [check.id, check]));

  assert.equal(byId.get("plugin-name-collision").status, "warning");
  // Unknown is not healthy: an unauditable cache is a warning, not a pass.
  assert.equal(byId.get("plugin-cache-stale").status, "warning");
  assert.equal(report.overallStatus, "warning");
});
