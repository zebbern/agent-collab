#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import {
  acquireBrokerRegistryLock,
  assessBrokerOwners,
  loadBrokerChildren,
  loadBrokerRegistration,
  loadBrokerTerminal,
  publishBrokerReaperReceipt,
  publishBrokerTerminal,
  releaseBrokerChild,
  releaseBrokerRegistryLock,
  resolveBrokerOwnershipRoot
} from "./lib/broker-ownership.mjs";
import {
  getLiveProcessPids,
  terminateProcessGroup,
  terminateProcessTree
} from "./lib/process.mjs";

const APPLY_MODE = "apply-registered";
const REPORT_MODE = "report-only";

// Mirrors broker-ownership.mjs: POSIX mode bits are unrepresentable on Windows
// (modes read back 0o666), so exact-mode checks apply only off win32.
const ENFORCE_POSIX_MODES = process.platform !== "win32";

function listRegistrationCandidates(env) {
  const registryRoot = resolveBrokerOwnershipRoot(env);
  if (!registryRoot || !fs.existsSync(registryRoot)) {
    return [];
  }
  try {
    const rootStat = fs.lstatSync(registryRoot);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory() || (ENFORCE_POSIX_MODES && (rootStat.mode & 0o777) !== 0o700)) {
      return [{ valid: false, brokerKey: null, registryDir: registryRoot, reason: "registry-root-invalid" }];
    }
  } catch {
    return [{ valid: false, brokerKey: null, registryDir: registryRoot, reason: "registry-root-invalid" }];
  }
  const candidates = [];
  for (const entry of fs.readdirSync(registryRoot, { withFileTypes: true })) {
    if (!/^[a-f0-9]{64}$/.test(entry.name)) {
      continue;
    }
    const registryDir = path.join(registryRoot, entry.name);
    if (!entry.isDirectory()) {
      candidates.push({ valid: false, brokerKey: entry.name, registryDir, reason: "broker-directory-invalid" });
      continue;
    }
    const brokerPath = path.join(registryDir, "broker.json");
    try {
      const brokerStat = fs.lstatSync(brokerPath);
      if (brokerStat.isSymbolicLink() || !brokerStat.isFile() || (ENFORCE_POSIX_MODES && (brokerStat.mode & 0o777) !== 0o600)) {
        throw new Error("broker record is not a private regular file");
      }
      const broker = JSON.parse(fs.readFileSync(brokerPath, "utf8"));
      const registration = loadBrokerRegistration({
        endpoint: broker?.endpoint,
        brokerIdentity: broker?.pidIdentity,
        env
      });
      if (
        registration.registered !== true ||
        registration.brokerKey !== entry.name ||
        registration.registryDir !== registryDir
      ) {
        candidates.push({ valid: false, brokerKey: entry.name, registryDir, reason: "broker-record-invalid" });
      } else {
        const terminal = loadBrokerTerminal(registration);
        if (terminal.terminal === true) {
          continue;
        }
        if (terminal.reason !== "terminal-absent") {
          candidates.push({ valid: false, brokerKey: entry.name, registryDir, reason: terminal.reason });
        } else {
          candidates.push({ valid: true, registration });
        }
      }
    } catch {
      candidates.push({ valid: false, brokerKey: entry.name, registryDir, reason: "broker-record-invalid" });
    }
  }
  return candidates;
}

function targetRecords(registration, children) {
  const broker = registration.broker;
  const byIdentity = new Map([[broker.pidIdentity, { pid: broker.pid, identity: broker.pidIdentity }]]);
  for (const child of children) {
    for (const member of child.ownershipSnapshot.members) {
      byIdentity.set(member.identity, { pid: member.pid, identity: member.identity });
    }
  }
  return [...byIdentity.values()];
}

function brokerOwnershipSnapshot(broker) {
  const startedAt = broker.pidIdentity.slice(String(broker.pid).length + 1);
  return {
    rootPid: broker.pid,
    rootIdentity: broker.pidIdentity,
    processGroupId: broker.processGroupId,
    members: [
      {
        pid: broker.pid,
        parentPid: 1,
        processGroupId: broker.processGroupId,
        state: "registered",
        startedAt,
        identity: broker.pidIdentity,
        depth: 0
      }
    ]
  };
}

