#!/usr/bin/env node
// Reports (and with --clean, removes) the temp-directory residue this repo's
// test suite leaves behind. Every test run mints scratch workspaces and state
// dirs via makeTempDir; graceful runs now self-clean, but hard-killed runs
// (SIGKILL, the app closing mid-suite) leak them, and thousands can pile up.
//
// Scope is airtight by construction: only directories whose basename starts
// with a KNOWN test prefix, under the two temp roots this repo uses, are ever
// touched. The real per-workspace state dir (e.g. codex-plugin-<hash>, with no
// -test-/-runtime-state- segment) does not match any prefix, so it can never
// be reaped — and this tool never touches processes or anything outside temp.
//
// Usage:
//   node scripts/reap-test-residue.mjs            # report only (default)
//   node scripts/reap-test-residue.mjs --clean    # delete the residue
//   node scripts/reap-test-residue.mjs --root DIR # scan DIR instead of os.tmpdir()
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

// Test-only directory prefixes from tests/helpers.mjs and
// tests/runtime-helpers.mjs. Keep in sync if a new test prefix is added, and
// NEVER add a prefix that production also uses. In particular a bare `cxc-` is
// forbidden: createBrokerSessionDir() mints LIVE broker session dirs as
// os.tmpdir()/cxc-XXXXXX (socket, pid, log), so reaping that prefix would
// delete an active broker's IPC dir and strand it. The test broker helpers'
// own dirs (also cxc-*) are cleaned by broker teardown, not by this tool.
export const TEST_DIR_PREFIXES = [
  "codex-plugin-test-",
  "cursor-plugin-test-",
  "codex-plugin-runtime-state-",
  "cursor-plugin-runtime-state-",
  "sync-chassis-test-",
  "cxc-launcher-exit-",
  "goal-plugin-test-"
];

function isTestResidue(name) {
  return TEST_DIR_PREFIXES.some((prefix) => name.startsWith(prefix));
}

function dirSizeBytes(dir) {
  let total = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else {
        try {
          total += fs.statSync(full).size;
        } catch {
          // Vanished mid-scan; ignore.
        }
      }
    }
  }
  return total;
}

// Scans a single root's immediate children for test-residue directories.
function collectResidue(root) {
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const found = [];
  for (const entry of entries) {
    if ((entry.isDirectory() || entry.isSymbolicLink()) && isTestResidue(entry.name)) {
      found.push(path.join(root, entry.name));
    }
  }
  return found;
}

export function findTestResidue(root) {
  // The two places residue lands: makeTempDir workspaces/plugin-data dirs sit
  // directly under temp; fallback state dirs sit under the companion roots.
  const roots = [root, path.join(root, "codex-companion"), path.join(root, "cursor-companion")];
  return roots.flatMap((dir) => collectResidue(dir));
}

export function reapTestResidue(root, { clean } = {}) {
  const residue = findTestResidue(root);
  let bytes = 0;
  let removed = 0;
  const failures = [];
  for (const dir of residue) {
    bytes += dirSizeBytes(dir);
    if (clean) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
        removed += 1;
      } catch (error) {
        failures.push({ dir, error: error instanceof Error ? error.message : String(error) });
      }
    }
  }
  return { count: residue.length, bytes, removed, failures };
}

function parseArgs(argv) {
  const clean = argv.includes("--clean");
  const rootIndex = argv.indexOf("--root");
  const root = rootIndex === -1 ? os.tmpdir() : argv[rootIndex + 1];
  return { clean, root };
}

// Only run as a CLI, not when imported by the test.
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const { clean, root } = parseArgs(process.argv.slice(2));
  const result = reapTestResidue(root, { clean });
  const mb = (result.bytes / (1024 * 1024)).toFixed(1);
  if (result.count === 0) {
    console.log(`No test residue under ${root}.`);
  } else if (clean) {
    console.log(`Reaped ${result.removed}/${result.count} test residue dir(s), ~${mb}MB reclaimed, under ${root}.`);
    for (const failure of result.failures) {
      console.log(`  kept (in use?): ${failure.dir} — ${failure.error}`);
    }
  } else {
    console.log(`${result.count} test residue dir(s), ~${mb}MB, under ${root}. Re-run with --clean to remove.`);
  }
  process.exit(0);
}
