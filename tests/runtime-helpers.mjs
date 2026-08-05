// Shared fixtures and helpers for the runtime suite. The former monolithic
// tests/runtime.test.mjs is split into runtime-core.test.mjs,
// runtime-task.test.mjs, and runtime-broker.test.mjs so node's per-file test
// parallelism spreads the suite across three files with similar wall time.
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { installFakeCodex } from "./fake-codex-fixture.mjs";
import { makeTempDir as createTempDir } from "./helpers.mjs";
import { SESSION_OWNER_IDENTITY_ENV, SESSION_OWNER_PID_ENV } from "../plugins/codex/scripts/lib/broker-ownership.mjs";
import { clearBrokerSession, loadBrokerSession, sendBrokerShutdown, teardownBrokerSession } from "../plugins/codex/scripts/lib/broker-lifecycle.mjs";
import { getProcessIdentity, terminateProcessTree } from "../plugins/codex/scripts/lib/process.mjs";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const PLUGIN_ROOT = path.join(ROOT, "plugins", "codex");
export const SCRIPT = path.join(PLUGIN_ROOT, "scripts", "codex-companion.mjs");
export const STOP_HOOK = path.join(PLUGIN_ROOT, "scripts", "stop-review-gate-hook.mjs");
export const SESSION_HOOK = path.join(PLUGIN_ROOT, "scripts", "session-lifecycle-hook.mjs");
export const BROKER_SCRIPT = path.join(PLUGIN_ROOT, "scripts", "app-server-broker.mjs");
export const DETACHED_FIXTURE_TTL_MS = 5 * 60 * 1000;
export const SELF_EXPIRING_KEEPALIVE = selfExpiringKeepaliveCode();
const runtimeTempDirs = new Set();
export const runtimePluginDataDir = createTempDir("codex-plugin-runtime-state-");
process.env.CLAUDE_PLUGIN_DATA = runtimePluginDataDir;
let brokerOwnerSequence = 0;

export function makeTempDir(prefix) {
  const tempDir = createTempDir(prefix);
  runtimeTempDirs.add(tempDir);
  return tempDir;
}

export function withBrokerOwner(env, label) {
  brokerOwnerSequence += 1;
  return {
    ...env,
    CODEX_COMPANION_SESSION_ID: `runtime-${label}-${brokerOwnerSequence}`,
    [SESSION_OWNER_PID_ENV]: String(process.pid),
    [SESSION_OWNER_IDENTITY_ENV]: getProcessIdentity(process.pid)
  };
}

export function selfExpiringKeepaliveCode(ttlMs = DETACHED_FIXTURE_TTL_MS) {
  return `setTimeout(() => process.exit(0), ${ttlMs}); setInterval(() => {}, 1000)`;
}

// Body of the former monolithic file's test.after hook; each split file
// registers it via test.after and asserts the returned failure list is empty.
export async function cleanupRuntimeBrokerSessions() {
  const cleanupFailures = [];

  for (const cwd of [ROOT, ...runtimeTempDirs]) {
    const brokerSession = loadBrokerSession(cwd);
    if (!brokerSession) {
      continue;
    }

    await sendBrokerShutdown(brokerSession.endpoint).catch(() => {});
    const cleanup = await teardownBrokerSession({
      endpoint: brokerSession.endpoint,
      pidFile: brokerSession.pidFile,
      logFile: brokerSession.logFile,
      sessionDir: brokerSession.sessionDir,
      pid: brokerSession.pid,
      pidIdentity: brokerSession.pidIdentity,
      ownershipSnapshot: brokerSession.ownershipSnapshot,
      requireVerifiedOwnership: brokerSession.ownershipCaptureFailed === true,
      killProcess: terminateProcessTree
    });
    if (cleanup?.verified === true) {
      clearBrokerSession(cwd);
    }
    if (cleanup?.verified !== true || loadBrokerSession(cwd)) {
      cleanupFailures.push({ cwd, cleanup });
    }
  }

  return cleanupFailures;
}

export async function waitFor(predicate, { timeoutMs = 5000, intervalMs = 50 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = await predicate();
    if (value) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("Timed out waiting for condition.");
}

export function installSlowRejectFakeCodex(binDir) {
  installFakeCodex(binDir, "slow-reject");
  const scriptPath = path.join(binDir, "codex");
  const marker = "const turnId = nextTurnId(state);";
  const source = fs.readFileSync(scriptPath, "utf8");
  // The marker also appears in the review/start handler; anchor the patch to
  // the turn/start case so the injection lands in the right handler.
  const caseStart = source.indexOf('case "turn/start"');
  assert.ok(caseStart !== -1);
  const markerAt = source.indexOf(marker, caseStart);
  assert.ok(markerAt !== -1);
  fs.writeFileSync(
    scriptPath,
    source.slice(0, markerAt) +
      source.slice(markerAt).replace(
        marker,
      `if (BEHAVIOR === "slow-reject") {
          state.turnRejectPending = true;
          saveState(state);
          setTimeout(() => {
            const current = loadState();
            send({ id: message.id, error: { code: -32000, message: "slow fake turn rejected" } });
            current.turnRejectPending = false;
            current.turnRejectSent = true;
            saveState(current);
          }, 400);
          break;
        }

        ${marker}`
      ),
    "utf8"
  );
}

export function installInitializeErrorFakeCodex(binDir) {
  installFakeCodex(binDir, "initialize-rpc-error");
  const scriptPath = path.join(binDir, "codex");
  let source = fs.readFileSync(scriptPath, "utf8");
  const startsMarker = "bootState.appServerStarts = (bootState.appServerStarts || 0) + 1;";
  assert.ok(source.includes(startsMarker));
  source = source.replace(
    startsMarker,
    `${startsMarker}
bootState.appServerPids = [...(bootState.appServerPids || []), process.pid];`
  );
  const initializeMarker = `      case "initialize":
        state.capabilities = message.params.capabilities || null;`;
  assert.ok(source.includes(initializeMarker));
  source = source.replace(
    initializeMarker,
    `      case "initialize":
        if (BEHAVIOR === "initialize-rpc-error") {
          send({ id: message.id, error: { code: -32010, message: "initialize failed" } });
          break;
        }
        state.capabilities = message.params.capabilities || null;`
  );
  fs.writeFileSync(scriptPath, source, "utf8");
}

export function instrumentSlowFakeTurnState(binDir) {
  const scriptPath = path.join(binDir, "codex");
  const source = fs.readFileSync(scriptPath, "utf8");
  const delayedTurn = "emitTurnCompletedLater(thread.id, turnId, items, 400);";
  assert.ok(source.includes(delayedTurn));
  fs.writeFileSync(
    scriptPath,
    source.replace(
      delayedTurn,
      `state.turnInFlight = true;
          saveState(state);
          ${delayedTurn}`
    ).replace(
      "emitTurnCompleted(threadId, turnId, item);",
      `emitTurnCompleted(threadId, turnId, item);
    const currentState = loadState();
    currentState.turnInFlight = false;
    saveState(currentState);`
    ),
    "utf8"
  );
}
