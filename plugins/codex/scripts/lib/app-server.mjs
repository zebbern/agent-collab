/**
 * @typedef {Error & { data?: unknown, rpcCode?: number }} ProtocolError
 * @typedef {import("./app-server-protocol").AppServerMethod} AppServerMethod
 * @typedef {import("./app-server-protocol").AppServerNotification} AppServerNotification
 * @typedef {import("./app-server-protocol").AppServerNotificationHandler} AppServerNotificationHandler
 * @typedef {import("./app-server-protocol").ClientInfo} ClientInfo
 * @typedef {import("./app-server-protocol").CodexAppServerClientOptions} CodexAppServerClientOptions
 * @typedef {import("./app-server-protocol").InitializeCapabilities} InitializeCapabilities
 */
import fs from "node:fs";
import net from "node:net";
import process from "node:process";
import { spawn } from "node:child_process";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { parseBrokerEndpoint } from "./broker-endpoint.mjs";
import { ensureBrokerSession, loadReusableBrokerSession } from "./broker-lifecycle.mjs";
import { captureProcessOwnership, normalizeProcessCleanupOutcome, terminateProcessGroup, terminateProcessTree } from "./process.mjs";

const PLUGIN_MANIFEST_URL = new URL("../../.claude-plugin/plugin.json", import.meta.url);
const PLUGIN_MANIFEST = JSON.parse(fs.readFileSync(PLUGIN_MANIFEST_URL, "utf8"));
const DEFAULT_CLOSE_WAIT_MS = 2000;
const GATED_APP_SERVER_CHILD = fileURLToPath(new URL("../app-server-child.mjs", import.meta.url));

export const BROKER_ENDPOINT_ENV = "CODEX_COMPANION_APP_SERVER_ENDPOINT";
export const BROKER_BUSY_RPC_CODE = -32001;
export const BROKER_OWNERSHIP_RPC_CODE = -32005;
export const BROKER_STREAM_COMPLETED_METHOD = "broker/stream-completed";

/** @type {ClientInfo} */
const DEFAULT_CLIENT_INFO = {
  title: "Codex Plugin",
  name: "Claude Code",
  version: PLUGIN_MANIFEST.version ?? "0.0.0"
};

/** @type {InitializeCapabilities} */
const DEFAULT_CAPABILITIES = {
  experimentalApi: false,
  requestAttestation: false,
  optOutNotificationMethods: [
    "item/agentMessage/delta",
    "item/reasoning/summaryTextDelta",
    "item/reasoning/summaryPartAdded",
    "item/reasoning/textDelta"
  ]
};

function buildJsonRpcError(code, message, data) {
  return data === undefined ? { code, message } : { code, message, data };
}

function createProtocolError(message, data) {
  const error = /** @type {ProtocolError} */ (new Error(message));
  error.data = data;
  if (data?.code !== undefined) {
    error.rpcCode = data.code;
  }
  return error;
}

class AppServerClientBase {
  constructor(cwd, options = {}) {
    this.cwd = cwd;
    this.options = options;
    this.pending = new Map();
    this.nextId = 1;
    this.stderr = "";
    this.closed = false;
    this.exitError = null;
    this.exitHandler = null;
    /** @type {AppServerNotificationHandler | null} */
    this.notificationHandler = null;
    this.lineBuffer = "";
    this.transport = "unknown";

    this.exitPromise = new Promise((resolve) => {
      this.resolveExit = resolve;
    });
  }

  setNotificationHandler(handler) {
    this.notificationHandler = handler;
  }

  setExitHandler(handler) {
    this.exitHandler = handler;
  }

