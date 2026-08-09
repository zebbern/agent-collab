// Docker argv construction for discovery runs.
//
// Pure builders, kept separate from execution so the shapes that carry the
// safety properties are unit-testable and cannot drift silently. Every
// constraint below traces to something that actually happened during corpus
// hardening rather than to caution in the abstract:
//
//   - resource caps: three of six scouts wedged Docker or WSL, one taking the
//     whole Docker Desktop VM down for ~15 minutes with a jest run that forked
//     until the host died;
//   - container-native storage: one task measured phantom timeouts on a bind
//     mount (10+ minutes versus 20 seconds) and another silently benchmarked
//     the wrong tree after a CRLF-aborted checkout on a Windows-hosted mount;
//   - --internal network: an agent with any egress reaches the advisory
//     database and the benchmark measures retrieval instead of discovery.
import path from "node:path";

/** Docker wants //c/Users/... for a Windows path on this host. */
export function toDockerMountPath(hostPath) {
  return String(hostPath).replace(/\\/g, "/").replace(/^([A-Za-z]):/, (_, drive) => `//${drive.toLowerCase()}`);
}

/**
 * Hard caps for any container the bench starts. A wedged container is a lost
 * run; a wedged HOST is a lost day, and that has happened.
 */
export const DEFAULT_LIMITS = Object.freeze({
  memory: "6g",
  cpus: "2",
  pidsLimit: 512
});

function limitArgs(overrides = {}) {
  // `??` per field, not an object spread: spreading an override object whose
  // keys are present-but-undefined replaces the defaults with undefined, and
  // the container then ships `--memory undefined`. Caught by its own test.
  const memory = overrides?.memory ?? DEFAULT_LIMITS.memory;
  const cpus = overrides?.cpus ?? DEFAULT_LIMITS.cpus;
  const pidsLimit = overrides?.pidsLimit ?? DEFAULT_LIMITS.pidsLimit;
  return ["--memory", String(memory), "--cpus", String(cpus), "--pids-limit", String(pidsLimit)];
}

function envArgs(env = {}) {
  return Object.entries(env).flatMap(([key, value]) => ["-e", `${key}=${value}`]);
}

/**
 * The sealed network pair. `internal` has no route off it at all — that is the
 * actual boundary, not the proxy env vars, which an agent could ignore with
 * `curl --noproxy '*'`. `external` exists only so the proxy can reach out.
 */
export function buildNetworkCreateArgs({ internal, external }) {
  return [
    { name: internal, args: ["network", "create", "--internal", internal] },
    { name: external, args: ["network", "create", external] }
  ];
}

/**
 * The agent's container: attached ONLY to the sealed network, resource-capped,
 * and pointed at the proxy for the one host it is allowed to reach.
 *
 * The tree is COPIED in rather than bind-mounted (see `copySpec`): a bind mount
 * both measured pathologically slow and let host filesystem semantics — line
 * endings, permission bits — leak into the tree the agent audits.
 */
export function buildAgentRunArgs({
  image,
  containerName,
  internalNetwork,
  proxyHost,
  proxyPort = 8888,
  workdir = "/work",
  env = {},
  limits
}) {
  if (!image) {
    throw new Error("buildAgentRunArgs requires an image");
  }
  if (!internalNetwork) {
    throw new Error("buildAgentRunArgs requires internalNetwork — an unsealed agent measures retrieval, not discovery");
  }
  const proxyUrl = `http://${proxyHost}:${proxyPort}`;
  return [
    "run", "-d",
    "--name", containerName,
    "--network", internalNetwork,
    ...limitArgs(limits),
    "-w", workdir,
    // Set for tools that honour it. NOT the control: the sealed network is.
    ...envArgs({ HTTP_PROXY: proxyUrl, HTTPS_PROXY: proxyUrl, http_proxy: proxyUrl, https_proxy: proxyUrl, ...env }),
    image,
    "sleep", "infinity"
  ];
}

/**
 * Copy a prepared tree INTO a container. `docker cp` avoids the bind-mount
 * pathologies above, and the tar form preserves the Linux permission bits a
 * Windows-hosted checkout would otherwise flatten to 0755 — a visible
 * repackaging tell that would hint to the agent that the tree was prepared.
 */
export function buildTreeCopySpec({ containerName, hostTarball, workdir = "/work" }) {
  return {
    mkdir: ["exec", containerName, "mkdir", "-p", workdir],
    copy: ["cp", toDockerMountPath(hostTarball), `${containerName}:${path.posix.join(workdir, "tree.tar")}`],
    extract: ["exec", "-w", workdir, containerName, "tar", "-xf", "tree.tar"],
    cleanup: ["exec", "-w", workdir, containerName, "rm", "-f", "tree.tar"]
  };
}

/**
 * Run one command inside an already-started container, with a wall-clock cap
 * enforced by the caller's spawn timeout.
 */
export function buildExecArgs({ containerName, command, workdir = "/work", env = {}, user }) {
  if (!containerName || !command) {
    throw new Error("buildExecArgs requires containerName and command");
  }
  return [
    "exec",
    ...(user ? ["-u", user] : []),
    "-w", workdir,
    ...envArgs(env),
    containerName,
    "sh", "-lc", command
  ];
}

/**
 * Applying a leg's patch. `--check` first so a patch that does not apply is a
 * loud harness failure rather than a leg that silently stays at the parent —
 * a mis-applied patch produces the parent measured twice, and every number
 * downstream then looks like a clean result.
 */
export function buildApplyLegSpec({ containerName, patchPathInContainer, workdir = "/work" }) {
  return {
    check: buildExecArgs({
      containerName,
      workdir,
      command: `git apply --check ${patchPathInContainer} || patch -p1 --dry-run < ${patchPathInContainer}`
    }),
    apply: buildExecArgs({
      containerName,
      workdir,
      command: `git apply ${patchPathInContainer} || patch -p1 < ${patchPathInContainer}`
    })
  };
}

/** Teardown. Networks outlive containers, so both are named for removal. */
export function buildTeardownArgs({ containers = [], networks = [] }) {
  return [
    ...containers.map((name) => ["rm", "-f", name]),
    ...networks.map((name) => ["network", "rm", name])
  ];
}
