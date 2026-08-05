/**
 * Adapter for Cursor's headless CLI (`cursor-agent`).
 *
 * Every job is one `cursor-agent -p <prompt> --output-format stream-json`
 * process; there is no shared-server mode. On win32 there is no native build,
 * so the adapter falls back to running the Linux binary through WSL with pure
 * argv passing (never a shell string).
 *
 * @typedef {((update: string | { message: string, phase: string | null, threadId?: string | null, turnId?: string | null, stderrMessage?: string | null, logTitle?: string | null, logBody?: string | null }) => void)} ProgressReporter
 * @typedef {{
 *   kind: "direct" | "node-script" | "cmd-shim" | "wsl",
 *   file: string,
 *   prefix?: string[],
 *   cmdPath?: string
 * }} CursorSpawnPlan
 * @typedef {{
 *   available: boolean,
 *   detail: string,
 *   transport: "native" | "wsl" | null,
 *   transportReason: string | null,
 *   binaryPath: string | null,
 *   plan: CursorSpawnPlan | null
 * }} CursorInvocation
 */
import { spawn, spawnSync } from "node:child_process";
import process from "node:process";

import { readJsonFile } from "./fs.mjs";
import { binaryAvailable, runCommand } from "./process.mjs";

const TEST_BINARY_ENV = "CURSOR_COMPANION_TEST_BINARY";
const WSL_PROBE_TIMEOUT_MS = 30 * 1000;
const DEFAULT_CONTINUE_PROMPT =
  "Continue from the current chat state. Pick the next highest-value step and follow through until the task is resolved.";

