// Doc and manifest pins for the goal plugin, mirroring the discipline of
// tests/cursor-skills.test.mjs: the manifests, commands, and skill carry
// contracts that must not drift silently.
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN = path.join(ROOT, "plugins", "goal");

function read(relative) {
  return fs.readFileSync(path.join(PLUGIN, relative), "utf8");
}

test("goal plugin manifest and marketplace entry agree", () => {
  const plugin = JSON.parse(read(path.join(".claude-plugin", "plugin.json")));
  assert.equal(plugin.name, "goal");
  // Agreement, not a literal: this test broke on both releases to date
  // because it pinned the version string its own name never claimed to pin.
  // bump-version --check owns coherence; here we assert the two sites agree
  // and look like a version at all.
  assert.match(plugin.version, /^\d+\.\d+\.\d+/);
  assert.match(plugin.description, /long-horizon/i);

  const marketplace = JSON.parse(
    fs.readFileSync(path.join(ROOT, ".claude-plugin", "marketplace.json"), "utf8")
  );
  const entry = marketplace.plugins.find((candidate) => candidate.name === "goal");
  assert.ok(entry, "marketplace.json has no goal entry");
  assert.equal(entry.version, plugin.version);
  assert.equal(entry.source, "./plugins/goal");
});

test("goal plugin ships license and changelog", () => {
  assert.match(read("LICENSE"), /Apache License/);
  assert.match(read("CHANGELOG.md"), /## 0\.1\.0/);
});

test("goal step command pins the one-increment choreography", () => {
  const step = read(path.join("commands", "step.md"));
  assert.match(step, /One increment per invocation/);
  assert.match(step, /Announce the increment in one line/);
  assert.match(step, /goal-companion\.mjs" next/);
  assert.match(step, /goal-companion\.mjs" start/);
  assert.match(step, /Analysis and implementation are separate delegations/);
  assert.match(step, /refine the brief with the failure evidence and re-delegate once/);
  assert.match(step, /--disposition blocked/);
  assert.match(step, /Do not start another increment/);
});

test("goal commands pin their frontmatter: user-surface only, node-only bash", () => {
  for (const command of ["set", "step", "status", "help"]) {
    const source = read(path.join("commands", `${command}.md`));
    assert.match(source, /^disable-model-invocation: true$/m, `${command}.md`);
    assert.match(source, /^allowed-tools: Bash\(node:\*\)$/m, `${command}.md`);
  }
});

test("goal-runner skill pins the policy", () => {
  const skill = read(path.join("skills", "goal-runner", "SKILL.md"));
  assert.match(skill, /^name: goal-runner$/m);
  assert.match(skill, /one increment at a time/i);
  assert.match(skill, /codex-delegation|cursor-delegation/);
  assert.match(skill, /blocked is a full stop/i);
  assert.match(skill, /Never invent progress/);
});

test("goal step command pins the unattended operation recipe", () => {
  const step = read(path.join("commands", "step.md"));
  assert.match(step, /## Unattended \(scheduled\) operation/);
  assert.match(step, /never merges PRs/);
  assert.match(step, /goal\/<slug>\/<itemId>/);
  assert.match(step, /Reconcile before stepping/i);
});

test("goal retro command pins its frontmatter and hard rules", () => {
  const retro = read(path.join("commands", "retro.md"));
  assert.match(retro, /^description: Analyze the goal ledger and propose policy improvements$/m);
  assert.match(retro, /^argument-hint: "\[slug\|--all\]"$/m);
  assert.match(retro, /^disable-model-invocation: true$/m);
  assert.match(retro, /^allowed-tools: Bash\(node:\*\)$/m);
  assert.match(retro, /goal-companion\.mjs" ledger/);
  assert.match(retro, /goal-companion\.mjs" status/);
  assert.match(retro, /never auto-applied/);
  assert.match(retro, /too thin for conclusions/);
  assert.match(retro, /[Pp]olicy artifacts only/);
  assert.match(retro, /skill wording, routing guidance, effort tiers, budgets/);
});

test("goal retro command pins the four-event ledger vocabulary and the goal-file-wins rule", () => {
  const retro = read(path.join("commands", "retro.md"));
  // The ledger's full event vocabulary, named together. \s+ rather than a
  // literal \n: this phrase wraps a line, and a Windows checkout without a
  // .gitattributes normalizer reads CRLF — a pin that spans a line break must
  // never depend on which line ending git handed it (this exact pin turned CI
  // red on 2026-08-07 while both local gate legs, reading an LF working tree,
  // stayed green).
  assert.match(retro, /`step-started`, `disposition`, `closed`, and\s+`correction`/);
  // A correction is an append-only reversal, never a rewrite.
  assert.match(retro, /never rewrites history/);
  assert.match(retro, /supersedes/);
  // Goal file is ground truth over the ledger.
  assert.match(retro, /goal file wins/i);
  assert.match(retro, /portable ground truth/);
  // closed events feed the retro's goal-level analysis.
  assert.match(retro, /Goal-level outcomes and their timing/);
  assert.match(retro, /`closed` event/);
});

test("goal retro command pins the two scopes and the method-invention mandate", () => {
  const retro = read(path.join("commands", "retro.md"));
  // Per-goal is the process retro; portfolio is the policy retro (the outer
  // loop), and the floor counts at the scope being run.
  assert.match(retro, /process retro/);
  assert.match(retro, /policy retro/);
  assert.match(retro, /the outer loop/);
  assert.match(retro, /retro --all/);
  assert.match(retro, /at the (running )?scope/);
  // Portfolio reports must expose heterogeneity and their own limits.
  assert.match(retro, /group findings by goal/);
  assert.match(retro, /per-project and per-machine/);
  // Global artifacts change on global evidence.
  assert.match(retro, /global artifacts\s+change on global evidence/i);
  // The method-invention mandate: procedures, not just parameters — riding
  // the same rails, and grounded in cited evidence.
  assert.match(retro, /Methods are policy artifacts too/);
  assert.match(retro, /invent better ways of searching/);
  assert.match(retro, /this command's own\s+analysis method/);
  assert.match(retro, /a method opinion without a citation is not/);
});

test("README documents the goal plugin", () => {
  const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
  assert.match(readme, /## Goal plugin/);
  assert.match(readme, /\[Goal plugin\]\(#goal-plugin\)/);
  assert.match(readme, /one increment at a time/);
});
