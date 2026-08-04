import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  acquireBrokerRegistryLock,
  assessBrokerOwners,
  hasLiveBrokerOwnerIdentity,
  loadBrokerChildren,
  loadBrokerRegistration,
  publishRegisteredBroker,
  registerBrokerOwner,
  releaseBrokerChild,
  releaseBrokerOwner,
  releaseBrokerRegistryLock,
  resolveBrokerOwnershipRoot
} from "./broker-ownership.mjs";
import { createBrokerEndpoint, parseBrokerEndpoint } from "./broker-endpoint.mjs";
import { captureProcessOwnership, getProcessIdentity, terminateProcessTree } from "./process.mjs";
import { resolveStateDir } from "./state.mjs";

export const PID_FILE_ENV = "CODEX_COMPANION_APP_SERVER_PID_FILE";
export const LOG_FILE_ENV = "CODEX_COMPANION_APP_SERVER_LOG_FILE";
const BROKER_STATE_FILE = "broker.json";
const BROKER_ACTIVATION_ACK = "activated";
const BROKER_LAUNCH_LOCK_HOST = "127.0.0.1";
const BROKER_LAUNCH_LOCK_MIN_PORT = 49152;
const BROKER_LAUNCH_LOCK_PORT_COUNT = 16384;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function brokerLaunchLockIdentity(cwd) {
  return createHash("sha256").update(resolveBrokerStateFile(cwd)).digest("hex");
}

export function brokerLaunchLockPort(cwd) {
  const identity = brokerLaunchLockIdentity(cwd);
  const digest = Buffer.from(identity, "hex");
  return BROKER_LAUNCH_LOCK_MIN_PORT + (digest.readUInt16BE(0) % BROKER_LAUNCH_LOCK_PORT_COUNT);
}

function tryListenForBrokerLaunch(port, greeting) {
  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => socket.end(`${greeting}\n`));
    const onError = (error) => {
      if (error?.code === "EADDRINUSE") {
        resolve(null);
        return;
      }
      reject(error);
    };
    server.once("error", onError);
    server.listen({ host: BROKER_LAUNCH_LOCK_HOST, port, exclusive: true }, () => {
      server.removeListener("error", onError);
      resolve(server);
    });
  });
}

function probeBrokerLaunchPort(port, expectedGreeting, timeoutMs = 150) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: BROKER_LAUNCH_LOCK_HOST, port });
    let connected = false;
    let buffer = "";
    let settled = false;
    const finish = (state) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(state);
    };
    const timer = setTimeout(() => finish(connected ? "foreign" : "transient"), timeoutMs);
    socket.setEncoding("utf8");
    socket.on("connect", () => {
      connected = true;
    });
    socket.on("data", (chunk) => {
      buffer += chunk;
      if (buffer.includes("\n")) {
        finish(buffer.trim() === expectedGreeting ? "matching" : "foreign");
      }
    });
    socket.on("end", () => finish(buffer.trim() === expectedGreeting ? "matching" : "foreign"));
    socket.on("error", () => finish("transient"));
  });
}

export async function acquireBrokerLaunchLock(cwd, options = {}) {
  const identity = brokerLaunchLockIdentity(cwd);
  const greeting = `codex-broker-launch-v1:${identity}`;
  const port = brokerLaunchLockPort(cwd);
  const timeoutMs = options.timeoutMs ?? 10_000;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const server = await tryListenForBrokerLaunch(port, greeting);
    if (server) {
      return {
        port,
        async release() {
          await new Promise((resolve) => server.close(resolve));
        }
      };
    }
    const observed = await probeBrokerLaunchPort(port, greeting);
    if (observed === "foreign") {
      const error = new Error("The deterministic Codex broker launch lock is occupied by another local service.");
      error.code = "BROKER_LAUNCH_LOCK_UNAVAILABLE";
      throw error;
    }
    await delay(25);
  }

  const error = new Error("Timed out waiting for another Codex broker launch to finish.");
  error.code = "BROKER_LAUNCH_LOCK_TIMEOUT";
  throw error;
}

