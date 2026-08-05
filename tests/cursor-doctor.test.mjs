// Mirrors the doctor tests for the cursor plugin's copy of the chassis and
// pins the cursor companion's doctor CLI surface against the fake agent.
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { buildCursorEnv, installFakeCursorAgent } from "./fake-cursor-agent-fixture.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";
import { renderDoctorReport, runDoctorChecks } from "../plugins/cursor/scripts/lib/doctor.mjs";

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
    env: buildCursorEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.overallStatus, "ok", result.stdout);
  const ids = payload.checks.map((check) => check.id);
  for (const expected of ["cursor-cli", "cursor-auth", "jobs-cleanup-pending", "state-lock"]) {
    assert.ok(ids.includes(expected), `missing check ${expected}`);
  }
});
