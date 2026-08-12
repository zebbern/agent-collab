import fs from "node:fs";
import process from "node:process";

import { captureProcessOwnership, getOwnWindowsProcessIdentity, getProcessIdentity } from "./process.mjs";
import { hasCancelFlag, isTerminalJobStatus, listJobs, readJobFile, removeCancelFlag, resolveJobFile, resolveJobLogFile, upsertJob, writeJobFile } from "./state.mjs";

export const SESSION_ID_ENV = "CURSOR_COMPANION_SESSION_ID";
const JOB_CANCELLED_CODE = "JOB_CANCELLED";

export function nowIso() {
  return new Date().toISOString();
}

function normalizeProgressEvent(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return {
      message: String(value.message ?? "").trim(),
      phase: typeof value.phase === "string" && value.phase.trim() ? value.phase.trim() : null,
      threadId: typeof value.threadId === "string" && value.threadId.trim() ? value.threadId.trim() : null,
      turnId: typeof value.turnId === "string" && value.turnId.trim() ? value.turnId.trim() : null,
      stderrMessage: value.stderrMessage == null ? null : String(value.stderrMessage).trim(),
      logTitle: typeof value.logTitle === "string" && value.logTitle.trim() ? value.logTitle.trim() : null,
      logBody: value.logBody == null ? null : String(value.logBody).trimEnd()
    };
  }

  return {
    message: String(value ?? "").trim(),
    phase: null,
    threadId: null,
    turnId: null,
    stderrMessage: String(value ?? "").trim(),
    logTitle: null,
    logBody: null
  };
}

export function appendLogLine(logFile, message) {
  const normalized = String(message ?? "").trim();
  if (!logFile || !normalized) {
    return;
  }
  fs.appendFileSync(logFile, `[${nowIso()}] ${normalized}\n`, "utf8");
}

export function appendLogBlock(logFile, title, body) {
  if (!logFile || !body) {
    return;
  }
  fs.appendFileSync(logFile, `\n[${nowIso()}] ${title}\n${String(body).trimEnd()}\n`, "utf8");
}

export function createJobLogFile(workspaceRoot, jobId, title) {
  const logFile = resolveJobLogFile(workspaceRoot, jobId);
  // Logs carry the same prompts and results as job records; keep them private.
  fs.writeFileSync(logFile, "", { encoding: "utf8", mode: 0o600 });
  if (title) {
    appendLogLine(logFile, `Starting ${title}.`);
  }
  return logFile;
}

export function createJobRecord(base, options = {}) {
  const env = options.env ?? process.env;
  const sessionId = env[options.sessionIdEnv ?? SESSION_ID_ENV];
  return {
    ...base,
    createdAt: nowIso(),
    ...(sessionId ? { sessionId } : {})
  };
}

export function createJobProgressUpdater(workspaceRoot, jobId) {
  let lastPhase = null;
  let lastThreadId = null;
  let lastTurnId = null;

  return (event) => {
    const normalized = normalizeProgressEvent(event);
    const patch = { id: jobId };
    let changed = false;

    if (normalized.phase && normalized.phase !== lastPhase) {
      lastPhase = normalized.phase;
      patch.phase = normalized.phase;
      changed = true;
    }

    if (normalized.threadId && normalized.threadId !== lastThreadId) {
      lastThreadId = normalized.threadId;
      patch.threadId = normalized.threadId;
      changed = true;
    }

    if (normalized.turnId && normalized.turnId !== lastTurnId) {
      lastTurnId = normalized.turnId;
      patch.turnId = normalized.turnId;
      changed = true;
    }

    if (!changed) {
      return;
    }

    // Never write progress over a job that has already reached a terminal
    // status (a cancel can land while the stream is still emitting events).
    const currentJob = listJobs(workspaceRoot).find((job) => job.id === jobId);
    if (currentJob && isTerminalJobStatus(currentJob.status)) {
      return;
    }

    upsertJob(workspaceRoot, patch);

    const jobFile = resolveJobFile(workspaceRoot, jobId);
    if (!fs.existsSync(jobFile)) {
      return;
    }

    const storedJob = readJobFile(jobFile);
    writeJobFile(workspaceRoot, jobId, {
      ...storedJob,
      ...patch
    });
  };
}

