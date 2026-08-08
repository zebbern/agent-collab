// Pure helpers for driving a headless `claude` CLI run. Nothing in this file
// spawns a process — that lands in increment 2 (see run-bench.mjs's runLive
// TODO seam). This increment only builds the deterministic, testable pieces:
// what settings a "solo" vs "codex" arm gets, the exact argv a live run would
// invoke, the environment a run must be scrubbed and re-pointed to, and how
// to parse `claude -p --output-format json`'s result payload.
import path from "node:path";
import process from "node:process";

// Job-record/transcript vars the INSTALLED plugins' SessionStart hooks export
// into every Bash environment of a live Claude session — the same leak class
// tests/helpers.mjs's run() scrubs. A bench arm must not inherit the
// orchestrator's own session identity into the subprocess it spawns to
// benchmark, or the subprocess's companion state would session-filter its own
// jobs away.
const AMBIENT_SESSION_VARS = [
  "CODEX_COMPANION_SESSION_ID",
  "CURSOR_COMPANION_SESSION_ID",
  "CODEX_COMPANION_TRANSCRIPT_PATH",
  "CURSOR_COMPANION_TRANSCRIPT_PATH"
];

/**
 * The Claude Code settings.json content for one bench arm. "solo" runs with
 * every delegation plugin disabled (the baseline); "codex" enables only the
 * codex plugin, isolating its effect from cursor and goal.
 */
export function buildArmSettings(arm) {
  if (arm !== "solo" && arm !== "codex") {
    throw new Error(`Unknown bench arm "${arm}"; use "solo" or "codex".`);
  }
  return {
    enabledPlugins: {
      "codex@agent-collab": arm === "codex",
      "cursor@agent-collab": false,
      "goal@agent-collab": false
    }
  };
}

/**
 * The exact argv a live run invokes claude with. Kept as a single source of
 * truth so a live-run wiring pass in increment 2 cannot silently diverge from
 * what this increment's tests pin.
 */
export function buildClaudeInvocation({ armSettingsFile, prompt, budgetUsd }) {
  return {
    file: "claude",
    args: [
      "-p", prompt,
      "--output-format", "json",
      "--no-session-persistence",
      "--max-budget-usd", String(budgetUsd),
      "--permission-mode", "bypassPermissions",
      "--setting-sources", "user",
      "--settings", armSettingsFile
    ]
  };
}

/**
 * Scrubs the orchestrator's own ambient session identity out of `baseEnv`
 * (only when a var's value is identical to the live ambient one — a var a
 * caller set DELIBERATELY, e.g. for a session-scoping test, is preserved),
 * then points the run at an isolated plugin-data directory. CLAUDE_PLUGIN_DATA
 * is set for the era whose companions still key state off it (see
 * plugins/codex/scripts/lib/state.mjs's ERA doctrine comment); the modern
 * *_COMPANION_STATE_ROOT vars are also set, as subdirectories of the same
 * isolated root, for forward-compat with post-canonical-root checkouts.
 */
export function buildRunEnv(baseEnv, { pluginDataDir }) {
  const env = { ...baseEnv };
  for (const name of AMBIENT_SESSION_VARS) {
    if (env[name] !== undefined && env[name] === process.env[name]) {
      delete env[name];
    }
  }
  env.CLAUDE_PLUGIN_DATA = pluginDataDir;
  env.CODEX_COMPANION_STATE_ROOT = path.join(pluginDataDir, "codex-companion");
  env.CURSOR_COMPANION_STATE_ROOT = path.join(pluginDataDir, "cursor-companion");
  env.GOAL_COMPANION_STATE_ROOT = path.join(pluginDataDir, "goal-companion");
  return env;
}

/**
 * Parses `claude -p --output-format json`'s stdout. costMeasurable is false
 * exactly when the run reports zero cost despite having taken at least one
 * turn — the signature of a subscription/flat-rate account where cost is
 * structurally unmeasured, not a genuinely free run. Malformed JSON reports
 * as a harness-error rather than throwing, so a caller can record the run as
 * invalid instead of crashing the whole bench.
 */
export function parseClaudeResult(stdoutText) {
  let parsed;
  try {
    parsed = JSON.parse(stdoutText);
  } catch (error) {
    return {
      status: "harness-error",
      detail: `claude output was not valid JSON: ${error instanceof Error ? error.message : String(error)}`
    };
  }
  const totalCostUsd = typeof parsed?.total_cost_usd === "number" ? parsed.total_cost_usd : null;
  const numTurns = typeof parsed?.num_turns === "number" ? parsed.num_turns : null;
  const durationMs = typeof parsed?.duration_ms === "number" ? parsed.duration_ms : null;
  const isError = Boolean(parsed?.is_error);
  const costMeasurable = !(totalCostUsd === 0 && numTurns > 0);
  return { totalCostUsd, costMeasurable, numTurns, durationMs, isError, raw: parsed };
}
