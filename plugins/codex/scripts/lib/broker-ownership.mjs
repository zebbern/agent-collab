import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { getLiveProcessPids, getProcessIdentity, hasLiveProcessIdentity } from "./process.mjs";

export const BROKER_OWNERSHIP_VERSION = 1;
export const SESSION_OWNER_PID_ENV = "CODEX_COMPANION_SESSION_OWNER_PID";
export const SESSION_OWNER_IDENTITY_ENV = "CODEX_COMPANION_SESSION_OWNER_IDENTITY";

const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";
const SESSION_ID_ENV = "CODEX_COMPANION_SESSION_ID";
const REGISTRY_DIR_NAME = "broker-ownership-v1";
const REGISTRY_LOCK_DIR_NAME = "registry.lock";
const TERMINAL_FILE_NAME = "terminal.json";

function sha256(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function isSafePid(value) {
  return Number.isSafeInteger(value) && value > 1;
}

function isRegistryLockToken(value) {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
}

function isPidIdentity(pid, identity) {
  return isSafePid(pid) && typeof identity === "string" && identity.startsWith(`${pid}@`) && identity.length > String(pid).length + 1;
}

// POSIX mode bits are meaningless on Windows: chmod is a near-no-op and modes
// read back as 0o666/0o444, so exact-mode privacy checks can never pass there.
// On win32 the per-user %LOCALAPPDATA%/plugin-data ACL is the privacy boundary;
// symlink and file-type checks still apply on every platform.
const ENFORCE_POSIX_MODES = process.platform !== "win32";

function requirePrivateDirectory(dirPath) {
  const stat = fs.lstatSync(dirPath);
  if (stat.isSymbolicLink() || !stat.isDirectory() || (ENFORCE_POSIX_MODES && (stat.mode & 0o777) !== 0o700)) {
    const error = /** @type {Error & { code?: string }} */ (new Error(`Broker ownership registry directory is not private: ${dirPath}.`));
    error.code = "BROKER_OWNERSHIP_PERMISSIONS";
    throw error;
  }
  return stat;
}

function requirePrivateFile(filePath) {
  const stat = fs.lstatSync(filePath);
  if (stat.isSymbolicLink() || !stat.isFile() || (ENFORCE_POSIX_MODES && (stat.mode & 0o777) !== 0o600)) {
    const error = /** @type {Error & { code?: string }} */ (new Error(`Broker ownership registry file is not private: ${filePath}.`));
    error.code = "BROKER_OWNERSHIP_PERMISSIONS";
    throw error;
  }
  return stat;
}

function ensurePrivateDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(dirPath);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    const error = /** @type {Error & { code?: string }} */ (new Error(`Refusing non-directory broker ownership path: ${dirPath}.`));
    error.code = "BROKER_OWNERSHIP_PERMISSIONS";
    throw error;
  }
  fs.chmodSync(dirPath, 0o700);
  requirePrivateDirectory(dirPath);
}

function immutableJsonBytes(payload) {
  return `${JSON.stringify(payload, null, 2)}\n`;
}

function createImmutableJson(filePath, payload) {
  const bytes = immutableJsonBytes(payload);
  ensurePrivateDir(path.dirname(filePath));
  if (fs.existsSync(filePath)) {
    requirePrivateFile(filePath);
    if (fs.readFileSync(filePath, "utf8") !== bytes) {
      const error = /** @type {Error & { code?: string }} */ (new Error(`Broker ownership registry collision at ${filePath}.`));
      error.code = "BROKER_OWNERSHIP_COLLISION";
      throw error;
    }
    fs.chmodSync(filePath, 0o600);
    return filePath;
  }

  const tempPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(tempPath, bytes, { encoding: "utf8", flag: "wx", mode: 0o600 });
    fs.chmodSync(tempPath, 0o600);
    try {
      fs.linkSync(tempPath, filePath);
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error;
      }
      requirePrivateFile(filePath);
      if (fs.readFileSync(filePath, "utf8") !== bytes) {
        throw error;
      }
    }
    fs.chmodSync(filePath, 0o600);
    requirePrivateFile(filePath);
    return filePath;
  } finally {
    try {
      fs.unlinkSync(tempPath);
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
    }
  }
}

