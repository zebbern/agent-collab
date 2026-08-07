#!/usr/bin/env node
// Turns the accumulated spawn->ready startup metrics (ADR 0004's data
// corpus, `appendStartupMetric`/`readStartupMetrics` in both plugins'
// state.mjs) into a baseline/compare regression gate. See ADR 0008 for why
// this exists and why it is opt-in rather than part of `npm run verify`.
//
// Usage:
//   node scripts/startup-baseline.mjs --save-baseline [--cwd DIR] [--baseline-file FILE]
//   node scripts/startup-baseline.mjs --compare [--cwd DIR] [--baseline-file FILE]
//       [--p90-regression-pct N] [--p90-regression-abs-ms N] [--min-samples N]
//
// Stats vocabulary is deliberately the same one plugins/*/scripts/lib/doctor.mjs's
// buildStartupOverheadCheck already renders (n / median / p90, same quantile
// pick) so a person reading `/codex:doctor` output and this gate's output is
// reading the same numbers, not two dialects of "the p90".
//
// Honesty floor: a (plugin, transport) cell compares only when BOTH the
// baseline and the current run have at least --min-samples (default 5)
// samples. Anything short of that is reported UNCOMPARABLE and can never
// fail or silently pass the gate. If nothing is comparable, the report says
// so in plain words and exits 0 — never a silent, implied pass.
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { readStartupMetrics as readCodexStartupMetrics } from "../plugins/codex/scripts/lib/state.mjs";
import { readStartupMetrics as readCursorStartupMetrics } from "../plugins/cursor/scripts/lib/state.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DEFAULT_BASELINE_FILE = path.join(ROOT, "docs", "startup-baseline.json");
export const BASELINE_SCHEMA_VERSION = 1;

export const DEFAULT_THRESHOLDS = {
  p90RegressionPct: 50,
  p90RegressionAbsMs: 250,
  minSamples: 5
};

// Reads both plugins' durable metrics for one workspace. Each record already
// carries its own `plugin` field (set at the appendStartupMetric call site in
// codex.mjs / cursor.mjs), so concatenation is enough — no re-tagging needed.
export function readCurrentMetrics(cwd) {
  return [...readCodexStartupMetrics(cwd), ...readCursorStartupMetrics(cwd)];
}

// Same quantile pick as doctor.mjs's buildStartupOverheadCheck: the value at
// floor(q * n) in the sorted sample, clamped to the last index. Kept here as
// an inlined mirror (doctor.mjs does not export it) rather than a second,
// diverging definition of "the p90".
function quantile(sortedValues, q) {
  return sortedValues[Math.min(sortedValues.length - 1, Math.floor(q * sortedValues.length))];
}

export function cellKey(plugin, transport) {
  return `${plugin ?? "unknown"}::${transport ?? "unknown"}`;
}

// Groups raw metric records (as returned by readStartupMetrics /
// readCurrentMetrics) into { key -> { plugin, transport, values: number[] } },
// filtering to startup samples with a finite ms exactly like
// buildStartupOverheadCheck does.
export function groupStartupMetrics(records) {
  const byCell = new Map();
  for (const record of records ?? []) {
    if (record?.kind !== "startup" || !Number.isFinite(record.ms)) {
      continue;
    }
    const plugin = record.plugin ?? "unknown";
    const transport = record.transport ?? "unknown";
    const key = cellKey(plugin, transport);
    if (!byCell.has(key)) {
      byCell.set(key, { plugin, transport, values: [] });
    }
    byCell.get(key).values.push(record.ms);
  }
  return byCell;
}

function computeCellStats(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    n: sorted.length,
    medianMs: Math.round(quantile(sorted, 0.5)),
    p90Ms: Math.round(quantile(sorted, 0.9))
  };
}

// Builds the { schemaVersion, generatedAt, cells } shape both the baseline
// file and an in-memory "current" snapshot share.
export function buildBaselineFromMetrics(records, { generatedAt } = {}) {
  const byCell = groupStartupMetrics(records);
  const cells = {};
  for (const [key, { plugin, transport, values }] of byCell) {
    cells[key] = { plugin, transport, ...computeCellStats(values) };
  }
  return {
    schemaVersion: BASELINE_SCHEMA_VERSION,
    generatedAt: generatedAt ?? new Date().toISOString(),
    cells
  };
}

