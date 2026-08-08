// Hermetic tests for the bench harness's pure lib modules and the
// worktree/git plumbing. No `claude` binary and no network: headless.mjs's
// pure helpers are tested directly (nothing here spawns claude), and
// createBenchWorktree is exercised against a real temp git repo built with
// initGitRepo — never the real machine's repository.
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import assert from "node:assert/strict";

import { initGitRepo, makeTempDir, run } from "./helpers.mjs";
import { validateManifest, loadManifest, MANIFEST_SCHEMA_VERSION } from "../bench/lib/manifest.mjs";
import { createBenchWorktree, removeReviewWorktree } from "../bench/lib/worktree.mjs";
import { buildArmSettings, buildClaudeInvocation, buildRunEnv, parseClaudeResult } from "../bench/lib/headless.mjs";
import { parseTap, newlyPassing, allTestsPass, allTestsFail, classifyRunStatus } from "../bench/lib/score.mjs";
import { harvestJobs } from "../bench/lib/telemetry.mjs";
import { buildRecord, appendRecord, readRecords, REPORT_SCHEMA_VERSION } from "../bench/lib/report.mjs";

// ---------------------------------------------------------------------------
// manifest.mjs
// ---------------------------------------------------------------------------

function validManifest() {
  return {
    schemaVersion: 1,
    id: "sample-task",
    fixSha: "abc1234",
    parentSha: "def5678",
    symptomFile: "symptom.md",
    groundTruth: {
      tests: [{ from: "ground-truth.test.mjs", to: "tests/ground-truth.test.mjs" }],
      fixtures: []
    },
    classBonus: null,
    originalStrict: {
      transplantFromFix: ["src/fixed.mjs"],
      excludeTestNames: [],
      caveat: "originalStrict only checks the transplanted files, not the whole fix."
    },
    regressionSuite: ["tests/existing.test.mjs"],
    driftCheckRequired: true,
    timeouts: { claudeMs: 600000, testMs: 120000 },
    budgetUsd: 2,
    forbiddenSymptomStrings: ["fixed.mjs"]
  };
}

test("validateManifest accepts a well-formed manifest", () => {
  assert.deepEqual(validateManifest(validManifest()), []);
});

test("validateManifest refuses a non-object", () => {
  assert.deepEqual(validateManifest(null), ["manifest must be a JSON object"]);
  assert.deepEqual(validateManifest([1, 2]), ["manifest must be a JSON object"]);
});

test("validateManifest refuses an unknown top-level key", () => {
  const manifest = { ...validManifest(), extra: true };
  const errors = validateManifest(manifest);
  assert.ok(errors.some((e) => e.includes('unknown key "extra"')), errors.join("\n"));
});

test("validateManifest refuses the wrong schemaVersion", () => {
  const errors = validateManifest({ ...validManifest(), schemaVersion: 2 });
  assert.ok(errors.some((e) => e === `schemaVersion must be ${MANIFEST_SCHEMA_VERSION}`), errors.join("\n"));
});

test("validateManifest refuses fixSha === parentSha", () => {
  const manifest = { ...validManifest(), fixSha: "abc1234", parentSha: "abc1234" };
  const errors = validateManifest(manifest);
  assert.ok(errors.includes("fixSha and parentSha must differ"), errors.join("\n"));
});

test("validateManifest refuses a non-hex sha", () => {
  const errors = validateManifest({ ...validManifest(), fixSha: "not-a-sha!" });
  assert.ok(errors.some((e) => e === "fixSha must be a hex git SHA string"), errors.join("\n"));
});

test("validateManifest refuses a groundTruth.tests pair missing 'to'", () => {
  const manifest = validManifest();
  manifest.groundTruth.tests = [{ from: "x.test.mjs" }];
  const errors = validateManifest(manifest);
  assert.ok(errors.some((e) => e === "groundTruth.tests[0].to must be a non-empty string"), errors.join("\n"));
});