function readJson(filePath) {
  requirePrivateFile(filePath);
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function registrationReference(registryRoot, brokerKey) {
  return {
    registered: true,
    version: BROKER_OWNERSHIP_VERSION,
    brokerKey,
    registryRoot,
    registryDir: path.join(registryRoot, brokerKey)
  };
}

function validRegistrationReference(registration) {
  return Boolean(
    registration?.registered === true &&
      registration.version === BROKER_OWNERSHIP_VERSION &&
      typeof registration.brokerKey === "string" &&
      /^[a-f0-9]{64}$/.test(registration.brokerKey) &&
      typeof registration.registryRoot === "string" &&
      path.isAbsolute(registration.registryRoot) &&
      registration.registryDir === path.join(registration.registryRoot, registration.brokerKey)
  );
}

function validRegistryLock(registration, lock) {
  return Boolean(
    validRegistrationReference(registration) &&
      lock?.acquired === true &&
      lock.brokerKey === registration.brokerKey &&
      isRegistryLockToken(lock.token) &&
      isSafePid(lock.pid) &&
      isPidIdentity(lock.pid, lock.pidIdentity) &&
      lock.path === path.join(registration.registryDir, REGISTRY_LOCK_DIR_NAME)
  );
}

function createPreparedRegistryLock(registration, preparedRegistryDir, options = {}) {
  const pid = options.pid ?? process.pid;
  if (!isSafePid(pid)) {
    return { acquired: false, reason: "registry-lock-owner-invalid" };
  }
  const getProcessIdentityImpl = options.getProcessIdentityImpl ?? getProcessIdentity;
  let pidIdentity = options.pidIdentity ?? null;
  if (!pidIdentity) {
    try {
      pidIdentity = getProcessIdentityImpl(pid);
    } catch {
      return { acquired: false, reason: "registry-lock-owner-identity-unavailable" };
    }
  }
  if (!isPidIdentity(pid, pidIdentity)) {
    return { acquired: false, reason: "registry-lock-owner-identity-unavailable" };
  }
  const token = randomUUID();
  const preparedLockPath = path.join(preparedRegistryDir, REGISTRY_LOCK_DIR_NAME);
  ensurePrivateDir(preparedLockPath);
  createImmutableJson(path.join(preparedLockPath, "owner.json"), {
    version: BROKER_OWNERSHIP_VERSION,
    kind: "registry-lock",
    brokerKey: registration.brokerKey,
    token,
    pid,
    pidIdentity,
    acquiredAt: (options.now ?? (() => new Date().toISOString()))()
  });
  return {
    acquired: true,
    brokerKey: registration.brokerKey,
    token,
    pid,
    pidIdentity,
    path: path.join(registration.registryDir, REGISTRY_LOCK_DIR_NAME)
  };
}

export function acquireBrokerRegistryLock(
  registration,
  {
    now = () => new Date().toISOString(),
    pid = process.pid,
    pidIdentity: suppliedPidIdentity = null,
    getProcessIdentityImpl = getProcessIdentity,
    getLiveProcessPidsImpl = getLiveProcessPids,
    hasLiveProcessIdentityImpl = hasLiveProcessIdentity
  } = {}
) {
  if (!validRegistrationReference(registration)) {
    return { acquired: false, reason: "broker-registration-unavailable" };
  }
  requirePrivateDirectory(registration.registryRoot);
  requirePrivateDirectory(registration.registryDir);
  let pidIdentity = suppliedPidIdentity;
  if (!pidIdentity) {
    try {
      pidIdentity = getProcessIdentityImpl(pid);
    } catch {
      return { acquired: false, reason: "registry-lock-owner-identity-unavailable" };
    }
  }
  if (!isPidIdentity(pid, pidIdentity)) {
    return { acquired: false, reason: "registry-lock-owner-identity-unavailable" };
  }
  const lockPath = path.join(registration.registryDir, REGISTRY_LOCK_DIR_NAME);
  const token = randomUUID();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const preparedPath = path.join(registration.registryDir, `.registry-lock.${pid}.${randomUUID()}`);
    try {
      ensurePrivateDir(preparedPath);
      createImmutableJson(path.join(preparedPath, "owner.json"), {
        version: BROKER_OWNERSHIP_VERSION,
        kind: "registry-lock",
        brokerKey: registration.brokerKey,
        token,
        pid,
        pidIdentity,
        acquiredAt: now()
      });
      try {
        fs.renameSync(preparedPath, lockPath);
        return { acquired: true, brokerKey: registration.brokerKey, token, pid, pidIdentity, path: lockPath };
      } catch (error) {
        // Windows reports rename-onto-existing-directory as EPERM rather than
        // EEXIST/ENOTEMPTY; treat it as lock contention, not a fatal error.
        const contention =
          error?.code === "EEXIST" ||
          error?.code === "ENOTEMPTY" ||
          (process.platform === "win32" && error?.code === "EPERM");
        if (!contention) {
          throw error;
        }
      }
    } finally {
      if (fs.existsSync(preparedPath)) {
        fs.rmSync(preparedPath, { recursive: true, force: true });
      }
    }

    let existingOwner;
    try {
      requirePrivateDirectory(lockPath);
      existingOwner = readJson(path.join(lockPath, "owner.json"));
    } catch (error) {
      if (error?.code === "ENOENT") {
        continue;
      }
      return { acquired: false, reason: "registry-lock-malformed", path: lockPath };
    }
    if (
      existingOwner?.version !== BROKER_OWNERSHIP_VERSION ||
      existingOwner.kind !== "registry-lock" ||
      existingOwner.brokerKey !== registration.brokerKey ||
      !isRegistryLockToken(existingOwner.token) ||
      !isSafePid(existingOwner.pid) ||
      (existingOwner.pidIdentity != null && !isPidIdentity(existingOwner.pid, existingOwner.pidIdentity))
    ) {
      return { acquired: false, reason: "registry-lock-malformed", path: lockPath };
    }
    let live = false;
    try {
      if (existingOwner.pidIdentity == null) {
        const livePids = getLiveProcessPidsImpl([existingOwner.pid]);
        if (!Array.isArray(livePids)) {
          return { acquired: false, reason: "registry-lock-liveness-unavailable", path: lockPath };
        }
        live = livePids.includes(existingOwner.pid);
      } else {
        live = hasLiveProcessIdentityImpl(existingOwner.pid, existingOwner.pidIdentity);
        if (typeof live !== "boolean") {
          return { acquired: false, reason: "registry-lock-liveness-unavailable", path: lockPath };
        }
      }
    } catch {
      return { acquired: false, reason: "registry-lock-liveness-unavailable", path: lockPath };
    }
    if (live) {
      return { acquired: false, reason: "registry-busy", path: lockPath };
    }

    const staleRoot = path.join(registration.registryDir, "stale-locks");
    ensurePrivateDir(staleRoot);
    const stalePath = path.join(staleRoot, `${existingOwner.pid}-${existingOwner.token}`);
    try {
      fs.renameSync(lockPath, stalePath);
    } catch (error) {
      if (
        error?.code === "ENOENT" ||
        error?.code === "EEXIST" ||
        error?.code === "ENOTEMPTY" ||
        (process.platform === "win32" && error?.code === "EPERM")
      ) {
        continue;
      }
      return { acquired: false, reason: "registry-lock-quarantine-failed", path: lockPath };
    }
  }
  return { acquired: false, reason: "registry-lock-contention", path: lockPath };
}

