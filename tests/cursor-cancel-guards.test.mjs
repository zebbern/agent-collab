// Unit tests for the cursor plugin's cancel-ownership guards: the win32 kill
// path must prove (pid, start time) identity before taskkill, refuse blind
// kills when capture failed, and the WSL reap must verify /proc cmdline
// before signalling and fail closed when the agent survives.
import test from "node:test";
import assert from "node:assert/strict";

import {
  getWindowsProcessIdentity,
  isWindowsProcessIdentity,
  terminateProcessTree
} from "../plugins/cursor/scripts/lib/process.mjs";
import { buildWslAgentSpawn, reapWslAgent } from "../plugins/cursor/scripts/lib/cursor.mjs";

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
  const { runCommandImpl } = commandRecorder([
    { match: (key) => key.startsWith("powershell"), result: ok("133702000000000000\n") }
  ]);
  assert.equal(getWindowsProcessIdentity(4242, { runCommandImpl }), "4242@win32:133702000000000000");
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

test("buildWslAgentSpawn routes the agent through the pidfile wrapper", () => {
  const plan = { kind: "wsl", file: "wsl", prefix: ["-e", "/home/kali/.local/bin/cursor-agent"] };
  const line = buildWslAgentSpawn(plan, ["-p", "hello world", "--trust"], "/mnt/c/tmp/agent.pid");
  assert.equal(line.file, "wsl");
  assert.deepEqual(line.args.slice(0, 4), ["-e", "/bin/bash", "-c", 'echo $$ > "$1"; BIN="$2"; shift 2; exec "$BIN" "$@"']);
  assert.deepEqual(line.args.slice(4), ["bash", "/mnt/c/tmp/agent.pid", "/home/kali/.local/bin/cursor-agent", "-p", "hello world", "--trust"]);
});

test("reapWslAgent verifies cmdline, escalates TERM then KILL, and fails closed on survivors", async () => {
  const aliveThenGone = (() => {
    let reads = 0;
    return commandRecorder([
      {
        match: (key) => key.includes("/proc/4242/cmdline"),
        result: null,
        get result() {
          reads += 1;
          return reads === 1 ? ok("/home/kali/.local/bin/cursor-agent -p hi ") : ok("");
        }
      }
    ]);
  })();
  const reaped = await reapWslAgent(4242, { runCommandImpl: aliveThenGone.runCommandImpl, delayMs: 5 });
  assert.equal(reaped.reaped, true);
  assert.equal(reaped.signal, "TERM");
  assert.equal(aliveThenGone.calls.some((call) => call.join(" ").includes("kill -TERM 4242")), true);

  const reused = commandRecorder([
    { match: (key) => key.includes("/proc/4242/cmdline"), result: ok("/usr/bin/vim notes.txt ") }
  ]);
  const reusedOutcome = await reapWslAgent(4242, { runCommandImpl: reused.runCommandImpl, delayMs: 5 });
  assert.equal(reusedOutcome.reaped, true);
  assert.equal(reusedOutcome.pidReused, true);
  assert.equal(reused.calls.some((call) => call.join(" ").includes("kill -")), false);

  const immortal = commandRecorder([
    { match: (key) => key.includes("/proc/4242/cmdline"), result: ok("/home/kali/.local/bin/cursor-agent -p hi ") }
  ]);
  const survived = await reapWslAgent(4242, { runCommandImpl: immortal.runCommandImpl, delayMs: 5 });
  assert.equal(survived.reaped, false);
  assert.deepEqual(survived.survivors, [4242]);
  assert.equal(immortal.calls.some((call) => call.join(" ").includes("kill -KILL 4242")), true);

  const gone = commandRecorder([
    { match: (key) => key.includes("/proc/4242/cmdline"), result: ok("") }
  ]);
  const alreadyDead = await reapWslAgent(4242, { runCommandImpl: gone.runCommandImpl, delayMs: 5 });
  assert.equal(alreadyDead.reaped, true);
  assert.equal(alreadyDead.alreadyDead, true);
});