test("validateManifest refuses an empty groundTruth.tests array", () => {
  const manifest = validManifest();
  manifest.groundTruth.tests = [];
  const errors = validateManifest(manifest);
  assert.ok(errors.includes("groundTruth.tests must contain at least one test"), errors.join("\n"));
});

test("validateManifest refuses a missing originalStrict.caveat", () => {
  const manifest = validManifest();
  manifest.originalStrict.caveat = "";
  const errors = validateManifest(manifest);
  assert.ok(errors.includes("originalStrict.caveat must be a non-empty string"), errors.join("\n"));
});

test("validateManifest refuses a non-positive budgetUsd", () => {
  const errors = validateManifest({ ...validManifest(), budgetUsd: 0 });
  assert.ok(errors.includes("budgetUsd must be a positive number"), errors.join("\n"));
});

test("loadManifest reads and validates manifest.json, and pins id to the directory name", () => {
  const tasksDir = makeTempDir("codex-plugin-bench-tasks-");
  const taskDir = path.join(tasksDir, "sample-task");
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(path.join(taskDir, "manifest.json"), JSON.stringify(validManifest()));

  const manifest = loadManifest(taskDir);
  assert.equal(manifest.id, "sample-task");
});

test("loadManifest throws with specifics naming the field on invalid JSON content", () => {
  const tasksDir = makeTempDir("codex-plugin-bench-tasks-");
  const taskDir = path.join(tasksDir, "broken-task");
  fs.mkdirSync(taskDir, { recursive: true });
  const bad = { ...validManifest(), id: "broken-task", schemaVersion: 99 };
  fs.writeFileSync(path.join(taskDir, "manifest.json"), JSON.stringify(bad));

  assert.throws(() => loadManifest(taskDir), /schemaVersion must be 1/);
});

test("loadManifest throws when the manifest id does not match the directory name", () => {
  const tasksDir = makeTempDir("codex-plugin-bench-tasks-");
  const taskDir = path.join(tasksDir, "dir-name");
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(path.join(taskDir, "manifest.json"), JSON.stringify({ ...validManifest(), id: "other-id" }));

  assert.throws(() => loadManifest(taskDir), /does not match the task directory name "dir-name"/);
});

// ---------------------------------------------------------------------------
// headless.mjs
// ---------------------------------------------------------------------------

test("buildArmSettings returns the exact shape for the solo arm", () => {
  assert.deepEqual(buildArmSettings("solo"), {
    enabledPlugins: {
      "codex@agent-collab": false,
      "cursor@agent-collab": false,
      "goal@agent-collab": false
    }
  });
});

test("buildArmSettings returns the exact shape for the codex arm", () => {
  assert.deepEqual(buildArmSettings("codex"), {
    enabledPlugins: {
      "codex@agent-collab": true,
      "cursor@agent-collab": false,
      "goal@agent-collab": false
    }
  });
});

test("buildArmSettings refuses an unknown arm", () => {
  assert.throws(() => buildArmSettings("cursor"), /Unknown bench arm "cursor"/);
});

test("buildClaudeInvocation produces the exact argv contract", () => {
  const invocation = buildClaudeInvocation({
    armSettingsFile: "/tmp/settings.json",
    prompt: "fix the bug",
    budgetUsd: 2
  });
  assert.equal(invocation.file, "claude");
  assert.deepEqual(invocation.args, [
    "-p", "fix the bug",
    "--output-format", "json",
    "--no-session-persistence",
    "--max-budget-usd", "2",
    "--permission-mode", "bypassPermissions",
    "--setting-sources", "user",
    "--settings", "/tmp/settings.json"
  ]);
});

