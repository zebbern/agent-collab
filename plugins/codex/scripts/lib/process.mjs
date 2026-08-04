import { spawnSync } from "node:child_process";
import process from "node:process";

export function runCommand(command, args = [], options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    input: options.input,
    maxBuffer: options.maxBuffer,
    stdio: options.stdio ?? "pipe",
    shell: options.shell ?? (process.platform === "win32" ? (process.env.SHELL || true) : false),
    windowsHide: true
  });

  return {
    command,
    args,
    status: result.status ?? 0,
    signal: result.signal ?? null,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error ?? null
  };
}

export function runCommandChecked(command, args = [], options = {}) {
  const result = runCommand(command, args, options);
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(formatCommandFailure(result));
  }
  return result;
}

export function binaryAvailable(command, versionArgs = ["--version"], options = {}) {
  const result = runCommand(command, versionArgs, options);
  if (result.error && /** @type {NodeJS.ErrnoException} */ (result.error).code === "ENOENT") {
    return { available: false, detail: "not found" };
  }
  if (result.error) {
    return { available: false, detail: result.error.message };
  }
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`;
    return { available: false, detail };
  }
  return { available: true, detail: result.stdout.trim() || result.stderr.trim() || "ok" };
}

function looksLikeMissingProcessMessage(text) {
  return /not found|no running instance|cannot find|does not exist|no such process/i.test(text);
}

const UNIX_PROCESS_TABLE_ARGS = ["-axo", "pid=,ppid=,pgid=,sess=,stat=,lstart="];
const UNIX_PS_COMMAND = "/bin/ps";
const UNIX_PS_PATH_COMMAND = "ps";

function createProcessTableError(message) {
  const error = new Error(message);
  error.code = "PROCESS_TABLE_UNAVAILABLE";
  return error;
}

function readUnixProcessTable(runCommandImpl, options = {}) {
  let result = runCommandImpl(UNIX_PS_COMMAND, UNIX_PROCESS_TABLE_ARGS, {
    cwd: options.cwd,
    env: options.env
  });
  if (result.error?.code === "ENOENT") {
    result = runCommandImpl(UNIX_PS_PATH_COMMAND, UNIX_PROCESS_TABLE_ARGS, {
      cwd: options.cwd,
      env: options.env
    });
  }
  if (result.error || result.status !== 0) {
    const detail = result.error?.message || result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`;
    throw createProcessTableError(`Unable to enumerate Unix processes: ${detail || `exit ${result.status}`}`);
  }

  const processes = new Map();
  for (const line of result.stdout.split("\n")) {
    const trimmedLine = line.trim();
    if (!trimmedLine) {
      continue;
    }
    const match = trimmedLine.match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/);
    const legacyMatch = match ? null : trimmedLine.match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/);
    const parsed = match ?? legacyMatch;
    if (!parsed) {
      throw createProcessTableError(`Unable to parse Unix process table line: ${trimmedLine}`);
    }
    const pid = Number(parsed[1]);
    const parentPid = Number(parsed[2]);
    const processGroupId = Number(parsed[3]);
    const parsedSessionId = match ? Number(parsed[4]) : null;
    // Darwin's `sess` is the security audit session, not the POSIX process
    // session used for containment. Never treat it as a child-tree boundary.
    const sessionId =
      (options.platform ?? process.platform) !== "darwin" &&
      Number.isSafeInteger(parsedSessionId) &&
      parsedSessionId > 1
        ? parsedSessionId
        : null;
    const state = parsed[match ? 5 : 4];
    const startedAt = parsed[match ? 6 : 5].trim();
    if (
      !Number.isSafeInteger(pid) ||
      !Number.isSafeInteger(parentPid) ||
      !Number.isSafeInteger(processGroupId) ||
      !startedAt
    ) {
      throw createProcessTableError(`Unable to parse Unix process table line: ${trimmedLine}`);
    }
    processes.set(pid, {
      pid,
      parentPid,
      processGroupId,
      sessionId,
      state,
      startedAt,
      identity: `${pid}@${startedAt}`
    });
  }
  return processes;
}

function isRunningProcess(record) {
  return record && !record.state.startsWith("Z");
}

