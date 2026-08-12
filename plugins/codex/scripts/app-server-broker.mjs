#!/usr/bin/env node

import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { parseArgs } from "./lib/args.mjs";
import { BROKER_BUSY_RPC_CODE, BROKER_OWNERSHIP_RPC_CODE, BROKER_STREAM_COMPLETED_METHOD, CodexAppServerClient } from "./lib/app-server.mjs";
import {
  loadBrokerRegistration,
  publishBrokerChild,
  publishBrokerChildObservation,
  releaseBrokerChild
} from "./lib/broker-ownership.mjs";
import { parseBrokerEndpoint } from "./lib/broker-endpoint.mjs";
import { getLiveProcessPids, getProcessIdentity } from "./lib/process.mjs";

const DEFAULT_CHILD_IDLE_MS = 5 * 60 * 1000;
const STREAMING_METHODS = new Set(["turn/start", "review/start", "thread/compact/start"]);
const TEST_BROKER_TTL_ENV = "CODEX_COMPANION_TEST_BROKER_TTL_MS";
const BROKER_CLEANUP_UNVERIFIED_RPC_CODE = -32002;
const BROKER_SHUTDOWN_RPC_CODE = -32003;
const BROKER_NOT_ACTIVATED_RPC_CODE = -32004;
const BROKER_ACTIVATION_ACK = "activated";
const CHILD_OBSERVATION_RETRY_DELAYS_MS = [10, 25, 50, 100];

/** @typedef {Error & { rpcCode?: number, requiresChildTeardown?: boolean }} BrokerRequestError */
/** @typedef {import("./lib/app-server.mjs").SpawnedCodexAppServerClient} SpawnedCodexAppServerClient */

export function isBrokerRequestAllowedDuringShutdown(shuttingDown, message) {
  return !shuttingDown || message?.method === "broker/shutdown";
}

function resolveChildIdleMs(env = process.env) {
  const raw = env.CODEX_COMPANION_BROKER_CHILD_IDLE_MS;
  if (raw == null || raw === "") {
    return DEFAULT_CHILD_IDLE_MS;
  }
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_CHILD_IDLE_MS;
}

function buildStreamThreadIds(method, params, result) {
  const threadIds = new Set();
  if (params?.threadId) {
    threadIds.add(params.threadId);
  }
  if (method === "review/start" && result?.reviewThreadId) {
    threadIds.add(result.reviewThreadId);
  }
  return threadIds;
}

function buildJsonRpcError(code, message, data) {
  return data === undefined ? { code, message } : { code, message, data };
}

function send(socket, message) {
  if (socket.destroyed) {
    return;
  }
  socket.write(`${JSON.stringify(message)}\n`);
}

function flushSocket(socket) {
  if (socket.destroyed) {
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    socket.write("", () => resolve(true));
  });
}

function isInterruptRequest(message) {
  return message?.method === "turn/interrupt";
}

function isRegistryContention(reason) {
  return reason === "registry-busy" || reason === "registry-lock-contention";
}