test("buildRunEnv scrubs an ambient-identical session var but preserves a deliberately-set one, and injects state roots", () => {
  const savedCodex = process.env.CODEX_COMPANION_SESSION_ID;
  const savedCursor = process.env.CURSOR_COMPANION_SESSION_ID;
  process.env.CODEX_COMPANION_SESSION_ID = "ambient-session-123";
  delete process.env.CURSOR_COMPANION_SESSION_ID;
  try {
    const baseEnv = {
      PATH: process.env.PATH,
      CODEX_COMPANION_SESSION_ID: "ambient-session-123", // spread-inherited: identical to ambient
      CURSOR_COMPANION_SESSION_ID: "deliberately-set-session" // not equal to ambient (undefined): preserved
    };
    const pluginDataDir = path.join("some", "plugin-data-dir");
    const env = buildRunEnv(baseEnv, { pluginDataDir });

    assert.equal(env.CODEX_COMPANION_SESSION_ID, undefined);
    assert.equal(env.CURSOR_COMPANION_SESSION_ID, "deliberately-set-session");
    // CLAUDE_PLUGIN_DATA must point at a NON-harvested sibling of the state
    // roots: the agent runs the repo's parent-era tests, whose companions key
    // state off this var — pointing it at a harvested dir produced 6 phantom
    // arm-leaks in the first live matrix. Only the three *_COMPANION_STATE_ROOT
    // dirs below are harvested for delegation telemetry.
    assert.equal(env.CLAUDE_PLUGIN_DATA, path.join(pluginDataDir, "agent-ambient"));
    assert.equal(env.CODEX_COMPANION_STATE_ROOT, path.join(pluginDataDir, "codex-companion"));
    assert.equal(env.CURSOR_COMPANION_STATE_ROOT, path.join(pluginDataDir, "cursor-companion"));
    assert.equal(env.GOAL_COMPANION_STATE_ROOT, path.join(pluginDataDir, "goal-companion"));
  } finally {
    if (savedCodex === undefined) delete process.env.CODEX_COMPANION_SESSION_ID;
    else process.env.CODEX_COMPANION_SESSION_ID = savedCodex;
    if (savedCursor === undefined) delete process.env.CURSOR_COMPANION_SESSION_ID;
    else process.env.CURSOR_COMPANION_SESSION_ID = savedCursor;
  }
});

test("parseClaudeResult extracts the result fields from valid JSON", () => {
  const stdout = JSON.stringify({
    total_cost_usd: 0.42,
    num_turns: 3,
    duration_ms: 15000,
    is_error: false
  });
  const result = parseClaudeResult(stdout);
  assert.deepEqual(result, {
    totalCostUsd: 0.42,
    costMeasurable: true,
    numTurns: 3,
    durationMs: 15000,
    isError: false,
    raw: { total_cost_usd: 0.42, num_turns: 3, duration_ms: 15000, is_error: false }
  });
});

test("parseClaudeResult flags a zero-cost run with turns as unmeasured, not free", () => {
  const stdout = JSON.stringify({ total_cost_usd: 0, num_turns: 5, duration_ms: 9000, is_error: false });
  const result = parseClaudeResult(stdout);
  assert.equal(result.costMeasurable, false);
  assert.equal(result.totalCostUsd, 0);
});

test("parseClaudeResult reports malformed JSON as a harness-error instead of throwing", () => {
  const result = parseClaudeResult("{ not json");
  assert.equal(result.status, "harness-error");
  assert.match(result.detail, /claude output was not valid JSON/);
});

// ---------------------------------------------------------------------------
// score.mjs
// ---------------------------------------------------------------------------

test("parseTap extracts ok/not-ok result lines with their names", () => {
  const tap = [
    "TAP version 13",
    "# Subtest: sample.test.mjs",
    "    ok 1 - it does the thing",
    "    not ok 2 - it does the other thing",
    "      ---",
    "      duration_ms: 1.2",
    "      ...",
    "1..2"
  ].join("\n");
  assert.deepEqual(parseTap(tap), [
    { name: "it does the thing", ok: true },
    { name: "it does the other thing", ok: false }
  ]);
});

test("parseTap strips a trailing TAP directive comment", () => {
  const tap = "ok 1 - a skipped test # SKIP not applicable\n";
  assert.deepEqual(parseTap(tap), [{ name: "a skipped test", ok: true }]);
});

test("parseTap returns [] for text with no result lines", () => {
  assert.deepEqual(parseTap("TAP version 13\n1..0\n"), []);
});