function collectProcessTree(rootPid, processes, rootDepth = 0) {
  const childrenByParent = new Map();
  for (const record of processes.values()) {
    const children = childrenByParent.get(record.parentPid) ?? [];
    children.push(record);
    childrenByParent.set(record.parentPid, children);
  }

  const records = [];
  const visited = new Set();
  const visit = (parentPid, depth) => {
    if (visited.has(parentPid)) {
      return;
    }
    visited.add(parentPid);
    for (const child of childrenByParent.get(parentPid) ?? []) {
      visit(child.pid, depth + 1);
      records.push({ ...child, depth: depth + 1 });
    }
  };
  visit(rootPid, rootDepth);
  const root = processes.get(rootPid);
  if (root) {
    records.push({ ...root, depth: rootDepth });
  }
  return records;
}

export function captureProcessOwnership(pid, options = {}) {
  if (!Number.isFinite(pid) || (options.platform ?? process.platform) === "win32") {
    return null;
  }

  const processes = readUnixProcessTable(options.runCommandImpl ?? runCommand, options);
  const root = processes.get(pid);
  if (!root) {
    return null;
  }

  return {
    rootPid: root.pid,
    rootIdentity: root.identity,
    processGroupId: root.processGroupId,
    sessionId: root.sessionId,
    members: collectProcessTree(pid, processes).map((record) => ({ ...record }))
  };
}

export function captureStableSessionOwner(pid = process.pid, options = {}) {
  if (!Number.isFinite(pid) || (options.platform ?? process.platform) === "win32") {
    return null;
  }
  const processes = readUnixProcessTable(options.runCommandImpl ?? runCommand, options);
  const current = processes.get(pid);
  if (!isRunningProcess(current) || current.processGroupId === pid) {
    return null;
  }
  const leader = processes.get(current.processGroupId);
  if (!isRunningProcess(leader) || leader.pid !== leader.processGroupId) {
    return null;
  }
  return {
    pid: leader.pid,
    identity: leader.identity,
    processGroupId: leader.processGroupId
  };
}

function recordsFromOwnershipSnapshot(snapshot) {
  return (snapshot?.members ?? []).filter((record) => {
    return Number.isFinite(record.pid) && typeof record.identity === "string" && record.identity.length > 0;
  });
}

function identitiesByPid(identities) {
  const result = new Map();
  for (const identity of identities ?? []) {
    const match = String(identity).match(/^(\d+)@/);
    if (match) {
      result.set(Number(match[1]), String(identity));
    }
  }
  return result;
}

export function normalizeProcessCleanupOutcome(outcome = {}) {
  return {
    attempted: Boolean(outcome.attempted),
    delivered: Boolean(outcome.delivered),
    verified: outcome.verified === true,
    degraded: Boolean(outcome.degraded),
    method: outcome.method ?? null,
    escalated: Boolean(outcome.escalated),
    targets: Array.isArray(outcome.targets) ? outcome.targets : [],
    targetIdentities: Array.isArray(outcome.targetIdentities) ? outcome.targetIdentities : [],
    survivors: Array.isArray(outcome.survivors) ? outcome.survivors : [],
    survivorIdentities: Array.isArray(outcome.survivorIdentities) ? outcome.survivorIdentities : [],
    ...(outcome.identityMismatch ? { identityMismatch: true } : {}),
    ...(outcome.reason ? { reason: outcome.reason } : {})
  };
}

