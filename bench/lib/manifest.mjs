// The shared bench manifest contract (bench/tasks/<id>/manifest.json). This
// file is git-tracked project content another agent hand-authors per task, so
// precision here is the whole safety story — same doctrine as
// plugins/goal/scripts/lib/goal-state.mjs's validateGoal: unknown keys are
// refused at every nesting level, and every refusal names the exact field.
import fs from "node:fs";
import path from "node:path";

export const MANIFEST_SCHEMA_VERSION = 1;

// Loose on length (short SHAs are legitimate git refs) but strict on
// alphabet, and fixSha/parentSha must differ — a manifest pointing both at
// the same commit could never calibrate RED at parentSha and GREEN at fixSha.
const SHA_PATTERN = /^[0-9a-f]{7,40}$/i;

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isStringArray(value) {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

const TOP_KEYS = new Set([
  "schemaVersion",
  "id",
  "fixSha",
  "parentSha",
  "symptomFile",
  "groundTruth",
  "classBonus",
  "originalStrict",
  "regressionSuite",
  "driftCheckRequired",
  "timeouts",
  "budgetUsd",
  "forbiddenSymptomStrings"
]);
const PAIR_KEYS = new Set(["from", "to"]);
const GROUND_TRUTH_KEYS = new Set(["tests", "fixtures"]);
const CLASS_BONUS_KEYS = new Set(["tests"]);
const ORIGINAL_STRICT_KEYS = new Set(["transplantFromFix", "excludeTestNames", "caveat"]);
const TIMEOUTS_KEYS = new Set(["claudeMs", "testMs"]);

function checkUnknownKeys(object, allowedKeys, label, errors) {
  for (const key of Object.keys(object)) {
    if (!allowedKeys.has(key)) {
      errors.push(`${label} has unknown key "${key}" — remove it or fix the spelling`);
    }
  }
}

function validatePairArray(value, label, errors) {
  if (!Array.isArray(value)) {
    errors.push(`${label} must be an array`);
    return;
  }
  value.forEach((entry, index) => {
    const entryLabel = `${label}[${index}]`;
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      errors.push(`${entryLabel} must be an object with "from" and "to"`);
      return;
    }
    checkUnknownKeys(entry, PAIR_KEYS, entryLabel, errors);
    if (!isNonEmptyString(entry.from)) errors.push(`${entryLabel}.from must be a non-empty string`);
    if (!isNonEmptyString(entry.to)) errors.push(`${entryLabel}.to must be a non-empty string`);
  });
}

/**
 * Validate a bench manifest object against schemaVersion 1. Returns a list of
 * specific problems; an empty list means valid.
 */
export function validateManifest(value) {
  const errors = [];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return ["manifest must be a JSON object"];
  }
  checkUnknownKeys(value, TOP_KEYS, "manifest", errors);

  if (value.schemaVersion !== MANIFEST_SCHEMA_VERSION) {
    errors.push(`schemaVersion must be ${MANIFEST_SCHEMA_VERSION}`);
  }
  if (!isNonEmptyString(value.id)) {
    errors.push("id must be a non-empty string");
  }
  if (!isNonEmptyString(value.fixSha) || !SHA_PATTERN.test(value.fixSha)) {
    errors.push("fixSha must be a hex git SHA string");
  }
  if (!isNonEmptyString(value.parentSha) || !SHA_PATTERN.test(value.parentSha)) {
    errors.push("parentSha must be a hex git SHA string");
  }
  if (
    isNonEmptyString(value.fixSha) &&
    isNonEmptyString(value.parentSha) &&
    value.fixSha.toLowerCase() === value.parentSha.toLowerCase()
  ) {
    errors.push("fixSha and parentSha must differ");
  }
  if (value.symptomFile !== "symptom.md") {
    errors.push('symptomFile must be "symptom.md"');
  }

  if (typeof value.groundTruth !== "object" || value.groundTruth === null || Array.isArray(value.groundTruth)) {
    errors.push('groundTruth must be an object with "tests" and "fixtures"');
  } else {
    checkUnknownKeys(value.groundTruth, GROUND_TRUTH_KEYS, "groundTruth", errors);
    validatePairArray(value.groundTruth.tests, "groundTruth.tests", errors);
    validatePairArray(value.groundTruth.fixtures, "groundTruth.fixtures", errors);
    if (Array.isArray(value.groundTruth.tests) && value.groundTruth.tests.length === 0) {
      errors.push("groundTruth.tests must contain at least one test");
    }
  }

  if (value.classBonus !== null && value.classBonus !== undefined) {
    if (typeof value.classBonus !== "object" || Array.isArray(value.classBonus)) {
      errors.push('classBonus must be null or an object with "tests"');
    } else {
      checkUnknownKeys(value.classBonus, CLASS_BONUS_KEYS, "classBonus", errors);
      validatePairArray(value.classBonus.tests, "classBonus.tests", errors);
    }
  }

  if (typeof value.originalStrict !== "object" || value.originalStrict === null || Array.isArray(value.originalStrict)) {
    errors.push("originalStrict must be an object");
  } else {
    checkUnknownKeys(value.originalStrict, ORIGINAL_STRICT_KEYS, "originalStrict", errors);
    if (!isStringArray(value.originalStrict.transplantFromFix)) {
      errors.push("originalStrict.transplantFromFix must be an array of path strings");
    }
    if (!isStringArray(value.originalStrict.excludeTestNames)) {
      errors.push("originalStrict.excludeTestNames must be an array of strings");
    }
    if (!isNonEmptyString(value.originalStrict.caveat)) {
      errors.push("originalStrict.caveat must be a non-empty string");
    }
  }

  if (!isStringArray(value.regressionSuite)) {
    errors.push("regressionSuite must be an array of path strings");
  }
  if (typeof value.driftCheckRequired !== "boolean") {
    errors.push("driftCheckRequired must be a boolean");
  }

  if (typeof value.timeouts !== "object" || value.timeouts === null || Array.isArray(value.timeouts)) {
    errors.push("timeouts must be an object with claudeMs and testMs");
  } else {
    checkUnknownKeys(value.timeouts, TIMEOUTS_KEYS, "timeouts", errors);
    if (!Number.isInteger(value.timeouts.claudeMs) || value.timeouts.claudeMs <= 0) {
      errors.push("timeouts.claudeMs must be a positive integer");
    }
    if (!Number.isInteger(value.timeouts.testMs) || value.timeouts.testMs <= 0) {
      errors.push("timeouts.testMs must be a positive integer");
    }
  }

  if (!Number.isFinite(value.budgetUsd) || value.budgetUsd <= 0) {
    errors.push("budgetUsd must be a positive number");
  }

  if (!isStringArray(value.forbiddenSymptomStrings)) {
    errors.push("forbiddenSymptomStrings must be an array of strings");
  }

  return errors;
}

/**
 * Load and validate bench/tasks/<id>/manifest.json. Throws with specifics
 * naming the field on any parse or validation failure — never returns a
 * partially-trusted manifest.
 */
export function loadManifest(taskDir) {
  const file = path.join(taskDir, "manifest.json");
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (error) {
    throw new Error(`Cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${file} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const errors = validateManifest(parsed);
  if (errors.length > 0) {
    throw new Error(`${file} is not a valid bench manifest:\n  - ${errors.join("\n  - ")}`);
  }
  const expectedId = path.basename(taskDir);
  if (parsed.id !== expectedId) {
    throw new Error(`${file}: id "${parsed.id}" does not match the task directory name "${expectedId}"`);
  }
  return parsed;
}
