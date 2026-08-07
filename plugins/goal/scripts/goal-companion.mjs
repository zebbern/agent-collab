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
