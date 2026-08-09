// Live verification of the discovery bench's network boundary.
//
// The claim under test: an agent container can reach ONLY the allowlisted host,
// through the proxy, and cannot reach anything else even by bypassing the proxy
// entirely. Nothing here is asserted from the design — every leg runs real
// docker and real curl, because the previous probe already proved that a
// lockdown which merely LOOKS right (all web tools removed) still let an agent
// curl the NVD API.
import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PROXY_SRC = path.join(ROOT, "bench", "lib", "egress-proxy.mjs");
const mount = (p) => p.replace(/\\/g, "/").replace(/^([A-Za-z]):/, (_, d) => `//${d.toLowerCase()}`);

const INTERNAL = "bench-egress-internal";
const EXTERNAL = "bench-egress-external";
const PROXY = "bench-egress-proxy";
const ALLOWED = "api.anthropic.com";
const DENIED = "services.nvd.nist.gov";

function sh(args, opts = {}) {
  const r = spawnSync("docker", args, { encoding: "utf8", shell: false, timeout: 180000, ...opts });
  return { status: r.status, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim() };
}

function cleanup() {
  sh(["rm", "-f", PROXY]);
  sh(["network", "rm", INTERNAL]);
  sh(["network", "rm", EXTERNAL]);
}

process.stdout.write("=== setup ===\n");
cleanup();
// --internal: no route off this network at all. This is the actual boundary;
// HTTPS_PROXY env vars are a convenience, not a control (curl --noproxy would
// ignore them).
for (const [name, args] of [
  [INTERNAL, ["network", "create", "--internal", INTERNAL]],
  [EXTERNAL, ["network", "create", EXTERNAL]]
]) {
  const r = sh(args);
  process.stdout.write(`  network ${name}: ${r.status === 0 ? "created" : "FAILED " + r.err}\n`);
  if (r.status !== 0) process.exit(1);
}

// The proxy straddles both networks: reachable from the sealed side, with
// egress on the other. It is the ONLY path out.
const runProxy = sh([
  "run", "-d", "--name", PROXY, "--network", INTERNAL,
  "-v", `${mount(PROXY_SRC)}:/proxy/egress-proxy.mjs:ro`,
  "-e", `ALLOWLIST=${ALLOWED}`,
  "node:22",
  "node", "-e",
  `import("/proxy/egress-proxy.mjs").then(async (m) => {
     const p = await m.startEgressProxy({ allowlist: process.env.ALLOWLIST.split(","), port: 8888, logPath: "/tmp/egress.jsonl" });
     console.log("proxy listening on " + p.port);
   })`
]);
process.stdout.write(`  proxy container: ${runProxy.status === 0 ? "started" : "FAILED " + runProxy.err}\n`);
if (runProxy.status !== 0) { cleanup(); process.exit(1); }

sh(["network", "connect", EXTERNAL, PROXY]);
// Give node a moment to bind without a foreground sleep.
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 4000);
process.stdout.write(`  proxy log: ${sh(["logs", PROXY]).out || "(none yet)"}\n`);

function agentCurl(label, curlArgs) {
  const r = sh([
    "run", "--rm", "--network", INTERNAL, "curlimages/curl:latest",
    ...curlArgs
  ]);
  process.stdout.write(`\n  [${label}]\n    exit=${r.status}\n    out=${r.out.slice(0, 200)}\n    err=${r.err.slice(0, 200)}\n`);
  return r;
}

process.stdout.write("\n=== legs ===\n");

// 1. Allowlisted host THROUGH the proxy -> must reach it (any HTTP status
//    proves the tunnel; 401 from an unauthenticated API call is a success here).
const allowedViaProxy = agentCurl("allowlisted via proxy", [
  "-sS", "-o", "/dev/null", "-w", "%{http_code}", "--max-time", "25",
  "-x", `http://${PROXY}:8888`, `https://${ALLOWED}/v1/messages`
]);

// 2. Denied host THROUGH the proxy -> must be refused.
const deniedViaProxy = agentCurl("denied via proxy", [
  "-sS", "-o", "/dev/null", "-w", "%{http_code}", "--max-time", "25",
  "-x", `http://${PROXY}:8888`, `https://${DENIED}/rest/json/cves/2.0`
]);

// 3. Denied host BYPASSING the proxy -> must fail on the network itself.
//    This is the leg that matters: it is what an agent that ignores
//    HTTPS_PROXY would do.
const deniedDirect = agentCurl("denied direct (proxy bypassed)", [
  "-sS", "-o", "/dev/null", "-w", "%{http_code}", "--noproxy", "*", "--max-time", "25",
  `https://${DENIED}/rest/json/cves/2.0`
]);

// 4. Allowlisted host BYPASSING the proxy -> must ALSO fail, proving the
//    boundary is the network and not the allowlist's goodwill.
const allowedDirect = agentCurl("allowlisted direct (proxy bypassed)", [
  "-sS", "-o", "/dev/null", "-w", "%{http_code}", "--noproxy", "*", "--max-time", "25",
  `https://${ALLOWED}/v1/messages`
]);

process.stdout.write("\n=== audit trail ===\n");
const log = sh(["exec", PROXY, "sh", "-c", "cat /tmp/egress.jsonl 2>/dev/null || echo '(empty)'"]);
process.stdout.write(`${log.out}\n`);

process.stdout.write("\n=== verdict ===\n");
const checks = [
  ["allowlisted host reachable through proxy", allowedViaProxy.status === 0 && /^\d{3}$/.test(allowedViaProxy.out)],
  ["denied host refused through proxy", deniedViaProxy.status !== 0 || deniedViaProxy.out === "000"],
  ["denied host unreachable when bypassing proxy", deniedDirect.status !== 0 || deniedDirect.out === "000"],
  ["allowlisted host unreachable when bypassing proxy", allowedDirect.status !== 0 || allowedDirect.out === "000"]
];
let ok = true;
for (const [name, passed] of checks) {
  process.stdout.write(`  ${passed ? "PASS" : "FAIL"}  ${name}\n`);
  if (!passed) ok = false;
}
process.stdout.write(ok ? "\nBOUNDARY HOLDS\n" : "\nBOUNDARY DOES NOT HOLD\n");

cleanup();
process.exit(ok ? 0 : 1);
