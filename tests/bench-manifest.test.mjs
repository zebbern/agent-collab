// Validates every bench task directory (bench/tasks/*) against the shared
// manifest contract. This suite IS the benchmark's validity gate for the
// static shape of each task; tests/bench-runner.test.mjs and the manual
// worktree calibration (see the goal ledger) separately prove RED-at-parent
// / GREEN-at-fix behavior.
//
// Prefers bench/lib/manifest.mjs (the harness owner's canonical
// loadManifest/validateManifest) when present, so this suite and the runner
// agree on one implementation. bench/lib/manifest.mjs did not exist yet at
// the time this file was written; the fallback below mirrors the shared
// contract described in the task brief and the goal-state.mjs error-message
// style (plugins/goal/scripts/lib/goal-state.mjs validateGoal) so the suite
// is never blocked on integration order. Once bench/lib/manifest.mjs lands,
// delete the fallback branch below and always import it.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TASKS_DIR = path.join(ROOT, "bench", "tasks");
const MANIFEST_LIB = path.join(ROOT, "bench", "lib", "manifest.mjs");

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isPathArray(value) {
  return Array.isArray(value) && value.every((entry) => isNonEmptyString(entry));
}

function isFromToArray(value) {
  return (
    Array.isArray(value) &&
    value.every(
      (entry) =>
        typeof entry === "object" &&
        entry !== null &&
        isNonEmptyString(entry.from) &&
        isNonEmptyString(entry.to)
    )
  );
}

// Fallback validator: mirrors the SHARED MANIFEST CONTRACT. An empty array
// means valid, matching validateGoal's contract.
function validateManifestLocal(value) {
  const errors = [];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return ["manifest must be a JSON object"];
  }
  if (value.schemaVersion !== 1) {
    errors.push("schemaVersion must be 1");
  }
  if (!isNonEmptyString(value.id)) {
    errors.push("id must be a non-empty string");
  }
  if (!isNonEmptyString(value.fixSha)) {
    errors.push("fixSha must be a non-empty string");
  }
  if (!isNonEmptyString(value.parentSha)) {
    errors.push("parentSha must be a non-empty string");
  }
  if (!isNonEmptyString(value.symptomFile)) {
    errors.push("symptomFile must be a non-empty string");
  }
  if (typeof value.groundTruth !== "object" || value.groundTruth === null) {
    errors.push("groundTruth must be an object");
  } else {
    if (!isFromToArray(value.groundTruth.tests)) {
      errors.push("groundTruth.tests must be an array of {from, to} string pairs");
    }
    if (!isFromToArray(value.groundTruth.fixtures)) {
      errors.push("groundTruth.fixtures must be an array of {from, to} string pairs");
    }
  }
  if (value.classBonus !== null) {
    if (typeof value.classBonus !== "object") {
      errors.push("classBonus must be null or an object");
    } else if (!isFromToArray(value.classBonus.tests)) {
      errors.push("classBonus.tests must be an array of {from, to} string pairs");
    }
  }
  if (typeof value.originalStrict !== "object" || value.originalStrict === null) {
    errors.push("originalStrict must be an object");
  } else {
    if (!isPathArray(value.originalStrict.transplantFromFix)) {
      errors.push("originalStrict.transplantFromFix must be an array of strings");
    }
    if (!Array.isArray(value.originalStrict.excludeTestNames)) {
      errors.push("originalStrict.excludeTestNames must be an array");
    }
    if (!isNonEmptyString(value.originalStrict.caveat)) {
      errors.push("originalStrict.caveat must be a non-empty string");
    }
  }
  if (!isPathArray(value.regressionSuite)) {
    errors.push("regressionSuite must be an array of strings");
  }
  if (typeof value.driftCheckRequired !== "boolean") {
    errors.push("driftCheckRequired must be a boolean");
  }
  if (typeof value.timeouts !== "object" || value.timeouts === null) {
    errors.push("timeouts must be an object");
  } else {
    if (!Number.isInteger(value.timeouts.claudeMs) || value.timeouts.claudeMs <= 0) {
      errors.push("timeouts.claudeMs must be a positive integer");
    }
    if (!Number.isInteger(value.timeouts.testMs) || value.timeouts.testMs <= 0) {
      errors.push("timeouts.testMs must be a positive integer");
    }
  }
  if (typeof value.budgetUsd !== "number" || value.budgetUsd <= 0) {
    errors.push("budgetUsd must be a positive number");
  }
  if (!isPathArray(value.forbiddenSymptomStrings)) {
    errors.push("forbiddenSymptomStrings must be an array of strings");
  }
  return errors;
}

