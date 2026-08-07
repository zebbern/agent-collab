# goal@agent-collab v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the third plugin `goal` — an attended `/goal` loop with schema-validated git-tracked goal files, deterministic increment selection, a mechanical disposition ledger, and command/skill docs — per the approved spec `docs/superpowers/specs/2026-08-07-goal-plugin-design.md`.

**Architecture:** A small self-contained companion CLI (`goal-companion.mjs`) owns everything that must be true (state, selection, dispositions, ledger); Claude owns everything that needs judgment (executing steps, delegating via the existing codex/cursor delegation skills). The plugin mirrors nothing from the sibling plugins and never spawns workers.

**Tech Stack:** Plain Node `.mjs` (Node ≥ 20), `node:` builtins only, `node --test` + `node:assert/strict`, repo test helpers in `tests/helpers.mjs`.

## Global Constraints

- **Zero runtime dependencies**: every import is `node:*` or a relative path inside `plugins/goal/` — `tests/import-closure.test.mjs` enforces this mechanically once Task 7 adds `"goal"` to its `PLUGINS` list.
- **Self-contained plugin**: never import from `plugins/codex/` or `plugins/cursor/`. The chassis drift guard must remain untouched.
- **Windows + Linux**: no POSIX-isms in code or npm scripts; tests must pass under Git Bash on win32 and under Linux (`npm run verify` runs both).
- **Plain commit messages, no AI attribution** (no Co-Authored-By, no "Generated with").
- **Branch + PR**: work on branch `goal-plugin`; `main` is protected. `npm run verify` must pass before merge (Actions dispatch is intermittent; the local gate is the gate).
- **State-dir separation**: goal state lives under `goal-companion/` in the plugin-data root (`CLAUDE_PLUGIN_DATA` env override, else OS temp), never under `codex-companion`/`cursor-companion`.
- **Exit-code honesty**: 0 = success; 1 = refusal/error with the reason on stderr. Refusals state specifics; nothing is silently repaired.
- All file paths below are relative to the repo root `C:\Users\zeb\Documents\workspace_for_ai\codex-plugin`.

---

### Task 1: Plugin scaffold, manifests, and manifest pins

**Files:**
- Create: `plugins/goal/.claude-plugin/plugin.json`
- Create: `plugins/goal/CHANGELOG.md`
- Create: `plugins/goal/LICENSE` (copy of repo `LICENSE`)
- Modify: `.claude-plugin/marketplace.json` (add third plugin entry)
- Test: `tests/goal-docs.test.mjs` (new)

**Interfaces:**
- Consumes: nothing.
- Produces: plugin identity `name: "goal"`, `version: "0.1.0"`; marketplace entry `source: "./plugins/goal"`. Later tasks rely on the directory `plugins/goal/` existing.

- [ ] **Step 1: Create branch**

```bash
git checkout main && git pull --ff-only && git checkout -b goal-plugin
```

- [ ] **Step 2: Write the failing test**

Create `tests/goal-docs.test.mjs`:

```js
// Doc and manifest pins for the goal plugin, mirroring the discipline of
// tests/cursor-skills.test.mjs: the manifests, commands, and skill carry
// contracts that must not drift silently.
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN = path.join(ROOT, "plugins", "goal");

function read(relative) {
  return fs.readFileSync(path.join(PLUGIN, relative), "utf8");
}

test("goal plugin manifest and marketplace entry agree", () => {
  const plugin = JSON.parse(read(path.join(".claude-plugin", "plugin.json")));
  assert.equal(plugin.name, "goal");
  assert.equal(plugin.version, "0.1.0");
  assert.match(plugin.description, /long-horizon/i);

  const marketplace = JSON.parse(
    fs.readFileSync(path.join(ROOT, ".claude-plugin", "marketplace.json"), "utf8")
  );
  const entry = marketplace.plugins.find((candidate) => candidate.name === "goal");
  assert.ok(entry, "marketplace.json has no goal entry");
  assert.equal(entry.version, "0.1.0");
  assert.equal(entry.source, "./plugins/goal");
});

test("goal plugin ships license and changelog", () => {
  assert.match(read("LICENSE"), /Apache License/);
  assert.match(read("CHANGELOG.md"), /## 0\.1\.0/);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `node --test tests/goal-docs.test.mjs`
Expected: FAIL (`ENOENT` reading `plugins/goal/.claude-plugin/plugin.json`).

- [ ] **Step 4: Create the manifests**

`plugins/goal/.claude-plugin/plugin.json`:

```json
{
  "name": "goal",
  "version": "0.1.0",
  "description": "Long-horizon project goals for Claude Code: an attended /goal loop that advances one increment at a time, delegating through the codex and cursor plugins.",
  "author": {
    "name": "zebbern"
  }
}
```

`plugins/goal/CHANGELOG.md`:

```markdown
# Changelog

## 0.1.0

- Initial release: attended `/goal` loop. A schema-validated, git-tracked goal file (`.claude/goals/<slug>.json`) with a ranked backlog; deterministic next-increment selection; mechanical one-increment-at-a-time enforcement; dispositions recorded in the goal file and an append-only machine-local ledger; `check` runs command-kind acceptance criteria by exit code. Delegation happens through the codex/cursor delegation skills — this plugin spawns no workers of its own.
```

Copy the license:

```bash
cp LICENSE plugins/goal/LICENSE
```

In `.claude-plugin/marketplace.json`, append to the `plugins` array (after the cursor entry):

```json
    {
      "name": "goal",
      "description": "Set a long-horizon goal in a project and advance it one increment at a time, delegating to Codex/Cursor.",
      "version": "0.1.0",
      "author": {
        "name": "zebbern"
      },
      "source": "./plugins/goal"
    }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test tests/goal-docs.test.mjs`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add plugins/goal .claude-plugin/marketplace.json tests/goal-docs.test.mjs
git commit -m "Scaffold the goal plugin: manifests, license, changelog, manifest pins"
```

---

### Task 2: Argument parser (`lib/args.mjs`)

**Files:**
- Create: `plugins/goal/scripts/lib/args.mjs`
- Test: `tests/goal-companion.test.mjs` (new)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `parseCommandInput(argv: string[], { valueOptions?: string[], booleanOptions?: string[] }) → { options: Record<string, string|true>, positionals: string[] }` — throws `Error` on unknown options or a value option with no value. `-C` is an alias for `--cwd`.
  - `resolveCommandCwd(options) → string` — `path.resolve(options.cwd ?? process.cwd())`.

- [ ] **Step 1: Write the failing test**

Create `tests/goal-companion.test.mjs`:

