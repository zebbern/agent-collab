// Runtime broker and lifecycle tests: broker registration/reuse/rollback,
// app-server children, session hooks, cancel/worker cleanup, the stop-review
// gate hook, and shared-runtime contracts.
// Split from the former monolithic tests/runtime.test.mjs (unchanged test
// bodies) so node's per-file test parallelism spreads the suite across three
// files with similar wall time. Shared fixtures live in runtime-helpers.mjs.
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";

import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { initGitRepo, run } from "./helpers.mjs";
import { enqueueBackgroundTask, handleCancel, handleTaskWorker } from "../plugins/codex/scripts/codex-companion.mjs";
import { cleanupSessionJobs, handleSessionEnd, handleSessionStart } from "../plugins/codex/scripts/session-lifecycle-hook.mjs";
import { CodexAppServerClient } from "../plugins/codex/scripts/lib/app-server.mjs";
import { isBrokerRequestAllowedDuringShutdown } from "../plugins/codex/scripts/app-server-broker.mjs";
import { acquireBrokerRegistryLock, loadBrokerChildren, loadBrokerRegistration, publishBrokerChild, publishRegisteredBroker, registerBrokerOwner, releaseBrokerOwner, releaseBrokerRegistryLock, SESSION_OWNER_IDENTITY_ENV, SESSION_OWNER_PID_ENV } from "../plugins/codex/scripts/lib/broker-ownership.mjs";
import { acquireBrokerLaunchLock, activateBrokerProcess, brokerLaunchLockPort, clearBrokerSession, ensureBrokerSession, loadBrokerSession, loadReusableBrokerSession, saveBrokerSession, sendBrokerShutdown, teardownBrokerSession, waitForBrokerEndpoint } from "../plugins/codex/scripts/lib/broker-lifecycle.mjs";
import { readStoredJob } from "../plugins/codex/scripts/lib/job-control.mjs";
import { captureProcessOwnership, getProcessIdentity, getWindowsProcessIdentity, hasLiveProcessIdentity, terminateProcessGroup, terminateProcessTree } from "../plugins/codex/scripts/lib/process.mjs";
import { hasCancelFlag, listJobs, loadState, resolveStateDir, resolveStateFile, saveState, upsertJob, writeCancelFlag, writeJobFile } from "../plugins/codex/scripts/lib/state.mjs";
import { runTrackedJob } from "../plugins/codex/scripts/lib/tracked-jobs.mjs";
import { ROOT, SCRIPT, STOP_HOOK, SESSION_HOOK, BROKER_SCRIPT, SELF_EXPIRING_KEEPALIVE, selfExpiringKeepaliveCode, runtimePluginDataDir, makeTempDir, withBrokerOwner, waitFor, installSlowRejectFakeCodex, installInitializeErrorFakeCodex, instrumentSlowFakeTurnState, cleanupRuntimeBrokerSessions } from "./runtime-helpers.mjs";

test.after(async () => {
  assert.deepEqual(await cleanupRuntimeBrokerSessions(), []);
});

test("broker rejects queued work after shutdown begins", () => {
  assert.equal(isBrokerRequestAllowedDuringShutdown(true, { id: 2, method: "thread/list" }), false);
  assert.equal(isBrokerRequestAllowedDuringShutdown(true, { id: 3, method: "broker/shutdown" }), true);
  assert.equal(isBrokerRequestAllowedDuringShutdown(false, { id: 4, method: "thread/list" }), true);
});

test("SessionStart exports the stable process-group owner identity and runs registered cleanup", async () => {
  const envFile = path.join(makeTempDir(), "session.env");
  const previousEnvFile = process.env.CLAUDE_ENV_FILE;
  process.env.CLAUDE_ENV_FILE = envFile;
  try {
    let reaperMode = null;
    await handleSessionStart(
      {
        session_id: "session-owner-export",
        transcript_path: "/tmp/transcript.jsonl",
        cwd: ROOT
      },
      {
        pid: 7101,
        platform: "darwin",
        captureStableSessionOwnerImpl() {
          return {
            pid: 7100,
            identity: "7100@Mon Jul 27 00:07:00 2026",
            processGroupId: 7100
          };
        },
        async runRegisteredBrokerReaperImpl(options) {
          reaperMode = options.mode;
          return { mode: options.mode, scanned: 0, reaped: 0, reported: 0, results: [] };
        }
      }
    );
    assert.equal(reaperMode, "apply-registered");
  } finally {
    if (previousEnvFile == null) {
      delete process.env.CLAUDE_ENV_FILE;
    } else {
      process.env.CLAUDE_ENV_FILE = previousEnvFile;
    }
  }

  const source = fs.readFileSync(envFile, "utf8");
  assert.match(source, /export CODEX_COMPANION_SESSION_ID='session-owner-export'/);
  assert.match(source, new RegExp(`export ${SESSION_OWNER_PID_ENV}='7100'`));
  assert.match(source, new RegExp(`export ${SESSION_OWNER_IDENTITY_ENV}='7100@Mon Jul 27 00:07:00 2026'`));
});

test("SessionEnd leaves a shared broker untouched while another registered owner is live", async () => {
  const calls = [];
  await handleSessionEnd(
    { cwd: ROOT, session_id: "session-ending" },
    {
      env: {},
      loadBrokerSessionImpl() {
        return {
          endpoint: "unix:/tmp/shared-broker.sock",
          pid: 4100,
          pidIdentity: "4100@Mon Jul 27 00:00:00 2026",
          registry: {
            registered: true,
            version: 1,
            brokerKey: "a".repeat(64),
            registryRoot: "/tmp/registry",
            registryDir: `/tmp/registry/${"a".repeat(64)}`
          }
        };
      },
      acquireBrokerRegistryLockImpl() {
        calls.push("acquire-lock");
        return { acquired: true };
      },
      loadBrokerRegistrationImpl() {
        calls.push("validate-registry");
        return {
          registered: true,
          version: 1,
          brokerKey: "a".repeat(64),
          registryRoot: "/tmp/registry",
          registryDir: `/tmp/registry/${"a".repeat(64)}`
        };
      },
      releaseBrokerOwnerImpl() {
        calls.push("release-owner");
        return { released: true };
      },
      assessBrokerOwnersImpl() {
        return { safeToShutdown: false, reason: "live-owner", liveOwners: [{ sessionId: "session-other" }] };
      },
      sendBrokerShutdownImpl() {
        calls.push("shutdown-broker");
      },
      cleanupSessionJobsImpl() {
        calls.push("cleanup-jobs");
        return { verified: true, failures: [] };
      },
      teardownBrokerSessionImpl() {
        calls.push("teardown-broker");
        return { verified: true };
      },
      clearBrokerSessionImpl() {
        calls.push("clear-broker");
      },
      releaseBrokerRegistryLockImpl() {
        calls.push("release-lock");
        return { released: true };
      }
    }
  );

  assert.deepEqual(calls, ["acquire-lock", "validate-registry", "release-owner", "release-lock", "cleanup-jobs"]);
});

test("SessionEnd leaves an unregistered or externally supplied broker report-only", async () => {
  const calls = [];
  await handleSessionEnd(
    { cwd: ROOT, session_id: "session-unregistered" },
    {
      loadBrokerSessionImpl() {
        return {
          endpoint: "unix:/tmp/unregistered-broker.sock",
          pid: 4150,
          pidIdentity: "4150@Mon Jul 27 00:00:50 2026"
        };
      },
      sendBrokerShutdownImpl() {
        calls.push("shutdown-broker");
      },
      teardownBrokerSessionImpl() {
        calls.push("teardown-broker");
        return { verified: true };
      },
      clearBrokerSessionImpl() {
        calls.push("clear-broker");
      },
      cleanupSessionJobsImpl() {
        calls.push("cleanup-jobs");
        return { verified: true, failures: [] };
      }
    }
  );

  assert.deepEqual(calls, ["cleanup-jobs"]);
});

test("detached fixture keepalive self-expires when parent cleanup is skipped", async (t) => {
  if (process.platform === "win32") {
    t.skip("Unix detached fixture behavior is not available on Windows.");
    return;
  }

  const sleeper = spawn(process.execPath, ["-e", selfExpiringKeepaliveCode(500)], {
    detached: true,
    stdio: "ignore"
  });
  sleeper.unref();
  assert.doesNotThrow(() => process.kill(sleeper.pid, 0));

  await waitFor(() => {
    try {
      process.kill(sleeper.pid, 0);
      return false;
    } catch (error) {
      return error?.code === "ESRCH";
    }
  }, { timeoutMs: 3000 });
});

test("fake app-server crash reclaims an observed regrouped helper without replacement", async (t) => {
  if (process.platform === "win32") {
    t.skip("Unix process identities are required for helper ownership cleanup.");
    return;
  }
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const fakeStatePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir, "crash-with-regrouped-helper");
  const env = buildEnv(binDir);
  const child = spawn("codex", ["app-server"], {
    cwd: repo,
    env,
    detached: true,
    stdio: ["pipe", "pipe", "ignore"]
  });
  child.stdout.setEncoding("utf8");
  let buffer = "";
  const initialized = new Promise((resolve, reject) => {
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline === -1) {
        return;
      }
      resolve(JSON.parse(buffer.slice(0, newline)));
    });
    child.once("error", reject);
  });
  child.stdin.write(`${JSON.stringify({ id: 1, method: "initialize", params: { capabilities: {} } })}\n`);
  const response = await initialized;
  assert.equal(response.id, 1);
  await waitFor(() => fs.existsSync(fakeStatePath) && JSON.parse(fs.readFileSync(fakeStatePath, "utf8")).helperPids?.length === 1);
  const helperPid = JSON.parse(fs.readFileSync(fakeStatePath, "utf8")).helperPids[0];
  t.after(() => {
    try {
      process.kill(helperPid, "SIGKILL");
    } catch {
      // Ignore the helper after cleanup.
    }
  });
  let ownershipSnapshot;
  try {
    ownershipSnapshot = captureProcessOwnership(child.pid, { env });
  } catch (error) {
    if (error?.code === "PROCESS_TABLE_UNAVAILABLE") {
      t.skip(`process table unavailable: ${error.message}`);
      return;
    }
    throw error;
  }
  await new Promise((resolve) => child.once("exit", resolve));
  const outcome = await terminateProcessGroup(child.pid, { ownershipSnapshot, env });

  assert.equal(outcome.verified, true);
  assert.deepEqual(outcome.survivors, []);
  assert.equal(JSON.parse(fs.readFileSync(fakeStatePath, "utf8")).appServerStarts, 1);
});

test("shared broker durably observes and reclaims a post-activation regrouped helper", async (t) => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const fakeStatePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir, "crash-with-post-activation-regrouped-helper");
  const env = withBrokerOwner({
    ...buildEnv(binDir),
    CODEX_COMPANION_BROKER_CHILD_IDLE_MS: "1000"
  }, "post-snapshot-helper");
  const brokerSession = await ensureBrokerSession(repo, { env });
  if (!brokerSession) {
    t.skip("broker socket unavailable in this sandbox");
    return;
  }
  t.after(() => {
    run("node", [SESSION_HOOK, "SessionEnd"], {
      cwd: repo,
      env,
      input: JSON.stringify({ hook_event_name: "SessionEnd", cwd: repo })
    });
    if (fs.existsSync(fakeStatePath)) {
      const state = JSON.parse(fs.readFileSync(fakeStatePath, "utf8"));
      for (const helperPid of state.helperPids || []) {
        try {
          process.kill(helperPid, "SIGKILL");
        } catch {
          // Ignore helpers already terminated by group cleanup.
        }
      }
    }
  });

  function isLive(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return error?.code !== "ESRCH";
    }
  }

  const client = await CodexAppServerClient.connect(repo, { env });
  await client.request("thread/list", { cwd: repo });
  await waitFor(() => {
    if (!fs.existsSync(fakeStatePath)) {
      return false;
    }
    const state = JSON.parse(fs.readFileSync(fakeStatePath, "utf8"));
    return state.helperPids?.length === 1 && state.appServerPids?.length === 1;
  });

  const firstState = JSON.parse(fs.readFileSync(fakeStatePath, "utf8"));
  const appServerPid = firstState.appServerPids[0];
  const helperPid = firstState.helperPids[0];
  await waitFor(() => !isLive(appServerPid));
  await waitFor(() => !isLive(helperPid));

  const replacementResponse = await waitFor(async () => {
    try {
      const replacementClient = await CodexAppServerClient.connect(repo, { env });
      try {
        return await replacementClient.request("thread/list", { cwd: repo });
      } finally {
        await replacementClient.close();
      }
    } catch (error) {
      if (error?.rpcCode === -32002) {
        return false;
      }
      throw error;
    }
  });

  assert.ok(Array.isArray(replacementResponse.data));
  assert.equal(JSON.parse(fs.readFileSync(fakeStatePath, "utf8")).appServerStarts, 2);
});