export function createBrokerSessionDir(prefix = "cxc-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function connectToEndpoint(endpoint) {
  const target = parseBrokerEndpoint(endpoint);
  return net.createConnection({ path: target.path });
}

export async function waitForBrokerEndpoint(endpoint, timeoutMs = 2000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const ready = await new Promise((resolve) => {
      const socket = connectToEndpoint(endpoint);
      socket.on("connect", () => {
        socket.end();
        resolve(true);
      });
      socket.on("error", () => resolve(false));
    });
    if (ready) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

export async function sendBrokerShutdown(endpoint) {
  await new Promise((resolve) => {
    const socket = connectToEndpoint(endpoint);
    socket.setEncoding("utf8");
    socket.on("connect", () => {
      socket.write(`${JSON.stringify({ id: 1, method: "broker/shutdown", params: {} })}\n`);
    });
    socket.on("data", () => {
      socket.end();
      resolve();
    });
    socket.on("error", resolve);
    socket.on("close", resolve);
  });
}

export function spawnBrokerProcess({ scriptPath, cwd, endpoint, pidFile, logFile, env = process.env }) {
  const logFd = fs.openSync(logFile, "a");
  try {
    const child = spawn(
      process.execPath,
      [scriptPath, "serve", "--endpoint", endpoint, "--cwd", cwd, "--pid-file", pidFile, "--require-activation-stdin"],
      {
        cwd,
        env,
        detached: true,
        stdio: ["pipe", logFd, logFd, "pipe"]
      }
    );
    child.on("error", () => {});
    return child;
  } finally {
    fs.closeSync(logFd);
  }
}

export function activateBrokerProcess(child, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const status = child?.stdio?.[3];
    if (!child?.stdin || !status) {
      const error = new Error("Broker activation channels are unavailable.");
      error.code = "BROKER_ACTIVATION_FAILED";
      reject(error);
      return;
    }

    let buffer = "";
    let settled = false;
    const ignoreStdinError = () => {};
    const cleanup = () => {
      clearTimeout(timer);
      status.removeListener("data", onData);
      status.removeListener("error", onStatusError);
      child.removeListener("error", onChildError);
      child.removeListener("exit", onChildExit);
      child.stdin.removeListener("error", onStdinError);
    };
    const finish = (error = null) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      status.destroy();
      child.stdin.on("error", ignoreStdinError);
      if (error) {
        reject(error);
        return;
      }
      child.unref();
      resolve();
    };
    const activationError = (message) => {
      const error = new Error(message);
      error.code = "BROKER_ACTIVATION_FAILED";
      return error;
    };
    const onData = (chunk) => {
      buffer += chunk;
      if (buffer.includes("\n")) {
        finish(buffer.trim() === BROKER_ACTIVATION_ACK
          ? null
          : activationError(`Unexpected broker activation response: ${buffer.trim() || "empty"}.`));
      }
    };
    const onStatusError = (error) => finish(activationError(`Broker activation response failed: ${error.message}`));
    const onChildError = (error) => finish(activationError(`Broker activation process failed: ${error.message}`));
    const onChildExit = () => finish(activationError("Broker exited before activation completed."));
    const onStdinError = (error) => finish(activationError(`Broker activation request failed: ${error.message}`));
    const timer = setTimeout(
      () => finish(activationError("Timed out waiting for broker activation acknowledgement.")),
      timeoutMs
    );

    status.setEncoding("utf8");
    status.on("data", onData);
    status.once("error", onStatusError);
    child.once("error", onChildError);
    child.once("exit", onChildExit);
    child.stdin.once("error", onStdinError);
    child.stdin.end("activate\n");
  });
}

function closeBrokerActivationChannels(child) {
  if (child?.stdin && !child.stdin.destroyed) {
    child.stdin.once("error", () => {});
    child.stdin.end();
  }
  child?.stdio?.[3]?.destroy();
}

async function waitForBrokerProcessExit(child, timeoutMs = 1000) {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return true;
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = (exited) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      child.removeListener("exit", onExit);
      resolve(exited);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.once("exit", onExit);
  });
}

function resolveBrokerStateFile(cwd) {
  return path.join(resolveStateDir(cwd), BROKER_STATE_FILE);
}

