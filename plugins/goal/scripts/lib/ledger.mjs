import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Machine-local append-only telemetry, deliberately outside git: one line per
 * step event. This file is the raw feed a future retrospective loop reads.
 * State root honors CLAUDE_PLUGIN_DATA (the test-isolation convention shared
 * with the sibling plugins) and stays under goal-companion/, never inside the
 * codex/cursor state dirs.
 */
// v1 creates this with default permissions (attended, machine-local telemetry).
// If goal notes ever carry sensitive content, mirror the sibling plugins'
// ensurePrivateDir doctrine (0o700, symlink refusal) — see
// plugins/codex/scripts/lib/state.mjs.
export function stateDir(cwd) {
  const root = process.env.CLAUDE_PLUGIN_DATA || os.tmpdir();
  const resolved = path.resolve(cwd);
  const key = `${path.basename(resolved)}-${createHash("sha256").update(resolved).digest("hex").slice(0, 16)}`;
  return path.join(root, "goal-companion", key);
}

function ledgerFile(cwd) {
  return path.join(stateDir(cwd), "ledger.jsonl");
}

export function appendLedger(cwd, entry) {
  fs.mkdirSync(stateDir(cwd), { recursive: true });
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
