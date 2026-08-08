// Harvests delegated-job telemetry (tokenUsage, model, effort, timing) out of
// a run's isolated CLAUDE_PLUGIN_DATA directory. Two on-disk layouts are
// scanned because the three parent SHAs this bench replays predate the
// canonical state-root change (PR #40): at those checkouts the companions
// key state off CLAUDE_PLUGIN_DATA directly (<CPD>/state/<slug>-<hash16>/
// jobs/*.json — the "parent-era" layout below); a post-canonical-root
// checkout instead honors *_COMPANION_STATE_ROOT, which
// bench/lib/headless.mjs's buildRunEnv points at <CPD>/<companion>/
// <slug>-<hash16>/jobs/*.json (the "modern" fallback below). Both are
// scanned unconditionally rather than branched on sha, since which era a
// given task's parent/fix commits land in is not this module's concern.
import fs from "node:fs";
import path from "node:path";

function listSubdirs(dir) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

function readJobFiles(jobsDir) {
  let entries;
  try {
    entries = fs.readdirSync(jobsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const jobs = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) {
      continue;
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(jobsDir, entry.name), "utf8"));
      if (parsed && typeof parsed === "object") {
        jobs.push(parsed);
      }
    } catch {
      // Skip an unreadable or corrupt job file rather than failing the harvest.
    }
  }
  return jobs;
}

function findJobsDirs(pluginDataDir) {
  const found = [];
  // Parent-era layout: <pluginDataDir>/state/<slug-hash>/jobs
  const stateRoot = path.join(pluginDataDir, "state");
  for (const shard of listSubdirs(stateRoot)) {
    const jobsDir = path.join(stateRoot, shard, "jobs");
    if (fs.existsSync(jobsDir)) {
      found.push(jobsDir);
    }
  }
  // Modern fallback: <pluginDataDir>/<companion>/<slug-hash>/jobs
  for (const companion of listSubdirs(pluginDataDir)) {
    if (companion === "state") {
      continue; // already covered by the parent-era scan above
    }
    const companionRoot = path.join(pluginDataDir, companion);
    for (const shard of listSubdirs(companionRoot)) {
      const jobsDir = path.join(companionRoot, shard, "jobs");
      if (fs.existsSync(jobsDir)) {
        found.push(jobsDir);
      }
    }
  }
  return found;
}

// Same dual-dialect read as plugins/codex/scripts/lib/job-control.mjs's
// pickNumericField: job records seen across the bench's replayed commits may
// carry either camelCase or snake_case token-usage fields.
function pickNumericField(source, names) {
  if (!source || typeof source !== "object") {
    return null;
  }
  for (const name of names) {
    const value = source[name];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }
  return null;
}

/**
 * Reads every delegated job record under `pluginDataDir`, across both
 * on-disk layouts, and returns the fields the bench report cares about plus
 * their summed token usage.
 */
export function harvestJobs(pluginDataDir) {
  const jobsDirs = [...new Set(findJobsDirs(pluginDataDir))];
  const rawJobs = jobsDirs.flatMap((dir) => readJobFiles(dir));
  const jobs = rawJobs.map((job) => ({
    tokenUsage: job.tokenUsage ?? null,
    model: job.model ?? null,
    effort: job.effort ?? null,
    startedAt: job.startedAt ?? null,
    completedAt: job.completedAt ?? null
  }));
  const totalTokens = jobs.reduce((sum, job) => {
    const total = pickNumericField(job.tokenUsage, ["totalTokens", "total_tokens"]);
    return sum + (total ?? 0);
  }, 0);
  return { jobs, totalTokens };
}
