// The broker launch lock's greeting server must survive probing clients that
// hard-destroy their connection after reading: without a per-socket error
// handler the resulting ECONNRESET was an uncaughtException that killed the
// lock holder mid-launch (observed as a CI crash in the concurrent-launch
// broker test, but equally fatal to a real companion during a concurrent
// session startup).
import net from "node:net";
import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir } from "./helpers.mjs";
import { acquireBrokerLaunchLock, brokerLaunchLockPort } from "../plugins/codex/scripts/lib/broker-lifecycle.mjs";

// The lock port is hash-derived from the workspace path; Windows reserves
// whole port ranges (Hyper-V/WSL) where listening fails EACCES. Sample fresh
// workspaces until one binds — production routes excluded ports through the
// direct-mode fallback, which is pinned elsewhere.
async function acquireBindableLaunchLock(attempts = 6) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const cwd = makeTempDir();
    try {
      const lock = await acquireBrokerLaunchLock(cwd, { timeoutMs: 500 });
      return { cwd, lock, port: brokerLaunchLockPort(cwd) };
    } catch (error) {
      if (error?.code === "EACCES") {
        continue;
      }
      throw error;
    }
  }
  return null;
}

test("the launch-lock server survives clients that reset their connection", async (t) => {
  const acquired = await acquireBindableLaunchLock();
  if (!acquired) {
    t.skip("Every sampled launch-lock port is OS-excluded on this host.");
    return;
  }
  const { lock, port } = acquired;
  try {
    // Two abusive clients: one destroys on connect (RST can beat the
    // greeting flush), one destroys immediately after the first byte — the
    // exact shape probeBrokerLaunchPort produces via socket.destroy().
    for (const readFirst of [false, true]) {
      await new Promise((resolve, reject) => {
        const socket = net.createConnection({ host: "127.0.0.1", port });
        const timer = setTimeout(() => reject(new Error("client never settled")), 2000);
        timer.unref?.();
        socket.on("error", () => {
          clearTimeout(timer);
          resolve();
        });
        if (readFirst) {
          socket.once("data", () => {
            socket.destroy();
            clearTimeout(timer);
            resolve();
          });
        } else {
          socket.on("connect", () => {
            socket.destroy();
            clearTimeout(timer);
            resolve();
          });
        }
      });
    }

    // Give any ECONNRESET a tick to surface: the process must still be alive
    // and the lock server must still answer with its greeting.
    await new Promise((resolve) => setTimeout(resolve, 100));
    const greeting = await new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: "127.0.0.1", port });
      let buffer = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk) => {
        buffer += chunk;
      });
      socket.on("end", () => resolve(buffer));
      socket.on("error", reject);
    });
    assert.match(greeting, /^codex-broker-launch-v1:/);
  } finally {
    await lock.release();
  }
});
