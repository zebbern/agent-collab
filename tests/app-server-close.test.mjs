import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { SpawnedCodexAppServerClient } from "../plugins/codex/scripts/lib/app-server.mjs";
import { runAppServerClientOperation } from "../plugins/codex/scripts/lib/codex.mjs";
import { waitFor } from "./runtime-helpers.mjs";

const APP_SERVER_CHILD = fileURLToPath(new URL("../plugins/codex/scripts/app-server-child.mjs", import.meta.url));

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
  client.procIdentity = "4321@app-server";
  client.ownershipSnapshot = {
    rootPid: 4321,
    rootIdentity: client.procIdentity,
    members: [{ pid: 4321, identity: client.procIdentity, depth: 0 }]
  };

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

test("published win32 close rejects an absent-root cleanup as unverified", async () => {
  const client = createClient({
    platform: "win32",
    terminateProcessTreeImpl: async () => ({
      attempted: false,
      delivered: false,
      verified: true,
      degraded: false,
      method: "identity-check",
      survivors: []
    })
  });
  client.ownershipPublished = true;
  client.procIdentity = "4321@win32:123456";

  await client.close();

  assert.equal(client.cleanupOutcome.verified, false);
  assert.equal(client.cleanupOutcome.degraded, true);
  assert.deepEqual(client.cleanupOutcome.survivorIdentities, [client.procIdentity]);
});

test("published win32 close rejects a root-only kill as unverified", async () => {
  const client = createClient({
    platform: "win32",
    terminateProcessTreeImpl: async () => ({
      attempted: true,
      delivered: true,
      verified: true,
      degraded: false,
      method: "kill",
      survivors: []
    })
  });
  client.ownershipPublished = true;
  client.procIdentity = "4321@win32:123456";

  await client.close();

  assert.equal(client.cleanupOutcome.verified, false);
  assert.equal(client.cleanupOutcome.degraded, true);
  assert.deepEqual(client.cleanupOutcome.survivorIdentities, [client.procIdentity]);
});

test("published close durably reports its verified cleanup outcome before returning", async () => {
  let publishedOutcome = null;
  const client = createClient({
    platform: "win32",
    terminateProcessTreeImpl: async () => ({
      attempted: true,
      delivered: true,
      verified: true,
      method: "taskkill",
      survivors: []
    }),
    async onAppServerCleanupOutcome(outcome) {
      await Promise.resolve();
      publishedOutcome = outcome;
    }
  });
  client.ownershipPublished = true;
  client.procIdentity = "4321@win32:123456";

  await client.close();

  assert.equal(publishedOutcome?.verified, true);
  assert.equal(publishedOutcome?.method, "taskkill");
});

test("cleanup publication failure leaves a published operation retryable", async () => {
  const client = createClient({
    platform: "win32",
    terminateProcessTreeImpl: async () => ({
      attempted: true,
      delivered: true,
      verified: true,
      method: "taskkill",
      survivors: []
    }),
    async onAppServerCleanupOutcome() {
      throw new Error("injected cleanup persistence failure");
    }
  });
  client.transport = "direct";
  client.ownershipPublished = true;
  client.procIdentity = "4321@win32:123456";

  await assert.rejects(
    runAppServerClientOperation(client, async () => ({ exitStatus: 0 })),
    (error) => {
      assert.match(error.message, /cleanup persistence failure/);
      assert.equal(error.appServerCleanupOutcome?.verified, false);
      return true;
    }
  );
  assert.equal(client.cleanupOutcome.verified, false);
  assert.match(client.cleanupOutcome.reason, /cleanup persistence failure/);
});

test("win32 close records an unverified outcome when termination throws", async () => {
  const client = createClient({
    platform: "win32",
    terminateProcessTreeImpl: async () => {
      throw new Error("taskkill unavailable");
    }
  });
  client.transport = "direct";
  client.ownershipPublished = true;

  await client.close();

  assert.equal(client.cleanupOutcome.verified, false);
  assert.equal(client.cleanupOutcome.degraded, true);
});

