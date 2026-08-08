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
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { loadManifest } from "./lib/manifest.mjs";
import {
  createBenchWorktree,
  removeReviewWorktree,
  pruneStaleBenchWorktrees,
  captureWorkingTreeFingerprintSafe,
  detectWorkspaceDrift
} from "./lib/worktree.mjs";
import { transplantFromFix, copyGroundTruth, removeTransplants } from "./lib/transplant.mjs";
import { runNodeTest, parseTap, allTestsPass, allTestsFail, newlyPassing } from "./lib/score.mjs";
import { buildArmSettings, buildClaudeInvocation, buildRunEnv, parseClaudeResult } from "./lib/headless.mjs";
import { harvestJobs } from "./lib/telemetry.mjs";
import { buildRecord, appendRecord, readRecords } from "./lib/report.mjs";

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

// ---------------------------------------------------------------------------
// Live-run path (increment 2). One (task, arm, repeat) at a time, strictly
// sequential, every phase's outcome recorded — an invalid run is a JSONL
// record with a reason, never a crash of the matrix.
// ---------------------------------------------------------------------------

function runSuiteAt(worktreePath, files, timeoutMs, env) {
  // env is mandatory for live runs: the parent-era suites predate the
  // hermeticity fixes (PR #35), so run with inherited env they absorb the
  // live session's CLAUDE_PLUGIN_DATA/session vars and fail for reasons that
  // have nothing to do with the agent's fix — the smoke run caught exactly
  // this on its first invocation.
  const result = runNodeTest(worktreePath, files, { timeoutMs, env });
  return { status: result.status, timedOut: result.timedOut === true, tap: parseTap(result.stdout ?? "") };
}

function spawnHeadlessClaude({ worktreePath, prompt, env, argsList, timeoutMs }) {
  // shell:true so the npm "claude" shim resolves on Windows; every argv token
  // is a flag or a space-free temp path, and the prompt rides STDIN — the
  // only join-hazardous string never touches the command line.
  const result = spawnSync("claude", argsList, {
    cwd: worktreePath,
    env,
    input: prompt,
    encoding: "utf8",
    timeout: timeoutMs,
    killSignal: "SIGKILL",
    shell: true,
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024
  });
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    timedOut: result.error?.code === "ETIMEDOUT",
    spawnError: result.error && result.error.code !== "ETIMEDOUT" ? result.error.message : null,
    exitCode: result.status
  };
}