export function releaseBrokerRegistryLock(registration, lock) {
  if (!validRegistryLock(registration, lock)) {
    return { released: false, reason: "registry-lock-unavailable" };
  }
  const ownerPath = path.join(lock.path, "owner.json");
  try {
    const owner = readJson(ownerPath);
    if (
      owner?.version !== BROKER_OWNERSHIP_VERSION ||
      owner.kind !== "registry-lock" ||
      owner.brokerKey !== registration.brokerKey ||
      owner.token !== lock.token ||
      owner.pid !== lock.pid ||
      owner.pidIdentity !== lock.pidIdentity
    ) {
      return { released: false, reason: "registry-lock-mismatch" };
    }
    fs.unlinkSync(ownerPath);
    fs.rmdirSync(lock.path);
    return { released: true };
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { released: false, reason: "registry-lock-missing" };
    }
    throw error;
  }
}

function withBrokerRegistryLock(registration, options, action) {
  const suppliedLock = options.registryLock;
  if (suppliedLock && !validRegistryLock(registration, suppliedLock)) {
    return { ok: false, reason: "registry-lock-unavailable" };
  }
  const lock = suppliedLock ?? acquireBrokerRegistryLock(registration, options);
  if (lock.acquired !== true) {
    return { ok: false, reason: lock.reason ?? "registry-busy" };
  }
  try {
    return { ok: true, value: action() };
  } finally {
    if (!suppliedLock) {
      const released = releaseBrokerRegistryLock(registration, lock);
      if (released.released !== true) {
        const error = /** @type {Error & { code?: string }} */ (new Error(`Unable to release broker registry lock (${released.reason}).`));
        error.code = "BROKER_REGISTRY_LOCK_RELEASE_FAILED";
        throw error;
      }
    }
  }
}

export function resolveBrokerOwnershipRoot(env = process.env) {
  const pluginDataDir = env?.[PLUGIN_DATA_ENV];
  if (typeof pluginDataDir !== "string" || !path.isAbsolute(pluginDataDir)) {
    return null;
  }
  return path.join(pluginDataDir, "state", REGISTRY_DIR_NAME);
}

export function brokerOwnershipKey(endpoint, brokerIdentity) {
  return sha256(`${endpoint}\0${brokerIdentity}`);
}

export function loadBrokerRegistration({ endpoint, brokerIdentity, env = process.env }) {
  const registryRoot = resolveBrokerOwnershipRoot(env);
  if (!registryRoot || typeof endpoint !== "string" || !endpoint || typeof brokerIdentity !== "string" || !brokerIdentity) {
    return { registered: false, reason: "missing-registration-identity" };
  }
  const registration = registrationReference(registryRoot, brokerOwnershipKey(endpoint, brokerIdentity));
  const brokerPath = path.join(registration.registryDir, "broker.json");
  if (!fs.existsSync(brokerPath)) {
    return { registered: false, reason: "broker-record-absent" };
  }
  try {
    requirePrivateDirectory(registryRoot);
    requirePrivateDirectory(registration.registryDir);
    const broker = readJson(brokerPath);
    if (
      broker?.version !== BROKER_OWNERSHIP_VERSION ||
      broker.kind !== "broker" ||
      broker.brokerKey !== registration.brokerKey ||
      broker.endpoint !== endpoint ||
      broker.pidIdentity !== brokerIdentity ||
      !isPidIdentity(broker.pid, broker.pidIdentity)
    ) {
      return { registered: false, reason: "broker-record-invalid" };
    }
    return { ...registration, broker };
  } catch {
    return { registered: false, reason: "broker-record-invalid" };
  }
}

function validBrokerTerminal(record, filePath, registration) {
  return Boolean(
    record?.version === BROKER_OWNERSHIP_VERSION &&
      record.kind === "terminal" &&
      record.brokerKey === registration.brokerKey &&
      record.pidIdentity === registration.broker?.pidIdentity &&
      record.decision === "cleanup-verified" &&
      typeof record.attemptId === "string" &&
      /^[a-zA-Z0-9._-]{1,128}$/.test(record.attemptId) &&
      record.receipt === `${record.attemptId}.json` &&
      typeof record.retiredAt === "string" &&
      record.retiredAt.length > 0 &&
      filePath === path.join(registration.registryDir, TERMINAL_FILE_NAME)
  );
}

export function loadBrokerTerminal(registration) {
  if (!validRegistrationReference(registration)) {
    return { terminal: false, reason: "broker-registration-unavailable" };
  }
  const terminalPath = path.join(registration.registryDir, TERMINAL_FILE_NAME);
  if (!fs.existsSync(terminalPath)) {
    return { terminal: false, reason: "terminal-absent", path: terminalPath };
  }
  try {
    const record = readJson(terminalPath);
    if (!validBrokerTerminal(record, terminalPath, registration)) {
      return { terminal: false, reason: "terminal-invalid", path: terminalPath };
    }
    return { terminal: true, reason: "cleanup-verified", path: terminalPath, record };
  } catch {
    return { terminal: false, reason: "terminal-invalid", path: terminalPath };
  }
}

export function publishBrokerRegistration({ cwd, endpoint, pid, ownershipSnapshot, env = process.env, now = () => new Date().toISOString() }) {
  const registryRoot = resolveBrokerOwnershipRoot(env);
  if (!registryRoot) {
    return { registered: false, reason: "plugin-data-unavailable" };
  }
  if (
    typeof endpoint !== "string" ||
    !endpoint ||
    !isSafePid(pid) ||
    ownershipSnapshot?.rootPid !== pid ||
    !isPidIdentity(pid, ownershipSnapshot?.rootIdentity) ||
    !isSafePid(ownershipSnapshot?.processGroupId)
  ) {
    return { registered: false, reason: "broker-identity-unavailable" };
  }

  const brokerKey = brokerOwnershipKey(endpoint, ownershipSnapshot.rootIdentity);
  const registration = registrationReference(registryRoot, brokerKey);
  const existing = loadBrokerRegistration({ endpoint, brokerIdentity: ownershipSnapshot.rootIdentity, env });
  if (existing.registered === true) {
    return existing;
  }
  const broker = {
    version: BROKER_OWNERSHIP_VERSION,
    kind: "broker",
    brokerKey,
    endpoint,
    pid,
    pidIdentity: ownershipSnapshot.rootIdentity,
    processGroupId: ownershipSnapshot.processGroupId,
    workspaceHash: sha256(path.resolve(cwd)),
    createdAt: now()
  };
  createImmutableJson(path.join(registration.registryDir, "broker.json"), broker);
  return { ...registration, broker };
}