async function publishChildObservationWithRetry(registration, options) {
  let observation = publishBrokerChildObservation(registration, options);
  for (const delayMs of CHILD_OBSERVATION_RETRY_DELAYS_MS) {
    if (observation.observed === true || !isRegistryContention(observation.reason)) {
      return observation;
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    observation = publishBrokerChildObservation(registration, options);
  }
  return observation;
}

function writePidFile(pidFile) {
  if (!pidFile) {
    return;
  }
  fs.mkdirSync(path.dirname(pidFile), { recursive: true });
  fs.writeFileSync(pidFile, `${process.pid}\n`, "utf8");
}

function resolveTestBrokerTtlMs() {
  const raw = process.env[TEST_BROKER_TTL_ENV];
  if (raw == null || raw === "") {
    return null;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 100 || value > 10 * 60 * 1000) {
    throw new Error(`${TEST_BROKER_TTL_ENV} must be an integer from 100 to 600000 milliseconds.`);
  }
  return value;
}

async function main() {
  const [subcommand, ...argv] = process.argv.slice(2);
  if (subcommand !== "serve") {
    throw new Error("Usage: node scripts/app-server-broker.mjs serve --endpoint <value> [--cwd <path>] [--pid-file <path>]");
  }

  const { options } = parseArgs(argv, {
    valueOptions: ["cwd", "pid-file", "endpoint"],
    booleanOptions: ["require-activation-stdin"]
  });

  if (!options.endpoint) {
    throw new Error("Missing required --endpoint.");
  }

  const cwd = options.cwd ? path.resolve(process.cwd(), options.cwd) : process.cwd();
  const endpoint = String(options.endpoint);
  const listenTarget = parseBrokerEndpoint(endpoint);
  const pidFile = options["pid-file"] ? path.resolve(options["pid-file"]) : null;
  const activationRequired = options["require-activation-stdin"] === true;
  const testBrokerTtlMs = resolveTestBrokerTtlMs();
  writePidFile(pidFile);

  const childIdleMs = resolveChildIdleMs();
  let appClient = null;
  let appClientRegistryChild = null;
  let appClientStartPromise = null;
  let appClientClosePromise = null;
  let childIdleTimer = null;
  let inFlightRequests = 0;
  let shutdownPromise = null;
  let shuttingDown = false;
  let activated = !activationRequired;
  let activationAbortStarted = false;
  let activeRequestSocket = null;
  let activeStreamSocket = null;
  let activeStreamThreadIds = null;
  let activeStreamRunning = false;
  // Identifies the turn that owns the current stream. The owning socket may
  // disconnect while the turn keeps running, so socket identity cannot be used
  // to decide whether a late result still belongs to the active stream.
  let activeStreamTurn = 0;
  let streamTurnCounter = 0;
  let blockedCleanup = null;
  let brokerRegistration = null;
  let testBrokerTtlTimer = null;
  const sockets = new Set();

  function getBrokerRegistration() {
    try {
      const brokerIdentity = getProcessIdentity(process.pid);
      if (brokerIdentity) {
        const candidate = loadBrokerRegistration({ endpoint, brokerIdentity });
        if (candidate.registered === true) {
          brokerRegistration = candidate;
          return brokerRegistration;
        }
      }
    } catch {
      // Missing registry evidence keeps the child outside automated cleanup.
    }
    brokerRegistration = null;
    return null;
  }

  function cancelChildIdleClose() {
    if (childIdleTimer) {
      clearTimeout(childIdleTimer);
      childIdleTimer = null;
    }
  }

  function hasActiveWork() {
    return (
      sockets.size > 0 ||
      inFlightRequests > 0 ||
      activeRequestSocket !== null ||
      activeStreamRunning
    );
  }

  function clearStreamState() {
    activeStreamRunning = false;
    activeStreamSocket = null;
    activeStreamThreadIds = null;
    activeStreamTurn = 0;
  }

  function recordUnverifiedCleanup(client) {
    const outcome = client.cleanupOutcome;
    if (!outcome || outcome.verified !== false) {
      return;
    }
    const survivors = outcome.survivors ?? [];
    blockedCleanup = {
      degraded: Boolean(outcome.degraded) || survivors.length === 0,
      survivors,
      survivorIdentities: outcome.survivorIdentities ?? []
    };
    process.stderr.write(
      `Warning: shared Codex broker will not spawn a replacement after unverified cleanup; surviving PIDs: ${survivors.join(", ") || "none known"}.\n`
    );
  }

  function recordVerifiedChildRelease(client, child) {
    const registration = getBrokerRegistration();
    if (registration?.registered !== true || !child || client.cleanupOutcome?.verified !== true) {
      return;
    }
    try {
      const released = releaseBrokerChild(registration, {
        child,
        cleanupOutcome: client.cleanupOutcome
      });
      if (released.released !== true) {
        process.stderr.write(`Warning: unable to release shared Codex app-server ownership (${released.reason ?? "unknown"}).\n`);
      }
    } catch (error) {
      process.stderr.write(`Warning: unable to release shared Codex app-server ownership: ${error.message}.\n`);
    }
  }

  async function closeAppClient() {
    cancelChildIdleClose();
    clearStreamState();
    if (appClientStartPromise) {
      await appClientStartPromise.catch(() => {});
    }
    if (appClientClosePromise) {
      await appClientClosePromise;
      return;
    }
    const client = appClient;
    const registryChild = appClientRegistryChild;
    appClient = null;
    appClientRegistryChild = null;
    if (!client) {
      return;
    }
    appClientClosePromise = client
      .close()
      .then(() => {
        recordUnverifiedCleanup(client);
        recordVerifiedChildRelease(client, registryChild);
      })
      .catch((error) => {
        blockedCleanup = { degraded: true, survivors: [] };
        process.stderr.write(`Warning: shared Codex broker cleanup failed: ${error.message}. No replacement child will be spawned.\n`);
      })
      .finally(() => {
        appClientClosePromise = null;
      });
    await appClientClosePromise;
  }

  async function prepareRequestErrorForReply(error) {
    if (error?.requiresChildTeardown !== true) {
      return error;
    }
    await closeAppClient();
    if (!blockedCleanup) {
      return error;
    }
    /** @type {BrokerRequestError} */
    const cleanupError = new Error("Shared Codex app-server cleanup is unverified after ownership publication failed.");
    cleanupError.rpcCode = BROKER_CLEANUP_UNVERIFIED_RPC_CODE;
    return cleanupError;
  }

  function scheduleChildIdleClose() {
    cancelChildIdleClose();
    if (!appClient || hasActiveWork()) {
      return;
    }
    childIdleTimer = setTimeout(() => {
      childIdleTimer = null;
      if (hasActiveWork()) {
        return;
      }
      void closeAppClient();
    }, childIdleMs);
    childIdleTimer.unref?.();
  }

  function clearSocketOwnership(socket) {
    if (activeRequestSocket === socket) {
      activeRequestSocket = null;
    }
    if (activeStreamSocket === socket) {
      // Detach only the notification socket. The turn may still be running in
      // the app-server; stream state is cleared on turn/completed, on a
      // streaming request error, on child exit, or when the child is released.
      activeStreamSocket = null;
    }
  }

  function routeNotification(message) {
    const target = activeRequestSocket ?? activeStreamSocket;
    if (target) {
      send(target, message);
    }
    if (message.method === "turn/completed" && activeStreamRunning) {
      const threadId = message.params?.threadId ?? null;
      if (!threadId || !activeStreamThreadIds || activeStreamThreadIds.has(threadId)) {
        const streamSocket = activeStreamSocket;
        activeStreamRunning = false;
        activeStreamSocket = null;
        activeStreamThreadIds = null;
        if (activeRequestSocket === streamSocket) {
          activeRequestSocket = null;
        }
        scheduleChildIdleClose();
      }
    }
  }

  function ensureCleanupSafeToSpawn() {
    if (blockedCleanup) {
      if (blockedCleanup.survivors.length > 0) {
        const liveSurvivors = getLiveProcessPids(blockedCleanup.survivors, {
          identities: blockedCleanup.survivorIdentities
        });
        if (liveSurvivors.length > 0) {
          /** @type {BrokerRequestError} */
          const error = new Error(`Shared Codex broker cleanup is unverified; surviving PIDs: ${liveSurvivors.join(", ")}.`);
          error.rpcCode = BROKER_CLEANUP_UNVERIFIED_RPC_CODE;
          throw error;
        }
        blockedCleanup = null;
      } else if (blockedCleanup.degraded) {
        /** @type {BrokerRequestError} */
        const error = new Error("Shared Codex broker cleanup is unverified; refusing to spawn a replacement child.");
        error.rpcCode = BROKER_CLEANUP_UNVERIFIED_RPC_CODE;
        throw error;
      } else {
        blockedCleanup = null;
      }
    }
  }

  async function getAppClient() {
    if (shuttingDown) {
      /** @type {BrokerRequestError} */
      const error = new Error("Shared Codex broker is shutting down.");
      error.rpcCode = BROKER_SHUTDOWN_RPC_CODE;
      throw error;
    }
    cancelChildIdleClose();
    ensureCleanupSafeToSpawn();
    if (appClient) {
      return appClient;
    }
    if (appClientClosePromise) {
      await appClientClosePromise;
      if (shuttingDown) {
        /** @type {BrokerRequestError} */
        const error = new Error("Shared Codex broker is shutting down.");
        error.rpcCode = BROKER_SHUTDOWN_RPC_CODE;
        throw error;
      }
      ensureCleanupSafeToSpawn();
    }
    if (!appClientStartPromise) {
      let childRegistration = null;
      let registration = null;
      appClientStartPromise = CodexAppServerClient.connect(cwd, {
        disableBroker: true,
        gatedBrokerChild: true,
        async beforeAppServerActivation(ownershipSnapshot) {
          registration = getBrokerRegistration();
          if (registration?.registered !== true) {
            /** @type {BrokerRequestError} */
            const error = new Error("Shared Codex broker ownership registration is unavailable.");
            error.rpcCode = BROKER_OWNERSHIP_RPC_CODE;
            throw error;
          }
          childRegistration = publishBrokerChild(registration, { ownershipSnapshot });
          if (childRegistration.registered !== true) {
            /** @type {BrokerRequestError} */
            const error = new Error(`Unable to register shared Codex app-server ownership (${childRegistration.reason ?? "unknown"}).`);
            error.rpcCode = BROKER_OWNERSHIP_RPC_CODE;
            throw error;
          }
        },
        async afterAppServerOwnershipRefresh(ownershipSnapshot) {
          if (registration?.registered !== true || childRegistration?.registered !== true) {
            /** @type {BrokerRequestError} */
            const error = new Error("Shared Codex app-server ownership registration was lost before helper observation.");
            error.rpcCode = BROKER_OWNERSHIP_RPC_CODE;
            throw error;
          }
          const observation = await publishChildObservationWithRetry(registration, {
            child: childRegistration.child,
            ownershipSnapshot
          });
          if (observation.observed !== true) {
            /** @type {BrokerRequestError} */
            const error = new Error(`Unable to publish shared Codex app-server helper ownership (${observation.reason ?? "unknown"}).`);
            error.rpcCode = BROKER_OWNERSHIP_RPC_CODE;
            error.requiresChildTeardown = true;
            throw error;
          }
          childRegistration = {
            ...childRegistration,
            child: observation.child
          };
        }
      })
        .then(async (client) => {
          if (registration?.registered !== true || childRegistration?.registered !== true) {
            await client.close().catch(() => {});
            /** @type {BrokerRequestError} */
            const error = new Error("Shared Codex app-server activation lost its durable ownership registration.");
            error.rpcCode = BROKER_OWNERSHIP_RPC_CODE;
            throw error;
          }
          let registryChild = null;
          appClient = client;
          registryChild = childRegistration.child;
          appClientRegistryChild = registryChild;
          client.setNotificationHandler(routeNotification);
          const childPid = /** @type {SpawnedCodexAppServerClient} */ (client).proc?.pid ?? null;
          client.setExitHandler(() => {
            clearStreamState();
            if (appClient === client) {
              appClient = null;
              appClientRegistryChild = null;
            }
            if (!client.closed && childPid != null && process.platform !== "win32") {
              // The child is a detached process-group leader; on an unexpected
              // exit its surviving helpers reparent away from the broker, so
              // wait for the client's shared direct/broker crash cleanup before
              // allowing a replacement to spawn.
              appClientClosePromise = /** @type {SpawnedCodexAppServerClient} */ (client)
                .waitForUnexpectedExitCleanup()
                ?.then(() => {
                  recordUnverifiedCleanup(client);
                  recordVerifiedChildRelease(client, registryChild);
                })
                .catch((error) => {
                  blockedCleanup = { degraded: true, survivors: [] };
                  process.stderr.write(`Warning: shared Codex broker could not reclaim exited app-server group: ${error.message}. No replacement child will be spawned.\n`);
                })
                .finally(() => {
                  appClientClosePromise = null;
                }) ?? null;
            }
            scheduleChildIdleClose();
          });
          return client;
        })
        .catch((error) => {
          if (error.cleanupOutcome) {
            recordUnverifiedCleanup({ cleanupOutcome: error.cleanupOutcome });
          }
          throw error;
        })
        .finally(() => {
          appClientStartPromise = null;
        });
    }
    return appClientStartPromise;
  }

  async function shutdown(server) {
    if (shutdownPromise) {
      return shutdownPromise;
    }
    shuttingDown = true;
    const serverClosePromise = new Promise((resolve) => {
      server.close(resolve);
    });
    shutdownPromise = (async () => {
      if (testBrokerTtlTimer) {
        clearTimeout(testBrokerTtlTimer);
        testBrokerTtlTimer = null;
      }
      cancelChildIdleClose();
      for (const socket of sockets) {
        socket.destroy();
      }
      await closeAppClient();
      await serverClosePromise;
      if (listenTarget.kind === "unix" && fs.existsSync(listenTarget.path)) {
        fs.unlinkSync(listenTarget.path);
      }
      if (pidFile && fs.existsSync(pidFile)) {
        fs.unlinkSync(pidFile);
      }
    })();
    return shutdownPromise;
  }

  function setupActivationGate(server) {
    let buffer = "";
    const abort = () => {
      if (activated || activationAbortStarted) {
        return;
      }
      activationAbortStarted = true;
      void shutdown(server)
        .catch(() => {})
        .finally(() => process.exit(1));
    };

    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      if (activated || activationAbortStarted) {
        return;
      }
      buffer += chunk;
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex === -1) {
        return;
      }
      const command = buffer.slice(0, newlineIndex).trim();
      if (command !== "activate") {
        abort();
        return;
      }
      activated = true;
      try {
        fs.writeSync(3, `${BROKER_ACTIVATION_ACK}\n`);
        fs.closeSync(3);
      } catch {
        activated = false;
        abort();
      }
    });
    process.stdin.on("end", abort);
    process.stdin.on("error", abort);
    process.stdin.resume();
    if (process.stdin.readableEnded) {
      abort();
    }
  }

  const server = net.createServer((socket) => {
    if (shuttingDown) {
      socket.destroy();
      return;
    }
    cancelChildIdleClose();
    sockets.add(socket);
    socket.setEncoding("utf8");
    let buffer = "";

    socket.on("data", async (chunk) => {
      if (shuttingDown) {
        socket.destroy();
        return;
      }
      buffer += chunk;
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        newlineIndex = buffer.indexOf("\n");

        if (!line.trim()) {
          continue;
        }

        let message;
        try {
          message = JSON.parse(line);
        } catch (error) {
          send(socket, {
            id: null,
            error: buildJsonRpcError(-32700, `Invalid JSON: ${error.message}`)
          });
          continue;
        }

        if (activationRequired && !activated && message.method !== "broker/shutdown") {
          if (message.id !== undefined) {
            send(socket, {
              id: message.id,
              error: buildJsonRpcError(BROKER_NOT_ACTIVATED_RPC_CODE, "Shared Codex broker is not activated.")
            });
          }
          socket.end();
          continue;
        }

        if (message.id !== undefined && message.method === "initialize") {
          send(socket, {
            id: message.id,
            result: {
              userAgent: "codex-companion-broker"
            }
          });
          continue;
        }

        if (message.method === "initialized" && message.id === undefined) {
          continue;
        }

        if (message.method === BROKER_STREAM_COMPLETED_METHOD && message.id === undefined) {
          const threadId = message.params?.threadId ?? null;
          if (
            activeStreamRunning &&
            activeStreamSocket === socket &&
            (!threadId || !activeStreamThreadIds || activeStreamThreadIds.has(threadId))
          ) {
            clearStreamState();
            scheduleChildIdleClose();
          }
          continue;
        }

        if (message.id !== undefined && message.method === "broker/shutdown") {
          shuttingDown = true;
          send(socket, { id: message.id, result: {} });
          await flushSocket(socket);
          await shutdown(server);
          process.exit(0);
        }

        if (!isBrokerRequestAllowedDuringShutdown(shuttingDown, message)) {
          if (message.id !== undefined) {
            send(socket, {
              id: message.id,
              error: buildJsonRpcError(BROKER_SHUTDOWN_RPC_CODE, "Shared Codex broker is shutting down.")
            });
          }
          socket.destroy();
          continue;
        }

        if (message.id === undefined) {
          continue;
        }

        const allowInterruptDuringActiveStream =
          isInterruptRequest(message) && activeStreamRunning && activeStreamSocket !== socket && !activeRequestSocket;

        if (
          ((activeRequestSocket && activeRequestSocket !== socket) ||
            (activeStreamRunning && activeStreamSocket !== socket)) &&
          !allowInterruptDuringActiveStream
        ) {
          send(socket, {
            id: message.id,
            error: buildJsonRpcError(BROKER_BUSY_RPC_CODE, "Shared Codex broker is busy.")
          });
          continue;
        }

        if (allowInterruptDuringActiveStream) {
          inFlightRequests += 1;
          try {
            const client = await getAppClient();
            const result = await client.request(message.method, message.params ?? {});
            send(socket, { id: message.id, result });
          } catch (error) {
            const replyError = await prepareRequestErrorForReply(error);
            send(socket, {
              id: message.id,
              error: buildJsonRpcError(replyError.rpcCode ?? -32000, replyError.message)
            });
          } finally {
            inFlightRequests -= 1;
            scheduleChildIdleClose();
          }
          continue;
        }

        const isStreaming = STREAMING_METHODS.has(message.method);
        activeRequestSocket = socket;
        let streamTurn = 0;
        if (isStreaming) {
          activeStreamRunning = true;
          activeStreamSocket = socket;
          activeStreamThreadIds = buildStreamThreadIds(message.method, message.params ?? {}, null);
          streamTurn = ++streamTurnCounter;
          activeStreamTurn = streamTurn;
        }
        inFlightRequests += 1;

        try {
          const client = await getAppClient();
          const result = await client.request(message.method, message.params ?? {});
          send(socket, { id: message.id, result });
          // Gate on the turn, not the socket: a client that disconnects mid-turn
          // clears activeStreamSocket while the turn keeps running, and without
          // the result-derived thread ids the completion notification can never
          // match, leaving the broker busy forever.
          if (isStreaming && activeStreamRunning && activeStreamTurn === streamTurn) {
            activeStreamThreadIds = buildStreamThreadIds(message.method, message.params ?? {}, result);
          }
          if (activeRequestSocket === socket) {
            activeRequestSocket = null;
          }
        } catch (error) {
          const replyError = await prepareRequestErrorForReply(error);
          send(socket, {
            id: message.id,
            error: buildJsonRpcError(replyError.rpcCode ?? -32000, replyError.message)
          });
          if (activeRequestSocket === socket) {
            activeRequestSocket = null;
          }
          if (isStreaming) {
            clearStreamState();
          }
        } finally {
          inFlightRequests -= 1;
          scheduleChildIdleClose();
        }
      }
    });

    socket.on("close", () => {
      sockets.delete(socket);
      clearSocketOwnership(socket);
      scheduleChildIdleClose();
    });

    socket.on("error", () => {
      sockets.delete(socket);
      clearSocketOwnership(socket);
      scheduleChildIdleClose();
    });
  });

  process.on("SIGTERM", async () => {
    await shutdown(server);
    process.exit(0);
  });

  process.on("SIGINT", async () => {
    await shutdown(server);
    process.exit(0);
  });

  server.listen(listenTarget.path, () => {
    if (activationRequired) {
      setupActivationGate(server);
    }
    if (testBrokerTtlMs != null) {
      // Test suites intentionally exercise real detached broker behavior. A
      // bounded test-only lifetime prevents an interrupted runner from leaving
      // its fixture broker behind after normal teardown becomes impossible.
      testBrokerTtlTimer = setTimeout(() => {
        testBrokerTtlTimer = null;
        void shutdown(server)
          .catch(() => {})
          .finally(() => process.exit(0));
      }, testBrokerTtlMs);
      testBrokerTtlTimer.unref?.();
    }
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