test("newlyPassing finds tests passing after but not before, including tests absent from pre", () => {
  const pre = [
    { name: "a", ok: false },
    { name: "b", ok: true }
  ];
  const post = [
    { name: "a", ok: true }, // was failing, now passes
    { name: "b", ok: true }, // was already passing
    { name: "c", ok: true } // did not exist before, now passes
  ];
  assert.deepEqual(newlyPassing(pre, post), ["a", "c"]);
});

test("newlyPassing excludes a post-run failure even if it did not exist before", () => {
  const pre = [];
  const post = [{ name: "a", ok: false }];
  assert.deepEqual(newlyPassing(pre, post), []);
});

test("allTestsPass / allTestsFail require a non-empty, uniform result set", () => {
  assert.equal(allTestsPass([{ name: "a", ok: true }, { name: "b", ok: true }]), true);
  assert.equal(allTestsPass([{ name: "a", ok: true }, { name: "b", ok: false }]), false);
  assert.equal(allTestsPass([]), false);
  assert.equal(allTestsFail([{ name: "a", ok: false }]), true);
  assert.equal(allTestsFail([]), false);
});

test("classifyRunStatus prioritizes harness/timeout signals over scoring outcomes", () => {
  assert.equal(classifyRunStatus({ harnessError: true }), "harness-error");
  assert.equal(classifyRunStatus({ timedOut: true }), "timeout");
  assert.equal(classifyRunStatus({ preRedOk: false }), "invalid-red");
  assert.equal(classifyRunStatus({ baselineOk: false }), "invalid-baseline");
  assert.equal(classifyRunStatus({ armLeakDetected: true }), "invalid-arm-leak");
  assert.equal(classifyRunStatus({}), "complete");
});

// ---------------------------------------------------------------------------
// worktree.mjs
// ---------------------------------------------------------------------------

test("createBenchWorktree checks out a pinned sha, not HEAD, and removeReviewWorktree cleans it up", () => {
  const repo = makeTempDir("codex-plugin-bench-repo-");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "app.js"), "export const value = 1;\n");
  run("git", ["add", "app.js"], { cwd: repo });
  run("git", ["commit", "-m", "first"], { cwd: repo });
  const firstSha = run("git", ["rev-parse", "HEAD"], { cwd: repo }).stdout.trim();

  fs.writeFileSync(path.join(repo, "app.js"), "export const value = 2;\n");
  run("git", ["add", "app.js"], { cwd: repo });
  run("git", ["commit", "-m", "second"], { cwd: repo });
  const secondSha = run("git", ["rev-parse", "HEAD"], { cwd: repo }).stdout.trim();
  assert.notEqual(firstSha, secondSha);

  const worktree = createBenchWorktree(repo, firstSha, makeTempDir("codex-plugin-bench-tmp-"));
  assert.equal(worktree.isolated, true, worktree.reason ?? "");
  try {
    // The worktree is pinned at firstSha, not the repo's current HEAD (secondSha).
    assert.match(fs.readFileSync(path.join(worktree.path, "app.js"), "utf8"), /value = 1/);
  } finally {
    removeReviewWorktree(worktree);
  }
  assert.equal(fs.existsSync(worktree.path), false);
});

test("createBenchWorktree reports a reason instead of throwing when the sha does not resolve", () => {
  const repo = makeTempDir("codex-plugin-bench-repo-");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "app.js"), "export const value = 1;\n");
  run("git", ["add", "app.js"], { cwd: repo });
  run("git", ["commit", "-m", "first"], { cwd: repo });

  const worktree = createBenchWorktree(repo, "not-a-real-sha", makeTempDir("codex-plugin-bench-tmp-"));
  assert.equal(worktree.isolated, false);
  assert.equal(worktree.path, null);
  assert.match(worktree.reason, /does not resolve to a commit/);
});

// ---------------------------------------------------------------------------
// telemetry.mjs
// ---------------------------------------------------------------------------

