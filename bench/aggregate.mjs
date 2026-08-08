#!/usr/bin/env node
// Aggregates bench/results/*.jsonl run records into a per-(task, arm) cell
// report. Mirrors scripts/startup-baseline.mjs's house style deliberately:
// the cellKey idiom, an explicit sample-count floor below which a cell is
// UNCOMPARABLE rather than silently scored, a verdict distinct from the
// process exit code, and an explicit "nothing was verified" line when zero
// cells clear the floor — never an implied pass. Unlike startup-baseline,
// this script does not gate anything (there is no regression threshold to
// violate): it describes the bench results, so it exits 0 whenever it could
// read its input, even when every cell is UNCOMPARABLE.
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { readRecords } from "./lib/report.mjs";
import { loadManifest } from "./lib/manifest.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DEFAULT_RECORDS_FILE = path.join(ROOT, "bench", "results", "records.jsonl");
export const DEFAULT_TASKS_DIR = path.join(ROOT, "bench", "tasks");
export const DEFAULT_MIN_SAMPLES = 2;

export function cellKey(task, arm) {
  return `${task}::${arm}`;
}

function median(values) {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/** Groups run records into { key -> { task, arm, records } } by cellKey. */
export function groupByCell(records) {
  const byCell = new Map();
  for (const record of records) {
    const key = cellKey(record.task, record.arm);
    if (!byCell.has(key)) {
      byCell.set(key, { task: record.task, arm: record.arm, records: [] });
    }
    byCell.get(key).records.push(record);
  }
  return byCell;
}

// A strict pass requires every non-excluded, pre-fix-failing test to have
// newly started passing. Returns null when the record carries no
// originalStrict data to judge (so the caller can exclude it from the strict
// denominator instead of silently scoring it as a failure).
function originalStrictOk(originalStrict) {
  if (!originalStrict || !Array.isArray(originalStrict.preFailing)) {
    return null;
  }
  const excluded = new Set(originalStrict.excluded ?? []);
  const required = originalStrict.preFailing.filter((name) => !excluded.has(name));
  const newlyPassingSet = new Set(originalStrict.newlyPassing ?? []);
  return required.every((name) => newlyPassingSet.has(name));
}

/** Computes one cell's n_valid / invalid-by-reason / k-of-n / median stats. */
export function computeCellStats(cell) {
  const invalidByReason = {};
  let nValid = 0;
  let primaryK = 0;
  let cleanK = 0;
  let cleanN = 0;
  let strictK = 0;
  let strictN = 0;
  const durations = [];
  const costs = [];
  for (const record of cell.records) {
    if (record.status !== "complete") {
      const reason = record.status ?? "unknown";
      invalidByReason[reason] = (invalidByReason[reason] ?? 0) + 1;
      continue;
    }
    nValid += 1;
    if (record.groundTruth?.pass === true) {
      primaryK += 1;
    }
    if (typeof record.cleanPass === "boolean") {
      cleanN += 1;
      if (record.cleanPass) {
        cleanK += 1;
      }
    }
    const strictOk = originalStrictOk(record.originalStrict);
    if (strictOk !== null) {
      strictN += 1;
      if (strictOk) {
        strictK += 1;
      }
    }
    if (typeof record.claude?.durationMs === "number") {
      durations.push(record.claude.durationMs);
    }
    if (typeof record.claude?.totalCostUsd === "number") {
      costs.push(record.claude.totalCostUsd);
    }
  }
  return {
    task: cell.task,
    arm: cell.arm,
    n: cell.records.length,
    nValid,
    invalidByReason,
    primaryK,
    primaryN: nValid,
    cleanK,
    cleanN,
    strictK,
    strictN,
    medianDurationMs: median(durations),
    medianCostUsd: median(costs)
  };
}

function formatInvalidByReason(invalidByReason) {
  const entries = Object.entries(invalidByReason);
  if (entries.length === 0) {
    return "0 invalid";
  }
  return entries
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([reason, count]) => `${count} ${reason}`)
    .join(", ");
}

function formatFraction(k, n) {
  return n === 0 ? "n/a" : `${k}/${n}`;
}

export function formatCellLine(stats) {
  return (
    `${cellKey(stats.task, stats.arm)}: n=${stats.n} valid=${stats.nValid} (${formatInvalidByReason(stats.invalidByReason)}), ` +
    `primary ${formatFraction(stats.primaryK, stats.primaryN)}, clean ${formatFraction(stats.cleanK, stats.cleanN)}, ` +
    `strict ${formatFraction(stats.strictK, stats.strictN)}, median duration ${stats.medianDurationMs ?? "n/a"}ms, ` +
    `median cost $${stats.medianCostUsd ?? "n/a"}`
  );
}