const MAX_CLEAN_STDERR_BYTES = 32 * 1024;
const STDERR_ANSI_PATTERN = /\u001b\[[0-9;?]*[A-Za-z]/g;
const STDERR_TIMESTAMP_PATTERN = /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?/g;
const STDERR_PATH_PATTERN = /(?:[A-Za-z]:)?(?:[\\/][^\s:\\/]+){2,}[\\/]?/g;

const FILE_CHANGE_TOOL_PATTERN = /^(write|edit|create|delete|remove|move|rename|apply)/i;
const SHELL_TOOL_PATTERN = /(shell|terminal|command|bash|exec)/i;

function stderrLineSignature(line) {
  return line
    .replace(STDERR_ANSI_PATTERN, "")
    .replace(STDERR_TIMESTAMP_PATTERN, "<timestamp>")
    .replace(STDERR_PATH_PATTERN, "<path>")
    .trim();
}

function collapseRepeatedStderrLines(lines) {
  const collapsed = [];
  let index = 0;
  while (index < lines.length) {
    const signature = stderrLineSignature(lines[index]);
    let runLength = 1;
    while (index + runLength < lines.length && stderrLineSignature(lines[index + runLength]) === signature) {
      runLength += 1;
    }
    collapsed.push(lines[index]);
    if (runLength > 1) {
      const suppressed = runLength - 1;
      collapsed.push(`... (${suppressed} similar ${suppressed === 1 ? "line" : "lines"} suppressed)`);
    }
    index += runLength;
  }
  return collapsed;
}

function truncateStderrMiddle(text, maxBytes = MAX_CLEAN_STDERR_BYTES) {
  const totalBytes = Buffer.byteLength(text, "utf8");
  if (totalBytes <= maxBytes) {
    return text;
  }
  const budget = Math.floor(maxBytes / 2);
  let head = text.slice(0, budget);
  const headBreak = head.lastIndexOf("\n");
  if (headBreak > 0) {
    head = head.slice(0, headBreak);
  }
  let tail = text.slice(-budget);
  const tailBreak = tail.indexOf("\n");
  if (tailBreak >= 0 && tailBreak < tail.length - 1) {
    tail = tail.slice(tailBreak + 1);
  }
  const omittedBytes = totalBytes - Buffer.byteLength(head, "utf8") - Buffer.byteLength(tail, "utf8");
  return `${head}\n... (${omittedBytes} bytes omitted) ...\n${tail}`;
}

function cleanCursorStderr(stderr) {
  const lines = stderr
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean);
  return truncateStderrMiddle(collapseRepeatedStderrLines(lines).join("\n"));
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

function looksLikeVerificationCommand(command) {
  return /\b(test|tests|lint|build|typecheck|type-check|check|verify|validate|pytest|jest|vitest|cargo test|npm test|pnpm test|yarn test|go test|mvn test|gradle test|tsc|eslint|ruff)\b/i.test(
    command
  );
}

/**
 * @param {ProgressReporter | null | undefined} onProgress
 * @param {string | null | undefined} message
 * @param {string | null | undefined} [phase]
 */
function emitProgress(onProgress, message, phase = null, extra = {}) {
  if (!onProgress || !message) {
    return;
  }
  if (!phase && Object.keys(extra).length === 0) {
    onProgress(message);
    return;
  }
  onProgress({ message, phase, ...extra });
}

function emitLogEvent(onProgress, options = {}) {
  if (!onProgress) {
    return;
  }

  onProgress({
    message: options.message ?? "",
    phase: options.phase ?? null,
    stderrMessage: options.stderrMessage ?? null,
    logTitle: options.logTitle ?? null,
    logBody: options.logBody ?? null
  });
}

export function buildInstallHint() {
  return process.platform === "win32"
    ? "Cursor CLI is not installed. There is no native Windows build; install it inside WSL with `curl https://cursor.com/install -fsS | bash`, then rerun `/cursor:setup`."
    : "Cursor CLI is not installed. Install it with `curl https://cursor.com/install -fsS | bash`, then rerun `/cursor:setup`.";
}

/**
 * Translate a Windows path into its WSL mount path
 * (e.g. `C:\foo\bar` -> `/mnt/c/foo/bar`).
 */
export function winPathToWsl(windowsPath) {
  const normalized = String(windowsPath ?? "").replace(/\\/g, "/");
  const driveMatch = normalized.match(/^([A-Za-z]):(\/.*)?$/);
  if (!driveMatch) {
    return normalized;
  }
  const drive = driveMatch[1].toLowerCase();
  const rest = driveMatch[2] ?? "/";
  return `/mnt/${drive}${rest}`;
}

// Quote one argument for a `cmd.exe /d /s /c "..."` command line, following
// CommandLineToArgvW rules. cmd.exe metacharacters inside quotes (notably `%`
// and `!`) can still expand; this path only exists for .cmd test shims.
function quoteWindowsArg(value) {
  const text = String(value);
  if (text !== "" && !/[\s"&|<>^%!()]/.test(text)) {
    return text;
  }
  return `"${text.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1")}"`;
}

/** @returns {CursorSpawnPlan} */
function buildNativeSpawnPlan(binaryPath) {
  if (/\.(mjs|cjs|js)$/i.test(binaryPath)) {
    return { kind: "node-script", file: process.execPath, prefix: [binaryPath] };
  }
  if (process.platform === "win32" && /\.(cmd|bat)$/i.test(binaryPath)) {
    return { kind: "cmd-shim", file: process.env.comspec || "cmd.exe", cmdPath: binaryPath };
  }
  return { kind: "direct", file: binaryPath, prefix: [] };
}

/** @returns {CursorSpawnPlan} */
function buildPathSpawnPlan(cwd) {
  if (process.platform !== "win32") {
    return { kind: "direct", file: "cursor-agent", prefix: [] };
  }

  // The PATH probe runs through a shell, but spawn(..., { shell: false })
  // cannot launch .cmd shims on Windows. Resolve the real file behind the
  // PATH entry so the turn spawn stays argv-only.
  const where = runCommand("where", ["cursor-agent"], { cwd, shell: false });
  const candidates =
    !where.error && where.status === 0
      ? where.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
      : [];
  const executable = candidates.find((candidate) => /\.(exe|com)$/i.test(candidate));
  if (executable) {
    return { kind: "direct", file: executable, prefix: [] };
  }
  const script = candidates.find((candidate) => /\.(mjs|cjs|js)$/i.test(candidate));
  if (script) {
    return buildNativeSpawnPlan(script);
  }
  const shim = candidates.find((candidate) => /\.(cmd|bat)$/i.test(candidate));
  if (shim) {
    return buildNativeSpawnPlan(shim);
  }
  return { kind: "direct", file: "cursor-agent", prefix: [] };
}

function planCommandLine(plan, args) {
  if (plan.kind === "cmd-shim") {
    return {
      file: plan.file,
      args: ["/d", "/s", "/c", [plan.cmdPath, ...args].map(quoteWindowsArg).join(" ")],
      options: { windowsVerbatimArguments: true }
    };
  }
  return { file: plan.file, args: [...(plan.prefix ?? []), ...args], options: {} };
}

function runPlanSync(plan, args, options = {}) {
  const line = planCommandLine(plan, args);
  const result = spawnSync(line.file, line.args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: "utf8",
    timeout: options.timeout,
    shell: false,
    windowsHide: true,
    ...line.options
  });

  return {
    status: result.status ?? 0,
    signal: result.signal ?? null,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error ?? null
  };
}

function describeRunFailure(result) {
  if (result.error) {
    return result.error.message;
  }
  return result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`;
}

/** @returns {CursorInvocation} */
function unavailableInvocation(detail) {
  return {
    available: false,
    detail,
    transport: null,
    transportReason: null,
    binaryPath: null,
    plan: null
  };
}

/** @returns {CursorInvocation} */
function probeCursorInvocation(cwd) {
  const testBinary = process.env[TEST_BINARY_ENV];
  if (testBinary) {
    const plan = buildNativeSpawnPlan(testBinary);
    const probe = runPlanSync(plan, ["--version"], { cwd });
    if (probe.error || probe.status !== 0) {
      return unavailableInvocation(
        `${TEST_BINARY_ENV} points at ${testBinary} but \`--version\` failed: ${describeRunFailure(probe)}`
      );
    }
    return {
      available: true,
      detail: probe.stdout.trim() || probe.stderr.trim() || "ok",
      transport: "native",
      transportReason: "test binary override",
      binaryPath: testBinary,
      plan
    };
  }

  const nativeStatus = binaryAvailable("cursor-agent", ["--version"], { cwd });
  if (nativeStatus.available) {
    const plan = buildPathSpawnPlan(cwd);
    return {
      available: true,
      detail: nativeStatus.detail,
      transport: "native",
      transportReason: null,
      binaryPath: plan.cmdPath ?? plan.prefix?.[0] ?? plan.file,
      plan
    };
  }

  if (process.platform !== "win32") {
    return unavailableInvocation(`cursor-agent: ${nativeStatus.detail}`);
  }

  // win32 fallback: there is no native Windows build, so look for the Linux
  // binary inside WSL. `wsl -e` runs argv directly; `bash -lc` is only used
  // for the one-time PATH resolution because `wsl -e` skips login-shell PATH.
  const resolved = runCommand("wsl", ["-e", "bash", "-lc", "command -v cursor-agent"], {
    cwd,
    shell: false,
    timeout: WSL_PROBE_TIMEOUT_MS
  });
  const wslPath = resolved.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("/"))
    .at(-1);
  if (resolved.error || resolved.status !== 0 || !wslPath) {
    return unavailableInvocation(
      `cursor-agent: ${nativeStatus.detail} on PATH; WSL probe found nothing (${describeRunFailure(resolved)})`
    );
  }

  const version = runCommand("wsl", ["-e", wslPath, "--version"], {
    cwd,
    shell: false,
    timeout: WSL_PROBE_TIMEOUT_MS
  });
  if (version.error || version.status !== 0) {
    return unavailableInvocation(
      `cursor-agent found in WSL at ${wslPath} but \`--version\` failed: ${describeRunFailure(version)}`
    );
  }

  return {
    available: true,
    detail: `${version.stdout.trim() || "ok"} (via WSL at ${wslPath})`,
    transport: "wsl",
    transportReason: "no native Windows build; using WSL",
    binaryPath: wslPath,
    plan: { kind: "wsl", file: "wsl", prefix: ["-e", wslPath] }
  };
}

