// Drift guard for the shared job chassis. The codex and cursor plugins carry
// near-identical copies of these lib modules (plugin directories must be
// self-contained, so they cannot share imports). Fixes to the chassis must be
// mirrored into BOTH copies — this test makes forgetting that a red build.
//
// Mechanism: for each module, take the diff between the two copies and hash
// only its +/- payload lines. A change mirrored identically into both copies
// leaves the payload untouched; a one-sided change alters it and fails here.
//
// When this fails:
//   1. If you changed one plugin's copy, mirror the change into the other.
//   2. If the divergence is intentional (provider-specific behavior), rerun
//      the digest and update PINNED_DIVERGENCE below in the same commit —
//      that keeps every intentional delta a visible, reviewed decision:
//      node --test --test-name-pattern="chassis" tests/chassis-drift.test.mjs
//      prints the actual digests on failure.
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// module → sha256(diff payload) prefix. "e3b0c44298fc1c14" is the empty-diff
// digest: those copies are byte-identical and should stay that way.
const PINNED_DIVERGENCE = new Map([
  ["args.mjs", "e3b0c44298fc1c14"],
  ["fs.mjs", "1edeb160e32f4964"],
  ["prompts.mjs", "e3b0c44298fc1c14"],
  ["workspace.mjs", "e3b0c44298fc1c14"],
  ["process.mjs", "e3b0c44298fc1c14"],
  ["git.mjs", "e3b0c44298fc1c14"],
  ["doctor.mjs", "e3b0c44298fc1c14"],
  ["state.mjs", "225822284a336ad7"],
  ["job-control.mjs", "ec57029b7211f664"],
  ["tracked-jobs.mjs", "c6ac2381ef6cc767"],
  ["render.mjs", "3245b0d4f89dbb64"]
]);

function divergenceDigest(module) {
  const codexPath = path.join(ROOT, "plugins", "codex", "scripts", "lib", module);
  const cursorPath = path.join(ROOT, "plugins", "cursor", "scripts", "lib", module);
  const result = spawnSync("git", ["diff", "--no-index", "--unified=0", codexPath, cursorPath], {
    encoding: "utf8"
  });
  // git diff --no-index exits 1 when the files differ; only a missing git or
  // an unreadable file is a real error.
  assert.equal(result.error ?? null, null);
  const payload = (result.stdout ?? "")
    .split("\n")
    .filter((line) => (line.startsWith("+") || line.startsWith("-")) && !line.startsWith("+++") && !line.startsWith("---"))
    .join("\n");
  return createHash("sha256").update(payload).digest("hex").slice(0, 16);
}

// Provider-specific modules that intentionally exist in only one plugin.
// Anything else found in a lib directory must exist in BOTH plugins and be
// pinned above — otherwise a new chassis module (or a one-sided addition)
// would silently escape the drift guard.
const PROVIDER_ONLY = {
  codex: new Set([
    "app-server-protocol.d.ts",
    "app-server.mjs",
    "broker-endpoint.mjs",
    "broker-lifecycle.mjs",
    "broker-ownership.mjs",
    "claude-session-transfer.mjs",
    "codex.mjs"
  ]),
  cursor: new Set(["cursor.mjs"])
};

test("every lib module is either provider-only or a pinned chassis pair", () => {
  const problems = [];
  const seen = { codex: new Set(), cursor: new Set() };
  for (const plugin of ["codex", "cursor"]) {
    for (const entry of fs.readdirSync(path.join(ROOT, "plugins", plugin, "scripts", "lib"))) {
      seen[plugin].add(entry);
    }
  }
  for (const plugin of ["codex", "cursor"]) {
    const other = plugin === "codex" ? "cursor" : "codex";
    for (const entry of seen[plugin]) {
      if (PROVIDER_ONLY[plugin].has(entry)) {
        if (seen[other].has(entry)) {
          problems.push(`lib/${entry} is marked provider-only for ${plugin} but also exists in ${other}`);
        }
        continue;
      }
      if (!seen[other].has(entry)) {
        problems.push(`lib/${entry} exists only in plugins/${plugin} — add it to the other plugin, or to PROVIDER_ONLY if intentional`);
        continue;
      }
      if (!PINNED_DIVERGENCE.has(entry)) {
        problems.push(`lib/${entry} is shared but has no pin — add it to PINNED_DIVERGENCE`);
      }
    }
  }
  for (const module of PINNED_DIVERGENCE.keys()) {
    for (const plugin of ["codex", "cursor"]) {
      if (!seen[plugin].has(module)) {
        problems.push(`pinned lib/${module} is missing from plugins/${plugin}`);
      }
    }
  }
  assert.deepEqual(problems, []);
});

test("chassis copies have not drifted beyond their pinned divergence", () => {
  const drifted = [];
  for (const [module, pinned] of PINNED_DIVERGENCE) {
    const actual = divergenceDigest(module);
    if (actual !== pinned) {
      drifted.push(`  lib/${module}: pinned ${pinned}, actual ${actual}`);
    }
  }
  assert.equal(
    drifted.length,
    0,
    `Chassis drift between plugins/codex and plugins/cursor:\n${drifted.join("\n")}\n` +
      "Mirror the change into the other plugin, or update PINNED_DIVERGENCE in this file if the divergence is intentional."
  );
});
