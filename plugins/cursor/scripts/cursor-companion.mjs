#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { parseArgs, splitRawArgumentString } from "./lib/args.mjs";
import {
  buildInstallHint,
  DEFAULT_CONTINUE_PROMPT,
  getCursorAuthStatus,
  getCursorAvailability,
  parseStructuredOutput,
  readOutputSchema,
  reapWslAgent,
  runCursorTurn,
  winPathToWsl
} from "./lib/cursor.mjs";
import { readStdinIfPiped } from "./lib/fs.mjs";
import {
  captureWorkingTreeFingerprintSafe,
  collectReviewContext,
  createReviewWorktree,
  detectWorkspaceDrift,
  ensureGitRepository,
  pruneStaleReviewWorktrees,
  removeReviewWorktree,
  renderWorkspaceDriftSection,
  resolveReviewTarget
} from "./lib/git.mjs";
import {
  binaryAvailable,
  captureProcessOwnership,
  getProcessIdentity,
  getOwnWindowsProcessIdentity,
  matchesWindowsIdentity,
  probeWindowsProcessIdentity,
  isWindowsProcessIdentity,
  terminateProcessTree
} from "./lib/process.mjs";
import { loadPromptTemplate, interpolateTemplate } from "./lib/prompts.mjs";
import {
  generateJobId,
  listJobs,
  readStartupMetrics,
  resolveStateDir,
  upsertJob,
  writeCancelFlag,
  writeJobFile
} from "./lib/state.mjs";
import {
  buildSingleJobSnapshot,
  buildStatusSnapshot,
  getLiveJobPids,
  readStoredJob,
  resolveCancelableJob,
  resolveResultJob
} from "./lib/job-control.mjs";
import {
  buildLivenessProbe,
  buildStartupOverheadCheck,
  buildStateHygieneChecks,
  renderDoctorReport,
  runDoctorChecks
} from "./lib/doctor.mjs";
import {
  appendLogLine,
  createJobLogFile,
  createJobProgressUpdater,
  createJobRecord,
  createProgressReporter,
  nowIso,
  runTrackedJob
} from "./lib/tracked-jobs.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";
import {
  renderReviewResult,
  renderStoredJobResult,
  renderCancelReport,
  renderJobStatusReport,
  renderSetupReport,
  renderStatusReport,
  renderTaskResult
} from "./lib/render.mjs";

const ROOT_DIR = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const REVIEW_SCHEMA = path.join(ROOT_DIR, "schemas", "review-output.schema.json");
const DEFAULT_STATUS_WAIT_TIMEOUT_MS = 240000;
const DEFAULT_STATUS_POLL_INTERVAL_MS = 2000;
const MAX_TELEMETRY_ITEMS = 100;

export function boundTelemetryItems(items) {
  const list = Array.isArray(items) ? items : [];
  if (list.length <= MAX_TELEMETRY_ITEMS) {
    return list;
  }
  const half = Math.floor(MAX_TELEMETRY_ITEMS / 2);
  return [...list.slice(0, half), { truncated: list.length - MAX_TELEMETRY_ITEMS }, ...list.slice(-half)];
}

function printUsage() {
  console.log(
    [
      "Usage:",
      "  node scripts/cursor-companion.mjs setup [--json]",
      "  node scripts/cursor-companion.mjs doctor [--json]",
      "  node scripts/cursor-companion.mjs review [--wait|--background] [--base <ref>] [--scope <auto|working-tree|branch>] [--model <model>] [--json]",
      "  node scripts/cursor-companion.mjs adversarial-review [--wait|--background] [--base <ref>] [--scope <auto|working-tree|branch>] [--model <model>] [--json] [focus text]",
      "  node scripts/cursor-companion.mjs task [--background] [--write] [--model <model>] [--resume <chat-id>] [--prompt-file <path>] [prompt]",
      "  node scripts/cursor-companion.mjs status [job-id] [--wait] [--timeout-ms <ms>] [--poll-interval-ms <ms>] [--all] [--json]",
      "  node scripts/cursor-companion.mjs result [job-id] [--json]",
      "  node scripts/cursor-companion.mjs cancel [job-id] [--json]",
      "  node scripts/cursor-companion.mjs task-worker --job-id <id> (internal)",
      "  node scripts/cursor-companion.mjs help",
      "",
      "Notes:",
      "  - task also accepts the prompt from piped stdin.",
      "  - resume a chat outside Claude with `cursor-agent --resume <chat-id>`.",
      "  - every subcommand accepts --cwd <path> (alias -C)."
    ].join("\n")
  );
}

function outputResult(value, asJson) {
  if (asJson) {
    console.log(JSON.stringify(value, null, 2));
  } else {
    process.stdout.write(value);
  }
}