```js
// Behavior tests for the goal companion and its libs. E2E tests run the real
// CLI via node with temp-dir projects; lib tests import functions directly.
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { makeTempDir, run } from "./helpers.mjs";
import { parseCommandInput, resolveCommandCwd } from "../plugins/goal/scripts/lib/args.mjs";

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/goal-companion.test.mjs`
Expected: FAIL (`Cannot find module .../plugins/goal/scripts/lib/args.mjs`).

- [ ] **Step 3: Write the implementation**

Create `plugins/goal/scripts/lib/args.mjs`:

```js
import path from "node:path";

/**
 * Minimal argv parser shared by every goal-companion subcommand. Unknown
 * options are refused loudly rather than ignored: a typo like --dispositon
 * must never silently drop a disposition.
 */
export function parseCommandInput(argv, { valueOptions = [], booleanOptions = [] } = {}) {
  const options = {};
  const positionals = [];
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "-C") {
      const value = argv[i + 1];
      if (value === undefined) {
        throw new Error("-C requires a value");
      }
      options.cwd = value;
      i += 1;
      continue;
    }
    if (token.startsWith("--")) {
      const name = token.slice(2);
      if (booleanOptions.includes(name)) {
        options[name] = true;
        continue;
      }
      if (valueOptions.includes(name)) {
        const value = argv[i + 1];
        if (value === undefined) {
          throw new Error(`--${name} requires a value`);
        }
        options[name] = value;
        i += 1;
        continue;
      }
      throw new Error(`Unknown option: ${token}`);
    }
    positionals.push(token);
  }
  return { options, positionals };
}

export function resolveCommandCwd(options) {
  return path.resolve(options.cwd ?? process.cwd());
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/goal-companion.test.mjs`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add plugins/goal/scripts/lib/args.mjs tests/goal-companion.test.mjs
git commit -m "Goal companion: argv parser with loud refusals"
```

---

### Task 3: Goal state module (`lib/goal-state.mjs`)

**Files:**
- Create: `plugins/goal/scripts/lib/goal-state.mjs`
- Modify: `tests/goal-companion.test.mjs` (append tests)

**Interfaces:**
- Consumes: nothing.
- Produces (all exported):
  - `GOAL_SCHEMA_VERSION = 1`
  - `GOAL_STATUSES = ["active","blocked","done","abandoned"]`
  - `ITEM_STATUSES = ["todo","in-progress","merged","discarded","dropped","blocked"]`
  - `TERMINAL_ITEM_STATUSES = ["merged","discarded","dropped","blocked"]`
  - `validateGoal(value) → string[]` — empty array means valid; each entry names the exact field and problem.
  - `goalsDir(cwd) → string` — `path.join(cwd, ".claude", "goals")`.
  - `listGoalFiles(cwd) → Array<{slug, file}>` — `[]` when the dir is missing; only `*.json` files.
  - `loadGoal(file, expectedSlug) → goal` — throws with specifics on unreadable/unparseable/invalid content or a `goal.slug !== expectedSlug` mismatch.
  - `resolveGoal(cwd, slug) → { slug, file, goal }` — `slug` may be `""`; refusal messages list available slugs (see test).
  - `saveGoal(cwd, goal) → string` — validates, stamps `updatedAt` (ISO), writes atomically (`<file>.<pid>.tmp` + `renameSync`) to `goalsDir(cwd)/<slug>.json`, returns the file path.

- [ ] **Step 1: Write the failing tests**

Append to `tests/goal-companion.test.mjs`:

```js
import {
  validateGoal,
  resolveGoal,
  saveGoal,
  goalsDir
} from "../plugins/goal/scripts/lib/goal-state.mjs";

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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/goal-companion.test.mjs`
Expected: FAIL (`Cannot find module .../lib/goal-state.mjs`).

- [ ] **Step 3: Write the implementation**

Create `plugins/goal/scripts/lib/goal-state.mjs`:

```js
import fs from "node:fs";
import path from "node:path";

export const GOAL_SCHEMA_VERSION = 1;
export const GOAL_STATUSES = ["active", "blocked", "done", "abandoned"];
export const ITEM_STATUSES = ["todo", "in-progress", "merged", "discarded", "dropped", "blocked"];
export const TERMINAL_ITEM_STATUSES = ["merged", "discarded", "dropped", "blocked"];

const SLUG_PATTERN = /^[a-z0-9-]+$/;

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Validate a goal object against schemaVersion 1. Returns a list of specific
 * problems; an empty list means valid. Every refusal path in the companion
 * routes through this — the file is git-tracked project content that humans
 * hand-edit, so precision here is the whole safety story.
 */
export function validateGoal(value) {
  const errors = [];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return ["goal must be a JSON object"];
  }
  if (value.schemaVersion !== GOAL_SCHEMA_VERSION) {
    errors.push(`schemaVersion must be ${GOAL_SCHEMA_VERSION}`);
  }
  if (!isNonEmptyString(value.slug) || !SLUG_PATTERN.test(value.slug)) {
    errors.push("slug must be a non-empty [a-z0-9-]+ string");
  }
  if (!isNonEmptyString(value.statement)) {
    errors.push("statement must be a non-empty string");
  }
  if (!Array.isArray(value.acceptanceCriteria)) {
    errors.push("acceptanceCriteria must be an array");
  } else {
    value.acceptanceCriteria.forEach((criterion, index) => {
      const label = `acceptanceCriteria[${index}]`;
      if (typeof criterion !== "object" || criterion === null) {
        errors.push(`${label} must be an object`);
        return;
      }
      if (criterion.kind === "command") {
        if (!isNonEmptyString(criterion.run)) errors.push(`${label}.run must be a non-empty string`);
        if (criterion.expect !== "exit0") errors.push(`${label}.expect must be "exit0"`);
        if (
          criterion.timeoutMs !== undefined &&
          (!Number.isInteger(criterion.timeoutMs) || criterion.timeoutMs <= 0)
        ) {
          errors.push(`${label}.timeoutMs must be a positive integer`);
        }
      } else if (criterion.kind === "manual") {
        if (!isNonEmptyString(criterion.text)) errors.push(`${label}.text must be a non-empty string`);
      } else {
        errors.push(`${label}.kind must be "command" or "manual"`);
      }
    });
  }
  if (!Array.isArray(value.backlog)) {
    errors.push("backlog must be an array");
  } else {
    const seen = new Set();
    let inProgress = 0;
    value.backlog.forEach((item, index) => {
      const label = `backlog[${index}]`;
      if (typeof item !== "object" || item === null) {
        errors.push(`${label} must be an object`);
        return;
      }
      if (!isNonEmptyString(item.id) || !SLUG_PATTERN.test(item.id)) {
        errors.push(`${label}.id must be a non-empty [a-z0-9-]+ string`);
      } else if (seen.has(item.id)) {
        errors.push(`${label}.id "${item.id}" is a duplicate`);
      } else {
        seen.add(item.id);
      }
      if (!isNonEmptyString(item.title)) errors.push(`${label}.title must be a non-empty string`);
      if (!ITEM_STATUSES.includes(item.status)) {
        errors.push(`${label}.status must be one of ${ITEM_STATUSES.join("|")}`);
      }
      if (item.status === "in-progress") inProgress += 1;
      if (TERMINAL_ITEM_STATUSES.includes(item.status)) {
        if (typeof item.disposition !== "object" || item.disposition === null) {
          errors.push(`${label}.disposition must be an object recording the terminal outcome`);
        } else if (!isNonEmptyString(item.disposition.recordedAt)) {
          errors.push(`${label}.disposition.recordedAt must be an ISO timestamp string`);
        }
      } else if (item.disposition !== null && item.disposition !== undefined) {
        errors.push(`${label}.disposition must be null until the item reaches a terminal status`);
      }
    });
    if (inProgress > 1) {
      errors.push("at most one item may be in-progress");
    }
  }
  if (value.budget !== undefined && value.budget !== null) {
    if (
      typeof value.budget !== "object" ||
      !Number.isInteger(value.budget.perStepDelegations) ||
      value.budget.perStepDelegations <= 0
    ) {
      errors.push("budget.perStepDelegations must be a positive integer");
    }
  }
  if (!GOAL_STATUSES.includes(value.status)) {
    errors.push(`status must be one of ${GOAL_STATUSES.join("|")}`);
  }
  if (value.status === "blocked" && !isNonEmptyString(value.blockedReason)) {
    errors.push("blockedReason must be a non-empty string while status is blocked");
  }
  return errors;
}

