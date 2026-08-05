import fs from "node:fs";
import path from "node:path";

export const DOCTOR_SCHEMA_VERSION = 1;

const STATUS_RANK = { ok: 0, warning: 1, error: 2 };

/**
 * Runs an ordered list of checks and aggregates them into a doctor report.
 * A check is { id, run } where run returns (or resolves to)
 * { status: "ok"|"warning"|"error", message, details?: string[] }.
 * A throwing check becomes an error finding instead of aborting the report:
 * doctor must be able to describe a broken environment, not crash on it.
 */
export async function runDoctorChecks(checks) {
  const results = [];
  for (const check of checks) {
    try {
      const outcome = await check.run();
      results.push({
        id: check.id,
        status: STATUS_RANK[outcome?.status] !== undefined ? outcome.status : "error",
        message: outcome?.message ?? "Check returned no message.",
        ...(Array.isArray(outcome?.details) && outcome.details.length > 0 ? { details: outcome.details } : {})
      });
    } catch (error) {
      results.push({
        id: check.id,
        status: "error",
        message: `Check failed: ${error instanceof Error ? error.message : String(error)}`
      });
    }
  }
  const overallStatus = results.reduce(
    (worst, check) => (STATUS_RANK[check.status] > STATUS_RANK[worst] ? check.status : worst),
    "ok"
  );
  return {
    schemaVersion: DOCTOR_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    overallStatus,
    issueCount: results.filter((check) => check.status !== "ok").length,
    checks: results
  };
}

export function renderDoctorReport(report, options = {}) {
  const title = options.title ?? "Doctor";
  const marker = { ok: "OK", warning: "WARN", error: "FAIL" };
  const lines = [`# ${title}`, ""];
  lines.push(
    report.overallStatus === "ok"
      ? "Overall: ok — no issues found."
      : `Overall: ${report.overallStatus} (${report.issueCount} issue${report.issueCount === 1 ? "" : "s"}).`
  );
  lines.push("");
  for (const check of report.checks) {
    lines.push(`- [${marker[check.status] ?? check.status}] ${check.id}: ${check.message}`);
    for (const detail of check.details ?? []) {
      lines.push(`  - ${detail}`);
    }
  }
  return lines.join("\n");
}

// A PID that can never belong to a real worker: beyond Linux's default
// pid_max and far outside the PID ranges Windows hands out in practice.
export const LIVENESS_SENTINEL_PID = 0x40000000;

/**
 * Wraps a getLiveJobPids-style probe so a degraded process table is visible
 * instead of reading as "everything is alive". getLiveProcessPids fails
 * closed for cancel by returning every candidate when the table is
 * unreadable — the sentinel PID coming back "live" detects exactly that,
 * and the wrapper returns null (unknown) instead of a fake-healthy set.
 */
export function buildLivenessProbe(getLiveJobPidsImpl) {
  return (activeJobs) => {
    const live = getLiveJobPidsImpl([...activeJobs, { pid: LIVENESS_SENTINEL_PID }]);
    return live.has(LIVENESS_SENTINEL_PID) ? null : live;
  };
}

/**
 * Same sentinel contract for raw getLiveProcessPids-style callers (arrays of
 * PIDs rather than job records). Consumers like the broker owner assessment
 * map a throwing liveness impl to their own "unavailable" reason, so on a
 * fail-closed candidate echo this throws instead of letting dead owners
 * masquerade as live ones.
 */
export function buildProcessTableGuard(getLiveProcessPidsImpl) {
  return (pids, options) => {
    const live = getLiveProcessPidsImpl([...pids, LIVENESS_SENTINEL_PID], options);
    if (live.includes(LIVENESS_SENTINEL_PID)) {
      const error = /** @type {Error & { code?: string }} */ (
        new Error("Process table unavailable: liveness cannot be probed.")
      );
      error.code = "PROCESS_TABLE_UNAVAILABLE";
      throw error;
    }
    return live.filter((pid) => pid !== LIVENESS_SENTINEL_PID);
  };
}

/**
 * Summarizes the durable spawn->ready startup metrics per transport so the
 * accumulated data is readable, not write-only. Always informational (ok):
 * slow startup is a fact to weigh — e.g. for the persistent-broker decision —
 * not a health problem.
 */
