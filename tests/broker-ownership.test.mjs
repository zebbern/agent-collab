import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";

import {
  acquireBrokerRegistryLock as acquireBrokerRegistryLockImpl,
  assessBrokerOwners,
  loadBrokerChildren,
  publishBrokerChild as publishBrokerChildImpl,
  publishBrokerChildObservation as publishBrokerChildObservationImpl,
  publishBrokerRegistration,
  publishRegisteredBroker,
  registerBrokerOwner as registerBrokerOwnerImpl,
  releaseBrokerChild as releaseBrokerChildImpl,
  releaseBrokerOwner as releaseBrokerOwnerImpl,
  releaseBrokerRegistryLock,
  resolveBrokerOwnershipRoot
} from "../plugins/codex/scripts/lib/broker-ownership.mjs";

test("resolveBrokerOwnershipRoot derives from the canonical state root, ignoring CLAUDE_PLUGIN_DATA", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-broker-root-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  assert.equal(
    resolveBrokerOwnershipRoot({ CODEX_COMPANION_STATE_ROOT: root, CLAUDE_PLUGIN_DATA: path.join(root, "poison") }),
    path.join(root, "broker-ownership-v1")
  );
  // Without the override the registry exists under the per-user canonical
  // root — never disabled, never relocated by an ambient plugin-data dir.
  assert.equal(
    resolveBrokerOwnershipRoot({ CLAUDE_PLUGIN_DATA: path.join(root, "poison") }),
    path.join(os.homedir(), ".claude", "codex-companion", "broker-ownership-v1")
  );
});

const TEST_LOCK_PID = 4900;
const TEST_LOCK_IDENTITY = "4900@Mon Jul 27 00:00:40 2026";

function withTestRegistryLock(options = {}) {
  const pid = options.pid ?? TEST_LOCK_PID;
  const pidIdentity = options.pidIdentity ?? (pid === TEST_LOCK_PID
    ? TEST_LOCK_IDENTITY
    : `${pid}@Mon Jul 27 00:00:40 2026`);
  return {
    ...options,
    pid,
    pidIdentity,
    hasLiveProcessIdentityImpl: () => true,
    ...(options.hasLiveProcessIdentityImpl
      ? { hasLiveProcessIdentityImpl: options.hasLiveProcessIdentityImpl }
      : {})
  };
}

function acquireBrokerRegistryLock(registration, options = {}) {
  return acquireBrokerRegistryLockImpl(registration, withTestRegistryLock(options));
}

function registerBrokerOwner(registration, options = {}) {
  return registerBrokerOwnerImpl(registration, withTestRegistryLock(options));
}

function releaseBrokerOwner(registration, options = {}) {
  return releaseBrokerOwnerImpl(registration, withTestRegistryLock(options));
}

function publishBrokerChild(registration, options = {}) {
  return publishBrokerChildImpl(registration, withTestRegistryLock(options));
}

function publishBrokerChildObservation(registration, options = {}) {
  return publishBrokerChildObservationImpl(registration, withTestRegistryLock(options));
}

function releaseBrokerChild(registration, options = {}) {
  return releaseBrokerChildImpl(registration, withTestRegistryLock(options));
}

function makeFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-broker-ownership-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = { CODEX_COMPANION_STATE_ROOT: root };
  const brokerIdentity = "4100@Mon Jul 27 00:00:00 2026";
  const ownershipSnapshot = {
    rootPid: 4100,
    rootIdentity: brokerIdentity,
    processGroupId: 4100,
    members: [
      {
        pid: 4100,
        parentPid: 1,
        processGroupId: 4100,
        state: "S",
        startedAt: "Mon Jul 27 00:00:00 2026",
        identity: brokerIdentity,
        depth: 0
      }
    ]
  };
  const registration = publishBrokerRegistration({
    cwd: root,
    endpoint: `unix:${path.join(root, "broker.sock")}`,
    pid: 4100,
    ownershipSnapshot,
    env,
    now: () => "2026-07-27T00:00:00.000Z"
  });
  assert.equal(registration.registered, true);
  return { root, env, registration };
}

