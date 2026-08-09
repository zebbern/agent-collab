// Proving which tree a measurement actually ran against.
//
// This module exists because of a specific silent failure: a scout certifying
// a task believed it was measuring the fixed commit while a CRLF-aborted
// checkout had left it on the parent. Nothing errored. The numbers looked
// plausible. Every conclusion drawn from them would have been backwards.
//
// So: capture the tree's identity immediately before EVERY PoC invocation and
// compare it to what the leg is supposed to be. A run whose provenance does not
// match is a harness failure, never a score.
//
// It also mechanically enforces the structural property that makes the paired
// contract work at all — see verifyLegFingerprints.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export function sha256File(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function git(treeDir, args) {
  return execFileSync("git", args, { cwd: treeDir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/**
 * The identity of a tree at one moment: which commit it claims to be on, and
 * the exact bytes of the files the agent was pointed at.
 *
 * Missing watched files hash as null rather than throwing — a leg that deletes
 * an audited file is a real (and interesting) state, not a crash.
 */
export function captureProvenance(treeDir, watchedPaths = []) {
  let headSha = null;
  let dirty = null;
  try {
    headSha = git(treeDir, ["rev-parse", "HEAD"]);
    dirty = git(treeDir, ["status", "--porcelain"]).length > 0;
  } catch (error) {
    // A shipped tree may legitimately have no git history (several corpus
    // tasks squash or strip it to avoid leaking the fix). File hashes are then
    // the whole identity, and that is recorded rather than guessed at.
    headSha = null;
    dirty = null;
    void error;
  }

  const fileHashes = {};
  for (const relativePath of watchedPaths) {
    const absolute = path.join(treeDir, relativePath);
    fileHashes[relativePath] = fs.existsSync(absolute) && fs.statSync(absolute).isFile()
      ? sha256File(absolute)
      : null;
  }
  return { headSha, dirty, fileHashes };
}

/**
 * Compare an observed capture against the one recorded when the leg was built.
 * Returns every mismatch rather than the first, so a drifted run reports its
 * whole story at once.
 */
export function compareProvenance(actual, expected) {
  const mismatches = [];
  if (expected?.headSha != null && actual?.headSha !== expected.headSha) {
    mismatches.push(`HEAD is ${actual?.headSha ?? "unknown"}, expected ${expected.headSha}`);
  }
  const watched = new Set([
    ...Object.keys(expected?.fileHashes ?? {}),
    ...Object.keys(actual?.fileHashes ?? {})
  ]);
  for (const file of [...watched].sort()) {
    const want = expected?.fileHashes?.[file];
    const got = actual?.fileHashes?.[file];
    if (want !== undefined && want !== got) {
      mismatches.push(`${file} is ${got ?? "missing"}, expected ${want ?? "missing"}`);
    }
  }
  return { ok: mismatches.length === 0, mismatches };
}

/**
 * Throwing form, for use immediately before a scored invocation. The thrown
 * error names the leg, because "some run measured the wrong tree" is useless
 * and "leg camo measured the parent's bytes" is actionable.
 */
export function assertProvenance(actual, expected, legName) {
  const { ok, mismatches } = compareProvenance(actual, expected);
  if (!ok) {
    throw new Error(
      `Provenance check failed for leg "${legName}" — refusing to score a run against an ` +
        `unexpected tree:\n  - ${mismatches.join("\n  - ")}`
    );
  }
  return true;
}

/**
 * The structural check that makes the paired contract mean anything.
 *
 * A camo (and its decoy-c twin) close/leave-open the flaw from OUTSIDE the
 * audited region — so their audited bytes must be IDENTICAL to the parent's.
 * If a camo accidentally touches the audited region, a static oracle can see
 * it, and the pair it was supposed to form silently stops existing.
 *
 * Conversely a minimal patch and its decoy twin edit the audited region by
 * definition — one that does not is not doing its job either.
 *
 * Both directions were violated in practice during task hardening, which is
 * why this is a mechanical check and not a review instruction.
 *
 * @param {Array<{name: string, role: string, provenance: {fileHashes: object}}>} legs
 * @param {string[]} auditScope paths the agent is pointed at
 */
export function verifyLegFingerprints(legs, auditScope) {
  const problems = [];
  const parent = (legs ?? []).find((leg) => leg.role === "parent");
  if (!parent) {
    return { ok: false, problems: ["no parent leg to compare against"] };
  }

  const auditedOf = (leg) =>
    (auditScope ?? []).map((file) => `${file}=${leg.provenance?.fileHashes?.[file] ?? "missing"}`).join("|");
  const parentAudited = auditedOf(parent);

  for (const leg of legs ?? []) {
    if (leg.role === "parent") {
      continue;
    }
    const audited = auditedOf(leg);
    const identical = audited === parentAudited;

    if ((leg.role === "camo" || leg.role === "decoy-c") && !identical) {
      problems.push(
        `leg "${leg.name}" (${leg.role}) must leave the audited region byte-identical to the parent — ` +
          "it fixes or fakes from outside it. Touching audited bytes lets a static oracle separate " +
          "this leg from its twin, which removes the pair"
      );
    }
    if ((leg.role === "minimal" || leg.role === "decoy") && identical) {
      problems.push(
        `leg "${leg.name}" (${leg.role}) has audited bytes identical to the parent — it is supposed ` +
          "to edit the audited region, so as built it is not exercising anything"
      );
    }
  }
  return { ok: problems.length === 0, problems };
}