function sleep(milliseconds) {
  if (milliseconds <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function getProcessIdentity(pid, options = {}) {
  if (!Number.isFinite(pid) || (options.platform ?? process.platform) === "win32") {
    return null;
  }
  return readUnixProcessTable(options.runCommandImpl ?? runCommand, options).get(pid)?.identity ?? null;
}

export function hasLiveProcessIdentity(pid, identity, options = {}) {
  if (
    !Number.isFinite(pid) ||
    typeof identity !== "string" ||
    !identity ||
    (options.platform ?? process.platform) === "win32"
  ) {
    return false;
  }
  const current = readUnixProcessTable(options.runCommandImpl ?? runCommand, options).get(pid);
  return isRunningProcess(current) && current.identity === identity;
}

export function getLiveProcessPids(pids, options = {}) {
  const candidates = [...new Set((pids ?? []).filter((pid) => Number.isFinite(pid)))];
  const expectedIdentities = identitiesByPid(options.identities);
  if (candidates.length === 0) {
    return [];
  }
  if ((options.platform ?? process.platform) === "win32") {
    const killImpl = options.killImpl ?? process.kill.bind(process);
    return candidates.filter((pid) => {
      try {
        killImpl(pid, 0);
        return true;
      } catch (error) {
        return error?.code !== "ESRCH";
      }
    });
  }

  try {
    const processes = readUnixProcessTable(options.runCommandImpl ?? runCommand, options);
    return candidates.filter((pid) => {
      const current = processes.get(pid);
      return isRunningProcess(current) && (!expectedIdentities.has(pid) || expectedIdentities.get(pid) === current.identity);
    });
  } catch {
    // An unverified cleanup remains blocked when liveness cannot be checked.
    return candidates;
  }
}

function mergeTrackedDescendants(tracked, processes, rootPid, rootIdentity) {
  const trackedByPid = new Map([...tracked.values()].map((record) => [record.pid, record.identity]));
  const roots = [];
  const currentRoot = processes.get(rootPid);
  if (currentRoot?.identity === rootIdentity) {
    roots.push({ pid: rootPid, depth: 0 });
  }
  for (const trackedRecord of tracked.values()) {
    const current = processes.get(trackedRecord.pid);
    if (current?.identity === trackedRecord.identity) {
      roots.push({ pid: current.pid, depth: trackedRecord.depth });
    }
  }
  for (const root of roots) {
    const records = collectProcessTree(root.pid, processes, root.depth).sort((left, right) => left.depth - right.depth);
    for (const record of records) {
      const priorIdentity = trackedByPid.get(record.pid);
      if (priorIdentity && priorIdentity !== record.identity) {
        continue;
      }
      if (record.pid !== root.pid) {
        const parentIdentity = trackedByPid.get(record.parentPid);
        if (!parentIdentity || processes.get(record.parentPid)?.identity !== parentIdentity) {
          continue;
        }
      }
      if (!tracked.has(record.identity)) {
        tracked.set(record.identity, record);
        trackedByPid.set(record.pid, record.identity);
      }
    }
  }
}

function listLiveTracked(tracked, processes) {
  return [...tracked.values()].filter((record) => {
    const current = processes.get(record.pid);
    return current?.identity === record.identity && isRunningProcess(current);
  });
}

function buildSignalUnits(records) {
  const groupLeaders = new Map();
  for (const record of records) {
    if (record.pid === record.processGroupId) {
      groupLeaders.set(record.processGroupId, record);
    }
  }

  const units = [];
  for (const record of records) {
    const groupLeader = groupLeaders.get(record.processGroupId);
    if (groupLeader && groupLeader.identity !== record.identity) {
      continue;
    }
    units.push({
      record,
      group: record.pid === record.processGroupId
    });
  }
  units.sort((left, right) => right.record.depth - left.record.depth);
  return units;
}

function mergeTrackedGroupMembers(tracked, processes, units) {
  const trackedByPid = new Map([...tracked.values()].map((record) => [record.pid, record.identity]));
  for (const unit of units) {
    if (!unit.group) {
      continue;
    }
    for (const record of processes.values()) {
      if (record.processGroupId !== unit.record.processGroupId) {
        continue;
      }
      const priorIdentity = trackedByPid.get(record.pid);
      if (priorIdentity && priorIdentity !== record.identity) {
        continue;
      }
      if (!tracked.has(record.identity)) {
        tracked.set(record.identity, { ...record, depth: unit.record.depth + 1 });
        trackedByPid.set(record.pid, record.identity);
      }
    }
  }
}

function signalVerifiedUnit(unit, signal, processes, killImpl) {
  const current = processes.get(unit.record.pid);
  if (current?.identity !== unit.record.identity || !isRunningProcess(current)) {
    return false;
  }
  if (unit.group && current.processGroupId !== current.pid) {
    return false;
  }

  const target = unit.group ? -current.pid : current.pid;
  try {
    killImpl(target, signal);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH" || error?.code === "EPERM") {
      // On macOS a process-group signal can race the group leader's exit and
      // return EPERM. Never infer success from the errno; the caller's fresh
      // process-table poll decides whether cleanup is verified.
      return false;
    }
    if (error instanceof Error) {
      error.message = `Unable to signal owned process ${unit.record.identity} with ${signal} via target ${target}: ${error.message}`;
    }
    throw error;
  }
}

function withoutExcluded(records, excludePids) {
  if (!excludePids || excludePids.size === 0) {
    return records;
  }
  return records.filter((record) => !excludePids.has(record.pid));
}

function signalTracked(tracked, signal, options) {
  const processes = readUnixProcessTable(options.runCommandImpl, options);
  mergeTrackedDescendants(tracked, processes, options.rootPid, options.rootIdentity);
  mergeTrackedGroupMembers(tracked, processes, buildSignalUnits(listLiveTracked(tracked, processes)));
  const units = buildSignalUnits(withoutExcluded(listLiveTracked(tracked, processes), options.excludePids));
  let delivered = false;
  for (const unit of units) {
    delivered = signalVerifiedUnit(unit, signal, processes, options.killImpl) || delivered;
  }
  return delivered;
}

async function pollTracked(tracked, options, attempts) {
  let live = [];
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const processes = readUnixProcessTable(options.runCommandImpl, options);
    mergeTrackedDescendants(tracked, processes, options.rootPid, options.rootIdentity);
    live = withoutExcluded(listLiveTracked(tracked, processes), options.excludePids);
    if (live.length === 0) {
      break;
    }
    if (attempt + 1 < attempts) {
      await options.sleepImpl(options.pollIntervalMs);
    }
  }
  return live;
}