function ownerEnv(env, sessionId, pid, startedAt) {
  return {
    ...env,
    CODEX_COMPANION_SESSION_ID: sessionId,
    CODEX_COMPANION_SESSION_OWNER_PID: String(pid),
    CODEX_COMPANION_SESSION_OWNER_IDENTITY: `${pid}@${startedAt}`
  };
}

test("initial broker and owner records become visible atomically", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-broker-atomic-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = ownerEnv({ CODEX_COMPANION_STATE_ROOT: root }, "session-atomic", 5050, "Mon Jul 27 00:00:45 2026");
  const brokerIdentity = "4100@Mon Jul 27 00:00:00 2026";
  const registration = publishRegisteredBroker({
    cwd: root,
    endpoint: `unix:${path.join(root, "broker.sock")}`,
    pid: 4100,
    ownershipSnapshot: {
      rootPid: 4100,
      rootIdentity: brokerIdentity,
      processGroupId: 4100,
      members: []
    },
    env,
    now: () => "2026-07-27T00:00:00.000Z",
    hasLiveProcessIdentityImpl: (pid, identity) =>
      (pid === 5050 && identity === "5050@Mon Jul 27 00:00:45 2026") ||
      (pid === 4100 && identity === brokerIdentity)
  });

  assert.equal(registration.registered, true);
  assert.equal(fs.existsSync(path.join(registration.registryDir, "broker.json")), true);
  assert.equal(fs.readdirSync(path.join(registration.registryDir, "owners")).length, 1);
  assert.equal(fs.readdirSync(registration.registryRoot).some((name) => name.endsWith(".prepared")), false);
});

test("initial publication can make its transaction lock visible atomically", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-broker-atomic-lock-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const brokerIdentity = "4100@Mon Jul 27 00:00:00 2026";
  const registration = publishRegisteredBroker({
    cwd: root,
    endpoint: `unix:${path.join(root, "broker.sock")}`,
    pid: 4100,
    ownershipSnapshot: {
      rootPid: 4100,
      rootIdentity: brokerIdentity,
      processGroupId: 4100,
      members: []
    },
    env: ownerEnv({ CODEX_COMPANION_STATE_ROOT: root }, "session-atomic-lock", 5050, "Mon Jul 27 00:00:45 2026"),
    retainRegistryLock: true,
    hasLiveProcessIdentityImpl: () => true,
    getProcessIdentityImpl: (pid) => `${pid}@Mon Jul 27 00:00:41 2026`
  });

  assert.equal(registration.registered, true);
  assert.equal(registration.registryLock?.acquired, true);
  assert.equal(fs.existsSync(registration.registryLock.path), true);
  assert.equal(acquireBrokerRegistryLock(registration).acquired, false);
  assert.equal(releaseBrokerRegistryLock(registration, registration.registryLock).released, true);
});

test("missing owner identity prevents any broker registry publication", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-broker-no-owner-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const registration = publishRegisteredBroker({
    cwd: root,
    endpoint: `unix:${path.join(root, "broker.sock")}`,
    pid: 4100,
    ownershipSnapshot: {
      rootPid: 4100,
      rootIdentity: "4100@Mon Jul 27 00:00:00 2026",
      processGroupId: 4100,
      members: []
    },
    env: { CODEX_COMPANION_STATE_ROOT: root }
  });

  assert.deepEqual(registration, { registered: false, reason: "session-owner-unavailable" });
  assert.equal(fs.existsSync(path.join(root, "broker-ownership-v1")), false);
});

test("stale owner identity prevents any broker registry publication", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-broker-stale-owner-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const registration = publishRegisteredBroker({
    cwd: root,
    endpoint: `unix:${path.join(root, "broker.sock")}`,
    pid: 4100,
    ownershipSnapshot: {
      rootPid: 4100,
      rootIdentity: "4100@Mon Jul 27 00:00:00 2026",
      processGroupId: 4100,
      members: []
    },
    env: ownerEnv({ CODEX_COMPANION_STATE_ROOT: root }, "session-stale", 5050, "Mon Jul 27 00:00:45 2026"),
    hasLiveProcessIdentityImpl: () => false
  });

  assert.deepEqual(registration, { registered: false, reason: "session-owner-not-live" });
  assert.equal(fs.existsSync(path.join(root, "broker-ownership-v1")), false);
});

