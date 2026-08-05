import fs from "node:fs";

import { getSessionRuntimeStatus } from "./codex.mjs";
import { getLiveProcessPids } from "./process.mjs";
import { getConfig, listJobs, readJobFile, resolveJobFile } from "./state.mjs";
import { SESSION_ID_ENV } from "./tracked-jobs.mjs";
import { resolveWorkspaceRoot } from "./workspace.mjs";

export const DEFAULT_MAX_STATUS_JOBS = 8;
export const DEFAULT_MAX_PROGRESS_LINES = 4;
export const STALE_QUEUED_JOB_THRESHOLD_MS = 2 * 60 * 1000;
const LOOP_COMMAND_THRESHOLD = 3;

export function sortJobsNewestFirst(jobs) {
  return [...jobs].sort((left, right) => String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")));
}

function getCurrentSessionId(options = {}) {
  return options.env?.[SESSION_ID_ENV] ?? process.env[SESSION_ID_ENV] ?? null;
}

function filterJobsForCurrentSession(jobs, options = {}) {
  const sessionId = getCurrentSessionId(options);
  if (!sessionId) {
    return jobs;
  }
  return jobs.filter((job) => job.sessionId === sessionId);
}

function getJobTypeLabel(job) {
  if (typeof job.kindLabel === "string" && job.kindLabel) {
    return job.kindLabel;
  }
  if (job.kind === "adversarial-review") {
    return "adversarial-review";
  }
  if (job.jobClass === "review") {
    return "review";
  }
  if (job.jobClass === "task") {
    return "rescue";
  }
  if (job.kind === "review") {
    return "review";
  }
  if (job.kind === "task") {
    return "rescue";
  }
  return "job";
}

function stripLogPrefix(line) {
  return line.replace(/^\[[^\]]+\]\s*/, "").trim();
}

function isProgressBlockTitle(line) {
  return (
    ["Final output", "Assistant message", "Reasoning summary", "Review output"].includes(line) ||
    /^Subagent .+ message$/.test(line) ||
    /^Subagent .+ reasoning summary$/.test(line)
  );
}