function warnProcessCleanup(message, options) {
  const warnImpl = options.warnImpl ?? ((warning) => process.stderr.write(`${warning}\n`));
  try {
    warnImpl(message);
  } catch {
    // Cleanup warnings must not turn a best-effort kill into a host failure.
  }
}

function windowsTasklistShowsPid(pid, stdout) {
  const expected = String(pid);
  for (const line of stdout.split("\n")) {
    const trimmedLine = line.trim();
    if (!trimmedLine.startsWith('"')) {
      continue;
    }
    const pidField = trimmedLine.split('","')[1]?.replace(/"/g, "").trim();
    if (pidField === expected) {
      return true;
    }
  }
  return false;
}

function verifyWindowsTaskkillCleanup(pid, options, runCommandImpl) {
  // taskkill /T can report success while the root process resists /F or a
  // descendant outlives it, so exit 0 alone never verifies the cleanup.
  // Recheck the root pid with tasklist. The recheck only covers the root pid:
  // without identity-tracked process enumeration on Windows, a descendant
  // that survived taskkill /T remains a documented blind spot.
  const check = runCommandImpl("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], {
    cwd: options.cwd,
    env: options.env
  });
  if (check.error || check.status !== 0) {
    const detail = check.error?.message || check.stderr.trim() || check.stdout.trim() || `exit ${check.status}`;
    warnProcessCleanup(
      `Unable to verify Windows process cleanup for PID ${pid}; tasklist recheck failed (${String(detail).replace(/\s+/g, " ").trim()}). Surviving PIDs: ${pid}.`,
      options
    );
    return normalizeProcessCleanupOutcome({
      attempted: true,
      delivered: true,
      verified: false,
      degraded: true,
      method: "taskkill",
      survivors: [pid],
      reason: "tasklist liveness recheck failed"
    });
  }
  if (windowsTasklistShowsPid(pid, check.stdout)) {
    warnProcessCleanup(
      `taskkill reported success for PID ${pid} but the process is still running; cleanup is unverified. Surviving PIDs: ${pid}.`,
      options
    );
    return normalizeProcessCleanupOutcome({
      attempted: true,
      delivered: true,
      verified: false,
      degraded: true,
      method: "taskkill",
      survivors: [pid],
      reason: "process still running after taskkill"
    });
  }
  return normalizeProcessCleanupOutcome({ attempted: true, delivered: true, verified: true, method: "taskkill" });
}

