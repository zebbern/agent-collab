#!/usr/bin/env node
// The resurrection-bench orchestrator. This increment builds everything
// except live `claude` execution:
//
//   --calibrate proves, for every task, that its manifest's ground truth is
//   RED (all failing) at parentSha and GREEN (all passing) at fixSha once
//   originalStrict.transplantFromFix is applied — i.e. that the manifest
//   itself is trustworthy before any agent ever runs against it.
//
//   The live-run path (seed a worktree per arm, invoke claude, score,
//   harvest delegated-job telemetry, append a JSONL record) is designed
//   across bench/lib/{headless,score,telemetry,report}.mjs but this file
//   does not yet spawn `claude` — see the TODO seam in runLive below.
//
// Runs are sequential with a settle window between them (scripts/verify.mjs's
// idiom): the process-spawning legs of this repo's own test suite have shown
// that starting the next spawn immediately after the previous one's workers
// are still exiting measures contention, not correctness.
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { loadManifest } from "./lib/manifest.mjs";
import { createBenchWorktree, removeReviewWorktree, pruneStaleBenchWorktrees } from "./lib/worktree.mjs";
import { transplantFromFix, copyGroundTruth } from "./lib/transplant.mjs";
import { runNodeTest, parseTap, allTestsPass, allTestsFail } from "./lib/score.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_TASKS_DIR = path.join(ROOT, "bench", "tasks");

function settle(seconds = 3) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, seconds * 1000);
}

