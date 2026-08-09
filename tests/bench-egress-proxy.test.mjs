// The egress boundary. These tests drive the real proxy over real sockets —
// the whole point of this component is that it holds against an actual client,
// and a mocked allowlist check would prove nothing about that.
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { hostAllowed, parseAuthority, startEgressProxy } from "../bench/lib/egress-proxy.mjs";

test("hostAllowed matches on dot boundaries, so a suffix cannot be forged", () => {
  const allow = ["api.anthropic.com"];
  assert.equal(hostAllowed("api.anthropic.com", allow), true);
  assert.equal(hostAllowed("API.Anthropic.COM", allow), true);
  assert.equal(hostAllowed("api.anthropic.com.", allow), true, "trailing root dot is still the same host");

  // The attacks a bare endsWith() would admit.
  assert.equal(hostAllowed("notapi.anthropic.com", allow), false);
  assert.equal(hostAllowed("api.anthropic.com.attacker.invalid", allow), false);
  assert.equal(hostAllowed("services.nvd.nist.gov", allow), false);

  // A broader entry admits subdomains but still not a forged suffix.
  assert.equal(hostAllowed("api.anthropic.com", ["anthropic.com"]), true);
  assert.equal(hostAllowed("anthropic.com.evil.invalid", ["anthropic.com"]), false);
  assert.equal(hostAllowed("anything", []), false);
});

test("parseAuthority refuses shapes it cannot read rather than guessing", () => {
  assert.deepEqual(parseAuthority("example.com:443", 443), { host: "example.com", port: 443 });
  assert.deepEqual(parseAuthority("example.com", 443), { host: "example.com", port: 443 });
  assert.deepEqual(parseAuthority("[::1]:8443", 443), { host: "::1", port: 8443 });
  // Ambiguous or malformed targets are denied: "we could not tell where this
  // was going" is not a reason to allow it.
  assert.equal(parseAuthority("::1:443", 443), null);
  assert.equal(parseAuthority("example.com:notaport", 443), null);
  assert.equal(parseAuthority("", 443), null);
});

test("a denied CONNECT is refused with 403 and recorded in the audit trail", async (t) => {
  const logPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "bench-egress-")), "egress.jsonl");
  const proxy = await startEgressProxy({ allowlist: ["api.anthropic.com"], logPath });
  t.after(() => proxy.close());

  const { status, tunnelled } = await new Promise((resolve, reject) => {
    const req = http.request({
      port: proxy.port,
      host: "127.0.0.1",
      method: "CONNECT",
      path: "services.nvd.nist.gov:443"
    });
    // Node emits "connect" for ANY response to a CONNECT, refusals included —
    // the status code is the only thing that says whether a tunnel exists.
    // (Found by driving a real socket; a client that assumed the event meant
    // success would treat this denial as an open tunnel.)
    req.on("connect", (res, socket) => {
      // A refused CONNECT must leave nothing to talk to.
      let sawData = false;
      socket.on("data", () => {
        sawData = true;
      });
      socket.destroy();
      resolve({ status: res.statusCode, tunnelled: sawData });
    });
    req.on("response", (res) => {
      res.resume();
      resolve({ status: res.statusCode, tunnelled: false });
    });
    req.on("error", reject);
    req.end();
  });

  assert.equal(status, 403);
  assert.equal(tunnelled, false, "a denied CONNECT must not carry traffic");
  assert.deepEqual(proxy.deniedHosts(), ["services.nvd.nist.gov"]);

  // The attempt is durable, because "the agent tried to look up the advisory"
  // is a finding about the run, not noise.
  const logged = fs.readFileSync(logPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(logged.length, 1);
  assert.equal(logged[0].host, "services.nvd.nist.gov");
  assert.equal(logged[0].allowed, false);
  assert.equal(logged[0].method, "CONNECT");
});

test("an allowed CONNECT tunnels end to end", async (t) => {
  // Stand up a local origin and allowlist it, so the permitted path is
  // exercised for real rather than asserted.
  const origin = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("origin-reached");
  });
  await new Promise((resolve) => origin.listen(0, "127.0.0.1", resolve));
  const originPort = origin.address().port;
  t.after(() => new Promise((done) => origin.close(() => done())));

  const proxy = await startEgressProxy({ allowlist: ["127.0.0.1"] });
  t.after(() => proxy.close());

  const body = await new Promise((resolve, reject) => {
    const req = http.request({
      port: proxy.port,
      host: "127.0.0.1",
      method: "CONNECT",
      path: `127.0.0.1:${originPort}`
    });
    req.on("connect", (res, socket) => {
      assert.equal(res.statusCode, 200);
      socket.write(`GET / HTTP/1.1\r\nHost: 127.0.0.1:${originPort}\r\nConnection: close\r\n\r\n`);
      let data = "";
      socket.on("data", (chunk) => {
        data += chunk.toString();
      });
      socket.on("end", () => resolve(data));
    });
    req.on("response", (res) => {
      res.resume();
      reject(new Error(`tunnel refused with ${res.statusCode}`));
    });
    req.on("error", reject);
    req.end();
  });

  assert.match(body, /origin-reached/);
  assert.deepEqual(proxy.deniedHosts(), []);
});

test("plain-HTTP absolute-form requests are policed by the same allowlist", async (t) => {
  const proxy = await startEgressProxy({ allowlist: ["api.anthropic.com"] });
  t.after(() => proxy.close());

  const status = await new Promise((resolve, reject) => {
    const req = http.request(
      { port: proxy.port, host: "127.0.0.1", method: "GET", path: "http://services.nvd.nist.gov/rest/json/cves/2.0" },
      (res) => {
        res.resume();
        resolve(res.statusCode);
      }
    );
    req.on("error", reject);
    req.end();
  });

  assert.equal(status, 403);
  assert.ok(proxy.deniedHosts().includes("services.nvd.nist.gov"));
});
