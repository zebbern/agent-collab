// Exact-string assertions on bench/aggregate.mjs's output, in the same style
// as tests/startup-baseline.test.mjs: the floor line, UNCOMPARABLE cells, the
// per-task solo-vs-codex comparison, a manifest caveat printed under its
// strict metric, and the explicit "nothing was verified" line when no cell
// clears the floor. Every input is a synthetic JSONL file and a synthetic
// manifest tree in an isolated temp dir — never the repo's real bench data.
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir, run } from "./helpers.mjs";
import { appendRecord, buildRecord } from "../bench/lib/report.mjs";
import { buildAggregateReport, cellKey, computeCellStats, groupByCell, DEFAULT_MIN_SAMPLES } from "../bench/aggregate.mjs";

const SCRIPT = path.resolve("bench/aggregate.mjs");

function runCli(args) {
  return run(process.execPath, [SCRIPT, ...args]);
}

function completeRecord(overrides = {}) {
  return buildRecord({
    runId: `run-${Math.random().toString(36).slice(2)}`,
    task: "task-a",
    arm: "solo",
    repeat: 1,
    status: "complete",
    groundTruth: { exitCode: 0, pass: true },
    claude: { durationMs: 1000, totalCostUsd: 0.1 },
    ...overrides
  });
}

// ---------------------------------------------------------------------------
// pure helpers
// ---------------------------------------------------------------------------

test("cellKey and groupByCell bucket records by task::arm", () => {
  assert.equal(cellKey("task-a", "solo"), "task-a::solo");
  const byCell = groupByCell([
    completeRecord({ task: "task-a", arm: "solo" }),
    completeRecord({ task: "task-a", arm: "codex" }),
    completeRecord({ task: "task-b", arm: "solo" })
  ]);
  assert.deepEqual([...byCell.keys()].sort(), ["task-a::codex", "task-a::solo", "task-b::solo"]);
});

test("computeCellStats counts invalid-by-reason separately from valid k-of-n", () => {
  const cell = {
    task: "task-a",
    arm: "solo",
    records: [
      completeRecord({ groundTruth: { exitCode: 0, pass: true } }),
      completeRecord({ groundTruth: { exitCode: 1, pass: false } }),
      buildRecord({ task: "task-a", arm: "solo", repeat: 3, status: "timeout" }),
      buildRecord({ task: "task-a", arm: "solo", repeat: 4, status: "timeout" }),
      buildRecord({ task: "task-a", arm: "solo", repeat: 5, status: "harness-error" })
    ]
  };
  const stats = computeCellStats(cell);
  assert.equal(stats.n, 5);
  assert.equal(stats.nValid, 2);
  assert.deepEqual(stats.invalidByReason, { timeout: 2, "harness-error": 1 });
  assert.equal(stats.primaryK, 1);
  assert.equal(stats.primaryN, 2);
});

test("computeCellStats scores originalStrict as an all-required-tests-newly-passing check", () => {
  const passingStrict = completeRecord({
    originalStrict: { newlyPassing: ["a", "b"], preFailing: ["a", "b", "excluded-one"], excluded: ["excluded-one"] }
  });
  const failingStrict = completeRecord({
    originalStrict: { newlyPassing: ["a"], preFailing: ["a", "b"], excluded: [] }
  });
  const stats = computeCellStats({ task: "task-a", arm: "solo", records: [passingStrict, failingStrict] });
  assert.equal(stats.strictN, 2);
  assert.equal(stats.strictK, 1);
});

// ---------------------------------------------------------------------------
// buildAggregateReport (in-process, exact-string assertions)
// ---------------------------------------------------------------------------

test("buildAggregateReport reports 'nothing was verified' with no records at all", () => {
  const { lines, verdict } = buildAggregateReport([], { minSamples: DEFAULT_MIN_SAMPLES });
  assert.equal(lines.at(-1), "No run records found; nothing was verified.");
  assert.equal(verdict.verdict, "nothing-verified");
  assert.equal(verdict.exitCode, 0);
});

test("buildAggregateReport marks a below-floor cell UNCOMPARABLE and the whole report nothing-was-verified", () => {
  const records = [completeRecord({ task: "task-a", arm: "solo", repeat: 1 })]; // only 1 valid sample
  const { lines, verdict } = buildAggregateReport(records, { minSamples: 2 });
  assert.match(lines[0], />= 2 valid/);
  assert.equal(lines.includes("[UNCOMPARABLE] task-a::solo: n=1 valid=1 (below the 2-sample floor)"), true);
  assert.equal(lines.includes("Every cell was UNCOMPARABLE; nothing was verified."), true);
  assert.equal(verdict.verdict, "nothing-verified");
});