export function createProgressReporter({ stderr = false, logFile = null, onEvent = null } = {}) {
  if (!stderr && !logFile && !onEvent) {
    return null;
  }

  return (eventOrMessage) => {
    const event = normalizeProgressEvent(eventOrMessage);
    const stderrMessage = event.stderrMessage ?? event.message;
    if (stderr && stderrMessage) {
      process.stderr.write(`[cursor] ${stderrMessage}\n`);
    }
    appendLogLine(logFile, event.message);
    appendLogBlock(logFile, event.logTitle, event.logBody);
    onEvent?.(event);
  };
}

function readStoredJobOrNull(workspaceRoot, jobId) {
  const jobFile = resolveJobFile(workspaceRoot, jobId);
  if (!fs.existsSync(jobFile)) {
    return null;
  }
  return readJobFile(jobFile);
}

const CANONICAL_CLEANUP_FIELDS = [
  "pid",
  "processIdentity",
  "ownershipSnapshot",
  "ownershipCaptureFailed",
  "cleanupOutcome",
  "appServerPid",
  "appServerProcessIdentity",
  "appServerOwnershipSnapshot",
  "appServerCleanupOutcome",
  "cleanupFailure",
  "wslAgentPid",
  "wslAgentStartTime",
  "wslReap"
];

function readCanonicalTrackedRecord(workspaceRoot, jobId, fallback) {
  const indexed = listJobs(workspaceRoot).find((candidate) => candidate.id === jobId) ?? fallback;
  const stored = readStoredJobOrNull(workspaceRoot, jobId) ?? {};
  const record = { ...stored, ...indexed };
  for (const field of CANONICAL_CLEANUP_FIELDS) {
    if (Object.hasOwn(indexed, field)) {
      record[field] = indexed[field];
    } else {
      delete record[field];
    }
  }
  // The locked index is the cancellation linearization point. A job-file
  // writer can lag or race it, but must never hide an authoritative cancel.
  if (indexed.status === "cancelled") {
    record.status = "cancelled";
    record.phase = indexed.phase ?? "cancelled";
  }
  return record;
}

function hasUnresolvedCleanup(record) {
  const hasAppServerOwnership =
    Number.isFinite(record?.appServerPid) ||
    Boolean(record?.appServerProcessIdentity) ||
    Boolean(record?.appServerOwnershipSnapshot);
  return (
    record?.phase === "cleanup-pending" ||
    (typeof record?.cleanupFailure === "string" && record.cleanupFailure.length > 0) ||
    record?.cleanupOutcome?.verified === false ||
    record?.appServerCleanupOutcome?.verified === false ||
    (hasAppServerOwnership && record?.appServerCleanupOutcome?.verified !== true) ||
    (record?.status === "cancelled" && Number.isFinite(record?.wslAgentPid) && record?.wslReap?.reaped !== true)
  );
}

function preferVerifiedCleanupOutcome(current, candidate) {
  if (candidate?.verified === true) {
    return candidate;
  }
  if (current?.verified === true) {
    return current;
  }
  return candidate ?? current ?? null;
}

function createJobCancelledError(jobId) {
  const error = /** @type {Error & { code?: string }} */ (new Error(`Job ${jobId} was cancelled before execution.`));
  error.name = "JobCancelledError";
  error.code = JOB_CANCELLED_CODE;
  return error;
}

