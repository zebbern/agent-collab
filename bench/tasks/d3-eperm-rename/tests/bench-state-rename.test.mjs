// Bench ground truth for D3 (eperm-rename). Strategy-agnostic on purpose: a
// retry-based fix hits fs.renameSync twice for the same destination (the
// second call, unpatched, succeeds); a copy-based fallback may never call
// fs.renameSync again for this destination at all. Both land the write. No
// call counting -- only that the write survives and no partial state.
//
// Archaeology (read at the parent, e906cb5): writeJsonFileAtomic's rename is
// a bare `fs.renameSync(temporaryFile, filePath)` with no retry. The first
// throw propagates straight out of updateState -> saveStateUnlocked with no
// recovery.
//
// The persistent-failure case (every renameSync call throws) is deliberately
// EXCLUDED from bench ground truth: at the parent that variant also throws
// loudly, which is indistinguishable from what a correct bounded-retry fix
// does once its budget is exhausted -- it would pass at both parent and fix,
// breaking the RED-at-parent gate. Only the transient (first-call-only)
// failure discriminates.
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir } from "./helpers.mjs";
import { loadState, resolveStateDir, updateState } from "../plugins/codex/scripts/lib/state.mjs";

process.env.CLAUDE_PLUGIN_DATA = makeTempDir("codex-plugin-bench-d3-");
for (const name of [
  "CODEX_COMPANION_SESSION_ID",
  "CURSOR_COMPANION_SESSION_ID",
  "CODEX_COMPANION_TRANSCRIPT_PATH",
  "CURSOR_COMPANION_TRANSCRIPT_PATH"
]) {
  delete process.env[name];
}

test("a transient rename failure on state.json is survived and the write lands", (t) => {
  const workspace = makeTempDir("codex-plugin-bench-d3-ws-");
  updateState(workspace, (state) => {
    state.config.counter = 1;
  });

  const originalRenameSync = fs.renameSync;
  let thrown = false;
  fs.renameSync = (from, to) => {
    if (!thrown && String(to).endsWith("state.json")) {
      thrown = true;
      throw Object.assign(new Error("EPERM: operation not permitted, rename"), { code: "EPERM" });
    }
    return originalRenameSync(from, to);
  };
  t.after(() => {
    fs.renameSync = originalRenameSync;
  });

  // RED at the parent: this throws EPERM straight out of updateState (no
  // retry exists), so the test never reaches the assertions below. GREEN at
  // the fix: a bounded retry (or an equivalent strategy) survives the first
  // throw and the write lands.
  updateState(workspace, (state) => {
    state.config.counter = 2;
  });

  assert.equal(loadState(workspace).config.counter, 2);

  const residue = fs.readdirSync(resolveStateDir(workspace)).filter((entry) => entry.endsWith(".tmp"));
  assert.deepEqual(residue, []);
});