function getFlagValue(args, flag) {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

function listTaskIds(tasksDir) {
  let entries;
  try {
    entries = fs.readdirSync(tasksDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

// Builds a worktree at `sha`, seeds it via `seed(worktreePath)`, runs the
// manifest's ground-truth test files, and reports the parsed TAP result.
// Every failure path (worktree, seed, or test run) returns `ok: false` with
// a reason instead of throwing, so a single bad task cannot crash the whole
// calibration pass.
function runGroundTruthCheck({ repoRoot, manifest, sha, tmpRoot, keepWorktree, seed }) {
  const worktree = createBenchWorktree(repoRoot, sha, tmpRoot);
  if (!worktree.isolated) {
    return { ok: false, reason: `worktree at ${sha} failed: ${worktree.reason}` };
  }
  try {
    seed(worktree.path);
    const files = (manifest.groundTruth.tests ?? []).map((entry) => entry.to);
    const result = runNodeTest(worktree.path, files, { timeoutMs: manifest.timeouts.testMs });
    if (result.timedOut) {
      return { ok: false, reason: `ground truth run at ${sha} timed out after ${manifest.timeouts.testMs}ms` };
    }
    return { ok: true, exitCode: result.status, tap: parseTap(result.stdout) };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  } finally {
    if (!keepWorktree) {
      removeReviewWorktree(worktree);
    }
  }
}

function calibrateTask({ repoRoot, tasksDir, taskId, tmpRoot, keepWorktree }) {
  const taskDir = path.join(tasksDir, taskId);
  const manifest = loadManifest(taskDir);

  const red = runGroundTruthCheck({
    repoRoot,
    manifest,
    sha: manifest.parentSha,
    tmpRoot,
    keepWorktree,
    seed: (worktreePath) => copyGroundTruth(taskDir, manifest, worktreePath)
  });
  if (!red.ok) {
    return { taskId, redOk: false, greenOk: null, detail: red.reason };
  }
  const redOk = allTestsFail(red.tap);
  const redUnexpectedlyPassing = red.tap.filter((entry) => entry.ok).map((entry) => entry.name);

  const green = runGroundTruthCheck({
    repoRoot,
    manifest,
    sha: manifest.fixSha,
    tmpRoot,
    keepWorktree,
    seed: (worktreePath) => {
      transplantFromFix(repoRoot, manifest.fixSha, manifest.originalStrict.transplantFromFix, worktreePath);
      copyGroundTruth(taskDir, manifest, worktreePath);
    }
  });
  if (!green.ok) {
    return { taskId, redOk, greenOk: false, detail: green.reason, redUnexpectedlyPassing };
  }
  const greenOk = allTestsPass(green.tap);
  const greenUnexpectedlyFailing = green.tap.filter((entry) => !entry.ok).map((entry) => entry.name);

  return { taskId, redOk, greenOk, redUnexpectedlyPassing, greenUnexpectedlyFailing };
}

export function formatCalibrationTable(results) {
  const lines = ["Task calibration (RED at parentSha / GREEN at fixSha):", ""];
  for (const result of results) {
    const red = result.redOk ? "RED" : "red-FAIL";
    const green = result.greenOk === null ? "-" : result.greenOk ? "GREEN" : "green-FAIL";
    lines.push(`  ${result.taskId}: ${red} / ${green}`);
    if (result.redUnexpectedlyPassing?.length) {
      lines.push(`    unexpectedly passing at parentSha: ${result.redUnexpectedlyPassing.join(", ")}`);
    }
    if (result.greenUnexpectedlyFailing?.length) {
      lines.push(`    unexpectedly failing at fixSha: ${result.greenUnexpectedlyFailing.join(", ")}`);
    }
    if (result.detail) {
      lines.push(`    ${result.detail}`);
    }
  }
  return lines;
}

export function determineCalibrationVerdict(results) {
  const allOk = results.length > 0 && results.every((result) => result.redOk && result.greenOk);
  return { verdict: allOk ? "calibrated" : "failed", exitCode: allOk ? 0 : 1 };
}

function runCalibrate(args) {
  const repoRoot = ROOT;
  const tasksDir = getFlagValue(args, "--tasks-dir") ?? DEFAULT_TASKS_DIR;
  const tmpRoot = getFlagValue(args, "--tmp-root");
  const keepWorktree = args.includes("--keep-worktrees");
  const requestedTask = getFlagValue(args, "--task");
  const taskIds = requestedTask ? [requestedTask] : listTaskIds(tasksDir);

  pruneStaleBenchWorktrees(repoRoot, tmpRoot ? { tmpRoot } : {});

  if (taskIds.length === 0) {
    console.log(`No bench tasks found under ${tasksDir}.`);
    process.exit(1);
  }

  const results = [];
  for (const taskId of taskIds) {
    try {
      results.push(calibrateTask({ repoRoot, tasksDir, taskId, tmpRoot, keepWorktree }));
    } catch (error) {
      results.push({ taskId, redOk: false, greenOk: null, detail: error instanceof Error ? error.message : String(error) });
    }
    settle();
  }

  for (const line of formatCalibrationTable(results)) {
    console.log(line);
  }
  console.log("");
  const verdict = determineCalibrationVerdict(results);
  console.log(
    verdict.verdict === "calibrated"
      ? "Gate: CALIBRATED (every task is RED at parentSha and GREEN at fixSha)"
      : "Gate: FAILED — see the task table above for which task and which side"
  );
  process.exit(verdict.exitCode);
}

function runLive() {
  // TODO(increment 2): wire the live-run path in here.
  //   Phase 3: for each (task, arm, repeat) — createBenchWorktree at
  //     manifest.parentSha, copyGroundTruth, and for the "solo" arm also
  //     transplantFromFix(manifest.originalStrict.transplantFromFix) so the
  //     strict comparison is apples-to-apples.
  //   Phase 4: buildArmSettings(arm) -> write to a temp settings file;
  //     buildRunEnv(process.env, { pluginDataDir }) where pluginDataDir is a
  //     fresh fs.mkdtempSync(os.tmpdir()/"codex-plugin-bench-...") per run —
  //     that prefix is in scripts/reap-test-residue.mjs's TEST_DIR_PREFIXES
  //     precisely so a killed live run's telemetry dir gets reaped.
  //   Phase 5: buildClaudeInvocation(...) and actually spawn it (bounded by
  //     manifest.timeouts.claudeMs), capturing stdout for parseClaudeResult.
  //   Phase 6: runNodeTest the ground truth + regressionSuite, parseTap,
  //     newlyPassing against a pre-run baseline TAP capture; if
  //     manifest.driftCheckRequired, capture/diff the REAL repo's working
  //     tree fingerprint around the run (worktree.mjs re-exports the
  //     fingerprint helpers for exactly this).
  //   Phase 7: harvestJobs(pluginDataDir), buildRecord({...}), appendRecord
  //     to --out (default bench/results/records.jsonl).
  console.log("live runs land in increment 2");
  process.exit(1);
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes("--calibrate")) {
    runCalibrate(args);
    return;
  }
  runLive(args);
}

// Only run as a CLI, not when imported by a test.
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main();
}
