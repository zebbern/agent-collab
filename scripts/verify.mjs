#!/usr/bin/env node
// The pre-merge gate, run locally.
//
// GitHub Actions dispatch is intermittent for this repo (a single day has
// seen it both work and silently fail), so this script is the gate rather
// than a convenience wrapper — CI availability is not something a merge gate
// may assume. The Linux leg runs in docker where the win32-guarded tests
// actually execute (the Windows run skips ~40 of them), so the two legs
// together cover more than either platform alone.
//
//   npm run verify              # build + native suite + Linux suite in docker
//   npm run verify -- --no-linux  # skip the docker leg deliberately
//
// Reporting rule: a skipped leg is never reported as a pass. If the Linux leg
// cannot run, the summary says UNVERIFIED and the gate is INCOMPLETE — the
// same "unknown is not healthy" doctrine the runtime code follows.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const skipLinux = process.argv.includes("--no-linux");

function run(label, command, args, options = {}) {
  process.stdout.write(`\n=== ${label} ===\n`);
  const result = spawnSync(command, args, {
    cwd: ROOT,
    stdio: "inherit",
    shell: process.platform === "win32" && !path.isAbsolute(command),
    ...options
  });
  if (result.error) {
    return { label, status: "error", detail: result.error.message };
  }
  // Distinguish a real non-zero exit from a signal kill: a leg terminated by
  // a signal exits with status null, which naive handling reports as a test
  // failure that the same command passes when run directly.
  if (result.signal) {
    return { label, status: "error", detail: `killed by ${result.signal}` };
  }
  return { label, status: result.status === 0 ? "pass" : "fail", detail: `exit ${result.status}` };
}

function dockerAvailable() {
  const probe = spawnSync("docker", ["version", "--format", "{{.Server.Version}}"], {
    encoding: "utf8",
    shell: process.platform === "win32"
  });
  return !probe.error && probe.status === 0;
}

// The suites spawn real detached processes; starting the next leg while the
// previous one's workers are still exiting produces exactly the load-starved
// flakes documented in AGENTS.md (observed here: the broker e2e tests failed
// only when docker started immediately after the native run, and passed twice
// in a row on their own). A short settle window between legs avoids measuring
// contention instead of correctness.
function settle(seconds = 5) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, seconds * 1000);
}

const results = [];
results.push(run("build (types + tsc checkJs)", "npm", ["run", "build"]));
results.push(run(`native suite (${process.platform})`, process.execPath, [path.join(ROOT, "scripts", "run-tests.mjs")]));
settle();

if (skipLinux) {
  results.push({ label: "linux suite (docker)", status: "skipped", detail: "--no-linux" });
} else if (!dockerAvailable()) {
  results.push({ label: "linux suite (docker)", status: "skipped", detail: "docker unavailable" });
} else {
  // Mount read-only and copy inside, so the container never writes into the
  // working tree (and a container-side node_modules cannot clobber the host).
  // The drive letter is lower-cased into the //c/... form docker expects here.
  const mount = `${ROOT.replace(/\\/g, "/").replace(/^([A-Za-z]):/, (_, drive) => `//${drive.toLowerCase()}`)}:/repo:ro`;
  results.push(
    // Two things here are load-bearing, both found the hard way:
    //   shell:false — routing this through cmd.exe re-parses the quoted
    //   `bash -lc "..."` payload and the container gets a mangled command
    //   (seen as `cp: missing file operand`).
    //
    //   The suite's TAP output stays INSIDE the container and only a summary
    //   is echoed. Streaming ~400 tests' output back through inherited stdio
    //   reproducibly failed 7 timing-sensitive broker e2e tests that pass
    //   every time when the output is not piped out — measuring pipe
    //   backpressure, not correctness.
    run(
      "linux suite (docker node:22)",
      "docker",
      [
        "run", "--rm", "-v", mount, "node:22",
        "bash", "-lc",
        // .git handling is conditional. From a git WORKTREE it is a pointer
        // file whose target does not exist in the container, which kills
        // every git invocation (the chassis-drift guard's `git diff
        // --no-index` died with exit 128 and hashed empty diffs) — so a
        // pointer-file .git is excluded, and the bench archaeology tests
        // skip loudly inside the container. From a REAL checkout .git is a
        // directory and is included: tests/bench-manifest.test.mjs verifies
        // historical fix/parent SHAs and needs the object DB, so "no test
        // needs the repo's git history" stopped being true on 2026-08-08.
        `mkdir /work && tar -C /repo ${fs.statSync(path.join(ROOT, ".git")).isDirectory() ? "" : "--exclude=./.git "}-cf - . | tar -C /work -xf - && ` +
          "cd /work && node scripts/run-tests.mjs > /tmp/suite.log 2>&1; status=$?; " +
          "grep -E '^not ok' /tmp/suite.log; grep -E '^# (tests|pass|fail|skipped)' /tmp/suite.log; exit $status"
      ],
      { shell: false }
    )
  );
}

const failed = results.filter((r) => r.status === "fail" || r.status === "error");
const skipped = results.filter((r) => r.status === "skipped");

process.stdout.write("\n=== verify summary ===\n");
for (const result of results) {
  const mark = { pass: "PASS", fail: "FAIL", error: "ERROR", skipped: "UNVERIFIED" }[result.status];
  process.stdout.write(`  ${mark.padEnd(11)} ${result.label} (${result.detail})\n`);
}

if (failed.length > 0) {
  process.stdout.write("\nGate: FAILED\n");
  process.exit(1);
}
if (skipped.length > 0) {
  // Not a failure, but never call an unrun leg a pass.
  process.stdout.write("\nGate: INCOMPLETE — some legs were not verified (see UNVERIFIED above).\n");
  process.exit(0);
}
process.stdout.write("\nGate: PASSED (all legs verified)\n");