function outputCommandResult(payload, rendered, asJson) {
  outputResult(asJson ? payload : rendered, asJson);
}

function normalizeRequestedModel(model) {
  if (model == null) {
    return null;
  }
  const normalized = String(model).trim();
  if (!normalized) {
    return null;
  }
  return normalized;
}

function normalizeArgv(argv) {
  if (argv.length === 1) {
    const [raw] = argv;
    if (!raw || !raw.trim()) {
      return [];
    }
    return splitRawArgumentString(raw);
  }
  return argv;
}

function parseCommandInput(argv, config = {}) {
  return parseArgs(normalizeArgv(argv), {
    ...config,
    aliasMap: {
      C: "cwd",
      ...(config.aliasMap ?? {})
    }
  });
}

function resolveCommandCwd(options = {}) {
  return options.cwd ? path.resolve(process.cwd(), options.cwd) : process.cwd();
}

function resolveCommandWorkspace(options = {}) {
  return resolveWorkspaceRoot(resolveCommandCwd(options));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shorten(text, limit = 96) {
  const normalized = String(text ?? "").trim().replace(/\s+/g, " ");
  if (!normalized) {
    return "";
  }
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit - 3)}...`;
}

function firstMeaningfulLine(text, fallback) {
  const line = String(text ?? "")
    .split(/\r?\n/)
    .map((value) => value.trim())
    .find(Boolean);
  return line ?? fallback;
}

async function buildSetupReport(cwd, actionsTaken = []) {
  const nodeStatus = binaryAvailable("node", ["--version"], { cwd });
  const cursorStatus = getCursorAvailability(cwd);
  const authStatus = await getCursorAuthStatus(cwd);

  const nextSteps = [];
  if (!cursorStatus.available) {
    nextSteps.push(
      process.platform === "win32"
        ? "There is no native Windows build of cursor-agent. Install it inside WSL with `curl https://cursor.com/install -fsS | bash`."
        : "Install the Cursor CLI with `curl https://cursor.com/install -fsS | bash`."
    );
  }
  if (cursorStatus.available && !authStatus.loggedIn) {
    nextSteps.push(
      cursorStatus.transport === "wsl"
        ? "Run `cursor-agent login` inside WSL, or set the CURSOR_API_KEY environment variable."
        : "Run `cursor-agent login`, or set the CURSOR_API_KEY environment variable."
    );
  }

  return {
    ready: nodeStatus.available && cursorStatus.available && authStatus.loggedIn,
    node: nodeStatus,
    cursor: cursorStatus,
    auth: authStatus,
    platform: process.platform,
    actionsTaken,
    nextSteps
  };
}

async function handleSetup(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const report = await buildSetupReport(cwd);
  outputResult(options.json ? report : renderSetupReport(report), options.json);
}

async function handleDoctor(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });
  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);

  const cursorStatus = getCursorAvailability(cwd);
  const authStatus = cursorStatus.available ? await getCursorAuthStatus(cwd) : null;

  const checks = [
    {
      id: "cursor-cli",
      run: () => {
        if (cursorStatus.available) {
          const transportNote = cursorStatus.transport === "wsl" ? " via WSL" : "";
          return { status: "ok", message: `cursor-agent available${transportNote} (${cursorStatus.detail}).` };
        }
        return {
          status: "error",
          message:
            process.platform === "win32"
              ? `cursor-agent not found (${cursorStatus.detail}). There is no native Windows build — install it inside WSL with \`curl https://cursor.com/install -fsS | bash\`.`
              : `cursor-agent not found (${cursorStatus.detail}). Install it with \`curl https://cursor.com/install -fsS | bash\`.`
        };
      }
    },
    {
      id: "cursor-auth",
      run: () => {
        if (!authStatus) {
          return { status: "warning", message: "Skipped: cursor-agent is unavailable." };
        }
        if (authStatus.loggedIn) {
          return { status: "ok", message: "Cursor is authenticated." };
        }
        return {
          status: "error",
          message:
            cursorStatus.transport === "wsl"
              ? "Cursor is not logged in — run `cursor-agent login` inside WSL, or set CURSOR_API_KEY."
              : "Cursor is not logged in — run `cursor-agent login`, or set CURSOR_API_KEY."
        };
      }
    },
    ...buildStateHygieneChecks({
      stateDir: resolveStateDir(workspaceRoot),
      jobs: listJobs(workspaceRoot),
      getLiveJobPidsImpl: buildLivenessProbe((jobs) => getLiveJobPids(jobs)),
      commandPrefix: "/cursor"
    }),
    buildStartupOverheadCheck(() => readStartupMetrics(workspaceRoot))
  ];

  const report = await runDoctorChecks(checks);
  outputResult(options.json ? report : renderDoctorReport(report, { title: "Cursor Doctor" }), options.json);
}