export function buildStartupOverheadCheck(readMetrics) {
  return {
    id: "startup-overhead",
    run: () => {
      const samples = readMetrics().filter(
        (metric) => metric?.kind === "startup" && Number.isFinite(metric.ms)
      );
      if (samples.length === 0) {
        return { status: "ok", message: "No startup samples yet; run a few jobs and check back." };
      }
      const byTransport = new Map();
      for (const sample of samples) {
        const key = sample.transport ?? "unknown";
        if (!byTransport.has(key)) {
          byTransport.set(key, []);
        }
        byTransport.get(key).push(sample.ms);
      }
      const quantile = (sorted, q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
      const details = [...byTransport.entries()].map(([transport, values]) => {
        const sorted = [...values].sort((a, b) => a - b);
        return `${transport}: n=${sorted.length}, median ${Math.round(quantile(sorted, 0.5))}ms, p90 ${Math.round(quantile(sorted, 0.9))}ms`;
      });
      return {
        status: "ok",
        message: `Spawn→ready startup overhead across ${samples.length} sample(s).`,
        details
      };
    }
  };
}

/**
 * State-hygiene checks shared by both plugins. The context carries the
 * plugin-specific pieces so this module stays provider-free:
 * { stateDir, jobs, getLiveJobPidsImpl, commandPrefix, staleLockMs? }.
 * getLiveJobPidsImpl may return null to signal that liveness is unknown.
 * Every artifact these checks surface is something the failure paths write
 * deliberately and nothing else ever reads back.
 */
export function buildStateHygieneChecks(context) {
  const staleLockMs = context.staleLockMs ?? 10_000;
  const jobs = context.jobs ?? [];
  return [
    {
      id: "jobs-cleanup-pending",
      run: () => {
        const pending = jobs.filter((job) => job.phase === "cleanup-pending");
        if (pending.length === 0) {
          return { status: "ok", message: "No jobs are waiting on unverified cleanup." };
        }
        return {
          status: "warning",
          message: `${pending.length} job(s) could not verify process cleanup; retry ${context.commandPrefix}:cancel <id> once the environment recovers.`,
          details: pending.map(
            (job) => `${job.id}: ${job.cleanupFailure ?? "cleanup could not be verified"}`
          )
        };
      }
    },
    {
      id: "jobs-likely-dead",
      run: () => {
        const active = jobs.filter((job) => job.status === "queued" || job.status === "running");
        if (active.length === 0) {
          return { status: "ok", message: "No active jobs." };
        }
        const livePids = context.getLiveJobPidsImpl(active);
        if (livePids === null) {
          return {
            status: "warning",
            message: `Worker liveness for ${active.length} active job(s) could not be determined (process table unavailable) — unknown is not healthy.`
          };
        }
        const dead = active.filter((job) => Number.isFinite(job.pid) && !livePids.has(job.pid));
        if (dead.length === 0) {
          return { status: "ok", message: `${active.length} active job(s), all workers alive.` };
        }
        return {
          status: "warning",
          message: `${dead.length} active job(s) whose worker process is gone; ${context.commandPrefix}:cancel <id> will fail them closed.`,
          details: dead.map((job) => `${job.id} (pid ${job.pid})`)
        };
      }
    },
    {
      id: "state-lock",
      run: () => {
        const lockFile = path.join(context.stateDir, "state.lock");
        let lockStat;
        try {
          lockStat = fs.statSync(lockFile);
        } catch {
          return { status: "ok", message: "No state lock is held." };
        }
        const age = Date.now() - lockStat.mtimeMs;
        if (age <= staleLockMs) {
          return { status: "ok", message: "State lock is held by a live writer." };
        }
        return {
          status: "warning",
          message: `state.lock is ${Math.round(age / 1000)}s old (stale after ${Math.round(staleLockMs / 1000)}s); the next writer will steal it, or delete ${lockFile} by hand.`
        };
      }
    },
    {
      id: "state-quarantine",
      run: () => {
        let entries;
        try {
          entries = fs.readdirSync(context.stateDir);
        } catch {
          return { status: "ok", message: "No state directory yet." };
        }
        const quarantined = entries.filter((name) => name.includes(".corrupt-"));
        if (quarantined.length === 0) {
          return { status: "ok", message: "No quarantined state files." };
        }
        return {
          status: "warning",
          message: `${quarantined.length} quarantined state file(s) from past corruption; safe to delete after inspection.`,
          details: quarantined.map((name) => path.join(context.stateDir, name))
        };
      }
    },
    {
      id: "jobs-orphaned-files",
      run: () => {
        const jobsDir = path.join(context.stateDir, "jobs");
        let entries;
        try {
          entries = fs.readdirSync(jobsDir);
        } catch {
          return { status: "ok", message: "No job files yet." };
        }
        const knownIds = new Set(jobs.map((job) => job.id));
        const orphans = entries.filter((name) => {
          const id = name.replace(/\.(json|log)$/, "");
          return id !== name && !knownIds.has(id);
        });
        if (orphans.length === 0) {
          return { status: "ok", message: "Every job file is tracked by the state index." };
        }
        if (knownIds.size === 0) {
          // An empty index with job files on disk looks like a lost index,
          // not prune residue — never coach deletion here.
          return {
            status: "warning",
            message: `${orphans.length} job file(s) exist but the state index is empty — the index may have been lost; inspect before deleting anything.`,
            details: orphans.map((name) => path.join(jobsDir, name))
          };
        }
        return {
          status: "warning",
          message: `${orphans.length} job file(s) have no state entry (residue from pruning or crashes); safe to delete.`,
          details: orphans.map((name) => path.join(jobsDir, name))
        };
      }
    }
  ];
}