test("initial publication revalidates the sole owner after preparing registry bytes", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-broker-owner-revalidation-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = ownerEnv({ CODEX_COMPANION_STATE_ROOT: root }, "session-race", 5050, "Mon Jul 27 00:00:45 2026");
  let ownerChecks = 0;
  const registration = publishRegisteredBroker({
    cwd: root,
    endpoint: `unix:${path.join(root, "broker.sock")}`,
    pid: 4100,
    ownershipSnapshot: {
      rootPid: 4100,
      rootIdentity: "4100@Mon Jul 27 00:00:00 2026",
      processGroupId: 4100,
      members: []
    },
    env,
    hasLiveProcessIdentityImpl(pid) {
      if (pid === 5050) {
        ownerChecks += 1;
        return ownerChecks === 1;
      }
      return true;
    }
  });

  assert.deepEqual(registration, { registered: false, reason: "session-owner-not-live" });
  assert.equal(fs.existsSync(path.join(root, "broker-ownership-v1")), true);
  assert.deepEqual(fs.readdirSync(path.join(root, "broker-ownership-v1")), []);
});

test("initial publication revalidates the broker identity immediately before visibility", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-broker-process-revalidation-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = ownerEnv({ CODEX_COMPANION_STATE_ROOT: root }, "session-race", 5050, "Mon Jul 27 00:00:45 2026");
  const registration = publishRegisteredBroker({
    cwd: root,
    endpoint: `unix:${path.join(root, "broker.sock")}`,
    pid: 4100,
    ownershipSnapshot: {
      rootPid: 4100,
      rootIdentity: "4100@Mon Jul 27 00:00:00 2026",
      processGroupId: 4100,
      members: []
    },
    env,
    hasLiveProcessIdentityImpl(pid) {
      return pid === 5050;
    }
  });

  assert.deepEqual(registration, { registered: false, reason: "broker-not-live" });
  assert.deepEqual(fs.readdirSync(path.join(root, "broker-ownership-v1")), []);
});

test("owner publication revalidates the exact owner while holding the registry lock", (t) => {
  const { registration, env } = makeFixture(t);
  const sessionEnv = ownerEnv(env, "session-revalidated", 5060, "Mon Jul 27 00:00:46 2026");
  const lockOptions = {
    pid: 5061,
    pidIdentity: "5061@Mon Jul 27 00:00:47 2026"
  };

  const rejectedCreate = registerBrokerOwner(registration, {
    env: sessionEnv,
    ...lockOptions,
    hasLiveProcessIdentityImpl: () => false
  });
  assert.deepEqual(rejectedCreate, { registered: false, reason: "session-owner-not-live" });

  const registered = registerBrokerOwner(registration, {
    env: sessionEnv,
    ...lockOptions,
    hasLiveProcessIdentityImpl: () => true
  });
  assert.equal(registered.registered, true);

  const rejectedExisting = registerBrokerOwner(registration, {
    env: sessionEnv,
    ...lockOptions,
    hasLiveProcessIdentityImpl: () => false
  });
  assert.deepEqual(rejectedExisting, { registered: false, reason: "session-owner-not-live" });
});

test("owner publication fails closed while cleanup holds the registry lock", (t) => {
  const { registration, env } = makeFixture(t);
  const lock = acquireBrokerRegistryLock(registration, {
    pid: 5000,
    now: () => "2026-07-27T00:00:30.000Z"
  });
  assert.equal(lock.acquired, true);
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(lock.path).mode & 0o777, 0o700);
  }

  const blocked = registerBrokerOwner(
    registration,
    {
      env: ownerEnv(env, "session-racing", 5050, "Mon Jul 27 00:00:45 2026"),
      getLiveProcessPidsImpl: () => [5000]
    }
  );
  assert.deepEqual(blocked, { registered: false, reason: "registry-busy" });

  assert.deepEqual(releaseBrokerRegistryLock(registration, lock), { released: true });
  const registered = registerBrokerOwner(
    registration,
    { env: ownerEnv(env, "session-racing", 5050, "Mon Jul 27 00:00:45 2026") }
  );
  assert.equal(registered.registered, true);
});

