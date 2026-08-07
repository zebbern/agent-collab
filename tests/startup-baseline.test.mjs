// The startup baseline/compare regression gate: save-baseline writes the
// expected per-(plugin,transport) median/p90/n; compare is a no-op on
// unchanged data, catches a real regression past BOTH thresholds and names
// the cell, ignores a small regression under the absolute floor, and never
// lets a thin-sample cell fail or silently pass (the honesty floor). Every
// test injects synthetic metrics into an isolated temp workspace — no real
// workspace or real accumulated metrics are ever touched.
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir, run } from "./helpers.mjs";
import { appendStartupMetric as appendCodexStartupMetric } from "../plugins/codex/scripts/lib/state.mjs";
import { appendStartupMetric as appendCursorStartupMetric } from "../plugins/cursor/scripts/lib/state.mjs";
import {
  buildBaselineFromMetrics,
  cellKey,
  compareCells,
  DEFAULT_THRESHOLDS,
  determineCompareVerdict,
  formatCompareReport,
  formatSaveReport,
  groupStartupMetrics,
  loadBaselineFile,
  readCurrentMetrics
} from "../scripts/startup-baseline.mjs";

const SCRIPT = path.resolve("scripts/startup-baseline.mjs");

function seedMetrics(cwd, { codex = [], cursor = [] } = {}) {
  for (const ms of codex) {
    appendCodexStartupMetric(cwd, { kind: "startup", plugin: "codex", transport: "direct", ms });
  }
  for (const ms of cursor) {
    appendCursorStartupMetric(cwd, { kind: "startup", plugin: "cursor", transport: "wsl", ms });
  }
}

function runCli(args, { cwd } = {}) {
  return run(process.execPath, [SCRIPT, ...args], { cwd: cwd ?? process.cwd() });
}

test("groupStartupMetrics filters to finite startup samples and buckets by (plugin, transport)", () => {
  const records = [
    { kind: "startup", plugin: "codex", transport: "direct", ms: 100 },
    { kind: "startup", plugin: "codex", transport: "direct", ms: 200 },
    { kind: "startup", plugin: "cursor", transport: "wsl", ms: 5000 },
    { kind: "startup", plugin: "codex", transport: "direct", ms: Number.NaN }, // dropped: not finite
    { kind: "other", plugin: "codex", transport: "direct", ms: 999 }, // dropped: wrong kind
    { kind: "startup", plugin: "codex", transport: null, ms: 50 } // buckets as "unknown"
  ];
  const byCell = groupStartupMetrics(records);
  assert.deepEqual([...byCell.keys()].sort(), ["codex::direct", "codex::unknown", "cursor::wsl"].sort());
  assert.deepEqual(byCell.get("codex::direct").values, [100, 200]);
  assert.deepEqual(byCell.get("cursor::wsl").values, [5000]);
});

test("buildBaselineFromMetrics computes n/median/p90 matching doctor.mjs's quantile pick", () => {
  // Sorted [100,100,100,100,100,100,100,100,300,500]; median = index floor(0.5*10)=5 -> 100;
  // p90 = index floor(0.9*10)=9 -> 500.
  const values = [100, 100, 100, 100, 100, 100, 100, 100, 300, 500];
  const records = values.map((ms) => ({ kind: "startup", plugin: "codex", transport: "direct", ms }));
  const baseline = buildBaselineFromMetrics(records, { generatedAt: "2026-08-07T00:00:00.000Z" });
  assert.equal(baseline.schemaVersion, 1);
  assert.equal(baseline.generatedAt, "2026-08-07T00:00:00.000Z");
  const cell = baseline.cells[cellKey("codex", "direct")];
  assert.equal(cell.n, 10);
  assert.equal(cell.medianMs, 100);
  assert.equal(cell.p90Ms, 500);
});

test("readCurrentMetrics reads both plugins' state dirs for one workspace, isolated from other workspaces", () => {
  const workspaceA = makeTempDir();
  const workspaceB = makeTempDir();
  seedMetrics(workspaceA, { codex: [100, 200], cursor: [5000] });
  seedMetrics(workspaceB, { codex: [999] });

  const recordsA = readCurrentMetrics(workspaceA);
  assert.equal(recordsA.filter((r) => r.plugin === "codex").length, 2);
  assert.equal(recordsA.filter((r) => r.plugin === "cursor").length, 1);

  const recordsB = readCurrentMetrics(workspaceB);
  assert.equal(recordsB.length, 1);
  assert.equal(recordsB[0].ms, 999);
});

