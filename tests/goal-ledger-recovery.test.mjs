import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir } from "./helpers.mjs";
import { appendLedger, readLedger, stateDir } from "../plugins/goal/scripts/lib/ledger.mjs";

process.env.GOAL_COMPANION_STATE_ROOT = makeTempDir("goal-recovery-state-");
process.env.CLAUDE_CONFIG_DIR = makeTempDir("goal-recovery-config-");
delete process.env.CLAUDE_PLUGIN_DATA;

const MODULE_URL = new URL("../plugins/goal/scripts/lib/ledger.mjs", import.meta.url).href;
const repeated = JSON.stringify({ at: "2026-08-01T00:00:00.000Z", event: "disposition", itemId: "repeat" });
const event = (itemId, at) => JSON.stringify({ at, event: "disposition", itemId });

function fixture({ canonical = true } = {}) {
  const project = makeTempDir("goal-recovery-project-");
  const directory = stateDir(project);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const target = path.join(directory, "ledger.jsonl");
  const canonicalContents = `${repeated}\n${event("canonical", "2026-08-03T00:00:00.000Z")}\n`;
  if (canonical) fs.writeFileSync(target, canonicalContents);
  const sources = ["a", "b"].map((install) => {
    const sourceDirectory = path.join(process.env.CLAUDE_CONFIG_DIR, "plugins", "data", install,
      "goal-companion", path.basename(directory));
    fs.mkdirSync(sourceDirectory, { recursive: true });
    return path.join(sourceDirectory, "ledger.jsonl");
  });
  const corrupt = Buffer.from([0x7b, 0x74, 0x6f, 0x72, 0x6e, 0xff, 0x0a]);
  const first = Buffer.concat([
    Buffer.from(`${repeated}\n${event("a", "2026-08-02T00:00:00.000Z")}\n`), corrupt
  ]);
  const second = Buffer.from(`${repeated}\n${event("b", "2026-08-02T00:00:00.000Z")}\n`);
  fs.writeFileSync(sources[0], first);
  fs.writeFileSync(sources[1], second);
  fs.writeFileSync(`${sources[0]}.migrated`, "previous original\n");
  const expected = Buffer.concat([
    Buffer.from(`${repeated}\n${repeated}\n${canonical ? `${repeated}\n` : ""}${event("a", "2026-08-02T00:00:00.000Z")}\n`),
    corrupt,
    Buffer.from(`${event("b", "2026-08-02T00:00:00.000Z")}\n${canonical ? `${event("canonical", "2026-08-03T00:00:00.000Z")}\n` : ""}`)
  ]);
  const itemIds = ["repeat", "repeat", ...(canonical ? ["repeat"] : []), "a", "b", ...(canonical ? ["canonical"] : [])];
  return { project, directory, target, sources, originals: [first, second], expected,
    itemIds, journal: path.join(directory, "ledger.jsonl.migration.json") };
}

// The child deliberately imports no test helpers: their process-exit cleanup
// must not remove the parent's evidence. The synchronous mutation is complete
// before process.exit bypasses any production finally/exception cleanup.
const crashScript = `
  import fs from "node:fs";
  const scenario = JSON.parse(process.argv[1]);
  const ledger = await import(scenario.moduleUrl);
  const stop = (stage) => {
    if (scenario.stage !== stage) return;
    process.stderr.write("STOP:" + stage + "\\n");
    process.exit(73);
  };
  const rename = fs.renameSync;
  let archived = 0;
  fs.renameSync = function (source, destination, ...rest) {
    const result = Reflect.apply(rename, this, [source, destination, ...rest]);
    if (destination === scenario.journal) stop("journal-published");
    if (destination === scenario.target) stop("target-published");
    if (scenario.sources.includes(source)) {
      archived += 1;
      if (archived === 1) stop("first-archived");
    }
    return result;
  };
  const unlink = fs.unlinkSync;
  fs.unlinkSync = function (file, ...rest) {
    if (file === scenario.journal) stop("all-archived");
    return Reflect.apply(unlink, this, [file, ...rest]);
  };
  ledger.readLedger(scenario.project);
  throw new Error("Crash boundary was not reached");
`;

function interrupt(scenario, stage = "target-published") {
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", crashScript,
    JSON.stringify({ project: scenario.project, target: scenario.target, journal: scenario.journal,
      sources: scenario.sources, stage, moduleUrl: MODULE_URL })], {
    env: { ...process.env }, encoding: "utf8", shell: false, windowsHide: true, timeout: 15000
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 73, result.stderr);
  assert.equal(result.stderr.trim(), `STOP:${stage}`);
}

