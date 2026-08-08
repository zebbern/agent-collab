// Bench classBonus for D2 (job-refs): the same underlying bucket-before-match
// bug class, exercised on two siblings beyond the reported symptom. Wording
// is deliberately NOT pinned (see manifest originalStrict.caveat) -- only
// that the failure is loud and names the job id.
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { makeTempDir, run } from "./helpers.mjs";
import { resolveStateDir } from "../plugins/codex/scripts/lib/state.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "plugins", "codex", "scripts", "codex-companion.mjs");

process.env.CLAUDE_PLUGIN_DATA = makeTempDir("codex-plugin-bench-d2-class-");
for (const name of [
  "CODEX_COMPANION_SESSION_ID",
  "CURSOR_COMPANION_SESSION_ID",
  "CODEX_COMPANION_TRANSCRIPT_PATH",
  "CURSOR_COMPANION_TRANSCRIPT_PATH"
]) {
  delete process.env[name];
}

function seedJob(workspace, { id, status, writeJobFile = true }) {
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
            title: "Codex Task",
            createdAt: "2026-08-07T15:00:00.000Z",
            updatedAt: "2026-08-07T15:01:00.000Z"
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );
}

// RED at parent (verified by reading job-control.mjs and render.mjs at
// 59e190c): the completed job IS found by matchJobReference (it's in the
// terminal bucket), so resolveResultJob returns it with no missing-payload
// check. readStoredJob then returns null (no jobs/<id>.json), and
// renderStoredJobResult's fallback path renders "No captured result payload
// was stored for this job." on a clean exit 0 -- a silent negative. The
// nonzero-exit assertion alone is enough to fail this at the parent.
// GREEN at the fix (abfd9aa): resolveResultJob checks readStoredJob and
// throws, naming the job and its status.
test("result on a completed job with a missing stored result file fails loudly and names the id", () => {
  const workspace = makeTempDir("codex-plugin-bench-d2-class-ws-");
  seedJob(workspace, { id: "task-bench-pruned", status: "completed", writeJobFile: false });

  const result = run("node", [SCRIPT, "result", "task-bench-pruned"], { cwd: workspace });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /task-bench-pruned/);
});

// RED at parent: resolveCancelableJob filters to activeJobs before calling
// matchJobReference(activeJobs, reference) with no allowMissing -- the
// completed job isn't in that filtered bucket, so matchJobReference itself
// throws `No job found for "task-bench-finished". Run /codex:status to list
// known jobs.` (the `if (!selected) throw "No active job found for"` branch
// below it is dead code; matchJobReference never returns null here). The
// doesNotMatch(/No job found/) assertion fails at the parent for this exact
// reason. GREEN at the fix: the active-bucket probe uses allowMissing, then
// falls back to the full job list and reports "already <status>" instead.
test("cancel on an already-completed job id says it is finished, not missing", () => {
  const workspace = makeTempDir("codex-plugin-bench-d2-class-ws-");
  seedJob(workspace, { id: "task-bench-finished", status: "completed" });

  const result = run("node", [SCRIPT, "cancel", "task-bench-finished"], { cwd: workspace });

  assert.notEqual(result.status, 0);
  assert.doesNotMatch(result.stderr, /No job found/);
  assert.match(result.stderr, /task-bench-finished/);
});