function executeLiveRun({ repoRoot, tasksDir, taskId, arm, repeat, tmpRoot, keepWorktree, outDir }) {
  const taskDir = path.join(tasksDir, taskId);
  const manifest = loadManifest(taskDir);
  const runId = `${taskId}__${arm}__r${repeat}`;
  const startedAt = new Date().toISOString();
  const artifactsDir = path.join(outDir, "raw", runId);
  fs.mkdirSync(artifactsDir, { recursive: true });

  const groundTruthFiles = (manifest.groundTruth.tests ?? []).map((entry) => entry.to);
  const classBonusFiles = (manifest.classBonus?.tests ?? []).map((entry) => entry.to);

  const record = {
    runId, task: taskId, arm, repeat,
    parentSha: manifest.parentSha, fixSha: manifest.fixSha,
    startedAt, artifactsDir
  };

  const worktree = createBenchWorktree(repoRoot, manifest.parentSha, tmpRoot);
  if (!worktree.isolated) {
    return { ...record, status: "harness-error", detail: `worktree failed: ${worktree.reason}`, finishedAt: new Date().toISOString() };
  }

  const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-plugin-bench-run-"));
  // Test-phase isolation dir is DISTINCT from the claude run's plugin-data dir:
  // parent-era suites write real state/job files, and the telemetry harvest
  // must only ever see jobs the AGENT's delegations created.
  const testDataDir = path.join(scratchRoot, "test-data");
  fs.mkdirSync(testDataDir, { recursive: true });
  const testEnv = buildRunEnv(process.env, { pluginDataDir: testDataDir });
  try {
    // Phase 2a: ground truth must be RED before the agent ever runs.
    copyGroundTruth(taskDir, manifest, worktree.path);
    const preGt = runSuiteAt(worktree.path, groundTruthFiles, manifest.timeouts.testMs, testEnv);
    if (!allTestsFail(preGt.tap)) {
      return { ...record, status: "invalid-red", detail: "ground truth did not fully fail at parentSha", finishedAt: new Date().toISOString() };
    }
    // Phase 2b: the parent's OWN regression suite must be green (before any
    // fix-era transplant, which by design contains failing-at-parent tests).
    const baseline = runSuiteAt(worktree.path, manifest.regressionSuite, manifest.timeouts.testMs, testEnv);
    if (baseline.status !== 0) {
      return { ...record, status: "invalid-baseline", detail: "parent regression suite not green pre-run", finishedAt: new Date().toISOString() };
    }
    // Phase 2c: originals from the fix, pre-fix TAP baseline for newlyPassing.
    transplantFromFix(repoRoot, manifest.fixSha, manifest.originalStrict.transplantFromFix, worktree.path);
    const preOriginals = runSuiteAt(worktree.path, manifest.originalStrict.transplantFromFix, manifest.timeouts.testMs, testEnv);
    fs.writeFileSync(path.join(artifactsDir, "pre.tap.json"), JSON.stringify(preOriginals.tap, null, 2));

    // Phase 3: the agent must never see the ground truth or the fix-era tests.
    removeTransplants(worktree.path, manifest);

    // Phase 4: the headless run.
    const settingsFile = path.join(scratchRoot, "arm-settings.json");
    fs.writeFileSync(settingsFile, JSON.stringify(buildArmSettings(arm), null, 2));
    const pluginDataDir = path.join(scratchRoot, "plugin-data");
    fs.mkdirSync(pluginDataDir, { recursive: true });
    const env = buildRunEnv(process.env, { pluginDataDir });
    const prompt = fs.readFileSync(path.join(taskDir, manifest.symptomFile), "utf8");
    const invocation = buildClaudeInvocation({
      armSettingsFile: settingsFile,
      prompt,
      budgetUsd: manifest.budgetUsd,
      promptViaStdin: true
    });
    const mainBefore = captureWorkingTreeFingerprintSafe(repoRoot);
    const live = spawnHeadlessClaude({
      worktreePath: worktree.path,
      prompt,
      env,
      argsList: invocation.args,
      timeoutMs: manifest.timeouts.claudeMs
    });
    fs.writeFileSync(path.join(artifactsDir, "claude-output.json"), live.stdout || "");
    fs.writeFileSync(path.join(artifactsDir, "claude-stderr.txt"), live.stderr || "");
    const mainAfter = captureWorkingTreeFingerprintSafe(repoRoot);
    const mainRepoDrift = detectWorkspaceDrift(mainBefore, mainAfter);
    record.mainRepoDrift = mainRepoDrift?.changed?.length ? mainRepoDrift.changed : [];

    if (live.spawnError) {
      return { ...record, status: "harness-error", detail: `claude spawn failed: ${live.spawnError}`, finishedAt: new Date().toISOString() };
    }
    const claude = live.timedOut
      ? { totalCostUsd: null, costMeasurable: false, numTurns: null, durationMs: manifest.timeouts.claudeMs, isError: true }
      : parseClaudeResult(live.stdout);
    if (claude.status === "harness-error") {
      return { ...record, status: "harness-error", detail: claude.detail, finishedAt: new Date().toISOString(), claude: null };
    }
    record.claude = {
      totalCostUsd: claude.totalCostUsd, costMeasurable: claude.costMeasurable,
      numTurns: claude.numTurns, durationMs: claude.durationMs, isError: claude.isError
    };

    // Phase 5: score. Diff artifact first, then fresh transplants (overwrites
    // any agent tampering with test files), then the mechanical verdicts.
    const diff = spawnSync("git", ["-C", worktree.path, "diff"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    fs.writeFileSync(path.join(artifactsDir, "worktree.patch"), diff.stdout ?? "");
    copyGroundTruth(taskDir, manifest, worktree.path);
    transplantFromFix(repoRoot, manifest.fixSha, manifest.originalStrict.transplantFromFix, worktree.path);

    const gt = runSuiteAt(worktree.path, groundTruthFiles, manifest.timeouts.testMs, testEnv);
    record.groundTruth = { exitCode: gt.status, pass: gt.status === 0 && allTestsPass(gt.tap) };
    if (classBonusFiles.length > 0) {
      const bonus = runSuiteAt(worktree.path, classBonusFiles, manifest.timeouts.testMs, testEnv);
      record.classBonus = bonus.status === 0 && allTestsPass(bonus.tap);
    } else {
      record.classBonus = null;
    }
    const postOriginals = runSuiteAt(worktree.path, manifest.originalStrict.transplantFromFix, manifest.timeouts.testMs, testEnv);
    fs.writeFileSync(path.join(artifactsDir, "post.tap.json"), JSON.stringify(postOriginals.tap, null, 2));
    const gained = newlyPassing(preOriginals.tap, postOriginals.tap)
      .filter((name) => !(manifest.originalStrict.excludeTestNames ?? []).includes(name));
    const preFailing = preOriginals.tap
      .filter((entry) => !entry.ok)
      .map((entry) => entry.name)
      .filter((name) => !(manifest.originalStrict.excludeTestNames ?? []).includes(name));
    record.originalStrict = { newlyPassing: gained, preFailing, excluded: manifest.originalStrict.excludeTestNames ?? [] };
    let regression = runSuiteAt(worktree.path, manifest.regressionSuite, manifest.timeouts.testMs, testEnv);
    record.regressionRetried = false;
    if (regression.status !== 0) {
      // The parent-era suites carry the documented load-flaky contention
      // tests (AGENTS.md), and this scoring run starts right after a heavy
      // multi-minute claude session. One retry after a settle distinguishes
      // a load flake from real agent-caused breakage; the retry is recorded,
      // never silent, and both TAPs land in the artifacts.
      fs.writeFileSync(path.join(artifactsDir, "regression-first.tap.json"), JSON.stringify(regression.tap, null, 2));
      settle();
      regression = runSuiteAt(worktree.path, manifest.regressionSuite, manifest.timeouts.testMs, testEnv);
      record.regressionRetried = true;
    }
    fs.writeFileSync(path.join(artifactsDir, "regression.tap.json"), JSON.stringify(regression.tap, null, 2));
    record.regression = regression.status === 0;
    record.drift = manifest.driftCheckRequired
      ? runSuiteAt(worktree.path, ["tests/chassis-drift.test.mjs"], manifest.timeouts.testMs, testEnv).status === 0
      : null;
    record.cleanPass = Boolean(record.groundTruth.pass && record.regression && (record.drift === null || record.drift));

    // Phase 6: telemetry + the arm-validity check. harvestJobs returns
    // { jobs, totalTokens } — the smoke run caught this shape being misread.
    const harvest = harvestJobs(pluginDataDir);
    record.delegation = harvest;
    if (live.timedOut) {
      return { ...record, status: "timeout", finishedAt: new Date().toISOString() };
    }
    if (arm === "solo" && harvest.jobs.length > 0) {
      return { ...record, status: "invalid-arm-leak", detail: `solo arm harvested ${harvest.jobs.length} delegated job(s); plugin gating failed`, finishedAt: new Date().toISOString() };
    }
    return { ...record, status: "complete", finishedAt: new Date().toISOString() };
  } catch (error) {
    return { ...record, status: "harness-error", detail: error instanceof Error ? error.message : String(error), finishedAt: new Date().toISOString() };
  } finally {
    if (!keepWorktree) {
      removeReviewWorktree(worktree);
    }
    fs.rmSync(scratchRoot, { recursive: true, force: true });
  }
}

function runLive(args) {
  const repoRoot = ROOT;
  const tasksDir = getFlagValue(args, "--tasks-dir") ?? DEFAULT_TASKS_DIR;
  const tmpRoot = getFlagValue(args, "--tmp-root");
  const keepWorktree = args.includes("--keep-worktrees");
  const outDir = getFlagValue(args, "--out") ?? path.join(ROOT, "bench", "results");
  const smoke = args.includes("--smoke");
  const resume = args.includes("--resume");

  const taskIds = smoke
    ? ["d3-eperm-rename"]
    : getFlagValue(args, "--task")
      ? [getFlagValue(args, "--task")]
      : listTaskIds(tasksDir);
  const arms = smoke ? ["solo"] : (getFlagValue(args, "--arms") ?? "solo,codex").split(",").map((entry) => entry.trim());
  const repeats = smoke ? 1 : Number(getFlagValue(args, "--repeats") ?? 3);

  fs.mkdirSync(outDir, { recursive: true });
  const recordsFile = path.join(outDir, "records.jsonl");
  const done = new Set(resume ? readRecords(recordsFile).map((entry) => entry.runId) : []);

  pruneStaleBenchWorktrees(repoRoot, tmpRoot ? { tmpRoot } : {});

  let ran = 0;
  for (const taskId of taskIds) {
    for (const arm of arms) {
      for (let repeat = 1; repeat <= repeats; repeat += 1) {
        const runId = `${taskId}__${arm}__r${repeat}`;
        if (done.has(runId)) {
          console.log(`[skip] ${runId} (already recorded)`);
          continue;
        }
        console.log(`[run ] ${runId} ...`);
        const outcome = executeLiveRun({ repoRoot, tasksDir, taskId, arm, repeat, tmpRoot, keepWorktree, outDir });
        appendRecord(recordsFile, buildRecord(outcome));
        console.log(`[done] ${runId}: ${outcome.status}${outcome.detail ? ` (${outcome.detail})` : ""}${outcome.groundTruth ? ` groundTruth=${outcome.groundTruth.pass}` : ""}`);
        ran += 1;
        settle();
      }
    }
  }
  console.log(`\n${ran} run(s) recorded to ${recordsFile}. Aggregate with: node bench/aggregate.mjs --results ${outDir}`);
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