test("a well-formed lock whose creator is absent is quarantined before retry", (t) => {
  const { registration, env } = makeFixture(t);
  const stale = acquireBrokerRegistryLock(registration, {
    pid: 5001,
    now: () => "2026-07-27T00:00:31.000Z"
  });
  assert.equal(stale.acquired, true);

  const registered = registerBrokerOwner(registration, {
    env: ownerEnv(env, "session-after-stale-lock", 5051, "Mon Jul 27 00:00:46 2026"),
    hasLiveProcessIdentityImpl: (pid) => pid !== 5001
  });
  assert.equal(registered.registered, true);
  const staleRoot = path.join(registration.registryDir, "stale-locks");
  assert.equal(fs.readdirSync(staleRoot).length, 1);
  assert.equal(fs.existsSync(stale.path), false);
});

test("a reused lock-owner PID does not keep an abandoned registry lock busy", (t) => {
  const { registration } = makeFixture(t);
  const staleIdentity = "5006@Mon Jul 27 00:00:36 2026";
  const stale = acquireBrokerRegistryLock(registration, {
    pid: 5006,
    pidIdentity: staleIdentity,
    now: () => "2026-07-27T00:00:36.000Z"
  });
  assert.equal(stale.acquired, true);

  const contender = acquireBrokerRegistryLock(registration, {
    pid: 5007,
    pidIdentity: "5007@Mon Jul 27 00:00:37 2026",
    now: () => "2026-07-27T00:00:37.000Z",
    getLiveProcessPidsImpl: () => [5006],
    hasLiveProcessIdentityImpl(pid, identity) {
      assert.equal(pid, 5006);
      assert.equal(identity, staleIdentity);
      return false;
    }
  });

  assert.equal(contender.acquired, true);
  const owner = JSON.parse(fs.readFileSync(path.join(contender.path, "owner.json"), "utf8"));
  assert.equal(owner.pidIdentity, "5007@Mon Jul 27 00:00:37 2026");
  assert.deepEqual(releaseBrokerRegistryLock(registration, contender), { released: true });
});

test("a stale-lock contender cannot quarantine a replacement live lock", (t) => {
  const { registration } = makeFixture(t);
  const stale = acquireBrokerRegistryLock(registration, {
    pid: 5002,
    now: () => "2026-07-27T00:00:32.000Z"
  });
  assert.equal(stale.acquired, true);

  let replacement;
  let livenessChecks = 0;
  const contender = acquireBrokerRegistryLock(registration, {
    pid: 5004,
    now: () => "2026-07-27T00:00:34.000Z",
    hasLiveProcessIdentityImpl(pid) {
      livenessChecks += 1;
      if (livenessChecks === 1) {
        const staleRoot = path.join(registration.registryDir, "stale-locks");
        fs.mkdirSync(staleRoot, { recursive: true, mode: 0o700 });
        fs.chmodSync(staleRoot, 0o700);
        fs.renameSync(stale.path, path.join(staleRoot, `${5002}-${stale.token}`));
        replacement = acquireBrokerRegistryLock(registration, {
          pid: 5003,
          now: () => "2026-07-27T00:00:33.000Z"
        });
        assert.equal(replacement.acquired, true);
        return false;
      }
      return pid === 5003;
    }
  });

  assert.equal(contender.acquired, false);
  assert.equal(contender.reason, "registry-busy");
  const liveOwner = JSON.parse(fs.readFileSync(path.join(replacement.path, "owner.json"), "utf8"));
  assert.equal(liveOwner.token, replacement.token);
  assert.deepEqual(releaseBrokerRegistryLock(registration, replacement), { released: true });
});

