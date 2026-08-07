import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ENFORCE_POSIX_MODES = process.platform !== "win32";

/**
 * Machine-local append-only telemetry, deliberately outside git: one line per
 * step event. This file is the raw feed a future retrospective loop reads.
 * State root honors CLAUDE_PLUGIN_DATA (the test-isolation convention shared
 * with the sibling plugins) and stays under goal-companion/, never inside the
 * codex/cursor state dirs.
 */
function stateRoot() {
  return path.join(process.env.CLAUDE_PLUGIN_DATA || os.tmpdir(), "goal-companion");
}

export function stateDir(cwd) {
  const resolved = path.resolve(cwd);
  const key = `${path.basename(resolved)}-${createHash("sha256").update(resolved).digest("hex").slice(0, 16)}`;
  return path.join(stateRoot(), key);
}

function ledgerFile(cwd) {
  return path.join(stateDir(cwd), "ledger.jsonl");
}

// Private-dir doctrine, built goal-locally (the chassis is mirrored, not
// shared — plugins may not import across plugins/*, so this is a from-scratch
// copy of the sibling behavior, not a shared module). Mirrors
// plugins/codex/scripts/lib/state.mjs's ensurePrivateDir. Hardened
// 2026-08-07: v1 shipped a plain recursive mkdirSync with default
// permissions (see CHANGELOG's Unreleased entry for the full list).
function ensurePrivateDir(dir, { create }) {
  let stat;
  try {
    stat = fs.lstatSync(dir);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
    if (!create) {
      return false;
    }
    fs.mkdirSync(dir, { mode: 0o700 });
    return true;
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`State path ${dir} is not a private directory; refusing to use it.`);
  }
  if (ENFORCE_POSIX_MODES) {
    if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
      throw new Error(`State path ${dir} is owned by another user; refusing to use it.`);
    }
    if ((stat.mode & 0o777) !== 0o700) {
      // Tighten a loose directory we own (e.g. one created by an older
      // version) instead of only protecting fresh installs.
      fs.chmodSync(dir, 0o700);
    }
  }
  return true;
}

// Build the tree from the root down, validating each level before creating
// the next. The root is created recursively (its parents — %TEMP% or the
// harness-provided plugin-data dir — are out of our threat model), then
// validated so a squatted or symlinked root is refused before anything is
// written beneath it. The leaf is created non-recursively so a pre-planted
// symlink (or file) at the leaf fails EEXIST/lstat-refusal rather than being
// followed or silently reused.
function ensureLedgerStateDir(cwd) {
  const root = stateRoot();
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  ensurePrivateDir(root, { create: false });
  const dir = stateDir(cwd);
  ensurePrivateDir(dir, { create: true });
  return dir;
}

export function appendLedger(cwd, entry) {
  ensureLedgerStateDir(cwd);
  const line = JSON.stringify({ at: new Date().toISOString(), ...entry });
  fs.appendFileSync(ledgerFile(cwd), `${line}\n`);
}

export function readLedger(cwd) {
  let raw;
  try {
    raw = fs.readFileSync(ledgerFile(cwd), "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { entries: [], corruptCount: 0 };
    }
    throw new Error(`Cannot read ${ledgerFile(cwd)}: ${error.message}`);
  }
  const entries = [];
  let corruptCount = 0;
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      corruptCount += 1; // skipped and counted, never silently absorbed
    }
  }
  return { entries, corruptCount };
}
