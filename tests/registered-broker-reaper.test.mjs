import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  acquireBrokerRegistryLock as acquireBrokerRegistryLockImpl,
  loadBrokerChildren,
  publishBrokerChild as publishBrokerChildImpl,
  publishBrokerRegistration,
  registerBrokerOwner as registerBrokerOwnerImpl,
  releaseBrokerOwner as releaseBrokerOwnerImpl,
  releaseBrokerRegistryLock
} from "../plugins/codex/scripts/lib/broker-ownership.mjs";
import { runRegisteredBrokerReaper as runRegisteredBrokerReaperImpl } from "../plugins/codex/scripts/registered-broker-reaper.mjs";

const TEST_LOCK_PID = 4950;
const TEST_LOCK_IDENTITY = "4950@Mon Jul 27 00:00:50 2026";

function withTestRegistryLock(options = {}) {
  return {
    pid: options.pid ?? TEST_LOCK_PID,
    pidIdentity: options.pidIdentity ?? TEST_LOCK_IDENTITY,
    hasLiveProcessIdentityImpl: () => true,
    ...options
  };
}

function acquireBrokerRegistryLock(registration, options = {}) {
  return acquireBrokerRegistryLockImpl(registration, withTestRegistryLock(options));
}

function publishBrokerChild(registration, options = {}) {
  return publishBrokerChildImpl(registration, withTestRegistryLock(options));
}

function registerBrokerOwner(registration, options = {}) {
  return registerBrokerOwnerImpl(registration, withTestRegistryLock(options));
}

function releaseBrokerOwner(registration, options = {}) {
  return releaseBrokerOwnerImpl(registration, withTestRegistryLock(options));
}

function runRegisteredBrokerReaper(options = {}) {
  return runRegisteredBrokerReaperImpl({
    ...options,
    acquireBrokerRegistryLockImpl:
      options.acquireBrokerRegistryLockImpl ?? ((registration) => acquireBrokerRegistryLock(registration))
  });
}

function ownerEnv(env, sessionId, pid) {
  const startedAt = `Mon Jul 27 00:${String(pid % 60).padStart(2, "0")}:00 2026`;
  return {
    ...env,
    CODEX_COMPANION_SESSION_ID: sessionId,
    CODEX_COMPANION_SESSION_OWNER_PID: String(pid),
    CODEX_COMPANION_SESSION_OWNER_IDENTITY: `${pid}@${startedAt}`
  };
}

function snapshot(pid, minute) {
  const startedAt = `Mon Jul 27 01:${String(minute).padStart(2, "0")}:00 2026`;
  const identity = `${pid}@${startedAt}`;
  return {
    rootPid: pid,
    rootIdentity: identity,
    processGroupId: pid,
    members: [
      {
        pid,
        parentPid: 1,
        processGroupId: pid,
        state: "S",
        startedAt,
        identity,
        depth: 0
      }
    ]
  };
}