test("--save-baseline writes the expected per-cell stats and prints what it wrote", () => {
  const workspace = makeTempDir();
  const baselineFile = path.join(makeTempDir(), "baseline.json");
  seedMetrics(workspace, {
    codex: [100, 110, 120, 130, 140, 150, 160],
    cursor: [5000, 5200, 5400, 5600, 5800]
  });

  const result = runCli(["--save-baseline", "--cwd", workspace, "--baseline-file", baselineFile]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Wrote startup baseline to/);
  assert.match(result.stdout, /codex::direct: n=7/);
  assert.match(result.stdout, /cursor::wsl: n=5/);

  const written = JSON.parse(fs.readFileSync(baselineFile, "utf8"));
  assert.equal(written.cells["codex::direct"].n, 7);
  assert.equal(written.cells["cursor::wsl"].n, 5);
});

test("--compare on unchanged data exits 0", () => {
  const workspace = makeTempDir();
  const baselineFile = path.join(makeTempDir(), "baseline.json");
  const values = [100, 110, 120, 130, 140, 150, 160];
  seedMetrics(workspace, { codex: values });

  const saved = runCli(["--save-baseline", "--cwd", workspace, "--baseline-file", baselineFile]);
  assert.equal(saved.status, 0, saved.stderr);

  const compared = runCli(["--compare", "--cwd", workspace, "--baseline-file", baselineFile]);
  assert.equal(compared.status, 0, compared.stdout + compared.stderr);
  assert.match(compared.stdout, /\[OK\]\s+codex::direct/);
  assert.match(compared.stdout, /Gate: PASSED/);
});

test("--compare catches a large regression past both thresholds and names the cell", () => {
  const workspace = makeTempDir();
  const baselineFile = path.join(makeTempDir(), "baseline.json");
  // Baseline p90 ~ 200ms.
  seedMetrics(workspace, { codex: [190, 195, 200, 200, 200, 200, 200] });
  const saved = runCli(["--save-baseline", "--cwd", workspace, "--baseline-file", baselineFile]);
  assert.equal(saved.status, 0, saved.stderr);

  // New "current" workspace with a blown-up p90 (~1000ms): +800ms and +400%,
  // clearing both the absolute (250ms) and relative (50%) floors.
  const regressedWorkspace = makeTempDir();
  seedMetrics(regressedWorkspace, { codex: [950, 980, 1000, 1000, 1000, 1000, 1000] });

  const compared = runCli(["--compare", "--cwd", regressedWorkspace, "--baseline-file", baselineFile]);
  assert.equal(compared.status, 1, compared.stdout + compared.stderr);
  assert.match(compared.stdout, /\[REGRESSED\]\s+codex::direct/);
  assert.match(compared.stdout, /Gate: FAILED — regressed past threshold: codex::direct/);
});

test("--compare passes a small regression that stays under the absolute-ms floor", () => {
  const workspace = makeTempDir();
  const baselineFile = path.join(makeTempDir(), "baseline.json");
  // Baseline p90 = 100ms.
  seedMetrics(workspace, { codex: [90, 95, 100, 100, 100, 100, 100] });
  const saved = runCli(["--save-baseline", "--cwd", workspace, "--baseline-file", baselineFile]);
  assert.equal(saved.status, 0, saved.stderr);

  // Current p90 = 170ms: +70ms (under the 250ms absolute floor) even though
  // +70% clears the percentage floor — both conditions must hold, so this
  // must NOT fail the gate.
  const regressedWorkspace = makeTempDir();
  seedMetrics(regressedWorkspace, { codex: [160, 165, 170, 170, 170, 170, 170] });

  const compared = runCli(["--compare", "--cwd", regressedWorkspace, "--baseline-file", baselineFile]);
  assert.equal(compared.status, 0, compared.stdout + compared.stderr);
  assert.match(compared.stdout, /\[OK\]\s+codex::direct/);
  assert.match(compared.stdout, /Gate: PASSED/);
});

test("a cell with fewer than 5 samples is UNCOMPARABLE and cannot fail the gate", () => {
  const baselineCells = { [cellKey("codex", "direct")]: { plugin: "codex", transport: "direct", n: 3, medianMs: 100, p90Ms: 100 } };
  const currentCells = { [cellKey("codex", "direct")]: { plugin: "codex", transport: "direct", n: 3, medianMs: 100000, p90Ms: 100000 } };
  const results = compareCells(baselineCells, currentCells, DEFAULT_THRESHOLDS);
  assert.equal(results.length, 1);
  assert.equal(results[0].status, "uncomparable");
  const verdict = determineCompareVerdict(results);
  assert.equal(verdict.verdict, "nothing-verified");
  assert.equal(verdict.exitCode, 0);
  const report = formatCompareReport(results, DEFAULT_THRESHOLDS).join("\n");
  assert.match(report, /\[UNCOMPARABLE\] codex::direct/);
  assert.match(report, /nothing was verified/);
});

