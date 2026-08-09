// The execution witness: proof that a scored PoC actually ENTERED the
// vulnerable code, rather than reading the tree and guessing.
//
// This is the discovery bench's second, independent gate. The first (paired
// legs) is semantic: no static signal separates a location's flaw-live leg from
// its flaw-closed twin. This one is dynamic, and it is what makes the whole
// class of static oracles irrelevant — across five rounds of adversarial
// hardening, 19 oracles were built against one task, 18 against another and 14
// against a third, and EVERY one of them reads files and exits without ever
// executing the target. Coverage kills all of them at once, however
// sophisticated the analysis becomes.
//
// TWO-PHASE CONTRACT, and the ordering is a security property:
//
//   Phase 1 — run the agent's PoC under instrumentation. Its stdout is
//             captured for the exit code and the artifacts, and is NEVER read
//             for coverage. The PoC is attacker-controlled; if it could print
//             its own coverage verdict it would simply claim one.
//   Phase 2 — run the task's bench-owned witness command, which reads the
//             coverage artifact and emits `COVERED <target>` lines. ONLY this
//             output decides coverage.
//
// Residual risk, recorded rather than hidden: the PoC and the reporter share a
// filesystem, so a PoC that knows the artifact path could forge it. Mitigation
// is to place the artifact outside the tree the PoC is given and to name it at
// run time. That narrows the hole; it does not close it. A PoC elaborate enough
// to forge a language-specific coverage artifact has done more work than
// finding the bug would have taken.

/** Emitted by a witness command that could not gather coverage at all. */
const UNAVAILABLE = /^WITNESS-UNAVAILABLE\s+(.*)$/m;
const COVERED_LINE = /^COVERED\s+(.+?)\s*$/gm;

/**
 * Parse a witness command's report against the manifest's mustCover list.
 *
 * A witness that cannot run is `unavailable` — a HARNESS failure, never a
 * verdict against the agent. A witness that runs and reports nothing covered
 * is a real negative: the submission never touched the vulnerable code.
 *
 * @param {{stdout?: string, exitCode?: number|null, error?: string|null}} report
 * @param {string[]} mustCover
 */
export function parseWitnessReport(report, mustCover) {
  const targets = Array.isArray(mustCover) ? mustCover.filter((t) => typeof t === "string" && t.length > 0) : [];
  if (targets.length === 0) {
    // The manifest validator already refuses this; treating it as "covered"
    // here would let a schema regression silently disable the gate.
    return { covered: false, missing: [], unavailable: "the task declares no mustCover targets" };
  }

  if (report?.error) {
    return { covered: false, missing: targets, unavailable: `witness command failed to run: ${report.error}` };
  }

  const stdout = typeof report?.stdout === "string" ? report.stdout : "";
  const declaredUnavailable = stdout.match(UNAVAILABLE);
  if (declaredUnavailable) {
    return { covered: false, missing: targets, unavailable: declaredUnavailable[1].trim() || "reported unavailable" };
  }

  // A non-zero exit with no COVERED lines means the tooling broke; a non-zero
  // exit that still reported coverage is tolerated, because some coverage
  // tools exit non-zero on thresholds they were never asked about.
  const found = new Set();
  for (const match of stdout.matchAll(COVERED_LINE)) {
    found.add(match[1].trim());
  }
  if (found.size === 0 && report?.exitCode !== 0) {
    return {
      covered: false,
      missing: targets,
      unavailable: `witness command exited ${report?.exitCode} without reporting coverage`
    };
  }

  const missing = targets.filter((target) => !found.has(target));
  return { covered: missing.length === 0, missing, covering: [...found] };
}

/**
 * Build the two-phase plan for one leg. Kept as data so a caller cannot
 * accidentally collapse the phases — reading coverage out of the PoC's own
 * stdout would hand the gate to the thing it is gating.
 */
export function buildWitnessPlan({ poc, witness, artifactPath }) {
  if (!poc?.entryPath) {
    throw new Error("buildWitnessPlan requires poc.entryPath");
  }
  if (!witness?.command) {
    throw new Error("buildWitnessPlan requires witness.command");
  }
  return {
    phases: [
      {
        name: "poc",
        command: poc.entryPath,
        capturesCoverage: true,
        // Explicit, because it is the security property: this output decides
        // the leg's exit code and nothing else.
        stdoutUsedFor: "exit-code-and-artifacts"
      },
      {
        name: "witness",
        command: witness.command,
        capturesCoverage: false,
        stdoutUsedFor: "coverage-report"
      }
    ],
    artifactPath,
    mustCover: witness.mustCover ?? []
  };
}
