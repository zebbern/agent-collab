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
process.env.CLAUDE_PLUGIN_DATA = makeTempDir("goal-plugin-test-state-");

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

test("validateGoal refuses an unknown top-level key by name", () => {
  const errors = validateGoal(makeGoal({ blockedReson: "typo" }));
  assert.ok(errors.some((error) => /unknown key "blockedReson"/.test(error)), errors.join("; "));
});

test("saveGoal writes atomically and resolveGoal round-trips", () => {
  const project = makeTempDir("goal-plugin-test-proj-");
  const file = saveGoal(project, makeGoal());
  assert.equal(file, path.join(goalsDir(project), "test-goal.json"));
  assert.equal(fs.readdirSync(goalsDir(project)).length, 1); // no tmp residue

  const resolved = resolveGoal(project, "");
  assert.equal(resolved.slug, "test-goal");
  assert.equal(resolved.goal.backlog.length, 2);

  const stored = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(typeof stored.createdAt, "string");
});

test("resolveGoal refusals list what exists", () => {
  const empty = makeTempDir("goal-plugin-test-proj-");
  assert.throws(() => resolveGoal(empty, ""), /No goal files found/);

  const project = makeTempDir("goal-plugin-test-proj-");
  saveGoal(project, makeGoal({ slug: "goal-a" }));
  saveGoal(project, makeGoal({ slug: "goal-b" }));
  assert.throws(() => resolveGoal(project, ""), /goal-a.*goal-b|goal-b.*goal-a/s);
  assert.throws(() => resolveGoal(project, "goal-c"), /goal-c.*not found.*goal-a/s);
});

test("a hand-broken goal file refuses with specifics, never repairs", () => {
  const project = makeTempDir("goal-plugin-test-proj-");
  const file = saveGoal(project, makeGoal());
  fs.writeFileSync(file, "{not json");
  assert.throws(() => resolveGoal(project, "test-goal"), /test-goal\.json/);

  fs.writeFileSync(file, JSON.stringify({ ...makeGoal(), slug: "different" }));
  assert.throws(() => resolveGoal(project, "test-goal"), /slug .*different.* does not match/);
});

test("ledger appends under the plugin-data override and tolerates corrupt lines", () => {
  const project = makeTempDir("goal-plugin-test-proj-");
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

function writeGoalFixture(project, overrides = {}) {
  const goal = makeGoal(overrides);
  fs.mkdirSync(path.join(project, ".claude", "goals"), { recursive: true });
  fs.writeFileSync(
    path.join(project, ".claude", "goals", `${goal.slug}.json`),
    JSON.stringify(goal, null, 2)
  );
  return goal;
}

function companion(args, project) {
  return run(process.execPath, [SCRIPT, ...args, "--cwd", project], { env: { ...process.env } });
}

test("set validates and writes; status reports counts and ledger health", () => {
  const project = makeTempDir("goal-plugin-test-proj-");
  const draft = path.join(makeTempDir("goal-plugin-test-draft-"), "goal.json");
  fs.writeFileSync(draft, JSON.stringify(makeGoal()));

  const set = companion(["set", "--file", draft, "--json"], project);
  assert.equal(set.status, 0, set.stderr);
  assert.equal(JSON.parse(set.stdout).slug, "test-goal");

  const status = companion(["status", "--json"], project);
  assert.equal(status.status, 0, status.stderr);
  const payload = JSON.parse(status.stdout);
  assert.equal(payload.counts.todo, 2);
  assert.equal(payload.inProgress, null);
  assert.equal(payload.corruptLedgerLines, 0);
});

test("set refuses malformed drafts with specifics", () => {
  const project = makeTempDir("goal-plugin-test-proj-");
  const draft = path.join(makeTempDir("goal-plugin-test-draft-"), "goal.json");
  fs.writeFileSync(draft, JSON.stringify({ schemaVersion: 1, slug: "x" }));
  const set = companion(["set", "--file", draft], project);
  assert.equal(set.status, 1);
  assert.match(set.stderr, /statement must be a non-empty string/);
});

test("next returns the first todo and refuses on non-active goals", () => {
  const project = makeTempDir("goal-plugin-test-proj-");
  writeGoalFixture(project);
  const next = companion(["next", "--json"], project);
  assert.equal(next.status, 0, next.stderr);
  assert.equal(JSON.parse(next.stdout).item.id, "first-item");

  const blockedProject = makeTempDir("goal-plugin-test-proj-");
  writeGoalFixture(blockedProject, { status: "blocked", blockedReason: "waiting on a human" });
  const refused = companion(["next"], blockedProject);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /blocked.*waiting on a human/s);
});

test("help prints usage and unknown subcommands refuse", () => {
  const project = makeTempDir("goal-plugin-test-proj-");
  const help = companion(["help"], project);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /goal-companion\.mjs set --file/);
  const unknown = companion(["frobnicate"], project);
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /Unknown subcommand: frobnicate/);
});

