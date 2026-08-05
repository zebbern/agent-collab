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

export function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
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