const appended = { at: "2026-08-04T00:00:00.000Z", event: "disposition", itemId: "appended" };

function assertRecovered(scenario, operation) {
  if (operation === "append") appendLedger(scenario.project, appended);
  const healed = readLedger(scenario.project);
  const expected = operation === "append"
    ? Buffer.concat([scenario.expected, Buffer.from(`${JSON.stringify(appended)}\n`)])
    : scenario.expected;
  assert.deepEqual(fs.readFileSync(scenario.target), expected);
  assert.deepEqual(healed.entries.map((entry) => entry.itemId),
    [...scenario.itemIds, ...(operation === "append" ? ["appended"] : [])]);
  assert.equal(healed.corruptCount, 1);
  assert.deepEqual(fs.readFileSync(`${scenario.sources[0]}.migrated.1`), scenario.originals[0]);
  assert.deepEqual(fs.readFileSync(`${scenario.sources[1]}.migrated`), scenario.originals[1]);
  assert.equal(fs.readFileSync(`${scenario.sources[0]}.migrated`, "utf8"), "previous original\n");
  for (const file of [...scenario.sources, scenario.journal, `${scenario.journal}.tmp`,
    path.join(scenario.directory, "ledger.jsonl.consolidating")]) {
    assert.equal(fs.existsSync(file), false, `${file} remains after recovery`);
  }
  assert.deepEqual(readLedger(scenario.project), healed);
  assert.deepEqual(fs.readFileSync(scenario.target), expected);
}

for (const stage of ["journal-published", "target-published", "first-archived", "all-archived"]) {
  for (const operation of ["read", "append"]) {
    test(`${operation} resumes migration after ${stage} without changing event multiplicity or corrupt bytes`, () => {
      const scenario = fixture();
      interrupt(scenario, stage);
      assertRecovered(scenario, operation);
    });
  }
}

test("partially archived migration resumes after the legacy discovery configuration changes", () => {
  const scenario = fixture();
  interrupt(scenario, "first-archived");
  const previousConfig = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = makeTempDir("goal-recovery-empty-config-");
  try {
    assert.equal(process.env.CLAUDE_PLUGIN_DATA, undefined);
    assertRecovered(scenario, "append");
  } finally {
    process.env.CLAUDE_CONFIG_DIR = previousConfig;
  }
});

test("interruption before the first canonical ledger is published recovers from a null beforeHash", () => {
  const scenario = fixture({ canonical: false });
  interrupt(scenario, "journal-published");
  assert.equal(fs.existsSync(scenario.target), false);
  assert.equal(JSON.parse(fs.readFileSync(scenario.journal, "utf8")).beforeHash, null);
  assertRecovered(scenario, "read");
  assert.deepEqual(readLedger(scenario.project).entries.map((entry) => entry.itemId), ["repeat", "repeat", "a", "b"]);
});

for (const failure of ["partial journal write", "journal publication rename"]) {
  test(`${failure} failure preserves every original and a retry completes migration`, (t) => {
    const scenario = fixture();
    const targetBefore = fs.readFileSync(scenario.target);
    const scratch = `${scenario.journal}.tmp`;
    const method = failure === "partial journal write" ? "writeFileSync" : "renameSync";
    const original = fs[method];
    const mocked = t.mock.method(fs, method, function (...args) {
      const hit = method === "writeFileSync" ? args[0] === scratch : args[1] === scenario.journal;
      if (hit) {
        if (method === "writeFileSync") Reflect.apply(original, this, [scratch, "{partial journal"]);
        throw Object.assign(new Error(`injected ${failure} failure`), { code: "EIO" });
      }
      return Reflect.apply(original, this, args);
    });
    assert.throws(() => readLedger(scenario.project), new RegExp(`injected ${failure} failure`));
    mocked.mock.restore();
    assert.equal(fs.existsSync(scenario.journal), false);
    assert.equal(fs.existsSync(scratch), true);
    if (method === "writeFileSync") assert.equal(fs.readFileSync(scratch, "utf8"), "{partial journal");
    assert.deepEqual(fs.readFileSync(scenario.target), targetBefore);
    assert.deepEqual(scenario.sources.map((source) => fs.readFileSync(source)), scenario.originals);
    assert.equal(fs.readFileSync(`${scenario.sources[0]}.migrated`, "utf8"), "previous original\n");
    assert.equal(fs.existsSync(`${scenario.sources[0]}.migrated.1`), false);
    assert.equal(fs.existsSync(`${scenario.sources[1]}.migrated`), false);
    assertRecovered(scenario, "read");
  });
}

