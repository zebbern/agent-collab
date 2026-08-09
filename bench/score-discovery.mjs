#!/usr/bin/env node
// Replay a submitted PoC against every leg and score it.
//
//   node bench/score-discovery.mjs --task aiohttp-smuggling --run <runId>
//
// Runs separately from the agent so nothing the agent left behind can influence
// how its own submission is judged. Each leg gets a fresh container from the
// task's pinned image, the patch applied, the PoC copied in, and provenance
// asserted before every invocation.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { loadDiscoveryManifest } from "./lib/discovery-manifest.mjs";
import { scoreDiscoveryRun } from "./lib/discovery-score.mjs";
import { parseWitnessReport } from "./lib/witness.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RESULTS = path.join(ROOT, "bench", "results-discovery");
const argv = process.argv.slice(2);
const argOf = (n, d) => (argv.indexOf(`--${n}`) === -1 ? d : argv[argv.indexOf(`--${n}`) + 1]);
const TASK = argOf("task", "aiohttp-smuggling");
const RUN = argOf("run", `${TASK}__solo__r1`);

const IMAGE = "aiohttp-69243:ship";
const PATCH_DIR = path.join(
  "C:/Users/zeb/AppData/Local/Temp/claude/C--Users-zeb-Documents-workspace-for-ai-codex-plugin",
  "e4cbb56f-d0a7-4b69-9ad8-c00d27ecd95a/scratchpad/preflight/aiohttp-smuggling"
);

const manifest = loadDiscoveryManifest(path.join(ROOT, "bench", "tasks-discovery", TASK));
const artifacts = path.join(RESULTS, "raw", RUN);
const poc = path.join(artifacts, "submitted", path.posix.basename(manifest.poc.entryPath));
if (!fs.existsSync(poc)) {
  process.stdout.write(`no submitted PoC at ${poc}\n`);
  process.exit(1);
}

const log = (m) => process.stdout.write(`${m}\n`);
const docker = (args, opts = {}) => {
  const r = spawnSync("docker", args, { encoding: "utf8", shell: false, timeout: 600000, ...opts });
  return { status: r.status, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim() };
};

log(`scoring ${RUN} against ${manifest.legs.length} legs\n`);
const legResults = [];
let witness = { covered: false, unavailable: "witness never ran" };

for (const leg of manifest.legs) {
  const container = `bench-score-${leg.name}`.replace(/[^A-Za-z0-9_.-]/g, "-");
  docker(["rm", "-f", container]);
  const up = docker([
    "run", "-d", "--name", container, "--network", "none",
    "--memory", "4g", "--pids-limit", "512", "-w", "/build",
    ...Object.entries(manifest.build.env ?? {}).flatMap(([k, v]) => ["-e", `${k}=${v}`]),
    IMAGE, "sleep", "infinity"
  ]);
  if (up.status !== 0) {
    log(`  ${leg.name}: container failed — ${up.err.slice(0, 120)}`);
    continue;
  }

  // Apply the leg's patch, if it has one.
  if (leg.patch) {
    docker(["cp", path.join(PATCH_DIR, leg.patch), `${container}:/tmp/leg.patch`]);
    const applied = docker(["exec", "-w", "/build", container, "git", "apply", "/tmp/leg.patch"]);
    if (applied.status !== 0) {
      log(`  ${leg.name}: PATCH FAILED — ${applied.err.slice(0, 160)}`);
      docker(["rm", "-f", container]);
      continue;
    }
  }

  // Provenance, asserted before any measurement.
  const head = docker(["exec", "-w", "/build", container, "git", "rev-parse", "HEAD"]).out;
  const sha = docker(["exec", "-w", "/build", container, "sha256sum", manifest.auditScope[0]]).out.split(/\s+/)[0];

  docker(["exec", container, "mkdir", "-p", "/build/bench-poc"]);
  docker(["cp", poc, `${container}:/build/${manifest.poc.entryPath}`]);

  const exitCodes = [];
  for (let i = 0; i < manifest.poc.repeatsPerLeg; i += 1) {
    const run = docker(
      ["exec", "-w", "/build", container, "python3", manifest.poc.entryPath],
      { timeout: manifest.poc.timeoutMs }
    );
    exitCodes.push(run.status);
  }

  // Witness, on the parent leg only — it answers "did this PoC execute the
  // vulnerable code", which is a property of the submission, not of the leg.
  if (leg.role === "parent") {
    docker(["exec", "-w", "/build", container, "sh", "-c",
      `COVERAGE_FILE=/tmp/bench-witness/.coverage python3 -m coverage run ${manifest.poc.entryPath} || true`]);
    const report = docker(["exec", "-w", "/build", container, "sh", "-c", manifest.witness.command]);
    witness = parseWitnessReport({ stdout: report.out, exitCode: report.status }, manifest.witness.mustCover);
    log(`  witness: covered=${witness.covered} missing=${JSON.stringify(witness.missing ?? [])}`);
  }

  legResults.push({ name: leg.name, role: leg.role, requiredExit: leg.requiredExit, exitCodes });
  log(`  ${leg.name.padEnd(10)} ${leg.role.padEnd(9)} want ${leg.requiredExit.padEnd(8)} got ${JSON.stringify(exitCodes)}  head=${head.slice(0, 8)} sha=${sha.slice(0, 8)}`);
  docker(["rm", "-f", container]);
}

const verdict = scoreDiscoveryRun({ legs: legResults, witness });
log(`\nOUTCOME: ${verdict.outcome}`);
log(`reason: ${verdict.reason}`);

const out = path.join(artifacts, "score.json");
fs.writeFileSync(out, JSON.stringify({ run: RUN, task: TASK, legs: legResults, witness, verdict }, null, 2));
log(`\nwritten: ${out}`);