/** @type {CursorInvocation | null} */
let cachedInvocation = null;

/** @returns {CursorInvocation} */
export function resolveCursorInvocation(cwd) {
  if (!cachedInvocation) {
    cachedInvocation = probeCursorInvocation(cwd);
  }
  return cachedInvocation;
}

export function clearCursorInvocationCache() {
  cachedInvocation = null;
}

export function getCursorAvailability(cwd) {
  const invocation = resolveCursorInvocation(cwd);
  if (!invocation.available) {
    return { available: false, detail: invocation.detail };
  }
  return {
    available: true,
    detail: invocation.detail,
    transport: invocation.transport,
    transportReason: invocation.transportReason
  };
}

export async function getCursorAuthStatus(cwd) {
  const invocation = resolveCursorInvocation(cwd);
  if (!invocation.available) {
    return {
      available: false,
      loggedIn: false,
      detail: invocation.detail,
      source: "availability",
      method: null
    };
  }

  const result = runPlanSync(invocation.plan, ["status"], { cwd, timeout: WSL_PROBE_TIMEOUT_MS });
  if (result.error) {
    return {
      available: true,
      loggedIn: false,
      detail: `unable to run \`cursor-agent status\`: ${result.error.message}`,
      source: "status",
      method: null
    };
  }

  const output = `${result.stdout}\n${result.stderr}`.trim();
  const firstLine = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);

  if (/not logged in/i.test(output)) {
    if (process.env.CURSOR_API_KEY) {
      return {
        available: true,
        loggedIn: true,
        detail: "API key configured via CURSOR_API_KEY (unverified)",
        source: "env",
        method: "api-key"
      };
    }
    return {
      available: true,
      loggedIn: false,
      detail: firstLine ?? "Not logged in",
      source: "status",
      method: null
    };
  }

  if (result.status !== 0) {
    return {
      available: true,
      loggedIn: false,
      detail: firstLine ?? `\`cursor-agent status\` exited with ${result.status}`,
      source: "status",
      method: null
    };
  }

  return {
    available: true,
    loggedIn: true,
    detail: firstLine ?? "logged in",
    source: "status",
    method: "login"
  };
}