test("shared broker observes a helper spawned after a streaming response before forwarding notifications", async (t) => {
  if (process.platform === "win32") {
    t.skip("Unix process identities are required for helper ownership cleanup.");
    return;
  }

  const repo = makeTempDir();
  const binDir = makeTempDir();
  const fakeStatePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir, "streaming-helper-after-response");
  const env = withBrokerOwner({
    ...buildEnv(binDir),
    CODEX_COMPANION_BROKER_CHILD_IDLE_MS: "1000"
  }, "streaming-helper-observation");
  const brokerSession = await ensureBrokerSession(repo, { env });
  if (!brokerSession) {
    t.skip("broker socket unavailable in this sandbox");
    return;
  }

  let helperPid = null;
  let appServerPid = null;
  let registeredChild = null;
  const client = await CodexAppServerClient.connect(repo, { env });
  t.after(async () => {
    await client.close().catch(() => {});
    await sendBrokerShutdown(brokerSession.endpoint).catch(() => {});
    for (const pid of [helperPid, appServerPid, brokerSession.pid]) {
      if (!Number.isFinite(pid)) {
        continue;
      }
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Ignore processes already reclaimed by the ownership cleanup path.
      }
    }
    clearBrokerSession(repo);
  });

  const started = await client.request("thread/start", { cwd: repo, ephemeral: true });
  await waitFor(() => {
    registeredChild = loadBrokerChildren(brokerSession.registry).children[0] ?? null;
    appServerPid = registeredChild?.pid ?? null;
    return Number.isFinite(appServerPid) && Boolean(registeredChild?.pidIdentity);
  });

  await client.request("turn/start", {
    threadId: started.thread.id,
    input: [{ type: "text", text: "spawn a helper after returning this response" }]
  });
  await waitFor(() => {
    if (!fs.existsSync(fakeStatePath)) {
      return false;
    }
    const state = JSON.parse(fs.readFileSync(fakeStatePath, "utf8"));
    helperPid = state.helperPids?.[0] ?? null;
    return Number.isFinite(helperPid) && Number.isFinite(appServerPid);
  });
  await waitFor(() => !hasLiveProcessIdentity(appServerPid, registeredChild.pidIdentity));
  await waitFor(() => {
    try {
      process.kill(helperPid, 0);
      return false;
    } catch (error) {
      return error?.code === "ESRCH";
    }
  }, { timeoutMs: 3000 });
});

test("shared broker tears down a post-activation helper before reporting observation lock contention", async (t) => {
  if (process.platform === "win32") {
    t.skip("Unix process identities are required for helper ownership cleanup.");
    return;
  }

  const repo = makeTempDir();
  const binDir = makeTempDir();
  const fakeStatePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir, "post-activation-helper-on-thread-list");
  const env = withBrokerOwner({
    ...buildEnv(binDir),
    CODEX_COMPANION_BROKER_CHILD_IDLE_MS: "1000"
  }, "observation-contention");
  const brokerSession = await ensureBrokerSession(repo, { env });
  if (!brokerSession) {
    t.skip("broker socket unavailable in this sandbox");
    return;
  }

  let helperPid = null;
  let appServerPid = null;
  let registryLock = null;
  const client = await CodexAppServerClient.connect(repo, { env });
  t.after(async () => {
    await client.close().catch(() => {});
    if (registryLock?.acquired === true) {
      const currentRegistration = loadBrokerRegistration({
        endpoint: brokerSession.endpoint,
        brokerIdentity: brokerSession.pidIdentity,
        env
      });
      releaseBrokerRegistryLock(currentRegistration, registryLock);
      registryLock = null;
    }
    run("node", [SESSION_HOOK, "SessionEnd"], {
      cwd: repo,
      env,
      input: JSON.stringify({ hook_event_name: "SessionEnd", cwd: repo })
    });
    for (const pid of [helperPid, appServerPid]) {
      if (!pid) {
        continue;
      }
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Ignore fixture processes already reclaimed by the broker.
      }
    }
  });

  function isLive(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return error?.code !== "ESRCH";
    }
  }

  await client.request("account/read", {});
  const registration = loadBrokerRegistration({
    endpoint: brokerSession.endpoint,
    brokerIdentity: brokerSession.pidIdentity,
    env
  });
  assert.equal(registration.registered, true);
  registryLock = acquireBrokerRegistryLock(registration);
  assert.equal(registryLock.acquired, true);

  try {
    await assert.rejects(
      client.request("thread/list", { cwd: repo }),
      (error) => {
        const state = JSON.parse(fs.readFileSync(fakeStatePath, "utf8"));
        helperPid = state.helperPids?.[0] ?? null;
        appServerPid = state.appServerPids?.[0] ?? null;
        return (
          error?.rpcCode === -32005 &&
          /registry-busy/.test(error.message) &&
          helperPid !== null &&
          appServerPid !== null &&
          !isLive(helperPid) &&
          !isLive(appServerPid)
        );
      }
    );
  } finally {
    assert.equal(releaseBrokerRegistryLock(registration, registryLock).released, true);
    registryLock = null;
  }

  const state = JSON.parse(fs.readFileSync(fakeStatePath, "utf8"));
  assert.equal(state.appServerStarts, 1);
  assert.equal(isLive(helperPid), false);
  assert.equal(isLive(appServerPid), false);
});

test("automatic broker registration preserves a shared broker until its final owner releases", async (t) => {
  if (process.platform === "win32") {
    t.skip("Unix process identities are required for the registered broker contract.");
    return;
  }

  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "review-ok");
  let ownerIdentity;
  try {
    ownerIdentity = getProcessIdentity(process.pid);
  } catch (error) {
    if (error?.code === "PROCESS_TABLE_UNAVAILABLE") {
      t.skip(`process table unavailable: ${error.message}`);
      return;
    }
    throw error;
  }
  assert.ok(ownerIdentity);

  const baseEnv = {
    ...buildEnv(binDir),
    CLAUDE_PLUGIN_DATA: runtimePluginDataDir,
    [SESSION_OWNER_PID_ENV]: String(process.pid),
    [SESSION_OWNER_IDENTITY_ENV]: ownerIdentity
  };
  const envA = { ...baseEnv, CODEX_COMPANION_SESSION_ID: "registry-owner-a" };
  const envB = { ...baseEnv, CODEX_COMPANION_SESSION_ID: "registry-owner-b" };
  const first = await ensureBrokerSession(repo, { env: envA });
  if (!first) {
    t.skip("broker socket unavailable in this sandbox");
    return;
  }
  t.after(() => {
    run("node", [SESSION_HOOK, "SessionEnd"], {
      cwd: repo,
      env: envB,
      input: JSON.stringify({ hook_event_name: "SessionEnd", cwd: repo, session_id: "registry-owner-b" })
    });
  });

  assert.equal(first.registry?.registered, true);
  assert.equal(fs.statSync(path.join(first.registry.registryDir, "broker.json")).mode & 0o777, 0o600);
  const second = await ensureBrokerSession(repo, { env: envB });
  assert.equal(second.pid, first.pid);
  assert.equal(fs.readdirSync(path.join(first.registry.registryDir, "owners")).filter((name) => name.endsWith(".json")).length, 2);

  const client = await CodexAppServerClient.connect(repo, { env: envB });
  await client.request("thread/list", { cwd: repo });
  await client.close();
  await waitFor(() => {
    const childrenDir = path.join(first.registry.registryDir, "children");
    return fs.existsSync(childrenDir) && fs.readdirSync(childrenDir).some((name) => name.endsWith(".json"));
  });

  const firstEnd = run("node", [SESSION_HOOK, "SessionEnd"], {
    cwd: repo,
    env: envA,
    input: JSON.stringify({ hook_event_name: "SessionEnd", cwd: repo, session_id: "registry-owner-a" })
  });
  assert.equal(firstEnd.status, 0, firstEnd.stderr);
  assert.ok(loadBrokerSession(repo));
  assert.doesNotThrow(() => process.kill(first.pid, 0));

  const finalEnd = run("node", [SESSION_HOOK, "SessionEnd"], {
    cwd: repo,
    env: envB,
    input: JSON.stringify({ hook_event_name: "SessionEnd", cwd: repo, session_id: "registry-owner-b" })
  });
  assert.equal(finalEnd.status, 0, finalEnd.stderr);
  assert.equal(loadBrokerSession(repo), null);
  await waitFor(() => {
    try {
      process.kill(first.pid, 0);
      return false;
    } catch (error) {
      return error?.code === "ESRCH";
    }
  });
});

test("existing broker reuse holds the registry lock through owner publication", async (t) => {
  if (process.platform === "win32") {
    t.skip("Unix process identities are required for the registered broker contract.");
    return;
  }

  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "review-ok");
  const baseEnv = {
    ...buildEnv(binDir),
    CLAUDE_PLUGIN_DATA: runtimePluginDataDir,
    [SESSION_OWNER_PID_ENV]: String(process.pid),
    [SESSION_OWNER_IDENTITY_ENV]: getProcessIdentity(process.pid)
  };
  const envA = { ...baseEnv, CODEX_COMPANION_SESSION_ID: "locked-reuse-a" };
  const envB = { ...baseEnv, CODEX_COMPANION_SESSION_ID: "locked-reuse-b" };
  const first = await ensureBrokerSession(repo, { env: envA });
  let heldLock = null;
  t.after(() => {
    run("node", [SESSION_HOOK, "SessionEnd"], {
      cwd: repo,
      env: envB,
      input: JSON.stringify({ hook_event_name: "SessionEnd", cwd: repo, session_id: "locked-reuse-b" })
    });
    run("node", [SESSION_HOOK, "SessionEnd"], {
      cwd: repo,
      env: envA,
      input: JSON.stringify({ hook_event_name: "SessionEnd", cwd: repo, session_id: "locked-reuse-a" })
    });
  });

  const second = await ensureBrokerSession(repo, {
    env: envB,
    acquireBrokerRegistryLockImpl(registration) {
      heldLock = acquireBrokerRegistryLock(registration);
      return heldLock;
    },
    loadBrokerRegistrationImpl(args) {
      assert.equal(heldLock?.acquired, true);
      return loadBrokerRegistration(args);
    },
    registerBrokerOwnerImpl(registration, options) {
      assert.equal(options.registryLock, heldLock);
      return registerBrokerOwner(registration, options);
    },
    releaseBrokerRegistryLockImpl(registration, lock) {
      assert.equal(lock, heldLock);
      const released = releaseBrokerRegistryLock(registration, lock);
      heldLock = null;
      return released;
    }
  });

  assert.equal(second.pid, first.pid);
  assert.equal(heldLock, null);
});

test("existing broker reuse refuses an owner that dies at the publication boundary", async (t) => {
  if (process.platform === "win32") {
    t.skip("Unix process identities are required for the registered broker contract.");
    return;
  }

  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "review-ok");
  const baseEnv = {
    ...buildEnv(binDir),
    CLAUDE_PLUGIN_DATA: runtimePluginDataDir,
    [SESSION_OWNER_PID_ENV]: String(process.pid),
    [SESSION_OWNER_IDENTITY_ENV]: getProcessIdentity(process.pid)
  };
  const envA = { ...baseEnv, CODEX_COMPANION_SESSION_ID: "publication-owner-a" };
  const envB = { ...baseEnv, CODEX_COMPANION_SESSION_ID: "publication-owner-b" };
  const first = await ensureBrokerSession(repo, { env: envA });
  t.after(() => {
    run("node", [SESSION_HOOK, "SessionEnd"], {
      cwd: repo,
      env: envA,
      input: JSON.stringify({ hook_event_name: "SessionEnd", cwd: repo, session_id: "publication-owner-a" })
    });
  });

  let publicationChecks = 0;
  const reused = await ensureBrokerSession(repo, {
    env: envB,
    registerBrokerOwnerImpl(registration, options) {
      return registerBrokerOwner(registration, {
        ...options,
        hasLiveProcessIdentityImpl(pid, identity) {
          publicationChecks += 1;
          assert.equal(pid, process.pid);
          assert.equal(identity, envB[SESSION_OWNER_IDENTITY_ENV]);
          return false;
        }
      });
    }
  });

  assert.equal(reused, null);
  assert.equal(publicationChecks, 1);
  assert.equal(loadBrokerSession(repo)?.pid, first.pid);
  const registration = loadBrokerRegistration({
    endpoint: first.endpoint,
    brokerIdentity: first.pidIdentity,
    env: envB
  });
  const owners = fs.readdirSync(path.join(registration.registryDir, "owners"))
    .map((name) => JSON.parse(fs.readFileSync(path.join(registration.registryDir, "owners", name), "utf8")));
  assert.equal(owners.some((owner) => owner.sessionId === "publication-owner-b"), false);
});

