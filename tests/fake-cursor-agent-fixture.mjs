import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { writeExecutable } from "./helpers.mjs";

// Behaviors:
// - "turn-ok" (default): logged in; -p runs stream init, assistant chunks,
//   and a success result carrying the final text.
// - "logged-out": `status` prints the real CLI's "Not logged in" output.
// - "auth-error": the run terminates with an is_error result event.
// - "with-file-edit": emits read/write tool_call started/completed pairs
//   before the final answer so telemetry mapping can be asserted.
// - "streamed-answer": the terminal result omits its `result` text so the
//   final answer must be reassembled from the assistant chunks.
// - "slow": the terminal result only arrives after a long delay, leaving a
//   live process for cancel tests to kill.
export function installFakeCursorAgent(binDir, behavior = "turn-ok") {
  const statePath = path.join(binDir, "fake-cursor-state.json");
  const scriptPath = path.join(binDir, "cursor-agent");
  const source = `#!/usr/bin/env node
const fs = require("node:fs");

const STATE_PATH = ${JSON.stringify(statePath)};
const BEHAVIOR = ${JSON.stringify(behavior)};
const SLOW_RESULT_DELAY_MS = 15000;

function loadState() {
  if (!fs.existsSync(STATE_PATH)) {
    return { runs: [], lastArgs: null };
  }
  return JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
}

function saveState(state) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

function send(event) {
  process.stdout.write(JSON.stringify(event) + "\\n");
}

function readFlagValue(args, flag) {
  const index = args.indexOf(flag);
  if (index === -1 || index + 1 >= args.length) {
    return null;
  }
  return args[index + 1];
}

const args = process.argv.slice(2);

if (args[0] === "--version") {
  console.log("2026.07.23-fake");
  process.exit(0);
}

if (args[0] === "status") {
  if (BEHAVIOR === "logged-out") {
    console.log("Not logged in");
    process.exit(1);
  }
  console.log("Logged in as fake@example.com");
  process.exit(0);
}

if (args[0] === "login") {
  process.exit(0);
}

// Mirrors the real \`cursor-agent --list-models\` output shape ("<id> - <label>",
// with an "Available models" header) so the doctor's roster check can verify
// the pinned profile ids against a fixture instead of degrading to
// "unauditable". The two ids the cursor profile table pins are present on
// purpose: a healthy fixture environment must read as healthy, and a profile
// id going stale must be what turns it red — not the fixture's own ignorance.
if (args[0] === "--list-models" || args[0] === "models") {
  if (BEHAVIOR === "roster-missing-profile") {
    console.log("Available models\\n\\nauto - Auto (default)\\ncomposer-2.5 - Composer 2.5");
    process.exit(0);
  }
  console.log(
    [
      "Available models",
      "",
      "auto - Auto (default)",
      "gpt-5.6-sol-xhigh - GPT-5.6 Sol 1M Extra High",
      "cursor-grok-4.5-high-fast - Cursor Grok 4.5 Fast",
      "composer-2.5 - Composer 2.5"
    ].join("\\n")
  );
  process.exit(0);
}

const promptIndex = args.indexOf("-p");
if (promptIndex === -1 || readFlagValue(args, "--output-format") !== "stream-json") {
  console.error("fake cursor-agent: unsupported invocation: " + args.join(" "));
  process.exit(2);
}

// The companion sends the prompt over stdin, never argv (argv rides wsl.exe's
// ~32K CreateProcess command line on Windows; the real cursor-agent reads the
// print-mode prompt from stdin when no positional is given — verified live
// 2026-08-07). Reading stdin here is the contract tripwire: a companion that
// regresses to an argv prompt leaves this empty and fails the content pins.
const prompt = fs.readFileSync(0, "utf8");

const state = loadState();
state.runs.push({ args: args, receivedAt: new Date().toISOString(), promptLength: prompt.length });
state.lastArgs = args;
state.lastPrompt = prompt;
saveState(state);
const resumeChatId = readFlagValue(args, "--resume");
const sessionId = resumeChatId || "sess-fake-" + state.runs.length;
const model = readFlagValue(args, "--model") || "composer-2-fake";
const forced = args.includes("--force") || args.includes("-f");

function finalText() {
  if (prompt.includes("<output_schema>")) {
    return JSON.stringify({
      verdict: "needs-attention",
      summary: "One adversarial concern surfaced.",
      findings: [
        {
          severity: "high",
          title: "Missing empty-state guard",
          body: "The change assumes data is always present.",
          file: "src/app.js",
          line_start: 4,
          line_end: 6,
          confidence: 0.87,
          recommendation: "Handle empty collections before indexing."
        }
      ],
      next_steps: ["Add an empty-state test."]
    });
  }
  if (resumeChatId) {
    return "Resumed the prior chat.\\nFollow-up prompt accepted.";
  }
  return "Handled the requested task.\\nTask prompt accepted.";
}

if (process.env.CURSOR_FAKE_WRITE_FILE) {
  // Simulates an agent writing into the workspace during a read-mode run,
  // which the companion's workspace-drift check must surface.
  fs.writeFileSync(process.env.CURSOR_FAKE_WRITE_FILE, "agent scratch\\n");
}

send({
  type: "system",
  subtype: "init",
  apiKeySource: "none",
  cwd: process.cwd(),
  session_id: sessionId,
  model: model,
  permissionMode: forced ? "acceptEdits" : "default"
});
send({
  type: "user",
  message: { role: "user", content: [{ type: "text", text: prompt }] },
  session_id: sessionId
});

if (BEHAVIOR === "auth-error") {
  send({
    type: "result",
    subtype: "error",
    duration_ms: 12,
    duration_api_ms: 8,
    is_error: true,
    result: "Not authenticated. Run cursor-agent login and retry.",
    session_id: sessionId
  });
  process.exitCode = 1;
} else if (BEHAVIOR === "slow") {
  setTimeout(() => {
    send({
      type: "result",
      subtype: "success",
      duration_ms: SLOW_RESULT_DELAY_MS,
      duration_api_ms: SLOW_RESULT_DELAY_MS,
      is_error: false,
      result: "Finished after a long wait.",
      session_id: sessionId
    });
  }, SLOW_RESULT_DELAY_MS);
} else {
  if (BEHAVIOR === "with-file-edit") {
    send({
      type: "tool_call",
      subtype: "started",
      call_id: "call_1",
      tool_call: { readToolCall: { args: { path: "README.md" } } },
      session_id: sessionId
    });
    send({
      type: "tool_call",
      subtype: "completed",
      call_id: "call_1",
      tool_call: { readToolCall: { args: { path: "README.md" }, result: { totalLines: 1 } } },
      session_id: sessionId
    });
    send({
      type: "tool_call",
      subtype: "started",
      call_id: "call_2",
      tool_call: { writeToolCall: { args: { path: "out.txt", fileText: "hello" } } },
      session_id: sessionId
    });
    send({
      type: "tool_call",
      subtype: "completed",
      call_id: "call_2",
      tool_call: { writeToolCall: { args: { path: "out.txt", fileText: "hello" }, result: { linesCreated: 1, fileSize: 6 } } },
      session_id: sessionId
    });
  }

  // The final answer arrives as repeated assistant events; split it so tests
  // exercise the adapter's chunk concatenation.
  const text = finalText();
  const midpoint = Math.ceil(text.length / 2);
  send({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text: text.slice(0, midpoint) }] },
    session_id: sessionId
  });
  send({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text: text.slice(midpoint) }] },
    session_id: sessionId
  });

  const resultEvent = {
    type: "result",
    subtype: "success",
    duration_ms: 42,
    duration_api_ms: 30,
    is_error: false,
    result: text,
    session_id: sessionId
  };
  if (BEHAVIOR === "streamed-answer") {
    delete resultEvent.result;
  }
  send(resultEvent);
}
`;
  writeExecutable(scriptPath, source);

  // Node-script twin of the extensionless CJS fake. CURSOR_COMPANION_TEST_BINARY
  // can point at it so the adapter uses its node-script spawn plan (prompts
  // travel over stdin, so argv stays small and newline-free on every plan; the
  // cmd.exe shim below still truncates any argument at the first newline).
  fs.writeFileSync(
    path.join(binDir, "cursor-agent.mjs"),
    [
      'import { createRequire } from "node:module";',
      "",
      "const require = createRequire(import.meta.url);",
      'require("./cursor-agent");',
      ""
    ].join("\n"),
    "utf8"
  );

  // On Windows, PATH lookups resolve .cmd wrappers. Create a cursor-agent.cmd
  // so the fake binary is discoverable by the shell-based availability probe
  // and by `where cursor-agent`.
  if (process.platform === "win32") {
    const cmdWrapper = `@echo off\r\nnode "%~dp0cursor-agent" %*\r\n`;
    fs.writeFileSync(path.join(binDir, "cursor-agent.cmd"), cmdWrapper, { encoding: "utf8" });
  }
}

export function buildCursorEnv(binDir) {
  const sep = process.platform === "win32" ? ";" : ":";
  return {
    ...process.env,
    PATH: `${binDir}${sep}${process.env.PATH}`
  };
}