function degradedDirectChildKill(pid, options, killImpl, reason) {
  const ownershipSnapshot = options.ownershipSnapshot ?? null;
  const ownerHoldsLiveHandle = options.ownerHoldsLiveHandle === true;
  const canSignalOwnedGroup =
    ownerHoldsLiveHandle &&
    ownershipSnapshot?.rootPid === pid &&
    ownershipSnapshot?.processGroupId === pid &&
    ownershipSnapshot?.rootIdentity === (options.expectedRootIdentity ?? ownershipSnapshot?.rootIdentity);
  if (!ownerHoldsLiveHandle) {
    warnProcessCleanup(
      `Unable to verify Unix process cleanup for PID ${pid}; deferred signalling until process enumeration recovers (${String(reason).replace(/\s+/g, " ").trim()}). Surviving PIDs: ${pid}.`,
      options
    );
    return normalizeProcessCleanupOutcome({
      attempted: true,
      delivered: false,
      verified: false,
      escalated: false,
      degraded: true,
      method: "deferred",
      targets: [],
      targetIdentities: options.expectedRootIdentity ? [options.expectedRootIdentity] : [],
      survivors: [pid],
      survivorIdentities: options.expectedRootIdentity ? [options.expectedRootIdentity] : []
    });
  }
  const directKillImpl = options.directKillImpl ?? ((signal) => killImpl(pid, signal));
  let delivered = false;
  try {
    delivered = canSignalOwnedGroup
      ? killImpl(-pid, "SIGKILL") !== false
      : directKillImpl("SIGKILL") !== false;
  } catch {
    // The direct child may already have exited.
  }
  warnProcessCleanup(
    `Unable to verify Unix process cleanup for PID ${pid}; used ${canSignalOwnedGroup ? "process-group" : "direct-child"} kill fallback (${String(reason).replace(/\s+/g, " ").trim()}). Surviving PIDs: none known.`,
    options
  );
  return normalizeProcessCleanupOutcome({
    attempted: true,
    delivered,
    verified: false,
    escalated: false,
    degraded: true,
    method: canSignalOwnedGroup ? "process-group" : "direct-child",
    targets: canSignalOwnedGroup
      ? recordsFromOwnershipSnapshot(ownershipSnapshot).map((record) => record.pid)
      : [pid],
    targetIdentities: canSignalOwnedGroup
      ? recordsFromOwnershipSnapshot(ownershipSnapshot).map((record) => record.identity)
      : options.expectedRootIdentity ? [options.expectedRootIdentity] : [],
    survivors: [],
    survivorIdentities: []
  });
}