test("deterministic broker launch lock never splits across fallback resources", async (t) => {
  const repo = makeTempDir();
  const port = brokerLaunchLockPort(repo);
  const foreignServer = net.createServer((socket) => socket.end("foreign-service\n"));
  await new Promise((resolve, reject) => {
    foreignServer.once("error", reject);
    foreignServer.listen({ host: "127.0.0.1", port, exclusive: true }, resolve);
  });
  t.after(async () => {
    if (foreignServer.listening) {
      await new Promise((resolve) => foreignServer.close(resolve));
    }
  });

  await assert.rejects(
    acquireBrokerLaunchLock(repo, { timeoutMs: 250 }),
    (error) => error?.code === "BROKER_LAUNCH_LOCK_UNAVAILABLE"
  );
  await new Promise((resolve) => foreignServer.close(resolve));

  const first = await acquireBrokerLaunchLock(repo, { timeoutMs: 250 });
  assert.equal(first.port, port);
  try {
    await assert.rejects(
      acquireBrokerLaunchLock(repo, { timeoutMs: 75 }),
      (error) => error?.code === "BROKER_LAUNCH_LOCK_TIMEOUT"
    );
  } finally {
    await first.release();
  }
  const next = await acquireBrokerLaunchLock(repo, { timeoutMs: 250 });
  assert.equal(next.port, port);
  await next.release();
});

test("automatic broker falls back to direct mode when its launch lock cannot bind", async () => {
  const repo = makeTempDir();
  const env = withBrokerOwner(process.env, "launch-lock-bind-denied");
  let endpointCreated = false;

  const session = await ensureBrokerSession(repo, {
    env,
    async acquireBrokerLaunchLockImpl() {
      const error = new Error("loopback bind denied");
      error.code = "EACCES";
      throw error;
    },
    createBrokerEndpoint() {
      endpointCreated = true;
      return "unix:/unused.sock";
    }
  });

  assert.equal(session, null);
  assert.equal(endpointCreated, false);
});

test("ensureBrokerSession reports why the shared runtime is unavailable", async () => {
  const repo = makeTempDir();

  const windowsReasons = [];
  const windowsSession = await ensureBrokerSession(repo, {
    platform: "win32",
    onUnavailable: (reason) => windowsReasons.push(reason)
  });
  assert.equal(windowsSession, null);
  assert.deepEqual(windowsReasons, ["unsupported on Windows"]);

  const {
    [SESSION_OWNER_PID_ENV]: _ownerPid,
    [SESSION_OWNER_IDENTITY_ENV]: _ownerIdentity,
    ...envWithoutOwner
  } = process.env;
  const ownershipReasons = [];
  const ownerlessSession = await ensureBrokerSession(repo, {
    env: envWithoutOwner,
    platform: "linux",
    onUnavailable: (reason) => ownershipReasons.push(reason)
  });
  assert.equal(ownerlessSession, null);
  assert.deepEqual(ownershipReasons, ["session ownership unavailable"]);

  const lockReasons = [];
  const lockedSession = await ensureBrokerSession(repo, {
    env: withBrokerOwner(process.env, "unavailable-reasons"),
    platform: "linux",
    hasLiveBrokerOwnerIdentityImpl: () => true,
    async acquireBrokerLaunchLockImpl() {
      const error = new Error("launch lock occupied");
      error.code = "BROKER_LAUNCH_LOCK_TIMEOUT";
      throw error;
    },
    onUnavailable: (reason) => lockReasons.push(reason)
  });
  assert.equal(lockedSession, null);
  assert.deepEqual(lockReasons, ["broker launch lock unavailable"]);
});

test("automatic and explicit reuse paths refuse a live unregistered endpoint", async (t) => {
  if (process.platform === "win32") {
    t.skip("Unix broker sockets are required for this contract.");
    return;
  }

  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "review-ok");
  const socketPath = path.join(os.tmpdir(), `cxc-unregistered-${process.pid}-${Date.now()}.sock`);
  const endpoint = `unix:${socketPath}`;
  let brokerConnections = 0;
  const server = net.createServer((socket) => {
    brokerConnections += 1;
    socket.end();
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  saveBrokerSession(repo, { endpoint, registry: null });
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    clearBrokerSession(repo);
    if (fs.existsSync(socketPath)) {
      fs.unlinkSync(socketPath);
    }
  });

  const directClient = await CodexAppServerClient.connect(repo, {
    reuseExistingBroker: true,
    env: buildEnv(binDir)
  });
  await directClient.close();
  assert.equal(brokerConnections, 0);

  assert.equal(
    await ensureBrokerSession(repo, {
      env: withBrokerOwner(process.env, "unregistered-refusal")
    }),
    null
  );
  assert.equal(loadBrokerSession(repo)?.endpoint, endpoint);
  assert.equal(brokerConnections, 0);
});

test("invalid legacy broker state falls back to direct mode without deleting evidence", async () => {
  const repo = makeTempDir();
  const stateDir = resolveStateDir(repo);
  fs.mkdirSync(stateDir, { recursive: true });
  const statePath = path.join(stateDir, "broker.json");
  fs.writeFileSync(statePath, "{truncated\n", "utf8");

  const session = await ensureBrokerSession(repo, {
    env: withBrokerOwner(process.env, "invalid-legacy-state")
  });

  assert.equal(session, null);
  assert.equal(fs.readFileSync(statePath, "utf8"), "{truncated\n");
  fs.unlinkSync(statePath);
});

test("automatic broker rolls back when the broker registration cannot be published", async (t) => {
  if (process.platform === "win32") {
    t.skip("Unix process identities are required for the registered broker contract.");
    return;
  }

  const repo = makeTempDir();
  const binDir = makeTempDir();
  const socketPath = path.join(os.tmpdir(), `cxc-publish-failure-${process.pid}-${Date.now()}.sock`);
  installFakeCodex(binDir, "review-ok");
  const ownerIdentity = getProcessIdentity(process.pid);
  const env = {
    ...buildEnv(binDir),
    CLAUDE_PLUGIN_DATA: runtimePluginDataDir,
    CODEX_COMPANION_SESSION_ID: "publish-failure-owner",
    [SESSION_OWNER_PID_ENV]: String(process.pid),
    [SESSION_OWNER_IDENTITY_ENV]: ownerIdentity
  };
  let brokerPid = null;

  await assert.rejects(
    ensureBrokerSession(repo, {
      env,
      createBrokerEndpoint: () => `unix:${socketPath}`,
      captureProcessOwnershipImpl(pid, options) {
        brokerPid = pid;
        return captureProcessOwnership(pid, options);
      },
      publishRegisteredBrokerImpl() {
        throw new Error("injected broker registration failure");
      }
    }),
    (error) => error?.code === "BROKER_REGISTRATION_FAILED"
  );

  assert.ok(Number.isFinite(brokerPid));
  await waitFor(() => {
    try {
      process.kill(brokerPid, 0);
      return false;
    } catch (error) {
      return error?.code === "ESRCH";
    }
  });
  assert.equal(loadBrokerSession(repo), null);
  assert.equal(fs.existsSync(socketPath), false);
});

test("automatic broker rolls back when owner, state, or activation publication fails", async (t) => {
  if (process.platform === "win32") {
    t.skip("Unix process identities are required for the registered broker contract.");
    return;
  }

  const ownerIdentity = getProcessIdentity(process.pid);
  for (const failure of ["owner", "state", "activation"]) {
    const repo = makeTempDir();
    const binDir = makeTempDir();
    const socketPath = path.join(os.tmpdir(), `cxc-${failure}-failure-${process.pid}-${Date.now()}.sock`);
    installFakeCodex(binDir, "review-ok");
    const env = {
      ...buildEnv(binDir),
      CLAUDE_PLUGIN_DATA: runtimePluginDataDir,
      CODEX_COMPANION_SESSION_ID: `${failure}-failure-owner`,
      [SESSION_OWNER_PID_ENV]: String(process.pid),
      [SESSION_OWNER_IDENTITY_ENV]: ownerIdentity
    };
    let brokerPid = null;

    await assert.rejects(
      ensureBrokerSession(repo, {
        env,
        createBrokerEndpoint: () => `unix:${socketPath}`,
        captureProcessOwnershipImpl(pid, options) {
          brokerPid = pid;
          return captureProcessOwnership(pid, options);
        },
        publishRegisteredBrokerImpl: failure === "owner"
          ? () => ({ registered: false, reason: "injected-owner-failure" })
          : undefined,
        saveBrokerSessionImpl: failure === "state"
          ? () => {
              throw new Error("injected state publication failure");
            }
          : undefined,
        activateBrokerProcessImpl: failure === "activation"
          ? async () => {
              throw new Error("injected activation failure");
            }
          : undefined
      }),
      (error) => error?.code === "BROKER_REGISTRATION_FAILED"
    );

    assert.ok(Number.isFinite(brokerPid));
    await waitFor(() => {
      try {
        process.kill(brokerPid, 0);
        return false;
      } catch (error) {
        return error?.code === "ESRCH";
      }
    });
    assert.equal(loadBrokerSession(repo), null);
    assert.equal(fs.existsSync(socketPath), false);
  }
});

test("automatic broker rollback remains locked until exact cleanup converges", async (t) => {
  if (process.platform === "win32") {
    t.skip("Unix process identities are required for the registered broker contract.");
    return;
  }

  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "review-ok");
  const env = withBrokerOwner({
    ...buildEnv(binDir),
    CLAUDE_PLUGIN_DATA: runtimePluginDataDir
  }, "locked-rollback");
  let registration = null;
  let brokerPid = null;
  let releaseObserved = false;

  await assert.rejects(
    ensureBrokerSession(repo, {
      env,
      rollbackExitTimeoutMs: 0,
      captureProcessOwnershipImpl(pid, options) {
        brokerPid = pid;
        return captureProcessOwnership(pid, options);
      },
      publishRegisteredBrokerImpl(options) {
        registration = publishRegisteredBroker(options);
        return registration;
      },
      saveBrokerSessionImpl() {
        throw new Error("injected state publication failure");
      },
      releaseBrokerOwnerImpl(lockedRegistration, options) {
        assert.equal(options.registryLock?.acquired, true);
        assert.equal(fs.existsSync(options.registryLock.path), true);
        assert.equal(acquireBrokerRegistryLock(lockedRegistration).acquired, false);
        assert.equal(hasLiveProcessIdentity(brokerPid, registration.broker.pidIdentity), false);
        releaseObserved = true;
        return releaseBrokerOwner(lockedRegistration, options);
      }
    }),
    (error) => error?.code === "BROKER_REGISTRATION_FAILED"
  );

  assert.equal(releaseObserved, true);
  assert.equal(fs.existsSync(registration.registryLock.path), false);
});

test("a failed activation recovery marker is never reusable", async (t) => {
  if (process.platform === "win32") {
    t.skip("Unix process identities are required for the registered broker contract.");
    return;
  }

  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "review-ok");
  const env = withBrokerOwner({
    ...buildEnv(binDir),
    CLAUDE_PLUGIN_DATA: runtimePluginDataDir
  }, "failed-activation-marker");
  const unverifiedCleanup = async () => ({
    attempted: true,
    delivered: false,
    verified: false,
    degraded: true,
    survivors: []
  });

  await assert.rejects(
    ensureBrokerSession(repo, {
      env,
      rollbackExitTimeoutMs: 0,
      async activateBrokerProcessImpl(child) {
        await activateBrokerProcess(child);
        throw new Error("injected post-activation publication failure");
      },
      killProcess: unverifiedCleanup
    }),
    (error) => error?.code === "BROKER_CLEANUP_UNVERIFIED"
  );

  const failedSession = loadBrokerSession(repo);
  t.after(async () => {
    await sendBrokerShutdown(failedSession?.endpoint).catch(() => {});
    if (Number.isFinite(failedSession?.pid)) {
      await terminateProcessTree(failedSession.pid, {
        expectedRootIdentity: failedSession.pidIdentity,
        ownershipSnapshot: failedSession.ownershipSnapshot
      }).catch(() => {});
    }
    clearBrokerSession(repo);
  });
  assert.equal(failedSession?.activationFailed, true);
  assert.equal(loadReusableBrokerSession(repo, env), null);
  assert.doesNotThrow(() => process.kill(failedSession.pid, 0));

  assert.equal(await ensureBrokerSession(repo, { env, killProcess: unverifiedCleanup }), null);
  assert.equal(loadBrokerSession(repo)?.pid, failedSession.pid);
  assert.equal(loadBrokerSession(repo)?.activationFailed, true);
});