function buildReviewPrompt(context, focusText, reviewName) {
  const template = loadPromptTemplate(ROOT_DIR, "adversarial-review");
  const prompt = interpolateTemplate(template, {
    REVIEW_KIND: reviewName,
    TARGET_LABEL: context.target.label,
    USER_FOCUS: focusText || "No extra focus provided.",
    REVIEW_COLLECTION_GUIDANCE: context.collectionGuidance,
    REVIEW_INPUT: context.content
  });
  // cursor-agent has no structured-output flag, so the schema contract rides
  // inside the prompt itself.
  const schema = readOutputSchema(REVIEW_SCHEMA);
  return [
    prompt,
    "",
    // cursor-agent has no enforced read-only sandbox (--trust suppresses the
    // write prompt), so the no-write rule must ride in the prompt and any
    // violation is surfaced by the post-run workspace-drift check.
    "Never create, modify, or delete files in the workspace: you are reviewing, not editing. Do not write helper scripts, notes, or diff dumps to disk.",
    "",
    "<output_schema>",
    "Your final message must be only valid JSON matching this JSON Schema. Do not wrap it in markdown fences.",
    JSON.stringify(schema, null, 2),
    "</output_schema>"
  ].join("\n");
}

function ensureCursorAvailable(cwd) {
  const availability = getCursorAvailability(cwd);
  if (!availability.available) {
    throw new Error(buildInstallHint());
  }
}

function validatePlainReviewRequest(focusText) {
  if (focusText.trim()) {
    throw new Error(
      `\`/cursor:review\` does not support custom focus text. Retry with \`/cursor:adversarial-review ${focusText.trim()}\` for focused review instructions.`
    );
  }
}

function renderStatusPayload(report, asJson) {
  return asJson ? report : renderStatusReport(report);
}

function isActiveJobStatus(status) {
  return status === "queued" || status === "running";
}

async function waitForSingleJobSnapshot(cwd, reference, options = {}) {
  const timeoutMs = Math.max(0, Number(options.timeoutMs) || DEFAULT_STATUS_WAIT_TIMEOUT_MS);
  const pollIntervalMs = Math.max(100, Number(options.pollIntervalMs) || DEFAULT_STATUS_POLL_INTERVAL_MS);
  const deadline = Date.now() + timeoutMs;
  let snapshot = buildSingleJobSnapshot(cwd, reference);

  while (isActiveJobStatus(snapshot.job.status) && Date.now() < deadline) {
    await sleep(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())));
    snapshot = buildSingleJobSnapshot(cwd, reference);
  }

  return {
    ...snapshot,
    waitTimedOut: isActiveJobStatus(snapshot.job.status),
    timeoutMs
  };
}