test("start enforces one in-progress item and records step-started", () => {
  const project = makeTempDir("goal-plugin-test-proj-");
  writeGoalFixture(project);

  const start = companion(["start", "test-goal", "first-item", "--json"], project);
  assert.equal(start.status, 0, start.stderr);
  assert.equal(JSON.parse(start.stdout).item.status, "in-progress");

  const second = companion(["start", "test-goal", "second-item"], project);
  assert.equal(second.status, 1);
  assert.match(second.stderr, /first-item.*already in progress/s);

  const { entries } = readLedger(project);
  assert.equal(entries.at(-1).event, "step-started");
  assert.equal(entries.at(-1).itemId, "first-item");
});

test("status reports a ledger tail scoped to the resolved goal", () => {
  const project = makeTempDir("goal-plugin-test-proj-");
  writeGoalFixture(project);
  companion(["start", "test-goal", "first-item"], project);
  companion(
    ["record", "test-goal", "first-item", "--disposition", "dropped", "--notes", "n/a"],
    project
  );

  const status = companion(["status", "--json"], project);
  assert.equal(status.status, 0, status.stderr);
  const payload = JSON.parse(status.stdout);
  assert.equal(payload.ledgerTail.length, 2);
  assert.ok(payload.ledgerTail.every((entry) => entry.slug === "test-goal"));

  const text = companion(["status"], project);
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /step-started/);
});

test("record enforces the state machine and blocked halts the goal", () => {
  const project = makeTempDir("goal-plugin-test-proj-");
  writeGoalFixture(project);

  // todo -> merged is illegal; only dropped may skip in-progress.
  const illegal = companion(
    ["record", "test-goal", "first-item", "--disposition", "merged"],
    project
  );
  assert.equal(illegal.status, 1);
  assert.match(illegal.stderr, /must be in-progress/);

  const dropped = companion(
    ["record", "test-goal", "second-item", "--disposition", "dropped", "--notes", "obsolete"],
    project
  );
  assert.equal(dropped.status, 0, dropped.stderr);

  companion(["start", "test-goal", "first-item"], project);
  const blocked = companion(
    ["record", "test-goal", "first-item", "--disposition", "blocked", "--notes", "needs credentials"],
    project
  );
  assert.equal(blocked.status, 0, blocked.stderr);
  assert.equal(JSON.parse(companion(["status", "--json"], project).stdout).status, "blocked");

  const refused = companion(["next"], project);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /blocked.*needs credentials/s);
});

test("record merged stores the disposition with pr and delegate", () => {
  const project = makeTempDir("goal-plugin-test-proj-");
  writeGoalFixture(project);
  companion(["start", "test-goal", "first-item"], project);
  const record = companion(
    [
      "record", "test-goal", "first-item",
      "--disposition", "merged", "--pr", "12", "--delegate", "codex", "--notes", "landed"
    ],
    project
  );
  assert.equal(record.status, 0, record.stderr);
  const stored = JSON.parse(
    fs.readFileSync(path.join(project, ".claude", "goals", "test-goal.json"), "utf8")
  );
  const item = stored.backlog.find((candidate) => candidate.id === "first-item");
  assert.equal(item.status, "merged");
  assert.equal(item.disposition.pr, 12);
  assert.equal(item.disposition.delegate, "codex");
  assert.ok(item.disposition.recordedAt);

  const { entries } = readLedger(project);
  const last = entries.at(-1);
  assert.equal(last.event, "disposition");
  assert.equal(last.disposition, "merged");
  assert.equal(last.pr, 12);
});

test("multi-word option values survive the spawn boundary verbatim", () => {
  const project = makeTempDir("goal-plugin-test-proj-");
  writeGoalFixture(project);
  companion(["start", "test-goal", "first-item"], project);
  const record = companion(
    ["record", "test-goal", "first-item", "--disposition", "discarded", "--notes", "needs credentials and a second pass"],
    project
  );
  assert.equal(record.status, 0, record.stderr);
  const stored = JSON.parse(
    fs.readFileSync(path.join(project, ".claude", "goals", "test-goal.json"), "utf8")
  );
  assert.equal(
    stored.backlog.find((item) => item.id === "first-item").disposition.notes,
    "needs credentials and a second pass"
  );
});