export function formatSaveReport(baseline, baselineFile) {
  const lines = [`Wrote startup baseline to ${baselineFile}`, `generatedAt: ${baseline.generatedAt}`];
  const keys = Object.keys(baseline.cells).sort();
  if (keys.length === 0) {
    lines.push("No startup samples found in either plugin's state dir for this workspace; baseline is empty.");
    return lines;
  }
  for (const key of keys) {
    const cell = baseline.cells[key];
    lines.push(`  ${key}: n=${cell.n}, median ${cell.medianMs}ms, p90 ${cell.p90Ms}ms`);
  }
  return lines;
}

// Four-state baseline-file read, same doctrine as doctor.mjs's plugin
// registry read: missing is a legitimate first-run state, but unreadable or
// malformed must be described, never silently treated as "no baseline".
export function loadBaselineFile(baselineFile) {
  let raw;
  try {
    raw = fs.readFileSync(baselineFile, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { state: "missing" };
    }
    return { state: "unreadable", detail: error instanceof Error ? error.message : String(error) };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { state: "malformed", detail: error instanceof Error ? error.message : String(error) };
  }
  if (!parsed || typeof parsed.cells !== "object" || parsed.cells === null || Array.isArray(parsed.cells)) {
    return { state: "malformed", detail: 'no "cells" object' };
  }
  return { state: "ok", cells: parsed.cells };
}

// Compares two { key -> {plugin, transport, n, medianMs, p90Ms} } cell maps.
// A cell missing from either side reads as n=0 on that side, which the
// minSamples floor then correctly routes to "uncomparable" — no special
// casing needed for "new cell" / "cell disappeared".
export function compareCells(baselineCells, currentCells, thresholds = DEFAULT_THRESHOLDS) {
  const keys = new Set([...Object.keys(baselineCells ?? {}), ...Object.keys(currentCells ?? {})]);
  const results = [];
  for (const key of [...keys].sort()) {
    const base = baselineCells?.[key];
    const cur = currentCells?.[key];
    const nBase = base?.n ?? 0;
    const nCur = cur?.n ?? 0;
    const plugin = cur?.plugin ?? base?.plugin;
    const transport = cur?.transport ?? base?.transport;
    if (nBase < thresholds.minSamples || nCur < thresholds.minSamples) {
      results.push({ key, plugin, transport, status: "uncomparable", nBase, nCur });
      continue;
    }
    const deltaMs = cur.p90Ms - base.p90Ms;
    const deltaPct = base.p90Ms === 0 ? (deltaMs === 0 ? 0 : Infinity) : (deltaMs / base.p90Ms) * 100;
    const regressed = deltaMs > thresholds.p90RegressionAbsMs && deltaPct > thresholds.p90RegressionPct;
    results.push({
      key,
      plugin,
      transport,
      status: regressed ? "regressed" : "ok",
      nBase,
      nCur,
      baseMedianMs: base.medianMs,
      curMedianMs: cur.medianMs,
      baseP90Ms: base.p90Ms,
      curP90Ms: cur.p90Ms,
      deltaMs,
      deltaPct
    });
  }
  return results;
}

function signed(n) {
  return n >= 0 ? `+${n}` : `${n}`;
}

export function formatCompareReport(results, thresholds = DEFAULT_THRESHOLDS) {
  const lines = [
    `Threshold: p90 regression is flagged only when it exceeds ${thresholds.p90RegressionPct}% AND ` +
      `${thresholds.p90RegressionAbsMs}ms absolute (both conditions must hold). Cells with fewer than ` +
      `${thresholds.minSamples} samples in baseline or current are UNCOMPARABLE.`,
    ""
  ];
  if (results.length === 0) {
    lines.push("No (plugin, transport) cell found in the baseline or the current metrics; nothing was verified.");
    return lines;
  }
  for (const r of results) {
    if (r.status === "uncomparable") {
      lines.push(`[UNCOMPARABLE] ${r.key}: n_baseline=${r.nBase}, n_current=${r.nCur} (below the ${thresholds.minSamples}-sample floor)`);
      continue;
    }
    const marker = r.status === "regressed" ? "[REGRESSED]  " : "[OK]         ";
    lines.push(
      `${marker} ${r.key}: p90 ${r.baseP90Ms}ms -> ${r.curP90Ms}ms (${signed(r.deltaMs)}ms, ${r.deltaPct.toFixed(1)}%), ` +
        `median ${r.baseMedianMs}ms -> ${r.curMedianMs}ms, n ${r.nBase}->${r.nCur}`
    );
  }
  const comparable = results.filter((r) => r.status !== "uncomparable");
  if (comparable.length === 0) {
    lines.push("");
    lines.push("Every cell was UNCOMPARABLE; nothing was verified.");
  }
  return lines;
}