test("harvestJobs reads both the parent-era and modern-fallback layouts and sums dual-dialect token fields", () => {
  const pluginDataDir = makeTempDir("codex-plugin-bench-telemetry-");

  // Parent-era layout: <pluginDataDir>/state/<slug-hash>/jobs/*.json
  const parentEraJobsDir = path.join(pluginDataDir, "state", "myworkspace-aaaa1111", "jobs");
  fs.mkdirSync(parentEraJobsDir, { recursive: true });
  fs.writeFileSync(
    path.join(parentEraJobsDir, "job1.json"),
    JSON.stringify({
      id: "job1",
      tokenUsage: { totalTokens: 100 },
      model: "gpt-5.6-sol",
      effort: "xhigh",
      startedAt: "2026-08-08T00:00:00.000Z",
      completedAt: "2026-08-08T00:01:00.000Z"
    })
  );

  // Modern fallback layout: <pluginDataDir>/<companion>/<slug-hash>/jobs/*.json
  const modernJobsDir = path.join(pluginDataDir, "codex-companion", "myworkspace-bbbb2222", "jobs");
  fs.mkdirSync(modernJobsDir, { recursive: true });
  fs.writeFileSync(
    path.join(modernJobsDir, "job2.json"),
    JSON.stringify({
      id: "job2",
      tokenUsage: { total_tokens: 50 },
      model: "gpt-5.3-codex-spark",
      effort: "medium",
      startedAt: "2026-08-08T00:02:00.000Z",
      completedAt: "2026-08-08T00:03:00.000Z"
    })
  );

  // A corrupt job file must be skipped, not crash the harvest.
  fs.writeFileSync(path.join(modernJobsDir, "corrupt.json"), "{ not json");

  const { jobs, totalTokens } = harvestJobs(pluginDataDir);
  assert.equal(jobs.length, 2);
  assert.equal(totalTokens, 150);
  const byModel = new Map(jobs.map((job) => [job.model, job]));
  assert.equal(byModel.get("gpt-5.6-sol").effort, "xhigh");
  assert.equal(byModel.get("gpt-5.3-codex-spark").effort, "medium");
});

test("harvestJobs returns an empty harvest for a directory with no job files", () => {
  const pluginDataDir = makeTempDir("codex-plugin-bench-telemetry-empty-");
  const result = harvestJobs(pluginDataDir);
  assert.deepEqual(result, { jobs: [], totalTokens: 0 });
});

// ---------------------------------------------------------------------------
// report.mjs
// ---------------------------------------------------------------------------

test("buildRecord fills every contract field, defaulting absent input honestly", () => {
  const record = buildRecord({ runId: "run-1", task: "sample-task", arm: "codex", repeat: 1 });
  assert.deepEqual(record, {
    schemaVersion: REPORT_SCHEMA_VERSION,
    runId: "run-1",
    task: "sample-task",
    arm: "codex",
    repeat: 1,
    parentSha: null,
    fixSha: null,
    startedAt: null,
    finishedAt: null,
    status: null,
    groundTruth: { exitCode: null, pass: null },
    classBonus: null,
    originalStrict: { newlyPassing: [], preFailing: [], excluded: [] },
    regression: null,
    drift: null,
    cleanPass: null,
    claude: null,
    delegation: { jobs: [], totalTokens: 0 },
    mainRepoDrift: null,
    artifactsDir: null
  });
});

test("appendRecord + readRecords round-trip JSONL, and a missing file reads as []", () => {
  const dir = makeTempDir("codex-plugin-bench-report-");
  const file = path.join(dir, "nested", "records.jsonl");

  assert.deepEqual(readRecords(file), []);

  const first = buildRecord({ runId: "run-1", task: "t", arm: "solo", repeat: 1, status: "complete" });
  const second = buildRecord({ runId: "run-2", task: "t", arm: "codex", repeat: 1, status: "timeout" });
  appendRecord(file, first);
  appendRecord(file, second);

  const records = readRecords(file);
  assert.equal(records.length, 2);
  assert.equal(records[0].runId, "run-1");
  assert.equal(records[1].status, "timeout");
});