test("a cell missing from current or baseline still reports UNCOMPARABLE (n=0 on the missing side)", () => {
  const baselineCells = { [cellKey("codex", "direct")]: { plugin: "codex", transport: "direct", n: 10, medianMs: 100, p90Ms: 150 } };
  const currentCells = {}; // no current samples for this workspace at all
  const results = compareCells(baselineCells, currentCells, DEFAULT_THRESHOLDS);
  assert.equal(results.length, 1);
  assert.equal(results[0].status, "uncomparable");
  assert.equal(results[0].nCur, 0);
});

test("all-cells-uncomparable prints an explicit nothing-was-verified line and exits 0", () => {
  const workspace = makeTempDir();
  const baselineFile = path.join(makeTempDir(), "baseline.json");
  // Only 2 samples: below the 5-sample floor on both sides.
  seedMetrics(workspace, { codex: [100, 110] });
  const saved = runCli(["--save-baseline", "--cwd", workspace, "--baseline-file", baselineFile]);
  assert.equal(saved.status, 0, saved.stderr);

  const compared = runCli(["--compare", "--cwd", workspace, "--baseline-file", baselineFile]);
  assert.equal(compared.status, 0, compared.stdout + compared.stderr);
  assert.match(compared.stdout, /\[UNCOMPARABLE\]/);
  assert.match(compared.stdout, /nothing was verified/);
  assert.match(compared.stdout, /Gate: NOTHING WAS VERIFIED/);
});

test("--compare with no baseline file and no samples anywhere is graceful: nothing was verified, exit 0", () => {
  const workspace = makeTempDir();
  const baselineFile = path.join(makeTempDir(), "does-not-exist.json");
  const compared = runCli(["--compare", "--cwd", workspace, "--baseline-file", baselineFile]);
  assert.equal(compared.status, 0, compared.stdout + compared.stderr);
  assert.match(compared.stdout, /No baseline file found/);
  assert.match(compared.stdout, /Gate: NOTHING WAS VERIFIED/);
});

test("--compare refuses (exit 1) a malformed baseline file instead of silently treating it as absent", () => {
  const workspace = makeTempDir();
  const baselineFile = path.join(makeTempDir(), "baseline.json");
  fs.writeFileSync(baselineFile, "{ not json");
  const compared = runCli(["--compare", "--cwd", workspace, "--baseline-file", baselineFile]);
  assert.equal(compared.status, 1, compared.stdout + compared.stderr);
  assert.match(compared.stdout, /could not be read as a baseline/);
});

test("loadBaselineFile distinguishes missing, malformed, and ok", () => {
  const dir = makeTempDir();
  const missing = path.join(dir, "missing.json");
  assert.deepEqual(loadBaselineFile(missing), { state: "missing" });

  const malformed = path.join(dir, "malformed.json");
  fs.writeFileSync(malformed, JSON.stringify({ schemaVersion: 1 })); // no "cells"
  assert.equal(loadBaselineFile(malformed).state, "malformed");

  const ok = path.join(dir, "ok.json");
  fs.writeFileSync(ok, JSON.stringify({ schemaVersion: 1, cells: { "codex::direct": { n: 1 } } }));
  const okResult = loadBaselineFile(ok);
  assert.equal(okResult.state, "ok");
  assert.equal(okResult.cells["codex::direct"].n, 1);
});

test("thresholds are overridable via flags and printed in the report", () => {
  const workspace = makeTempDir();
  const baselineFile = path.join(makeTempDir(), "baseline.json");
  seedMetrics(workspace, { codex: [90, 95, 100, 100, 100, 100, 100] });
  const saved = runCli(["--save-baseline", "--cwd", workspace, "--baseline-file", baselineFile]);
  assert.equal(saved.status, 0, saved.stderr);

  // Same +70ms/+70% case as the absolute-floor test above, but now with a
  // tightened 10ms absolute floor: this time it must fail, and the report
  // must reflect the overridden threshold values.
  const regressedWorkspace = makeTempDir();
  seedMetrics(regressedWorkspace, { codex: [160, 165, 170, 170, 170, 170, 170] });
  const compared = runCli([
    "--compare",
    "--cwd", regressedWorkspace,
    "--baseline-file", baselineFile,
    "--p90-regression-pct", "10",
    "--p90-regression-abs-ms", "10"
  ]);
  assert.equal(compared.status, 1, compared.stdout + compared.stderr);
  assert.match(compared.stdout, /exceeds 10% AND 10ms absolute/);
  assert.match(compared.stdout, /\[REGRESSED\]\s+codex::direct/);
});

test("formatSaveReport reports an explicitly empty baseline when there are no samples", () => {
  const baseline = buildBaselineFromMetrics([], { generatedAt: "2026-08-07T00:00:00.000Z" });
  const lines = formatSaveReport(baseline, "/tmp/baseline.json").join("\n");
  assert.match(lines, /baseline is empty/);
});
