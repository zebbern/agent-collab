import test from "node:test";
import assert from "node:assert/strict";

import { cleanCodexStderr } from "../plugins/codex/scripts/lib/codex.mjs";

function skillLoadLine(index) {
  return [
    `\u001b[2m2026-08-05T02:06:${String(index % 60).padStart(2, "0")}.540941Z\u001b[0m`,
    "\u001b[31mERROR\u001b[0m",
    `codex_core::codex: failed to load skill C:\\Users\\zeb\\.codex\\plugins\\cache\\pack-${index}\\SKILL.md: invalid name: exceeds maximum length of 64 characters`
  ].join(" ");
}

test("cleanCodexStderr collapses a repeated skill-load flood to the first line plus a summary", () => {
  const lines = [];
  for (let index = 0; index < 200; index += 1) {
    lines.push(skillLoadLine(index));
  }
  const cleaned = cleanCodexStderr(lines.join("\n"));
  const cleanedLines = cleaned.split("\n");

  assert.equal(cleanedLines.length, 2);
  assert.equal(cleanedLines[0], skillLoadLine(0));
  assert.equal(cleanedLines[1], "... (199 similar lines suppressed)");
  assert.equal(cleaned.includes("pack-1\\"), false);
});

test("cleanCodexStderr keeps distinct error shapes intact around a collapsed run", () => {
  const flood = [];
  for (let index = 0; index < 5; index += 1) {
    flood.push(skillLoadLine(index));
  }
  const connectError = "ERROR codex_core::client: failed to connect to model backend: connection refused";
  const authError = "ERROR codex_core::auth: token refresh failed: expired credentials";
  const cleaned = cleanCodexStderr([connectError, ...flood, authError].join("\n"));
  const cleanedLines = cleaned.split("\n");

  assert.deepEqual(cleanedLines, [
    connectError,
    skillLoadLine(0),
    "... (4 similar lines suppressed)",
    authError
  ]);
});

test("cleanCodexStderr passes small varied stderr through unchanged", () => {
  const stderr = [
    "ERROR codex_core::codex: failed to load skill C:\\Users\\zeb\\.codex\\plugins\\cache\\pack-0\\SKILL.md: invalid name: exceeds maximum length of 64 characters",
    "WARN codex_core::config: profile missing, falling back to defaults",
    "ERROR codex_core::client: failed to connect to model backend: connection refused"
  ].join("\n");

  assert.equal(cleanCodexStderr(stderr), stderr);
});

test("cleanCodexStderr still drops blank lines and PATH update warnings", () => {
  const stderr = [
    "",
    "WARNING: proceeding, even though we could not update PATH: permission denied",
    "ERROR codex_core::client: failed to connect to model backend: connection refused",
    ""
  ].join("\n");

  assert.equal(cleanCodexStderr(stderr), "ERROR codex_core::client: failed to connect to model backend: connection refused");
});

test("cleanCodexStderr truncates the middle when cleaned stderr exceeds the size cap", () => {
  const lines = [];
  for (let index = 0; index < 2000; index += 1) {
    lines.push(`ERROR codex_core::codex: distinct failure number ${index} with detail code ${index * 7}`);
  }
  const cleaned = cleanCodexStderr(lines.join("\n"));
  const cleanedLines = cleaned.split("\n");

  assert.equal(Buffer.byteLength(cleaned, "utf8") <= 33 * 1024, true);
  assert.equal(cleanedLines[0], lines[0]);
  assert.equal(cleanedLines[cleanedLines.length - 1], lines[lines.length - 1]);
  const marker = cleanedLines.find((line) => /^\.\.\. \(\d+ bytes omitted\) \.\.\.$/.test(line));
  assert.ok(marker, "expected a bytes-omitted marker line");
});
