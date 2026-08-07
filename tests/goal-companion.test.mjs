// Behavior tests for the goal companion and its libs. E2E tests run the real
// CLI via node with temp-dir projects; lib tests import functions directly.
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { makeTempDir, run } from "./helpers.mjs";
import { parseCommandInput, resolveCommandCwd } from "../plugins/goal/scripts/lib/args.mjs";
import {
  validateGoal,
  resolveGoal,
  saveGoal,
  goalsDir
} from "../plugins/goal/scripts/lib/goal-state.mjs";
import { appendLedger, readLedger, stateDir } from "../plugins/goal/scripts/lib/ledger.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "plugins", "goal", "scripts", "goal-companion.mjs");

// Isolate goal-companion ledger state from any real plugin data on this host.
process.env.CLAUDE_PLUGIN_DATA = makeTempDir("goal-plugin-state-");

test("parseCommandInput handles flags, values, positionals, and the -C alias", () => {
  const { options, positionals } = parseCommandInput(
    ["record", "zb", "item-1", "--disposition", "merged", "--json", "-C", "C:/proj"],
    { valueOptions: ["cwd", "disposition"], booleanOptions: ["json"] }
  );
  assert.deepEqual(positionals, ["record", "zb", "item-1"]);
  assert.equal(options.disposition, "merged");
  assert.equal(options.json, true);
  assert.equal(options.cwd, "C:/proj");
  assert.equal(resolveCommandCwd(options), path.resolve("C:/proj"));
});

test("parseCommandInput refuses unknown options and missing values", () => {
  assert.throws(
    () => parseCommandInput(["--bogus"], { valueOptions: [], booleanOptions: [] }),
    /Unknown option: --bogus/
  );
  assert.throws(
    () => parseCommandInput(["--file"], { valueOptions: ["file"], booleanOptions: [] }),
    /--file requires a value/
  );
});

function makeGoal(overrides = {}) {
  return {
    schemaVersion: 1,
    slug: "test-goal",
    statement: "Prove the goal machinery works",
    acceptanceCriteria: [
      { kind: "command", run: "node -e \"process.exit(0)\"", expect: "exit0" },
      { kind: "manual", text: "A human is satisfied" }
    ],
    backlog: [
      { id: "first-item", title: "Do the first thing", status: "todo", disposition: null },
      { id: "second-item", title: "Do the second thing", status: "todo", disposition: null }
    ],
    budget: { perStepDelegations: 2 },
    status: "active",
    blockedReason: null,
    createdAt: "2026-08-07T00:00:00.000Z",
    updatedAt: "2026-08-07T00:00:00.000Z",
    ...overrides
  };
}

test("validateGoal accepts the reference shape and names every violation", () => {
  assert.deepEqual(validateGoal(makeGoal()), []);

  const errors = validateGoal(
    makeGoal({
      slug: "Bad Slug!",
      status: "cruising",
      backlog: [
        { id: "dup", title: "a", status: "todo", disposition: null },
        { id: "dup", title: "b", status: "in-progress", disposition: null },
        { id: "x", title: "c", status: "in-progress", disposition: null },
        { id: "y", title: "d", status: "merged", disposition: null }
      ]
    })
  );
  assert.ok(errors.some((error) => /slug/.test(error)), errors.join("; "));
  assert.ok(errors.some((error) => /status/.test(error)), errors.join("; "));
  assert.ok(errors.some((error) => /duplicate/.test(error)), errors.join("; "));
  assert.ok(errors.some((error) => /one item may be in-progress/.test(error)), errors.join("; "));
  assert.ok(errors.some((error) => /disposition/.test(error)), errors.join("; "));
});

test("saveGoal writes atomically and resolveGoal round-trips", () => {
  const project = makeTempDir("goal-proj-");
  const file = saveGoal(project, makeGoal());
  assert.equal(file, path.join(goalsDir(project), "test-goal.json"));
  assert.equal(fs.readdirSync(goalsDir(project)).length, 1); // no tmp residue

  const resolved = resolveGoal(project, "");
  assert.equal(resolved.slug, "test-goal");
  assert.equal(resolved.goal.backlog.length, 2);
});

test("resolveGoal refusals list what exists", () => {
  const empty = makeTempDir("goal-proj-");
  assert.throws(() => resolveGoal(empty, ""), /No goal files found/);

  const project = makeTempDir("goal-proj-");
  saveGoal(project, makeGoal({ slug: "goal-a" }));
  saveGoal(project, makeGoal({ slug: "goal-b" }));
  assert.throws(() => resolveGoal(project, ""), /goal-a.*goal-b|goal-b.*goal-a/s);
  assert.throws(() => resolveGoal(project, "goal-c"), /goal-c.*not found.*goal-a/s);
});

test("a hand-broken goal file refuses with specifics, never repairs", () => {
  const project = makeTempDir("goal-proj-");
  const file = saveGoal(project, makeGoal());
  fs.writeFileSync(file, "{not json");
  assert.throws(() => resolveGoal(project, "test-goal"), /test-goal\.json/);

  fs.writeFileSync(file, JSON.stringify({ ...makeGoal(), slug: "different" }));
  assert.throws(() => resolveGoal(project, "test-goal"), /slug .*different.* does not match/);
});

test("ledger appends under the plugin-data override and tolerates corrupt lines", () => {
  const project = makeTempDir("goal-proj-");
  assert.ok(
    stateDir(project).startsWith(path.join(process.env.CLAUDE_PLUGIN_DATA, "goal-companion")),
    stateDir(project)
  );

  assert.deepEqual(readLedger(project), { entries: [], corruptCount: 0 });

  appendLedger(project, { slug: "g", itemId: "i", event: "step-started" });
  appendLedger(project, { slug: "g", itemId: "i", event: "disposition", disposition: "merged" });
  fs.appendFileSync(path.join(stateDir(project), "ledger.jsonl"), "{torn write\n");

  const { entries, corruptCount } = readLedger(project);
  assert.equal(entries.length, 2);
  assert.equal(corruptCount, 1);
  assert.equal(entries[0].event, "step-started");
  assert.ok(typeof entries[0].at === "string" && entries[0].at.includes("T"));
});