function ownerFromEnv(env) {
  const sessionId = env?.[SESSION_ID_ENV];
  const pid = Number(env?.[SESSION_OWNER_PID_ENV]);
  const identity = env?.[SESSION_OWNER_IDENTITY_ENV];
  if (typeof sessionId !== "string" || !sessionId || !isPidIdentity(pid, identity)) {
    return null;
  }
  const ownerKey = sha256(`${sessionId}\0${identity}`);
  return { ownerKey, sessionId, pid, identity };
}

export function hasLiveBrokerOwnerIdentity(env = process.env, options = {}) {
  const owner = ownerFromEnv(env);
  if (!owner) {
    return false;
  }
  const hasLiveIdentity = options.hasLiveProcessIdentityImpl ?? hasLiveProcessIdentity;
  try {
    return hasLiveIdentity(owner.pid, owner.identity);
  } catch {
    return false;
  }
}

export function publishRegisteredBroker({
  cwd,
  endpoint,
  pid,
  ownershipSnapshot,
  env = process.env,
  now = () => new Date().toISOString(),
  hasLiveProcessIdentityImpl = hasLiveProcessIdentity,
  getProcessIdentityImpl = getProcessIdentity,
  retainRegistryLock = false
}) {
  const registryRoot = resolveBrokerOwnershipRoot(env);
  if (!registryRoot) {
    return { registered: false, reason: "plugin-data-unavailable" };
  }
  const owner = ownerFromEnv(env);
  if (!owner) {
    return { registered: false, reason: "session-owner-unavailable" };
  }
  if (!hasLiveBrokerOwnerIdentity(env, { hasLiveProcessIdentityImpl })) {
    return { registered: false, reason: "session-owner-not-live" };
  }
  if (
    typeof endpoint !== "string" ||
    !endpoint ||
    !isSafePid(pid) ||
    ownershipSnapshot?.rootPid !== pid ||
    !isPidIdentity(pid, ownershipSnapshot?.rootIdentity) ||
    !isSafePid(ownershipSnapshot?.processGroupId)
  ) {
    return { registered: false, reason: "broker-identity-unavailable" };
  }

  const brokerKey = brokerOwnershipKey(endpoint, ownershipSnapshot.rootIdentity);
  const registration = registrationReference(registryRoot, brokerKey);
  const createdAt = now();
  const broker = {
    version: BROKER_OWNERSHIP_VERSION,
    kind: "broker",
    brokerKey,
    endpoint,
    pid,
    pidIdentity: ownershipSnapshot.rootIdentity,
    processGroupId: ownershipSnapshot.processGroupId,
    workspaceHash: sha256(path.resolve(cwd)),
    createdAt
  };
  const ownerRecord = {
    version: BROKER_OWNERSHIP_VERSION,
    kind: "owner",
    brokerKey,
    ownerKey: owner.ownerKey,
    sessionId: owner.sessionId,
    pid: owner.pid,
    pidIdentity: owner.identity,
    registeredAt: createdAt
  };

  ensurePrivateDir(registryRoot);
  const preparedDir = path.join(registryRoot, `.${brokerKey}.${process.pid}.${randomUUID()}.prepared`);
  fs.mkdirSync(preparedDir, { mode: 0o700 });
  try {
    createImmutableJson(path.join(preparedDir, "broker.json"), broker);
    createImmutableJson(path.join(preparedDir, "owners", `${owner.ownerKey}.json`), ownerRecord);
    const registryLock = retainRegistryLock
      ? createPreparedRegistryLock(registration, preparedDir, { now, getProcessIdentityImpl })
      : null;
    if (retainRegistryLock && registryLock?.acquired !== true) {
      return { registered: false, reason: registryLock?.reason ?? "registry-lock-unavailable" };
    }
    // Publication is the point at which the reaper can first observe this
    // broker. Revalidate both identities after all prepared bytes exist and
    // immediately before the atomic rename so the visible initial state never
    // begins with a dead sole owner or a reused broker PID.
    if (!hasLiveProcessIdentityImpl(owner.pid, owner.identity)) {
      return { registered: false, reason: "session-owner-not-live" };
    }
    if (!hasLiveProcessIdentityImpl(pid, ownershipSnapshot.rootIdentity)) {
      return { registered: false, reason: "broker-not-live" };
    }
    fs.renameSync(preparedDir, registration.registryDir);
    requirePrivateDirectory(registration.registryDir);
    return {
      ...registration,
      broker,
      ownerKey: owner.ownerKey,
      ...(registryLock ? { registryLock } : {})
    };
  } finally {
    if (fs.existsSync(preparedDir)) {
      fs.rmSync(preparedDir, { recursive: true, force: true });
    }
  }
}

