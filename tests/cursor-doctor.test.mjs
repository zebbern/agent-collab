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
  buildModelRosterCheck,
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

// buildModelRosterCheck: fake roster probes only, never a real CLI. Mirrors
// the codex chassis test suite, using cursor's live-verified profile ids.
const FAKE_CURSOR_PROFILES = [
  { name: "deep", id: "gpt-5.6-sol-xhigh" },
  { name: "fast", id: "cursor-grok-4.5-high-fast" }
];

test("cursor model roster check reports ok and names the verified profiles when every id is present", async () => {
  const report = await runDoctorChecks([
    buildModelRosterCheck({
      providerLabel: "cursor-agent",
      profiles: FAKE_CURSOR_PROFILES,
      probeRoster: () => ({ status: "ok", ids: ["gpt-5.6-sol-xhigh", "cursor-grok-4.5-high-fast", "auto"] })
    })
  ]);
  const check = report.checks[0];
  assert.equal(check.status, "ok");
  assert.match(check.message, /deep, fast/);
  assert.match(check.message, /verified/);
});

test("cursor model roster check warns and names the profile and id when one is missing from the roster", async () => {
  const report = await runDoctorChecks([
    buildModelRosterCheck({
      providerLabel: "cursor-agent",
      profiles: FAKE_CURSOR_PROFILES,
      probeRoster: () => ({ status: "ok", ids: ["cursor-grok-4.5-high-fast"] })
    })
  ]);
  const check = report.checks[0];
  assert.equal(check.status, "warning");
  assert.match(check.message, /1 pinned profile/);
  assert.match(check.message, /--model/);
  assert.deepEqual(check.details, ["deep: gpt-5.6-sol-xhigh"]);
});

test("cursor model roster check warns the roster is unauditable when the probe fails or is absent, never ok", async () => {
  const failing = await runDoctorChecks([
    buildModelRosterCheck({
      providerLabel: "cursor-agent",
      profiles: FAKE_CURSOR_PROFILES,
      probeRoster: () => ({ status: "error", detail: "cursor-agent: command not found" })
    })
  ]);
  assert.equal(failing.checks[0].status, "warning");
  assert.match(failing.checks[0].message, /unauditable/);
  assert.match(failing.checks[0].message, /command not found/);

  const throwing = await runDoctorChecks([
    buildModelRosterCheck({
      providerLabel: "cursor-agent",
      profiles: FAKE_CURSOR_PROFILES,
      probeRoster: () => {
        throw new Error("WSL probe exploded");
      }
    })
  ]);
  assert.equal(throwing.checks[0].status, "warning");
  assert.match(throwing.checks[0].message, /unauditable/);
  assert.match(throwing.checks[0].message, /WSL probe exploded/);
});

test("cursor model roster check treats empty or garbage roster output as unauditable, not as every id missing", async () => {
  const empty = await runDoctorChecks([
    buildModelRosterCheck({
      providerLabel: "cursor-agent",
      profiles: FAKE_CURSOR_PROFILES,
      probeRoster: () => ({ status: "empty", detail: "no parseable ids" })
    })
  ]);
  assert.equal(empty.checks[0].status, "warning");
  assert.match(empty.checks[0].message, /unauditable/);
  assert.doesNotMatch(empty.checks[0].message, /pinned profile id\(s\) are missing/);
  assert.equal(empty.checks[0].details, undefined);

  const garbage = await runDoctorChecks([
    buildModelRosterCheck({
      providerLabel: "cursor-agent",
      profiles: FAKE_CURSOR_PROFILES,
      probeRoster: () => ({ status: "ok", ids: [] })
    })
  ]);
  assert.equal(garbage.checks[0].status, "warning");
  assert.match(garbage.checks[0].message, /unauditable/);
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
    // CURSOR_COMPANION_TEST_BINARY pins the fixture's node-script twin: PATH
    // discovery on win32 resolves a cmd shim, and the roster probe refuses
    // shim plans rather than reimplementing cmd.exe quoting — the same
    // override tests/cursor-runtime.test.mjs uses for the same reason.
    env: {
      ...buildCursorEnv(binDir),
      CLAUDE_CONFIG_DIR: makeTempDir(),
      CURSOR_COMPANION_TEST_BINARY: path.join(binDir, "cursor-agent.mjs")
    }
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  const ids = payload.checks.map((check) => check.id);
  for (const expected of [
    "cursor-cli",
    "cursor-auth",
    "model-roster-pins",
    "plugin-name-collision",
    "plugin-cache-stale",
    "jobs-cleanup-pending",
    "state-lock"
  ]) {
    assert.ok(ids.includes(expected), `missing check ${expected}`);
  }
  const byId = new Map(payload.checks.map((check) => [check.id, check]));
  for (const expected of ["cursor-cli", "cursor-auth", "plugin-name-collision", "plugin-cache-stale", "jobs-cleanup-pending", "state-lock"]) {
    assert.equal(byId.get(expected).status, "ok", `${expected}: ${byId.get(expected).message}`);
  }
  // The fake cursor-agent answers `--list-models` with a roster carrying both
  // pinned profile ids, so a healthy environment reads healthy end to end. A
  // stale profile id is what must turn this red — never the fixture's own
  // ignorance of the command.
  assert.equal(byId.get("model-roster-pins").status, "ok", byId.get("model-roster-pins").message);
  assert.equal(payload.overallStatus, "ok", result.stdout);
});

test("cursor doctor flags a pinned profile id the live roster no longer lists", () => {
  const repo = makeTempDir("cursor-plugin-test-");
  const binDir = makeTempDir("cursor-plugin-test-");
  installFakeCursorAgent(binDir, "roster-missing-profile");

  const result = run("node", [SCRIPT, "doctor", "--json"], {
    cwd: repo,
    env: {
      ...buildCursorEnv(binDir),
      CLAUDE_CONFIG_DIR: makeTempDir(),
      CURSOR_COMPANION_TEST_BINARY: path.join(binDir, "cursor-agent.mjs")
    }
  });

  const payload = JSON.parse(result.stdout);
  const check = payload.checks.find((entry) => entry.id === "model-roster-pins");
  assert.equal(check.status, "warning", check.message);
  // Names the profile AND the id that went stale, so the fix is obvious.
  assert.match(`${check.message} ${(check.details ?? []).join(" ")}`, /gpt-5\.6-sol-xhigh/);
  assert.match(`${check.message} ${(check.details ?? []).join(" ")}`, /deep/);
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