async function executeReviewRun(request) {
  ensureCursorAvailable(request.cwd);
  ensureGitRepository(request.cwd);

  const target = resolveReviewTarget(request.cwd, {
    base: request.base,
    scope: request.scope
  });
  const focusText = request.focusText?.trim() ?? "";
  const reviewName = request.reviewName ?? "Review";
  if (reviewName === "Review") {
    validatePlainReviewRequest(focusText);
  }

  const context = collectReviewContext(request.cwd, target);
  const prompt = buildReviewPrompt(context, focusText, reviewName);
  const treeBefore = captureWorkingTreeFingerprintSafe(context.repoRoot);

  // Cursor has no enforced read-only sandbox, so run the agent inside a
  // disposable worktree: writes land there and are thrown away instead of
  // reaching the user's tree. Review CONTENT is still collected from the real
  // repo above, so what gets reviewed is unchanged. Sweep leaked worktrees
  // from previously killed runs first.
  pruneStaleReviewWorktrees(context.repoRoot);
  const usesWsl = getCursorAvailability(request.cwd).transport === "wsl";
  const worktree = createReviewWorktree(context.repoRoot, {
    includeUncommitted: target.mode === "working-tree",
    translateGitdir: usesWsl ? winPathToWsl : undefined
  });
  const runRoot = worktree.isolated ? worktree.path : context.repoRoot;
  request.onProgress?.(
    worktree.isolated
      ? "Review running in an isolated worktree."
      : `Review running in the workspace: isolation unavailable (${worktree.reason}).`
  );

  let result;
  try {
    result = await runCursorTurn(runRoot, {
      prompt,
      model: request.model,
      write: false,
      onProgress: request.onProgress,
      onWslAgentPid: request.onWslAgentPid
    });
  } finally {
    removeReviewWorktree(worktree);
  }
  // Drift detection stays on the REAL repo as defense in depth: it proves the
  // isolation held (and still catches writes when isolation was unavailable).
  const workspaceDrift = detectWorkspaceDrift(treeBefore, context.repoRoot);
  const parsed = parseStructuredOutput(result.finalMessage, {
    status: result.status,
    failureMessage: result.error?.message ?? result.stderr
  });
  const payload = {
    review: reviewName,
    target,
    threadId: result.threadId,
    context: {
      repoRoot: context.repoRoot,
      branch: context.branch,
      summary: context.summary
    },
    cursor: {
      status: result.status,
      stderr: result.stderr,
      stdout: result.finalMessage
    },
    result: parsed.parsed,
    rawOutput: parsed.rawOutput,
    parseError: parsed.parseError,
    transport: result.transport ?? null,
    transportReason: result.transportReason ?? null,
    model: result.model ?? null,
    workspaceDrift,
    isolation: worktree.isolated ? "worktree" : "none",
    isolationReason: worktree.isolated ? null : worktree.reason
  };

  return {
    exitStatus: result.status,
    threadId: result.threadId,
    turnId: result.turnId,
    payload,
    rendered:
      renderReviewResult(parsed, {
        reviewLabel: reviewName,
        targetLabel: context.target.label,
        threadId: result.threadId
      }) +
      (worktree.isolated
        ? ""
        : `\n\n> Note: this review ran in your workspace, not an isolated worktree (${worktree.reason}). Cursor has no enforced read-only sandbox, so any writes would land in your tree.`) +
      renderWorkspaceDriftSection(workspaceDrift),
    summary: parsed.parsed?.summary ?? parsed.parseError ?? firstMeaningfulLine(result.finalMessage, `${reviewName} finished.`),
    jobTitle: `Cursor ${reviewName}`,
    jobClass: "review",
    targetLabel: context.target.label
  };
}

async function executeTaskRun(request) {
  const workspaceRoot = resolveWorkspaceRoot(request.cwd);
  ensureCursorAvailable(request.cwd);

  const taskMetadata = buildTaskRunMetadata({
    prompt: request.prompt,
    resumeChatId: request.resumeChatId
  });

  if (!request.prompt && !request.resumeChatId) {
    throw new Error("Provide a prompt, a prompt file, piped stdin, or --resume <chat-id>.");
  }

  const result = await runCursorTurn(workspaceRoot, {
    prompt: request.prompt,
    defaultPrompt: request.resumeChatId ? DEFAULT_CONTINUE_PROMPT : "",
    model: request.model,
    resumeChatId: request.resumeChatId,
    write: request.write,
    onProgress: request.onProgress,
    onWslAgentPid: request.onWslAgentPid
  });

  const rawOutput = typeof result.finalMessage === "string" ? result.finalMessage : "";
  const failureMessage = result.error?.message ?? result.stderr ?? "";
  const rendered = renderTaskResult(
    {
      rawOutput,
      failureMessage
    },
    {
      title: taskMetadata.title,
      jobId: request.jobId ?? null,
      write: Boolean(request.write),
      threadId: result.threadId
    }
  );
  const payload = {
    status: result.status,
    threadId: result.threadId,
    rawOutput,
    touchedFiles: result.touchedFiles,
    fileChanges: boundTelemetryItems(result.fileChanges),
    commandExecutions: boundTelemetryItems(result.commandExecutions),
    reasoningSummary: result.reasoningSummary,
    tokenUsage: result.turn?.tokenUsage ?? null,
    durationMs: result.durationMs ?? null,
    transport: result.transport ?? null,
    transportReason: result.transportReason ?? null,
    model: result.model ?? null
  };

  return {
    exitStatus: result.status,
    threadId: result.threadId,
    turnId: result.turnId,
    payload,
    rendered,
    summary: firstMeaningfulLine(rawOutput, firstMeaningfulLine(failureMessage, `${taskMetadata.title} finished.`)),
    jobTitle: taskMetadata.title,
    jobClass: "task",
    write: Boolean(request.write)
  };
}

function buildReviewJobMetadata(reviewName, target) {
  return {
    kind: reviewName === "Adversarial Review" ? "adversarial-review" : "review",
    title: `Cursor ${reviewName}`,
    summary: `${reviewName} ${target.label}`
  };
}

function buildTaskRunMetadata({ prompt, resumeChatId = null }) {
  const title = resumeChatId ? "Cursor Resume" : "Cursor Task";
  const fallbackSummary = resumeChatId ? DEFAULT_CONTINUE_PROMPT : "Task";
  return {
    title,
    summary: shorten(prompt || fallbackSummary)
  };
}

