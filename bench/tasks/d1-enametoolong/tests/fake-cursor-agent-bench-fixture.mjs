// Bench fixture for D1 (enametoolong). Speaks the same stream-json protocol
// as tests/fake-cursor-agent-fixture.mjs (--version/status/login handling,
// init + result events, state-file recording of what it received) but is
// deliberately CHANNEL-AGNOSTIC about how the prompt arrives, so the same
// fixture scores both the parent-era transport (prompt on argv) and the
// fixed transport (prompt on stdin) honestly instead of only recognizing
// the fixed mechanism:
//   (a) stdin, read fully -- if non-empty, that IS the prompt;
//   (b) else scan argv tokens for one that is an EXISTING FILE whose
//       content contains the marker string -- a hypothetical fix that hands
//       cursor-agent a prompt-file path (instead of stdin) recovers here
//       without the marker ever touching argv itself;
//   (c) else fall back to the parent-era positional: the argv token
//       immediately after "-p", unless that token is itself another flag.
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { writeExecutable } from "./helpers.mjs";

const MARKER = "BENCH-ENAMETOOLONG-MARKER";

export function installBenchCursorAgent(binDir) {
  const statePath = path.join(binDir, "fake-cursor-bench-state.json");
  const scriptPath = path.join(binDir, "cursor-agent");
  const source = `#!/usr/bin/env node
const fs = require("node:fs");

const STATE_PATH = ${JSON.stringify(statePath)};
const MARKER = ${JSON.stringify(MARKER)};

function readStdinSync() {
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function readFlagValue(args, flag) {
  const index = args.indexOf(flag);
  if (index === -1 || index + 1 >= args.length) {
    return null;
  }
  return args[index + 1];
}

function recoverPrompt(args, stdinText) {
  if (stdinText && stdinText.length > 0) {
    return stdinText;
  }
  for (const token of args) {
    try {
      if (fs.existsSync(token) && fs.statSync(token).isFile()) {
        const content = fs.readFileSync(token, "utf8");
        if (content.includes(MARKER)) {
          return content;
        }
      }
    } catch {
      // Not a usable path; keep scanning.
    }
  }
  const promptIndex = args.indexOf("-p");
  if (promptIndex !== -1 && promptIndex + 1 < args.length) {
    const candidate = args[promptIndex + 1];
    if (!candidate.startsWith("-")) {
      return candidate;
    }
  }
  return "";
}

const args = process.argv.slice(2);

if (args[0] === "--version") {
  console.log("2026.07.23-bench-fake");
  process.exit(0);
}

if (args[0] === "status") {
  console.log("Logged in as bench@example.com");
  process.exit(0);
}

if (args[0] === "login") {
  process.exit(0);
}

if (readFlagValue(args, "--output-format") !== "stream-json") {
  console.error("bench fake cursor-agent: unsupported invocation: " + args.join(" "));
  process.exit(2);
}

// Stdin must be drained before argv is trusted: a stdin-carrying caller may
// still pass an unrelated positional/flag set on argv.
const stdinText = readStdinSync();
const prompt = recoverPrompt(args, stdinText);

let state = { runs: [] };
try {
  state = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
} catch {
  // First run.
}
state.runs.push({ args: args, prompt: prompt, receivedAt: new Date().toISOString() });
state.lastArgs = args;
state.lastPrompt = prompt;
fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));

const sessionId = "sess-bench-" + state.runs.length;

function send(event) {
  process.stdout.write(JSON.stringify(event) + "\\n");
}

send({
  type: "system",
  subtype: "init",
  apiKeySource: "none",
  cwd: process.cwd(),
  session_id: sessionId,
  model: "composer-2-bench",
  permissionMode: "default"
});
send({
  type: "user",
  message: { role: "user", content: [{ type: "text", text: prompt }] },
  session_id: sessionId
});
send({
  type: "assistant",
  message: { role: "assistant", content: [{ type: "text", text: "Bench prompt received." }] },
  session_id: sessionId
});
send({
  type: "result",
  subtype: "success",
  duration_ms: 5,
  duration_api_ms: 3,
  is_error: false,
  result: "Bench prompt received.",
  session_id: sessionId
});
`;
  writeExecutable(scriptPath, source);

  // Node-script twin of the extensionless CJS fake, mirroring the real
  // fixture's approach: CURSOR_COMPANION_TEST_BINARY can point at it so the
  // adapter uses its argv-only node-script spawn plan.
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

  // On Windows, PATH lookups resolve .cmd wrappers.
  if (process.platform === "win32") {
    const cmdWrapper = `@echo off\r\nnode "%~dp0cursor-agent" %*\r\n`;
    fs.writeFileSync(path.join(binDir, "cursor-agent.cmd"), cmdWrapper, { encoding: "utf8" });
  }
}

export function buildBenchCursorEnv(binDir) {
  const sep = process.platform === "win32" ? ";" : ":";
  return {
    ...process.env,
    PATH: `${binDir}${sep}${process.env.PATH}`
  };
}

export const BENCH_ENAMETOOLONG_MARKER = MARKER;
