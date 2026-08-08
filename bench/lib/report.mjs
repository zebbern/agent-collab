// The bench run-record JSONL schema: one line per (task, arm, repeat) run,
// appended as it completes so a killed bench leaves a usable partial file
// instead of losing every run since the last save. bench/aggregate.mjs is
// the only reader.
import fs from "node:fs";
import path from "node:path";

export const REPORT_SCHEMA_VERSION = 1;

/**
 * Builds one JSONL record with every contract field present (missing input
 * fields fall back to an honest empty/null shape rather than being omitted,
 * so every record on disk has the same keys regardless of how far the run
 * got before failing).
 */
export function buildRecord(fields = {}) {
  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    runId: fields.runId ?? null,
    task: fields.task ?? null,
    arm: fields.arm ?? null,
    repeat: fields.repeat ?? null,
    parentSha: fields.parentSha ?? null,
    fixSha: fields.fixSha ?? null,
    startedAt: fields.startedAt ?? null,
    finishedAt: fields.finishedAt ?? null,
    status: fields.status ?? null,
    groundTruth: fields.groundTruth ?? { exitCode: null, pass: null },
    classBonus: fields.classBonus ?? null,
    originalStrict: fields.originalStrict ?? { newlyPassing: [], preFailing: [], excluded: [] },
    regression: fields.regression ?? null,
    drift: fields.drift ?? null,
    cleanPass: fields.cleanPass ?? null,
    claude: fields.claude ?? null,
    delegation: fields.delegation ?? { jobs: [], totalTokens: 0 },
    mainRepoDrift: fields.mainRepoDrift ?? null,
    artifactsDir: fields.artifactsDir ?? null
  };
}

/** Appends one record as a JSONL line, creating the parent directory. */
export function appendRecord(file, record) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(record)}\n`, "utf8");
}

/** Reads every record from a JSONL file; a missing file reads as []. */
export function readRecords(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      return [];
    }
    throw error;
  }
  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}