test("a published win32 app-server that exits unexpectedly records unverified cleanup", async () => {
  const client = createClient(
    { platform: "win32" },
    { exitCode: 1 }
  );
  client.transport = "direct";
  client.ownershipPublished = true;

  client.handleExit(new Error("wrapper exited unexpectedly"));
  await client.close();

  assert.equal(client.cleanupOutcome.verified, false);
  assert.equal(client.cleanupOutcome.degraded, true);
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

test("POSIX close terminates the app-server process group", async () => {
  const calls = [];
  const client = createClient({
    platform: "linux",
    terminateProcessGroupImpl: async (pid, options) => {
      calls.push({ pid, options });
      return {
        attempted: true,
        delivered: true,
        verified: true,
        method: "process-group",
        survivors: []
      };
    }
  });
  client.procIdentity = "4321@app-server";
  client.ownershipSnapshot = {
    rootPid: 4321,
    rootIdentity: client.procIdentity,
    members: [{ pid: 4321, identity: client.procIdentity, depth: 0 }]
  };

  await client.close();

  assert.equal(calls.length, 1);
  assert.equal(calls[0].pid, 4321);
  assert.equal(calls[0].options.ownershipSnapshot, client.ownershipSnapshot);
  assert.equal(client.cleanupOutcome.verified, true);
  assert.equal(client.cleanupOutcome.method, "process-group");
});

test("a completed operation remains recoverable when direct app-server cleanup is unverified", async () => {
  const completedResult = { exitStatus: 0, payload: { ok: true }, rendered: "done" };
  const cleanupOutcome = { attempted: true, delivered: true, verified: false, survivors: [4321] };
  const client = {
    transport: "direct",
    ownershipPublished: true,
    cleanupOutcome: null,
    async close() {
      this.cleanupOutcome = cleanupOutcome;
    }
  };

  await assert.rejects(
    runAppServerClientOperation(client, async () => completedResult),
    (error) => {
      assert.equal(error.code, "APP_SERVER_CLEANUP_UNVERIFIED");
      assert.equal(error.appServerCleanupOutcome, cleanupOutcome);
      assert.equal(error.completedResult, completedResult);
      return true;
    }
  );
});

test("a failed operation retains its error when direct app-server cleanup is unverified", async () => {
  const operationError = new Error("turn failed before completion");
  operationError.code = "TURN_FAILED";
  const cleanupOutcome = { attempted: true, delivered: true, verified: false, survivors: [4321] };
  const client = {
    transport: "direct",
    ownershipPublished: true,
    cleanupOutcome: null,
    async close() {
      this.cleanupOutcome = cleanupOutcome;
    }
  };

  await assert.rejects(
    runAppServerClientOperation(client, async () => {
      throw operationError;
    }),
    (error) => {
      assert.equal(error, operationError);
      assert.equal(error.code, "TURN_FAILED");
      assert.equal(error.appServerCleanupOutcome, cleanupOutcome);
      assert.equal("completedResult" in error, false);
      return true;
    }
  );
});

test("the app-server activation wrapper waits for control-pipe publication on Windows", async (t) => {
  if (process.platform !== "win32") {
    t.skip("Windows child activation is the platform-specific contract.");
    return;
  }

  const wrapper = spawn(process.execPath, [APP_SERVER_CHILD], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: {
      ...process.env,
      PATH: ""
    },
    stdio: ["pipe", "pipe", "pipe", "pipe"],
    windowsHide: true
  });
  t.after(() => {
    wrapper.kill();
  });

  let stderr = "";
  wrapper.stderr.setEncoding("utf8");
  wrapper.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(wrapper.exitCode, null);
  assert.equal(stderr, "");

  wrapper.stdio[3].end("activate\n");
  await waitFor(() => wrapper.exitCode !== null);
  assert.match(stderr, /codex|not recognized/i);
});