test("registered broker with a live owner is not eligible for cleanup", (t) => {
  const { registration, env } = makeFixture(t);
  const liveOwner = ownerEnv(env, "session-live", 5100, "Mon Jul 27 00:01:00 2026");
  const owner = registerBrokerOwner(registration, { env: liveOwner, now: () => "2026-07-27T00:01:00.000Z" });

  const assessment = assessBrokerOwners(registration, {
    getLiveProcessPidsImpl(pids, options) {
      assert.deepEqual(pids, [5100]);
      assert.deepEqual(options.identities, ["5100@Mon Jul 27 00:01:00 2026"]);
      return [5100];
    }
  });

  assert.equal(owner.registered, true);
  assert.equal(assessment.safeToShutdown, false);
  assert.equal(assessment.reason, "live-owner");
  assert.deepEqual(assessment.liveOwners.map((candidate) => candidate.sessionId), ["session-live"]);
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(owner.path).mode & 0o777, 0o600);
  }
});

test("registered broker is eligible only after every owner is dead or released", (t) => {
  const { registration, env } = makeFixture(t);
  const ownerA = ownerEnv(env, "session-a", 5200, "Mon Jul 27 00:02:00 2026");
  const ownerB = ownerEnv(env, "session-b", 5300, "Mon Jul 27 00:03:00 2026");
  registerBrokerOwner(registration, { env: ownerA });
  registerBrokerOwner(registration, { env: ownerB });

  const mixed = assessBrokerOwners(registration, {
    getLiveProcessPidsImpl(pids) {
      return pids[0] === 5300 ? [5300] : [];
    }
  });
  assert.equal(mixed.safeToShutdown, false);
  assert.deepEqual(mixed.liveOwners.map((candidate) => candidate.sessionId), ["session-b"]);

  releaseBrokerOwner(registration, { env: ownerB, now: () => "2026-07-27T00:04:00.000Z" });
  const released = assessBrokerOwners(registration, {
    getLiveProcessPidsImpl() {
      return [];
    }
  });
  assert.equal(released.safeToShutdown, true);
  assert.equal(released.reason, "all-owners-dead-or-released");
  assert.deepEqual(released.releasedOwners.map((candidate) => candidate.sessionId), ["session-b"]);
});

test("owner PID reuse with a different identity does not keep a broker alive", (t) => {
  const { registration, env } = makeFixture(t);
  registerBrokerOwner(registration, {
    env: ownerEnv(env, "session-reused", 5400, "Mon Jul 27 00:05:00 2026")
  });

  const assessment = assessBrokerOwners(registration, {
    getLiveProcessPidsImpl() {
      return [];
    }
  });
  assert.equal(assessment.safeToShutdown, true);
  assert.deepEqual(assessment.deadOwners.map((candidate) => candidate.sessionId), ["session-reused"]);
});

test("malformed owner state blocks cleanup instead of being skipped", (t) => {
  const { registration } = makeFixture(t);
  const ownersDir = path.join(registration.registryDir, "owners");
  fs.mkdirSync(ownersDir, { recursive: true });
  fs.writeFileSync(path.join(ownersDir, "malformed.json"), "{not-json\n", { mode: 0o600 });

  const assessment = assessBrokerOwners(registration, {
    getLiveProcessPidsImpl() {
      throw new Error("malformed rows must stop before liveness checks");
    }
  });
  assert.equal(assessment.safeToShutdown, false);
  assert.equal(assessment.reason, "malformed-registry");
  assert.equal(assessment.malformed.length, 1);
});

