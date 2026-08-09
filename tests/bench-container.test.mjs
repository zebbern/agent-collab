// Docker argv shapes. These are pure builders, but the shapes carry the run's
// safety properties, so each test names the incident the constraint exists for.
import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_LIMITS,
  buildAgentRunArgs,
  buildApplyLegSpec,
  buildExecArgs,
  buildNetworkCreateArgs,
  buildTeardownArgs,
  buildTreeCopySpec,
  toDockerMountPath
} from "../bench/lib/container.mjs";

function argValue(args, flag) {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

test("windows host paths are converted to the //c/... form docker expects", () => {
  assert.equal(toDockerMountPath("C:\\Users\\zeb\\tree.tar"), "//c/Users/zeb/tree.tar");
  assert.equal(toDockerMountPath("/home/zeb/tree.tar"), "/home/zeb/tree.tar");
});

test("the agent container attaches only to the sealed network", () => {
  const args = buildAgentRunArgs({
    image: "python@sha256:abc",
    containerName: "agent-1",
    internalNetwork: "bench-internal",
    proxyHost: "bench-proxy"
  });
  assert.equal(argValue(args, "--network"), "bench-internal");
  // Exactly one network attachment: a second would be a route off the island.
  assert.equal(args.filter((a) => a === "--network").length, 1);
});

test("an unsealed agent run is refused outright", () => {
  assert.throws(
    () => buildAgentRunArgs({ image: "x@sha256:abc", containerName: "a", proxyHost: "p" }),
    /measures retrieval, not discovery/
  );
});

test("proxy env vars are set but are documented as a convenience, not the control", () => {
  const args = buildAgentRunArgs({
    image: "python@sha256:abc",
    containerName: "agent-1",
    internalNetwork: "bench-internal",
    proxyHost: "bench-proxy",
    proxyPort: 8888
  });
  for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"]) {
    assert.ok(args.includes(`${name}=http://bench-proxy:8888`), `${name} should be set`);
  }
});

test("caller env is merged and can be extended without dropping the proxy settings", () => {
  const args = buildAgentRunArgs({
    image: "python@sha256:abc",
    containerName: "agent-1",
    internalNetwork: "bench-internal",
    proxyHost: "bench-proxy",
    env: { AIOHTTP_NO_EXTENSIONS: "1" }
  });
  assert.ok(args.includes("AIOHTTP_NO_EXTENSIONS=1"));
  assert.ok(args.includes("HTTPS_PROXY=http://bench-proxy:8888"));
});

test("every container carries hard resource caps — a wedged host cost a day once", () => {
  const args = buildAgentRunArgs({
    image: "python@sha256:abc",
    containerName: "agent-1",
    internalNetwork: "bench-internal",
    proxyHost: "bench-proxy"
  });
  assert.equal(argValue(args, "--memory"), DEFAULT_LIMITS.memory);
  assert.equal(argValue(args, "--cpus"), DEFAULT_LIMITS.cpus);
  assert.equal(argValue(args, "--pids-limit"), String(DEFAULT_LIMITS.pidsLimit));
});

test("limits are overridable per task without losing the others", () => {
  const args = buildAgentRunArgs({
    image: "python@sha256:abc",
    containerName: "agent-1",
    internalNetwork: "bench-internal",
    proxyHost: "bench-proxy",
    limits: { memory: "10g" }
  });
  assert.equal(argValue(args, "--memory"), "10g");
  assert.equal(argValue(args, "--cpus"), DEFAULT_LIMITS.cpus);
});

test("the internal network is created with --internal and the external one without", () => {
  const [internal, external] = buildNetworkCreateArgs({ internal: "bench-in", external: "bench-out" });
  assert.ok(internal.args.includes("--internal"));
  assert.ok(!external.args.includes("--internal"));
});

test("the tree is copied in, never bind-mounted", () => {
  // A bind mount measured 10+ minutes versus 20 seconds on one task, and let
  // host line-ending and permission semantics leak into the audited tree.
  const spec = buildTreeCopySpec({ containerName: "agent-1", hostTarball: "C:\\tmp\\tree.tar" });
  assert.deepEqual(spec.copy, ["cp", "//c/tmp/tree.tar", "agent-1:/work/tree.tar"]);
  assert.ok(spec.extract.includes("tar"));
  // The tarball is removed so the agent cannot notice a packaging artifact.
  assert.ok(spec.cleanup.join(" ").includes("rm -f tree.tar") || spec.cleanup.includes("tree.tar"));
});

test("exec runs through a login shell with the requested workdir, env and user", () => {
  const args = buildExecArgs({
    containerName: "agent-1",
    command: "go test ./...",
    workdir: "/work/repo",
    env: { GOFLAGS: "-count=1" },
    user: "tester"
  });
  assert.equal(argValue(args, "-w"), "/work/repo");
  assert.equal(argValue(args, "-u"), "tester");
  assert.ok(args.includes("GOFLAGS=-count=1"));
  // The command is the final argument, passed to `sh -lc` as one string rather
  // than split into argv — task build/test invocations are shell pipelines.
  assert.deepEqual(args.slice(-4), ["agent-1", "sh", "-lc", "go test ./..."]);
});

test("a non-root user can be requested — one task's suite silently runs nothing as root", () => {
  const asRoot = buildExecArgs({ containerName: "a", command: "true" });
  assert.equal(asRoot.includes("-u"), false);
  const asUser = buildExecArgs({ containerName: "a", command: "true", user: "tester" });
  assert.equal(argValue(asUser, "-u"), "tester");
});

test("applying a leg checks the patch first, so a silent no-op cannot happen", () => {
  // A patch that fails to apply leaves the parent in place, and then every
  // downstream number is the parent measured twice.
  const spec = buildApplyLegSpec({ containerName: "agent-1", patchPathInContainer: "/patches/minimal.patch" });
  const checkCommand = spec.check[spec.check.length - 1];
  assert.match(checkCommand, /--check/);
  assert.match(checkCommand, /--dry-run/);
  const applyCommand = spec.apply[spec.apply.length - 1];
  assert.ok(!applyCommand.includes("--check"));
});

test("teardown names containers and networks separately, because networks outlive containers", () => {
  const args = buildTeardownArgs({ containers: ["agent-1"], networks: ["bench-in", "bench-out"] });
  assert.deepEqual(args[0], ["rm", "-f", "agent-1"]);
  assert.deepEqual(args[1], ["network", "rm", "bench-in"]);
  assert.deepEqual(args[2], ["network", "rm", "bench-out"]);
});

test("buildExecArgs refuses an incomplete invocation", () => {
  assert.throws(() => buildExecArgs({ containerName: "a" }), /requires containerName and command/);
  assert.throws(() => buildExecArgs({ command: "true" }), /requires containerName and command/);
});