test("a broker remains non-reusable until activation is acknowledged", async (t) => {
  if (process.platform === "win32") {
    t.skip("Unix process identities are required for the registered broker contract.");
    return;
  }

  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "review-ok");
  const env = withBrokerOwner({
    ...buildEnv(binDir),
    CLAUDE_PLUGIN_DATA: runtimePluginDataDir
  }, "pending-activation");
  let releaseActivation;
  const activationGate = new Promise((resolve) => {
    releaseActivation = resolve;
  });
  let session;
  const launch = ensureBrokerSession(repo, {
    env,
    async activateBrokerProcessImpl(child) {
      await activationGate;
      await activateBrokerProcess(child);
    }
  });
  t.after(async () => {
    releaseActivation?.();
    session ??= await launch.catch(() => null);
    await sendBrokerShutdown(session?.endpoint).catch(() => {});
    if (Number.isFinite(session?.pid)) {
      await terminateProcessTree(session.pid, {
        expectedRootIdentity: session.pidIdentity,
        ownershipSnapshot: session.ownershipSnapshot
      }).catch(() => {});
    }
    clearBrokerSession(repo);
  });

  await waitFor(() => loadBrokerSession(repo)?.activationPending === true);
  assert.equal(loadReusableBrokerSession(repo, env), null);

  releaseActivation();
  session = await launch;
  assert.equal(loadBrokerSession(repo)?.activationPending, false);
  assert.equal(loadReusableBrokerSession(repo, env)?.pid, session.pid);
});

test("a registered broker with a missing socket is not reusable", async (t) => {
  if (process.platform === "win32") {
    t.skip("Unix process identities are required for the registered broker contract.");
    return;
  }

  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "review-ok");
  const env = withBrokerOwner({
    ...buildEnv(binDir),
    CLAUDE_PLUGIN_DATA: runtimePluginDataDir
  }, "missing-socket");
  const session = await ensureBrokerSession(repo, { env });
  t.after(async () => {
    if (Number.isFinite(session?.pid)) {
      await terminateProcessTree(session.pid, {
        expectedRootIdentity: session.pidIdentity,
        ownershipSnapshot: session.ownershipSnapshot
      }).catch(() => {});
    }
    clearBrokerSession(repo);
  });

  assert.equal(loadReusableBrokerSession(repo, env)?.pid, session.pid);
  fs.unlinkSync(session.endpoint.slice("unix:".length));
  assert.equal(loadReusableBrokerSession(repo, env), null);
});

test("a crashed broker reclaims its registered child before starting a replacement", async (t) => {
  if (process.platform === "win32") {
    t.skip("Unix process identities are required for the registered broker contract.");
    return;
  }

  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "review-ok");
  const env = withBrokerOwner({
    ...buildEnv(binDir),
    CLAUDE_PLUGIN_DATA: runtimePluginDataDir
  }, "crashed-broker-child-reclaim");
  const session = await ensureBrokerSession(repo, { env });
  const helper = spawn(process.execPath, ["-e", SELF_EXPIRING_KEEPALIVE], {
    cwd: repo,
    env,
    detached: true,
    stdio: "ignore"
  });
  helper.unref();
  const helperOwnership = captureProcessOwnership(helper.pid, { cwd: repo, env });
  const childRegistration = publishBrokerChild(session.registry, { ownershipSnapshot: helperOwnership });
  assert.equal(childRegistration.registered, true);

  let replacement = null;
  t.after(async () => {
    await sendBrokerShutdown(replacement?.endpoint).catch(() => {});
    for (const target of [helper, { pid: replacement?.pid }]) {
      if (!Number.isFinite(target?.pid)) {
        continue;
      }
      try {
        process.kill(target.pid, "SIGKILL");
      } catch {
        // Ignore processes already reclaimed by the recovery path.
      }
    }
    clearBrokerSession(repo);
  });

  process.kill(session.pid, "SIGKILL");
  await waitFor(() => !hasLiveProcessIdentity(session.pid, session.pidIdentity));
  replacement = await ensureBrokerSession(repo, { env });

  assert.notEqual(replacement?.pid, session.pid);
  await waitFor(() => !hasLiveProcessIdentity(helper.pid, helperOwnership.rootIdentity));
  assert.equal(loadBrokerChildren(session.registry).children.length, 0);
});

test("automatic broker falls back without leaving a process when session ownership is unavailable", async (t) => {
  if (process.platform === "win32") {
    t.skip("Unix process identities are required for the registered broker contract.");
    return;
  }

  const repo = makeTempDir();
  const binDir = makeTempDir();
  const socketPath = path.join(os.tmpdir(), `cxc-owner-unavailable-${process.pid}-${Date.now()}.sock`);
  installFakeCodex(binDir, "review-ok");
  let endpointFactoryCalled = false;
  let brokerPid = null;

  const session = await ensureBrokerSession(repo, {
    env: buildEnv(binDir),
    createBrokerEndpoint: () => {
      endpointFactoryCalled = true;
      return `unix:${socketPath}`;
    },
    captureProcessOwnershipImpl(pid, options) {
      brokerPid = pid;
      return captureProcessOwnership(pid, options);
    }
  });

  assert.equal(session, null);
  assert.equal(endpointFactoryCalled, false);
  assert.equal(brokerPid, null);
  assert.equal(loadBrokerSession(repo), null);
  assert.equal(fs.existsSync(socketPath), false);
});

test("concurrent automatic broker launches converge on one registered process", async (t) => {
  if (process.platform === "win32") {
    t.skip("Unix process identities are required for the registered broker contract.");
    return;
  }

  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "review-ok");
  const ownerIdentity = getProcessIdentity(process.pid);
  const baseEnv = {
    ...buildEnv(binDir),
    CLAUDE_PLUGIN_DATA: runtimePluginDataDir,
    [SESSION_OWNER_PID_ENV]: String(process.pid),
    [SESSION_OWNER_IDENTITY_ENV]: ownerIdentity
  };
  const snapshots = [];
  const capture = (pid, options) => {
    const snapshot = captureProcessOwnership(pid, options);
    snapshots.push(snapshot);
    return snapshot;
  };
  t.after(async () => {
    for (const snapshot of snapshots) {
      await terminateProcessTree(snapshot.rootPid, {
        expectedRootIdentity: snapshot.rootIdentity,
        ownershipSnapshot: snapshot
      }).catch(() => {});
    }
  });

  const [first, second] = await Promise.all([
    ensureBrokerSession(repo, {
      env: { ...baseEnv, CODEX_COMPANION_SESSION_ID: "concurrent-owner-a" },
      captureProcessOwnershipImpl: capture
    }),
    ensureBrokerSession(repo, {
      env: { ...baseEnv, CODEX_COMPANION_SESSION_ID: "concurrent-owner-b" },
      captureProcessOwnershipImpl: capture
    })
  ]);

  assert.equal(first.pid, second.pid);
  assert.equal(snapshots.length, 1);
  assert.equal(loadBrokerSession(repo)?.pid, first.pid);
  assert.equal(fs.readdirSync(path.join(first.registry.registryDir, "owners")).filter((name) => name.endsWith(".json")).length, 2);
});

test("an unreachable registered broker is never terminated while an owner is live", async (t) => {
  if (process.platform === "win32") {
    t.skip("Unix broker sockets are required for this contract.");
    return;
  }

  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "review-ok");
  const ownerIdentity = getProcessIdentity(process.pid);
  const baseEnv = {
    ...buildEnv(binDir),
    CLAUDE_PLUGIN_DATA: runtimePluginDataDir,
    [SESSION_OWNER_PID_ENV]: String(process.pid),
    [SESSION_OWNER_IDENTITY_ENV]: ownerIdentity
  };
  const first = await ensureBrokerSession(repo, {
    env: { ...baseEnv, CODEX_COMPANION_SESSION_ID: "unreachable-live-owner-a" }
  });
  t.after(async () => {
    await terminateProcessTree(first.pid, {
      expectedRootIdentity: first.pidIdentity,
      ownershipSnapshot: first.ownershipSnapshot
    }).catch(() => {});
    clearBrokerSession(repo);
  });

  const socketPath = first.endpoint.slice("unix:".length);
  fs.unlinkSync(socketPath);
  const second = await ensureBrokerSession(repo, {
    env: { ...baseEnv, CODEX_COMPANION_SESSION_ID: "unreachable-live-owner-b" }
  });

  assert.equal(second, null);
  assert.doesNotThrow(() => process.kill(first.pid, 0));
  assert.equal(loadBrokerSession(repo)?.pid, first.pid);
});

test("a detached test broker self-expires when its test runner cannot clean it", async (t) => {
  if (process.platform === "win32") {
    t.skip("Unix broker sockets are required for this contract.");
    return;
  }

  const repo = makeTempDir();
  const socketPath = path.join(os.tmpdir(), `cxc-test-ttl-${process.pid}-${Date.now()}.sock`);
  const endpoint = `unix:${socketPath}`;
  const broker = spawn(process.execPath, [BROKER_SCRIPT, "serve", "--endpoint", endpoint, "--cwd", repo], {
    cwd: repo,
    env: {
      ...process.env,
      CODEX_COMPANION_TEST_BROKER_TTL_MS: "250"
    },
    detached: true,
    stdio: "ignore"
  });
  broker.unref();
  const ownership = captureProcessOwnership(broker.pid, { cwd: repo });
  t.after(async () => {
    await terminateProcessTree(broker.pid, {
      expectedRootIdentity: ownership.rootIdentity,
      ownershipSnapshot: ownership
    }).catch(() => {});
  });

  assert.equal(await waitForBrokerEndpoint(endpoint, 2000), true);
  await waitFor(() => !hasLiveProcessIdentity(broker.pid, ownership.rootIdentity), { timeoutMs: 2000 });
  assert.equal(fs.existsSync(socketPath), false);
});

test("pre-activation broker exits when its launcher pipe closes", async (t) => {
  if (process.platform === "win32") {
    t.skip("Unix process groups are required for this contract.");
    return;
  }

  const repo = makeTempDir();
  const sessionDir = makeTempDir("cxc-launcher-exit-");
  const socketPath = path.join(os.tmpdir(), `cxc-launcher-exit-${process.pid}-${Date.now()}.sock`);
  const endpoint = `unix:${socketPath}`;
  const pidFile = path.join(sessionDir, "broker.pid");
  const child = spawn(
    process.execPath,
    [BROKER_SCRIPT, "serve", "--endpoint", endpoint, "--cwd", repo, "--pid-file", pidFile, "--require-activation-stdin"],
    {
      cwd: repo,
      env: { ...process.env, CODEX_COMPANION_TEST_BROKER_TTL_MS: "30000" },
      detached: true,
      stdio: ["pipe", "ignore", "ignore"],
      timeout: 30000,
      killSignal: "SIGKILL"
    }
  );
  const ownershipSnapshot = captureProcessOwnership(child.pid, { cwd: repo });
  t.after(async () => {
    child.stdin?.destroy();
    await terminateProcessTree(child.pid, {
      expectedRootIdentity: ownershipSnapshot.rootIdentity,
      ownershipSnapshot
    }).catch(() => {});
  });

  assert.equal(await waitForBrokerEndpoint(endpoint, 2000), true);
  const preActivationResponse = await new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: socketPath });
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("connect", () => {
      socket.write(`${JSON.stringify({ id: 1, method: "initialize", params: {} })}\n`);
    });
    socket.on("data", (chunk) => {
      buffer += chunk;
    });
    socket.on("end", () => resolve(JSON.parse(buffer.trim())));
    socket.on("error", reject);
  });
  assert.equal(preActivationResponse.error?.code, -32004);
  child.stdin.end();
  await waitFor(() => {
    try {
      process.kill(child.pid, 0);
      return false;
    } catch (error) {
      return error?.code === "ESRCH";
    }
  }, { timeoutMs: 2000 });
  assert.equal(fs.existsSync(socketPath), false);
  assert.equal(fs.existsSync(pidFile), false);
});

test("an unregistered broker refuses to activate a detached app-server child", async (t) => {
  if (process.platform === "win32") {
    t.skip("Unix broker sockets are required for this contract.");
    return;
  }
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const fakeStatePath = path.join(binDir, "fake-codex-state.json");
  const socketPath = path.join(os.tmpdir(), `cxc-unregistered-child-${process.pid}-${Date.now()}.sock`);
  const endpoint = `unix:${socketPath}`;
  installFakeCodex(binDir, "with-helper-child");
  const env = buildEnv(binDir);
  const broker = spawn(process.execPath, [BROKER_SCRIPT, "serve", "--endpoint", endpoint, "--cwd", repo], {
    cwd: repo,
    env,
    detached: false,
    stdio: ["ignore", "ignore", "ignore"],
    timeout: 30000,
    killSignal: "SIGKILL"
  });
  const brokerOwnership = captureProcessOwnership(broker.pid, { cwd: repo, env });
  t.after(async () => {
    await sendBrokerShutdown(endpoint).catch(() => {});
    await terminateProcessTree(broker.pid, {
      expectedRootIdentity: brokerOwnership.rootIdentity,
      ownershipSnapshot: brokerOwnership
    }).catch(() => {});
    await waitFor(() => !hasLiveProcessIdentity(broker.pid, brokerOwnership.rootIdentity));
  });
  assert.equal(await waitForBrokerEndpoint(endpoint, 2000), true);

  const client = await CodexAppServerClient.connect(repo, { brokerEndpoint: endpoint, env });
  await assert.rejects(
    client.request("thread/start", { cwd: repo, ephemeral: true }),
    (error) => error?.rpcCode === -32005
  );
  await client.close();
  assert.equal(fs.existsSync(fakeStatePath), false);
});