test("symlinked or overly permissive registry rows block cleanup", (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX permission bits and unprivileged symlinks are required for this contract.");
    return;
  }
  const permissiveFixture = makeFixture(t);
  const registered = registerBrokerOwner(permissiveFixture.registration, {
    env: ownerEnv(permissiveFixture.env, "session-permissive", 5450, "Mon Jul 27 00:05:30 2026")
  });
  fs.chmodSync(registered.path, 0o644);
  const permissive = assessBrokerOwners(permissiveFixture.registration, {
    getLiveProcessPidsImpl: () => []
  });
  assert.equal(permissive.safeToShutdown, false);
  assert.equal(permissive.reason, "malformed-registry");

  const symlinkFixture = makeFixture(t);
  const ownersDir = path.join(symlinkFixture.registration.registryDir, "owners");
  fs.mkdirSync(ownersDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(ownersDir, 0o700);
  const target = path.join(symlinkFixture.root, "outside.json");
  fs.writeFileSync(target, "{}\n", { mode: 0o600 });
  fs.symlinkSync(target, path.join(ownersDir, "linked.json"));
  const symlinked = assessBrokerOwners(symlinkFixture.registration, {
    getLiveProcessPidsImpl: () => []
  });
  assert.equal(symlinked.safeToShutdown, false);
  assert.equal(symlinked.reason, "malformed-registry");
});

test("a broker record with no owner rows remains unregistered and report-only", (t) => {
  const { registration } = makeFixture(t);
  const assessment = assessBrokerOwners(registration, {
    getLiveProcessPidsImpl() {
      throw new Error("an ownerless broker must not reach liveness checks");
    }
  });
  assert.equal(assessment.safeToShutdown, false);
  assert.equal(assessment.reason, "no-registered-owner");
});

test("broker child ownership is immutable and identity keyed", (t) => {
  const { registration } = makeFixture(t);
  const childSnapshot = {
    rootPid: 6100,
    rootIdentity: "6100@Mon Jul 27 00:06:00 2026",
    processGroupId: 6100,
    members: [
      {
        pid: 6100,
        parentPid: 4100,
        processGroupId: 6100,
        state: "S",
        startedAt: "Mon Jul 27 00:06:00 2026",
        identity: "6100@Mon Jul 27 00:06:00 2026",
        depth: 0
      }
    ]
  };
  const first = publishBrokerChild(registration, {
    ownershipSnapshot: childSnapshot,
    now: () => "2026-07-27T00:06:00.000Z"
  });
  const second = publishBrokerChild(registration, {
    ownershipSnapshot: childSnapshot,
    now: () => "2026-07-27T00:06:00.000Z"
  });

  assert.equal(first.registered, true);
  assert.equal(second.path, first.path);
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(first.path).mode & 0o777, 0o600);
  }
  assert.deepEqual(JSON.parse(fs.readFileSync(first.path, "utf8")).ownershipSnapshot, childSnapshot);

  const refused = releaseBrokerChild(registration, {
    child: first.child,
    cleanupOutcome: { verified: false, survivors: [6100] }
  });
  assert.equal(refused.released, false);
  assert.equal(loadBrokerChildren(registration).children.length, 1);

  const released = releaseBrokerChild(registration, {
    child: first.child,
    cleanupOutcome: { verified: true, survivors: [], survivorIdentities: [] },
    now: () => "2026-07-27T00:07:00.000Z"
  });
  assert.equal(released.released, true);
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(released.path).mode & 0o777, 0o600);
  }
  const children = loadBrokerChildren(registration);
  assert.equal(children.children.length, 0);
  assert.equal(children.releasedChildren.length, 1);
});

