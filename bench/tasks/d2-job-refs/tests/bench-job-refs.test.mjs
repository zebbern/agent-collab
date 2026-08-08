// Bench ground truth for D2 (job-refs). Behavior-level: any correct fix
// passes, regardless of implementation strategy. Targets the CODEX companion
// only — cross-plugin mirroring of the underlying job-control.mjs fix is
// enforced separately by tests/chassis-drift.test.mjs, not by this file.
//
// Archaeology (read at the parent, 59e190c): matchJobReference(jobs,
// reference, predicate) filters jobs by predicate first, then throws
// `No job found for "<reference>". Run /codex:status to list known jobs.`
// whenever the reference isn't found *inside that filtered bucket* -- even
// when the job exists in a different bucket (e.g. it's running, and the
// caller's first probe filtered to the terminal-status bucket).
// resolveResultJob probes the terminal bucket first, so that throw fires
// before the running/queued branch below it is ever reached. This is the
// exact defect from symptom.md.
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { makeTempDir, run } from "./helpers.mjs";
import { resolveStateDir } from "../plugins/codex/scripts/lib/state.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "plugins", "codex", "scripts", "codex-companion.mjs");

// Bench isolation: never touch the real per-user state root, and never leak
// an installed session's id/transcript into these synthetic runs (the
// installed-session leak class documented at scripts/run-tests.mjs:42-52).
process.env.CLAUDE_PLUGIN_DATA = makeTempDir("codex-plugin-bench-d2-");
for (const name of [
  "CODEX_COMPANION_SESSION_ID",
  "CURSOR_COMPANION_SESSION_ID",
  "CODEX_COMPANION_TRANSCRIPT_PATH",
  "CURSOR_COMPANION_TRANSCRIPT_PATH"
]) {
  delete process.env[name];
}

function seedJob(workspace, { id, status, pid = null, writeJobFile = true }) {
  const stateDir = resolveStateDir(workspace);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });
  if (writeJobFile) {
    fs.writeFileSync(
      path.join(jobsDir, `${id}.json`),
      JSON.stringify({ id, status, title: "Codex Task" }, null, 2),
      "utf8"
    );
  }
  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id,
            status,
            pid,
            title: "Codex Task",
            createdAt: "2026-08-07T15:00:00.000Z",
            updatedAt: "2026-08-07T15:00:30.000Z"
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );
}

// RED at parent: matchJobReference's terminal-status probe throws "No job
// found" before the running/queued branch runs -- every assertion below
// fails together (nonzero exit is the only thing that happens to hold; the
// wording and doesNotMatch assertions do not). GREEN at the fix (abfd9aa):
// allowMissing lets the terminal probe return null instead of throwing, so
// resolveResultJob's active-job branch is reached and reports it honestly.
test("result on a RUNNING job reports it as running, not missing", () => {
  const workspace = makeTempDir("codex-plugin-bench-d2-ws-");
  seedJob(workspace, { id: "task-bench-running", status: "running", pid: 999999 });

  const result = run("node", [SCRIPT, "result", "task-bench-running"], { cwd: workspace });

  assert.notEqual(result.status, 0);
  assert.doesNotMatch(result.stderr, /No job found/);
  assert.match(result.stderr, /still running/);
  assert.match(result.stderr, /\/codex:status/);
});

// Same defect, queued bucket.
test("result on a QUEUED job reports it as queued, not missing", () => {
  const workspace = makeTempDir("codex-plugin-bench-d2-ws-");
  seedJob(workspace, { id: "task-bench-queued", status: "queued" });

  const result = run("node", [SCRIPT, "result", "task-bench-queued"], { cwd: workspace });

  assert.notEqual(result.status, 0);
  assert.doesNotMatch(result.stderr, /No job found/);
  assert.match(result.stderr, /still queued/);
  assert.match(result.stderr, /\/codex:status/);
});