function renderQueuedTaskLaunch(payload) {
  return `${payload.title} started in the background as ${payload.jobId}. Check /cursor:status ${payload.jobId} for progress.\n`;
}

function createCompanionJob({ prefix, kind, title, workspaceRoot, jobClass, summary, write = false }) {
  return createJobRecord({
    id: generateJobId(prefix),
    kind,
    kindLabel: kind,
    title,
    workspaceRoot,
    jobClass,
    summary,
    write
  });
}

function createTrackedProgress(job, options = {}) {
  const logFile = options.logFile ?? createJobLogFile(job.workspaceRoot, job.id, job.title);
  return {
    logFile,
    progress: createProgressReporter({
      stderr: Boolean(options.stderr),
      logFile,
      onEvent: createJobProgressUpdater(job.workspaceRoot, job.id)
    })
  };
}

function buildTaskJob(workspaceRoot, taskMetadata, write) {
  return createCompanionJob({
    prefix: "task",
    kind: "task",
    title: taskMetadata.title,
    workspaceRoot,
    jobClass: "task",
    summary: taskMetadata.summary,
    write
  });
}

function buildTaskRequest({ cwd, model, prompt, write, resumeChatId, jobId }) {
  return {
    cwd,
    model,
    prompt,
    write,
    resumeChatId,
    jobId
  };
}

function readTaskPrompt(cwd, options, positionals) {
  if (options["prompt-file"]) {
    return fs.readFileSync(path.resolve(cwd, options["prompt-file"]), "utf8");
  }

  const positionalPrompt = positionals.join(" ");
  return positionalPrompt || readStdinIfPiped();
}

function requireTaskRequest(prompt, resumeChatId) {
  if (!prompt && !resumeChatId) {
    throw new Error("Provide a prompt, a prompt file, piped stdin, or --resume <chat-id>.");
  }
}

function persistWslAgentIdentity(workspaceRoot, jobId) {
  return (wslAgentPid, wslAgentStartTime) => {
    // Persist the Linux-side agent (pid, starttime) as soon as it is known
    // so a concurrent cancel can reap the agent inside the distro and prove
    // it is signalling the process we spawned, not a reused PID.
    try {
      const current = readStoredJob(workspaceRoot, jobId) ?? {};
      writeJobFile(workspaceRoot, jobId, {
        ...current,
        wslAgentPid,
        wslAgentStartTime: wslAgentStartTime ?? null,
        transport: "wsl"
      });
      upsertJob(workspaceRoot, { id: jobId, wslAgentPid, wslAgentStartTime: wslAgentStartTime ?? null });
    } catch {
      // Best-effort persistence; the job continues either way.
    }
  };
}

async function runForegroundCommand(job, runner, options = {}) {
  const { logFile, progress } = createTrackedProgress(job, {
    logFile: options.logFile,
    stderr: !options.json
  });
  const execution = await runTrackedJob(job, () => runner(progress), { logFile });
  outputResult(options.json ? execution.payload : execution.rendered, options.json);
  if (execution.exitStatus !== 0) {
    process.exitCode = execution.exitStatus;
  }
  return execution;
}

function spawnDetachedTaskWorker(cwd, jobId) {
  const scriptPath = path.join(ROOT_DIR, "scripts", "cursor-companion.mjs");
  const child = spawn(process.execPath, [scriptPath, "task-worker", "--cwd", cwd, "--job-id", jobId], {
    cwd,
    env: process.env,
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });
  child.unref();
  return child;
}

function recordTaskWorkerSpawnFailure(workspaceRoot, jobId, error) {
  const storedJob = readStoredJob(workspaceRoot, jobId);
  if (!storedJob || storedJob.status !== "queued" || storedJob.pid != null) {
    return;
  }

  const errorMessage = error instanceof Error ? error.message : String(error);
  const completedAt = nowIso();
  const failedRecord = {
    ...storedJob,
    status: "failed",
    phase: "failed",
    pid: null,
    errorMessage,
    completedAt
  };
  writeJobFile(workspaceRoot, jobId, failedRecord);
  upsertJob(workspaceRoot, {
    id: jobId,
    status: "failed",
    phase: "failed",
    pid: null,
    errorMessage,
    completedAt
  });
  appendLogLine(storedJob.logFile, `Worker spawn failed: ${errorMessage}`);
}