export function goalsDir(cwd) {
  return path.join(cwd, ".claude", "goals");
}

export function listGoalFiles(cwd) {
  let entries;
  try {
    entries = fs.readdirSync(goalsDir(cwd), { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") {
      return [];
    }
    throw new Error(`Cannot read ${goalsDir(cwd)}: ${error.message}`);
  }
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => ({ slug: entry.name.slice(0, -5), file: path.join(goalsDir(cwd), entry.name) }));
}

export function loadGoal(file, expectedSlug) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (error) {
    throw new Error(`Cannot read ${file}: ${error.message}`);
  }
  let goal;
  try {
    goal = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${path.basename(file)} is not valid JSON: ${error.message}`);
  }
  const errors = validateGoal(goal);
  if (errors.length > 0) {
    throw new Error(`${path.basename(file)} is not a valid goal:\n  - ${errors.join("\n  - ")}`);
  }
  if (goal.slug !== expectedSlug) {
    throw new Error(
      `${path.basename(file)}: slug "${goal.slug}" does not match the filename — rename the file or fix the slug, then re-run set`
    );
  }
  return goal;
}

export function resolveGoal(cwd, slug) {
  const files = listGoalFiles(cwd);
  if (slug) {
    const match = files.find((entry) => entry.slug === slug);
    if (!match) {
      const known = files.map((entry) => entry.slug).join(", ") || "(none)";
      throw new Error(`Goal "${slug}" not found. Goals in this project: ${known}`);
    }
    return { slug, file: match.file, goal: loadGoal(match.file, slug) };
  }
  if (files.length === 0) {
    throw new Error(`No goal files found under ${goalsDir(cwd)}. Create one with /goal:set.`);
  }
  if (files.length > 1) {
    throw new Error(
      `Multiple goals exist — name one: ${files.map((entry) => entry.slug).join(", ")}`
    );
  }
  return { slug: files[0].slug, file: files[0].file, goal: loadGoal(files[0].file, files[0].slug) };
}

export function saveGoal(cwd, goal) {
  const errors = validateGoal(goal);
  if (errors.length > 0) {
    throw new Error(`Refusing to save an invalid goal:\n  - ${errors.join("\n  - ")}`);
  }
  const dir = goalsDir(cwd);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${goal.slug}.json`);
  const stamped = { ...goal, updatedAt: new Date().toISOString() };
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(stamped, null, 2)}\n`);
  fs.renameSync(tmp, file);
  return file;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/goal-companion.test.mjs`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add plugins/goal/scripts/lib/goal-state.mjs tests/goal-companion.test.mjs
git commit -m "Goal companion: schema validation, slug resolution, atomic goal-file writes"
```

---

### Task 4: Ledger module (`lib/ledger.mjs`)

**Files:**
- Create: `plugins/goal/scripts/lib/ledger.mjs`
- Modify: `tests/goal-companion.test.mjs` (append tests)

**Interfaces:**
- Consumes: nothing.
- Produces (all exported):
  - `stateDir(cwd) → string` — `<root>/goal-companion/<basename(cwd)>-<sha256(resolve(cwd)).hex.slice(0,16)>` where `<root>` is `process.env.CLAUDE_PLUGIN_DATA` when set, else `os.tmpdir()`.
  - `appendLedger(cwd, entry) → void` — stamps `at` (ISO), appends one JSON line to `<stateDir>/ledger.jsonl`, creating dirs as needed.
  - `readLedger(cwd) → { entries: object[], corruptCount: number }` — missing file → `{ entries: [], corruptCount: 0 }`; unparseable lines are skipped and counted, never absorbed silently.

- [ ] **Step 1: Write the failing tests**

Append to `tests/goal-companion.test.mjs`:

```js
import { appendLedger, readLedger, stateDir } from "../plugins/goal/scripts/lib/ledger.mjs";

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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/goal-companion.test.mjs`
Expected: FAIL (`Cannot find module .../lib/ledger.mjs`).

- [ ] **Step 3: Write the implementation**

Create `plugins/goal/scripts/lib/ledger.mjs`:

```js
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Machine-local append-only telemetry, deliberately outside git: one line per
 * step event. This file is the raw feed a future retrospective loop reads.
 * State root honors CLAUDE_PLUGIN_DATA (the test-isolation convention shared
 * with the sibling plugins) and stays under goal-companion/, never inside the
 * codex/cursor state dirs.
 */
export function stateDir(cwd) {
  const root = process.env.CLAUDE_PLUGIN_DATA || os.tmpdir();
  const resolved = path.resolve(cwd);
  const key = `${path.basename(resolved)}-${createHash("sha256").update(resolved).digest("hex").slice(0, 16)}`;
  return path.join(root, "goal-companion", key);
}