  /**
   * @template {AppServerMethod} M
   * @param {M} method
   * @param {import("./app-server-protocol").AppServerRequestParams<M>} params
   * @returns {Promise<import("./app-server-protocol").AppServerResponse<M>>}
   */
  request(method, params) {
    if (this.closed) {
      throw new Error("codex app-server client is closed.");
    }

    const id = this.nextId;
    this.nextId += 1;

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.sendMessage({ id, method, params });
    });
  }

  notify(method, params = {}) {
    if (this.closed) {
      return;
    }
    this.sendMessage({ method, params });
  }

  handleChunk(chunk) {
    this.lineBuffer += chunk;
    let newlineIndex = this.lineBuffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = this.lineBuffer.slice(0, newlineIndex);
      this.lineBuffer = this.lineBuffer.slice(newlineIndex + 1);
      this.handleLine(line);
      newlineIndex = this.lineBuffer.indexOf("\n");
    }
  }

  handleLine(line) {
    if (!line.trim()) {
      return;
    }

    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      this.handleExit(createProtocolError(`Failed to parse codex app-server JSONL: ${error.message}`, { line }));
      return;
    }

    if (message.id !== undefined && message.method) {
      this.handleServerRequest(message);
      return;
    }

    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }
      this.pending.delete(message.id);

      if (message.error) {
        pending.reject(createProtocolError(message.error.message ?? `codex app-server ${pending.method} failed.`, message.error));
      } else {
        pending.resolve(message.result ?? {});
      }
      return;
    }

    if (message.method && this.notificationHandler) {
      this.handleNotification(/** @type {AppServerNotification} */ (message));
    }
  }

  handleNotification(message) {
    this.notificationHandler?.(message);
  }

  handleServerRequest(message) {
    this.sendMessage({
      id: message.id,
      error: buildJsonRpcError(-32601, `Unsupported server request: ${message.method}`)
    });
  }

  handleExit(error) {
    if (this.exitResolved) {
      return;
    }

    this.exitResolved = true;
    this.exitError = error ?? null;

    for (const pending of this.pending.values()) {
      pending.reject(this.exitError ?? new Error("codex app-server connection closed."));
    }
    this.pending.clear();
    this.resolveExit(undefined);
    this.exitHandler?.(this.exitError);
  }

  sendMessage(_message) {
    throw new Error("sendMessage must be implemented by subclasses.");
  }
}

export class SpawnedCodexAppServerClient extends AppServerClientBase {
  constructor(cwd, options = {}) {
    super(cwd, options);
    this.transport = "direct";
    this.notificationRefreshPromise = Promise.resolve();
  }

  async initialize() {
    const gated = this.options.gatedBrokerChild === true && process.platform !== "win32";
    this.proc = spawn(gated ? process.execPath : "codex", gated ? [GATED_APP_SERVER_CHILD] : ["app-server"], {
      cwd: this.cwd,
      env: this.options.env ?? process.env,
      detached: process.platform !== "win32",
      stdio: gated ? ["pipe", "pipe", "pipe", "pipe"] : ["pipe", "pipe", "pipe"],
      shell: process.platform === "win32" ? (process.env.SHELL || true) : false,
      windowsHide: true
    });
    this.proc.stdout.setEncoding("utf8");
    this.proc.stderr.setEncoding("utf8");

    this.proc.stderr.on("data", (chunk) => {
      this.stderr += chunk;
    });

    this.proc.on("error", (error) => {
      this.handleExit(error);
    });

    this.proc.on("exit", (code, signal) => {
      const stderr = this.stderr.trim();
      const detail =
        code === 0
          ? null
          : createProtocolError(
              `codex app-server exited unexpectedly (${signal ? `signal ${signal}` : `exit ${code}`}).${stderr ? `\n${stderr}` : ""}`
            );
      if (!this.closed) {
        this.startUnexpectedExitCleanup(this.proc.pid);
      }
      this.handleExit(detail);
    });

    this.readline = readline.createInterface({ input: this.proc.stdout });
    this.readline.on("line", (line) => {
      this.handleLine(line);
    });

    try {
      const captureOwnership = this.options.captureProcessOwnershipImpl ?? captureProcessOwnership;
      this.ownershipSnapshot =
        process.platform === "win32"
          ? null
          : captureOwnership(this.proc.pid, {
              cwd: this.cwd,
              env: this.options.env ?? process.env
            });
      this.procIdentity = this.ownershipSnapshot?.rootIdentity ?? null;
    } catch (error) {
      this.identityCaptureFailed = true;
      throw error;
    }
    if (process.platform !== "win32" && !this.procIdentity) {
      this.identityCaptureFailed = true;
      throw new Error("Unable to capture codex app-server process identity.");
    }
    if (gated) {
      await this.options.beforeAppServerActivation?.(this.ownershipSnapshot);
      const activationControl = this.proc.stdio?.[3];
      if (!activationControl) {
        throw new Error("Codex app-server activation control is unavailable.");
      }
      activationControl.end("activate\n");
    }
    await this.request("initialize", {
      clientInfo: this.options.clientInfo ?? DEFAULT_CLIENT_INFO,
      capabilities: this.options.capabilities ?? DEFAULT_CAPABILITIES
    });
    this.notify("initialized", {});
  }