function extractToolCallEntry(toolCall) {
  if (!toolCall || typeof toolCall !== "object" || Array.isArray(toolCall)) {
    return null;
  }
  for (const [key, value] of Object.entries(toolCall)) {
    if (key.endsWith("ToolCall") && value && typeof value === "object") {
      return { name: key.slice(0, -"ToolCall".length), payload: value };
    }
  }
  return null;
}

function extractToolCallField(payload, keys) {
  for (const source of [payload?.args, payload]) {
    if (!source || typeof source !== "object") {
      continue;
    }
    for (const key of keys) {
      if (typeof source[key] === "string" && source[key]) {
        return source[key];
      }
    }
  }
  return null;
}

function extractToolCallPath(payload) {
  return extractToolCallField(payload, ["path", "filePath", "file", "targetFile", "target"]);
}

function extractToolCallCommand(payload) {
  return extractToolCallField(payload, ["command", "cmd", "script"]);
}

function extractMessageText(content) {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === "string" ? part : typeof part?.text === "string" ? part.text : ""))
      .join("");
  }
  if (content && typeof content === "object" && typeof content.text === "string") {
    return content.text;
  }
  return "";
}

function describeToolCallProgress(entry, subtype) {
  const command = extractToolCallCommand(entry.payload);
  const path = extractToolCallPath(entry.payload);
  const isShellTool = SHELL_TOOL_PATTERN.test(entry.name) && command;
  const label = path ? `${entry.name} (${path})` : entry.name;

  if (subtype === "started") {
    if (isShellTool) {
      return {
        message: `Running command: ${shorten(command, 96)}`,
        phase: looksLikeVerificationCommand(command) ? "verifying" : "running"
      };
    }
    if (FILE_CHANGE_TOOL_PATTERN.test(entry.name)) {
      return { message: `Applying file change: ${label}`, phase: "editing" };
    }
    return { message: `Running tool: ${label}`, phase: "investigating" };
  }

  if (isShellTool) {
    return {
      message: `Command completed: ${shorten(command, 96)}`,
      phase: looksLikeVerificationCommand(command) ? "verifying" : "running"
    };
  }
  if (FILE_CHANGE_TOOL_PATTERN.test(entry.name)) {
    return { message: `File change completed: ${label}`, phase: "editing" };
  }
  return { message: `Tool ${label} completed.`, phase: "investigating" };
}

function recordToolCall(state, event, onProgress) {
  const entry = extractToolCallEntry(event.tool_call);
  if (!entry) {
    return;
  }

  const update = describeToolCallProgress(entry, event.subtype);
  emitProgress(onProgress, update.message, update.phase);

  if (event.subtype !== "completed") {
    return;
  }

  const completedAt = new Date().toISOString();
  if (FILE_CHANGE_TOOL_PATTERN.test(entry.name)) {
    state.fileChanges.push({
      type: "fileChange",
      tool: entry.name,
      path: extractToolCallPath(entry.payload),
      status: "completed",
      completedAt
    });
    return;
  }

  const command = extractToolCallCommand(entry.payload);
  const path = extractToolCallPath(entry.payload);
  state.commandExecutions.push({
    type: "commandExecution",
    command: command ?? (path ? `${entry.name} ${path}` : entry.name),
    status: "completed",
    completedAt
  });
}