function ledgerFile(cwd) {
  return path.join(stateDir(cwd), "ledger.jsonl");
}

export function appendLedger(cwd, entry) {
  fs.mkdirSync(stateDir(cwd), { recursive: true });
  const line = JSON.stringify({ at: new Date().toISOString(), ...entry });
  fs.appendFileSync(ledgerFile(cwd), `${line}\n`);
}

export function readLedger(cwd) {
  let raw;
  try {
    raw = fs.readFileSync(ledgerFile(cwd), "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { entries: [], corruptCount: 0 };
    }
    throw new Error(`Cannot read ${ledgerFile(cwd)}: ${error.message}`);
  }
  const entries = [];
  let corruptCount = 0;
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      corruptCount += 1; // skipped and counted, never silently absorbed
    }
  }
  return { entries, corruptCount };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/goal-companion.test.mjs`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add plugins/goal/scripts/lib/ledger.mjs tests/goal-companion.test.mjs
git commit -m "Goal companion: append-only ledger with corrupt-line counting"
```

---

### Task 5: Companion CLI — `set`, `status`, `next`, `help`

**Files:**
- Create: `plugins/goal/scripts/goal-companion.mjs`
- Modify: `tests/goal-companion.test.mjs` (append e2e tests)

**Interfaces:**
- Consumes: `parseCommandInput`/`resolveCommandCwd` (Task 2), goal-state exports (Task 3), ledger exports (Task 4).
- Produces: the CLI entrypoint later tasks extend. Subcommand dispatch is a `switch` in `main()`; each handler is `async function handle<Name>(argv)`. JSON payload shapes (stable, later tasks and docs rely on them):
  - `set` → `{ slug, file }`
  - `status` → `{ slug, status, blockedReason, counts: {todo, "in-progress", merged, discarded, dropped, blocked}, inProgress: item|null, ledgerTail: entry[], corruptLedgerLines: number }`
  - `next` → `{ slug, item }`
- Exit codes: 0 success, 1 refusal/error (message on stderr).

- [ ] **Step 1: Write the failing e2e tests**

Append to `tests/goal-companion.test.mjs`:

```js
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
  return run("node", [SCRIPT, ...args, "--cwd", project], { env: { ...process.env } });
}

test("set validates and writes; status reports counts and ledger health", () => {
  const project = makeTempDir("goal-proj-");
  const draft = path.join(makeTempDir("goal-draft-"), "goal.json");
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
  const project = makeTempDir("goal-proj-");
  const draft = path.join(makeTempDir("goal-draft-"), "goal.json");
  fs.writeFileSync(draft, JSON.stringify({ schemaVersion: 1, slug: "x" }));
  const set = companion(["set", "--file", draft], project);
  assert.equal(set.status, 1);
  assert.match(set.stderr, /statement must be a non-empty string/);
});

test("next returns the first todo and refuses on non-active goals", () => {
  const project = makeTempDir("goal-proj-");
  writeGoalFixture(project);
  const next = companion(["next", "--json"], project);
  assert.equal(next.status, 0, next.stderr);
  assert.equal(JSON.parse(next.stdout).item.id, "first-item");

  const blockedProject = makeTempDir("goal-proj-");
  writeGoalFixture(blockedProject, { status: "blocked", blockedReason: "waiting on a human" });
  const refused = companion(["next"], blockedProject);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /blocked.*waiting on a human/s);
});

test("help prints usage and unknown subcommands refuse", () => {
  const project = makeTempDir("goal-proj-");
  const help = companion(["help"], project);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /goal-companion\.mjs set --file/);
  const unknown = companion(["frobnicate"], project);
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /Unknown subcommand: frobnicate/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/goal-companion.test.mjs`
Expected: FAIL (companion script missing → `run` exits non-zero with `Cannot find module`; the `set` test's `assert.equal(set.status, 0…)` fails).

- [ ] **Step 3: Write the implementation**

Create `plugins/goal/scripts/goal-companion.mjs`:

```js
#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { parseCommandInput, resolveCommandCwd } from "./lib/args.mjs";
import { resolveGoal, saveGoal, validateGoal } from "./lib/goal-state.mjs";
import { appendLedger, readLedger } from "./lib/ledger.mjs";

function printUsage() {
  console.log(
    [
      "Usage:",
      "  node scripts/goal-companion.mjs set --file <path> [--json]",
      "  node scripts/goal-companion.mjs status [slug] [--json]",
      "  node scripts/goal-companion.mjs next [slug] [--json]",
      "  node scripts/goal-companion.mjs start <slug> <itemId> [--json]",
      "  node scripts/goal-companion.mjs record <slug> <itemId> --disposition <merged|discarded|dropped|blocked> [--pr <n>] [--delegate <codex|cursor|none>] [--notes <text>] [--json]",
      "  node scripts/goal-companion.mjs check [slug] [--json]",
      "  node scripts/goal-companion.mjs close <slug> (--done|--abandoned) [--json]",
      "  node scripts/goal-companion.mjs help",
      "",
      "Notes:",
      "  - every subcommand accepts --cwd <path> (alias -C).",
      "  - goal files live at .claude/goals/<slug>.json and are project content.",
      "  - `check` runs command criteria via the shell: the same trust level as npm scripts."
    ].join("\n")
  );
}

function output(payload, rendered, asJson) {
  if (asJson) {
    console.log(JSON.stringify(payload, null, 2));
  } else {
    process.stdout.write(rendered);
  }
}

function countItems(goal) {
  const counts = { todo: 0, "in-progress": 0, merged: 0, discarded: 0, dropped: 0, blocked: 0 };
  for (const item of goal.backlog) {
    counts[item.status] += 1;
  }
  return counts;
}

async function handleSet(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd", "file"],
    booleanOptions: ["json"]
  });
  if (!options.file) {
    throw new Error("set requires --file <path> (stdin is not supported in v1)");
  }
  const cwd = resolveCommandCwd(options);
  const raw = fs.readFileSync(path.resolve(cwd, options.file), "utf8");
  let draft;
  try {
    draft = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${options.file} is not valid JSON: ${error.message}`);
  }
  const errors = validateGoal(draft);
  if (errors.length > 0) {
    throw new Error(`Refusing to set an invalid goal:\n  - ${errors.join("\n  - ")}`);
  }
  const file = saveGoal(cwd, draft);
  output(
    { slug: draft.slug, file },
    `Goal "${draft.slug}" written to ${file}.\n`,
    options.json
  );
}