export function registerBrokerOwner(registration, options = {}) {
  const { env = process.env, now = () => new Date().toISOString() } = options;
  if (!validRegistrationReference(registration)) {
    return { registered: false, reason: "broker-registration-unavailable" };
  }
  const owner = ownerFromEnv(env);
  if (!owner) {
    return { registered: false, reason: "session-owner-unavailable" };
  }
  const locked = withBrokerRegistryLock(registration, options, () => {
    const hasLiveIdentity = options.hasLiveProcessIdentityImpl ?? hasLiveProcessIdentity;
    const ownerIsLive = () => {
      try {
        return hasLiveIdentity(owner.pid, owner.identity) === true;
      } catch {
        return false;
      }
    };
    const ownerPath = path.join(registration.registryDir, "owners", `${owner.ownerKey}.json`);
    if (fs.existsSync(ownerPath)) {
      const existing = readJson(ownerPath);
      if (!validOwnerRecord(existing, ownerPath, registration)) {
        const error = /** @type {Error & { code?: string }} */ (new Error(`Invalid existing broker owner row at ${ownerPath}.`));
        error.code = "BROKER_OWNERSHIP_COLLISION";
        throw error;
      }
      if (!ownerIsLive()) {
        return { registered: false, reason: "session-owner-not-live" };
      }
      fs.chmodSync(ownerPath, 0o600);
      return { registered: true, ownerKey: owner.ownerKey, path: ownerPath, owner: existing };
    }
    const payload = {
      version: BROKER_OWNERSHIP_VERSION,
      kind: "owner",
      brokerKey: registration.brokerKey,
      ownerKey: owner.ownerKey,
      sessionId: owner.sessionId,
      pid: owner.pid,
      pidIdentity: owner.identity,
      registeredAt: now()
    };
    if (!ownerIsLive()) {
      return { registered: false, reason: "session-owner-not-live" };
    }
    createImmutableJson(ownerPath, payload);
    return { registered: true, ownerKey: owner.ownerKey, path: ownerPath, owner: payload };
  });
  return locked.ok ? locked.value : { registered: false, reason: locked.reason };
}

export function releaseBrokerOwner(registration, options = {}) {
  const { env = process.env, now = () => new Date().toISOString() } = options;
  if (!validRegistrationReference(registration)) {
    return { released: false, reason: "broker-registration-unavailable" };
  }
  const owner = ownerFromEnv(env);
  if (!owner) {
    return { released: false, reason: "session-owner-unavailable" };
  }
  const locked = withBrokerRegistryLock(registration, options, () => {
    const payload = {
      version: BROKER_OWNERSHIP_VERSION,
      kind: "release",
      brokerKey: registration.brokerKey,
      ownerKey: owner.ownerKey,
      sessionId: owner.sessionId,
      pid: owner.pid,
      pidIdentity: owner.identity,
      releasedAt: now()
    };
    const releasePath = path.join(registration.registryDir, "releases", `${owner.ownerKey}.json`);
    if (fs.existsSync(releasePath)) {
      const existing = readJson(releasePath);
      if (!validReleaseRecord(existing, releasePath, registration)) {
        const error = /** @type {Error & { code?: string }} */ (new Error(`Invalid existing broker owner release at ${releasePath}.`));
        error.code = "BROKER_OWNERSHIP_COLLISION";
        throw error;
      }
      fs.chmodSync(releasePath, 0o600);
      return { released: true, ownerKey: owner.ownerKey, path: releasePath, release: existing };
    }
    createImmutableJson(releasePath, payload);
    return { released: true, ownerKey: owner.ownerKey, path: releasePath, release: payload };
  });
  return locked.ok ? locked.value : { released: false, reason: locked.reason };
}

function listJsonFiles(dirPath) {
  try {
    requirePrivateDirectory(dirPath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return [];
    }
    throw error;
  }
  return fs.readdirSync(dirPath)
    .filter((name) => name.endsWith(".json") && !name.startsWith("."))
    .sort()
    .map((name) => path.join(dirPath, name));
}

function validOwnerRecord(record, filePath, registration) {
  return Boolean(
    record?.version === BROKER_OWNERSHIP_VERSION &&
      record.kind === "owner" &&
      record.brokerKey === registration.brokerKey &&
      typeof record.ownerKey === "string" &&
      path.basename(filePath) === `${record.ownerKey}.json` &&
      record.ownerKey === sha256(`${record.sessionId}\0${record.pidIdentity}`) &&
      isPidIdentity(record.pid, record.pidIdentity) &&
      typeof record.sessionId === "string" &&
      record.sessionId.length > 0
  );
}

function validReleaseRecord(record, filePath, registration) {
  return Boolean(
    record?.version === BROKER_OWNERSHIP_VERSION &&
      record.kind === "release" &&
      record.brokerKey === registration.brokerKey &&
      typeof record.ownerKey === "string" &&
      path.basename(filePath) === `${record.ownerKey}.json` &&
      record.ownerKey === sha256(`${record.sessionId}\0${record.pidIdentity}`) &&
      isPidIdentity(record.pid, record.pidIdentity) &&
      typeof record.sessionId === "string" &&
      record.sessionId.length > 0
  );
}

function validSnapshotMember(record) {
  return Boolean(
    isSafePid(record?.pid) &&
      Number.isSafeInteger(record.parentPid) &&
      record.parentPid >= 0 &&
      isSafePid(record.processGroupId) &&
      (record.sessionId == null || isSafePid(record.sessionId)) &&
      typeof record.state === "string" &&
      record.state.length > 0 &&
      typeof record.startedAt === "string" &&
      record.startedAt.length > 0 &&
      isPidIdentity(record.pid, record.identity) &&
      Number.isSafeInteger(record.depth) &&
      record.depth >= 0
  );
}

function validOwnershipTree(snapshot, rootPid, rootIdentity) {
  if (!Array.isArray(snapshot?.members) || snapshot.members.length === 0) {
    return false;
  }
  const membersByPid = new Map();
  const memberIdentities = new Set();
  for (const member of snapshot.members) {
    if (
      !validSnapshotMember(member) ||
      membersByPid.has(member.pid) ||
      memberIdentities.has(member.identity)
    ) {
      return false;
    }
    membersByPid.set(member.pid, member);
    memberIdentities.add(member.identity);
  }
  const root = membersByPid.get(rootPid);
  if (root?.identity !== rootIdentity || root.depth !== 0) {
    return false;
  }
  for (const member of snapshot.members) {
    if (member.pid === rootPid) {
      continue;
    }
    const parent = membersByPid.get(member.parentPid);
    if (!parent || member.depth !== parent.depth + 1) {
      return false;
    }
  }
  return true;
}