export function readJobProgressPreview(logFile, maxLines = DEFAULT_MAX_PROGRESS_LINES) {
  if (!logFile || !fs.existsSync(logFile)) {
    return [];
  }

  const lines = fs
    .readFileSync(logFile, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .filter((line) => line.startsWith("["))
    .map(stripLogPrefix)
    .filter((line) => line && !isProgressBlockTitle(line));

  return lines.slice(-maxLines);
}

function formatElapsedDuration(startValue, endValue = null) {
  const start = Date.parse(startValue ?? "");
  if (!Number.isFinite(start)) {
    return null;
  }

  const end = endValue ? Date.parse(endValue) : Date.now();
  // Tolerate small clock skew: filesystem mtimes can land a few milliseconds
  // ahead of Date.now() (NTFS rounding), and the freshest activity must not
  // render as "no signal". Math.max below clamps the skew to 0s.
  if (!Number.isFinite(end) || end < start - 2000) {
    return null;
  }

  const totalSeconds = Math.max(0, Math.round((end - start) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}

function looksLikeVerificationCommand(line) {
  return /\b(test|tests|lint|build|typecheck|type-check|check|verify|validate|pytest|jest|vitest|cargo test|npm test|pnpm test|yarn test|go test|mvn test|gradle test|tsc|eslint|ruff)\b/i.test(
    line
  );
}

function inferLegacyJobPhase(job, progressPreview = []) {
  switch (job.status) {
    case "queued":
      return "queued";
    case "cancelled":
      return "cancelled";
    case "failed":
      return "failed";
    case "completed":
      return "done";
    default:
      break;
  }

  for (let index = progressPreview.length - 1; index >= 0; index -= 1) {
    const line = progressPreview[index].toLowerCase();
    if (line.startsWith("starting codex") || line.startsWith("thread ready") || line.startsWith("turn started")) {
      return "starting";
    }
    if (line.startsWith("reviewer started") || line.includes("review mode")) {
      return "reviewing";
    }
    if (line.startsWith("searching:") || line.startsWith("calling ") || line.startsWith("running tool:")) {
      return "investigating";
    }
    if (line.startsWith("starting collaboration tool:")) {
      return "investigating";
    }
    if (line.startsWith("running command:")) {
      return looksLikeVerificationCommand(line)
        ? "verifying"
        : job.jobClass === "review"
          ? "reviewing"
          : "investigating";
    }
    if (line.startsWith("command completed:")) {
      return looksLikeVerificationCommand(line) ? "verifying" : "running";
    }
    if (line.startsWith("applying ") || line.startsWith("file changes ")) {
      return "editing";
    }
    if (line.startsWith("turn completed")) {
      return "finalizing";
    }
    if (line.startsWith("codex error:") || line.startsWith("failed:")) {
      return "failed";
    }
  }

  return job.jobClass === "review" ? "reviewing" : "running";
}

function readStoredJobResult(workspaceRoot, job) {
  if (!workspaceRoot || !job?.id) {
    return null;
  }
  try {
    const jobFile = resolveJobFile(workspaceRoot, job.id);
    if (!fs.existsSync(jobFile)) {
      return null;
    }
    const storedJob = readJobFile(jobFile);
    return storedJob?.result && typeof storedJob.result === "object" ? storedJob.result : null;
  } catch {
    return null;
  }
}

function telemetryEntries(list) {
  if (!Array.isArray(list)) {
    return [];
  }
  return list.filter((entry) => entry && typeof entry === "object" && !Number.isFinite(entry.truncated));
}

function latestTelemetryTimestamp(...lists) {
  let latest = null;
  for (const list of lists) {
    for (const entry of list) {
      const parsed = Date.parse(entry?.completedAt ?? "");
      if (Number.isFinite(parsed) && (latest === null || parsed > latest)) {
        latest = parsed;
      }
    }
  }
  return latest;
}

function readLogFileModifiedAt(logFile) {
  if (!logFile) {
    return null;
  }
  try {
    return fs.statSync(logFile).mtimeMs;
  } catch {
    return null;
  }
}

function formatLastActivitySignal(job, fileChanges, commandExecutions) {
  const lastActivityMs = latestTelemetryTimestamp(fileChanges, commandExecutions) ?? readLogFileModifiedAt(job.logFile);
  if (!Number.isFinite(lastActivityMs)) {
    return null;
  }
  const elapsed = formatElapsedDuration(new Date(lastActivityMs).toISOString());
  return elapsed ? `last activity: ${elapsed} ago` : null;
}

function formatCommandSignal(commandExecutions) {
  const counts = new Map();
  for (const entry of commandExecutions) {
    const command = typeof entry.command === "string" && entry.command.trim() ? entry.command.trim() : "(unknown command)";
    counts.set(command, (counts.get(command) ?? 0) + 1);
  }

  let repeated = null;
  for (const [command, count] of counts) {
    if (count >= LOOP_COMMAND_THRESHOLD && (repeated === null || count > repeated.count)) {
      repeated = { command, count };
    }
  }

  const base = `commands: ${commandExecutions.length} run (${counts.size} distinct)`;
  return repeated ? `${base}, possible loop: ${repeated.command} x${repeated.count}` : base;
}

function pickNumericField(source, names) {
  for (const name of names) {
    const value = source?.[name];
    if (Number.isFinite(value)) {
      return value;
    }
  }
  return null;
}

function formatTokenUsageSignal(tokenUsage) {
  if (!tokenUsage || typeof tokenUsage !== "object" || Array.isArray(tokenUsage)) {
    return null;
  }
  const total = pickNumericField(tokenUsage, ["totalTokens", "total_tokens"]);
  const input = pickNumericField(tokenUsage, ["inputTokens", "input_tokens"]);
  const output = pickNumericField(tokenUsage, ["outputTokens", "output_tokens", "completionTokens", "completion_tokens"]);
  if (total === null && input === null && output === null) {
    return null;
  }
  const parts = [];
  if (input !== null) {
    parts.push(`input ${input}`);
  }
  if (output !== null) {
    parts.push(`output ${output}`);
  }
  if (total !== null) {
    return `tokens: ${total} total${parts.length > 0 ? ` (${parts.join(", ")})` : ""}`;
  }
  return `tokens: ${parts.join(", ")}`;
}

export function buildProgressSignals(job, options = {}) {
  if (!job || job.status === "queued") {
    return [];
  }

  const workspaceRoot = options.workspaceRoot ?? job.workspaceRoot ?? null;
  const storedResult = Object.hasOwn(options, "storedResult") ? options.storedResult : readStoredJobResult(workspaceRoot, job);
  const fileChanges = telemetryEntries(storedResult?.fileChanges);
  const commandExecutions = telemetryEntries(storedResult?.commandExecutions);

  const signals = [];
  if (fileChanges.length > 0) {
    signals.push(`files changed: ${fileChanges.length}`);
  }
  const lastActivity = formatLastActivitySignal(job, fileChanges, commandExecutions);
  if (lastActivity) {
    signals.push(lastActivity);
  }
  if (commandExecutions.length > 0) {
    signals.push(formatCommandSignal(commandExecutions));
  }
  const tokenUsage = formatTokenUsageSignal(storedResult?.tokenUsage);
  if (tokenUsage) {
    signals.push(tokenUsage);
  }
  return signals;
}

function expectedIdentityFor(job) {
  return typeof job?.processIdentity === "string" && job.processIdentity ? job.processIdentity : null;
}

export function getLiveJobPids(jobs, options = {}) {
  const candidates = jobs.filter((job) => Number.isFinite(job?.pid));
  if (candidates.length === 0) {
    return new Set();
  }
  const identities = candidates.map(expectedIdentityFor).filter(Boolean);
  const livePids = (options.getLiveProcessPidsImpl ?? getLiveProcessPids)(
    candidates.map((job) => job.pid),
    { identities }
  );
  return new Set(livePids);
}

function deriveJobLiveness(job, options = {}) {
  if (job.status !== "queued" && job.status !== "running") {
    return null;
  }

  if (Number.isFinite(job.pid)) {
    const livePids =
      options.livePids ??
      getLiveJobPids([job], { getLiveProcessPidsImpl: options.getLiveProcessPidsImpl });
    return livePids.has(job.pid) ? null : "likely dead";
  }

  if (job.status === "queued") {
    const createdAt = Date.parse(job.createdAt ?? "");
    const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
    if (Number.isFinite(createdAt) && nowMs - createdAt > STALE_QUEUED_JOB_THRESHOLD_MS) {
      return "likely dead";
    }
  }

  return null;
}

function readJobTransport(storedResult) {
  const transport = typeof storedResult?.transport === "string" && storedResult.transport ? storedResult.transport : null;
  if (!transport) {
    return {};
  }
  const transportReason =
    typeof storedResult?.transportReason === "string" && storedResult.transportReason ? storedResult.transportReason : null;
  return transportReason ? { transport, transportReason } : { transport };
}

function readJobModel(storedResult) {
  // Older job files predate the model field; only surface it when the record
  // actually carries one. model: null means "no --model given" — the run used
  // the Codex config default — which render distinguishes from an absent record.
  if (!storedResult || typeof storedResult !== "object" || !Object.hasOwn(storedResult, "model")) {
    return {};
  }
  const model = typeof storedResult.model === "string" && storedResult.model ? storedResult.model : null;
  return { model, modelRecorded: true };
}

export function enrichJob(job, options = {}) {
  const maxProgressLines = options.maxProgressLines ?? DEFAULT_MAX_PROGRESS_LINES;
  const workspaceRoot = options.workspaceRoot ?? job.workspaceRoot ?? null;
  const storedResult = Object.hasOwn(options, "storedResult") ? options.storedResult : readStoredJobResult(workspaceRoot, job);
  const enriched = {
    ...job,
    kindLabel: getJobTypeLabel(job),
    progressPreview:
      job.status === "queued" || job.status === "running" || job.status === "failed"
        ? readJobProgressPreview(job.logFile, maxProgressLines)
        : [],
    progressSignals: buildProgressSignals(job, { ...options, storedResult }),
    ...readJobTransport(storedResult),
    ...readJobModel(storedResult),
    liveness: deriveJobLiveness(job, options),
    elapsed: formatElapsedDuration(job.startedAt ?? job.createdAt, job.completedAt ?? null),
    duration:
      job.status === "completed" || job.status === "failed" || job.status === "cancelled"
        ? formatElapsedDuration(job.startedAt ?? job.createdAt, job.completedAt ?? job.updatedAt)
        : null
  };

  return {
    ...enriched,
    phase: enriched.phase ?? inferLegacyJobPhase(enriched, enriched.progressPreview)
  };
}

export function readStoredJob(workspaceRoot, jobId) {
  const jobFile = resolveJobFile(workspaceRoot, jobId);
  if (!fs.existsSync(jobFile)) {
    return null;
  }
  return readJobFile(jobFile);
}

function matchJobReference(jobs, reference, predicate = () => true) {
  const filtered = jobs.filter(predicate);
  if (!reference) {
    return filtered[0] ?? null;
  }

  const exact = filtered.find((job) => job.id === reference);
  if (exact) {
    return exact;
  }

  const prefixMatches = filtered.filter((job) => job.id.startsWith(reference));
  if (prefixMatches.length === 1) {
    return prefixMatches[0];
  }
  if (prefixMatches.length > 1) {
    throw new Error(`Job reference "${reference}" is ambiguous. Use a longer job id.`);
  }

  throw new Error(`No job found for "${reference}". Run /codex:status to list known jobs.`);
}

export function buildStatusSnapshot(cwd, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const config = getConfig(workspaceRoot);
  const jobs = sortJobsNewestFirst(filterJobsForCurrentSession(listJobs(workspaceRoot), options));
  const maxJobs = options.maxJobs ?? DEFAULT_MAX_STATUS_JOBS;
  const maxProgressLines = options.maxProgressLines ?? DEFAULT_MAX_PROGRESS_LINES;

  const activeJobs = jobs.filter((job) => job.status === "queued" || job.status === "running");
  const livePids = getLiveJobPids(activeJobs, options);
  const running = activeJobs.map((job) => enrichJob(job, { maxProgressLines, workspaceRoot, livePids }));

  const latestFinishedRaw = jobs.find((job) => job.status !== "queued" && job.status !== "running") ?? null;
  const latestFinished = latestFinishedRaw ? enrichJob(latestFinishedRaw, { maxProgressLines, workspaceRoot, livePids }) : null;

  const recent = (options.all ? jobs : jobs.slice(0, maxJobs))
    .filter((job) => job.status !== "queued" && job.status !== "running" && job.id !== latestFinished?.id)
    .map((job) => enrichJob(job, { maxProgressLines, workspaceRoot, livePids }));

  return {
    workspaceRoot,
    config,
    sessionRuntime: getSessionRuntimeStatus(options.env, workspaceRoot),
    running,
    latestFinished,
    recent,
    needsReview: Boolean(config.stopReviewGate)
  };
}

export function buildSingleJobSnapshot(cwd, reference, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const jobs = sortJobsNewestFirst(listJobs(workspaceRoot));
  const selected = matchJobReference(jobs, reference);
  if (!selected) {
    throw new Error(`No job found for "${reference}". Run /codex:status to inspect known jobs.`);
  }

  const livePids = getLiveJobPids([selected], options);
  return {
    workspaceRoot,
    job: enrichJob(selected, { maxProgressLines: options.maxProgressLines, workspaceRoot, livePids })
  };
}

export function resolveResultJob(cwd, reference) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const jobs = sortJobsNewestFirst(reference ? listJobs(workspaceRoot) : filterJobsForCurrentSession(listJobs(workspaceRoot)));
  const selected = matchJobReference(
    jobs,
    reference,
    (job) => job.status === "completed" || job.status === "failed" || job.status === "cancelled"
  );

  if (selected) {
    return { workspaceRoot, job: selected };
  }

  const active = matchJobReference(jobs, reference, (job) => job.status === "queued" || job.status === "running");
  if (active) {
    throw new Error(`Job ${active.id} is still ${active.status}. Check /codex:status and try again once it finishes.`);
  }

  if (reference) {
    throw new Error(`No finished job found for "${reference}". Run /codex:status to inspect active jobs.`);
  }

  throw new Error("No finished Codex jobs found for this repository yet.");
}

export function resolveCancelableJob(cwd, reference, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const jobs = sortJobsNewestFirst(listJobs(workspaceRoot));
  const activeJobs = jobs.filter((job) => job.status === "queued" || job.status === "running");

  if (reference) {
    const selected = matchJobReference(activeJobs, reference);
    if (!selected) {
      throw new Error(`No active job found for "${reference}".`);
    }
    return { workspaceRoot, job: selected };
  }

  const sessionScopedActiveJobs = filterJobsForCurrentSession(activeJobs, options);

  if (sessionScopedActiveJobs.length === 1) {
    return { workspaceRoot, job: sessionScopedActiveJobs[0] };
  }
  if (sessionScopedActiveJobs.length > 1) {
    throw new Error("Multiple Codex jobs are active. Pass a job id to /codex:cancel.");
  }

  if (getCurrentSessionId(options)) {
    throw new Error("No active Codex jobs to cancel for this session.");
  }

  throw new Error("No active Codex jobs to cancel.");
}