export function loadBrokerSession(cwd) {
  const stateFile = resolveBrokerStateFile(cwd);
  if (!fs.existsSync(stateFile)) {
    return null;
  }

  try {
    return JSON.parse(fs.readFileSync(stateFile, "utf8"));
  } catch {
    return null;
  }
}

export function saveBrokerSession(cwd, session) {
  const stateDir = resolveStateDir(cwd);
  fs.mkdirSync(stateDir, { recursive: true });
  const stateFile = resolveBrokerStateFile(cwd);
  const temporaryStateFile = `${stateFile}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporaryStateFile, `${JSON.stringify(session, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600
    });
    fs.renameSync(temporaryStateFile, stateFile);
  } finally {
    if (fs.existsSync(temporaryStateFile)) {
      fs.unlinkSync(temporaryStateFile);
    }
  }
}

export function clearBrokerSession(cwd) {
  const stateFile = resolveBrokerStateFile(cwd);
  if (fs.existsSync(stateFile)) {
    fs.unlinkSync(stateFile);
  }
}

export function loadReusableBrokerSession(cwd, env = process.env) {
  if (!resolveBrokerOwnershipRoot(env) || !hasLiveBrokerOwnerIdentity(env)) {
    return null;
  }
  const session = loadBrokerSession(cwd);
  if (
    session?.activationPending === true ||
    session?.activationFailed === true ||
    session?.registry?.registered !== true ||
    typeof session.pidIdentity !== "string"
  ) {
    return null;
  }
  try {
    if (getProcessIdentity(session.pid, { cwd, env }) !== session.pidIdentity) {
      return null;
    }
  } catch {
    return null;
  }
  const registration = loadBrokerRegistration({
    endpoint: session.endpoint,
    brokerIdentity: session.pidIdentity,
    env
  });
  if (
    registration.registered !== true ||
    registration.brokerKey !== session.registry.brokerKey ||
    registration.registryDir !== session.registry.registryDir
  ) {
    return null;
  }
  try {
    const target = parseBrokerEndpoint(session.endpoint);
    if (target.kind !== "unix" || !fs.lstatSync(target.path).isSocket()) {
      return null;
    }
  } catch {
    return null;
  }
  return { ...session, registry: registration };
}

async function isBrokerEndpointReady(endpoint) {
  if (!endpoint) {
    return false;
  }
  try {
    return await waitForBrokerEndpoint(endpoint, 150);
  } catch {
    return false;
  }
}

async function rollbackNewBrokerSession(cwd, child, session, options) {
  closeBrokerActivationChannels(child);
  const exited = await waitForBrokerProcessExit(child, options.rollbackExitTimeoutMs ?? 1000);
  let cleanup;
  try {
    cleanup = await teardownBrokerSession({
      endpoint: session.endpoint,
      pidFile: session.pidFile,
      logFile: session.logFile,
      sessionDir: session.sessionDir,
      pid: session.pid,
      pidIdentity: session.pidIdentity,
      ownershipSnapshot: session.ownershipSnapshot,
      requireVerifiedOwnership: session.ownershipCaptureFailed === true,
      killProcess: exited ? null : (options.killProcess ?? terminateProcessTree)
    });
  } finally {
    child?.unref?.();
  }

  if (cleanup?.verified === true) {
    clearBrokerSession(cwd);
    return cleanup;
  }

  try {
    saveBrokerSession(cwd, { ...session, activationFailed: true });
  } catch {
    // Preserve the cleanup outcome as the primary failure if even the
    // report-only recovery record cannot be written.
  }
  return cleanup;
}

