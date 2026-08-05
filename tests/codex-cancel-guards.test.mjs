// Unit tests for the codex plugin's win32 cancel-ownership guards, mirroring
// tests/cursor-cancel-guards.test.mjs: the kill path must prove
// (pid, start time) identity before taskkill and refuse blind kills when
// ownership capture failed.
import test from "node:test";
import assert from "node:assert/strict";

import {
  getWindowsProcessIdentity,
  isWindowsProcessIdentity,
  terminateProcessTree
} from "../plugins/codex/scripts/lib/process.mjs";

function commandRecorder(responses) {
  const calls = [];
  const runCommandImpl = (command, args) => {
    calls.push([command, ...args]);
    const key = `${command} ${args.join(" ")}`;
    const match = responses.find((entry) => entry.match(key));
    return match ? match.result : { command, args, status: 0, signal: null, stdout: "", stderr: "", error: null };
  };
  return { calls, runCommandImpl };
}

const ok = (stdout) => ({ status: 0, signal: null, stdout, stderr: "", error: null });
const fail = () => ({ status: 1, signal: null, stdout: "", stderr: "no such process", error: null });

test("getWindowsProcessIdentity builds a pid@win32 identity from CIM output", () => {
  const { calls, runCommandImpl } = commandRecorder([
    { match: (key) => key.startsWith("powershell"), result: ok("133702000000000000\n") }
  ]);
  assert.equal(getWindowsProcessIdentity(4242, { runCommandImpl }), "4242@win32:133702000000000000");
  // The probe must never be able to block on console input: a hung probe
  // burns the retry budget and turns into an "unavailable" refusal on the
  // cancel path.
  assert.deepEqual(calls[0].slice(0, 3), ["powershell", "-NoProfile", "-NonInteractive"]);
  assert.equal(isWindowsProcessIdentity("4242@win32:133702000000000000"), true);
  assert.equal(isWindowsProcessIdentity("4242@Mon Jul 27 00:00:00 2026"), false);

  const gone = commandRecorder([{ match: (key) => key.startsWith("powershell"), result: fail() }]);
  assert.equal(getWindowsProcessIdentity(4242, { runCommandImpl: gone.runCommandImpl }), null);
});

test("win32 terminateProcessTree refuses a blind kill when ownership capture failed", async () => {
  const { calls, runCommandImpl } = commandRecorder([]);
  const outcome = await terminateProcessTree(4242, {
    platform: "win32",
    runCommandImpl,
    requireVerifiedOwnership: true,
    expectedRootIdentity: null
  });
  assert.equal(outcome.verified, false);
  assert.equal(outcome.attempted, false);
  assert.equal(calls.some((call) => call[0] === "taskkill"), false);
});

test("win32 terminateProcessTree never kills a reused PID", async () => {
  const { calls, runCommandImpl } = commandRecorder([
    { match: (key) => key.startsWith("powershell"), result: ok("999999\n") }
  ]);
  const outcome = await terminateProcessTree(4242, {
    platform: "win32",
    runCommandImpl,
    expectedRootIdentity: "4242@win32:111111"
  });
  assert.equal(outcome.verified, true);
  assert.equal(outcome.attempted, false);
  assert.equal(outcome.method, "identity-check");
  assert.equal(calls.some((call) => call[0] === "taskkill"), false);
});

test("win32 terminateProcessTree kills only after the identity matches", async () => {
  const { calls, runCommandImpl } = commandRecorder([
    { match: (key) => key.startsWith("powershell"), result: ok("111111\n") },
    { match: (key) => key.startsWith("taskkill"), result: ok("SUCCESS") },
    { match: (key) => key.startsWith("tasklist"), result: ok("INFO: No tasks are running which match the specified criteria.") }
  ]);
  const outcome = await terminateProcessTree(4242, {
    platform: "win32",
    runCommandImpl,
    expectedRootIdentity: "4242@win32:111111"
  });
  assert.equal(outcome.verified, true);
  assert.equal(calls.some((call) => call[0] === "taskkill"), true);
});

test("win32 terminateProcessTree fails closed when the identity probe is unavailable", async () => {
  const { calls, runCommandImpl } = commandRecorder([
    { match: (key) => key.startsWith("powershell"), result: fail() }
  ]);
  const outcome = await terminateProcessTree(4242, {
    platform: "win32",
    runCommandImpl,
    expectedRootIdentity: "4242@win32:111111"
  });
  assert.equal(outcome.verified, false);
  assert.equal(outcome.degraded, true);
  assert.equal(calls.some((call) => call[0] === "taskkill"), false);
});

test("win32 terminateProcessTree treats confirmed absence as a safe cancel", async () => {
  const { calls, runCommandImpl } = commandRecorder([
    { match: (key) => key.startsWith("powershell"), result: ok("ABSENT\n") }
  ]);
  const outcome = await terminateProcessTree(4242, {
    platform: "win32",
    runCommandImpl,
    expectedRootIdentity: "4242@win32:111111"
  });
  assert.equal(outcome.verified, true);
  assert.equal(outcome.method, "identity-check");
  assert.equal(calls.some((call) => call[0] === "taskkill"), false);
});

test("win32 terminateProcessTree never taskkills a bare PID without ownership proof", async () => {
  const { calls, runCommandImpl } = commandRecorder([]);
  const outcome = await terminateProcessTree(4242, {
    platform: "win32",
    runCommandImpl
  });
  assert.equal(outcome.verified, false);
  assert.equal(outcome.degraded, true);
  assert.equal(calls.some((call) => call[0] === "taskkill"), false);
});

test("matchesWindowsIdentity tolerates approximate self-identities within 5s", async () => {
  const { matchesWindowsIdentity, getOwnWindowsProcessIdentity } = await import("../plugins/codex/scripts/lib/process.mjs");
  assert.equal(matchesWindowsIdentity("42@win32:1000000000", "42@win32:1000000000"), true);
  assert.equal(matchesWindowsIdentity("42@win32:1000000000", "42@win32:1000000001"), false);
  // approx vs exact within tolerance (2s = 20_000_000 hundred-ns units)
  assert.equal(matchesWindowsIdentity("42@win32:~1000000000", "42@win32:1020000000"), true);
  // approx vs exact beyond tolerance (6s)
  assert.equal(matchesWindowsIdentity("42@win32:~1000000000", "42@win32:1060000000"), false);
  assert.equal(matchesWindowsIdentity("42@win32:~1000000000", "43@win32:1000000000"), false);
  assert.equal(matchesWindowsIdentity(null, "42@win32:1"), false);
  if (process.platform === "win32") {
    const own = getOwnWindowsProcessIdentity();
    assert.match(own, /^\d+@win32:~\d+$/);
  }
});
