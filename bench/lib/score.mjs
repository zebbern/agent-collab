// Scoring primitives: run a worktree's node:test suite, parse its TAP
// output, and diff two TAP runs to find what newly started passing.
import { spawnSync } from "node:child_process";
import process from "node:process";

// The full state space a single arm/repeat run can land in. "complete" is the
// only status an aggregate report treats as a valid sample — every other
// value is a specific, honestly-named reason the run cannot be scored, never
// silently folded into a pass or a fail.
export const RUN_STATUSES = ["complete", "invalid-red", "invalid-baseline", "timeout", "invalid-arm-leak", "harness-error"];

/**
 * Runs `node --test [--test-reporter=tap] <files>` inside `worktreePath`.
 * Returns the raw process result plus a `timedOut` flag — spawnSync's
 * `timeout` option kills the process and reports it via `signal`, not
 * `status`, so a caller checking `status !== 0` alone would misreport a
 * timeout as an ordinary test failure.
 */
export function runNodeTest(worktreePath, files, { env, timeoutMs, tap = true } = {}) {
  const args = ["--test"];
  if (tap) {
    args.push("--test-reporter=tap");
  }
  args.push(...(files ?? []));
  const result = spawnSync(process.execPath, args, {
    cwd: worktreePath,
    env: env ?? process.env,
    encoding: "utf8",
    timeout: timeoutMs,
    windowsHide: true
  });
  const timedOut = Boolean(timeoutMs) && result.status === null && result.signal != null;
  return {
    status: result.status,
    signal: result.signal,
    timedOut,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error ?? null
  };
}

// Matches TAP result lines at any nesting depth, e.g. "ok 1 - name" or
// "not ok 2 - name # SKIP reason". Node's --test-reporter=tap emits a
// "TAP version 13" header, "# Subtest: <file>" lines, and a top-level
// "ok N - <file>" line per file alongside each individual assertion's own
// "ok"/"not ok" line — all of those match this same shape, so callers that
// want per-test granularity should pass matching file lists rather than
// relying on this to disambiguate depth.
const TAP_RESULT_LINE = /^\s*(ok|not ok)\s+\d+\s*-\s*(.+?)\s*$/;

export function parseTap(text) {
  const results = [];
  for (const line of (text ?? "").split("\n")) {
    const match = line.match(TAP_RESULT_LINE);
    if (!match) {
      continue;
    }
    let name = match[2];
    // Strip a trailing TAP directive comment ("# SKIP reason", "# TODO x").
    const directiveIndex = name.indexOf(" # ");
    if (directiveIndex !== -1) {
      name = name.slice(0, directiveIndex);
    }
    results.push({ name: name.trim(), ok: match[1] === "ok" });
  }
  return results;
}

/**
 * Names present (and passing) in `postTap` that were not passing in
 * `preTap` — a test missing from preTap entirely counts as "was not
 * passing", matching the ground-truth-RED expectation that a target test
 * simply does not exist yet on the parent commit.
 */
export function newlyPassing(preTap, postTap) {
  const preOkByName = new Map((preTap ?? []).map((entry) => [entry.name, entry.ok]));
  const result = [];
  for (const entry of postTap ?? []) {
    if (entry.ok && preOkByName.get(entry.name) !== true) {
      result.push(entry.name);
    }
  }
  return result;
}

/** True only when `tap` is non-empty and every entry passed. */
export function allTestsPass(tap) {
  return Array.isArray(tap) && tap.length > 0 && tap.every((entry) => entry.ok);
}

/** True only when `tap` is non-empty and every entry failed. */
export function allTestsFail(tap) {
  return Array.isArray(tap) && tap.length > 0 && tap.every((entry) => !entry.ok);
}

/**
 * Picks the run status from the individual signals a caller collected —
 * harness/timeout failures take priority over scoring outcomes since they
 * mean the run's own results cannot be trusted at all.
 */
export function classifyRunStatus({ harnessError, timedOut, preRedOk, baselineOk, armLeakDetected }) {
  if (harnessError) return "harness-error";
  if (timedOut) return "timeout";
  if (preRedOk === false) return "invalid-red";
  if (baselineOk === false) return "invalid-baseline";
  if (armLeakDetected) return "invalid-arm-leak";
  return "complete";
}