function throwIfAuthoritativelyCancelled(workspaceRoot, jobId, source) {
  const authoritative = Array.isArray(source?.jobs)
    ? source.jobs.find((candidate) => candidate.id === jobId)
    : source;
  if (authoritative?.status !== "cancelled" || authoritative?.phase === "cleanup-pending") {
    return;
  }
  const stored = readStoredJobOrNull(workspaceRoot, jobId) ?? {};
  // Preserve any richer stored payload, but let the locked index win every
  // lifecycle field so file and index converge after either write ordering.
  writeJobFile(workspaceRoot, jobId, {
    ...stored,
    ...authoritative,
    status: "cancelled",
    phase: authoritative.phase ?? "cancelled",
    pid: null
  });
  removeCancelFlag(workspaceRoot, jobId);
  throw createJobCancelledError(jobId);
}

/**
 * Ownership proof for the process that is about to run a job in-process:
 * Unix start-time identity where available, (pid, CreationDate) on win32,
 * plus a best-effort tree snapshot. Cancel refuses to signal any PID it
 * cannot prove, so a record without these fields is uncancellable.
 */
export function captureRunnerOwnership(pid = process.pid) {
  let ownership;
  try {
    const processIdentity =
      getProcessIdentity(pid) ??
      (process.platform === "win32" ? getOwnWindowsProcessIdentity() : null);
    ownership = processIdentity ? { processIdentity } : { ownershipCaptureFailed: true };
  } catch {
    ownership = { ownershipCaptureFailed: true };
  }
  if (ownership.processIdentity) {
    // Snapshot only alongside a successful identity capture: a failed capture
    // must leave no partial ownership data behind.
    try {
      const ownershipSnapshot = captureProcessOwnership(pid);
      if (ownershipSnapshot) {
        ownership = { ...ownership, ownershipSnapshot };
      }
    } catch {
      // Snapshot capture is best-effort; identity above still gates cancel.
    }
  }
  return ownership;
}

