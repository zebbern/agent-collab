import test from "node:test";
import assert from "node:assert/strict";

import { SpawnedCodexAppServerClient } from "../plugins/codex/scripts/lib/app-server.mjs";

function createClient(options, procOverrides = {}) {
  const client = new SpawnedCodexAppServerClient("/tmp", { closeWaitMs: 10, ...options });
  client.proc = {
    pid: 4321,
    killed: false,
    exitCode: null,
    stdin: { end() {} },
    stdio: [null, null, null, null],
    ...procOverrides
  };
  client.resolveExit();
  return client;
}

test("win32 close terminates the app-server synchronously and records the verified outcome", async () => {
  const calls = [];
  const client = createClient({
    platform: "win32",
    terminateProcessTreeImpl: async (pid, options) => {
      calls.push({ pid, options });
      return {
        attempted: true,
        delivered: true,
        verified: true,
        method: "taskkill",
        survivors: []
      };
    }
  });

  await client.close();

  assert.equal(calls.length, 1);
  assert.equal(calls[0].pid, 4321);
  assert.equal(calls[0].options.ownerHoldsLiveHandle, true);
  assert.equal(client.cleanupOutcome.verified, true);
  assert.equal(client.cleanupOutcome.method, "taskkill");
});

test("win32 close surfaces an unverified termination outcome", async () => {
  const calls = [];
  const client = createClient({
    platform: "win32",
    terminateProcessTreeImpl: async (pid, options) => {
      calls.push({ pid, options });
      return {
        attempted: true,
        delivered: true,
        verified: false,
        degraded: true,
        method: "taskkill",
        survivors: [4321],
        reason: "process still running after taskkill"
      };
    }
  });

  await client.close();

  assert.equal(calls.length, 1);
  assert.equal(client.cleanupOutcome.verified, false);
  assert.equal(client.cleanupOutcome.degraded, true);
  assert.equal(client.cleanupOutcome.method, "taskkill");
  assert.deepEqual(client.cleanupOutcome.survivors, [4321]);
  assert.equal(client.cleanupOutcome.reason, "process still running after taskkill");
});

test("win32 close does not terminate an app-server that already exited", async () => {
  let calls = 0;
  const client = createClient(
    {
      platform: "win32",
      terminateProcessTreeImpl: async () => {
        calls += 1;
        return { attempted: true, delivered: true, verified: true, method: "taskkill" };
      }
    },
    { exitCode: 0 }
  );

  await client.close();

  assert.equal(calls, 0);
});

test("win32 close rechecks liveness through the default termination path", async () => {
  const calls = [];
  const client = createClient({
    platform: "win32",
    runCommandImpl(command, args) {
      calls.push({ command, args });
      if (command === "taskkill") {
        return { command, args, status: 0, signal: null, stdout: "", stderr: "", error: null };
      }
      return {
        command,
        args,
        status: 0,
        signal: null,
        stdout: "INFO: No tasks are running which match the specified criteria.\r\n",
        stderr: "",
        error: null
      };
    }
  });

  await client.close();

  assert.deepEqual(calls, [
    { command: "taskkill", args: ["/PID", "4321", "/T", "/F"] },
    { command: "tasklist", args: ["/FI", "PID eq 4321", "/FO", "CSV", "/NH"] }
  ]);
  assert.equal(client.cleanupOutcome.verified, true);
});

test("POSIX close still terminates through the process-tree path", async () => {
  const calls = [];
  const client = createClient({
    platform: "linux",
    terminateProcessTreeImpl: async (pid, options) => {
      calls.push({ pid, options });
      return {
        attempted: true,
        delivered: true,
        verified: true,
        method: "process-tree",
        survivors: []
      };
    }
  });

  await client.close();

  assert.equal(calls.length, 1);
  assert.equal(calls[0].pid, 4321);
  assert.equal(calls[0].options.ownerHoldsLiveHandle, true);
  assert.equal(typeof calls[0].options.directKillImpl, "function");
  assert.equal(client.cleanupOutcome.verified, true);
  assert.equal(client.cleanupOutcome.method, "process-tree");
});
