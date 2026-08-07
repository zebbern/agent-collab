import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { makeTempDir, run } from "./helpers.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "scripts", "bump-version.mjs");

const PLUGIN_VERSIONS = {
  codex: "1.0.6+fork.4",
  cursor: "0.4.0",
  goal: "0.1.0"
};
const REPO_VERSION = "1.0.6+fork.4";

function writeJson(filePath, json) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(json, null, 2)}\n`);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function pluginJsonPath(root, name) {
  return path.join(root, "plugins", name, ".claude-plugin", "plugin.json");
}

function marketplaceJsonPath(root) {
  return path.join(root, ".claude-plugin", "marketplace.json");
}

function makeVersionFixture() {
  const root = makeTempDir();

  writeJson(path.join(root, "package.json"), {
    name: "agent-collab",
    version: REPO_VERSION
  });
  writeJson(path.join(root, "package-lock.json"), {
    name: "agent-collab",
    version: REPO_VERSION,
    lockfileVersion: 3,
    packages: {
      "": {
        name: "agent-collab",
        version: REPO_VERSION
      }
    }
  });

  for (const [name, version] of Object.entries(PLUGIN_VERSIONS)) {
    writeJson(pluginJsonPath(root, name), { name, version });
  }

  writeJson(marketplaceJsonPath(root), {
    metadata: {
      version: REPO_VERSION
    },
    plugins: Object.entries(PLUGIN_VERSIONS).map(([name, version]) => ({
      name,
      version
    }))
  });

  return root;
}

function marketplaceEntry(root, name) {
  return readJson(marketplaceJsonPath(root)).plugins.find((entry) => entry.name === name);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

test("bump-version touches only the target plugin's plugin.json and marketplace entry", () => {
  const root = makeVersionFixture();

  const result = run("node", [SCRIPT, "--root", root, "cursor", "0.5.0"], { cwd: ROOT });
  assert.equal(result.status, 0, result.stderr);

  assert.equal(readJson(pluginJsonPath(root, "cursor")).version, "0.5.0");
  assert.equal(marketplaceEntry(root, "cursor").version, "0.5.0");

  // Every other plugin's sites are untouched.
  assert.equal(readJson(pluginJsonPath(root, "codex")).version, PLUGIN_VERSIONS.codex);
  assert.equal(marketplaceEntry(root, "codex").version, PLUGIN_VERSIONS.codex);
  assert.equal(readJson(pluginJsonPath(root, "goal")).version, PLUGIN_VERSIONS.goal);
  assert.equal(marketplaceEntry(root, "goal").version, PLUGIN_VERSIONS.goal);

  // Repo-level metadata is untouched by a plugin bump.
  assert.equal(readJson(path.join(root, "package.json")).version, REPO_VERSION);
  assert.equal(readJson(path.join(root, "package-lock.json")).version, REPO_VERSION);
  assert.equal(readJson(marketplaceJsonPath(root)).metadata.version, REPO_VERSION);
});

test("bump-version repo target updates package.json, package-lock.json, and marketplace metadata.version in lockstep", () => {
  const root = makeVersionFixture();

  const result = run("node", [SCRIPT, "--root", root, "repo", "1.1.0"], { cwd: ROOT });
  assert.equal(result.status, 0, result.stderr);

  assert.equal(readJson(path.join(root, "package.json")).version, "1.1.0");
  assert.equal(readJson(path.join(root, "package-lock.json")).version, "1.1.0");
  assert.equal(readJson(path.join(root, "package-lock.json")).packages[""].version, "1.1.0");
  assert.equal(readJson(marketplaceJsonPath(root)).metadata.version, "1.1.0");

  // No plugin site is touched by a repo bump.
  for (const [name, version] of Object.entries(PLUGIN_VERSIONS)) {
    assert.equal(readJson(pluginJsonPath(root, name)).version, version);
    assert.equal(marketplaceEntry(root, name).version, version);
  }
});

test("bump-version --check passes for a fully consistent fixture", () => {
  const root = makeVersionFixture();

  const result = run("node", [SCRIPT, "--root", root, "--check"], { cwd: ROOT });
  assert.equal(result.status, 0, result.stderr);
});

for (const name of Object.keys(PLUGIN_VERSIONS)) {
  test(`bump-version --check catches a plugin.json/marketplace.json mismatch for ${name}`, () => {
    const root = makeVersionFixture();
    writeJson(pluginJsonPath(root, name), { name, version: "9.9.9" });

    const expectedFile = path.join("plugins", name, ".claude-plugin", "plugin.json");
    const resultAll = run("node", [SCRIPT, "--root", root, "--check"], { cwd: ROOT });
    assert.notEqual(resultAll.status, 0);
    assert.match(resultAll.stderr, new RegExp(`${escapeRegExp(expectedFile)} version`));

    const resultOne = run("node", [SCRIPT, "--root", root, "--check", name], { cwd: ROOT });
    assert.notEqual(resultOne.status, 0);
    assert.match(resultOne.stderr, /version metadata disagrees/);
  });
}

test("bump-version --check catches a package.json/package-lock.json mismatch", () => {
  const root = makeVersionFixture();
  const lockPath = path.join(root, "package-lock.json");
  const lock = readJson(lockPath);
  lock.version = "9.9.9";
  writeJson(lockPath, lock);

  const resultAll = run("node", [SCRIPT, "--root", root, "--check"], { cwd: ROOT });
  assert.notEqual(resultAll.status, 0);
  assert.match(resultAll.stderr, /package-lock\.json version/);
  assert.match(resultAll.stderr, /version metadata disagrees/);

  const resultRepo = run("node", [SCRIPT, "--root", root, "--check", "repo"], { cwd: ROOT });
  assert.notEqual(resultRepo.status, 0);
  assert.match(resultRepo.stderr, /package-lock\.json version/);
});

test("bump-version refuses an unknown target and lists the known ones", () => {
  const root = makeVersionFixture();

  const result = run("node", [SCRIPT, "--root", root, "bogus", "1.2.3"], { cwd: ROOT });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Unknown target: bogus/);
  assert.match(result.stderr, /codex/);
  assert.match(result.stderr, /cursor/);
  assert.match(result.stderr, /goal/);
  assert.match(result.stderr, /repo/);

  // Nothing was written on refusal.
  assert.equal(readJson(pluginJsonPath(root, "codex")).version, PLUGIN_VERSIONS.codex);
});

test("bump-version refuses an invalid version string", () => {
  const root = makeVersionFixture();

  const result = run("node", [SCRIPT, "--root", root, "cursor", "not-a-version"], { cwd: ROOT });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /semver-like version/);

  // Nothing was written on refusal.
  assert.equal(readJson(pluginJsonPath(root, "cursor")).version, PLUGIN_VERSIONS.cursor);
});
