#!/usr/bin/env node
// Runs the test suite with file concurrency capped at min(cores, 8).
//
// The process-spawning e2e tests starve their detached workers when too many
// test files run at once on a high-core machine, so the suite needs a ceiling.
// But `--test-concurrency=8` is an absolute value, not a maximum: on a 2-core
// CI runner it would RAISE concurrency from the default of 2 to 8,
// oversubscribing the box, slowing every spawned process, and blowing the
// state lock's warn-and-proceed timeout (observed as lost updates in the
// concurrency test). Computing min(cores, 8) caps high-core machines without
// ever inflating low-core ones.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const testsDir = path.join(repoRoot, "tests");
const testFiles = fs
  .readdirSync(testsDir)
  .filter((name) => name.endsWith(".test.mjs"))
  .map((name) => path.join("tests", name));

const cores = os.availableParallelism?.() ?? os.cpus().length;
const concurrency = Math.min(cores, 8);

const args = ["--test", `--test-concurrency=${concurrency}`, ...process.argv.slice(2), ...testFiles];
// A live Claude session with the plugins INSTALLED exports plugin runtime
// env into every Bash environment: the SessionStart hook exports the real
// session id/transcript path (and pre-canonical-root versions also exported
// CLAUDE_PLUGIN_DATA, which merged both plugins' state under one dir).
// Inherited by the suite, those made tests write into the LIVE plugin state
// dir and session-filter synthetic jobs (observed 2026-08-07, the day the
// plugins were first really installed: native leg red, docker leg's clean
// env green). The canonical state-root overrides are scrubbed for the same
// reason: a user-exported value must never steer the suite. The suite must
// be hermetic regardless of where it is run from; suites that need these
// vars set their own values.
const env = { ...process.env };
for (const name of [
  "CLAUDE_PLUGIN_DATA",
  "CODEX_COMPANION_SESSION_ID",
  "CURSOR_COMPANION_SESSION_ID",
  "CODEX_COMPANION_TRANSCRIPT_PATH",
  "CURSOR_COMPANION_TRANSCRIPT_PATH",
  "CODEX_COMPANION_STATE_ROOT",
  "CURSOR_COMPANION_STATE_ROOT"
]) {
  delete env[name];
}
const child = spawn(process.execPath, args, { cwd: repoRoot, stdio: "inherit", env });
child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