  mergeOwnershipSnapshot(observation) {
    if (
      !observation?.rootIdentity ||
      observation.rootIdentity !== this.procIdentity ||
      observation.rootPid !== this.ownershipSnapshot?.rootPid
    ) {
      throw new Error("Codex app-server ownership identity changed while refreshing its helper tree.");
    }
    const members = new Map();
    for (const snapshot of [this.ownershipSnapshot, observation]) {
      for (const member of snapshot?.members ?? []) {
        members.set(member.identity, member);
      }
    }
    this.ownershipSnapshot = {
      ...observation,
      members: [...members.values()]
    };
    return this.ownershipSnapshot;
  }

  async refreshOwnership() {
    if (process.platform === "win32" || !this.procIdentity || !this.proc?.pid) {
      return this.ownershipSnapshot ?? null;
    }
    const captureOwnership = this.options.captureProcessOwnershipImpl ?? captureProcessOwnership;
    const observation = captureOwnership(this.proc.pid, {
      cwd: this.cwd,
      env: this.options.env ?? process.env
    });
    const ownershipSnapshot = this.mergeOwnershipSnapshot(observation);
    await this.options.afterAppServerOwnershipRefresh?.(ownershipSnapshot);
    return ownershipSnapshot;
  }

  handleNotification(message) {
    this.notificationRefreshPromise = this.notificationRefreshPromise.then(async () => {
      if (this.exitResolved) {
        return;
      }
      try {
        // Streaming requests return before their turn is complete. Publish a
        // fresh helper observation before forwarding each later notification
        // so independently grouped helpers are durable before a crash can
        // strand them outside both local and registered cleanup.
        await this.refreshOwnership();
      } catch (error) {
        this.startUnexpectedExitCleanup(this.proc?.pid);
        this.handleExit(error);
        return;
      }
      if (!this.closed) {
        this.notificationHandler?.(message);
      }
    });
    return this.notificationRefreshPromise;
  }

  async request(method, params) {
    let result;
    let requestError;
    try {
      result = await super.request(method, params);
    } catch (error) {
      requestError = error;
    }
    // Helpers may be created only after the gated wrapper is activated. Take
    // and durably publish a fresh identity snapshot at every request boundary
    // before the broker exposes the response or error to its caller.
    await this.refreshOwnership();
    if (requestError) {
      throw requestError;
    }
    return result;
  }

