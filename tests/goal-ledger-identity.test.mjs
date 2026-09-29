import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir } from "./helpers.mjs";
import { appendLedger, readLedger, stateDir } from "../plugins/goal/scripts/lib/ledger.mjs";

process.env.GOAL_COMPANION_STATE_ROOT = makeTempDir("goal-identity-state-");
process.env.CLAUDE_CONFIG_DIR = makeTempDir("goal-identity-config-");
delete process.env.CLAUDE_PLUGIN_DATA;

function aliasFor(project) {
  const alias = path.join(makeTempDir("goal-identity-alias-"), "project-alias");
  fs.symlinkSync(project, alias, process.platform === "win32" ? "junction" : "dir");
  return alias;
}

// The pre-canonicalization storage contract, needed to recover existing data.
function legacyKey(project) {
  const resolved = path.resolve(project);
  return `${path.basename(resolved)}-${createHash("sha256").update(resolved).digest("hex").slice(0, 16)}`;
}

function seedLegacy(root, project, lines) {
  const dir = path.join(root, legacyKey(project));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "ledger.jsonl");
  fs.writeFileSync(file, `${lines.join("\n")}\n`);
  return file;
}

const earlier = JSON.stringify({ at: "2026-08-01T00:00:00.000Z", event: "step-started", itemId: "earlier" });

test("ledger history remains readable after the project directory is removed", () => {
  const project = fs.realpathSync.native(makeTempDir("goal-identity-removed-"));
  appendLedger(project, { event: "step-started", itemId: "retained" });
  const original = stateDir(project);
  fs.rmdirSync(project);
  assert.equal(stateDir(project), original);
  assert.equal(readLedger(project).entries[0].itemId, "retained");
  assert.equal(fs.existsSync(project), false);
});

test("directory aliases share one ledger for reads and appends", () => {
  const project = makeTempDir("goal-identity-project-");
  const alias = aliasFor(project);
  assert.equal(stateDir(alias), stateDir(project));
  appendLedger(project, { event: "step-started", itemId: "first" });
  appendLedger(alias, { event: "disposition", itemId: "second" });
  assert.deepEqual(readLedger(project).entries.map((entry) => entry.itemId), ["first", "second"]);
  assert.deepEqual(readLedger(alias), readLedger(project));
});

test("Windows path casing shares one ledger", (t) => {
  if (process.platform !== "win32") {
    t.skip("Windows case-insensitive paths are required for this contract.");
    return;
  }
  const project = makeTempDir("Goal-Identity-Project-");
  const alias = project.toLowerCase();
  assert.notEqual(project, alias);
  assert.equal(fs.realpathSync.native(project), fs.realpathSync.native(alias));
  assert.equal(stateDir(project), stateDir(alias));
  appendLedger(alias, { event: "step-started", itemId: "same-directory" });
  assert.equal(readLedger(project).entries[0].itemId, "same-directory");
});

test("legacy alias history merges once with canonical history and preserves corrupt lines", () => {
  const project = makeTempDir("goal-identity-project-");
  const alias = aliasFor(project);
  appendLedger(project, { event: "disposition", itemId: "later" });
  const source = seedLegacy(process.env.GOAL_COMPANION_STATE_ROOT, alias, [earlier, "{torn write"]);

  const healed = readLedger(alias);
  assert.deepEqual(healed.entries.map((entry) => entry.itemId), ["earlier", "later"]);
  assert.equal(healed.corruptCount, 1);
  assert.equal(fs.readFileSync(`${source}.migrated`, "utf8"), `${earlier}\n{torn write\n`);
  assert.equal(fs.existsSync(source), false);
  assert.deepEqual(readLedger(project), healed);
  assert.deepEqual(readLedger(alias), healed);
});

test("append through a Windows case alias recovers its legacy history", (t) => {
  if (process.platform !== "win32") {
    t.skip("Windows case-insensitive paths are required for this contract.");
    return;
  }
  const project = makeTempDir("Goal-Identity-Project-");
  const alias = project.toLowerCase();
  const source = seedLegacy(process.env.GOAL_COMPANION_STATE_ROOT, alias, [earlier]);
  appendLedger(alias, { event: "disposition", itemId: "later" });
  assert.deepEqual(readLedger(project).entries.map((entry) => entry.itemId), ["earlier", "later"]);
  assert.equal(fs.readFileSync(`${source}.migrated`, "utf8"), `${earlier}\n`);
});

test("recovering a reused alias preserves every previous migration archive", () => {
  const project = makeTempDir("goal-identity-project-");
  const alias = aliasFor(project);
  const source = seedLegacy(process.env.GOAL_COMPANION_STATE_ROOT, alias, [earlier]);
  fs.writeFileSync(`${source}.migrated`, "first original\n");
  fs.writeFileSync(`${source}.migrated.1`, "second original\n");
  assert.equal(readLedger(alias).entries.length, 1);
  assert.equal(fs.readFileSync(`${source}.migrated`, "utf8"), "first original\n");
  assert.equal(fs.readFileSync(`${source}.migrated.1`, "utf8"), "second original\n");
  assert.equal(fs.readFileSync(`${source}.migrated.2`, "utf8"), `${earlier}\n`);
  assert.equal(readLedger(project).entries.length, 1);
});

test("legacy plugin-data aliases migrate into the canonical project ledger", () => {
  const project = makeTempDir("goal-identity-project-");
  const alias = aliasFor(project);
  const source = seedLegacy(
    path.join(process.env.CLAUDE_CONFIG_DIR, "plugins", "data", "old-install", "goal-companion"),
    alias,
    [earlier]
  );
  assert.equal(readLedger(alias).entries[0].itemId, "earlier");
  assert.equal(fs.readFileSync(`${source}.migrated`, "utf8"), `${earlier}\n`);
  assert.equal(readLedger(project).entries.length, 1);
});

test("different projects with the same basename keep separate ledgers", () => {
  const first = path.join(makeTempDir("goal-identity-parent-"), "project");
  const second = path.join(makeTempDir("goal-identity-parent-"), "project");
  fs.mkdirSync(first);
  fs.mkdirSync(second);
  assert.notEqual(stateDir(first), stateDir(second));
  appendLedger(first, { event: "step-started", itemId: "only-first" });
  assert.deepEqual(readLedger(second), { entries: [], corruptCount: 0 });
});