function validChildRecord(record, filePath, registration) {
  const snapshot = record?.ownershipSnapshot;
  return Boolean(
    record?.version === BROKER_OWNERSHIP_VERSION &&
      record.kind === "child" &&
      record.brokerKey === registration.brokerKey &&
      typeof record.childKey === "string" &&
      record.childKey === sha256(record.pidIdentity) &&
      path.basename(filePath) === `${record.childKey}.json` &&
      isPidIdentity(record.pid, record.pidIdentity) &&
      isSafePid(record.processGroupId) &&
      snapshot?.rootPid === record.pid &&
      snapshot.rootIdentity === record.pidIdentity &&
      snapshot.processGroupId === record.processGroupId &&
      (snapshot.sessionId == null ||
        (isSafePid(snapshot.sessionId) &&
          snapshot.sessionId === snapshot.rootPid)) &&
      validOwnershipTree(snapshot, record.pid, record.pidIdentity) &&
      (snapshot.sessionId == null || snapshot.members.find((member) => member.pid === record.pid)?.sessionId === snapshot.sessionId)
  );
}

function validChildObservation(record, filePath, registration, child) {
  const snapshot = record?.ownershipSnapshot;
  return Boolean(
    child &&
      record?.version === BROKER_OWNERSHIP_VERSION &&
      record.kind === "child-observation" &&
      record.brokerKey === registration.brokerKey &&
      record.childKey === child.childKey &&
      typeof record.observationKey === "string" &&
      record.observationKey === sha256(JSON.stringify(snapshot)) &&
      path.basename(filePath) === `${record.observationKey}.json` &&
      snapshot?.rootPid === child.pid &&
      snapshot.rootIdentity === child.pidIdentity &&
      snapshot.processGroupId === child.processGroupId &&
      (snapshot.sessionId == null ||
        (isSafePid(snapshot.sessionId) && snapshot.sessionId === snapshot.rootPid)) &&
      validOwnershipTree(snapshot, child.pid, child.pidIdentity) &&
      (snapshot.sessionId == null || snapshot.members.find((member) => member.pid === child.pid)?.sessionId === snapshot.sessionId) &&
      typeof record.observedAt === "string" &&
      record.observedAt.length > 0
  );
}

function mergeChildOwnership(child, observations) {
  const members = new Map();
  for (const snapshot of [child.ownershipSnapshot, ...observations.map((observation) => observation.ownershipSnapshot)]) {
    for (const member of snapshot.members) {
      members.set(member.identity, member);
    }
  }
  return {
    ...child,
    ownershipSnapshot: {
      ...child.ownershipSnapshot,
      members: [...members.values()]
    }
  };
}

function validChildReleaseRecord(record, filePath, registration, child) {
  return Boolean(
    child &&
      record?.version === BROKER_OWNERSHIP_VERSION &&
      record.kind === "child-release" &&
      record.brokerKey === registration.brokerKey &&
      record.childKey === child.childKey &&
      path.basename(filePath) === `${record.childKey}.json` &&
      record.pid === child.pid &&
      record.pidIdentity === child.pidIdentity &&
      record.cleanupVerified === true
  );
}

export function loadBrokerChildren(registration) {
  if (!validRegistrationReference(registration)) {
    return { valid: false, reason: "broker-registration-unavailable", children: [], malformed: [] };
  }
  const children = [];
  const releases = new Map();
  const malformed = [];
  let childFiles;
  let childReleaseFiles;
  try {
    childFiles = listJsonFiles(path.join(registration.registryDir, "children"));
    childReleaseFiles = listJsonFiles(path.join(registration.registryDir, "child-releases"));
  } catch {
    return {
      valid: false,
      reason: "malformed-child-registry",
      children: [],
      releasedChildren: [],
      malformed: [registration.registryDir]
    };
  }
  for (const filePath of childFiles) {
    try {
      const record = readJson(filePath);
      if (!validChildRecord(record, filePath, registration)) {
        malformed.push(filePath);
      } else {
        children.push(record);
      }
    } catch {
      malformed.push(filePath);
    }
  }
  const observedChildren = [];
  for (const child of children) {
    const observationDir = path.join(registration.registryDir, "child-observations", child.childKey);
    const observations = [];
    if (fs.existsSync(observationDir)) {
      try {
        requirePrivateDirectory(observationDir);
        for (const filePath of listJsonFiles(observationDir)) {
          const observation = readJson(filePath);
          if (!validChildObservation(observation, filePath, registration, child)) {
            malformed.push(filePath);
          } else {
            observations.push(observation);
          }
        }
      } catch {
        malformed.push(observationDir);
      }
    }
    observedChildren.push(mergeChildOwnership(child, observations));
  }
  const childrenByKey = new Map(observedChildren.map((child) => [child.childKey, child]));
  for (const filePath of childReleaseFiles) {
    try {
      const record = readJson(filePath);
      if (!validChildReleaseRecord(record, filePath, registration, childrenByKey.get(record?.childKey))) {
        malformed.push(filePath);
      } else {
        releases.set(record.childKey, record);
      }
    } catch {
      malformed.push(filePath);
    }
  }
  return malformed.length > 0
    ? { valid: false, reason: "malformed-child-registry", children: [], releasedChildren: [], malformed }
    : {
        valid: true,
        reason: "valid-child-registry",
        children: observedChildren.filter((child) => !releases.has(child.childKey)),
        releasedChildren: observedChildren.filter((child) => releases.has(child.childKey)),
        malformed: []
      };
}