async function cleanupExistingBrokerSession(cwd, existing, options) {
  const env = options.env ?? process.env;
  const acquireRegistryLock = options.acquireBrokerRegistryLockImpl ?? acquireBrokerRegistryLock;
  const releaseRegistryLock = options.releaseBrokerRegistryLockImpl ?? releaseBrokerRegistryLock;
  const registryLock = acquireRegistryLock(existing.registry);
  if (registryLock?.acquired !== true) {
    const error = new Error(`Broker cleanup eligibility could not be locked (${registryLock?.reason ?? "unknown"}).`);
    error.code = "BROKER_CLEANUP_UNVERIFIED";
    throw error;
  }

  try {
    const loadRegistration = options.loadBrokerRegistrationImpl ?? loadBrokerRegistration;
    const registration = loadRegistration({
      endpoint: existing.endpoint,
      brokerIdentity: existing.pidIdentity,
      env
    });
    if (
      registration.registered !== true ||
      registration.brokerKey !== existing.registry.brokerKey ||
      registration.registryDir !== existing.registry.registryDir
    ) {
      const error = new Error("The existing Codex broker registration is invalid; cleanup remains report-only.");
      error.code = "BROKER_REGISTRATION_REQUIRED";
      throw error;
    }

    const readProcessIdentity = options.getProcessIdentityImpl ?? getProcessIdentity;
    let currentIdentity;
    try {
      currentIdentity = readProcessIdentity(existing.pid, { cwd, env });
    } catch (cause) {
      const error = new Error("Broker liveness could not be verified; cleanup remains report-only.");
      error.code = "BROKER_CLEANUP_UNVERIFIED";
      error.cause = cause;
      throw error;
    }
    if (currentIdentity && currentIdentity !== existing.pidIdentity) {
      const error = new Error("The saved broker PID has been reused; refusing to signal it or start a replacement.");
      error.code = "BROKER_CLEANUP_UNVERIFIED";
      throw error;
    }
    if (currentIdentity === existing.pidIdentity) {
      const assessOwners = options.assessBrokerOwnersImpl ?? assessBrokerOwners;
      const assessment = assessOwners(registration);
      if (assessment?.safeToShutdown !== true) {
        if (assessment?.reason === "live-owner") {
          return { cleaned: false, blockedByLiveOwner: true };
        }
        const error = new Error(`Broker ownership is ambiguous (${assessment?.reason ?? "unknown"}); cleanup remains report-only.`);
        error.code = "BROKER_CLEANUP_UNVERIFIED";
        throw error;
      }
    }

    if (!currentIdentity) {
      const loadChildren = options.loadBrokerChildrenImpl ?? loadBrokerChildren;
      const children = loadChildren(registration);
      if (children?.valid !== true) {
        const error = new Error(`Registered broker children are invalid (${children?.reason ?? "unknown"}); cleanup remains report-only.`);
        error.code = "BROKER_CLEANUP_UNVERIFIED";
        throw error;
      }
      const terminateChild = options.terminateBrokerChildImpl ?? terminateProcessTree;
      const releaseChild = options.releaseBrokerChildImpl ?? releaseBrokerChild;
      for (const child of children.children) {
        const outcome = await terminateChild(child.pid, {
          expectedRootIdentity: child.pidIdentity,
          ownershipSnapshot: child.ownershipSnapshot,
          cwd,
          env
        });
        if (outcome?.verified !== true) {
          const error = new Error("Registered broker child cleanup is unverified; refusing to start a replacement broker.");
          error.code = "BROKER_CLEANUP_UNVERIFIED";
          throw error;
        }
        const released = releaseChild(registration, {
          child,
          cleanupOutcome: outcome,
          registryLock
        });
        if (released?.released !== true) {
          const error = new Error(`Registered broker child release failed (${released?.reason ?? "unknown"}); refusing to start a replacement broker.`);
          error.code = "BROKER_CLEANUP_UNVERIFIED";
          throw error;
        }
      }
    }

    const teardownBroker = options.teardownBrokerSessionImpl ?? teardownBrokerSession;
    const cleanup = await teardownBroker({
      endpoint: existing.endpoint ?? null,
      pidFile: existing.pidFile ?? null,
      logFile: existing.logFile ?? null,
      sessionDir: existing.sessionDir ?? null,
      pid: existing.pid ?? null,
      pidIdentity: existing.pidIdentity ?? null,
      ownershipSnapshot: existing.ownershipSnapshot ?? null,
      requireVerifiedOwnership: existing.ownershipCaptureFailed === true,
      killProcess: options.killProcess ?? terminateProcessTree
    });
    if (cleanup?.verified !== true) {
      const error = new Error("Broker cleanup is unverified; refusing to start another broker session.");
      error.code = "BROKER_CLEANUP_UNVERIFIED";
      throw error;
    }
    clearBrokerSession(cwd);
    return { cleaned: true, cleanup };
  } finally {
    const released = releaseRegistryLock(existing.registry, registryLock);
    if (released?.released !== true) {
      const error = new Error(`Broker registry lock release failed (${released?.reason ?? "unknown"}).`);
      error.code = "BROKER_CLEANUP_UNVERIFIED";
      throw error;
    }
  }
}

