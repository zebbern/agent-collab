import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ENFORCE_POSIX_MODES = process.platform !== "win32";

/**
 * Machine-local append-only telemetry, deliberately outside git: one line per
 * step event. This file is the raw feed the retrospective loop reads.
 *
 * State root doctrine (2026-08-07): ONE canonical root per user, independent
 * of the invocation context. The v1 root honored ambient CLAUDE_PLUGIN_DATA,
 * but installed sessions export whichever plugin's data dir last set it
 * (codex-inline one Bash call, unset the next), so a single project's history
 * silently split across roots and the retro's evidence fragmented per
 * invocation context. CLAUDE_PLUGIN_DATA is therefore never consulted for
 * root selection — it survives only as a migration SOURCE below. The
 * GOAL_COMPANION_STATE_ROOT override is goal-specific (no harness sets it
 * ambiently) and exists for test isolation.
 */
const STATE_ROOT_ENV = "GOAL_COMPANION_STATE_ROOT";

function stateRoot() {
  return process.env[STATE_ROOT_ENV] || path.join(os.homedir(), ".claude", "goal-companion");
}

function projectKey(cwd) {
  const resolved = path.resolve(cwd);
  return `${path.basename(resolved)}-${createHash("sha256").update(resolved).digest("hex").slice(0, 16)}`;
}

export function stateDir(cwd) {
  return path.join(stateRoot(), projectKey(cwd));
}

function ledgerFile(cwd) {
  return path.join(stateDir(cwd), "ledger.jsonl");
}

// Windows paths compare case-insensitively; a candidate that IS the canonical
// file must never be treated as a migration source (it would import into
// itself and duplicate every line).
function samePath(a, b) {
  const left = path.resolve(a);
  const right = path.resolve(b);
  return process.platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

// Roots older versions (or the ambient-env bug) wrote under, per project:
// whatever plugin data dir the current environment carries, every
// per-install plugin-data dir under the harness config dir (the ambient var
// only names the LAST exporter — any install may hold a shard, and the codex
// hook no longer exports the var at all), and the pre-install fallback
// (tmpdir). Only existing files are returned, deduplicated.
function legacyLedgerFiles(cwd) {
  const key = projectKey(cwd);
  const canonical = ledgerFile(cwd);
  const bases = [];
  if (process.env.CLAUDE_PLUGIN_DATA) {
    bases.push(process.env.CLAUDE_PLUGIN_DATA);
  }
  const pluginsData = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"), "plugins", "data");
  try {
    for (const entry of fs.readdirSync(pluginsData)) {
      bases.push(path.join(pluginsData, entry));
    }
  } catch {
    // No harness plugin-data dir on this machine.
  }
  bases.push(os.tmpdir());
  const files = [];
  for (const base of bases) {
    const file = path.join(base, "goal-companion", key, "ledger.jsonl");
    if (samePath(file, canonical)) continue;
    if (files.some((seen) => samePath(seen, file))) continue;
    if (fs.existsSync(file)) files.push(file);
  }
  return files;
}

// Heal a root split: fold every legacy ledger for this project into the
// canonical file, ordered by timestamp, and leave a `.migrated` marker where
// each source was so nothing is imported twice. Corrupt lines travel with
// their file neighbors (they inherit the last parseable `at` seen before
// them) — consolidation preserves them for readLedger's corrupt-line count,
// never silently drops them.
function consolidateLedger(cwd) {
  const sources = legacyLedgerFiles(cwd);
  if (sources.length === 0) return;
  const target = ledgerFile(cwd);
  const tagged = [];
  const collect = (file) => {
    let raw;
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    let lastAt = "";
    for (const line of raw.split("\n")) {
      if (line.trim() === "") continue;
      let at = lastAt;
      try {
        const parsed = JSON.parse(line);
        if (typeof parsed?.at === "string") at = parsed.at;
      } catch {
        // corrupt line: keep lastAt so it stays beside its neighbors
      }
      lastAt = at;
      tagged.push({ at, line });
    }
  };
  collect(target);
  for (const file of sources) collect(file);
  // ISO-8601 UTC timestamps order lexicographically; the sort is stable, so
  // ties keep their collection order (canonical first, then sources).
  tagged.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  const dir = ensureLedgerStateDir(cwd);
  const tmp = path.join(dir, "ledger.jsonl.consolidating");
  fs.writeFileSync(tmp, tagged.map((entry) => `${entry.line}\n`).join(""));
  fs.renameSync(tmp, target);
  for (const file of sources) {
    try {
      fs.renameSync(file, `${file}.migrated`);
    } catch {
      // A stale .migrated marker blocks the rename (Windows refuses to
      // clobber); the content is already merged, so the source must not
      // survive to be imported again.
      fs.unlinkSync(file);
    }
  }
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
  consolidateLedger(cwd);
  ensureLedgerStateDir(cwd);
  const line = JSON.stringify({ at: new Date().toISOString(), ...entry });
  fs.appendFileSync(ledgerFile(cwd), `${line}\n`);
}

export function readLedger(cwd) {
  // Consolidation on the read path too: "read-only" commands (status, ledger,
  // the retro) are exactly where a fragmented history lies, so they must see
  // the healed ledger, not a per-context shard. A project with no legacy
  // residue still creates nothing here.
  consolidateLedger(cwd);
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
