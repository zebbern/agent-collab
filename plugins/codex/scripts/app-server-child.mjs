#!/usr/bin/env node

import fs from "node:fs";
import process from "node:process";
import { spawn } from "node:child_process";

const activation = fs.createReadStream(null, { fd: 3, autoClose: true });
let activated = false;
let activationBuffer = "";
let child = null;

function exitWithoutChild(code = 1) {
  if (child || process.exitCode != null) {
    return;
  }
  process.exitCode = code;
  process.stdin.resume();
}

function startAppServer() {
  if (activated || child) {
    return;
  }
  activated = true;
  child = spawn("codex", ["app-server"], {
    cwd: process.cwd(),
    env: process.env,
    detached: false,
    stdio: ["pipe", "pipe", "pipe"],
    shell: process.platform === "win32" ? (process.env.SHELL || true) : false,
    windowsHide: true
  });
  child.stdout.pipe(process.stdout);
  child.stderr.pipe(process.stderr);
  process.stdin.pipe(child.stdin);
  child.on("error", (error) => {
    process.stderr.write(`Unable to start codex app-server: ${error.message}\n`);
    process.exit(1);
  });
  // `close` follows both process exit and stdio closure, so the wrapper does
  // not truncate the JSONL stream while forwarding the child's final bytes.
  child.on("close", (code, signal) => {
    process.exit(Number.isInteger(code) ? code : signal ? 1 : 0);
  });
}

activation.setEncoding("utf8");
activation.on("data", (chunk) => {
  if (activated) {
    return;
  }
  activationBuffer += chunk;
  const newlineIndex = activationBuffer.indexOf("\n");
  if (newlineIndex === -1) {
    return;
  }
  if (activationBuffer.slice(0, newlineIndex).trim() !== "activate") {
    exitWithoutChild(1);
    return;
  }
  startAppServer();
});
activation.on("end", () => {
  if (!activated) {
    exitWithoutChild(1);
  }
});
activation.on("error", () => {
  if (!activated) {
    exitWithoutChild(1);
  }
});

process.stdin.on("end", () => {
  if (!activated) {
    exitWithoutChild(1);
    return;
  }
  child?.stdin.end();
});
process.stdin.on("error", () => {
  child?.stdin.destroy();
});
// Keep protocol bytes buffered until activation has created the real app
// server and its stdin pipe. Flowing stdin here can discard an initialize
// request that races the activation-control pipe.
process.stdin.pause();