async function ensureBrokerSessionLocked(cwd, options = {}) {
  const env = options.env ?? process.env;
  // Automatic brokers are detached and outlive the process that spawned them.
  // Until Windows has a durable, reuse-resistant process identity for the
  // registry, use the attached direct app-server lifecycle instead of
  // publishing an unregistered broker that SessionEnd must refuse to signal.
  const stateFileExists = fs.existsSync(resolveBrokerStateFile(cwd));
  const existing = loadBrokerSession(cwd);
  if (stateFileExists && !existing) {
    return null;
  }
  if (existing && existing.registry?.registered !== true) {
    return null;
  }
  let existingProcessIdentity = null;
  if (existing && existing.activationFailed !== true) {
    try {
      const readProcessIdentity = options.getProcessIdentityImpl ?? getProcessIdentity;
      existingProcessIdentity = readProcessIdentity(existing.pid, { cwd, env });
    } catch (cause) {
      const error = new Error("Existing broker liveness could not be verified; refusing reuse or replacement.");
      error.code = "BROKER_CLEANUP_UNVERIFIED";
      error.cause = cause;
      throw error;
    }
  }
  if (
    existing &&
    existing.activationPending !== true &&
    existing.activationFailed !== true &&
    existingProcessIdentity === existing.pidIdentity &&
    (await isBrokerEndpointReady(existing.endpoint))
  ) {
    const acquireRegistryLock = options.acquireBrokerRegistryLockImpl ?? acquireBrokerRegistryLock;
    const releaseRegistryLock = options.releaseBrokerRegistryLockImpl ?? releaseBrokerRegistryLock;
    const registryLock = acquireRegistryLock(existing.registry);
    if (registryLock?.acquired !== true) {
      return null;
    }
    try {
      const loadRegistration = options.loadBrokerRegistrationImpl ?? loadBrokerRegistration;
      const registration = loadRegistration({
        endpoint: existing.endpoint,
        brokerIdentity: existing.pidIdentity,
        env
      });
      if (
        registration.registered !== true ||
        registration.brokerKey !== existing.registry.brokerKey ||
        registration.registryDir !== existing.registry.registryDir ||
        !hasLiveBrokerOwnerIdentity(env)
      ) {
        return null;
      }
      const readProcessIdentity = options.getProcessIdentityImpl ?? getProcessIdentity;
      if (
        readProcessIdentity(existing.pid, { cwd, env }) !== existing.pidIdentity ||
        !(await isBrokerEndpointReady(existing.endpoint))
      ) {
        return null;
      }
      const registerOwner = options.registerBrokerOwnerImpl ?? registerBrokerOwner;
      const owner = registerOwner(registration, { env, registryLock });
      if (owner.registered !== true) {
        return null;
      }
      return { ...existing, registry: registration };
    } finally {
      const released = releaseRegistryLock(existing.registry, registryLock);
      if (released?.released !== true) {
        const error = new Error(`Broker registry lock release failed (${released?.reason ?? "unknown"}).`);
        error.code = "BROKER_CLEANUP_UNVERIFIED";
        throw error;
      }
    }
  }

  if (existing) {
    const recovery = await cleanupExistingBrokerSession(cwd, existing, options);
    if (recovery.blockedByLiveOwner) {
      return null;
    }
  }

  const sessionDir = createBrokerSessionDir();
  const endpointFactory = options.createBrokerEndpoint ?? createBrokerEndpoint;
  const endpoint = endpointFactory(sessionDir, options.platform);
  const pidFile = path.join(sessionDir, "broker.pid");
  const logFile = path.join(sessionDir, "broker.log");
  const scriptPath =
    options.scriptPath ??
    fileURLToPath(new URL("../app-server-broker.mjs", import.meta.url));

  const spawnBroker = options.spawnBrokerProcessImpl ?? spawnBrokerProcess;
  const child = spawnBroker({
    scriptPath,
    cwd,
    endpoint,
    pidFile,
    logFile,
    env: options.env ?? process.env
  });
  const captureOwnership = options.captureProcessOwnershipImpl ?? captureProcessOwnership;
  let ownershipSnapshot = null;
  let ownershipCaptureFailed = false;
  if ((options.platform ?? process.platform) !== "win32") {
    try {
      ownershipSnapshot = captureOwnership(child.pid ?? Number.NaN, {
        cwd,
        env: options.env ?? process.env,
        platform: options.platform
      });
      ownershipCaptureFailed = !ownershipSnapshot?.rootIdentity;
    } catch {
      ownershipCaptureFailed = true;
    }
  }

  const session = {
    endpoint,
    pidFile,
    logFile,
    sessionDir,
    pid: child.pid ?? null,
    pidIdentity: ownershipSnapshot?.rootIdentity ?? null,
    ownershipSnapshot,
    ownershipCaptureFailed,
    registry: null
  };
  const ready = await waitForBrokerEndpoint(endpoint, options.timeoutMs ?? 2000);
  if (!ready) {
    const cleanup = await rollbackNewBrokerSession(cwd, child, session, options);
    if (cleanup?.verified !== true) {
      const error = new Error("Failed broker startup cleanup is unverified; refusing to create or hide another process.");
      error.code = "BROKER_CLEANUP_UNVERIFIED";
      throw error;
    }
    return null;
  }

  let fallbackToDirect = false;
  let ownerRegistered = false;
  let transactionRegistryLock = null;
  try {
    const publishRegistration = options.publishRegisteredBrokerImpl ?? publishRegisteredBroker;
    const candidate = publishRegistration({
      cwd,
      endpoint,
      pid: child.pid ?? null,
      ownershipSnapshot,
      env,
      retainRegistryLock: true
    });
    if (candidate.registered !== true) {
      fallbackToDirect = [
        "broker-identity-unavailable",
        "broker-not-live",
        "plugin-data-unavailable",
        "session-owner-not-live",
        "session-owner-unavailable"
      ].includes(candidate.reason);
      throw new Error(`Broker registration is unavailable (${candidate.reason ?? "unknown"}).`);
    }
    if (candidate.registryLock?.acquired !== true) {
      throw new Error("Broker registration did not retain the launch transaction lock.");
    }
    transactionRegistryLock = candidate.registryLock;
    const { registryLock: _registryLock, ...registration } = candidate;
    session.registry = registration;
    ownerRegistered = true;
    const saveSession = options.saveBrokerSessionImpl ?? saveBrokerSession;
    session.activationPending = true;
    saveSession(cwd, session);

    const activateBroker = options.activateBrokerProcessImpl ?? activateBrokerProcess;
    await activateBroker(child, options.activationTimeoutMs ?? 2000);
    session.activationPending = false;
    saveSession(cwd, session);
    return session;
  } catch (error) {
    // Keep the initial owner and the publication-time registry lock intact
    // until exact rollback has converged. Otherwise a reaper can classify the
    // half-launched broker as abandoned and race the launcher's own teardown.
    const cleanup = await rollbackNewBrokerSession(cwd, child, session, options);
    if (ownerRegistered && cleanup?.verified === true) {
      const releaseOwner = options.releaseBrokerOwnerImpl ?? releaseBrokerOwner;
      try {
        const released = releaseOwner(session.registry, {
          env,
          ...(transactionRegistryLock ? { registryLock: transactionRegistryLock } : {})
        });
        if (released.released !== true) {
          process.stderr.write(`Warning: unable to release rolled-back Codex broker owner (${released.reason ?? "unknown"}).\n`);
        }
      } catch (releaseError) {
        process.stderr.write(`Warning: unable to release rolled-back Codex broker owner: ${releaseError.message}.\n`);
      }
    }
    if (cleanup?.verified !== true) {
      const cleanupError = new Error(`Broker launch failed and exact rollback is unverified: ${error.message}`);
      cleanupError.code = "BROKER_CLEANUP_UNVERIFIED";
      cleanupError.cause = error;
      throw cleanupError;
    }
    if (fallbackToDirect) {
      options.onUnavailable?.("broker registration unavailable");
      return null;
    }
    const transactionError = new Error(`Broker launch transaction failed: ${error.message}`);
    transactionError.code = "BROKER_REGISTRATION_FAILED";
    transactionError.cause = error;
    throw transactionError;
  } finally {
    if (transactionRegistryLock && session.registry) {
      const releaseRegistryLock = options.releaseBrokerRegistryLockImpl ?? releaseBrokerRegistryLock;
      const released = releaseRegistryLock(session.registry, transactionRegistryLock);
      if (released?.released !== true) {
        const lockError = new Error(`Broker launch transaction lock release failed (${released?.reason ?? "unknown"}).`);
        lockError.code = "BROKER_CLEANUP_UNVERIFIED";
        throw lockError;
      }
    }
  }
}

