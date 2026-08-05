// Unit tests for the cursor plugin's cancel-ownership guards: the win32 kill
// path must prove (pid, start time) identity before taskkill, refuse blind
// kills when capture failed, and the WSL reap must prove the agent's
// (pid, /proc starttime) identity — falling back to the cmdline check for
// legacy records — before signalling, and fail closed when the agent
// survives.
import test from "node:test";
import assert from "node:assert/strict";

import {
  getWindowsProcessIdentity,
  isWindowsProcessIdentity,
  terminateProcessTree
} from "../plugins/cursor/scripts/lib/process.mjs";
import { buildWslAgentSpawn, createWslPidFileReader, reapWslAgent } from "../plugins/cursor/scripts/lib/cursor.mjs";

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

test("buildWslAgentSpawn routes the agent through the pidfile wrapper", () => {
  const plan = { kind: "wsl", file: "wsl", prefix: ["-e", "/home/kali/.local/bin/cursor-agent"] };
  const line = buildWslAgentSpawn(plan, ["-p", "hello world", "--trust"], "/mnt/c/tmp/agent.pid");
  assert.equal(line.file, "wsl");
  assert.deepEqual(line.args.slice(0, 4), [
    "-e",
    "/bin/bash",
    "-c",
    'S=$(</proc/$$/stat); S=${S##*) }; A=($S); echo "$$ ${A[19]}" > "$1"; BIN="$2"; shift 2; exec "$BIN" "$@"'
  ]);
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

test("reapWslAgent refuses to signal another cursor-agent born at a different time", async () => {
  const recycled = commandRecorder([
    {
      match: (key) => key.includes("/proc/4242/cmdline"),
      result: ok("/home/kali/.local/bin/cursor-agent -p hi \n999999\n")
    }
  ]);
  const outcome = await reapWslAgent(4242, {
    runCommandImpl: recycled.runCommandImpl,
    delayMs: 5,
    expectedStartTime: "123456"
  });
  assert.equal(outcome.reaped, true);
  assert.equal(outcome.pidReused, true);
  assert.equal(recycled.calls.some((call) => call.join(" ").includes("kill -")), false);
});

test("reapWslAgent kills on a starttime match and confirms death by identity, not cmdline", async () => {
  const aliveThenReplaced = (() => {
    let reads = 0;
    return commandRecorder([
      {
        match: (key) => key.includes("/proc/4242/cmdline"),
        get result() {
          reads += 1;
          // After TERM the PID is instantly recycled by another cursor-agent
          // with a different birth time: ours is provably gone, and the
          // impostor must not receive the KILL escalation.
          return reads === 1
            ? ok("/home/kali/.local/bin/cursor-agent -p hi \n123456\n")
            : ok("/home/kali/.local/bin/cursor-agent -p other \n999999\n");
        }
      }
    ]);
  })();
  const outcome = await reapWslAgent(4242, {
    runCommandImpl: aliveThenReplaced.runCommandImpl,
    delayMs: 5,
    expectedStartTime: "123456"
  });
  assert.equal(outcome.reaped, true);
  assert.equal(outcome.signal, "TERM");
  assert.equal(aliveThenReplaced.calls.some((call) => call.join(" ").includes("kill -TERM 4242")), true);
  assert.equal(aliveThenReplaced.calls.some((call) => call.join(" ").includes("kill -KILL")), false);
});

test("reapWslAgent stops escalating once the PID belongs to a different command", async () => {
  // Pins the fix for a latent gap: without identity awareness, a PID recycled
  // between TERM and the recheck used to receive a blind KILL.
  const replacedByStranger = (() => {
    let reads = 0;
    return commandRecorder([
      {
        match: (key) => key.includes("/proc/4242/cmdline"),
        get result() {
          reads += 1;
          return reads === 1 ? ok("/home/kali/.local/bin/cursor-agent -p hi ") : ok("/usr/bin/vim notes.txt ");
        }
      }
    ]);
  })();
  const outcome = await reapWslAgent(4242, { runCommandImpl: replacedByStranger.runCommandImpl, delayMs: 5 });
  assert.equal(outcome.reaped, true);
  assert.equal(outcome.signal, "TERM");
  assert.equal(replacedByStranger.calls.some((call) => call.join(" ").includes("kill -KILL")), false);
});

test("reapWslAgent keeps cmdline-only reaping for legacy records without a recorded starttime", async () => {
  const legacy = (() => {
    let reads = 0;
    return commandRecorder([
      {
        match: (key) => key.includes("/proc/4242/cmdline"),
        get result() {
          reads += 1;
          return reads === 1 ? ok("/home/kali/.local/bin/cursor-agent -p hi \n\n") : ok("");
        }
      }
    ]);
  })();
  const outcome = await reapWslAgent(4242, { runCommandImpl: legacy.runCommandImpl, delayMs: 5 });
  assert.equal(outcome.reaped, true);
  assert.equal(outcome.signal, "TERM");
  assert.equal(legacy.calls.some((call) => call.join(" ").includes("kill -TERM 4242")), true);
});

test("reapWslAgent fails closed when a recorded starttime cannot be verified against /proc", async () => {
  // We hold identity evidence but cannot check it; killing on the weaker
  // cmdline match alone would betray the recorded identity.
  const statUnreadable = commandRecorder([
    {
      match: (key) => key.includes("/proc/4242/cmdline"),
      result: ok("/home/kali/.local/bin/cursor-agent -p hi \n\n")
    }
  ]);
  const outcome = await reapWslAgent(4242, {
    runCommandImpl: statUnreadable.runCommandImpl,
    delayMs: 5,
    expectedStartTime: "123456"
  });
  assert.equal(outcome.reaped, false);
  assert.equal(outcome.identityUnverified, true);
  assert.deepEqual(outcome.survivors, [4242]);
  assert.equal(statUnreadable.calls.some((call) => call.join(" ").includes("kill -")), false);
});

test("reapWslAgent treats a failed WSL probe as unknown state, never as death", async () => {
  const probeDown = commandRecorder([
    { match: (key) => key.includes("/proc/4242/cmdline"), result: fail() }
  ]);
  const outcome = await reapWslAgent(4242, { runCommandImpl: probeDown.runCommandImpl, delayMs: 5 });
  assert.equal(outcome.reaped, false);
  assert.equal(outcome.probeUnavailable, true);
  assert.deepEqual(outcome.survivors, [4242]);
  assert.equal(probeDown.calls.some((call) => call.join(" ").includes("kill -")), false);
});

test("reapWslAgent never reports success from a probe that fails after signalling", async () => {
  const probeDiesAfterTerm = (() => {
    let reads = 0;
    return commandRecorder([
      {
        match: (key) => key.includes("/proc/4242/cmdline"),
        get result() {
          reads += 1;
          return reads === 1 ? ok("/home/kali/.local/bin/cursor-agent -p hi \n123456\n") : fail();
        }
      }
    ]);
  })();
  const outcome = await reapWslAgent(4242, {
    runCommandImpl: probeDiesAfterTerm.runCommandImpl,
    delayMs: 5,
    expectedStartTime: "123456"
  });
  assert.equal(outcome.reaped, false);
  assert.deepEqual(outcome.survivors, [4242]);
});

test("createWslPidFileReader only accepts two consecutive identical parseable reads", () => {
  const read = createWslPidFileReader();
  // Torn first read: parseable but truncated — must not be accepted, even
  // though it matches the pid/starttime shape.
  assert.equal(read("354 21"), null);
  // Content changed: the full line arrives, still not stable yet.
  assert.equal(read("354 2201420\n"), null);
  // Identical consecutive read: accepted.
  assert.deepEqual(read("354 2201420\n"), { pid: 354, startTime: "2201420" });

  const legacyRead = createWslPidFileReader();
  assert.equal(legacyRead("354"), null);
  assert.deepEqual(legacyRead("354"), { pid: 354, startTime: null });

  const garbage = createWslPidFileReader();
  assert.equal(garbage("not a pid"), null);
  assert.equal(garbage("not a pid"), null);
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