function applyStreamEvent(state, event, onProgress) {
  switch (event.type) {
    case "system":
      if (event.subtype === "init") {
        state.sessionId = event.session_id ?? state.sessionId;
        state.resolvedModel = typeof event.model === "string" && event.model ? event.model : state.resolvedModel;
        emitProgress(onProgress, `Cursor session ready (${state.sessionId ?? "unknown"}).`, "starting", {
          threadId: state.sessionId ?? null
        });
      }
      break;
    case "assistant": {
      // Assistant content arrives as repeated events; concatenate the text
      // parts to reconstruct the final answer.
      const text = extractMessageText(event.message?.content);
      if (text) {
        state.assistantText += text;
      }
      break;
    }
    case "tool_call":
      recordToolCall(state, event, onProgress);
      break;
    case "thinking":
      // Undocumented but real (cursor-agent 2026.07.23): reasoning streams as
      // {"type":"thinking","subtype":"delta","text":...} runs closed by a
      // "completed" event. Collect each run as one reasoning section.
      if (event.subtype === "delta" && typeof event.text === "string") {
        state.thinkingBuffer += event.text;
      } else if (event.subtype === "completed" && state.thinkingBuffer.trim()) {
        state.reasoningSummary.push(state.thinkingBuffer.replace(/\s+/g, " ").trim());
        state.thinkingBuffer = "";
      }
      break;
    case "result":
      state.result = event;
      if (event.is_error) {
        emitProgress(onProgress, `Cursor error: ${shorten(event.result, 96) || "turn failed"}`, "failed");
      } else {
        emitProgress(onProgress, "Turn completed.", "finalizing");
      }
      break;
    default:
      break;
  }
}

function handleStreamLine(state, line, onProgress) {
  const trimmed = line.trim();
  if (!trimmed) {
    return;
  }
  let event;
  try {
    event = JSON.parse(trimmed);
  } catch {
    // Non-JSON banner or diagnostic output interleaved with the stream.
    return;
  }
  if (event && typeof event === "object") {
    applyStreamEvent(state, event, onProgress);
  }
}

function collectTouchedFiles(fileChanges) {
  const paths = new Set();
  for (const fileChange of fileChanges) {
    if (fileChange.path) {
      paths.add(fileChange.path);
    }
  }
  return [...paths];
}

