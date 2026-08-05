// The sync-chassis author tool: on an already-mirrored tree it is a no-op,
// a one-sided chassis edit is propagated with the plugin-name literals
// swapped, and genuinely-divergent modules are never touched. Runs against a
// temp copy of the repo — the tool mutates trees, so the test must never
// point it at the real working tree.
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { makeTempDir, run } from "./helpers.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function makeRepoCopy() {
  const copy = makeTempDir("sync-chassis-test-");
  for (const dir of ["plugins", "scripts", "tests"]) {
    fs.cpSync(path.join(ROOT, dir), path.join(copy, dir), { recursive: true });
  }
  return copy;
}

function readLib(repo, plugin, module) {
  return fs.readFileSync(path.join(repo, "plugins", plugin, "scripts", "lib", module), "utf8");
}

test("sync-chassis is a no-op on an already-mirrored tree and passes the drift guard", () => {
  const repo = makeRepoCopy();
  const before = readLib(repo, "cursor", "state.mjs");

  const result = run(process.execPath, [path.join(repo, "scripts", "sync-chassis.mjs")], { cwd: repo });

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /in-sync\s+lib\/process\.mjs/);
  assert.doesNotMatch(result.stdout, /SYNCED/);
  assert.equal(readLib(repo, "cursor", "state.mjs"), before);
});

test("sync-chassis propagates a one-sided edit, preserves the swapped literal, stays drift-green", () => {
  const repo = makeRepoCopy();
  const statePath = path.join(repo, "plugins", "codex", "scripts", "lib", "state.mjs");
  // A neutral edit (no plugin literal) added to only the codex copy. It must
  // land verbatim in cursor, and the pre-existing FALLBACK literal must remain
  // the cursor value — proving the tool swaps the existing literal rather than
  // blind-copying codex's. Because the new line carries no literal, the
  // divergence payload is unchanged and the drift guard stays green.
  fs.writeFileSync(
    statePath,
    fs.readFileSync(statePath, "utf8").replace(
      "const STATE_VERSION = 1;",
      "const STATE_VERSION = 1;\nconst SYNC_TEST_MARKER = 42;"
    )
  );

  const result = run(process.execPath, [path.join(repo, "scripts", "sync-chassis.mjs")], { cwd: repo });

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /SYNCED\s+lib\/state\.mjs/);
  const mirrored = readLib(repo, "cursor", "state.mjs");
  assert.match(mirrored, /const SYNC_TEST_MARKER = 42;/);
  assert.match(mirrored, /"cursor-companion"/);
  assert.doesNotMatch(mirrored, /"codex-companion"/);
});

test("sync-chassis refuses to blind-copy the genuinely divergent modules", () => {
  const repo = makeRepoCopy();
  const renderBefore = readLib(repo, "cursor", "render.mjs");
  const renderPath = path.join(repo, "plugins", "codex", "scripts", "lib", "render.mjs");
  fs.writeFileSync(renderPath, `${fs.readFileSync(renderPath, "utf8")}\n// one-sided render edit\n`);

  const result = run(process.execPath, [path.join(repo, "scripts", "sync-chassis.mjs")], { cwd: repo });

  // The tool leaves render.mjs alone (MANUAL) and the drift guard it runs at
  // the end correctly fails the tree, so the one-sided edit cannot slip by.
  assert.match(result.stdout, /MANUAL\s+lib\/render\.mjs/);
  assert.equal(readLib(repo, "cursor", "render.mjs"), renderBefore);
  assert.notEqual(result.status, 0);
});