export function releaseBrokerChild(
  registration,
  options = {}
) {
  const { child, cleanupOutcome, now = () => new Date().toISOString() } = options;
  if (!validRegistrationReference(registration)) {
    return { released: false, reason: "broker-registration-unavailable" };
  }
  const childPath = path.join(registration.registryDir, "children", `${child?.childKey}.json`);
  let persistedChild;
  try {
    persistedChild = readJson(childPath);
  } catch {
    return { released: false, reason: "child-cleanup-unverified" };
  }
  if (
    !validChildRecord(persistedChild, childPath, registration) ||
    child?.childKey !== persistedChild.childKey ||
    child?.pidIdentity !== persistedChild.pidIdentity ||
    cleanupOutcome?.verified !== true ||
    (cleanupOutcome.survivors?.length ?? 0) > 0 ||
    (cleanupOutcome.survivorIdentities?.length ?? 0) > 0
  ) {
    return { released: false, reason: "child-cleanup-unverified" };
  }
  const payload = {
    version: BROKER_OWNERSHIP_VERSION,
    kind: "child-release",
    brokerKey: registration.brokerKey,
    childKey: child.childKey,
    pid: child.pid,
    pidIdentity: child.pidIdentity,
    cleanupVerified: true,
    releasedAt: now()
  };
  const releasePath = path.join(registration.registryDir, "child-releases", `${child.childKey}.json`);
  const locked = withBrokerRegistryLock(registration, options, () => {
    if (fs.existsSync(releasePath)) {
      const existing = readJson(releasePath);
      if (!validChildReleaseRecord(existing, releasePath, registration, child)) {
        const error = /** @type {Error & { code?: string }} */ (new Error(`Invalid existing broker child release at ${releasePath}.`));
        error.code = "BROKER_OWNERSHIP_COLLISION";
        throw error;
      }
      fs.chmodSync(releasePath, 0o600);
      return { released: true, path: releasePath, release: existing };
    }
    createImmutableJson(releasePath, payload);
    return { released: true, path: releasePath, release: payload };
  });
  return locked.ok ? locked.value : { released: false, reason: locked.reason };
}

export function publishBrokerReaperReceipt(
  registration,
  { attemptId, decision, outcomes, residualIdentities, createdAt = new Date().toISOString() }
) {
  if (!validRegistrationReference(registration)) {
    return { published: false, reason: "broker-registration-unavailable" };
  }
  if (
    typeof attemptId !== "string" ||
    !/^[a-zA-Z0-9._-]{1,128}$/.test(attemptId) ||
    typeof decision !== "string" ||
    !Array.isArray(outcomes) ||
    !Array.isArray(residualIdentities)
  ) {
    return { published: false, reason: "receipt-invalid" };
  }
  const payload = {
    version: BROKER_OWNERSHIP_VERSION,
    kind: "reaper-receipt",
    brokerKey: registration.brokerKey,
    attemptId,
    decision,
    outcomes,
    residualIdentities,
    createdAt
  };
  const receiptPath = path.join(registration.registryDir, "receipts", `${attemptId}.json`);
  createImmutableJson(receiptPath, payload);
  return { published: true, path: receiptPath, receipt: payload };
}

export function publishBrokerTerminal(
  registration,
  { attemptId, receiptPath, retiredAt = new Date().toISOString(), registryLock }
) {
  if (!validRegistrationReference(registration)) {
    return { terminal: false, reason: "broker-registration-unavailable" };
  }
  const expectedReceiptPath = path.join(registration.registryDir, "receipts", `${attemptId}.json`);
  if (
    typeof attemptId !== "string" ||
    !/^[a-zA-Z0-9._-]{1,128}$/.test(attemptId) ||
    receiptPath !== expectedReceiptPath ||
    typeof retiredAt !== "string" ||
    retiredAt.length === 0
  ) {
    return { terminal: false, reason: "terminal-invalid" };
  }
  let receipt;
  try {
    receipt = readJson(receiptPath);
  } catch {
    return { terminal: false, reason: "terminal-receipt-unavailable" };
  }
  if (
    receipt?.version !== BROKER_OWNERSHIP_VERSION ||
    receipt.kind !== "reaper-receipt" ||
    receipt.brokerKey !== registration.brokerKey ||
    receipt.attemptId !== attemptId ||
    receipt.decision !== "cleanup-verified" ||
    !Array.isArray(receipt.residualIdentities) ||
    receipt.residualIdentities.length !== 0
  ) {
    return { terminal: false, reason: "terminal-receipt-invalid" };
  }
  const terminalPath = path.join(registration.registryDir, TERMINAL_FILE_NAME);
  const payload = {
    version: BROKER_OWNERSHIP_VERSION,
    kind: "terminal",
    brokerKey: registration.brokerKey,
    pidIdentity: registration.broker.pidIdentity,
    decision: "cleanup-verified",
    attemptId,
    receipt: path.basename(receiptPath),
    retiredAt
  };
  const locked = withBrokerRegistryLock(registration, { registryLock }, () => {
    createImmutableJson(terminalPath, payload);
    return { terminal: true, reason: "cleanup-verified", path: terminalPath, record: payload };
  });
  return locked.ok ? locked.value : { terminal: false, reason: locked.reason };
}

export function assessBrokerOwners(registration, { getLiveProcessPidsImpl = getLiveProcessPids } = {}) {
  if (!validRegistrationReference(registration)) {
    return { safeToShutdown: false, reason: "broker-registration-unavailable", liveOwners: [], deadOwners: [], releasedOwners: [], malformed: [] };
  }

  const malformed = [];
  const owners = [];
  const releases = new Map();
  let ownerFiles;
  let releaseFiles;
  try {
    ownerFiles = listJsonFiles(path.join(registration.registryDir, "owners"));
    releaseFiles = listJsonFiles(path.join(registration.registryDir, "releases"));
  } catch {
    return {
      safeToShutdown: false,
      reason: "malformed-registry",
      liveOwners: [],
      deadOwners: [],
      releasedOwners: [],
      malformed: [registration.registryDir]
    };
  }
  for (const filePath of ownerFiles) {
    try {
      const record = readJson(filePath);
      if (!validOwnerRecord(record, filePath, registration)) {
        malformed.push(filePath);
      } else {
        owners.push(record);
      }
    } catch {
      malformed.push(filePath);
    }
  }
  for (const filePath of releaseFiles) {
    try {
      const record = readJson(filePath);
      if (!validReleaseRecord(record, filePath, registration)) {
        malformed.push(filePath);
      } else {
        releases.set(record.ownerKey, record);
      }
    } catch {
      malformed.push(filePath);
    }
  }
  if (malformed.length > 0) {
    return { safeToShutdown: false, reason: "malformed-registry", liveOwners: [], deadOwners: [], releasedOwners: [], malformed };
  }
  if (owners.length === 0) {
    return { safeToShutdown: false, reason: "no-registered-owner", liveOwners: [], deadOwners: [], releasedOwners: [], malformed: [] };
  }

  const liveOwners = [];
  const deadOwners = [];
  const releasedOwners = [];
  for (const owner of owners) {
    const release = releases.get(owner.ownerKey);
    if (release) {
      if (
        release.sessionId !== owner.sessionId ||
        release.pid !== owner.pid ||
        release.pidIdentity !== owner.pidIdentity
      ) {
        malformed.push(path.join(registration.registryDir, "releases", `${owner.ownerKey}.json`));
        continue;
      }
      releasedOwners.push(owner);
      continue;
    }
    let live;
    try {
      live = getLiveProcessPidsImpl([owner.pid], { identities: [owner.pidIdentity] });
    } catch {
      malformed.push(`liveness:${owner.ownerKey}`);
      continue;
    }
    if (Array.isArray(live) && live.includes(owner.pid)) {
      liveOwners.push(owner);
    } else {
      deadOwners.push(owner);
    }
  }
  if (malformed.length > 0) {
    return { safeToShutdown: false, reason: "owner-liveness-unavailable", liveOwners, deadOwners, releasedOwners, malformed };
  }
  if (liveOwners.length > 0) {
    return { safeToShutdown: false, reason: "live-owner", liveOwners, deadOwners, releasedOwners, malformed: [] };
  }
  return {
    safeToShutdown: true,
    reason: "all-owners-dead-or-released",
    liveOwners,
    deadOwners,
    releasedOwners,
    malformed: []
  };
}