export async function runCursorTurn(cwd, options = {}) {
  const invocation = resolveCursorInvocation(cwd);
  if (!invocation.available) {
    throw new Error(buildInstallHint());
  }

  const prompt = options.prompt?.trim() || options.defaultPrompt || "";
  if (!prompt) {
    throw new Error("A prompt is required for this Cursor run.");
  }

  const workspacePath = invocation.transport === "wsl" ? winPathToWsl(cwd) : cwd;
  const agentArgs = ["-p", prompt, "--output-format", "stream-json"];
  if (options.model) {
    agentArgs.push("--model", String(options.model));
  }
  if (options.resumeChatId) {
    agentArgs.push("--resume", String(options.resumeChatId));
  }
  agentArgs.push("--workspace", workspacePath);
  // Headless runs die on the interactive workspace-trust prompt without this
  // (verified against cursor-agent 2026.07.23).
  agentArgs.push("--trust");
  if (options.write) {
    // Write mode: skip per-command confirmation. Read mode omits --force and
    // keeps the default sandbox.
    agentArgs.push("--force");
  }

  const line = planCommandLine(invocation.plan, agentArgs);
  emitProgress(
    options.onProgress,
    `Starting Cursor turn${invocation.transport === "wsl" ? " via WSL" : ""}.`,
    "starting"
  );

  return new Promise((resolve, reject) => {
    const child = spawn(line.file, line.args, {
      cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      windowsHide: true,
      ...line.options
    });

    const state = {
      sessionId: options.resumeChatId ?? null,
      resolvedModel: null,
      assistantText: "",
      thinkingBuffer: "",
      reasoningSummary: [],
      fileChanges: [],
      commandExecutions: [],
      result: null,
      stderr: ""
    };
    let stdoutBuffer = "";
    let settled = false;

    child.stdin.end();
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    child.stdout.on("data", (chunk) => {
      stdoutBuffer += chunk;
      let newlineIndex = stdoutBuffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const streamLine = stdoutBuffer.slice(0, newlineIndex);
        stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
        handleStreamLine(state, streamLine, options.onProgress);
        newlineIndex = stdoutBuffer.indexOf("\n");
      }
    });

    child.stderr.on("data", (chunk) => {
      state.stderr += chunk;
    });

    child.on("error", (spawnError) => {
      if (settled) {
        return;
      }
      settled = true;
      const wrapped = /** @type {Error & { code?: string }} */ (
        new Error(`Unable to launch cursor-agent: ${spawnError.message}`)
      );
      wrapped.code = /** @type {NodeJS.ErrnoException} */ (spawnError).code;
      reject(wrapped);
    });

    child.on("close", (exitCode) => {
      if (settled) {
        return;
      }
      settled = true;
      if (stdoutBuffer.trim()) {
        handleStreamLine(state, stdoutBuffer, options.onProgress);
      }

      const resultEvent = state.result;
      const isError = resultEvent ? resultEvent.is_error === true : exitCode !== 0;
      const finalMessage =
        (typeof resultEvent?.result === "string" && resultEvent.result) || state.assistantText;
      const stderr = cleanCursorStderr(state.stderr);

      if (finalMessage) {
        emitLogEvent(options.onProgress, {
          message: `Assistant message captured: ${shorten(finalMessage, 96)}`,
          phase: null,
          logTitle: "Assistant message",
          logBody: finalMessage
        });
      }

      // The terminal result event carries token usage
      // ({inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens});
      // normalize to the snake_case field names the job-control signals read.
      const usage = resultEvent?.usage;
      const tokenUsage =
        usage && typeof usage === "object"
          ? {
              input_tokens: usage.inputTokens ?? null,
              output_tokens: usage.outputTokens ?? null,
              cache_read_tokens: usage.cacheReadTokens ?? null,
              cache_write_tokens: usage.cacheWriteTokens ?? null,
              total_tokens:
                Number.isFinite(usage.inputTokens) && Number.isFinite(usage.outputTokens)
                  ? usage.inputTokens + usage.outputTokens
                  : null
            }
          : null;

      resolve({
        status: isError ? 1 : 0,
        threadId: state.sessionId,
        turnId: null,
        finalMessage,
        reasoningSummary: state.reasoningSummary,
        turn: tokenUsage ? { tokenUsage } : null,
        fileChanges: state.fileChanges,
        touchedFiles: collectTouchedFiles(state.fileChanges),
        commandExecutions: state.commandExecutions,
        stderr,
        error: isError
          ? {
              message:
                shorten(finalMessage, 200) ||
                shorten(stderr, 200) ||
                `cursor-agent exited with code ${exitCode}`
            }
          : null,
        durationMs: Number.isFinite(resultEvent?.duration_ms) ? resultEvent.duration_ms : null,
        transport: invocation.transport,
        transportReason: invocation.transportReason,
        model: state.resolvedModel ?? options.model ?? null
      });
    });
  });
}

function stripJsonCodeFence(text) {
  const match = text.match(/^\s*```(?:json)?\s*\r?\n([\s\S]*?)\r?\n```\s*$/);
  return match ? match[1] : text;
}

export function parseStructuredOutput(rawOutput, fallback = {}) {
  if (!rawOutput) {
    return {
      parsed: null,
      parseError: fallback.failureMessage ?? "Cursor did not return a final structured message.",
      rawOutput: rawOutput ?? "",
      ...fallback
    };
  }

  try {
    return {
      // cursor-agent has no structured-output flag, so the model may fence the
      // JSON in a markdown code block despite the prompt contract.
      parsed: JSON.parse(stripJsonCodeFence(rawOutput)),
      parseError: null,
      rawOutput,
      ...fallback
    };
  } catch (error) {
    return {
      parsed: null,
      parseError: error.message,
      rawOutput,
      ...fallback
    };
  }
}

export function readOutputSchema(schemaPath) {
  return readJsonFile(schemaPath);
}

export { cleanCursorStderr, DEFAULT_CONTINUE_PROMPT };