test("automatic broker creation stays disabled where registered ownership is unsupported", async () => {
  const repo = makeTempDir();
  let endpointFactoryCalled = false;
  const session = await ensureBrokerSession(repo, {
    platform: "win32",
    createBrokerEndpoint() {
      endpointFactoryCalled = true;
      throw new Error("Windows automatic broker creation must stop before endpoint creation.");
    }
  });

  assert.equal(session, null);
  assert.equal(endpointFactoryCalled, false);
  assert.equal(loadBrokerSession(repo), null);
});

test("direct app-server reclaims a post-snapshot helper after its child crashes", async (t) => {
  if (process.platform === "win32") {
    t.skip("Unix process groups are not available on Windows.");
    return;
  }

  const repo = makeTempDir();
  const binDir = makeTempDir();
  const fakeStatePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir, "crash-with-post-snapshot-helper");
  const env = buildEnv(binDir);
  const client = await CodexAppServerClient.connect(repo, { env, disableBroker: true });
  let helperPid = null;
  t.after(async () => {
    await client.close().catch(() => {});
    if (Number.isFinite(helperPid)) {
      try {
        process.kill(helperPid, "SIGKILL");
      } catch {
        // Ignore a helper already reclaimed after the app-server crash.
      }
    }
  });

  await waitFor(() => {
    if (!fs.existsSync(fakeStatePath)) {
      return false;
    }
    const state = JSON.parse(fs.readFileSync(fakeStatePath, "utf8"));
    if (state.helperPids?.length !== 1 || state.appServerPids?.length !== 1) {
      return false;
    }
    helperPid = state.helperPids[0];
    return true;
  });
  await client.waitForExit();
  await waitFor(() => {
    try {
      process.kill(helperPid, 0);
      return false;
    } catch (error) {
      return error?.code === "ESRCH";
    }
  }, { timeoutMs: 3000 });
});

test("broker shutdown completes without starting a second app-server", async (t) => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const fakeStatePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir, "with-resistant-helper");
  const env = withBrokerOwner(buildEnv(binDir), "broker-shutdown");
  const brokerSocketPath = path.join(os.tmpdir(), `cxc-p1c-${process.pid}-${Date.now()}.sock`);
  const brokerSession = await ensureBrokerSession(repo, {
    env,
    createBrokerEndpoint: () => `unix:${brokerSocketPath}`
  });
  if (!brokerSession) {
    t.skip("broker socket unavailable in this sandbox");
    return;
  }
  assert.ok(brokerSession.pid);
  t.after(() => {
    run("node", [SESSION_HOOK, "SessionEnd"], {
      cwd: repo,
      env,
      input: JSON.stringify({ hook_event_name: "SessionEnd", cwd: repo })
    });
  });

  const client = await CodexAppServerClient.connect(repo, { env });
  await client.request("thread/list", { cwd: repo });
  const appServerStartsBeforeShutdown = JSON.parse(fs.readFileSync(fakeStatePath, "utf8")).appServerStarts;
  assert.equal(appServerStartsBeforeShutdown, 1);
  await sendBrokerShutdown(brokerSession.endpoint);
  await waitFor(() => {
    try {
      process.kill(brokerSession.pid, 0);
      return false;
    } catch (error) {
      return error?.code === "ESRCH";
    }
  });
  assert.equal(JSON.parse(fs.readFileSync(fakeStatePath, "utf8")).appServerStarts, appServerStartsBeforeShutdown);
});

test("task worker persists its own process identity and cancel verifies cleanup", async (t) => {
  if (process.platform === "win32") {
    t.skip("Unix process identity is not available on Windows.");
    return;
  }

  const workspace = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "interruptible-slow-task");
  initGitRepo(workspace);
  fs.writeFileSync(path.join(workspace, "README.md"), "hello\n", "utf8");

  const job = {
    id: "task-worker-self-identity",
    workspaceRoot: workspace,
    kind: "task",
    title: "Codex Task",
    jobClass: "task",
    summary: "Verify worker self-identity",
    createdAt: "2026-07-28T08:03:00.000Z"
  };
  const request = {
    cwd: workspace,
    model: null,
    effort: null,
    prompt: "Wait while cancellation verifies worker ownership.",
    write: false,
    resumeLast: false,
    jobId: job.id
  };
  let worker = null;

  t.after(() => {
    if (!worker?.pid) {
      return;
    }
    try {
      process.kill(-worker.pid, "SIGKILL");
    } catch {
      try {
        process.kill(worker.pid, "SIGKILL");
      } catch {
        // Ignore a worker already reclaimed by cancellation.
      }
    }
  });

  enqueueBackgroundTask(workspace, job, request, {
    spawnDetachedTaskWorkerImpl(cwd, jobId) {
      worker = spawn(process.execPath, [SCRIPT, "task-worker", "--cwd", cwd, "--job-id", jobId], {
        cwd,
        env: buildEnv(binDir),
        detached: true,
        stdio: "ignore"
      });
      worker.unref();
      return worker;
    }
  });

  const runningJob = await waitFor(() => {
    const stored = readStoredJob(workspace, job.id);
    return stored?.status === "running" && Number.isFinite(stored.pid) ? stored : null;
  });

  if (runningJob.ownershipCaptureFailed === true) {
    t.skip("Process table unavailable for worker self-identity verification.");
    return;
  }

  let liveIdentity;
  try {
    liveIdentity = getProcessIdentity(runningJob.pid);
  } catch (error) {
    if (error?.code === "PROCESS_TABLE_UNAVAILABLE") {
      t.skip(`process table unavailable: ${error.message}`);
      return;
    }
    throw error;
  }

  assert.equal(runningJob.pid, worker.pid);
  assert.equal(runningJob.processIdentity, liveIdentity);
  // Alongside a successful identity capture, the worker now persists an
  // ownership snapshot so cancel can verify the whole tree, not just the
  // root PID.
  assert.equal(runningJob.ownershipSnapshot?.rootIdentity, liveIdentity);
  assert.equal(runningJob.ownershipSnapshot?.rootPid, worker.pid);
  assert.equal(Object.hasOwn(runningJob, "ownershipCaptureFailed"), false);

  await handleCancel([job.id, "--cwd", workspace, "--json"], {
    interruptAppServerTurnImpl: async () => ({ attempted: false, interrupted: false })
  });

  await waitFor(() => {
    try {
      process.kill(worker.pid, 0);
      return false;
    } catch (error) {
      return error?.code === "ESRCH";
    }
  });

  const cancelledJob = readStoredJob(workspace, job.id);
  assert.equal(cancelledJob.status, "cancelled");
  assert.equal(cancelledJob.pid, null);
  assert.equal(cancelledJob.processIdentity, liveIdentity);
});

test("cancel stops an active background job and marks it cancelled", async (t) => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  const sleeper = spawn(process.execPath, ["-e", SELF_EXPIRING_KEEPALIVE], {
    cwd: workspace,
    detached: true,
    stdio: "ignore"
  });
  sleeper.unref();
  const ownershipSnapshot = captureProcessOwnership(sleeper.pid, { cwd: workspace });
  const sleeperIdentity = ownershipSnapshot?.rootIdentity ?? (process.platform === "win32" ? getWindowsProcessIdentity(sleeper.pid) : null);

  t.after(() => {
    try {
      process.kill(-sleeper.pid, "SIGTERM");
    } catch {
      try {
        process.kill(sleeper.pid, "SIGTERM");
      } catch {
        // Ignore missing process.
      }
    }
  });

  const logFile = path.join(jobsDir, "task-live.log");
  const jobFile = path.join(jobsDir, "task-live.json");
  fs.writeFileSync(logFile, "[2026-03-18T15:30:00.000Z] Starting Codex Task.\n", "utf8");
  fs.writeFileSync(
    jobFile,
    JSON.stringify(
      {
        id: "task-live",
        status: "running",
        title: "Codex Task",
        pid: sleeper.pid,
        processIdentity: sleeperIdentity,
        ownershipSnapshot,
        logFile
      },
      null,
      2
    ),
    "utf8"
  );
  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: "task-live",
            status: "running",
            title: "Codex Task",
            jobClass: "task",
            summary: "Investigate flaky test",
            pid: sleeper.pid,
            processIdentity: sleeperIdentity,
            ownershipSnapshot,
            logFile,
            createdAt: "2026-03-18T15:30:00.000Z",
            startedAt: "2026-03-18T15:30:01.000Z",
            updatedAt: "2026-03-18T15:30:02.000Z"
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const cancelResult = run("node", [SCRIPT, "cancel", "task-live", "--json"], {
    cwd: workspace
  });

  assert.equal(cancelResult.status, 0, cancelResult.stderr);
  assert.equal(JSON.parse(cancelResult.stdout).status, "cancelled");

  await waitFor(() => {
    try {
      process.kill(sleeper.pid, 0);
      return false;
    } catch (error) {
      return error?.code === "ESRCH";
    }
  });

  const state = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
  const cancelled = state.jobs.find((job) => job.id === "task-live");
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.pid, null);

  const stored = JSON.parse(fs.readFileSync(jobFile, "utf8"));
  assert.equal(stored.status, "cancelled");
  assert.match(fs.readFileSync(logFile, "utf8"), /Cancelled by user/);
});

test("cancelling a queued pid-less job prevents its worker from performing work", async () => {
  const workspace = makeTempDir();
  const job = {
    id: "task-queued-cancel",
    workspaceRoot: workspace,
    kind: "task",
    title: "Codex Task",
    jobClass: "task",
    status: "queued",
    phase: "queued",
    pid: null,
    createdAt: "2026-07-28T08:02:00.000Z",
    updatedAt: "2026-07-28T08:02:00.000Z"
  };
  writeJobFile(workspace, job.id, job);
  upsertJob(workspace, job);

  let terminateCalled = false;
  await handleCancel([job.id, "--cwd", workspace, "--json"], {
    interruptAppServerTurnImpl: async () => ({ attempted: false, interrupted: false }),
    terminateProcessTreeImpl: async () => {
      terminateCalled = true;
      return {
        attempted: false,
        delivered: false,
        verified: true,
        degraded: false
      };
    }
  });

  assert.equal(terminateCalled, false);
  assert.equal(hasCancelFlag(workspace, job.id), true);

  const workMarker = path.join(workspace, "work-performed");
  await assert.rejects(
    runTrackedJob(job, async () => {
      fs.writeFileSync(workMarker, "ran\n", "utf8");
      return {
        exitStatus: 0,
        payload: { ok: true },
        rendered: "Work ran.",
        summary: "Work ran."
      };
    }),
    (error) => error?.code === "JOB_CANCELLED"
  );

  assert.equal(fs.existsSync(workMarker), false);
});

