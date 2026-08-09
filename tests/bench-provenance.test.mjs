// Provenance: proving which tree a measurement ran against, and that each leg
// is structurally the thing it claims to be. Both checks exist because both
// failures happened during task hardening and neither announced itself.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import {
  assertProvenance,
  captureProvenance,
  compareProvenance,
  sha256File,
  verifyLegFingerprints
} from "../bench/lib/provenance.mjs";

function tempRepo(t, { withGit = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bench-provenance-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, "audited.js"), "const guard = a && !b;\n");
  fs.writeFileSync(path.join(dir, "other.js"), "// unrelated\n");
  if (withGit) {
    const git = (args) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
    git(["init", "-q"]);
    git(["config", "user.email", "bench@example.invalid"]);
    git(["config", "user.name", "Bench"]);
    git(["config", "commit.gpgsign", "false"]);
    git(["add", "-A"]);
    git(["commit", "-qm", "parent"]);
  }
  return dir;
}

test("captureProvenance records the commit and the exact bytes of watched files", (t) => {
  const dir = tempRepo(t);
  const capture = captureProvenance(dir, ["audited.js"]);

  assert.match(capture.headSha, /^[0-9a-f]{40}$/);
  assert.equal(capture.dirty, false);
  assert.equal(capture.fileHashes["audited.js"], sha256File(path.join(dir, "audited.js")));
});

test("a tree with no git history still has an identity — its file hashes", (t) => {
  // Several corpus tasks squash or strip history so the fix is not reachable
  // from the shipped tree. That must not make provenance unavailable.
  const dir = tempRepo(t, { withGit: false });
  const capture = captureProvenance(dir, ["audited.js"]);

  assert.equal(capture.headSha, null);
  assert.match(capture.fileHashes["audited.js"], /^[0-9a-f]{64}$/);
});

test("a watched file that does not exist hashes as null rather than throwing", (t) => {
  const dir = tempRepo(t);
  const capture = captureProvenance(dir, ["audited.js", "absent.js"]);
  assert.equal(capture.fileHashes["absent.js"], null);
});

test("compareProvenance reports every mismatch, not just the first", (t) => {
  const dir = tempRepo(t);
  const expected = captureProvenance(dir, ["audited.js", "other.js"]);

  fs.writeFileSync(path.join(dir, "audited.js"), "const guard = a;\n");
  fs.writeFileSync(path.join(dir, "other.js"), "// changed\n");
  const actual = captureProvenance(dir, ["audited.js", "other.js"]);

  const result = compareProvenance(actual, expected);
  assert.equal(result.ok, false);
  assert.equal(result.mismatches.length, 2);
  assert.ok(result.mismatches.some((m) => m.startsWith("audited.js is")));
  assert.ok(result.mismatches.some((m) => m.startsWith("other.js is")));
});

test("the aborted-checkout failure is caught: same bytes, wrong commit", (t) => {
  // The exact silent failure this module exists for — a scout measured the
  // parent while believing it was on the fix, because a checkout aborted.
  const dir = tempRepo(t);
  const expected = { ...captureProvenance(dir, ["audited.js"]), headSha: "0".repeat(40) };
  const actual = captureProvenance(dir, ["audited.js"]);

  const result = compareProvenance(actual, expected);
  assert.equal(result.ok, false);
  assert.match(result.mismatches[0], /^HEAD is [0-9a-f]{40}, expected 0{40}$/);
});

test("assertProvenance names the leg, because an anonymous drift report is useless", (t) => {
  const dir = tempRepo(t);
  const expected = { ...captureProvenance(dir, ["audited.js"]), headSha: "0".repeat(40) };
  const actual = captureProvenance(dir, ["audited.js"]);

  assert.throws(() => assertProvenance(actual, expected, "camo"), /leg "camo"/);
  assert.throws(() => assertProvenance(actual, expected, "camo"), /refusing to score a run/);
  assert.equal(assertProvenance(actual, actual, "camo"), true);
});

// --- the structural check ---------------------------------------------------

const AUDIT_SCOPE = ["audited.js"];

function leg(name, role, auditedHash) {
  return { name, role, provenance: { fileHashes: { "audited.js": auditedHash } } };
}

test("a well-formed leg set passes: fix-shaped legs edit the audited region, chokepoint legs do not", () => {
  const result = verifyLegFingerprints(
    [
      leg("parent", "parent", "aaa"),
      leg("minimal", "minimal", "bbb"),
      leg("decoy", "decoy", "ccc"),
      leg("camo", "camo", "aaa"),
      leg("decoy-c", "decoy-c", "aaa")
    ],
    AUDIT_SCOPE
  );
  assert.deepEqual(result, { ok: true, problems: [] });
});

test("a camo that touches the audited region is refused — it silently removes its own pair", () => {
  const result = verifyLegFingerprints(
    [
      leg("parent", "parent", "aaa"),
      leg("minimal", "minimal", "bbb"),
      leg("decoy", "decoy", "ccc"),
      leg("camo", "camo", "ddd"),
      leg("decoy-c", "decoy-c", "aaa")
    ],
    AUDIT_SCOPE
  );
  assert.equal(result.ok, false);
  assert.match(result.problems[0], /leg "camo" \(camo\) must leave the audited region byte-identical/);
  assert.match(result.problems[0], /removes the pair/);
});

test("a decoy-c that touches the audited region is refused for the same reason", () => {
  const result = verifyLegFingerprints(
    [leg("parent", "parent", "aaa"), leg("minimal", "minimal", "bbb"), leg("decoy-c", "decoy-c", "zzz")],
    AUDIT_SCOPE
  );
  assert.equal(result.ok, false);
  assert.match(result.problems[0], /leg "decoy-c"/);
});

test("a minimal or decoy leg that does NOT edit the audited region is refused", () => {
  // A patch that silently failed to apply produces exactly this shape, and
  // every downstream number would then be measured against the parent twice.
  const result = verifyLegFingerprints(
    [leg("parent", "parent", "aaa"), leg("minimal", "minimal", "aaa"), leg("decoy", "decoy", "aaa")],
    AUDIT_SCOPE
  );
  assert.equal(result.ok, false);
  assert.equal(result.problems.length, 2);
  assert.ok(result.problems.every((p) => /not exercising anything/.test(p)));
});

test("a leg set with no parent cannot be verified and says so", () => {
  const result = verifyLegFingerprints([leg("minimal", "minimal", "bbb")], AUDIT_SCOPE);
  assert.equal(result.ok, false);
  assert.match(result.problems[0], /no parent leg/);
});
