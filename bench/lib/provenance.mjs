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
 * CORRECTED after a measurement. The first version compared each leg's audited
 * bytes against the PARENT's and demanded that camo/decoy-c match. That is
 * wrong whenever the chokepoint lives in the same file the agent audits — on
 * the corpus's canary task both the camo and its decoy-c act inside
 * `http_parser.py`, which *is* an audit-scope file, so every leg's file hash
 * differs from the parent's and a whole-file rule either fires spuriously or
 * passes vacuously.
 *
 * The property that actually carries the invariant is PAIRWISE and applies
 * outside the audited region: a camo and its decoy-c twin must be
 * INDISTINGUISHABLE THERE. Measured on the canary: with the framing block
 * excised, camo and decoy-c hash identically while parent/minimal/decoy share a
 * different hash. That equality is what stops a tree-delta or chokepoint oracle
 * separating the pair.
 *
 * Callers supply `outsideRegionHash` per leg (a digest of the tree with the
 * audited region excised — the task's own hardening produces it). When it is
 * absent the check reports what it could not verify rather than passing
 * silently: an unverifiable pairing is not a verified one.
 *
 * The minimal/decoy direction is unchanged and still file-granular, because a
 * patch that fails to apply leaves the parent in place and every downstream
 * number becomes the parent measured twice.
 *
 * @param {Array<{name: string, role: string, provenance: {fileHashes: object},
 *   outsideRegionHash?: string}>} legs
 * @param {string[]} auditScope paths the agent is pointed at
 */
export function verifyLegFingerprints(legs, auditScope) {
  const problems = [];
  const unverified = [];
  const parent = (legs ?? []).find((leg) => leg.role === "parent");
  if (!parent) {
    return { ok: false, problems: ["no parent leg to compare against"], unverified };
  }

  const auditedOf = (leg) =>
    (auditScope ?? []).map((file) => `${file}=${leg.provenance?.fileHashes?.[file] ?? "missing"}`).join("|");
  const parentAudited = auditedOf(parent);

  for (const leg of legs ?? []) {
    if ((leg.role === "minimal" || leg.role === "decoy") && auditedOf(leg) === parentAudited) {
      problems.push(
        `leg "${leg.name}" (${leg.role}) has audited bytes identical to the parent — it is supposed ` +
          "to edit the audited region, so as built it is not exercising anything (a patch that " +
          "silently failed to apply looks exactly like this)"
      );
    }
  }

  // Pairwise: every flaw-CLOSED chokepoint leg needs a flaw-LIVE twin it is
  // indistinguishable from outside the audited region.
  const camos = (legs ?? []).filter((leg) => leg.role === "camo");
  const decoyCs = (legs ?? []).filter((leg) => leg.role === "decoy-c");
  for (const camo of camos) {
    if (camo.outsideRegionHash === undefined) {
      unverified.push(`leg "${camo.name}" (camo) has no outsideRegionHash; its pairing could not be verified`);
      continue;
    }
    const twins = decoyCs.filter((twin) => twin.outsideRegionHash === camo.outsideRegionHash);
    if (twins.length === 0) {
      const withHashes = decoyCs.filter((twin) => twin.outsideRegionHash !== undefined);
      if (withHashes.length === 0) {
        unverified.push(`leg "${camo.name}" (camo) has no decoy-c carrying an outsideRegionHash to compare against`);
        continue;
      }
      problems.push(
        `leg "${camo.name}" (camo) has no decoy-c that matches it outside the audited region — ` +
          "the pair is separable there, so a tree-delta or chokepoint oracle can tell them apart " +
          "and the pairing invariant is not actually in force"
      );
    }
  }

  return { ok: problems.length === 0, problems, unverified };
}