test("check judges command criteria by exit code and lists manual ones", () => {
  const project = makeTempDir("goal-plugin-test-proj-");
  writeGoalFixture(project);
  const pass = companion(["check", "--json"], project);
  assert.equal(pass.status, 0, pass.stderr);
  const passPayload = JSON.parse(pass.stdout);
  assert.equal(passPayload.passed, true);
  assert.equal(passPayload.results.find((r) => r.kind === "manual").outcome, "manual");

  const failing = makeTempDir("goal-plugin-test-proj-");
  writeGoalFixture(failing, {
    acceptanceCriteria: [{ kind: "command", run: "node -e \"process.exit(3)\"", expect: "exit0" }]
  });
  const fail = companion(["check", "--json"], failing);
  assert.equal(fail.status, 1);
  assert.equal(JSON.parse(fail.stdout).passed, false);
});

test("check reports a timed-out criterion honestly, not as a plain failure", () => {
  const project = makeTempDir("goal-plugin-test-proj-");
  writeGoalFixture(project, {
    acceptanceCriteria: [
      {
        kind: "command",
        run: "node -e \"setTimeout(()=>{},60000)\"",
        expect: "exit0",
        timeoutMs: 1500
      }
    ]
  });
  const timedOut = companion(["check"], project);
  assert.equal(timedOut.status, 1);
  assert.match(timedOut.stdout, /ETIMEDOUT|timed?[ -]?out/i);
  assert.match(timedOut.stdout, /may still be running/);
});

test("close --done refuses while work remains, succeeds when the backlog is settled", () => {
  const project = makeTempDir("goal-plugin-test-proj-");
  writeGoalFixture(project);
  const early = companion(["close", "test-goal", "--done"], project);
  assert.equal(early.status, 1);
  assert.match(early.stderr, /todo/);

  companion(["record", "test-goal", "first-item", "--disposition", "dropped", "--notes", "n/a"], project);
  companion(["record", "test-goal", "second-item", "--disposition", "dropped", "--notes", "n/a"], project);
  const done = companion(["close", "test-goal", "--done", "--json"], project);
  assert.equal(done.status, 0, done.stderr);
  assert.equal(JSON.parse(done.stdout).status, "done");
});

test("closed goals are frozen: close --abandoned after close --done refuses", () => {
  const project = makeTempDir("goal-plugin-test-proj-");
  writeGoalFixture(project);
  companion(["record", "test-goal", "first-item", "--disposition", "dropped", "--notes", "n/a"], project);
  companion(["record", "test-goal", "second-item", "--disposition", "dropped", "--notes", "n/a"], project);
  const done = companion(["close", "test-goal", "--done"], project);
  assert.equal(done.status, 0, done.stderr);

  const abandoned = companion(["close", "test-goal", "--abandoned"], project);
  assert.equal(abandoned.status, 1);
  assert.match(abandoned.stderr, /already done/);
});

test("blocked is a full stop: record freezes and close --done refuses", () => {
  const project = makeTempDir("goal-plugin-test-proj-");
  writeGoalFixture(project);
  companion(["start", "test-goal", "first-item"], project);
  companion(["record", "test-goal", "first-item", "--disposition", "blocked", "--notes", "stuck"], project);

  const dropOnBlocked = companion(["record", "test-goal", "second-item", "--disposition", "dropped"], project);
  assert.equal(dropOnBlocked.status, 1);
  assert.match(dropOnBlocked.stderr, /blocked/);

  const done = companion(["close", "test-goal", "--done"], project);
  assert.equal(done.status, 1);
  assert.match(done.stderr, /blocked/);
  const stored = JSON.parse(
    fs.readFileSync(path.join(project, ".claude", "goals", "test-goal.json"), "utf8")
  );
  assert.equal(stored.status, "blocked");

  const abandoned = companion(["close", "test-goal", "--abandoned", "--json"], project);
  assert.equal(abandoned.status, 0, abandoned.stderr);
  const late = companion(["record", "test-goal", "second-item", "--disposition", "dropped"], project);
  assert.equal(late.status, 1);
  assert.match(late.stderr, /abandoned/);
});

test("close --done refuses a hand-edited active goal that still carries a blocked item", () => {
  const project = makeTempDir("goal-plugin-test-proj-");
  writeGoalFixture(project, {
    backlog: [
      { id: "stuck-item", title: "stuck", status: "blocked", disposition: { recordedAt: "2026-08-07T00:00:00.000Z", notes: "stuck" } },
      { id: "ok-item", title: "ok", status: "dropped", disposition: { recordedAt: "2026-08-07T00:00:00.000Z" } }
    ]
  });
  const done = companion(["close", "test-goal", "--done"], project);
  assert.equal(done.status, 1);
  assert.match(done.stderr, /stuck-item/);
});