function maybeRead(file) {
  try {
    return fs.readFileSync(file);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function snapshot(scenario) {
  const files = [scenario.target, scenario.journal, `${scenario.journal}.tmp`,
    path.join(scenario.directory, "ledger.jsonl.consolidating"), ...scenario.sources,
    ...scenario.sources.flatMap((source) => [`${source}.migrated`, `${source}.migrated.1`, `${source}.migrated.2`])];
  return files.map((file) => [file, maybeRead(file)]);
}

function assertRefusedUnchanged(scenario) {
  const before = snapshot(scenario);
  assert.throws(() => readLedger(scenario.project), /migration|journal|source|archive|ledger/i);
  assert.deepEqual(snapshot(scenario), before);
  assert.throws(() => appendLedger(scenario.project, appended), /migration|journal|source|archive|ledger/i);
  assert.deepEqual(snapshot(scenario), before);
}

test("a filesystem error before canonical publication keeps originals and permits a subsequent append", (t) => {
  const scenario = fixture();
  const targetBefore = fs.readFileSync(scenario.target);
  const rename = fs.renameSync;
  const mocked = t.mock.method(fs, "renameSync", function (source, destination, ...rest) {
    if (destination === scenario.target) {
      throw Object.assign(new Error("injected canonical publish denial"), { code: "EACCES" });
    }
    return Reflect.apply(rename, this, [source, destination, ...rest]);
  });
  assert.throws(() => readLedger(scenario.project), /injected canonical publish denial/);
  mocked.mock.restore();
  assert.deepEqual(fs.readFileSync(scenario.target), targetBefore);
  assert.deepEqual(scenario.sources.map((source) => fs.readFileSync(source)), scenario.originals);
  assert.equal(fs.readFileSync(`${scenario.sources[0]}.migrated`, "utf8"), "previous original\n");
  assertRecovered(scenario, "append");
});

for (const stage of ["journal-published", "target-published"]) {
  for (const changed of ["source", "canonical"]) {
    test(`changed ${changed} after ${stage} refuses both entrypoints without modifying evidence`, () => {
      const scenario = fixture();
      interrupt(scenario, stage);
      fs.appendFileSync(changed === "source" ? scenario.sources[1] : scenario.target, "newer external bytes\n");
      assertRefusedUnchanged(scenario);
    });
  }
}

function archivedSource(scenario) {
  const journal = JSON.parse(fs.readFileSync(scenario.journal, "utf8"));
  const source = journal.sources.find((source) => !fs.existsSync(source.file));
  assert.ok(source, "fixture must have archived one source before interruption");
  return { ...source, archive: `${source.file}.migrated${source.archiveSuffix ? `.${source.archiveSuffix}` : ""}` };
}

for (const conflict of ["altered archive", "missing source and archive", "source and archive both present"]) {
  test(`${conflict} refuses recovery without destroying evidence`, () => {
    const scenario = fixture();
    interrupt(scenario, "first-archived");
    const source = archivedSource(scenario);
    if (conflict === "altered archive") fs.appendFileSync(source.archive, "different bytes\n");
    if (conflict === "missing source and archive") fs.unlinkSync(source.archive);
    if (conflict === "source and archive both present") fs.copyFileSync(source.archive, source.file);
    assertRefusedUnchanged(scenario);
  });
}

const malformedJournals = {
  "invalid JSON": () => "{partial journal",
  "unsupported version": (journal) => ({ ...journal, version: 2 }),
  "different state directory": (journal, scenario) => ({ ...journal, directory: path.dirname(scenario.directory) }),
  "canonical file as a migration source": (journal, scenario) => ({
    ...journal, sources: [{ ...journal.sources[0], file: scenario.target }, ...journal.sources.slice(1)]
  }),
  "relative source path": (journal) => ({
    ...journal, sources: [{ ...journal.sources[0], file: "../ledger.jsonl" }, ...journal.sources.slice(1)]
  }),
  "output hash mismatch": (journal) => ({ ...journal, outputBase64: Buffer.from("changed output\n").toString("base64") }),
  "invalid archive suffix": (journal) => ({
    ...journal, sources: [{ ...journal.sources[0], archiveSuffix: -1 }, ...journal.sources.slice(1)]
  })
};

for (const [name, corruptJournal] of Object.entries(malformedJournals)) {
  test(`${name} journal refuses read and append with every artifact intact`, () => {
    const scenario = fixture();
    interrupt(scenario, "journal-published");
    const journal = JSON.parse(fs.readFileSync(scenario.journal, "utf8"));
    const malformed = corruptJournal(journal, scenario);
    fs.writeFileSync(scenario.journal, typeof malformed === "string" ? malformed : JSON.stringify(malformed));
    assertRefusedUnchanged(scenario);
  });
}
