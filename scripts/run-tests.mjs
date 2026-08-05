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
const child = spawn(process.execPath, args, { cwd: repoRoot, stdio: "inherit" });
child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