function buildVerdict(cellStats, minSamples) {
  const comparable = cellStats.filter((stats) => stats.nValid >= minSamples);
  if (comparable.length === 0) {
    return { verdict: "nothing-verified", exitCode: 0 };
  }
  return { verdict: "reported", exitCode: 0 };
}

/**
 * Builds the full report: threshold line, one line per cell (UNCOMPARABLE
 * below minSamples, otherwise the full stat line with its manifest caveat
 * printed directly under it), a per-task solo-vs-codex comparison section
 * when both arms are present, and a verdict distinct from the exit code.
 */
export function buildAggregateReport(records, { minSamples = DEFAULT_MIN_SAMPLES, caveats = new Map() } = {}) {
  const byCell = groupByCell(records);
  const cellStats = [...byCell.keys()].sort().map((key) => computeCellStats(byCell.get(key)));

  const lines = [
    `Threshold: a cell's primary/clean/strict fractions are reported only when it has >= ${minSamples} valid ` +
      `(status "complete") run(s). Cells below that floor are UNCOMPARABLE.`,
    ""
  ];

  if (cellStats.length === 0) {
    lines.push("No run records found; nothing was verified.");
    return { lines, cells: [], verdict: buildVerdict([], minSamples) };
  }

  for (const stats of cellStats) {
    if (stats.nValid < minSamples) {
      lines.push(`[UNCOMPARABLE] ${cellKey(stats.task, stats.arm)}: n=${stats.n} valid=${stats.nValid} (below the ${minSamples}-sample floor)`);
      continue;
    }
    lines.push(`[OK] ${formatCellLine(stats)}`);
    const caveat = caveats.get(stats.task);
    if (caveat) {
      lines.push(`  strict caveat (${stats.task}): ${caveat}`);
    }
  }

  const byTask = new Map();
  for (const stats of cellStats) {
    if (!byTask.has(stats.task)) {
      byTask.set(stats.task, {});
    }
    byTask.get(stats.task)[stats.arm] = stats;
  }
  const comparisonLines = [];
  for (const [task, arms] of [...byTask].sort(([a], [b]) => a.localeCompare(b))) {
    if (!arms.solo || !arms.codex) {
      continue;
    }
    comparisonLines.push(
      `${task}: solo primary ${formatFraction(arms.solo.primaryK, arms.solo.primaryN)} vs ` +
        `codex primary ${formatFraction(arms.codex.primaryK, arms.codex.primaryN)}`
    );
  }
  if (comparisonLines.length > 0) {
    lines.push("");
    lines.push("Per-task solo vs codex:");
    lines.push(...comparisonLines.map((line) => `  ${line}`));
  }

  const verdict = buildVerdict(cellStats, minSamples);
  lines.push("");
  if (verdict.verdict === "nothing-verified") {
    lines.push("Every cell was UNCOMPARABLE; nothing was verified.");
  }
  return { lines, cells: cellStats, verdict };
}

function loadCaveats(tasksDir) {
  const caveats = new Map();
  let entries = [];
  try {
    entries = fs.readdirSync(tasksDir, { withFileTypes: true });
  } catch {
    return caveats;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    try {
      const manifest = loadManifest(path.join(tasksDir, entry.name));
      if (manifest.originalStrict?.caveat) {
        caveats.set(entry.name, manifest.originalStrict.caveat);
      }
    } catch {
      // A task without a valid manifest yet contributes no caveat; the
      // manifest's own validation failure is that task's problem to report.
    }
  }
  return caveats;
}

function getFlagValue(args, flag) {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

function main() {
  const args = process.argv.slice(2);
  const file = getFlagValue(args, "--file") ?? DEFAULT_RECORDS_FILE;
  const tasksDir = getFlagValue(args, "--tasks-dir") ?? DEFAULT_TASKS_DIR;
  const minSamples = Number(getFlagValue(args, "--min-samples") ?? DEFAULT_MIN_SAMPLES);

  const records = readRecords(file);
  const caveats = loadCaveats(tasksDir);
  const { lines, verdict } = buildAggregateReport(records, { minSamples, caveats });

  for (const line of lines) {
    console.log(line);
  }
  console.log("");
  if (verdict.verdict === "nothing-verified") {
    console.log("Gate: NOTHING WAS VERIFIED — no cell had >= min-samples valid runs.");
  } else {
    console.log("Gate: REPORTED (aggregate.mjs describes the bench results; it does not pass/fail).");
  }
  process.exit(verdict.exitCode);
}

// Only run as a CLI, not when imported by the test.
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main();
}
