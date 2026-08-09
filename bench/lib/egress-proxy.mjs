// A minimal HTTP/CONNECT proxy that enforces the discovery bench's egress
// allowlist — and, just as importantly, records every attempt.
//
// Why a proxy at all. Tool-level lockdown is not enough: with WebSearch,
// WebFetch and every MCP tool removed, a benched agent still reached the NVD
// REST API with plain `curl` and got live results (measured 2026-08-09). A
// denylist of network commands is unwinnable — curl, wget, node fetch, python
// urllib, git, nc — so the boundary has to sit below the agent. But the agent
// still needs its own model API to exist at all, so the requirement is
// SELECTIVE egress rather than none.
//
// The log is not a side effect, it is a deliverable: a run that TRIED to reach
// the advisory database is interesting behavioural data about how the agent
// approached the task. Blocked attempts are recorded, never punished.
import fs from "node:fs";
import http from "node:http";
import net from "node:net";

/**
 * Host matching is suffix-on-a-dot-boundary, never bare `endsWith`.
 * Allowing "anthropic.com" must not admit "anthropic.com.attacker.invalid",
 * and allowing "api.anthropic.com" must not admit "notapi.anthropic.com".
 */
export function hostAllowed(host, allowlist) {
  if (typeof host !== "string" || host.length === 0) {
    return false;
  }
  const candidate = host.toLowerCase().replace(/\.$/, "");
  return (allowlist ?? []).some((entry) => {
    const allowed = String(entry).toLowerCase().replace(/^\.+|\.$/g, "");
    if (allowed.length === 0) {
      return false;
    }
    return candidate === allowed || candidate.endsWith(`.${allowed}`);
  });
}

/**
 * Splits a CONNECT authority ("host:443") or an absolute-form request target.
 * Returns null rather than guessing when the shape is unrecognised — an
 * unparseable target is denied, because "we could not tell where this was
 * going" is not a reason to let it through.
 */
export function parseAuthority(authority, defaultPort) {
  if (typeof authority !== "string" || authority.trim().length === 0) {
    return null;
  }
  const value = authority.trim();
  // Bracketed IPv6 literal, e.g. [::1]:443
  const bracketed = value.match(/^\[([^\]]+)\](?::(\d+))?$/);
  if (bracketed) {
    return { host: bracketed[1], port: Number(bracketed[2] ?? defaultPort) };
  }
  if (value.split(":").length > 2) {
    return null; // bare IPv6 without brackets: ambiguous, refuse
  }
  const [host, portText] = value.split(":");
  if (!host) {
    return null;
  }
  const port = portText === undefined ? defaultPort : Number(portText);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    return null;
  }
  return { host, port };
}

/**
 * Starts the proxy. Returns { port, close, attempts } where `attempts` is the
 * in-memory audit trail (also appended to `logPath` when given).
 */
export function startEgressProxy({ allowlist = [], logPath = null, port = 0 } = {}) {
  const attempts = [];

  function record(entry) {
    const line = { at: new Date().toISOString(), ...entry };
    attempts.push(line);
    if (logPath) {
      try {
        fs.appendFileSync(logPath, `${JSON.stringify(line)}\n`);
      } catch {
        // The audit log must never take down the run it is observing.
      }
    }
  }

  const server = http.createServer((req, res) => {
    // Absolute-form plain HTTP (`GET http://host/path`). Denied unless
    // allowlisted, same as CONNECT.
    let target = null;
    try {
      target = new URL(req.url ?? "");
    } catch {
      target = null;
    }
    const host = target?.hostname ?? null;
    const allowed = host !== null && hostAllowed(host, allowlist);
    record({ method: req.method, host, port: Number(target?.port || 80), scheme: "http", allowed });
    if (!allowed) {
      res.writeHead(403, { "content-type": "text/plain" });
      res.end("egress denied by bench policy\n");
      return;
    }
    const upstream = http.request(
      { host, port: Number(target.port || 80), path: `${target.pathname}${target.search}`, method: req.method, headers: req.headers },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
        upstreamRes.pipe(res);
      }
    );
    upstream.on("error", () => {
      res.writeHead(502, { "content-type": "text/plain" });
      res.end("upstream error\n");
    });
    req.pipe(upstream);
  });

  // HTTPS rides CONNECT, which is what actually matters: the API the agent
  // needs and the advisory databases it must not reach are both TLS.
  server.on("connect", (req, clientSocket, head) => {
    const parsed = parseAuthority(req.url ?? "", 443);
    const allowed = parsed !== null && hostAllowed(parsed.host, allowlist);
    record({ method: "CONNECT", host: parsed?.host ?? null, port: parsed?.port ?? null, scheme: "https", allowed });

    if (!allowed) {
      clientSocket.write("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n");
      clientSocket.destroy();
      return;
    }
    const upstream = net.connect(parsed.port, parsed.host, () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head?.length) {
        upstream.write(head);
      }
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    const teardown = () => {
      upstream.destroy();
      clientSocket.destroy();
    };
    upstream.on("error", teardown);
    clientSocket.on("error", teardown);
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "0.0.0.0", () => {
      resolve({
        port: server.address().port,
        attempts,
        deniedHosts: () => [...new Set(attempts.filter((a) => !a.allowed).map((a) => a.host))],
        close: () => new Promise((done) => server.close(() => done()))
      });
    });
  });
}