export function enqueueBackgroundTask(cwd, job, request, dependencies = {}) {
  const { logFile } = createTrackedProgress(job);
  appendLogLine(logFile, "Queued for background execution.");

  const queuedRecord = {
    ...job,
    status: "queued",
    phase: "queued",
    pid: null,
    logFile,
    request
  };
  writeJobFile(job.workspaceRoot, job.id, queuedRecord);
  upsertJob(job.workspaceRoot, queuedRecord);

  const spawnWorker = dependencies.spawnDetachedTaskWorkerImpl ?? spawnDetachedTaskWorker;
  let worker;
  try {
    worker = spawnWorker(cwd, job.id);
  } catch (error) {
    recordTaskWorkerSpawnFailure(job.workspaceRoot, job.id, error);
    throw error;
  }
  worker?.once?.("error", (error) => {
    recordTaskWorkerSpawnFailure(job.workspaceRoot, job.id, error);
  });

  return {
    payload: {
      jobId: job.id,
      status: "queued",
      title: job.title,
      summary: job.summary,
      logFile
    },
    logFile
  };
}

async function handleReviewCommand(argv, config) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["base", "scope", "model", "cwd"],
    booleanOptions: ["json", "background", "wait"],
    aliasMap: {
      m: "model"
    }
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const focusText = positionals.join(" ").trim();
  const target = resolveReviewTarget(cwd, {
    base: options.base,
    scope: options.scope
  });

  if (config.reviewName === "Review") {
    validatePlainReviewRequest(focusText);
  }
  const metadata = buildReviewJobMetadata(config.reviewName, target);
  const job = createCompanionJob({
    prefix: "review",
    kind: metadata.kind,
    title: metadata.title,
    workspaceRoot,
    jobClass: "review",
    summary: metadata.summary
  });
  await runForegroundCommand(
    job,
    (progress) =>
      executeReviewRun({
        cwd,
        base: options.base,
        scope: options.scope,
        model: normalizeRequestedModel(options.model),
        focusText,
        reviewName: config.reviewName,
        onProgress: progress,
        onWslAgentPid: persistWslAgentIdentity(workspaceRoot, job.id)
      }),
    { json: options.json }
  );
}

async function handleTask(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["model", "cwd", "prompt-file", "resume"],
    booleanOptions: ["json", "write", "background"],
    aliasMap: {
      m: "model"
    }
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const model = normalizeRequestedModel(options.model);
  const prompt = readTaskPrompt(cwd, options, positionals);
  const resumeChatId = typeof options.resume === "string" && options.resume.trim() ? options.resume.trim() : null;
  const write = Boolean(options.write);
  const taskMetadata = buildTaskRunMetadata({
    prompt,
    resumeChatId
  });

  if (options.background) {
    ensureCursorAvailable(cwd);
    requireTaskRequest(prompt, resumeChatId);

    const job = buildTaskJob(workspaceRoot, taskMetadata, write);
    const request = buildTaskRequest({
      cwd,
      model,
      prompt,
      write,
      resumeChatId,
      jobId: job.id
    });
    const { payload } = enqueueBackgroundTask(cwd, job, request);
    outputCommandResult(payload, renderQueuedTaskLaunch(payload), options.json);
    return;
  }

  const job = buildTaskJob(workspaceRoot, taskMetadata, write);
  await runForegroundCommand(
    job,
    (progress) =>
      executeTaskRun({
        cwd,
        model,
        prompt,
        write,
        resumeChatId,
        jobId: job.id,
        onProgress: progress,
        onWslAgentPid: persistWslAgentIdentity(workspaceRoot, job.id)
      }),
    { json: options.json }
  );
}

export async function handleTaskWorker(argv, dependencies = {}) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd", "job-id"]
  });

  if (!options["job-id"]) {
    throw new Error("Missing required --job-id for task-worker.");
  }

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const storedJob = readStoredJob(workspaceRoot, options["job-id"]);
  if (!storedJob) {
    throw new Error(`No stored job found for ${options["job-id"]}.`);
  }

  const {
    processIdentity: _storedProcessIdentity,
    ownershipSnapshot: _storedOwnershipSnapshot,
    ownershipCaptureFailed: _storedOwnershipCaptureFailed,
    ...storedTask
  } = storedJob;
  let workerOwnership;
  try {
    // Unix start-time identity where available; on win32 fall back to the
    // (pid, CreationDate) identity so cancel can prove the PID still belongs
    // to this worker before any taskkill.
    const processIdentity =
      (dependencies.getProcessIdentityImpl ?? getProcessIdentity)(process.pid) ??
      (process.platform === "win32"
        ? (dependencies.getWindowsProcessIdentityImpl ?? getOwnWindowsProcessIdentity)(process.pid)
        : null);
    workerOwnership = processIdentity ? { processIdentity } : { ownershipCaptureFailed: true };
  } catch {
    workerOwnership = { ownershipCaptureFailed: true };
  }
  if (workerOwnership.processIdentity) {
    // Snapshot only alongside a successful identity capture: a failed capture
    // must leave no partial ownership data behind.
    try {
      const ownershipSnapshot = (dependencies.captureProcessOwnershipImpl ?? captureProcessOwnership)(process.pid);
      if (ownershipSnapshot) {
        workerOwnership = { ...workerOwnership, ownershipSnapshot };
      }
    } catch {
      // Snapshot capture is best-effort; identity above still gates cancel.
    }
  }

  const request = storedJob.request;
  if (!request || typeof request !== "object") {
    throw new Error(`Stored job ${options["job-id"]} is missing its task request payload.`);
  }

  const { logFile, progress } = createTrackedProgress(
    {
      ...storedTask,
      workspaceRoot
    },
    {
      logFile: storedJob.logFile ?? null
    }
  );
  await (dependencies.runTrackedJobImpl ?? runTrackedJob)(
    {
      ...storedTask,
      workspaceRoot,
      logFile,
      ...workerOwnership
    },
    () =>
      executeTaskRun({
        ...request,
        onProgress: progress,
        onWslAgentPid: persistWslAgentIdentity(workspaceRoot, options["job-id"])
      }),
    { logFile }
  );
}