test("session cleanup preserves a queued cancel between worker read and pid publication", async () => {
  const workspace = makeTempDir();
  const sessionId = "sess-queued-worker-race";
  const job = {
    id: "task-session-end-race",
    workspaceRoot: workspace,
    kind: "task",
    title: "Codex Task",
    jobClass: "task",
    summary: "Exercise the SessionEnd startup race",
    sessionId,
    createdAt: "2026-07-28T08:03:00.000Z"
  };
  const request = {
    cwd: workspace,
    prompt: "Do not run after SessionEnd.",
    jobId: job.id
  };
  const workMarker = path.join(workspace, "work-performed");
  let firstCleanupPromise = null;
  let cancelFlagSurvivedCleanup = false;

  enqueueBackgroundTask(workspace, job, request, {
    spawnDetachedTaskWorkerImpl() {}
  });
  const queuedState = loadState(workspace);
  const queuedJob = queuedState.jobs.find((candidate) => candidate.id === job.id);
  const newerJobs = Array.from({ length: 50 }, (_, index) => ({
    id: `newer-job-${index}`,
    status: "completed",
    phase: "done",
    pid: null,
    createdAt: new Date(Date.UTC(2026, 6, 29, 9, index, 0)).toISOString(),
    updatedAt: new Date(Date.UTC(2026, 6, 29, 9, index, 0)).toISOString()
  }));
  fs.writeFileSync(
    resolveStateFile(workspace),
    `${JSON.stringify({ ...queuedState, jobs: [...newerJobs, { ...queuedJob, updatedAt: "2026-07-28T08:03:00.000Z" }] }, null, 2)}\n`,
    "utf8"
  );

  await assert.rejects(
    handleTaskWorker(["--cwd", workspace, "--job-id", job.id], {
      getProcessIdentityImpl(pid) {
        // handleTaskWorker has already read the queued record, but runTrackedJob
        // has not yet published this worker's pid.
        firstCleanupPromise = cleanupSessionJobs(workspace, sessionId);
        cancelFlagSurvivedCleanup = hasCancelFlag(workspace, job.id);
        return `${pid}@Mon Jul 28 08:03:01 2026`;
      },
      runTrackedJobImpl(candidate, _runner, options) {
        return runTrackedJob(
          candidate,
          async () => {
            fs.writeFileSync(workMarker, "ran\n", "utf8");
            return {
              exitStatus: 0,
              payload: { ok: true },
              rendered: "Work ran.",
              summary: "Work ran."
            };
          },
          options
        );
      }
    }),
    (error) => error?.code === "JOB_CANCELLED"
  );

  const firstCleanup = await firstCleanupPromise;
  assert.equal(firstCleanup.verified, false);
  assert.equal(cancelFlagSurvivedCleanup, true);
  assert.equal(fs.existsSync(workMarker), false);
  assert.equal(readStoredJob(workspace, job.id).status, "cancelled");

  const finalCleanup = await cleanupSessionJobs(workspace, sessionId);
  assert.equal(finalCleanup.verified, true);
  assert.equal(readStoredJob(workspace, job.id), null);
  assert.equal(hasCancelFlag(workspace, job.id), false);
});

test("worker converges a flagged running record to cancelled", async () => {
  const workspace = makeTempDir();
  const job = {
    id: "task-flag-convergence",
    workspaceRoot: workspace,
    kind: "task",
    title: "Codex Task",
    jobClass: "task",
    status: "queued",
    phase: "queued",
    pid: null,
    createdAt: "2026-07-28T08:04:00.000Z"
  };
  writeJobFile(workspace, job.id, job);
  upsertJob(workspace, job);
  writeCancelFlag(workspace, job.id);

  let workPerformed = false;
  await assert.rejects(
    runTrackedJob(job, async () => {
      workPerformed = true;
      return {
        exitStatus: 0,
        payload: { ok: true },
        rendered: "Work ran.",
        summary: "Work ran."
      };
    }),
    (error) => error?.name === "JobCancelledError" && error?.code === "JOB_CANCELLED"
  );

  assert.equal(workPerformed, false);
  const storedJob = readStoredJob(workspace, job.id);
  assert.equal(storedJob.status, "cancelled");
  assert.equal(storedJob.phase, "cancelled");
  assert.equal(storedJob.pid, null);
  assert.match(storedJob.startedAt, /^\d{4}-\d{2}-\d{2}T/);

  const indexedJob = listJobs(workspace).find((candidate) => candidate.id === job.id);
  assert.equal(indexedJob.status, "cancelled");
  assert.equal(indexedJob.phase, "cancelled");
  assert.equal(indexedJob.pid, null);

  saveState(workspace, {
    ...loadState(workspace),
    jobs: []
  });
  assert.equal(readStoredJob(workspace, job.id), null);
  assert.equal(hasCancelFlag(workspace, job.id), false);
});

test("cancel reclaims a helper spawned after worker identity capture without an ownership snapshot", async (t) => {
  if (process.platform === "win32") {
    t.skip("Unix process groups are not available on Windows.");
    return;
  }

  const workspace = makeTempDir();
  const helperPidFile = path.join(workspace, "late-helper.pid");
  const leader = spawn(
    process.execPath,
    [
      "-e",
      `
        const fs = require("node:fs");
        const { spawn } = require("node:child_process");
        setTimeout(() => {
          const helper = spawn(process.execPath, ["-e", ${JSON.stringify(SELF_EXPIRING_KEEPALIVE)}], {
            stdio: "ignore"
          });
          helper.unref();
          fs.writeFileSync(${JSON.stringify(helperPidFile)}, String(helper.pid));
        }, 750);
        ${SELF_EXPIRING_KEEPALIVE};
      `
    ],
    {
      cwd: workspace,
      detached: true,
      stdio: "ignore"
    }
  );
  leader.unref();
  let helperPid = null;

  t.after(() => {
    try {
      process.kill(-leader.pid, "SIGKILL");
    } catch {
      try {
        process.kill(leader.pid, "SIGKILL");
      } catch {
        // Ignore a leader already reclaimed by cancellation.
      }
    }
    if (Number.isFinite(helperPid)) {
      try {
        process.kill(helperPid, "SIGKILL");
      } catch {
        // Ignore a helper already reclaimed with the worker group.
      }
    }
  });

  let leaderIdentity;
  try {
    leaderIdentity = getProcessIdentity(leader.pid);
  } catch (error) {
    if (error?.code === "PROCESS_TABLE_UNAVAILABLE") {
      t.skip(`process table unavailable: ${error.message}`);
      return;
    }
    throw error;
  }
  assert.ok(leaderIdentity);
  assert.equal(fs.existsSync(helperPidFile), false);

  const logFile = path.join(workspace, "late-helper.log");
  fs.writeFileSync(logFile, "", "utf8");
  const job = {
    id: "task-late-helper",
    workspaceRoot: workspace,
    kind: "task",
    title: "Codex Task",
    jobClass: "task",
    status: "running",
    phase: "running",
    pid: leader.pid,
    processIdentity: leaderIdentity,
    logFile,
    createdAt: "2026-07-28T08:05:00.000Z",
    updatedAt: "2026-07-28T08:05:00.000Z"
  };
  writeJobFile(workspace, job.id, job);
  upsertJob(workspace, job);

  helperPid = await waitFor(() => {
    if (!fs.existsSync(helperPidFile)) {
      return null;
    }
    return Number(fs.readFileSync(helperPidFile, "utf8"));
  });
  assert.ok(Number.isFinite(helperPid));

  await handleCancel([job.id, "--cwd", workspace, "--json"], {
    interruptAppServerTurnImpl: async () => ({ attempted: false, interrupted: false })
  });

  function isRunning(pid) {
    const result = run("/bin/ps", ["-o", "stat=", "-p", String(pid)]);
    return result.status === 0 && !result.stdout.trim().startsWith("Z");
  }

  await waitFor(() => !isRunning(leader.pid));
  await waitFor(() => !isRunning(helperPid));
  assert.equal(readStoredJob(workspace, job.id).status, "cancelled");
  assert.equal(Object.hasOwn(readStoredJob(workspace, job.id), "ownershipSnapshot"), false);
});

test("cancel and session cleanup converge after an identity-tracked worker exits abnormally", async () => {
  const workspace = makeTempDir();
  const sessionId = "sess-abnormal-worker-exit";
  const job = {
    id: "task-abnormal-worker-exit",
    workspaceRoot: workspace,
    kind: "task",
    title: "Codex Task",
    jobClass: "task",
    summary: "Clean up an exited worker",
    sessionId,
    status: "running",
    phase: "running",
    pid: 43210,
    processIdentity: "43210@Mon Jul 28 08:05:00 2026",
    createdAt: "2026-07-28T08:05:00.000Z"
  };
  let processTableReads = 0;
  let terminateCalledDuringSessionCleanup = false;

  writeJobFile(workspace, job.id, job);
  upsertJob(workspace, job);

  await handleCancel([job.id, "--cwd", workspace, "--json"], {
    interruptAppServerTurnImpl: async () => ({ attempted: false, interrupted: false }),
    terminateProcessTreeImpl(pid, options) {
      return terminateProcessTree(pid, {
        ...options,
        platform: "darwin",
        runCommandImpl(command, args) {
          processTableReads += 1;
          return {
            command,
            args,
            status: 0,
            signal: null,
            stdout: "",
            stderr: "",
            error: null
          };
        },
        killImpl() {
          throw new Error("an absent worker must not be signaled");
        }
      });
    }
  });

  const cancelledJob = readStoredJob(workspace, job.id);
  assert.equal(processTableReads, 1);
  assert.equal(cancelledJob.status, "cancelled");
  assert.equal(cancelledJob.pid, null);
  assert.equal(cancelledJob.processIdentity, job.processIdentity);
  assert.equal(Object.hasOwn(cancelledJob, "ownershipSnapshot"), false);

  const sessionCleanup = await cleanupSessionJobs(workspace, sessionId, {
    terminateProcessTreeImpl() {
      terminateCalledDuringSessionCleanup = true;
      throw new Error("terminal jobs must not be terminated again");
    }
  });
  assert.equal(sessionCleanup.verified, true);
  assert.equal(terminateCalledDuringSessionCleanup, false);
  assert.equal(readStoredJob(workspace, job.id), null);
});

