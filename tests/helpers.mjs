import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

// Temp dirs created by tests are best-effort removed when the test process
// exits, so a normal run stops piling up thousands of scratch dirs under
// %TEMP%. Hard-killed runs (SIGKILL, app close) skip this; scripts/reap-test-
// residue.mjs mops those up on demand. Cleanup is per-dir best-effort so a
// dir still held by a detached worker never breaks teardown.
const trackedTempDirs = [];
let tempCleanupRegistered = false;

function registerTempCleanup() {
  if (tempCleanupRegistered) {
    return;
  }
  tempCleanupRegistered = true;
  process.on("exit", () => {
    for (const dir of trackedTempDirs) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // In use or already gone; the reaper handles the remainder.
      }
    }
  });
}

export function makeTempDir(prefix = "codex-plugin-test-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  registerTempCleanup();
  trackedTempDirs.push(dir);
  return dir;
}

export function writeExecutable(filePath, source) {
  fs.writeFileSync(filePath, source, { encoding: "utf8", mode: 0o755 });
}

// Session vars the INSTALLED plugins' SessionStart hooks export into every
// Bash environment of a live Claude session. A suite run from such a session
// leaks them into test-spawned companions, which then session-filter the
// synthetic jobs away (observed 2026-08-07, the day the plugins were first
// really installed: two status tests went red on the native leg while the
// docker leg's clean env stayed green). Scrub a var only when its value is
// identical to the ambient one — i.e. it arrived via a {...process.env}
// spread — so tests that set a session id or transcript path DELIBERATELY
// (session-scoping and transfer tests) keep theirs.
const AMBIENT_SESSION_VARS = [
  "CODEX_COMPANION_SESSION_ID",
  "CURSOR_COMPANION_SESSION_ID",
  "CODEX_COMPANION_TRANSCRIPT_PATH",
  "CURSOR_COMPANION_TRANSCRIPT_PATH"
];

export function run(command, args, options = {}) {
  const env = { ...(options.env ?? process.env) };
  for (const name of AMBIENT_SESSION_VARS) {
    if (env[name] !== undefined && env[name] === process.env[name]) {
      delete env[name];
    }
  }
  return spawnSync(command, args, {
    cwd: options.cwd,
    env,
    encoding: "utf8",
    input: options.input,
    shell: options.shell ?? (process.platform === "win32" && !path.isAbsolute(command)),
    windowsHide: true
  });
}

export function initGitRepo(cwd) {
  run("git", ["init", "-b", "main"], { cwd });
  run("git", ["config", "user.name", "Codex Plugin Tests"], { cwd });
  run("git", ["config", "user.email", "tests@example.com"], { cwd });
  run("git", ["config", "commit.gpgsign", "false"], { cwd });
  run("git", ["config", "tag.gpgsign", "false"], { cwd });
}