async function handleStatus(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd", "timeout-ms", "poll-interval-ms"],
    booleanOptions: ["json", "all", "wait"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  if (reference) {
    const snapshot = options.wait
      ? await waitForSingleJobSnapshot(cwd, reference, {
          timeoutMs: options["timeout-ms"],
          pollIntervalMs: options["poll-interval-ms"]
        })
      : buildSingleJobSnapshot(cwd, reference);
    outputCommandResult(snapshot, renderJobStatusReport(snapshot.job), options.json);
    return;
  }

  if (options.wait) {
    throw new Error("`status --wait` requires a job id.");
  }

  const report = buildStatusSnapshot(cwd, { all: options.all });
  outputResult(renderStatusPayload(report, options.json), options.json);
}

function handleResult(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  const { workspaceRoot, job } = resolveResultJob(cwd, reference);
  const storedJob = readStoredJob(workspaceRoot, job.id);
  const payload = {
    job,
    storedJob
  };

  outputCommandResult(payload, renderStoredJobResult(job, storedJob), options.json);
}

function finishCancelledJob(workspaceRoot, record, options) {
  appendLogLine(record.logFile, "Cancelled by user.");

  const completedAt = nowIso();
  const nextJob = {
    ...record,
    status: "cancelled",
    phase: "cancelled",
    pid: null,
    completedAt,
    errorMessage: "Cancelled by user."
  };

  writeJobFile(workspaceRoot, record.id, {
    ...nextJob,
    cancelledAt: completedAt
  });
  upsertJob(workspaceRoot, {
    id: record.id,
    status: "cancelled",
    phase: "cancelled",
    pid: null,
    errorMessage: "Cancelled by user.",
    completedAt
  });

  const payload = {
    jobId: record.id,
    status: "cancelled",
    title: record.title
  };

  outputCommandResult(payload, renderCancelReport(nextJob), options.json);
}

export async function handleCancel(argv, dependencies = {}) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  const { workspaceRoot, job } = resolveCancelableJob(cwd, reference, { env: process.env });
  let existing = readStoredJob(workspaceRoot, job.id) ?? {};
  let record = { ...job, ...existing };

  if (!Number.isFinite(record.pid)) {
    writeCancelFlag(workspaceRoot, job.id);
    existing = readStoredJob(workspaceRoot, job.id) ?? existing;
    record = { ...job, ...existing };
    if (!Number.isFinite(record.pid)) {
      finishCancelledJob(workspaceRoot, record, options);
      return;
    }
  }

  // Bind ownership proof from the merged record, not the job file alone:
  // progress updates rewrite the file with unlocked read-modify-write, so a
  // write that sampled the file before ownership landed can clobber those
  // fields — while the lock-serialized state index still carries them.
  const expectedRootIdentity = record.processIdentity ?? null;
  const ownershipCaptureFailed = record.ownershipCaptureFailed === true;
  writeCancelFlag(workspaceRoot, job.id);

  // WSL transport: reap the Linux-side agent FIRST. taskkill cannot terminate
  // wsl.exe relay processes ("operation is not supported"), but once the agent
  // dies inside the distro the relay tree collapses on its own — and killing
  // the Windows side alone would prove nothing about the agent anyway.
  let wslReap = null;
  if (Number.isFinite(record.wslAgentPid)) {
    wslReap = await (dependencies.reapWslAgentImpl ?? reapWslAgent)(record.wslAgentPid, {
      expectedStartTime: record.wslAgentStartTime ?? null
    });
    if (wslReap?.reaped !== true) {
      const survivors = wslReap?.survivors ?? [record.wslAgentPid];
      const failureMessage = wslReap?.probeUnavailable === true
        ? `The WSL probe for ${job.id} (pid ${survivors.join(", ")}) failed, so the agent's state is unknown; not marking cancelled.`
        : wslReap?.identityUnverified === true
          ? `The recorded starttime for ${job.id} (pid ${survivors.join(", ")}) could not be verified against /proc; not marking cancelled.`
          : `The WSL cursor-agent for ${job.id} (pid ${survivors.join(", ")}) survived TERM and KILL; not marking cancelled.`;
      appendLogLine(record.logFile, failureMessage);
      writeJobFile(workspaceRoot, job.id, {
        ...record,
        phase: "cleanup-pending",
        wslReap,
        cleanupFailure: failureMessage
      });
      upsertJob(workspaceRoot, {
        id: job.id,
        status: record.status,
        phase: "cleanup-pending",
        pid: record.pid,
        cleanupFailure: failureMessage
      });
      throw new Error(failureMessage);
    }
  }

  let cleanupOutcome = null;
  try {
    cleanupOutcome = await (dependencies.terminateProcessTreeImpl ?? terminateProcessTree)(record.pid, {
      expectedRootIdentity,
      ownershipSnapshot: record.ownershipSnapshot ?? null,
      requireVerifiedOwnership: ownershipCaptureFailed,
      priorCleanupDegraded: record.cleanupOutcome?.degraded === true
    });
  } catch (error) {
    // A resistant tree (e.g. a not-yet-collapsed wsl.exe relay) is not fatal:
    // the identity poll below decides whether the worker actually exited.
    appendLogLine(record.logFile, `Process tree termination for ${job.id} reported: ${error.message}`);
  }

  if (cleanupOutcome?.verified !== true && isWindowsProcessIdentity(expectedRootIdentity)) {
    // The worker exits by itself once its agent is gone and the cancel flag is
    // set; give it a short window and verify by identity. Only CONFIRMED
    // evidence flips the verdict: a probe failure keeps the cancel unverified
    // rather than reading as "the worker died".
    const probeImpl = dependencies.probeWindowsProcessIdentityImpl ?? probeWindowsProcessIdentity;
    const deadline = Date.now() + (dependencies.workerExitWaitMs ?? 5000);
    for (;;) {
      const probe = probeImpl(record.pid);
      if (probe.status === "absent" || (probe.status === "ok" && !matchesWindowsIdentity(expectedRootIdentity, probe.identity))) {
        cleanupOutcome = { ...(cleanupOutcome ?? {}), attempted: true, delivered: true, verified: true, method: "identity-poll" };
        break;
      }
      if (Date.now() > deadline) {
        break;
      }
      await sleep(250);
    }
  }

  if (cleanupOutcome?.verified !== true) {
    const failureMessage =
      ownershipCaptureFailed && !expectedRootIdentity
        ? `Job ${job.id} could not be verified as owned and was left alone.`
        : `Unable to verify cleanup for ${job.id}; ownership records were preserved for retry.`;
    appendLogLine(record.logFile, failureMessage);
    const recoveryRecord = {
      ...record,
      status: record.status,
      phase: "cleanup-pending",
      pid: record.pid,
      cleanupOutcome,
      cleanupFailure: failureMessage
    };
    writeJobFile(workspaceRoot, job.id, recoveryRecord);
    upsertJob(workspaceRoot, {
      id: job.id,
      status: record.status,
      phase: "cleanup-pending",
      pid: record.pid,
      cleanupOutcome,
      cleanupFailure: failureMessage
    });
    throw new Error(failureMessage);
  }

  finishCancelledJob(workspaceRoot, record, options);
}

async function main() {
  const [subcommand, ...argv] = process.argv.slice(2);
  if (!subcommand || subcommand === "help" || subcommand === "--help") {
    printUsage();
    return;
  }

  switch (subcommand) {
    case "setup":
      await handleSetup(argv);
      break;
    case "doctor":
      await handleDoctor(argv);
      break;
    case "review":
      await handleReviewCommand(argv, {
        reviewName: "Review"
      });
      break;
    case "adversarial-review":
      await handleReviewCommand(argv, {
        reviewName: "Adversarial Review"
      });
      break;
    case "task":
      await handleTask(argv);
      break;
    case "task-worker":
      await handleTaskWorker(argv);
      break;
    case "status":
      await handleStatus(argv);
      break;
    case "result":
      handleResult(argv);
      break;
    case "cancel":
      await handleCancel(argv);
      break;
    default:
      throw new Error(`Unknown subcommand: ${subcommand}`);
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