export async function terminateProcessTree(pid, options = {}) {
  if (!Number.isFinite(pid)) {
    const ownershipSnapshot = options.ownershipSnapshot ?? null;
    if (Number.isFinite(ownershipSnapshot?.rootPid)) {
      return terminateProcessTree(ownershipSnapshot.rootPid, options);
    }
    const ownershipEstablished = Boolean(options.expectedRootIdentity || options.requireVerifiedOwnership);
    return normalizeProcessCleanupOutcome({
      attempted: false,
      delivered: false,
      verified: !ownershipEstablished,
      degraded: ownershipEstablished,
      method: null
    });
  }

  const platform = options.platform ?? process.platform;
  const runCommandImpl = options.runCommandImpl ?? runCommand;
  const killImpl = options.killImpl ?? process.kill.bind(process);
  const ownershipSnapshot = options.ownershipSnapshot ?? null;
  const expectedRootIdentity = options.expectedRootIdentity ?? ownershipSnapshot?.rootIdentity ?? null;
  const ownershipCaptureFailed = options.requireVerifiedOwnership === true;
  const captureFailureCleanupAllowed =
    ownershipCaptureFailed && options.ownerHoldsLiveHandle === true;
  const ownershipEstablished = Boolean(ownershipSnapshot || expectedRootIdentity || ownershipCaptureFailed);

  if (platform === "win32") {
    const result = runCommandImpl("taskkill", ["/PID", String(pid), "/T", "/F"], {
      cwd: options.cwd,
      env: options.env
    });

    if (!result.error && result.status === 0) {
      return { ...verifyWindowsTaskkillCleanup(pid, options, runCommandImpl), result };
    }

    const combinedOutput = `${result.stderr}\n${result.stdout}`.trim();
    if (!result.error && looksLikeMissingProcessMessage(combinedOutput)) {
      return { ...normalizeProcessCleanupOutcome({ attempted: true, delivered: false, verified: true, method: "taskkill" }), result };
    }

    if (result.error?.code === "ENOENT") {
      try {
        killImpl(pid);
        return normalizeProcessCleanupOutcome({ attempted: true, delivered: true, verified: true, method: "kill" });
      } catch (error) {
        if (error?.code === "ESRCH") {
          return normalizeProcessCleanupOutcome({ attempted: true, delivered: false, verified: true, method: "kill" });
        }
        throw error;
      }
    }

    if (result.error) {
      throw result.error;
    }

    throw new Error(formatCommandFailure(result));
  }

  let initialProcesses;
  try {
    initialProcesses = readUnixProcessTable(runCommandImpl, options);
  } catch (error) {
    if (error?.code !== "PROCESS_TABLE_UNAVAILABLE") {
      throw error;
    }
    if (!expectedRootIdentity && !captureFailureCleanupAllowed) {
      return normalizeProcessCleanupOutcome({
        attempted: true,
        delivered: false,
        verified: false,
        degraded: true,
        method: "process-tree",
        targets: [],
        survivors: [pid],
        survivorIdentities: []
      });
    }
    return degradedDirectChildKill(pid, options, killImpl, error.message);
  }
  const root = initialProcesses.get(pid);
  if (!expectedRootIdentity && !captureFailureCleanupAllowed) {
    return normalizeProcessCleanupOutcome({
      attempted: true,
      delivered: false,
      verified: false,
      degraded: true,
      method: "process-tree",
      targets: [],
      survivors: [pid],
      survivorIdentities: []
    });
  }
  if (root && expectedRootIdentity && root.identity !== expectedRootIdentity) {
    return normalizeProcessCleanupOutcome({
      attempted: true,
      delivered: false,
      verified: false,
      degraded: ownershipEstablished,
      identityMismatch: true,
      method: "process-tree",
      targets: []
    });
  }

  const tracked = new Map();
  for (const record of recordsFromOwnershipSnapshot(ownershipSnapshot)) {
    tracked.set(record.identity, record);
  }
  for (const record of root ? collectProcessTree(pid, initialProcesses) : []) {
    tracked.set(record.identity, record);
  }
  const sortedTracked = () =>
    [...tracked.values()].sort((left, right) => right.depth - left.depth);
  if (!root && listLiveTracked(tracked, initialProcesses).length === 0) {
    const degradedWithoutDurableSnapshot = options.priorCleanupDegraded === true && recordsFromOwnershipSnapshot(ownershipSnapshot).length === 0;
    const verified = !options.requireVerifiedOwnership && ownershipEstablished && !degradedWithoutDurableSnapshot;
    return normalizeProcessCleanupOutcome({
      attempted: true,
      delivered: false,
      verified,
      degraded: ownershipEstablished && !verified,
      method: "process-tree",
      targets: sortedTracked().map((record) => record.pid),
      targetIdentities: sortedTracked().map((record) => record.identity)
    });
  }
  let cleanupRootIdentity = expectedRootIdentity;
  if (!cleanupRootIdentity && captureFailureCleanupAllowed && root) {
    // A live, unreaped child handle prevents PID reuse. Its owner may use the
    // current identity for best-effort cleanup, but the result stays unverified.
    cleanupRootIdentity = root.identity;
  }
  const unixOptions = {
    rootPid: pid,
    rootIdentity: cleanupRootIdentity,
    runCommandImpl,
    killImpl,
    cwd: options.cwd,
    env: options.env,
    sleepImpl: options.sleepImpl ?? sleep,
    pollIntervalMs: options.pollIntervalMs ?? 25
  };

  try {
    let delivered = false;
    let escalated = false;
    let live = [];
    // Terminate descendants first and wait for them while their parent is
    // still alive, so the parent can reap them; killing the whole tree
    // back-to-back leaves permanent zombies where PID 1 does not reap orphans
    // (containers). Both phases share the one tracked map so PID-reuse
    // identity memory carries across phases; the descendant phase only
    // excludes the root pid from signaling and liveness.
    const hasDescendants = [...tracked.values()].some((record) => record.pid !== pid);
    const phases = hasDescendants
      ? [{ ...unixOptions, excludePids: new Set([pid]) }, unixOptions]
      : [unixOptions];
    for (const phaseOptions of phases) {
      delivered = signalTracked(tracked, "SIGTERM", phaseOptions) || delivered;
      let phaseLive = await pollTracked(tracked, phaseOptions, options.termPollAttempts ?? 11);
      if (phaseLive.length > 0) {
        escalated = true;
        delivered = signalTracked(tracked, "SIGKILL", phaseOptions) || delivered;
        phaseLive = await pollTracked(tracked, phaseOptions, options.killPollAttempts ?? 11);
      }
      live = phaseLive;
    }

    const verified =
      live.length === 0 &&
      !options.requireVerifiedOwnership &&
      ownershipEstablished;
    return normalizeProcessCleanupOutcome({
      attempted: true,
      delivered,
      verified,
      degraded: ownershipEstablished && !verified,
      escalated,
      method: "process-tree",
      // The algorithm covers same-process-group descendants plus those observed at scan time.
      // A post-scan setsid descendant can escape the tracked process tree.
      targets: sortedTracked().map((record) => record.pid),
      targetIdentities: sortedTracked().map((record) => record.identity),
      survivors: live.map((record) => record.pid),
      survivorIdentities: live.map((record) => record.identity)
    });
  } catch (error) {
    if (error?.code !== "PROCESS_TABLE_UNAVAILABLE") {
      throw error;
    }
    return degradedDirectChildKill(pid, options, killImpl, error.message);
  }
}