export async function ensureBrokerSession(cwd, options = {}) {
  if ((options.platform ?? process.platform) === "win32") {
    options.onUnavailable?.("unsupported on Windows");
    return null;
  }
  const env = options.env ?? process.env;
  const hasLiveOwner = options.hasLiveBrokerOwnerIdentityImpl ?? hasLiveBrokerOwnerIdentity;
  if (!resolveBrokerOwnershipRoot(env) || !hasLiveOwner(env)) {
    options.onUnavailable?.("session ownership unavailable");
    return null;
  }
  const acquireLaunchLock = options.acquireBrokerLaunchLockImpl ?? acquireBrokerLaunchLock;
  let launchLock;
  try {
    launchLock = await acquireLaunchLock(cwd, { timeoutMs: options.launchLockTimeoutMs ?? 10_000 });
  } catch {
    options.onUnavailable?.("broker launch lock unavailable");
    return null;
  }
  try {
    return await ensureBrokerSessionLocked(cwd, options);
  } finally {
    await launchLock.release();
  }
}

export async function teardownBrokerSession({
  endpoint = null,
  pidFile,
  logFile,
  sessionDir = null,
  pid = null,
  pidIdentity = null,
  ownershipSnapshot = null,
  requireVerifiedOwnership = false,
  killProcess = null
}) {
  let cleanupOutcome = {
    attempted: false,
    delivered: false,
    verified: true,
    degraded: false,
    method: null,
    targets: [],
    targetIdentities: [],
    survivors: [],
    survivorIdentities: []
  };
  if (Number.isFinite(pid) && killProcess) {
    try {
      const outcome = await killProcess(pid, {
        expectedRootIdentity: pidIdentity,
        ownershipSnapshot,
        requireVerifiedOwnership
      });
      cleanupOutcome = outcome ?? {
        ...cleanupOutcome,
        attempted: true,
        verified: false,
        degraded: true
      };
    } catch (error) {
      if (error?.code !== "ESRCH" && error?.code !== "ENOENT") {
        throw error;
      }
    }
    if (cleanupOutcome.verified !== true) {
      return cleanupOutcome;
    }
  }

  if (pidFile && fs.existsSync(pidFile)) {
    fs.unlinkSync(pidFile);
  }

  if (logFile && fs.existsSync(logFile)) {
    fs.unlinkSync(logFile);
  }

  if (endpoint) {
    try {
      const target = parseBrokerEndpoint(endpoint);
      if (target.kind === "unix" && fs.existsSync(target.path)) {
        fs.unlinkSync(target.path);
      }
    } catch {
      // Ignore malformed or already-removed broker endpoints during teardown.
    }
  }

  const resolvedSessionDir = sessionDir ?? (pidFile ? path.dirname(pidFile) : logFile ? path.dirname(logFile) : null);
  if (resolvedSessionDir && fs.existsSync(resolvedSessionDir)) {
    try {
      fs.rmdirSync(resolvedSessionDir);
    } catch {
      // Ignore non-empty or missing directories.
    }
  }
  return cleanupOutcome;
}