function loadManifestLocal(taskDir) {
  const file = path.join(taskDir, "manifest.json");
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (error) {
    throw new Error(`Cannot read ${file}: ${error.message}`);
  }
  let manifest;
  try {
    manifest = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${path.basename(taskDir)}/manifest.json is not valid JSON: ${error.message}`);
  }
  const errors = validateManifestLocal(manifest);
  if (errors.length > 0) {
    throw new Error(`${path.basename(taskDir)}/manifest.json is not a valid manifest:\n  - ${errors.join("\n  - ")}`);
  }
  return manifest;
}

let manifestLib = null;
if (fs.existsSync(MANIFEST_LIB)) {
  manifestLib = await import(pathToFileURL(MANIFEST_LIB).href);
}

function loadManifest(taskDir) {
  if (manifestLib?.loadManifest) {
    return manifestLib.loadManifest(taskDir);
  }
  return loadManifestLocal(taskDir);
}

function git(args) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();
}

function gitOk(args) {
  try {
    execFileSync("git", args, { cwd: ROOT, stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

// The archaeology assertions need the repo's actual history. Two real
// environments legitimately lack it: a shallow clone (CI checkout with the
// default fetch-depth), and the docker verify leg when the source checkout is
// a git WORKTREE (its .git is a pointer file the container copy must
// exclude). In those environments the checks skip loudly; everywhere with
// full history — dev checkouts, the native verify leg, CI with
// fetch-depth: 0 — they enforce. A resolvable-but-wrong SHA is always a
// failure, never a skip: this guard only fires when history as a whole is
// absent, so archaeology rot cannot hide behind it.
const HISTORY_UNAVAILABLE_REASON = (() => {
  if (!gitOk(["rev-parse", "--is-inside-work-tree"])) {
    return "this checkout has no git repository (the docker verify leg copies the tree without .git)";
  }
  try {
    if (git(["rev-parse", "--is-shallow-repository"]) === "true") {
      return "this checkout is shallow; historical fix/parent SHAs are not fetched (use fetch-depth: 0)";
    }
  } catch {
    return "git history could not be interrogated";
  }
  return null;
})();

function listTaskDirs() {
  if (!fs.existsSync(TASKS_DIR)) {
    return [];
  }
  return fs
    .readdirSync(TASKS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(TASKS_DIR, entry.name))
    .sort();
}

const taskDirs = listTaskDirs();

test("at least one bench task directory exists under bench/tasks", () => {
  assert.ok(taskDirs.length > 0, "expected bench/tasks/* to contain task directories");
});

test("bench/lib/manifest.mjs is used when present; local fallback is documented otherwise", (t) => {
  if (!manifestLib) {
    t.diagnostic(
      "bench/lib/manifest.mjs not found; validated with the local fallback in this file. " +
        "Integrator note: once bench/lib/manifest.mjs exists, this suite auto-adopts it (see the " +
        "top-of-file comment) -- no further action needed here."
    );
  }
});

for (const taskDir of taskDirs) {
  const taskName = path.basename(taskDir);

  test(`${taskName}: manifest.json loads and validates`, () => {
    const manifest = loadManifest(taskDir);
    assert.equal(manifest.id, taskName, `manifest.id should match its directory name (${taskName})`);
  });

  test(`${taskName}: fixSha and parentSha resolve, and parentSha is fixSha's first parent`, (t) => {
    if (HISTORY_UNAVAILABLE_REASON) {
      t.skip(`bench archaeology needs full git history — ${HISTORY_UNAVAILABLE_REASON}`);
      return;
    }
    const manifest = loadManifest(taskDir);

    assert.ok(gitOk(["cat-file", "-e", manifest.fixSha]), `fixSha ${manifest.fixSha} does not resolve in this repo`);
    assert.ok(
      gitOk(["cat-file", "-e", manifest.parentSha]),
      `parentSha ${manifest.parentSha} does not resolve in this repo`
    );

    const actualParent = git(["rev-parse", `${manifest.fixSha}^`]);
    assert.equal(
      actualParent,
      manifest.parentSha,
      `parentSha must be fixSha's first parent (git rev-parse ${manifest.fixSha}^ = ${actualParent})`
    );
  });

  test(`${taskName}: symptom.md exists, is non-empty, and avoids forbiddenSymptomStrings`, () => {
    const manifest = loadManifest(taskDir);
    const symptomPath = path.join(taskDir, manifest.symptomFile);

    assert.ok(fs.existsSync(symptomPath), `${symptomPath} does not exist`);
    const contents = fs.readFileSync(symptomPath, "utf8");
    assert.ok(contents.trim().length > 0, `${symptomPath} is empty`);

    const lowerContents = contents.toLowerCase();
    for (const forbidden of manifest.forbiddenSymptomStrings) {
      assert.ok(
        !lowerContents.includes(String(forbidden).toLowerCase()),
        `symptom.md leaks the forbidden string "${forbidden}" (case-insensitive)`
      );
    }
  });

  test(`${taskName}: every groundTruth and classBonus "from" file exists in the task directory`, () => {
    const manifest = loadManifest(taskDir);
    const fromPaths = [
      ...manifest.groundTruth.tests.map((entry) => entry.from),
      ...manifest.groundTruth.fixtures.map((entry) => entry.from),
      ...(manifest.classBonus ? manifest.classBonus.tests.map((entry) => entry.from) : [])
    ];

    assert.ok(fromPaths.length > 0, "expected at least one groundTruth file");
    for (const relativePath of fromPaths) {
      const absolutePath = path.join(taskDir, relativePath);
      assert.ok(fs.existsSync(absolutePath), `groundTruth/classBonus file missing: ${absolutePath}`);
    }
  });

  test(`${taskName}: every originalStrict.transplantFromFix path exists at fixSha`, (t) => {
    if (HISTORY_UNAVAILABLE_REASON) {
      t.skip(`bench archaeology needs full git history — ${HISTORY_UNAVAILABLE_REASON}`);
      return;
    }
    const manifest = loadManifest(taskDir);
    for (const relativePath of manifest.originalStrict.transplantFromFix) {
      assert.ok(
        gitOk(["cat-file", "-e", `${manifest.fixSha}:${relativePath}`]),
        `${relativePath} does not exist at fixSha ${manifest.fixSha}`
      );
    }
  });
}