  startUnexpectedExitCleanup(pid) {
    if (
      this.unexpectedExitCleanupPromise ||
      process.platform === "win32" ||
      !Number.isFinite(pid) ||
      !this.ownershipSnapshot?.rootIdentity
    ) {
      return this.unexpectedExitCleanupPromise ?? null;
    }

    const observationBarrier = this.notificationRefreshPromise ?? Promise.resolve();
    this.unexpectedExitCleanupPromise = observationBarrier
      .catch(() => {})
      .then(() => terminateProcessGroup(pid, {
        ownershipSnapshot: this.ownershipSnapshot,
        cwd: this.cwd,
        env: this.options.env ?? process.env,
        warnImpl: () => {}
      }))
      .then((outcome) => {
        this.cleanupOutcome = normalizeProcessCleanupOutcome(outcome);
        if (!outcome.verified) {
          process.stderr.write(
            `Warning: unable to verify crashed codex app-server group cleanup; surviving PIDs: ${outcome.survivors?.join(", ") || "none known"}.\n`
          );
        }
        return this.cleanupOutcome;
      })
      .catch((error) => {
        this.cleanupOutcome = normalizeProcessCleanupOutcome({
          attempted: true,
          delivered: false,
          verified: false,
          degraded: true,
          method: "process-group",
          survivors: [],
          survivorIdentities: []
        });
        process.stderr.write(`Warning: crashed codex app-server group cleanup failed: ${error.message}.\n`);
        return this.cleanupOutcome;
      });
    return this.unexpectedExitCleanupPromise;
  }

  waitForUnexpectedExitCleanup() {
    return this.unexpectedExitCleanupPromise ?? null;
  }

  async close() {
    if (this.closed) {
      await this.waitForExit();
      return;
    }

    this.closed = true;

    await this.notificationRefreshPromise?.catch(() => {});

    if (this.readline) {
      this.readline.close();
    }

    if (this.proc) {
      this.proc.stdio?.[3]?.end?.();
      try {
        this.proc.stdin.end();
      } catch {
        // The child may have closed its input before cleanup began.
      }
      const terminate = this.options.terminateProcessTreeImpl ?? terminateProcessTree;
      const platform = this.options.platform ?? process.platform;
      if (platform === "win32") {
        // Terminate synchronously during close. An unref'd timer never fires
        // when the companion exits immediately, orphaning the app-server
        // child; taskkill runs synchronously so there is no reason to defer.
        if (!this.proc.killed && this.proc.exitCode === null) {
          try {
            const outcome = await terminate(this.proc.pid, {
              platform,
              expectedRootIdentity: this.procIdentity,
              ownershipSnapshot: this.ownershipSnapshot,
              requireVerifiedOwnership: this.identityCaptureFailed,
              ownerHoldsLiveHandle: true,
              runCommandImpl: this.options.runCommandImpl,
              warnImpl: () => {}
            });
            this.cleanupOutcome = normalizeProcessCleanupOutcome(outcome);
            if (!outcome.verified) {
              process.stderr.write(
                `Warning: unable to verify codex app-server cleanup; surviving PIDs: ${outcome.survivors?.join(", ") || "none known"}.\n`
              );
            }
          } catch {
            // Best-effort cleanup during shutdown — swallow errors to avoid
            // crashing the host process.
          }
        }
      } else {
        // The app-server is its own process-group leader on Unix. Terminate
        // the group so MCP helpers cannot outlive the app-server parent.
        if (this.unexpectedExitCleanupPromise) {
          await this.unexpectedExitCleanupPromise;
        } else {
          const outcome = await terminate(this.proc.pid, {
            expectedRootIdentity: this.procIdentity,
            ownershipSnapshot: this.ownershipSnapshot,
            requireVerifiedOwnership: this.identityCaptureFailed,
            ownerHoldsLiveHandle: true,
            directKillImpl: (signal) => this.proc.kill(signal),
            warnImpl: () => {}
          });
          this.cleanupOutcome = normalizeProcessCleanupOutcome(outcome);
          if (!outcome.verified) {
            process.stderr.write(
              `Warning: unable to verify codex app-server cleanup; surviving PIDs: ${outcome.survivors?.join(", ") || "none known"}.\n`
            );
          }
        }
      }
    }

    const exited = await this.waitForExit();
    if (!exited) {
      this.cleanupOutcome = normalizeProcessCleanupOutcome({
        ...(this.cleanupOutcome ?? {}),
        attempted: true,
        verified: false,
        degraded: true
      });
    }
  }