async function handleStatus(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });
  const cwd = resolveCommandCwd(options);
  const { slug, goal } = resolveGoal(cwd, positionals[0] ?? "");
  const counts = countItems(goal);
  const inProgress = goal.backlog.find((item) => item.status === "in-progress") ?? null;
  const { entries, corruptCount } = readLedger(cwd);
  const payload = {
    slug,
    status: goal.status,
    blockedReason: goal.blockedReason,
    counts,
    inProgress,
    ledgerTail: entries.slice(-5),
    corruptLedgerLines: corruptCount
  };
  const lines = [
    `# Goal: ${slug} (${goal.status}${goal.status === "blocked" ? ` — ${goal.blockedReason}` : ""})`,
    goal.statement,
    `Items: ${counts.todo} todo, ${counts["in-progress"]} in-progress, ${counts.merged} merged, ${counts.discarded} discarded, ${counts.dropped} dropped, ${counts.blocked} blocked.`,
    inProgress ? `In progress: ${inProgress.id} — ${inProgress.title}` : "Nothing in progress.",
    corruptCount > 0 ? `Ledger: ${corruptCount} corrupt line(s) skipped.` : null
  ].filter((line) => line !== null);
  output(payload, `${lines.join("\n")}\n`, options.json);
}

async function handleNext(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });
  const cwd = resolveCommandCwd(options);
  const { slug, goal } = resolveGoal(cwd, positionals[0] ?? "");
  if (goal.status !== "active") {
    throw new Error(
      `Goal "${slug}" is ${goal.status}${goal.status === "blocked" ? `: ${goal.blockedReason}` : ""}. Resolve that before stepping.`
    );
  }
  const inProgress = goal.backlog.find((item) => item.status === "in-progress");
  if (inProgress) {
    throw new Error(
      `Item "${inProgress.id}" is already in progress. Record its disposition before starting another.`
    );
  }
  const item = goal.backlog.find((candidate) => candidate.status === "todo");
  if (!item) {
    throw new Error(`Backlog has no todo items. Run \`check\` and consider \`close ${slug} --done\`.`);
  }
  output({ slug, item }, `Next increment: ${item.id} — ${item.title}\n`, options.json);
}