export async function runTrackedJob(job, runner, options = {}) {
  // Detached workers capture and spread their own ownership into the job;
  // every other caller runs the job in this very process, so the proof is
  // captured here — otherwise foreground jobs are uncancellable by design.
  const ownership =
    job.processIdentity || job.ownershipCaptureFailed === true ? {} : captureRunnerOwnership();
  const runningRecord = {
    ...job,
    ...ownership,
    status: "running",
    startedAt: nowIso(),
    phase: "starting",
    pid: process.pid,
    logFile: options.logFile ?? job.logFile ?? null
  };
  const upsert = options.upsertJobImpl ?? upsertJob;
  writeJobFile(job.workspaceRoot, job.id, runningRecord);
  const runningState = upsert(job.workspaceRoot, runningRecord);
  throwIfAuthoritativelyCancelled(job.workspaceRoot, job.id, runningState);

  try {
    if (hasCancelFlag(job.workspaceRoot, job.id)) {
      throw createJobCancelledError(job.id);
    }
    const execution = await runner();
    const completionStatus = execution.exitStatus === 0 ? "completed" : "failed";
    const completedAt = nowIso();
    const existing = readCanonicalTrackedRecord(job.workspaceRoot, job.id, runningRecord);
    if (existing.status === "cancelled" && existing.phase !== "cleanup-pending") {
      removeCancelFlag(job.workspaceRoot, job.id);
      throw createJobCancelledError(job.id);
    }
    const cleanupPending = hasUnresolvedCleanup(existing);
    writeJobFile(job.workspaceRoot, job.id, {
      ...existing,
      status: completionStatus,
      threadId: execution.threadId ?? null,
      turnId: execution.turnId ?? null,
      pid: cleanupPending ? existing.pid ?? runningRecord.pid : null,
      phase: cleanupPending ? "cleanup-pending" : completionStatus === "completed" ? "done" : "failed",
      completedAt,
      result: execution.payload,
      rendered: execution.rendered
    });
    const completedState = upsert(job.workspaceRoot, {
      id: job.id,
      status: completionStatus,
      threadId: execution.threadId ?? null,
      turnId: execution.turnId ?? null,
      summary: execution.summary,
      phase: cleanupPending ? "cleanup-pending" : completionStatus === "completed" ? "done" : "failed",
      pid: cleanupPending ? existing.pid ?? runningRecord.pid : null,
      ...(cleanupPending
        ? {
            ...(existing.cleanupOutcome ? { cleanupOutcome: existing.cleanupOutcome } : {}),
            ...(existing.appServerCleanupOutcome ? { appServerCleanupOutcome: existing.appServerCleanupOutcome } : {}),
            cleanupFailure: existing.cleanupFailure ?? "Process cleanup remains unverified."
          }
        : {}),
      completedAt
    });
    throwIfAuthoritativelyCancelled(job.workspaceRoot, job.id, completedState);
    appendLogBlock(options.logFile ?? job.logFile ?? null, "Final output", execution.rendered);
    return execution;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const existing = readCanonicalTrackedRecord(job.workspaceRoot, job.id, runningRecord);
    const cleanupPendingCancellation = existing.status === "cancelled" && existing.phase === "cleanup-pending";
    if (existing.status === "cancelled" && existing.phase !== "cleanup-pending") {
      throwIfAuthoritativelyCancelled(job.workspaceRoot, job.id, existing);
    }
    const completedAt = nowIso();
    const appServerCleanupOutcome = preferVerifiedCleanupOutcome(
      existing.appServerCleanupOutcome,
      error?.appServerCleanupOutcome
    );
    const existingCleanupPending = hasUnresolvedCleanup(existing);
    const cleanupPending = appServerCleanupOutcome?.verified === false || existingCleanupPending;
    const completedExecution = cleanupPending ? error?.completedResult ?? null : null;
    const terminalStatus = completedExecution
      ? completedExecution.exitStatus === 0 ? "completed" : "failed"
      : cleanupPendingCancellation ? "cancelled"
      : error?.code === JOB_CANCELLED_CODE ? "cancelled" : "failed";
    const cleanupFailure = cleanupPending ? errorMessage : null;
    writeJobFile(job.workspaceRoot, job.id, {
      ...existing,
      status: terminalStatus,
      phase: cleanupPending ? "cleanup-pending" : terminalStatus,
      errorMessage,
      ...(cleanupPending
        ? {
            ...(appServerCleanupOutcome ? { appServerCleanupOutcome } : {}),
            ...(existing.cleanupOutcome ? { cleanupOutcome: existing.cleanupOutcome } : {}),
            cleanupFailure: existing.cleanupFailure ?? cleanupFailure
          }
        : {}),
      ...(completedExecution
        ? {
            threadId: completedExecution.threadId ?? null,
            turnId: completedExecution.turnId ?? null,
            result: completedExecution.payload,
            rendered: completedExecution.rendered
          }
        : {}),
      pid: cleanupPending ? existing.pid ?? runningRecord.pid : null,
      completedAt,
      logFile: options.logFile ?? job.logFile ?? existing.logFile ?? null
    });
    const failedState = upsert(job.workspaceRoot, {
      id: job.id,
      status: terminalStatus,
      phase: cleanupPending ? "cleanup-pending" : terminalStatus,
      pid: cleanupPending ? existing.pid ?? runningRecord.pid : null,
      errorMessage,
      ...(cleanupPending
        ? {
            ...(appServerCleanupOutcome ? { appServerCleanupOutcome } : {}),
            ...(existing.cleanupOutcome ? { cleanupOutcome: existing.cleanupOutcome } : {}),
            cleanupFailure: existing.cleanupFailure ?? cleanupFailure
          }
        : {}),
      ...(completedExecution
        ? {
            threadId: completedExecution.threadId ?? null,
            turnId: completedExecution.turnId ?? null,
            summary: completedExecution.summary
          }
        : {}),
      completedAt
    });
    throwIfAuthoritativelyCancelled(job.workspaceRoot, job.id, failedState);
    if (terminalStatus === "cancelled" && !cleanupPending) {
      // The worker has now durably acknowledged the cancellation. Until this
      // point the tombstone must survive state pruning so a worker that read
      // the queued request cannot cross the read-to-start race.
      removeCancelFlag(job.workspaceRoot, job.id);
    }
    throw error;
  }
}