export async function terminateProcessGroup(pgid, options = {}) {
  if (!Number.isFinite(pgid)) {
    return normalizeProcessCleanupOutcome({ attempted: false, delivered: false, verified: false, degraded: true });
  }
  if ((options.platform ?? process.platform) === "win32") {
    return normalizeProcessCleanupOutcome({ attempted: false, delivered: false, verified: false, degraded: true });
  }

  const runCommandImpl = options.runCommandImpl ?? runCommand;
  const killImpl = options.killImpl ?? process.kill.bind(process);

  let processes;
  try {
    processes = readUnixProcessTable(runCommandImpl, options);
  } catch (error) {
    if (error?.code !== "PROCESS_TABLE_UNAVAILABLE") {
      throw error;
    }
    warnProcessCleanup(
      `Unable to enumerate Unix processes while reclaiming process group ${pgid}; surviving PIDs unknown.`,
      options
    );
    return normalizeProcessCleanupOutcome({
      attempted: false,
      delivered: false,
      verified: false,
      degraded: true,
      survivors: recordsFromOwnershipSnapshot(options.ownershipSnapshot).map((record) => record.pid),
      survivorIdentities: recordsFromOwnershipSnapshot(options.ownershipSnapshot).map((record) => record.identity)
    });
  }

  const tracked = new Map();
  const ownershipSnapshot = options.ownershipSnapshot ?? null;
  const ownershipEstablished = Boolean(ownershipSnapshot);
  const ownershipSessionId =
    Number.isSafeInteger(ownershipSnapshot?.sessionId) &&
    ownershipSnapshot.sessionId > 1 &&
    ownershipSnapshot.rootPid === ownershipSnapshot.sessionId
      ? ownershipSnapshot.sessionId
      : null;
  const cleanupMethod = ownershipSessionId ? "process-session" : "process-group";
  // If a live process holds this group id but is not the root we recorded, the
  // id has been reused and nothing in the group is ours. Refuse before
  // admitting any member: members of an unrelated group are absent from the
  // snapshot, so the per-record check below would admit them, and the leader
  // identity check runs only after signals have already been delivered.
  // A missing leader is not a mismatch — that is the crashed-root case where
  // surviving helpers still need reclaiming.
  const groupLeader = processes.get(pgid);
  if (ownershipSnapshot && groupLeader && groupLeader.identity !== ownershipSnapshot.rootIdentity) {
    return normalizeProcessCleanupOutcome({
      attempted: false,
      delivered: false,
      verified: false,
      degraded: true,
      identityMismatch: true,
      method: cleanupMethod,
      survivors: recordsFromOwnershipSnapshot(ownershipSnapshot).map((record) => record.pid),
      survivorIdentities: recordsFromOwnershipSnapshot(ownershipSnapshot).map((record) => record.identity)
    });
  }
  const sessionLeader = ownershipSessionId ? processes.get(ownershipSessionId) : null;
  if (ownershipSessionId && sessionLeader && sessionLeader.identity !== ownershipSnapshot.rootIdentity) {
    return normalizeProcessCleanupOutcome({
      attempted: false,
      delivered: false,
      verified: false,
      degraded: true,
      identityMismatch: true,
      method: cleanupMethod,
      survivors: recordsFromOwnershipSnapshot(ownershipSnapshot).map((record) => record.pid),
      survivorIdentities: recordsFromOwnershipSnapshot(ownershipSnapshot).map((record) => record.identity)
    });
  }
  for (const record of recordsFromOwnershipSnapshot(ownershipSnapshot)) {
    tracked.set(record.identity, record);
  }
  let ownershipScopeMembersFound = false;
  let ownershipSelectionFound = false;
  for (const record of processes.values()) {
    const inOwnedScope =
      record.processGroupId === pgid ||
      (ownershipSessionId !== null && record.sessionId === ownershipSessionId);
    if (!inOwnedScope || !isRunningProcess(record)) {
      continue;
    }
    ownershipScopeMembersFound = true;
    const snapshotRecord = recordsFromOwnershipSnapshot(ownershipSnapshot).find((candidate) => candidate.pid === record.pid);
    if (ownershipSnapshot && snapshotRecord && snapshotRecord.identity !== record.identity) {
      continue;
    }
    ownershipSelectionFound = true;
    tracked.set(record.identity, {
      ...record,
      depth: Number.isSafeInteger(record.depth) ? record.depth : record.pid === pgid ? 0 : 1
    });
  }
  if (tracked.size === 0) {
    return normalizeProcessCleanupOutcome({
      attempted: false,
      delivered: false,
      verified: !ownershipEstablished,
      degraded: ownershipEstablished,
      survivors: [],
      survivorIdentities: []
    });
  }

  const unixOptions = {
    runCommandImpl,
    killImpl,
    cwd: options.cwd,
    env: options.env,
    sleepImpl: options.sleepImpl ?? sleep,
    pollIntervalMs: options.pollIntervalMs ?? 25
  };

  try {
    let delivered = signalTracked(tracked, "SIGTERM", unixOptions);
    let live = await pollTracked(tracked, unixOptions, options.termPollAttempts ?? 11);
    let escalated = false;
    if (live.length > 0) {
      escalated = true;
      delivered = signalTracked(tracked, "SIGKILL", unixOptions) || delivered;
      live = await pollTracked(tracked, unixOptions, options.killPollAttempts ?? 11);
    }
    const root = processes.get(pgid);
    const rootIdentityMatches = !root || root.identity === ownershipSnapshot?.rootIdentity;
    const ownedScopeAccountedFor = ownershipSelectionFound || !ownershipScopeMembersFound;
    return normalizeProcessCleanupOutcome({
      attempted: true,
      delivered,
      verified: live.length === 0 && (!ownershipEstablished || (rootIdentityMatches && ownedScopeAccountedFor)),
      degraded: ownershipEstablished && (!rootIdentityMatches || !ownedScopeAccountedFor),
      escalated,
      method: cleanupMethod,
      targets: [...tracked.values()].map((record) => record.pid),
      targetIdentities: [...tracked.values()].map((record) => record.identity),
      survivors: live.map((record) => record.pid),
      survivorIdentities: live.map((record) => record.identity)
    });
  } catch (error) {
    if (error?.code !== "PROCESS_TABLE_UNAVAILABLE") {
      throw error;
    }
    warnProcessCleanup(
      `Unable to verify Unix process-group cleanup for pgid ${pgid}; surviving PIDs unknown.`,
      options
    );
    return normalizeProcessCleanupOutcome({ attempted: true, delivered: true, verified: false, degraded: true, survivors: [], survivorIdentities: [] });
  }
}

export function formatCommandFailure(result) {
  const parts = [`${result.command} ${result.args.join(" ")}`.trim()];
  if (result.signal) {
    parts.push(`signal=${result.signal}`);
  } else {
    parts.push(`exit=${result.status}`);
  }
  const stderr = (result.stderr || "").trim();
  const stdout = (result.stdout || "").trim();
  if (stderr) {
    parts.push(stderr);
  } else if (stdout) {
    parts.push(stdout);
  }
  return parts.join(": ");
}