async function main() {
  const [subcommand, ...argv] = process.argv.slice(2);
  if (!subcommand || subcommand === "help" || subcommand === "--help") {
    printUsage();
    return;
  }
  switch (subcommand) {
    case "set":
      await handleSet(argv);
      return;
    case "status":
      await handleStatus(argv);
      return;
    case "next":
      await handleNext(argv);
      return;
    default:
      throw new Error(`Unknown subcommand: ${subcommand}`);
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/goal-companion.test.mjs`
Expected: PASS (11 tests).

- [ ] **Step 5: Commit**

```bash
git add plugins/goal/scripts/goal-companion.mjs tests/goal-companion.test.mjs
git commit -m "Goal companion: set/status/next/help with honest refusals"
```

---

### Task 6: Companion CLI — `start`, `record`, `check`, `close`

**Files:**
- Modify: `plugins/goal/scripts/goal-companion.mjs`
- Modify: `tests/goal-companion.test.mjs` (append e2e tests)

**Interfaces:**
- Consumes: everything from Tasks 2–5; `TERMINAL_ITEM_STATUSES` from goal-state; `appendLedger` from ledger; `spawnSync` from `node:child_process`.
- Produces JSON payloads:
  - `start` → `{ slug, item }` (item now `in-progress` with `startedAt`)
  - `record` → `{ slug, item, goalStatus }`
  - `check` → `{ slug, results: Array<{kind, label, outcome: "pass"|"fail"|"manual", exitCode?: number|null, detail?: string}>, passed: boolean }`
  - `close` → `{ slug, status }`
- Ledger events written: `step-started` (from `start`), `disposition` (from `record`). Exactly these two event types exist in v1.

- [ ] **Step 1: Write the failing e2e tests**

Append to `tests/goal-companion.test.mjs`:

```js
test("start enforces one in-progress item and records step-started", () => {
  const project = makeTempDir("goal-proj-");
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

test("record enforces the state machine and blocked halts the goal", () => {
  const project = makeTempDir("goal-proj-");
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
  const project = makeTempDir("goal-proj-");
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

test("check judges command criteria by exit code and lists manual ones", () => {
  const project = makeTempDir("goal-proj-");
  writeGoalFixture(project);
  const pass = companion(["check", "--json"], project);
  assert.equal(pass.status, 0, pass.stderr);
  const passPayload = JSON.parse(pass.stdout);
  assert.equal(passPayload.passed, true);
  assert.equal(passPayload.results.find((r) => r.kind === "manual").outcome, "manual");

  const failing = makeTempDir("goal-proj-");
  writeGoalFixture(failing, {
    acceptanceCriteria: [{ kind: "command", run: "node -e \"process.exit(3)\"", expect: "exit0" }]
  });
  const fail = companion(["check", "--json"], failing);
  assert.equal(fail.status, 1);
  assert.equal(JSON.parse(fail.stdout).passed, false);
});

test("close --done refuses while work remains, succeeds when the backlog is settled", () => {
  const project = makeTempDir("goal-proj-");
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/goal-companion.test.mjs`
Expected: FAIL with `Unknown subcommand: start` (and siblings) surfacing in the assertions.

- [ ] **Step 3: Write the implementation**

In `plugins/goal/scripts/goal-companion.mjs`, add `import { spawnSync } from "node:child_process";` to the imports, then add these handlers above `main()`:

```js
const DISPOSITIONS = ["merged", "discarded", "dropped", "blocked"];
const DELEGATES = ["codex", "cursor", "none"];
const DEFAULT_CRITERION_TIMEOUT_MS = 600000;

function requireItem(goal, itemId) {
  const item = goal.backlog.find((candidate) => candidate.id === itemId);
  if (!item) {
    throw new Error(
      `Item "${itemId}" not found. Backlog: ${goal.backlog.map((candidate) => candidate.id).join(", ")}`
    );
  }
  return item;
}

async function handleStart(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });
  const cwd = resolveCommandCwd(options);
  const [slugArg, itemId] = positionals;
  if (!slugArg || !itemId) {
    throw new Error("start requires <slug> <itemId>");
  }
  const { slug, goal } = resolveGoal(cwd, slugArg);
  if (goal.status !== "active") {
    throw new Error(`Goal "${slug}" is ${goal.status}; only an active goal can start work.`);
  }
  const inProgress = goal.backlog.find((item) => item.status === "in-progress");
  if (inProgress) {
    throw new Error(
      `Item "${inProgress.id}" is already in progress. One increment at a time — record it first.`
    );
  }
  const item = requireItem(goal, itemId);
  if (item.status !== "todo") {
    throw new Error(`Item "${itemId}" is ${item.status}, not todo; it cannot be started.`);
  }
  item.status = "in-progress";
  item.startedAt = new Date().toISOString();
  saveGoal(cwd, goal);
  appendLedger(cwd, { slug, itemId, event: "step-started" });
  output({ slug, item }, `Started ${itemId}: ${item.title}\n`, options.json);
}

async function handleRecord(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd", "disposition", "pr", "delegate", "notes"],
    booleanOptions: ["json"]
  });
  const cwd = resolveCommandCwd(options);
  const [slugArg, itemId] = positionals;
  if (!slugArg || !itemId) {
    throw new Error("record requires <slug> <itemId>");
  }
  const disposition = options.disposition;
  if (!DISPOSITIONS.includes(disposition)) {
    throw new Error(`--disposition must be one of ${DISPOSITIONS.join("|")}`);
  }
  if (options.delegate !== undefined && !DELEGATES.includes(options.delegate)) {
    throw new Error(`--delegate must be one of ${DELEGATES.join("|")}`);
  }
  let pr;
  if (options.pr !== undefined) {
    pr = Number(options.pr);
    if (!Number.isInteger(pr) || pr <= 0) {
      throw new Error("--pr must be a positive integer");
    }
  }
  const { slug, goal } = resolveGoal(cwd, slugArg);
  const item = requireItem(goal, itemId);
  if (disposition === "dropped") {
    if (item.status !== "todo" && item.status !== "in-progress") {
      throw new Error(`Item "${itemId}" is ${item.status}; only todo or in-progress items can be dropped.`);
    }
  } else if (item.status !== "in-progress") {
    throw new Error(`Item "${itemId}" is ${item.status}; it must be in-progress to record "${disposition}".`);
  }
  item.status = disposition;
  item.disposition = {
    recordedAt: new Date().toISOString(),
    ...(pr !== undefined ? { pr } : {}),
    ...(options.delegate !== undefined ? { delegate: options.delegate } : {}),
    ...(options.notes !== undefined ? { notes: options.notes } : {})
  };
  if (disposition === "blocked") {
    goal.status = "blocked";
    goal.blockedReason = options.notes || `Item "${itemId}" is blocked.`;
  }
  saveGoal(cwd, goal);
  appendLedger(cwd, {
    slug,
    itemId,
    event: "disposition",
    disposition,
    ...(pr !== undefined ? { pr } : {}),
    ...(options.delegate !== undefined ? { delegate: options.delegate } : {}),
    ...(options.notes !== undefined ? { notes: options.notes } : {})
  });
  output(
    { slug, item, goalStatus: goal.status },
    `Recorded ${itemId} as ${disposition}.${goal.status === "blocked" ? " Goal is now blocked." : ""}\n`,
    options.json
  );
}

function runCheck(cwd, goal) {
  const results = goal.acceptanceCriteria.map((criterion) => {
    if (criterion.kind === "manual") {
      return { kind: "manual", label: criterion.text, outcome: "manual" };
    }
    // Command criteria run via the shell: the goal file is git-tracked project
    // content, the same trust level as npm scripts (documented in the docs).
    const outcome = spawnSync(criterion.run, {
      cwd,
      shell: true,
      encoding: "utf8",
      timeout: criterion.timeoutMs ?? DEFAULT_CRITERION_TIMEOUT_MS
    });
    const pass = outcome.error === undefined && outcome.status === 0;
    return {
      kind: "command",
      label: criterion.run,
      outcome: pass ? "pass" : "fail",
      exitCode: outcome.status ?? null,
      ...(outcome.error ? { detail: outcome.error.message } : {})
    };
  });
  const passed = results.every((result) => result.outcome !== "fail");
  return { results, passed };
}

async function handleCheck(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });
  const cwd = resolveCommandCwd(options);
  const { slug, goal } = resolveGoal(cwd, positionals[0] ?? "");
  const { results, passed } = runCheck(cwd, goal);
  const rendered = results
    .map((result) =>
      result.outcome === "manual"
        ? `- [manual] ${result.label}`
        : `- [${result.outcome}] ${result.label} (exit ${result.exitCode ?? "n/a"})`
    )
    .join("\n");
  output({ slug, results, passed }, `${rendered}\n${passed ? "All command criteria pass." : "Command criteria FAILED."}\n`, options.json);
  if (!passed) {
    process.exitCode = 1;
  }
}

async function handleClose(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json", "done", "abandoned"]
  });
  const cwd = resolveCommandCwd(options);
  const slugArg = positionals[0];
  if (!slugArg) {
    throw new Error("close requires <slug>");
  }
  if (options.done === options.abandoned) {
    throw new Error("close requires exactly one of --done or --abandoned");
  }
  const { slug, goal } = resolveGoal(cwd, slugArg);
  if (options.done) {
    const open = goal.backlog.filter(
      (item) => item.status === "todo" || item.status === "in-progress"
    );
    if (open.length > 0) {
      throw new Error(
        `Cannot close as done: ${open.length} item(s) still todo/in-progress (${open.map((item) => item.id).join(", ")}).`
      );
    }
    const { passed } = runCheck(cwd, goal);
    if (!passed) {
      throw new Error("Cannot close as done: command acceptance criteria are failing (run `check`).");
    }
    goal.status = "done";
  } else {
    goal.status = "abandoned";
  }
  goal.blockedReason = null;
  saveGoal(cwd, goal);
  output({ slug, status: goal.status }, `Goal "${slug}" closed as ${goal.status}.\n`, options.json);
}
```

Extend the `switch` in `main()` with the four cases (before `default`):

```js
    case "start":
      await handleStart(argv);
      return;
    case "record":
      await handleRecord(argv);
      return;
    case "check":
      await handleCheck(argv);
      return;
    case "close":
      await handleClose(argv);
      return;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/goal-companion.test.mjs`
Expected: PASS (16 tests).

- [ ] **Step 5: Commit**

```bash
git add plugins/goal/scripts/goal-companion.mjs tests/goal-companion.test.mjs
git commit -m "Goal companion: start/record/check/close with the mechanical state machine"
```

---

### Task 7: Extend the import-closure guard to the goal plugin

**Files:**
- Modify: `tests/import-closure.test.mjs` (one line)

**Interfaces:**
- Consumes: the completed `plugins/goal/scripts/` tree (Tasks 5–6).
- Produces: mechanical self-containment enforcement for `plugins/goal`.

- [ ] **Step 1: Make the change**

In `tests/import-closure.test.mjs`, change:

```js
const PLUGINS = ["codex", "cursor"];
```

to:

```js
const PLUGINS = ["codex", "cursor", "goal"];
```

- [ ] **Step 2: Run the guard plus the untouched drift guard**

Run: `node --test tests/import-closure.test.mjs tests/chassis-drift.test.mjs`
Expected: PASS. (The drift guard ignores `plugins/goal` — it mirrors nothing; if import-closure fails, a goal-plugin import escaped its directory or a lib module is unreachable — fix the import, do not exempt.)

- [ ] **Step 3: Commit**

```bash
git add tests/import-closure.test.mjs
git commit -m "Extend the import-closure guard to the goal plugin"
```

---

### Task 8: Commands, skill, README section, and doc pins

**Files:**
- Create: `plugins/goal/commands/set.md`, `plugins/goal/commands/step.md`, `plugins/goal/commands/status.md`, `plugins/goal/commands/help.md`
- Create: `plugins/goal/skills/goal-runner/SKILL.md`
- Modify: `README.md` (nav link + new section)
- Modify: `tests/goal-docs.test.mjs` (append pins)

**Interfaces:**
- Consumes: the companion CLI surface (Tasks 5–6) — every invocation in the docs must match `printUsage()` exactly.
- Produces: the user-facing contract. The pinned phrases below are load-bearing; do not reword them without updating the pins in the same commit.

- [ ] **Step 1: Write the failing pins**

Append to `tests/goal-docs.test.mjs`:

```js
test("goal step command pins the one-increment choreography", () => {
  const step = read(path.join("commands", "step.md"));
  assert.match(step, /One increment per invocation/);
  assert.match(step, /Announce the increment in one line/);
  assert.match(step, /goal-companion\.mjs" next/);
  assert.match(step, /goal-companion\.mjs" start/);
  assert.match(step, /Analysis and implementation are separate delegations/);
  assert.match(step, /refine the brief with the failure evidence and re-delegate once/);
  assert.match(step, /--disposition blocked/);
  assert.match(step, /Do not start another increment/);
});

test("goal-runner skill pins the policy", () => {
  const skill = read(path.join("skills", "goal-runner", "SKILL.md"));
  assert.match(skill, /^name: goal-runner$/m);
  assert.match(skill, /one increment at a time/i);
  assert.match(skill, /codex-delegation|cursor-delegation/);
  assert.match(skill, /blocked is a full stop/i);
  assert.match(skill, /Never invent progress/);
});

test("README documents the goal plugin", () => {
  const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
  assert.match(readme, /## Goal plugin/);
  assert.match(readme, /\[Goal plugin\]\(#goal-plugin\)/);
  assert.match(readme, /one increment at a time/);
});
```

- [ ] **Step 2: Run pins to verify they fail**

Run: `node --test tests/goal-docs.test.mjs`
Expected: FAIL (`ENOENT` on `commands/step.md`).

- [ ] **Step 3: Write the commands**

`plugins/goal/commands/set.md`:

```markdown
---
description: Create or update a long-horizon goal for this project
argument-hint: "[description of the goal]"
---

Create or update a goal file for this project.

1. Interview briefly if needed: the goal statement, acceptance criteria
   (mechanically checkable commands where possible, `manual` otherwise), a
   ranked backlog of increments (each `[a-z0-9-]+` id, title, detail), and
   `budget.perStepDelegations` (default 2).
2. Draft the goal JSON (schemaVersion 1) to a temp file.
3. Run: `node "${CLAUDE_PLUGIN_ROOT}/scripts/goal-companion.mjs" set --file <temp-path>`
   The companion validates and writes `.claude/goals/<slug>.json`; if it
   refuses, fix exactly what it names and re-run — never bypass validation.
4. Show the result of `node "${CLAUDE_PLUGIN_ROOT}/scripts/goal-companion.mjs" status <slug>`.
5. Remind the user the goal file is git-tracked project content: commit it.

Trust note: `check` runs command criteria via the shell — the same trust
level as npm scripts. Review goal files in untrusted repos before running.
```

`plugins/goal/commands/step.md`:

```markdown
---
description: Advance the project goal by exactly one increment
argument-hint: "[slug]"
---

Advance the goal one increment. One increment per invocation — when step 7
completes, stop. Do not start another increment; repetition is the user's
call (or `/loop` while they watch).

1. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/goal-companion.mjs" next [slug] --json`.
   If it refuses (goal blocked/done, an item already in progress, nothing
   todo), surface the reason verbatim and stop.
2. Announce the increment in one line — what it is and whether you intend to
   delegate it.
3. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/goal-companion.mjs" start <slug> <itemId>`.
4. Execute with judgment: trivial work stays local; otherwise delegate via
   the `codex-delegation` / `cursor-delegation` skills. Analysis and
   implementation are separate delegations when both are needed, within the
   goal's `budget.perStepDelegations` (advisory: say so if you exceed it).
5. Verify through the project's own gates (this repo: `npm run verify`) and
   land the change as a PR; the user merges.
6. If delegated work fails verification: refine the brief with the failure
   evidence and re-delegate once (it counts against the step budget). If it
   fails again, record the item as blocked:
   `node "${CLAUDE_PLUGIN_ROOT}/scripts/goal-companion.mjs" record <slug> <itemId> --disposition blocked --notes "<evidence>"`
7. Record the real disposition (`merged` with `--pr <n>` and `--delegate`,
   or `discarded`/`blocked` with `--notes`), show the one-line output of
   `status`, and stop.
```

`plugins/goal/commands/status.md`:

```markdown
---
description: Show the project goal's progress
argument-hint: "[slug]"
---

Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/goal-companion.mjs" status [slug]`
and present the output faithfully, including any corrupt-ledger-line count.
If it refuses (no goals, ambiguous slug), relay the refusal and the listed
slugs verbatim.
```

`plugins/goal/commands/help.md`:

```markdown
---
description: Show goal companion usage
---

Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/goal-companion.mjs" help` and show
the output verbatim.
```

- [ ] **Step 4: Write the skill**

`plugins/goal/skills/goal-runner/SKILL.md`:

```markdown
---
name: goal-runner
description: Use when the user asks to advance, continue, or work on the project's long-horizon goal (or to set one up) — the policy for goal-driven increments driven through the goal companion, one increment at a time, delegated via the codex/cursor delegation skills, honestly recorded.
---

# Goal Runner

The companion (`goal-companion.mjs`) owns state, selection, and dispositions;
you own judgment. Follow the `/goal:step` choreography exactly — never
reimplement its bookkeeping by editing the goal file ad hoc.

Policy:

- **One increment at a time.** `next` → `start` → execute → verify → PR →
  `record` → stop. The companion refuses a second in-progress item; do not
  work around the refusal.
- **Disclose.** Announce each increment (and each delegation) in one line.
- **Delegate with judgment.** Trivial work stays local. Deep analysis or a
  second opinion goes to Codex, fast parallel implementation to Cursor, via
  the `codex-delegation` / `cursor-delegation` skills. Analysis and
  implementation are separate delegations when both are needed.
- **Refine once.** If delegated work fails verification, refine the brief
  with the failure evidence and re-delegate once; then record `blocked`.
- **Blocked is a full stop.** A blocked item blocks the goal; `next` refuses
  until a human resolves it. Surface the reason; never guess past it.
- **Honest dispositions.** `merged` means the PR merged. Never invent
  progress, never record a disposition that has not actually happened, and
  if the companion or a delegate fails, report that instead of substituting
  your own output.
```

- [ ] **Step 5: Update the README**

In `README.md`, in the nav block, after the line `[Ambient delegation](#ambient-delegation) •` add:

```markdown
[Goal plugin](#goal-plugin) •
```

After the `## Ambient delegation` section (before `## How it works`), add:

```markdown
## Goal plugin

Set a long-horizon goal once, then advance it one increment at a time — in
session, with you watching. `/goal:set` writes a schema-validated, git-tracked
goal file (`.claude/goals/<slug>.json`) with a ranked backlog and acceptance
criteria; `/goal:step` picks the next increment deterministically, executes it
(delegating to Codex or Cursor through the same skills as above), lands the
change as a PR through your normal gates, and records what actually happened
— merged, discarded, or blocked — in the goal file and an append-only ledger.
The companion enforces the honest parts mechanically: one in-progress item at
a time, refusals with specifics instead of silent repair, and a blocked goal
is a full stop until a human resolves it.

```bash
/plugin install goal@agent-collab
/goal:set    # interview → validated goal file
/goal:step   # advance exactly one increment
/goal:status
```
```

- [ ] **Step 6: Run all doc tests**

Run: `node --test tests/goal-docs.test.mjs tests/commands.test.mjs tests/cursor-skills.test.mjs`
Expected: PASS (existing README pins in commands.test.mjs must not break; if one does, the README edit collided with a pinned string — adjust placement, not the pinned text).

- [ ] **Step 7: Commit**

```bash
git add plugins/goal/commands plugins/goal/skills README.md tests/goal-docs.test.mjs
git commit -m "Goal plugin: commands, goal-runner skill, README section, doc pins"
```

---

### Task 9: Verify gate, PR, and live-fire dogfood

**Files:**
- Create: `.claude/goals/zclean-backlog.json` (dogfood seed, this repo)
- No other code changes — this task is verification and the live acceptance run.

**Interfaces:**
- Consumes: everything above.
- Produces: merged PR; a real goal file on this repo; observed live output of one full `/goal:step`-choreography cycle.

- [ ] **Step 1: Full local gate**

Run: `npm run verify`
Expected: `Gate: PASSED (all legs verified)` — build, native suite, dockerized Linux suite. Fix anything red before proceeding.

- [ ] **Step 2: Push and open the PR**

```bash
git push -u origin goal-plugin
gh pr create --title "Add the goal plugin: attended /goal loop with a mechanical outcome ledger" --body "Implements docs/superpowers/specs/2026-08-07-goal-plugin-design.md. Companion-backed state (schema-validated git-tracked goal file, deterministic next selection, one-increment enforcement, disposition ledger), commands + goal-runner skill, README section, doc pins, import-closure coverage. No chassis mirroring; delegation rides the existing codex/cursor delegation skills."
```

Then merge per repo practice (`gh pr merge <n> --squash` once the local gate is green; Actions dispatch is intermittent).

- [ ] **Step 3: Groom the dogfood backlog (honesty pass)**

Re-verify each zclean memory item against current `main` before seeding — several are already shipped. For each candidate, find the evidence:

```bash
grep -n "locale-stable" plugins/codex/CHANGELOG.md        # expect: shipped in 1.0.6+fork.4 → exclude
grep -n "starttime" plugins/cursor/CHANGELOG.md            # expect: WSL reap identity shipped in 0.4.0 → exclude
grep -rn "vacuous\|withStateFileLock" tests/broker-launch-lock.test.mjs tests/state.test.mjs | head -5   # judge whether the weak lock test still exists → include if so
```

Only items with no shipped evidence go in the backlog. Draft `.claude/goals/zclean-backlog.json` accordingly (statement: "Burn down the zclean comparison backlog"; criteria: `npm test` exit0 command + a manual criterion "Every item merged or explicitly dropped with a reason"; budget 2), then:

```bash
node plugins/goal/scripts/goal-companion.mjs set --file <draft-path> --cwd .
node plugins/goal/scripts/goal-companion.mjs status --cwd .
git add .claude/goals/zclean-backlog.json && git commit -m "Seed the zclean-backlog goal" && git push
```

(Commit via a branch + PR per repo rules.)

- [ ] **Step 4: Live-fire one full step**

Follow `plugins/goal/commands/step.md` exactly against this repo: `next` → announce → `start` → execute the first item (delegating if it fits) → `npm run verify` → PR → merge → `record --disposition merged --pr <n>` → `status`. Capture and report the observed output of every companion invocation. The plugin is not done until this run has happened and been reported — a green suite is not the acceptance test; the live run is.

- [ ] **Step 5: Update memory**

Record in the project memory: goal plugin shipped, first dogfood step's outcome, and any defect the live fire surfaced (live fire has found a defect in every major feature so far — expect one).

---

## Self-Review (completed)

- **Spec coverage:** layout → T1; schema/validation/slug/atomic writes → T3; ledger two-layer → T4 (jsonl) + T6 (`record` writes goal-file dispositions); command surface → T5–T6; slug-resolution refusals → T3; one-increment enforcement → T3 (validation) + T5 (`next`) + T6 (`start`); check trust boundary → T6 code comment + set.md note; choreography incl. refine-once and separate analyze/implement → T8; import-closure → T7; README/marketplace pins → T1/T8; dogfood grooming + live fire → T9. Non-goals require no code.
- **Placeholder scan:** none — every step carries the actual code/doc content.
- **Type consistency:** payload field names (`slug`, `item`, `counts`, `corruptLedgerLines`, `disposition`, `recordedAt`, `perStepDelegations`) verified consistent across T3–T8; companion usage strings in docs match `printUsage()`.