export function publishBrokerChild(registration, options = {}) {
  const { ownershipSnapshot, now = () => new Date().toISOString() } = options;
  if (!validRegistrationReference(registration)) {
    return { registered: false, reason: "broker-registration-unavailable" };
  }
  const pid = ownershipSnapshot?.rootPid;
  const identity = ownershipSnapshot?.rootIdentity;
  if (
    !isPidIdentity(pid, identity) ||
    !isSafePid(ownershipSnapshot?.processGroupId) ||
    (ownershipSnapshot?.sessionId != null &&
      (!isSafePid(ownershipSnapshot.sessionId) || ownershipSnapshot.sessionId !== pid)) ||
    !validOwnershipTree(ownershipSnapshot, pid, identity)
  ) {
    return { registered: false, reason: "child-identity-unavailable" };
  }
  const locked = withBrokerRegistryLock(registration, options, () => {
    const childKey = sha256(identity);
    const payload = {
      version: BROKER_OWNERSHIP_VERSION,
      kind: "child",
      brokerKey: registration.brokerKey,
      childKey,
      pid,
      pidIdentity: identity,
      processGroupId: ownershipSnapshot.processGroupId,
      ownershipSnapshot,
      registeredAt: now()
    };
    const childPath = path.join(registration.registryDir, "children", `${childKey}.json`);
    if (fs.existsSync(childPath)) {
      const existing = readJson(childPath);
      if (
        existing?.version !== BROKER_OWNERSHIP_VERSION ||
        existing.kind !== "child" ||
        existing.brokerKey !== registration.brokerKey ||
        existing.childKey !== childKey ||
        existing.pid !== pid ||
        existing.pidIdentity !== identity ||
        JSON.stringify(existing.ownershipSnapshot) !== JSON.stringify(ownershipSnapshot)
      ) {
        const error = /** @type {Error & { code?: string }} */ (new Error(`Invalid existing broker child row at ${childPath}.`));
        error.code = "BROKER_OWNERSHIP_COLLISION";
        throw error;
      }
      fs.chmodSync(childPath, 0o600);
      return { registered: true, childKey, path: childPath, child: existing };
    }
    createImmutableJson(childPath, payload);
    return { registered: true, childKey, path: childPath, child: payload };
  });
  return locked.ok ? locked.value : { registered: false, reason: locked.reason };
}

export function publishBrokerChildObservation(registration, options = {}) {
  const {
    child,
    ownershipSnapshot,
    now = () => new Date().toISOString()
  } = options;
  if (!validRegistrationReference(registration)) {
    return { observed: false, reason: "broker-registration-unavailable" };
  }
  const childPath = path.join(registration.registryDir, "children", `${child?.childKey}.json`);
  const locked = withBrokerRegistryLock(registration, options, () => {
    const persistedChild = readJson(childPath);
    if (
      !validChildRecord(persistedChild, childPath, registration) ||
      child?.childKey !== persistedChild.childKey ||
      child?.pidIdentity !== persistedChild.pidIdentity
    ) {
      return { observed: false, reason: "child-registration-invalid" };
    }
    const observationKey = sha256(JSON.stringify(ownershipSnapshot));
    const payload = {
      version: BROKER_OWNERSHIP_VERSION,
      kind: "child-observation",
      brokerKey: registration.brokerKey,
      childKey: persistedChild.childKey,
      observationKey,
      ownershipSnapshot,
      observedAt: now()
    };
    const observationPath = path.join(
      registration.registryDir,
      "child-observations",
      persistedChild.childKey,
      `${observationKey}.json`
    );
    if (fs.existsSync(observationPath)) {
      const existing = readJson(observationPath);
      if (!validChildObservation(existing, observationPath, registration, persistedChild)) {
        return { observed: false, reason: "child-observation-invalid" };
      }
      return {
        observed: true,
        reason: "child-already-observed",
        path: observationPath,
        observation: existing,
        child: mergeChildOwnership(persistedChild, [existing])
      };
    }
    if (!validChildObservation(payload, observationPath, registration, persistedChild)) {
      return { observed: false, reason: "child-observation-invalid" };
    }
    createImmutableJson(observationPath, payload);
    const observedChild = mergeChildOwnership(persistedChild, [payload]);
    return {
      observed: true,
      reason: "child-observed",
      path: observationPath,
      observation: payload,
      child: observedChild
    };
  });
  return locked.ok ? locked.value : { observed: false, reason: locked.reason };
}