function makeFixture(t, { child = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "registered-broker-reaper-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = { CLAUDE_PLUGIN_DATA: root };
  const brokerSnapshot = snapshot(4100, 1);
  const registration = publishBrokerRegistration({
    cwd: root,
    endpoint: `unix:${path.join(root, "broker.sock")}`,
    pid: brokerSnapshot.rootPid,
    ownershipSnapshot: brokerSnapshot,
    env,
    now: () => "2026-07-27T01:01:00.000Z"
  });
  assert.equal(registration.registered, true);
  let childRecord = null;
  if (child) {
    childRecord = publishBrokerChild(registration, {
      ownershipSnapshot: snapshot(4200, 2),
      now: () => "2026-07-27T01:02:00.000Z"
    }).child;
  }
  return { root, env, registration, childRecord };
}

function addReleasedOwner(registration, env, sessionId = "session-released", pid = 5100) {
  const sessionEnv = ownerEnv(env, sessionId, pid);
  assert.equal(registerBrokerOwner(registration, { env: sessionEnv }).registered, true);
  assert.equal(releaseBrokerOwner(registration, { env: sessionEnv }).released, true);
}

test("report-only mode never calls a cleanup function for an eligible registry", async (t) => {
  const { env, registration } = makeFixture(t);
  addReleasedOwner(registration, env);
  let cleanupCalls = 0;
  const summary = await runRegisteredBrokerReaper({
    env,
    terminateProcessGroupImpl: async () => { cleanupCalls += 1; },
    terminateProcessTreeImpl: async () => { cleanupCalls += 1; }
  });
  assert.equal(summary.mode, "report-only");
  assert.equal(summary.reaped, 0);
  assert.equal(summary.results[0].reason, "eligible-but-apply-not-enabled");
  assert.equal(cleanupCalls, 0);
});

test("one live owner blocks cleanup even when every other owner is dead", async (t) => {
  const { env, registration } = makeFixture(t);
  const live = ownerEnv(env, "session-live", 5200);
  const dead = ownerEnv(env, "session-dead", 5300);
  registerBrokerOwner(registration, { env: live });
  registerBrokerOwner(registration, { env: dead });
  let cleanupCalls = 0;
  const summary = await runRegisteredBrokerReaper({
    mode: "apply-registered",
    env,
    getLiveProcessPidsImpl(pids, options) {
      return pids.filter((pid) => pid === 5200 && options.identities.some((identity) => identity.startsWith("5200@")));
    },
    terminateProcessTreeImpl: async () => { cleanupCalls += 1; }
  });
  assert.equal(summary.results[0].reason, "live-owner");
  assert.equal(cleanupCalls, 0);
});

test("registered cleanup reclaims children before the broker and writes a mode-0600 receipt", async (t) => {
  const { env, registration, childRecord } = makeFixture(t, { child: true });
  addReleasedOwner(registration, env);
  const calls = [];
  const summary = await runRegisteredBrokerReaper({
    mode: "apply-registered",
    env,
    getLiveProcessPidsImpl: () => [],
    terminateProcessGroupImpl: async (pgid, options) => {
      calls.push(`group:${pgid}:${options.ownershipSnapshot.rootIdentity}`);
      return { attempted: true, delivered: true, verified: true, degraded: false, targetIdentities: [childRecord.pidIdentity] };
    },
    terminateProcessTreeImpl: async (pid, options) => {
      calls.push(`tree:${pid}:${options.expectedRootIdentity}`);
      return { attempted: true, delivered: true, verified: true, degraded: false, targetIdentities: [options.expectedRootIdentity] };
    },
    attemptIdFactory: () => "attempt-success",
    now: () => "2026-07-27T02:00:00.000Z"
  });
  assert.equal(summary.reaped, 1);
  assert.deepEqual(calls, [
    `group:4200:${childRecord.pidIdentity}`,
    `tree:4100:${registration.broker.pidIdentity}`
  ]);
  const receiptPath = summary.results[0].receiptPath;
  assert.ok(receiptPath);
  assert.equal(fs.statSync(receiptPath).mode & 0o777, 0o600);
  assert.equal(JSON.parse(fs.readFileSync(receiptPath, "utf8")).decision, "cleanup-verified");

  const receiptNames = fs.readdirSync(path.dirname(receiptPath));
  const repeated = await runRegisteredBrokerReaper({
    mode: "apply-registered",
    env,
    getLiveProcessPidsImpl: () => [],
    terminateProcessGroupImpl: async () => {
      throw new Error("a terminal registry must not retry child cleanup");
    },
    terminateProcessTreeImpl: async () => {
      throw new Error("a terminal registry must not retry broker cleanup");
    },
    attemptIdFactory: () => "attempt-should-not-run"
  });
  assert.equal(repeated.scanned, 0);
  assert.deepEqual(fs.readdirSync(path.dirname(receiptPath)), receiptNames);
});

test("each verified child is released before a later target can block convergence", async (t) => {
  const { env, registration } = makeFixture(t, { child: true });
  publishBrokerChild(registration, {
    ownershipSnapshot: snapshot(4300, 3),
    now: () => "2026-07-27T01:03:00.000Z"
  });
  addReleasedOwner(registration, env);
  const orderedChildren = loadBrokerChildren(registration).children;
  assert.equal(orderedChildren.length, 2);
  const firstProcessedChild = orderedChildren[0];
  const blockedChild = orderedChildren[1];

  let firstPassGroupCalls = 0;
  let firstPassBrokerCalls = 0;
  const firstPass = await runRegisteredBrokerReaper({
    mode: "apply-registered",
    env,
    getLiveProcessPidsImpl: () => [],
    terminateProcessGroupImpl: async () => {
      firstPassGroupCalls += 1;
      if (firstPassGroupCalls === 1) {
        return { attempted: true, delivered: true, verified: true, degraded: false, survivors: [], survivorIdentities: [] };
      }
      return { attempted: true, delivered: true, verified: false, degraded: true, survivors: [blockedChild.pid], survivorIdentities: [blockedChild.pidIdentity] };
    },
    terminateProcessTreeImpl: async () => { firstPassBrokerCalls += 1; },
    attemptIdFactory: () => "attempt-partial-child-release"
  });
  assert.equal(firstPass.reaped, 0);
  assert.equal(firstPassGroupCalls, 2);
  assert.equal(firstPassBrokerCalls, 0);
  const afterFirstPass = loadBrokerChildren(registration);
  assert.equal(afterFirstPass.valid, true);
  assert.deepEqual(afterFirstPass.releasedChildren.map((child) => child.childKey), [firstProcessedChild.childKey]);
  assert.deepEqual(afterFirstPass.children.map((child) => child.childKey), [blockedChild.childKey]);

  const secondPassCalls = [];
  const secondPass = await runRegisteredBrokerReaper({
    mode: "apply-registered",
    env,
    getLiveProcessPidsImpl: () => [],
    terminateProcessGroupImpl: async (pgid) => {
      secondPassCalls.push(`group:${pgid}`);
      return { attempted: true, delivered: true, verified: true, degraded: false, survivors: [], survivorIdentities: [] };
    },
    terminateProcessTreeImpl: async (pid) => {
      secondPassCalls.push(`tree:${pid}`);
      return { attempted: true, delivered: true, verified: true, degraded: false, survivors: [], survivorIdentities: [] };
    },
    attemptIdFactory: () => "attempt-converged-child-release"
  });
  assert.equal(secondPass.reaped, 1);
  assert.deepEqual(secondPassCalls, [`group:${blockedChild.processGroupId}`, `tree:${registration.broker.pid}`]);
});

test("a contended registry lock closes the registration-to-signal race", async (t) => {
  const { env, registration } = makeFixture(t);
  addReleasedOwner(registration, env);
  const lock = acquireBrokerRegistryLock(registration);
  t.after(() => releaseBrokerRegistryLock(registration, lock));
  let cleanupCalls = 0;
  const summary = await runRegisteredBrokerReaper({
    mode: "apply-registered",
    env,
    getLiveProcessPidsImpl: () => [],
    terminateProcessTreeImpl: async () => { cleanupCalls += 1; }
  });
  assert.equal(summary.results[0].reason, "registry-busy");
  assert.equal(cleanupCalls, 0);
});

test("the broker record is revalidated after the cleanup lock is acquired", async (t) => {
  const { env, registration } = makeFixture(t);
  addReleasedOwner(registration, env);
  let cleanupCalls = 0;
  const summary = await runRegisteredBrokerReaper({
    mode: "apply-registered",
    env,
    getLiveProcessPidsImpl: () => [],
    acquireBrokerRegistryLockImpl(candidate) {
      const lock = acquireBrokerRegistryLock(candidate);
      fs.unlinkSync(path.join(candidate.registryDir, "broker.json"));
      return lock;
    },
    terminateProcessTreeImpl: async () => { cleanupCalls += 1; }
  });
  assert.equal(summary.results[0].reason, "locked-broker-record-invalid");
  assert.equal(cleanupCalls, 0);
});

test("a reused or ambiguous child group blocks broker cleanup", async (t) => {
  const { env, registration } = makeFixture(t, { child: true });
  addReleasedOwner(registration, env);
  let brokerCleanupCalls = 0;
  const summary = await runRegisteredBrokerReaper({
    mode: "apply-registered",
    env,
    getLiveProcessPidsImpl: (pids) => pids,
    terminateProcessGroupImpl: async () => ({
      attempted: false,
      delivered: false,
      verified: false,
      degraded: true,
      identityMismatch: true
    }),
    terminateProcessTreeImpl: async () => { brokerCleanupCalls += 1; },
    attemptIdFactory: () => "attempt-child-reused"
  });
  assert.equal(summary.reaped, 0);
  assert.equal(summary.results[0].reason, "cleanup-unverified");
  assert.equal(brokerCleanupCalls, 0);
  assert.ok(summary.results[0].residualIdentities.length > 0);
});

test("malformed owner or child state is report-only", async (t) => {
  const ownerFixture = makeFixture(t);
  fs.mkdirSync(path.join(ownerFixture.registration.registryDir, "owners"), { recursive: true });
  fs.writeFileSync(path.join(ownerFixture.registration.registryDir, "owners", "bad.json"), "{}\n", "utf8");
  const ownerSummary = await runRegisteredBrokerReaper({
    mode: "apply-registered",
    env: ownerFixture.env,
    getLiveProcessPidsImpl: () => []
  });
  assert.equal(ownerSummary.results[0].reason, "malformed-registry");

  const childFixture = makeFixture(t);
  addReleasedOwner(childFixture.registration, childFixture.env);
  fs.mkdirSync(path.join(childFixture.registration.registryDir, "children"), { recursive: true });
  fs.writeFileSync(path.join(childFixture.registration.registryDir, "children", "bad.json"), "{}\n", "utf8");
  const childSummary = await runRegisteredBrokerReaper({
    mode: "apply-registered",
    env: childFixture.env,
    getLiveProcessPidsImpl: () => []
  });
  assert.equal(childSummary.results[0].reason, "malformed-child-registry");
});

test("missing and unregistered broker rows never reach a signal path", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "registered-broker-reaper-missing-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = { CLAUDE_PLUGIN_DATA: root };
  const registryRoot = path.join(root, "state", "broker-ownership-v1");
  const missingBrokerDir = path.join(registryRoot, "a".repeat(64));
  fs.mkdirSync(missingBrokerDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(registryRoot, 0o700);
  fs.chmodSync(missingBrokerDir, 0o700);
  let cleanupCalls = 0;
  const summary = await runRegisteredBrokerReaper({
    mode: "apply-registered",
    env,
    terminateProcessTreeImpl: async () => { cleanupCalls += 1; }
  });
  assert.equal(summary.results[0].reason, "broker-record-invalid");
  assert.equal(cleanupCalls, 0);

  const emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), "registered-broker-reaper-empty-"));
  t.after(() => fs.rmSync(emptyRoot, { recursive: true, force: true }));
  const empty = await runRegisteredBrokerReaper({
    mode: "apply-registered",
    env: { CLAUDE_PLUGIN_DATA: emptyRoot }
  });
  assert.equal(empty.scanned, 0);
});

test("an overly permissive registry root is report-only", async (t) => {
  const { env, registration } = makeFixture(t);
  addReleasedOwner(registration, env);
  const registryRoot = path.dirname(registration.registryDir);
  fs.chmodSync(registryRoot, 0o755);
  const summary = await runRegisteredBrokerReaper({
    mode: "apply-registered",
    env,
    getLiveProcessPidsImpl: () => [],
    terminateProcessTreeImpl: async () => {
      throw new Error("invalid roots must not reach cleanup");
    }
  });
  assert.equal(summary.reaped, 0);
  assert.equal(summary.results[0].reason, "registry-root-invalid");
});