function refusal(candidate, reason, extra = {}) {
  return {
    status: "report-only",
    brokerKey: candidate.registration?.brokerKey ?? candidate.brokerKey ?? null,
    pid: candidate.registration?.broker?.pid ?? null,
    reason,
    ...extra
  };
}

async function processRegistration(candidate, options) {
  if (!candidate.valid) {
    return refusal(candidate, candidate.reason);
  }

  const registration = candidate.registration;
  const getLive = options.getLiveProcessPidsImpl ?? getLiveProcessPids;
  const assess = options.assessBrokerOwnersImpl ?? assessBrokerOwners;
  const initialAssessment = assess(registration, { getLiveProcessPidsImpl: getLive });
  if (initialAssessment.safeToShutdown !== true) {
    return refusal(candidate, initialAssessment.reason, { assessment: initialAssessment });
  }
  const initialChildren = loadBrokerChildren(registration);
  if (initialChildren.valid !== true) {
    return refusal(candidate, initialChildren.reason, { malformed: initialChildren.malformed });
  }
  if (options.mode !== APPLY_MODE) {
    return refusal(candidate, "eligible-but-apply-not-enabled", { assessment: initialAssessment });
  }

  const acquireLock = options.acquireBrokerRegistryLockImpl ?? acquireBrokerRegistryLock;
  const releaseLock = options.releaseBrokerRegistryLockImpl ?? releaseBrokerRegistryLock;
  const registryLock = acquireLock(registration);
  if (registryLock?.acquired !== true) {
    return refusal(candidate, registryLock?.reason ?? "registry-busy");
  }

  const outcomes = [];
  let decision = "cleanup-unverified";
  let residualIdentities = [];
  let result;
  try {
    const lockedRegistration = loadBrokerRegistration({
      endpoint: registration.broker.endpoint,
      brokerIdentity: registration.broker.pidIdentity,
      env: options.env ?? process.env
    });
    if (
      lockedRegistration.registered !== true ||
      lockedRegistration.brokerKey !== registration.brokerKey ||
      lockedRegistration.registryDir !== registration.registryDir
    ) {
      result = refusal(candidate, "locked-broker-record-invalid");
    } else {
      const finalAssessment = assess(lockedRegistration, { getLiveProcessPidsImpl: getLive });
      if (finalAssessment.safeToShutdown !== true) {
        result = refusal(candidate, `locked-${finalAssessment.reason}`, { assessment: finalAssessment });
      } else {
        const children = loadBrokerChildren(lockedRegistration);
        if (children.valid !== true) {
          result = refusal(candidate, children.reason, { malformed: children.malformed });
        } else {
          const terminateGroup = options.terminateProcessGroupImpl ?? terminateProcessGroup;
          const terminateTree = options.terminateProcessTreeImpl ?? terminateProcessTree;
          let cleanupVerified = true;
          for (const child of children.children) {
            const outcome = await terminateGroup(child.processGroupId, {
              ownershipSnapshot: child.ownershipSnapshot,
              termPollAttempts: options.termPollAttempts,
              killPollAttempts: options.killPollAttempts,
              pollIntervalMs: options.pollIntervalMs
            });
            if (outcome?.verified !== true) {
              outcomes.push({ target: "child", pid: child.pid, pidIdentity: child.pidIdentity, outcome });
              cleanupVerified = false;
              break;
            }
            let childRelease;
            try {
              childRelease = (options.releaseBrokerChildImpl ?? releaseBrokerChild)(lockedRegistration, {
                child,
                cleanupOutcome: outcome,
                now: options.now,
                registryLock
              });
            } catch (error) {
              childRelease = { released: false, reason: `child-release-error:${error.message}` };
            }
            outcomes.push({
              target: "child",
              pid: child.pid,
              pidIdentity: child.pidIdentity,
              outcome,
              childRelease: {
                released: childRelease?.released === true,
                reason: childRelease?.reason ?? null
              }
            });
            if (childRelease?.released !== true) {
              cleanupVerified = false;
              break;
            }
          }

          if (cleanupVerified) {
            const broker = lockedRegistration.broker;
            const outcome = await terminateTree(broker.pid, {
              expectedRootIdentity: broker.pidIdentity,
              ownershipSnapshot: brokerOwnershipSnapshot(broker),
              termPollAttempts: options.termPollAttempts,
              killPollAttempts: options.killPollAttempts,
              pollIntervalMs: options.pollIntervalMs
            });
            outcomes.push({ target: "broker", pid: broker.pid, pidIdentity: broker.pidIdentity, outcome });
            cleanupVerified = outcome?.verified === true;
          }

          const targets = targetRecords(lockedRegistration, children.children);
          const residualPids = getLive(
            targets.map((target) => target.pid),
            { identities: targets.map((target) => target.identity) }
          );
          const residualSet = new Set(residualPids);
          residualIdentities = targets
            .filter((target) => residualSet.has(target.pid))
            .map((target) => target.identity);
          if (cleanupVerified && residualIdentities.length === 0) {
            decision = "cleanup-verified";
          }

          const attemptId = (options.attemptIdFactory ?? (() => randomUUID()))();
          const receipt = (options.publishBrokerReaperReceiptImpl ?? publishBrokerReaperReceipt)(lockedRegistration, {
            attemptId,
            decision,
            outcomes,
            residualIdentities,
            createdAt: (options.now ?? (() => new Date().toISOString()))()
          });
          const terminal =
            decision === "cleanup-verified" && receipt?.published === true
              ? (options.publishBrokerTerminalImpl ?? publishBrokerTerminal)(lockedRegistration, {
                  attemptId,
                  receiptPath: receipt.path,
                  retiredAt: (options.now ?? (() => new Date().toISOString()))(),
                  registryLock
                })
              : null;
          const terminalRecorded = decision !== "cleanup-verified" || terminal?.terminal === true;
          result = {
            status: decision === "cleanup-verified" && receipt?.published === true && terminalRecorded ? "reaped" : "report-only",
            brokerKey: lockedRegistration.brokerKey,
            pid: lockedRegistration.broker.pid,
            reason:
              receipt?.published !== true
                ? `${decision}-receipt-unavailable`
                : terminalRecorded
                  ? decision
                  : `${decision}-${terminal?.reason ?? "terminal-unavailable"}`,
            outcomes,
            residualIdentities,
            receiptPath: receipt?.published === true ? receipt.path : null,
            terminalPath: terminal?.terminal === true ? terminal.path : null
          };
        }
      }
    }
  } finally {
    const released = releaseLock(registration, registryLock);
    if (released?.released !== true) {
      if (result) {
        result.status = "report-only";
        result.reason = `registry-lock-release-${released?.reason ?? "failed"}`;
      } else {
        result = refusal(candidate, `registry-lock-release-${released?.reason ?? "failed"}`);
      }
    }
  }
  return result;
}

export async function runRegisteredBrokerReaper(options = {}) {
  const mode = options.mode === APPLY_MODE ? APPLY_MODE : REPORT_MODE;
  const candidates = listRegistrationCandidates(options.env ?? process.env);
  const results = [];
  for (const candidate of candidates) {
    results.push(await processRegistration(candidate, { ...options, mode }));
  }
  return {
    mode,
    scanned: candidates.length,
    reaped: results.filter((result) => result.status === "reaped").length,
    reported: results.filter((result) => result.status !== "reaped").length,
    results
  };
}

async function main() {
  const mode = process.argv.slice(2).includes("--apply-registered") ? APPLY_MODE : REPORT_MODE;
  const summary = await runRegisteredBrokerReaper({ mode });
  for (const result of summary.results) {
    process.stdout.write(
      `${result.status.toUpperCase()} broker_key=${result.brokerKey ?? "unknown"} pid=${result.pid ?? "unknown"} reason=${result.reason}\n`
    );
  }
  process.stdout.write(
    `scanned=${summary.scanned} reaped=${summary.reaped} reported=${summary.reported} mode=${summary.mode}\n`
  );
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