test("buildAggregateReport reports an [OK] cell once it clears the floor, with the exact stat line", () => {
  const records = [
    completeRecord({ task: "task-a", arm: "solo", repeat: 1, groundTruth: { exitCode: 0, pass: true }, claude: { durationMs: 1000, totalCostUsd: 0.1 } }),
    completeRecord({ task: "task-a", arm: "solo", repeat: 2, groundTruth: { exitCode: 1, pass: false }, claude: { durationMs: 2000, totalCostUsd: 0.3 } })
  ];
  const { lines, verdict } = buildAggregateReport(records, { minSamples: 2 });
  // originalStrict defaults to an empty-preFailing object (never null — see
  // report.mjs's buildRecord), which is vacuously satisfied, so strict is
  // 2/2 here even though neither record set up a real strict scenario;
  // cleanPass stays null by default, so clean is n/a.
  assert.equal(
    lines.includes(
      "[OK] task-a::solo: n=2 valid=2 (0 invalid), primary 1/2, clean n/a, strict 2/2, median duration 1500ms, median cost $0.2"
    ),
    true,
    lines.join("\n")
  );
  assert.equal(verdict.verdict, "reported");
});

test("buildAggregateReport prints a manifest caveat directly under its task's OK line", () => {
  const records = [
    completeRecord({ task: "task-a", arm: "solo", repeat: 1 }),
    completeRecord({ task: "task-a", arm: "solo", repeat: 2 })
  ];
  const caveats = new Map([["task-a", "originalStrict only checks the transplanted files."]]);
  const { lines } = buildAggregateReport(records, { minSamples: 2, caveats });
  const okIndex = lines.findIndex((line) => line.startsWith("[OK] task-a::solo"));
  assert.notEqual(okIndex, -1);
  assert.equal(lines[okIndex + 1], "  strict caveat (task-a): originalStrict only checks the transplanted files.");
});

test("buildAggregateReport prints a per-task solo-vs-codex line only when both arms clear the floor", () => {
  const records = [
    completeRecord({ task: "task-a", arm: "solo", repeat: 1, groundTruth: { exitCode: 1, pass: false } }),
    completeRecord({ task: "task-a", arm: "solo", repeat: 2, groundTruth: { exitCode: 1, pass: false } }),
    completeRecord({ task: "task-a", arm: "codex", repeat: 1, groundTruth: { exitCode: 0, pass: true } }),
    completeRecord({ task: "task-a", arm: "codex", repeat: 2, groundTruth: { exitCode: 0, pass: true } })
  ];
  const { lines } = buildAggregateReport(records, { minSamples: 2 });
  assert.equal(lines.includes("Per-task solo vs codex:"), true);
  assert.equal(lines.includes("  task-a: solo primary 0/2 vs codex primary 2/2"), true);
});

test("buildAggregateReport omits the comparison section when only one arm is present", () => {
  const records = [
    completeRecord({ task: "task-a", arm: "solo", repeat: 1 }),
    completeRecord({ task: "task-a", arm: "solo", repeat: 2 })
  ];
  const { lines } = buildAggregateReport(records, { minSamples: 2 });
  assert.equal(lines.includes("Per-task solo vs codex:"), false);
});

// ---------------------------------------------------------------------------
// CLI (spawned, exact-string assertions on stdout — startup-baseline style)
// ---------------------------------------------------------------------------

test("--file with no records prints the floor line and NOTHING WAS VERIFIED, exit 0", () => {
  const dir = makeTempDir("codex-plugin-bench-report-cli-");
  const file = path.join(dir, "records.jsonl");
  const result = runCli(["--file", file]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /No run records found; nothing was verified\./);
  assert.match(result.stdout, /Gate: NOTHING WAS VERIFIED/);
});

test("--file with enough valid records for one cell prints [OK] and Gate: REPORTED, exit 0", () => {
  const dir = makeTempDir("codex-plugin-bench-report-cli-");
  const file = path.join(dir, "records.jsonl");
  appendRecord(file, completeRecord({ task: "task-a", arm: "solo", repeat: 1 }));
  appendRecord(file, completeRecord({ task: "task-a", arm: "solo", repeat: 2 }));

  const result = runCli(["--file", file, "--min-samples", "2"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /\[OK\] task-a::solo/);
  assert.match(result.stdout, /Gate: REPORTED/);
});

test("--tasks-dir feeds each task's originalStrict.caveat into the report", () => {
  const dir = makeTempDir("codex-plugin-bench-report-cli-");
  const file = path.join(dir, "records.jsonl");
  appendRecord(file, completeRecord({ task: "task-a", arm: "solo", repeat: 1 }));
  appendRecord(file, completeRecord({ task: "task-a", arm: "solo", repeat: 2 }));

  const tasksDir = path.join(dir, "tasks");
  const taskDir = path.join(tasksDir, "task-a");
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(
    path.join(taskDir, "manifest.json"),
    JSON.stringify({
      schemaVersion: 1,
      id: "task-a",
      fixSha: "abc1234",
      parentSha: "def5678",
      symptomFile: "symptom.md",
      groundTruth: { tests: [{ from: "g.test.mjs", to: "tests/g.test.mjs" }], fixtures: [] },
      classBonus: null,
      originalStrict: { transplantFromFix: [], excludeTestNames: [], caveat: "CLI-loaded caveat text" },
      regressionSuite: [],
      driftCheckRequired: false,
      timeouts: { claudeMs: 600000, testMs: 120000 },
      budgetUsd: 2,
      forbiddenSymptomStrings: []
    })
  );

  const result = runCli(["--file", file, "--tasks-dir", tasksDir, "--min-samples", "2"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /strict caveat \(task-a\): CLI-loaded caveat text/);
});