// Verdict is distinct from a plain exit code so the CLI can print "nothing
// was verified" instead of a misleading "PASSED" when zero cells qualified.
export function determineCompareVerdict(results) {
  const comparable = results.filter((r) => r.status !== "uncomparable");
  if (comparable.length === 0) {
    return { verdict: "nothing-verified", exitCode: 0 };
  }
  const regressed = comparable.filter((r) => r.status === "regressed");
  if (regressed.length > 0) {
    return { verdict: "failed", exitCode: 1, regressedKeys: regressed.map((r) => r.key) };
  }
  return { verdict: "passed", exitCode: 0 };
}

function getFlagValue(args, flag) {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

function parseThresholds(args) {
  return {
    p90RegressionPct: Number(getFlagValue(args, "--p90-regression-pct") ?? DEFAULT_THRESHOLDS.p90RegressionPct),
    p90RegressionAbsMs: Number(getFlagValue(args, "--p90-regression-abs-ms") ?? DEFAULT_THRESHOLDS.p90RegressionAbsMs),
    minSamples: Number(getFlagValue(args, "--min-samples") ?? DEFAULT_THRESHOLDS.minSamples)
  };
}

function runSave(args) {
  const cwd = getFlagValue(args, "--cwd") ?? process.cwd();
  const baselineFile = getFlagValue(args, "--baseline-file") ?? DEFAULT_BASELINE_FILE;
  const baseline = buildBaselineFromMetrics(readCurrentMetrics(cwd));
  fs.mkdirSync(path.dirname(baselineFile), { recursive: true });
  fs.writeFileSync(baselineFile, `${JSON.stringify(baseline, null, 2)}\n`, "utf8");
  for (const line of formatSaveReport(baseline, baselineFile)) {
    console.log(line);
  }
  process.exit(0);
}

function runCompare(args) {
  const cwd = getFlagValue(args, "--cwd") ?? process.cwd();
  const baselineFile = getFlagValue(args, "--baseline-file") ?? DEFAULT_BASELINE_FILE;
  const thresholds = parseThresholds(args);

  const baselineResult = loadBaselineFile(baselineFile);
  if (baselineResult.state === "unreadable" || baselineResult.state === "malformed") {
    console.log(
      `Baseline file ${baselineFile} could not be read as a baseline (${baselineResult.detail}); ` +
        "refusing to compare — regenerate it with `npm run startup:baseline`."
    );
    process.exit(1);
  }
  if (baselineResult.state === "missing") {
    console.log(`No baseline file found at ${baselineFile}; run \`npm run startup:baseline\` first.`);
    console.log("");
  }
  const baselineCells = baselineResult.state === "ok" ? baselineResult.cells : {};
  const currentCells = buildBaselineFromMetrics(readCurrentMetrics(cwd)).cells;
  const results = compareCells(baselineCells, currentCells, thresholds);

  for (const line of formatCompareReport(results, thresholds)) {
    console.log(line);
  }

  const verdict = determineCompareVerdict(results);
  console.log("");
  if (verdict.verdict === "nothing-verified") {
    console.log("Gate: NOTHING WAS VERIFIED — no cell had >= min-samples in both the baseline and the current run.");
  } else if (verdict.verdict === "failed") {
    console.log(`Gate: FAILED — regressed past threshold: ${verdict.regressedKeys.join(", ")}`);
  } else {
    console.log("Gate: PASSED (every comparable cell stayed within threshold)");
  }
  process.exit(verdict.exitCode);
}

function main() {
  const args = process.argv.slice(2);
  const wantsSave = args.includes("--save-baseline");
  const wantsCompare = args.includes("--compare");
  if (wantsSave === wantsCompare) {
    console.error("Usage: node scripts/startup-baseline.mjs --save-baseline | --compare [options]");
    process.exit(1);
  }
  if (wantsSave) {
    runSave(args);
  } else {
    runCompare(args);
  }
}

// Only run as a CLI, not when imported by the test.
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main();
}
