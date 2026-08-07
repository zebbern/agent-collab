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
