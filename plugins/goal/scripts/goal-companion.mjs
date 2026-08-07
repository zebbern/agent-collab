#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

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
      "  node scripts/goal-companion.mjs ledger [slug] [--json]",
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
  const goalEntries = entries.filter((entry) => entry.slug === slug);
  const payload = {
    slug,
    status: goal.status,
    blockedReason: goal.blockedReason,
    counts,
    inProgress,
    ledgerTail: goalEntries.slice(-5),
    corruptLedgerLines: corruptCount
  };
  const lines = [
    `# Goal: ${slug} (${goal.status}${goal.status === "blocked" ? ` — ${goal.blockedReason}` : ""})`,
    goal.statement,
    `Items: ${counts.todo} todo, ${counts["in-progress"]} in-progress, ${counts.merged} merged, ${counts.discarded} discarded, ${counts.dropped} dropped, ${counts.blocked} blocked.`,
    inProgress ? `In progress: ${inProgress.id} — ${inProgress.title}` : "Nothing in progress.",
    ...goalEntries
      .slice(-3)
      .map((entry) => `-> ${entry.at} ${entry.event}${entry.disposition ? ` ${entry.disposition}` : ""} ${entry.itemId}`),
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
  if (goal.status !== "active") {
    throw new Error(
      `Goal "${slug}" is ${goal.status}; dispositions are frozen once a goal leaves active. Edit the goal file and re-run set if this is intentional.`
    );
  }
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
        : `- [${result.outcome}] ${result.label} (exit ${result.exitCode ?? "n/a"}${result.detail ? ` — ${result.detail}; its processes may still be running` : ""})`
    )
    .join("\n");
  output({ slug, results, passed }, `${rendered}\n${passed ? "All command criteria pass." : "Command criteria FAILED."}\n`, options.json);
  if (!passed) {
    process.exitCode = 1;
  }
}

async function handleLedger(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });
  const cwd = resolveCommandCwd(options);
  // Read-only: works on goals of any status (the retrospective reads history,
  // it never advances work), so no active-goal gate here.
  const { slug } = resolveGoal(cwd, positionals[0] ?? "");
  const { entries, corruptCount } = readLedger(cwd);
  const goalEntries = entries.filter((entry) => entry.slug === slug);
  const lines = [
    ...goalEntries.map(
      (entry) =>
        `${entry.at} ${entry.event}${entry.disposition ? ` ${entry.disposition}` : ""} ${entry.itemId}${entry.pr ? ` PR#${entry.pr}` : ""}${entry.delegate ? ` via ${entry.delegate}` : ""}`
    ),
    corruptCount > 0 ? `Ledger: ${corruptCount} corrupt line(s) skipped.` : null
  ].filter((line) => line !== null);
  output(
    { slug, entries: goalEntries, corruptLedgerLines: corruptCount },
    `${lines.join("\n")}\n`,
    options.json
  );
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
    if (goal.status === "done" || goal.status === "abandoned") {
      throw new Error(`Goal "${slug}" is already ${goal.status}; closed goals are frozen.`);
    }
    if (goal.status !== "active") {
      throw new Error(
        `Cannot close as done: goal "${slug}" is ${goal.status} (${goal.blockedReason}). Resolve that first.`
      );
    }
    const blockedItems = goal.backlog.filter((item) => item.status === "blocked");
    if (blockedItems.length > 0) {
      throw new Error(
        `Cannot close as done: ${blockedItems.length} item(s) are blocked (${blockedItems.map((item) => item.id).join(", ")}) — resolve them (back to todo, or dropped) by editing the goal file and re-running set.`
      );
    }
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
    if (goal.status === "done" || goal.status === "abandoned") {
      throw new Error(`Goal "${slug}" is already ${goal.status}; closed goals are frozen.`);
    }
    goal.status = "abandoned";
  }
  goal.blockedReason = null;
  saveGoal(cwd, goal);
  output({ slug, status: goal.status }, `Goal "${slug}" closed as ${goal.status}.\n`, options.json);
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
    case "start":
      await handleStart(argv);
      return;
    case "record":
      await handleRecord(argv);
      return;
    case "check":
      await handleCheck(argv);
      return;
    case "ledger":
      await handleLedger(argv);
      return;
    case "close":
      await handleClose(argv);
      return;
    default:
      throw new Error(`Unknown subcommand: ${subcommand}`);
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
