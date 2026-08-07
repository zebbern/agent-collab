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

test("parseCommandInput refuses a typo'd short flag instead of absorbing it as a positional", () => {
  assert.throws(
    () => parseCommandInput(["status", "-x", "slug"], { valueOptions: [], booleanOptions: [] }),
    /Unknown option: -x/
  );
  // -C keeps resolving cwd unaffected by the new short-flag guard.
  const { options } = parseCommandInput(["-C", "C:/proj"], { valueOptions: [], booleanOptions: [] });
  assert.equal(options.cwd, "C:/proj");
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

test("validateGoal requires createdAt/updatedAt, when present, to be date-parseable strings", () => {
  const badCreated = validateGoal(makeGoal({ createdAt: 12345 }));
  assert.ok(
    badCreated.some((error) => /createdAt must be a date-parseable string when present/.test(error)),
    badCreated.join("; ")
  );

  const badUpdated = validateGoal(makeGoal({ updatedAt: "not-a-date" }));
  assert.ok(
    badUpdated.some((error) => /updatedAt must be a date-parseable string when present/.test(error)),
    badUpdated.join("; ")
  );

  assert.deepEqual(validateGoal(makeGoal({ createdAt: "2026-08-07T00:00:00.000Z" })), []);
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

test("appendLedger refuses a pre-planted regular FILE at the leaf state-dir path", () => {
  const project = makeTempDir("goal-plugin-test-proj-");
  const leaf = stateDir(project);
  fs.mkdirSync(path.dirname(leaf), { recursive: true });
  fs.writeFileSync(leaf, "not a directory");

  assert.throws(
    () => appendLedger(project, { slug: "g", itemId: "i", event: "step-started" }),
    /not a private directory/
  );
});

test("appendLedger refuses a pre-planted SYMLINK at the leaf state-dir path", (t) => {
  const project = makeTempDir("goal-plugin-test-proj-");
  const leaf = stateDir(project);
  fs.mkdirSync(path.dirname(leaf), { recursive: true });
  const elsewhere = makeTempDir("goal-plugin-test-symlink-target-");
  try {
    fs.symlinkSync(elsewhere, leaf, "dir");
  } catch (error) {
    if (error?.code === "EPERM" || error?.code === "EACCES") {
      t.skip("Symlink creation requires elevated privileges on this platform.");
      return;
    }
    throw error;
  }

  assert.throws(
    () => appendLedger(project, { slug: "g", itemId: "i", event: "step-started" }),
    /not a private directory/
  );
  // No write-through: the refusal must come before anything lands under the
  // symlink target.
  assert.equal(fs.existsSync(path.join(elsewhere, "ledger.jsonl")), false);
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

test("ledger filters entries to the requested slug and surfaces corrupt-line counts", () => {
  const project = makeTempDir("goal-plugin-test-proj-");
  writeGoalFixture(project, { slug: "goal-a" });
  writeGoalFixture(project, { slug: "goal-b" });

  companion(["start", "goal-a", "first-item"], project);
  companion(["record", "goal-a", "first-item", "--disposition", "dropped", "--notes", "n/a"], project);
  companion(["start", "goal-b", "first-item"], project);

  const ledger = companion(["ledger", "goal-a", "--json"], project);
  assert.equal(ledger.status, 0, ledger.stderr);
  const payload = JSON.parse(ledger.stdout);
  assert.equal(payload.slug, "goal-a");
  assert.equal(payload.entries.length, 2);
  assert.ok(payload.entries.every((entry) => entry.slug === "goal-a"));
  assert.equal(payload.corruptLedgerLines, 0);

  fs.appendFileSync(path.join(stateDir(project), "ledger.jsonl"), "{torn write\n");
  const withTorn = companion(["ledger", "goal-a"], project);
  assert.equal(withTorn.status, 0, withTorn.stderr);
  assert.match(withTorn.stdout, /1 corrupt line/);
});

test("ledger's slug resolution refuses ambiguity exactly like status", () => {
  const project = makeTempDir("goal-plugin-test-proj-");
  writeGoalFixture(project, { slug: "goal-a" });
  writeGoalFixture(project, { slug: "goal-b" });

  const ambiguous = companion(["ledger"], project);
  assert.equal(ambiguous.status, 1);
  assert.match(ambiguous.stderr, /goal-a.*goal-b|goal-b.*goal-a/s);

  const missing = companion(["ledger", "goal-c"], project);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /goal-c.*not found.*goal-a/s);
});

test("ledger is read-only history: it works on a closed (non-active) goal", () => {
  const project = makeTempDir("goal-plugin-test-proj-");
  writeGoalFixture(project);
  companion(["record", "test-goal", "first-item", "--disposition", "dropped", "--notes", "n/a"], project);
  companion(["record", "test-goal", "second-item", "--disposition", "dropped", "--notes", "n/a"], project);
  const abandoned = companion(["close", "test-goal", "--abandoned"], project);
  assert.equal(abandoned.status, 0, abandoned.stderr);

  const ledger = companion(["ledger", "test-goal", "--json"], project);
  assert.equal(ledger.status, 0, ledger.stderr);
  const payload = JSON.parse(ledger.stdout);
  assert.equal(payload.slug, "test-goal");
  // 2 dispositions (record x2) + 1 closed event from `close --abandoned`.
  assert.equal(payload.entries.length, 3);
  assert.equal(payload.entries.at(-1).event, "closed");
  assert.equal(payload.entries.at(-1).status, "abandoned");
});

test("ledger --all pools every goal's events for the portfolio scope", () => {
  const project = makeTempDir("goal-plugin-test-proj-");
  writeGoalFixture(project, { slug: "goal-a" });
  writeGoalFixture(project, { slug: "goal-b" });
  companion(["start", "goal-a", "first-item"], project);
  companion(["record", "goal-a", "first-item", "--disposition", "discarded", "--notes", "n/a"], project);
  companion(["start", "goal-b", "first-item"], project);

  const pooled = companion(["ledger", "--all", "--json"], project);
  assert.equal(pooled.status, 0, pooled.stderr);
  const payload = JSON.parse(pooled.stdout);
  assert.equal(payload.scope, "portfolio");
  assert.deepEqual([...payload.goals].sort(), ["goal-a", "goal-b"]);
  // Every pooled entry keeps its slug, so grouping by goal stays possible.
  assert.equal(payload.entries.length, 3);
  assert.ok(payload.entries.every((entry) => entry.slug === "goal-a" || entry.slug === "goal-b"));
  // The text render prefixes the slug for the same reason.
  const rendered = companion(["ledger", "--all"], project);
  assert.match(rendered.stdout, /\[goal-b\] .*step-started/);
});

test("ledger --all refuses a slug and refuses an empty project", () => {
  const project = makeTempDir("goal-plugin-test-proj-");
  writeGoalFixture(project);
  const both = companion(["ledger", "test-goal", "--all"], project);
  assert.equal(both.status, 1);
  assert.match(both.stderr, /--all takes no slug/);

  const empty = makeTempDir("goal-plugin-test-proj-");
  const none = companion(["ledger", "--all"], empty);
  assert.equal(none.status, 1);
  assert.match(none.stderr, /No goal files found/);
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

test("check's rendered line omits the timeout caveat for a non-timeout spawn failure", () => {
  const project = makeTempDir("goal-plugin-test-proj-");
  writeGoalFixture(project, {
    // Exceeds spawnSync's default 1MB stdout buffer, producing a real
    // outcome.error (ENOBUFS) that is NOT a timeout — the honest-suffix
    // fix must not claim "its processes may still be running" here.
    acceptanceCriteria: [
      {
        kind: "command",
        run: "node -e \"process.stdout.write(String(1).repeat(2000000))\"",
        expect: "exit0"
      }
    ]
  });
  const failing = companion(["check"], project);
  assert.equal(failing.status, 1);
  assert.doesNotMatch(failing.stdout, /may still be running/);
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
  // The refusal now fires at load (validateGoal's active/blocked invariant); handleClose's own guard is the belt-and-suspenders layer behind it.
  const done = companion(["close", "test-goal", "--done"], project);
  assert.equal(done.status, 1);
  assert.match(done.stderr, /stuck-item/);
});

test("close --done appends exactly one closed event carrying the final status", () => {
  const project = makeTempDir("goal-plugin-test-proj-");
  writeGoalFixture(project);
  companion(["record", "test-goal", "first-item", "--disposition", "dropped", "--notes", "n/a"], project);
  companion(["record", "test-goal", "second-item", "--disposition", "dropped", "--notes", "n/a"], project);
  const done = companion(["close", "test-goal", "--done"], project);
  assert.equal(done.status, 0, done.stderr);

  const { entries } = readLedger(project);
  const closedEvents = entries.filter((entry) => entry.event === "closed");
  assert.equal(closedEvents.length, 1);
  assert.equal(closedEvents[0].slug, "test-goal");
  assert.equal(closedEvents[0].status, "done");
});

test("close --abandoned appends exactly one closed event carrying the final status", () => {
  const project = makeTempDir("goal-plugin-test-proj-");
  writeGoalFixture(project);
  const abandoned = companion(["close", "test-goal", "--abandoned"], project);
  assert.equal(abandoned.status, 0, abandoned.stderr);

  const { entries } = readLedger(project);
  const closedEvents = entries.filter((entry) => entry.event === "closed");
  assert.equal(closedEvents.length, 1);
  assert.equal(closedEvents[0].slug, "test-goal");
  assert.equal(closedEvents[0].status, "abandoned");
});

function writeDraft(overrides) {
  const draftDir = makeTempDir("goal-plugin-test-draft-");
  const draftFile = path.join(draftDir, "goal.json");
  fs.writeFileSync(draftFile, JSON.stringify(overrides));
  return draftFile;
}

test("set appends one correction event when a terminal item's delegate is hand-corrected", () => {
  const project = makeTempDir("goal-plugin-test-proj-");
  const goal = writeGoalFixture(project, {
    backlog: [
      {
        id: "first-item",
        title: "Do the first thing",
        status: "merged",
        disposition: { recordedAt: "2026-08-07T00:00:00.000Z", pr: 10, delegate: "codex", notes: "landed" }
      },
      { id: "second-item", title: "Do the second thing", status: "todo", disposition: null }
    ]
  });

  const corrected = {
    ...goal,
    backlog: goal.backlog.map((item) =>
      item.id === "first-item"
        ? { ...item, disposition: { ...item.disposition, delegate: "none" } }
        : item
    )
  };
  const set = companion(["set", "--file", writeDraft(corrected), "--json"], project);
  assert.equal(set.status, 0, set.stderr);
  assert.equal(JSON.parse(set.stdout).corrections, 1);

  const { entries } = readLedger(project);
  const corrections = entries.filter((entry) => entry.event === "correction");
  assert.equal(corrections.length, 1);
  assert.equal(corrections[0].slug, "test-goal");
  assert.equal(corrections[0].itemId, "first-item");
  assert.equal(corrections[0].field, "disposition.delegate");
  assert.equal(corrections[0].from, "codex");
  assert.equal(corrections[0].to, "none");
});

test("set appends no correction when nothing terminal changed", () => {
  const project = makeTempDir("goal-plugin-test-proj-");
  const goal = writeGoalFixture(project, {
    backlog: [
      {
        id: "first-item",
        title: "Do the first thing",
        status: "merged",
        disposition: { recordedAt: "2026-08-07T00:00:00.000Z", pr: 10, delegate: "codex", notes: "landed" }
      },
      { id: "second-item", title: "Do the second thing", status: "todo", disposition: null }
    ]
  });

  const unchanged = { ...goal, statement: "Prove the goal machinery works (reworded)" };
  const set = companion(["set", "--file", writeDraft(unchanged), "--json"], project);
  assert.equal(set.status, 0, set.stderr);
  assert.equal(JSON.parse(set.stdout).corrections, 0);

  const { entries } = readLedger(project);
  assert.equal(entries.filter((entry) => entry.event === "correction").length, 0);
});

test("set over a brand-new slug with no prior goal on disk appends no correction and does not crash", () => {
  const project = makeTempDir("goal-plugin-test-proj-");
  const draft = makeGoal({ slug: "brand-new-goal" });
  const set = companion(["set", "--file", writeDraft(draft), "--json"], project);
  assert.equal(set.status, 0, set.stderr);
  assert.equal(JSON.parse(set.stdout).corrections, 0);

  const { entries } = readLedger(project);
  assert.equal(entries.filter((entry) => entry.event === "correction").length, 0);
});

test("set truncates long notes in a correction line to ~120 chars", () => {
  const project = makeTempDir("goal-plugin-test-proj-");
  const longFrom = "f".repeat(200);
  const longTo = "t".repeat(200);
  const goal = writeGoalFixture(project, {
    backlog: [
      {
        id: "first-item",
        title: "Do the first thing",
        status: "merged",
        disposition: { recordedAt: "2026-08-07T00:00:00.000Z", delegate: "codex", notes: longFrom }
      },
      { id: "second-item", title: "Do the second thing", status: "todo", disposition: null }
    ]
  });

  const corrected = {
    ...goal,
    backlog: goal.backlog.map((item) =>
      item.id === "first-item"
        ? { ...item, disposition: { ...item.disposition, notes: longTo } }
        : item
    )
  };
  const set = companion(["set", "--file", writeDraft(corrected), "--json"], project);
  assert.equal(set.status, 0, set.stderr);

  const { entries } = readLedger(project);
  const notesCorrection = entries.find(
    (entry) => entry.event === "correction" && entry.field === "disposition.notes"
  );
  assert.ok(notesCorrection, "expected a disposition.notes correction");
  assert.ok(notesCorrection.from.length <= 121, notesCorrection.from);
  assert.ok(notesCorrection.to.length <= 121, notesCorrection.to);
  assert.ok(notesCorrection.from.endsWith("…"), notesCorrection.from);
  assert.ok(notesCorrection.to.endsWith("…"), notesCorrection.to);
});