test("unverified cleanup preserves cancel, session, and broker ownership records", async () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });
  const logFile = path.join(jobsDir, "task-live.log");
  const jobFile = path.join(jobsDir, "task-live.json");
  const job = {
    id: "task-live",
    status: "running",
    phase: "running",
    title: "Codex Task",
    sessionId: "sess-current",
    pid: 123,
    processIdentity: "123@old",
    logFile
  };
  fs.writeFileSync(logFile, "starting\n", "utf8");
  fs.writeFileSync(jobFile, `${JSON.stringify(job, null, 2)}\n`, "utf8");
  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify({ version: 1, config: { stopReviewGate: false }, jobs: [job] }, null, 2)}\n`,
    "utf8"
  );

  const cleanupOutcome = {
    attempted: true,
    delivered: true,
    verified: false,
    degraded: true,
    survivors: [123],
    survivorIdentities: ["123@old"]
  };
  await assert.rejects(
    handleCancel(["task-live", "--cwd", workspace, "--json"], {
      interruptAppServerTurnImpl: async () => ({ attempted: false, interrupted: false }),
      terminateProcessTreeImpl: async () => cleanupOutcome
    }),
    /ownership records were preserved for retry/
  );
  let state = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
  assert.equal(state.jobs[0].status, "running");
  assert.equal(state.jobs[0].pid, 123);
  assert.deepEqual(state.jobs[0].cleanupOutcome.survivorIdentities, ["123@old"]);

  let sessionCleanupOptions;
  const sessionCleanup = await cleanupSessionJobs(workspace, "sess-current", {
    terminateProcessTreeImpl: async (_pid, options) => {
      sessionCleanupOptions = options;
      return cleanupOutcome;
    }
  });
  assert.equal(sessionCleanup.verified, false);
  assert.equal(sessionCleanupOptions.priorCleanupDegraded, true);
  state = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
  assert.equal(state.jobs[0].pid, 123);
  assert.equal(fs.existsSync(jobFile), true);

  const sessionDir = path.join(workspace, "broker-session");
  fs.mkdirSync(sessionDir, { recursive: true });
  const pidFile = path.join(sessionDir, "broker.pid");
  const brokerLog = path.join(sessionDir, "broker.log");
  const endpointPath = path.join(sessionDir, "broker.sock");
  fs.writeFileSync(pidFile, "456\n", "utf8");
  fs.writeFileSync(brokerLog, "broker\n", "utf8");
  fs.writeFileSync(endpointPath, "socket-marker\n", "utf8");
  const brokerCleanup = await teardownBrokerSession({
    endpoint: `unix:${endpointPath}`,
    pidFile,
    logFile: brokerLog,
    sessionDir,
    pid: 456,
    killProcess: async () => cleanupOutcome
  });
  assert.equal(brokerCleanup.verified, false);
  assert.equal(fs.existsSync(pidFile), true);
  assert.equal(fs.existsSync(brokerLog), true);
  assert.equal(fs.existsSync(endpointPath), true);
});

test("cancel without a job id ignores active jobs from other Claude sessions", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  const logFile = path.join(jobsDir, "task-other.log");
  fs.writeFileSync(logFile, "", "utf8");
  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: "task-other",
            status: "running",
            title: "Codex Task",
            jobClass: "task",
            sessionId: "sess-other",
            summary: "Other session run",
            updatedAt: "2026-03-24T20:05:00.000Z",
            logFile
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const env = {
    ...process.env,
    CODEX_COMPANION_SESSION_ID: "sess-current"
  };
  const status = run("node", [SCRIPT, "status", "--json"], {
    cwd: workspace,
    env
  });
  assert.equal(status.status, 0, status.stderr);
  assert.deepEqual(JSON.parse(status.stdout).running, []);

  const cancel = run("node", [SCRIPT, "cancel", "--json"], {
    cwd: workspace,
    env
  });
  assert.equal(cancel.status, 1);
  assert.match(cancel.stderr, /No active Codex jobs to cancel for this session\./);

  const state = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
  assert.equal(state.jobs[0].status, "running");
});

test("cancel with a job id can still target an active job from another Claude session", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  const logFile = path.join(jobsDir, "task-other.log");
  fs.writeFileSync(logFile, "", "utf8");
  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: "task-other",
            status: "running",
            title: "Codex Task",
            jobClass: "task",
            sessionId: "sess-other",
            summary: "Other session run",
            updatedAt: "2026-03-24T20:05:00.000Z",
            logFile
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const env = {
    ...process.env,
    CODEX_COMPANION_SESSION_ID: "sess-current"
  };
  const cancel = run("node", [SCRIPT, "cancel", "task-other", "--json"], {
    cwd: workspace,
    env
  });
  assert.equal(cancel.status, 0, cancel.stderr);
  assert.equal(JSON.parse(cancel.stdout).jobId, "task-other");

  const state = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
  assert.equal(state.jobs[0].status, "cancelled");
});

test("cancel sends turn interrupt to the shared app-server before killing a brokered task", async (t) => {
  if (process.platform === "win32") {
    t.skip("Unix broker sockets are required for this contract.");
    return;
  }
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const fakeStatePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir, "interruptible-slow-task");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const env = withBrokerOwner(buildEnv(binDir), "cancel-interrupt");
  const launched = run("node", [SCRIPT, "task", "--background", "--json", "investigate the flaky worker timeout"], {
    cwd: repo,
    env
  });

  assert.equal(launched.status, 0, launched.stderr);
  const launchPayload = JSON.parse(launched.stdout);
  const jobId = launchPayload.jobId;
  assert.ok(jobId);

  const stateDir = resolveStateDir(repo);
  const runningJob = await waitFor(() => {
    const state = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
    const job = state.jobs.find((candidate) => candidate.id === jobId);
    if (job?.status === "running" && job.threadId && job.turnId) {
      return job;
    }
    return null;
  }, { timeoutMs: 15000 });

  const cancelResult = run("node", [SCRIPT, "cancel", jobId, "--json"], {
    cwd: repo,
    env
  });

  assert.equal(cancelResult.status, 0, cancelResult.stderr);
  const cancelPayload = JSON.parse(cancelResult.stdout);
  assert.equal(cancelPayload.status, "cancelled");
  assert.equal(cancelPayload.turnInterruptAttempted, true);
  assert.equal(cancelPayload.turnInterrupted, true);

  await waitFor(() => {
    const fakeState = JSON.parse(fs.readFileSync(fakeStatePath, "utf8"));
    return fakeState.lastInterrupt ?? null;
  });

  const fakeState = JSON.parse(fs.readFileSync(fakeStatePath, "utf8"));
  assert.deepEqual(fakeState.lastInterrupt, {
    threadId: runningJob.threadId,
    turnId: runningJob.turnId
  });

  const cleanup = run("node", [SESSION_HOOK, "SessionEnd"], {
    cwd: repo,
    env,
    input: JSON.stringify({
      hook_event_name: "SessionEnd",
      cwd: repo
    })
  });
  assert.equal(cleanup.status, 0, cleanup.stderr);
});

test("session end fully cleans up jobs for the ending session", async (t) => {
  const repo = makeTempDir();
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const stateDir = resolveStateDir(repo);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  const completedLog = path.join(jobsDir, "completed.log");
  const runningLog = path.join(jobsDir, "running.log");
  const otherSessionLog = path.join(jobsDir, "other.log");
  const completedJobFile = path.join(jobsDir, "review-completed.json");
  const runningJobFile = path.join(jobsDir, "review-running.json");
  const otherJobFile = path.join(jobsDir, "review-other.json");
  fs.writeFileSync(completedLog, "completed\n", "utf8");
  fs.writeFileSync(runningLog, "running\n", "utf8");
  fs.writeFileSync(otherSessionLog, "other\n", "utf8");
  fs.writeFileSync(completedJobFile, JSON.stringify({ id: "review-completed" }, null, 2), "utf8");
  fs.writeFileSync(otherJobFile, JSON.stringify({ id: "review-other" }, null, 2), "utf8");

  const sleeper = spawn(process.execPath, ["-e", SELF_EXPIRING_KEEPALIVE], {
    cwd: repo,
    detached: true,
    stdio: "ignore"
  });
  sleeper.unref();
  const ownershipSnapshot = captureProcessOwnership(sleeper.pid, { cwd: repo });
  const sleeperIdentity = ownershipSnapshot?.rootIdentity ?? (process.platform === "win32" ? getWindowsProcessIdentity(sleeper.pid) : null);
  fs.writeFileSync(
    runningJobFile,
    JSON.stringify(
      {
        id: "review-running",
        pid: sleeper.pid,
        processIdentity: sleeperIdentity,
        ownershipSnapshot
      },
      null,
      2
    ),
    "utf8"
  );

  t.after(() => {
    try {
      process.kill(-sleeper.pid, "SIGTERM");
    } catch {
      try {
        process.kill(sleeper.pid, "SIGTERM");
      } catch {
        // Ignore missing process.
      }
    }
  });

  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: "review-completed",
            status: "completed",
            title: "Codex Review",
            sessionId: "sess-current",
            logFile: completedLog,
            createdAt: "2026-03-18T15:30:00.000Z",
            updatedAt: "2026-03-18T15:31:00.000Z"
          },
          {
            id: "review-running",
            status: "running",
            title: "Codex Review",
            sessionId: "sess-current",
            pid: sleeper.pid,
            processIdentity: sleeperIdentity,
            ownershipSnapshot,
            logFile: runningLog,
            createdAt: "2026-03-18T15:32:00.000Z",
            updatedAt: "2026-03-18T15:33:00.000Z"
          },
          {
            id: "review-other",
            status: "completed",
            title: "Codex Review",
            sessionId: "sess-other",
            logFile: otherSessionLog,
            createdAt: "2026-03-18T15:34:00.000Z",
            updatedAt: "2026-03-18T15:35:00.000Z"
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const result = run("node", [SESSION_HOOK, "SessionEnd"], {
    cwd: repo,
    env: {
      ...process.env,
      CODEX_COMPANION_SESSION_ID: "sess-current"
    },
    input: JSON.stringify({
      hook_event_name: "SessionEnd",
      session_id: "sess-current",
      cwd: repo
    })
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(otherSessionLog), true);
  assert.equal(fs.existsSync(otherJobFile), true);
  assert.deepEqual(
    fs.readdirSync(path.dirname(otherJobFile)).sort(),
    [path.basename(otherJobFile), path.basename(otherSessionLog)].sort()
  );

  await waitFor(() => {
    try {
      process.kill(sleeper.pid, 0);
      return false;
    } catch (error) {
      return error?.code === "ESRCH";
    }
  });

  const state = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
  assert.deepEqual(state.jobs.map((job) => job.id), ["review-other"]);
  const otherJob = state.jobs[0];
  assert.equal(otherJob.logFile, otherSessionLog);
});

test("stop hook runs a stop-time review task and blocks on findings when the review gate is enabled", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const fakeStatePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const setup = run("node", [SCRIPT, "setup", "--enable-review-gate", "--json"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(setup.status, 0, setup.stderr);
  const setupPayload = JSON.parse(setup.stdout);
  assert.equal(setupPayload.reviewGateEnabled, true);

  const taskResult = run("node", [SCRIPT, "task", "--write", "fix the issue"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(taskResult.status, 0, taskResult.stderr);

  const blocked = run("node", [STOP_HOOK], {
    cwd: repo,
    env: buildEnv(binDir),
    input: JSON.stringify({
      cwd: repo,
      session_id: "sess-stop-review",
      last_assistant_message: "I completed the refactor and updated the retry logic."
    })
  });
  assert.equal(blocked.status, 0, blocked.stderr);
  const blockedPayload = JSON.parse(blocked.stdout);
  assert.equal(blockedPayload.decision, "block");
  assert.match(blockedPayload.reason, /Codex stop-time review found issues that still need fixes/i);
  assert.match(blockedPayload.reason, /Missing empty-state guard/i);

  const fakeState = JSON.parse(fs.readFileSync(fakeStatePath, "utf8"));
  assert.match(fakeState.lastTurnStart.prompt, /<task>/i);
  assert.match(fakeState.lastTurnStart.prompt, /<compact_output_contract>/i);
  assert.match(fakeState.lastTurnStart.prompt, /Only review the work from the previous Claude turn/i);
  assert.match(fakeState.lastTurnStart.prompt, /I completed the refactor and updated the retry logic\./);

  const status = run("node", [SCRIPT, "status"], {
    cwd: repo,
    env: {
      ...buildEnv(binDir),
      CODEX_COMPANION_SESSION_ID: "sess-stop-review"
    }
  });
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /Codex Stop Gate Review/);
});

test("stop hook logs running tasks to stderr without blocking when the review gate is disabled", () => {
  const repo = makeTempDir();
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const stateDir = resolveStateDir(repo);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  const runningLog = path.join(jobsDir, "task-running.log");
  fs.writeFileSync(runningLog, "running\n", "utf8");

  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        config: {
          stopReviewGate: false
        },
        jobs: [
          {
            id: "task-live",
            status: "running",
            title: "Codex Task",
            jobClass: "task",
            sessionId: "sess-current",
            logFile: runningLog,
            createdAt: "2026-03-18T15:32:00.000Z",
            updatedAt: "2026-03-18T15:33:00.000Z"
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const blocked = run("node", [STOP_HOOK], {
    cwd: repo,
    env: {
      ...process.env,
      CODEX_COMPANION_SESSION_ID: "sess-current"
    },
    input: JSON.stringify({ cwd: repo })
  });

  assert.equal(blocked.status, 0, blocked.stderr);
  assert.equal(blocked.stdout.trim(), "");
  assert.match(blocked.stderr, /Codex task task-live is still running/i);
  assert.match(blocked.stderr, /\/codex:status/i);
  assert.match(blocked.stderr, /\/codex:cancel task-live/i);
});

test("stop hook allows the stop when the review gate is enabled and the stop-time review task is clean", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "adversarial-clean");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const setup = run("node", [SCRIPT, "setup", "--enable-review-gate", "--json"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(setup.status, 0, setup.stderr);

  const allowed = run("node", [STOP_HOOK], {
    cwd: repo,
    env: buildEnv(binDir),
    input: JSON.stringify({ cwd: repo, session_id: "sess-stop-clean" })
  });

  assert.equal(allowed.status, 0, allowed.stderr);
  assert.equal(allowed.stdout.trim(), "");
});

test("stop hook does not block when Codex is unavailable even if the review gate is enabled", () => {
  const repo = makeTempDir();
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const setup = run(process.execPath, [SCRIPT, "setup", "--enable-review-gate", "--json"], {
    cwd: repo
  });
  assert.equal(setup.status, 0, setup.stderr);

  const allowed = run(process.execPath, [STOP_HOOK], {
    cwd: repo,
    env: {
      ...process.env,
      PATH: ""
    },
    input: JSON.stringify({ cwd: repo })
  });

  assert.equal(allowed.status, 0, allowed.stderr);
  assert.equal(allowed.stdout.trim(), "");
  assert.match(allowed.stderr, /Codex is not set up for the review gate/i);
  assert.match(allowed.stderr, /Run \/codex:setup/i);
});

test("stop hook runs the actual task when auth status looks stale", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "refreshable-auth");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const setup = run("node", [SCRIPT, "setup", "--enable-review-gate", "--json"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(setup.status, 0, setup.stderr);

  const allowed = run("node", [STOP_HOOK], {
    cwd: repo,
    env: buildEnv(binDir),
    input: JSON.stringify({ cwd: repo })
  });

  assert.equal(allowed.status, 0, allowed.stderr);
  assert.doesNotMatch(allowed.stderr, /Codex is not set up for the review gate/i);
  const payload = JSON.parse(allowed.stdout);
  assert.equal(payload.decision, "block");
  assert.match(payload.reason, /Missing empty-state guard/i);
});

test("commands lazily start and reuse one shared app-server after first use", async () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const fakeStatePath = path.join(binDir, "fake-codex-state.json");

  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");

  const env = withBrokerOwner(buildEnv(binDir), "lazy-reuse");

  const review = run("node", [SCRIPT, "review"], {
    cwd: repo,
    env
  });
  assert.equal(review.status, 0, review.stderr);

  const brokerSession = loadBrokerSession(repo);
  if (!brokerSession) {
    return;
  }

  const adversarial = run("node", [SCRIPT, "adversarial-review"], {
    cwd: repo,
    env
  });
  assert.equal(adversarial.status, 0, adversarial.stderr);

  const fakeState = JSON.parse(fs.readFileSync(fakeStatePath, "utf8"));
  assert.equal(fakeState.appServerStarts, 1);

  const cleanup = run("node", [SESSION_HOOK, "SessionEnd"], {
    cwd: repo,
    env,
    input: JSON.stringify({
      hook_event_name: "SessionEnd",
      cwd: repo
    })
  });
  assert.equal(cleanup.status, 0, cleanup.stderr);
});

test("shared broker clears a disconnected stream after its request rejects", async (t) => {
  if (process.platform === "win32") {
    // Without a shared broker both clients get private app-servers, so the
    // stream-clearing contract under test is never exercised here — and the
    // spawned cmd.exe -> codex.cmd stdio chain is unreliable on CI runners.
    t.skip("Unix broker sockets are required for this contract.");
    return;
  }
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const fakeStatePath = path.join(binDir, "fake-codex-state.json");

  installSlowRejectFakeCodex(binDir);
  const env = withBrokerOwner({
    ...buildEnv(binDir),
    CODEX_COMPANION_BROKER_CHILD_IDLE_MS: "1000"
  }, "disconnected-stream");
  t.after(() => {
    run("node", [SESSION_HOOK, "SessionEnd"], {
      cwd: repo,
      env,
      input: JSON.stringify({ hook_event_name: "SessionEnd", cwd: repo })
    });
  });

  const clientA = await CodexAppServerClient.connect(repo, { env });
  const started = await clientA.request("thread/start", { cwd: repo, ephemeral: true });
  const pendingTurn = clientA
    .request("turn/start", {
      threadId: started.thread.id,
      input: [{ type: "text", text: "reject this turn after the client disconnects" }]
    })
    .catch(() => null);

  // 15s windows: the fake app-server's reject round-trip regularly exceeds
  // the 5s default on loaded CI runners.
  await waitFor(() => {
    if (!fs.existsSync(fakeStatePath)) {
      return false;
    }
    return JSON.parse(fs.readFileSync(fakeStatePath, "utf8")).turnRejectPending === true;
  }, { timeoutMs: 15000 });
  await clientA.close();
  await pendingTurn;

  await waitFor(() => {
    if (!fs.existsSync(fakeStatePath)) {
      return false;
    }
    return JSON.parse(fs.readFileSync(fakeStatePath, "utf8")).turnRejectSent === true;
  }, { timeoutMs: 15000 });

  const clientB = await CodexAppServerClient.connect(repo, { env });
  t.after(() => clientB.close().catch(() => {}));
  const response = await waitFor(async () => {
    try {
      return await clientB.request("thread/list", { cwd: repo });
    } catch (error) {
      if (error.rpcCode === -32001) {
        return false;
      }
      throw error;
    }
    // 5000ms, not 1500: the broker child restart behind this request takes
    // longer than 1.5s on loaded CI runners.
  }, { timeoutMs: 5000, intervalMs: 20 });
  assert.ok(Array.isArray(response.data));
});

test("shared broker cleans up an app-server whose initialization returns an RPC error", async (t) => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const fakeStatePath = path.join(binDir, "fake-codex-state.json");

  installInitializeErrorFakeCodex(binDir);
  const env = withBrokerOwner({
    ...buildEnv(binDir),
    CODEX_COMPANION_BROKER_CHILD_IDLE_MS: "100"
  }, "initialize-error");
  const brokerSession = await ensureBrokerSession(repo, { env });
  t.after(() => {
    if (brokerSession) {
      run("node", [SESSION_HOOK, "SessionEnd"], {
        cwd: repo,
        env,
        input: JSON.stringify({ hook_event_name: "SessionEnd", cwd: repo })
      });
    }
    if (fs.existsSync(fakeStatePath)) {
      const state = JSON.parse(fs.readFileSync(fakeStatePath, "utf8"));
      for (const pid of state.appServerPids || []) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // Ignore children already terminated by the cleanup path.
        }
      }
    }
  });

  async function requestUntilInitializationFails() {
    const request = brokerSession
      ? (() => {
          const client = CodexAppServerClient.connect(repo, { env });
          return client.then((connectedClient) => connectedClient.request("thread/list", { cwd: repo }));
        })()
      : CodexAppServerClient.connect(repo, { env, disableBroker: true });
    await assert.rejects(
      request,
      (error) =>
        (error.rpcCode === -32010 && /initialize failed/.test(error.message)) ||
        (error.rpcCode === -32002 && /refusing to spawn a replacement child/i.test(error.message))
    );
  }

  function loadFakeState() {
    return JSON.parse(fs.readFileSync(fakeStatePath, "utf8"));
  }

  function isLive(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return error?.code !== "ESRCH";
    }
  }

  await requestUntilInitializationFails();
  await waitFor(() => {
    const state = loadFakeState();
    return state.appServerStarts === 1 && state.appServerPids?.length === 1 && !isLive(state.appServerPids[0]);
  });

  await requestUntilInitializationFails();
  await waitFor(() => {
    const state = loadFakeState();
    return state.appServerStarts <= 2 && state.appServerPids?.length <= 2 && state.appServerPids.every((pid) => !isLive(pid));
  });
});

test("shared broker releases its idle app-server child and restarts it on demand", async (t) => {
  if (process.platform === "win32") {
    t.skip("Unix broker sockets are required for this contract.");
    return;
  }
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const fakeStatePath = path.join(binDir, "fake-codex-state.json");

  installFakeCodex(binDir, "with-helper-child");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");

  const env = withBrokerOwner({
    ...buildEnv(binDir),
    CODEX_COMPANION_BROKER_CHILD_IDLE_MS: "100"
  }, "idle-child");

  const review = run("node", [SCRIPT, "review"], {
    cwd: repo,
    env
  });
  assert.equal(review.status, 0, review.stderr);

  const firstSession = loadBrokerSession(repo);
  assert.ok(firstSession?.pid);
  t.after(() => {
    run("node", [SESSION_HOOK, "SessionEnd"], {
      cwd: repo,
      env,
      input: JSON.stringify({
        hook_event_name: "SessionEnd",
        cwd: repo
      })
    });
    if (fs.existsSync(fakeStatePath)) {
      const fakeState = JSON.parse(fs.readFileSync(fakeStatePath, "utf8"));
      for (const helperPid of fakeState.helperPids || []) {
        try {
          process.kill(helperPid, "SIGTERM");
        } catch {
          // Ignore helpers already terminated with their app-server group.
        }
      }
    }
  });

  const firstFakeState = JSON.parse(fs.readFileSync(fakeStatePath, "utf8"));
  const firstHelperPid = firstFakeState.helperPids?.[0];
  assert.ok(firstHelperPid);
  await waitFor(() => {
    try {
      process.kill(firstHelperPid, 0);
      return false;
    } catch (error) {
      return error?.code === "ESRCH";
    }
  });

  const adversarial = run("node", [SCRIPT, "adversarial-review"], {
    cwd: repo,
    env
  });
  assert.equal(adversarial.status, 0, adversarial.stderr);

  const secondSession = loadBrokerSession(repo);
  assert.equal(secondSession?.pid, firstSession.pid);
  const fakeState = JSON.parse(fs.readFileSync(fakeStatePath, "utf8"));
  assert.equal(fakeState.appServerStarts, 2);
  assert.equal(fakeState.helperPids.length, 2);
});

test("identity capture failure prevents app-server activation and reports unverified cleanup", async (t) => {
  if (process.platform === "win32") {
    t.skip("Unix process identities are required for identity-capture gating.");
    return;
  }
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const fakeStatePath = path.join(binDir, "fake-codex-state.json");

  installFakeCodex(binDir, "with-helper-child");
  const env = buildEnv(binDir);
  await assert.rejects(
    CodexAppServerClient.connect(repo, {
      disableBroker: true,
      env,
      captureProcessOwnershipImpl() {
        throw new Error("identity lookup injected failure");
      }
    }),
    (error) => error.cleanupOutcome?.verified === false && error.cleanupOutcome?.degraded === true
  );

  assert.equal(fs.existsSync(fakeStatePath), false);
});

test("a broker-owned app-server cannot activate before durable child publication", async () => {
  if (process.platform === "win32") {
    return;
  }
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const fakeStatePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir, "with-helper-child");
  const env = buildEnv(binDir);
  let wrapperPid = null;

  await assert.rejects(
    CodexAppServerClient.connect(repo, {
      disableBroker: true,
      gatedBrokerChild: true,
      env,
      beforeAppServerActivation(ownershipSnapshot) {
        wrapperPid = ownershipSnapshot.rootPid;
        assert.equal(fs.existsSync(fakeStatePath), false);
        throw new Error("injected durable child publication failure");
      }
    }),
    /durable child publication failure/
  );

  assert.ok(Number.isFinite(wrapperPid));
  assert.equal(fs.existsSync(fakeStatePath), false);
  await waitFor(() => getProcessIdentity(wrapperPid) === null);
});

test("shared broker keeps active work alive after its client disconnects", async (t) => {
  if (process.platform === "win32") {
    t.skip("Unix broker sockets are required for this contract.");
    return;
  }
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const fakeStatePath = path.join(binDir, "fake-codex-state.json");

  installFakeCodex(binDir, "slow-task-with-helper-child");
  instrumentSlowFakeTurnState(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const env = withBrokerOwner({
    ...buildEnv(binDir),
    CODEX_COMPANION_BROKER_CHILD_IDLE_MS: "100"
  }, "active-work");
  t.after(() => {
    run("node", [SESSION_HOOK, "SessionEnd"], {
      cwd: repo,
      env,
      input: JSON.stringify({ hook_event_name: "SessionEnd", cwd: repo })
    });
  });

  const client = await CodexAppServerClient.connect(repo, { env });
  const started = await client.request("thread/start", { cwd: repo, ephemeral: true });
  await client.request("turn/start", {
    threadId: started.thread.id,
    input: [{ type: "text", text: "finish after the client disconnects" }]
  });
  await client.close();

  const initialState = JSON.parse(fs.readFileSync(fakeStatePath, "utf8"));
  const helperPid = initialState.helperPids?.[0];
  assert.ok(helperPid);

  await waitFor(() => {
    if (JSON.parse(fs.readFileSync(fakeStatePath, "utf8")).turnInFlight !== true) {
      return false;
    }
    try {
      process.kill(helperPid, 0);
      return true;
    } catch {
      return false;
    }
  });

  await waitFor(() => {
    try {
      process.kill(helperPid, 0);
      return false;
    } catch (error) {
      return error?.code === "ESRCH";
    }
  });
});

test("setup reuses an existing shared app-server without starting another one", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const fakeStatePath = path.join(binDir, "fake-codex-state.json");

  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");

  const env = withBrokerOwner(buildEnv(binDir), "setup-reuse");

  const review = run("node", [SCRIPT, "review"], {
    cwd: repo,
    env
  });
  assert.equal(review.status, 0, review.stderr);

  const brokerSession = loadBrokerSession(repo);
  if (!brokerSession) {
    return;
  }

  const setup = run("node", [SCRIPT, "setup", "--json"], {
    cwd: repo,
    env
  });
  assert.equal(setup.status, 0, setup.stderr);

  const fakeState = JSON.parse(fs.readFileSync(fakeStatePath, "utf8"));
  assert.equal(fakeState.appServerStarts, 1);

  const cleanup = run("node", [SESSION_HOOK, "SessionEnd"], {
    cwd: repo,
    env,
    input: JSON.stringify({
      hook_event_name: "SessionEnd",
      cwd: repo
    })
  });
  assert.equal(cleanup.status, 0, cleanup.stderr);
});

test("status reports shared session runtime when a lazy broker is active", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");

  const env = withBrokerOwner(buildEnv(binDir), "status-runtime");
  const review = run("node", [SCRIPT, "review"], {
    cwd: repo,
    env
  });
  assert.equal(review.status, 0, review.stderr);

  if (!loadBrokerSession(repo)) {
    return;
  }

  const result = run("node", [SCRIPT, "status"], {
    cwd: repo,
    env
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Session runtime: shared session/);

  const unownedResult = run("node", [SCRIPT, "status"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(unownedResult.status, 0, unownedResult.stderr);
  assert.match(unownedResult.stdout, /Session runtime: direct startup/);
});

test("setup and status ignore an unregistered saved runtime", () => {
  const targetWorkspace = makeTempDir();
  const invocationWorkspace = makeTempDir();

  saveBrokerSession(targetWorkspace, {
    endpoint: "unix:/tmp/fake-broker.sock"
  });

  const status = run("node", [SCRIPT, "status", "--cwd", targetWorkspace], {
    cwd: invocationWorkspace
  });
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /Session runtime: direct startup/);

  const setup = run("node", [SCRIPT, "setup", "--cwd", targetWorkspace, "--json"], {
    cwd: invocationWorkspace
  });
  assert.equal(setup.status, 0, setup.stderr);
  const payload = JSON.parse(setup.stdout);
  assert.equal(payload.sessionRuntime.mode, "direct");
  assert.equal(payload.sessionRuntime.endpoint, null);
});