  async waitForExit() {
    const timeoutMs = Number.isFinite(this.options.closeWaitMs) ? this.options.closeWaitMs : DEFAULT_CLOSE_WAIT_MS;
    let timeout;
    const timedOut = new Promise((resolve) => {
      timeout = setTimeout(() => resolve(false), timeoutMs);
    });
    const exited = await Promise.race([this.exitPromise.then(() => true), timedOut]);
    clearTimeout(timeout);
    return exited;
  }

  sendMessage(message) {
    const line = `${JSON.stringify(message)}\n`;
    const stdin = this.proc?.stdin;
    if (!stdin) {
      throw new Error("codex app-server stdin is not available.");
    }
    stdin.write(line);
  }
}

class BrokerCodexAppServerClient extends AppServerClientBase {
  constructor(cwd, options = {}) {
    super(cwd, options);
    this.transport = "broker";
    this.endpoint = options.brokerEndpoint;
  }

  async initialize() {
    await new Promise((resolve, reject) => {
      const target = parseBrokerEndpoint(this.endpoint);
      this.socket = net.createConnection({ path: target.path });
      this.socket.setEncoding("utf8");
      this.socket.on("connect", resolve);
      this.socket.on("data", (chunk) => {
        this.handleChunk(chunk);
      });
      this.socket.on("error", (error) => {
        if (!this.exitResolved) {
          reject(error);
        }
        this.handleExit(error);
      });
      this.socket.on("close", () => {
        this.handleExit(this.exitError);
      });
    });

    await this.request("initialize", {
      clientInfo: this.options.clientInfo ?? DEFAULT_CLIENT_INFO,
      capabilities: this.options.capabilities ?? DEFAULT_CAPABILITIES
    });
    this.notify("initialized", {});
  }

  async close() {
    if (this.closed) {
      await this.exitPromise;
      return;
    }

    this.closed = true;
    if (this.socket) {
      this.socket.end();
    }
    await this.exitPromise;
  }

  sendMessage(message) {
    const line = `${JSON.stringify(message)}\n`;
    const socket = this.socket;
    if (!socket) {
      throw new Error("codex app-server broker connection is not connected.");
    }
    socket.write(line);
  }
}

export class CodexAppServerClient {
  static async connect(cwd, options = {}) {
    let brokerEndpoint = null;
    let transportFallback = null;
    if (!options.disableBroker) {
      brokerEndpoint = options.brokerEndpoint ?? options.env?.[BROKER_ENDPOINT_ENV] ?? process.env[BROKER_ENDPOINT_ENV] ?? null;
      if (!brokerEndpoint && options.reuseExistingBroker) {
        brokerEndpoint = loadReusableBrokerSession(cwd, options.env ?? process.env)?.endpoint ?? null;
      }
      if (!brokerEndpoint && !options.reuseExistingBroker) {
        const brokerSession = await ensureBrokerSession(cwd, {
          env: options.env,
          onUnavailable: (reason) => {
            transportFallback = reason;
          }
        });
        brokerEndpoint = brokerSession?.endpoint ?? null;
        if (!brokerEndpoint) {
          transportFallback ??= "broker unavailable";
        }
      }
    }
    const client = brokerEndpoint
      ? new BrokerCodexAppServerClient(cwd, { ...options, brokerEndpoint })
      : new SpawnedCodexAppServerClient(cwd, options);
    client.transportFallback = transportFallback;
    try {
      await client.initialize();
      return client;
    } catch (error) {
      try {
        await client.close();
      } catch {
        client.cleanupOutcome = {
          verified: false,
          survivors: [],
          degraded: true
        };
      }
      if (client.cleanupOutcome?.verified === false) {
        error.cleanupOutcome = client.cleanupOutcome;
      }
      throw error;
    }
  }
}
