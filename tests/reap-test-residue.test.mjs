// The test-residue reaper: reports and (with clean) removes only directories
// whose basename matches a known test prefix, under a scan root, and NEVER
// touches a real per-workspace state dir. Runs against an isolated fake root
// so it can never see the real machine's temp tree.
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir } from "./helpers.mjs";
import { findTestResidue, reapTestResidue, TEST_DIR_PREFIXES } from "../scripts/reap-test-residue.mjs";

function seedRoot() {
  const root = makeTempDir("reap-fixture-root-");
  const mk = (parent, name) => {
    const dir = path.join(parent, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "state.json"), "{}");
    return dir;
  };
  // Test residue directly under the root and under both companion roots.
  mk(root, "codex-plugin-test-aaaaaa");
  mk(root, "cursor-plugin-runtime-state-bbbbbb");
  mk(root, "sync-chassis-test-cccccc");
  mk(root, "cxc-launcher-exit-dddddd");
  mk(path.join(root, "codex-companion"), "codex-plugin-test-eeeeee-0123456789abcdef");
  mk(path.join(root, "cursor-companion"), "cursor-plugin-test-ffffff-fedcba9876543210");
  // The real per-workspace state dirs — same parents, NO test prefix.
  const realCodex = mk(path.join(root, "codex-companion"), "codex-plugin-cf3d44fe0a8b121d");
  const realCursor = mk(root, "codex-plugin-realworkspace-0011223344556677");
  // An unrelated dir that merely shares a leading word.
  const bystander = mk(root, "codex-plugin-notatest");
  // A LIVE broker session dir shape: createBrokerSessionDir() uses a bare
  // cxc- prefix in production, so this must never be reaped.
  const liveBroker = mk(root, "cxc-9f3a1b");
  return { root, realCodex, realCursor, bystander, liveBroker };
}

test("the prefix allowlist matches no production directory shape", () => {
  // Real workspace state dirs (<slug>-<16hex>) and live broker session dirs
  // (bare cxc-<rand>) must all be outside the allowlist. A bare `cxc-` prefix
  // would delete an active broker's IPC dir, so it is explicitly forbidden.
  const productionNames = [
    "codex-plugin-cf3d44fe0a8b121d",
    "cursor-plugin-0011223344556677",
    "cxc-9f3a1b",
    "cxc-abc123def456"
  ];
  for (const name of productionNames) {
    assert.equal(TEST_DIR_PREFIXES.some((prefix) => name.startsWith(prefix)), false, name);
  }
});

test("findTestResidue lists only test-prefixed dirs and never the live broker dir", () => {
  const { root, realCodex, realCursor, bystander, liveBroker } = seedRoot();
  const found = findTestResidue(root).map((dir) => path.basename(dir)).sort();
  assert.deepEqual(found, [
    "codex-plugin-test-aaaaaa",
    "codex-plugin-test-eeeeee-0123456789abcdef",
    "cursor-plugin-runtime-state-bbbbbb",
    "cursor-plugin-test-ffffff-fedcba9876543210",
    "cxc-launcher-exit-dddddd",
    "sync-chassis-test-cccccc"
  ]);
  // Real, bystander, and the live broker session dir are all absent.
  for (const safe of [realCodex, realCursor, bystander, liveBroker]) {
    assert.equal(found.includes(path.basename(safe)), false);
  }
});

test("reap report is non-destructive; clean removes only residue and spares production dirs", () => {
  const { root, realCodex, realCursor, bystander, liveBroker } = seedRoot();

  const report = reapTestResidue(root, { clean: false });
  assert.equal(report.count, 6);
  assert.equal(report.removed, 0);
  // Nothing deleted on a report.
  assert.equal(fs.existsSync(path.join(root, "codex-plugin-test-aaaaaa")), true);

  const cleaned = reapTestResidue(root, { clean: true });
  assert.equal(cleaned.removed, 6);
  assert.equal(findTestResidue(root).length, 0);
  // Real state dirs, the bystander, and the live broker session dir survive.
  for (const safe of [realCodex, realCursor, bystander, liveBroker]) {
    assert.equal(fs.existsSync(safe), true, safe);
  }
});