test("post-activation child observations extend durable cleanup ownership", (t) => {
  const { registration } = makeFixture(t);
  const rootIdentity = "6200@Mon Jul 27 00:08:00 2026";
  const child = publishBrokerChild(registration, {
    ownershipSnapshot: {
      rootPid: 6200,
      rootIdentity,
      processGroupId: 6200,
      members: [
        {
          pid: 6200,
          parentPid: 4100,
          processGroupId: 6200,
          state: "S",
          startedAt: "Mon Jul 27 00:08:00 2026",
          identity: rootIdentity,
          depth: 0
        }
      ]
    }
  });
  const helperIdentity = "6202@Mon Jul 27 00:08:02 2026";
  const helperParentIdentity = "6201@Mon Jul 27 00:08:01 2026";
  const observed = publishBrokerChildObservation(registration, {
    child: child.child,
    ownershipSnapshot: {
      rootPid: 6200,
      rootIdentity,
      processGroupId: 6200,
      members: [
        {
          pid: 6200,
          parentPid: 4100,
          processGroupId: 6200,
          state: "S",
          startedAt: "Mon Jul 27 00:08:00 2026",
          identity: rootIdentity,
          depth: 0
        },
        {
          pid: 6201,
          parentPid: 6200,
          processGroupId: 6200,
          state: "S",
          startedAt: "Mon Jul 27 00:08:01 2026",
          identity: helperParentIdentity,
          depth: 1
        },
        {
          pid: 6202,
          parentPid: 6201,
          processGroupId: 6202,
          state: "S",
          startedAt: "Mon Jul 27 00:08:02 2026",
          identity: helperIdentity,
          depth: 2
        }
      ]
    },
    now: () => "2026-07-27T00:08:03.000Z"
  });

  assert.equal(observed.observed, true);
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(observed.path).mode & 0o777, 0o600);
  }
  const repeated = publishBrokerChildObservation(registration, {
    child: child.child,
    ownershipSnapshot: observed.observation.ownershipSnapshot,
    now: () => "2026-07-27T00:08:04.000Z"
  });
  assert.equal(repeated.observed, true);
  assert.equal(repeated.reason, "child-already-observed");
  assert.equal(repeated.path, observed.path);
  const loaded = loadBrokerChildren(registration);
  assert.equal(loaded.valid, true);
  assert.deepEqual(loaded.children[0].ownershipSnapshot.members.map((member) => member.identity), [
    rootIdentity,
    helperParentIdentity,
    helperIdentity
  ]);

  const released = releaseBrokerChild(registration, {
    child: loaded.children[0],
    cleanupOutcome: { verified: true, survivors: [], survivorIdentities: [] }
  });
  assert.equal(released.released, true);
  assert.equal(loadBrokerChildren(registration).releasedChildren[0].ownershipSnapshot.members.length, 3);
});

test("an observation member outside the immutable child tree makes the registry report-only", (t) => {
  const { registration } = makeFixture(t);
  const rootIdentity = "6300@Mon Jul 27 00:09:00 2026";
  const child = publishBrokerChild(registration, {
    ownershipSnapshot: {
      rootPid: 6300,
      rootIdentity,
      processGroupId: 6300,
      members: [
        {
          pid: 6300,
          parentPid: 4100,
          processGroupId: 6300,
          state: "S",
          startedAt: "Mon Jul 27 00:09:00 2026",
          identity: rootIdentity,
          depth: 0
        }
      ]
    }
  });
  const ownershipSnapshot = {
    rootPid: 6300,
    rootIdentity,
    processGroupId: 6300,
    members: [
      child.child.ownershipSnapshot.members[0],
      {
        pid: 9900,
        parentPid: 1,
        processGroupId: 9900,
        state: "S",
        startedAt: "Mon Jul 27 00:09:01 2026",
        identity: "9900@Mon Jul 27 00:09:01 2026",
        depth: 1
      }
    ]
  };

  const refused = publishBrokerChildObservation(registration, {
    child: child.child,
    ownershipSnapshot
  });
  assert.equal(refused.observed, false);
  assert.equal(refused.reason, "child-observation-invalid");

  const observationKey = createHash("sha256").update(JSON.stringify(ownershipSnapshot)).digest("hex");
  const observationDir = path.join(registration.registryDir, "child-observations", child.child.childKey);
  const observationPath = path.join(observationDir, `${observationKey}.json`);
  fs.mkdirSync(observationDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    observationPath,
    `${JSON.stringify({
      version: 1,
      kind: "child-observation",
      brokerKey: registration.brokerKey,
      childKey: child.child.childKey,
      observationKey,
      ownershipSnapshot,
      observedAt: "2026-07-27T00:09:02.000Z"
    })}\n`,
    { mode: 0o600 }
  );

  const loaded = loadBrokerChildren(registration);
  assert.equal(loaded.valid, false);
  assert.equal(loaded.reason, "malformed-child-registry");
  assert.deepEqual(loaded.children, []);
  assert.deepEqual(loaded.malformed, [observationPath]);
});
