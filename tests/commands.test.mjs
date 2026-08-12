import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_ROOT = path.join(ROOT, "plugins", "codex");

function read(relativePath) {
  return fs.readFileSync(path.join(PLUGIN_ROOT, relativePath), "utf8");
}

test("review command uses AskUserQuestion and background Bash while staying review-only", () => {
  const source = read("commands/review.md");
  assert.match(source, /AskUserQuestion/);
  assert.match(source, /\bBash\(/);
  assert.match(source, /Do not fix issues/i);
  assert.match(source, /review-only/i);
  assert.match(source, /return Codex's output verbatim to the user/i);
  assert.match(source, /```bash/);
  assert.match(source, /```typescript/);
  assert.match(source, /review "\$ARGUMENTS"/);
  assert.match(source, /\[--scope auto\|working-tree\|branch\]/);
  assert.match(source, /run_in_background:\s*true/);
  assert.match(source, /command:\s*`node "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/codex-companion\.mjs" review "\$ARGUMENTS"`/);
  assert.match(source, /description:\s*"Codex review"/);
  assert.match(source, /Do not call `BashOutput`/);
  assert.match(source, /Return the command stdout verbatim, exactly as-is/i);
  assert.match(source, /git status --short --untracked-files=all/);
  assert.match(source, /git diff --shortstat/);
  assert.match(source, /Treat untracked files or directories as reviewable work/i);
  assert.match(source, /Recommend waiting only when the review is clearly tiny, roughly 1-2 files total/i);
  assert.match(source, /In every other case, including unclear size, recommend background/i);
  assert.match(source, /The companion script parses `--wait` and `--background`/i);
  assert.match(source, /Claude Code's `Bash\(..., run_in_background: true\)` is what actually detaches the run/i);
  assert.match(source, /When in doubt, run the review/i);
  assert.match(source, /\(Recommended\)/);
  assert.match(source, /does not support staged-only review, unstaged-only review, or extra focus text/i);
});

test("adversarial review command uses AskUserQuestion and background Bash while staying review-only", () => {
  const source = read("commands/adversarial-review.md");
  assert.match(source, /AskUserQuestion/);
  assert.match(source, /\bBash\(/);
  assert.match(source, /Do not fix issues/i);
  assert.match(source, /review-only/i);
  assert.match(source, /return Codex's output verbatim to the user/i);
  assert.match(source, /```bash/);
  assert.match(source, /```typescript/);
  assert.match(source, /adversarial-review "\$ARGUMENTS"/);
  assert.match(source, /\[--scope auto\|working-tree\|branch\] \[focus \.\.\.\]/);
  assert.match(source, /run_in_background:\s*true/);
  assert.match(source, /command:\s*`node "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/codex-companion\.mjs" adversarial-review "\$ARGUMENTS"`/);
  assert.match(source, /description:\s*"Codex adversarial review"/);
  assert.match(source, /Do not call `BashOutput`/);
  assert.match(source, /Return the command stdout verbatim, exactly as-is/i);
  assert.match(source, /git status --short --untracked-files=all/);
  assert.match(source, /git diff --shortstat/);
  assert.match(source, /Treat untracked files or directories as reviewable work/i);
  assert.match(source, /Recommend waiting only when the scoped review is clearly tiny, roughly 1-2 files total/i);
  assert.match(source, /In every other case, including unclear size, recommend background/i);
  assert.match(source, /The companion script parses `--wait` and `--background`/i);
  assert.match(source, /Claude Code's `Bash\(..., run_in_background: true\)` is what actually detaches the run/i);
  assert.match(source, /When in doubt, run the review/i);
  assert.match(source, /\(Recommended\)/);
  assert.match(source, /uses the same review target selection as `\/codex:review`/i);
  assert.match(source, /supports working-tree review, branch review, and `--base <ref>`/i);
  assert.match(source, /does not support `--scope staged` or `--scope unstaged`/i);
  assert.match(source, /can still take extra focus text after the flags/i);
});

test("continue is not exposed as a user-facing command", () => {
  const commandFiles = fs.readdirSync(path.join(PLUGIN_ROOT, "commands")).sort();
  assert.deepEqual(commandFiles, [
    "adversarial-review.md",
    "cancel.md",
    "doctor.md",
    "help.md",
    "rescue.md",
    "result.md",
    "review.md",
    "setup.md",
    "status.md",
    "transfer.md"
  ]);
});

test("help command runs the companion help inline and returns it verbatim", () => {
  const source = read("commands/help.md");
  assert.match(source, /disable-model-invocation:\s*true/);
  assert.match(source, /allowed-tools: Bash\(node:\*\)/);
  assert.match(source, /!`node "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/codex-companion\.mjs" help`/);
  assert.match(source, /Present the full command output to the user exactly as returned/i);
  assert.match(source, /Do not summarize or condense it/i);
});

test("companion help and --help document every subcommand and the real flags", () => {
  const script = path.join(PLUGIN_ROOT, "scripts", "codex-companion.mjs");
  for (const args of [["help"], ["--help"]]) {
    const result = spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /\bsetup \[--enable-review-gate\|--disable-review-gate\] \[--json\]/);
    assert.match(result.stdout, /\breview \[--wait\|--background\] \[--base <ref>\] \[--scope <auto\|working-tree\|branch>\] \[--model <model>\] \[--json\]/);
    assert.match(result.stdout, /\badversarial-review .* \[focus text\]/);
    assert.match(result.stdout, /\btask .*--resume-last\|--resume\|--fresh/);
    assert.match(result.stdout, /\btask .*--profile <deep\|fast>/);
    assert.match(result.stdout, /\btask .*--model <model\|spark>/);
    assert.match(result.stdout, /\btask .*--effort <none\|minimal\|low\|medium\|high\|xhigh\|max>/);
    assert.match(result.stdout, /\btask .*--prompt-file <path>/);
    assert.match(result.stdout, /--profile fast uses gpt-5\.3-codex-spark at medium effort/i);
    // Profiles are task/rescue only: the review usage line must not advertise --profile.
    const reviewUsageLine = result.stdout
      .split("\n")
      .find((line) => /\breview \[--wait\|--background\]/.test(line));
    assert.ok(reviewUsageLine, "expected a review usage line");
    assert.doesNotMatch(reviewUsageLine, /--profile/);
    assert.match(result.stdout, /\bstatus \[job-id\] \[--wait\] \[--timeout-ms <ms>\] \[--poll-interval-ms <ms>\] \[--all\] \[--json\]/);
    assert.match(result.stdout, /\bresult \[job-id\] \[--json\]/);
    assert.match(result.stdout, /\bcancel \[job-id\] \[--json\]/);
    assert.match(result.stdout, /\btransfer \[--source <claude-jsonl>\] \[--json\]/);
    assert.match(result.stdout, /\btask-resume-candidate \[--json\]/);
    assert.match(result.stdout, /\btask-worker --job-id <id>/);
  }
});

test("rescue command absorbs continue semantics", () => {
  const rescue = read("commands/rescue.md");
  const agent = read("agents/codex-rescue.md");
  const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
  const runtimeSkill = read("skills/codex-cli-runtime/SKILL.md");

  assert.match(rescue, /The final user-visible response must be Codex's output verbatim/i);
  assert.match(rescue, /allowed-tools:\s*Bash\(node:\*\),\s*AskUserQuestion,\s*Agent/);
  // Regression for #234: `Skill(codex:rescue)` from the main agent recursed
  // because rescue.md named the routing with ambiguous prose ("Route this
  // request to the `codex:codex-rescue` subagent") while running under
  // `context: fork` — forked general-purpose subagents do not expose the
  // `Agent` tool, so the fork fell back to `Skill` and re-entered this
  // command. Pin the explicit transport and the inline (no-fork) execution.
  assert.match(rescue, /subagent_type: "codex:codex-rescue"/);
  assert.match(rescue, /do not call `Skill\(codex:codex-rescue\)`/i);
  assert.doesNotMatch(rescue, /^context:\s*fork\b/m);
  assert.match(rescue, /--background\|--wait/);
  assert.match(rescue, /--resume\|--fresh/);
  assert.match(rescue, /--profile <deep\|fast>/);
  assert.match(rescue, /--model <model\|spark>/);
  assert.match(rescue, /--effort <none\|minimal\|low\|medium\|high\|xhigh\|max>/);
  assert.match(rescue, /task-resume-candidate --json/);
  assert.match(rescue, /AskUserQuestion/);
  assert.match(rescue, /Continue current Codex thread/);
  assert.match(rescue, /Start a new Codex thread/);
  assert.match(rescue, /run the `codex:codex-rescue` subagent in the background/i);
  assert.match(rescue, /default to foreground/i);
  assert.match(rescue, /Do not forward them to `task`/i);
  assert.match(rescue, /`--model` and `--effort` are runtime-selection flags/i);
  assert.match(rescue, /Leave `--effort` unset unless the user explicitly asks for a specific reasoning effort/i);
  assert.match(rescue, /If they ask for `spark`, map it to `gpt-5\.3-codex-spark`/i);
  assert.match(rescue, /`--profile <deep\|fast>` is also a runtime-selection flag/i);
  assert.match(rescue, /Preserve it for the forwarded `task` call, but do not treat it as part of the natural-language task text/i);
  assert.match(rescue, /an explicit `--model` or `--effort` on the same request overrides the profile's default for that field/i);
  assert.match(rescue, /If the request includes `--resume`, do not ask whether to continue/i);
  assert.match(rescue, /If the request includes `--fresh`, do not ask whether to continue/i);
  assert.match(rescue, /If the user chooses continue, add `--resume`/i);
  assert.match(rescue, /If the user chooses a new thread, add `--fresh`/i);
  assert.match(rescue, /thin forwarder only/i);
  assert.match(rescue, /Return the Codex companion stdout verbatim to the user/i);
  assert.match(rescue, /Do not paraphrase, summarize, rewrite, or add commentary before or after it/i);
  assert.match(rescue, /return that command's stdout as-is/i);
  assert.match(rescue, /Leave `--resume` and `--fresh` in the forwarded request/i);
  assert.match(agent, /--resume/);
  assert.match(agent, /--fresh/);
  assert.match(agent, /thin forwarding wrapper/i);
  assert.match(agent, /prefer foreground for a small, clearly bounded rescue request/i);
  assert.match(agent, /If the user did not explicitly choose `--background` or `--wait` and the task looks complicated, open-ended, multi-step, or likely to keep Codex running for a long time, prefer background execution/i);
  assert.match(agent, /Use exactly one `Bash` call/i);
  assert.match(agent, /Do not inspect the repository, read files, grep, monitor progress, poll status, fetch results, cancel jobs, summarize output, or do any follow-up work of your own/i);
  assert.match(agent, /Do not call `review`, `adversarial-review`, `status`, `result`, or `cancel`/i);
  assert.match(agent, /Leave `--effort` unset unless the user explicitly requests a specific reasoning effort/i);
  assert.match(agent, /Leave model unset by default/i);
  assert.match(agent, /If the user asks for `spark`, map that to `--model gpt-5\.3-codex-spark`/i);
  assert.match(agent, /If the user asks for a concrete model name such as `gpt-5\.4-mini`, pass it through with `--model`/i);
  assert.match(agent, /Leave `--profile` unset by default/i);
  assert.match(agent, /Only add `--profile <deep\|fast>` when the user explicitly asks for that named profile/i);
  assert.match(agent, /Return the stdout of the `codex-companion` command exactly as-is/i);
  assert.match(agent, /If the Bash call fails or Codex cannot be invoked, return nothing/i);
  assert.match(agent, /gpt-5-4-prompting/);
  assert.match(agent, /only to tighten the user's request into a better Codex prompt/i);
  assert.match(agent, /Do not use that skill to inspect the repository, reason through the problem yourself, draft a solution, or do any independent work/i);
  assert.match(runtimeSkill, /only job is to invoke `task` once and return that stdout unchanged/i);
  assert.match(runtimeSkill, /Do not call `setup`, `review`, `adversarial-review`, `status`, `result`, or `cancel`/i);
  assert.match(runtimeSkill, /use the `gpt-5-4-prompting` skill to rewrite the user's request into a tighter Codex prompt/i);
  assert.match(runtimeSkill, /That prompt drafting is the only Claude-side work allowed/i);
  assert.match(runtimeSkill, /Leave `--effort` unset unless the user explicitly requests a specific effort/i);
  assert.match(runtimeSkill, /Leave model unset by default/i);
  assert.match(runtimeSkill, /Map `spark` to `--model gpt-5\.3-codex-spark`/i);
  assert.match(runtimeSkill, /If the forwarded request includes `--background` or `--wait`, treat that as Claude-side execution control only/i);
  assert.match(runtimeSkill, /Strip it before calling `task`/i);
  assert.match(runtimeSkill, /`--effort`: accepted values are `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`/i);
  assert.match(runtimeSkill, /`--profile`: accepted values are `deep`, `fast`\. Only supported on `task`; `review` and `adversarial-review` reject it/i);
  assert.match(runtimeSkill, /If the forwarded request includes `--profile <deep\|fast>`, strip it from the task text and pass it through to `task` unchanged/i);
  assert.match(runtimeSkill, /Do not inspect the repository, read files, grep, monitor progress, poll status, fetch results, cancel jobs, summarize output, or do any follow-up work of your own/i);
  assert.match(runtimeSkill, /If the Bash call fails or Codex cannot be invoked, return nothing/i);
  assert.match(readme, /`codex:codex-rescue` subagent/i);
  assert.match(readme, /if you do not pass `--model` or `--effort`, Codex chooses its own defaults/i);
  assert.match(readme, /--model gpt-5\.4-mini --effort medium/i);
  assert.match(readme, /`spark`, the plugin maps that to `gpt-5\.3-codex-spark`/i);
  assert.match(readme, /--profile <deep\|fast>/);
  assert.match(readme, /\| `deep` \| `gpt-5\.6-sol` \| `xhigh` \|/);
  assert.match(readme, /\| `fast` \| `gpt-5\.3-codex-spark`.*\| `medium` \|/);
  assert.match(readme, /`--profile` supplies the defaults; an explicit `--model` on the same invocation overrides the profile's model, and an explicit `--effort` overrides the profile's effort/i);
  assert.match(readme, /No `--profile` and no explicit flags behaves exactly as before: Codex's own defaults apply/i);
  assert.match(readme, /`review` and `adversarial-review` reject `--profile`/i);
  assert.match(readme, /continue a previous Codex task/i);
  assert.match(readme, /### `\/codex:setup`/);
  assert.match(readme, /### `\/codex:review`/);
  assert.match(readme, /### `\/codex:adversarial-review`/);
  assert.match(readme, /uses the same review target selection as `\/codex:review`/i);
  assert.match(readme, /--base main challenge whether this was the right caching and retry design/);
  assert.match(readme, /### `\/codex:rescue`/);
  assert.match(readme, /### `\/codex:transfer`/);
  assert.match(readme, /### `\/codex:status`/);
  assert.match(readme, /### `\/codex:result`/);
  assert.match(readme, /### `\/codex:cancel`/);
});

test("transfer, result, and cancel commands are exposed as deterministic runtime entrypoints", () => {
  const transfer = read("commands/transfer.md");
  const result = read("commands/result.md");
  const cancel = read("commands/cancel.md");
  const resultHandling = read("skills/codex-result-handling/SKILL.md");

  assert.match(transfer, /disable-model-invocation:\s*true/);
  assert.match(transfer, /codex-companion\.mjs" transfer "\$ARGUMENTS"/);
  assert.match(transfer, /codex resume <session-id>/);
  assert.match(result, /disable-model-invocation:\s*true/);
  assert.match(result, /codex-companion\.mjs" result "\$ARGUMENTS"/);
  assert.match(cancel, /disable-model-invocation:\s*true/);
  assert.match(cancel, /codex-companion\.mjs" cancel "\$ARGUMENTS"/);
  assert.match(resultHandling, /do not turn a failed or incomplete Codex run into a Claude-side implementation attempt/i);
  assert.match(resultHandling, /if Codex was never successfully invoked, do not generate a substitute answer at all/i);
});

test("internal docs use task terminology for rescue runs", () => {
  const runtimeSkill = read("skills/codex-cli-runtime/SKILL.md");
  const promptingSkill = read("skills/gpt-5-4-prompting/SKILL.md");
  const promptRecipes = read("skills/gpt-5-4-prompting/references/codex-prompt-recipes.md");

  assert.match(runtimeSkill, /codex-companion\.mjs" task "<raw arguments>"/);
  assert.match(runtimeSkill, /Use `task` for every rescue request/i);
  assert.match(runtimeSkill, /task --resume-last/i);
  assert.match(promptingSkill, /Use `task` when the task is diagnosis/i);
  assert.match(promptRecipes, /Codex task prompts/i);
  assert.match(promptRecipes, /Use these as starting templates for Codex task prompts/i);
  assert.match(promptRecipes, /## Diagnosis/);
  assert.match(promptRecipes, /## Narrow Fix/);
});

test("codex delegation skill drives ambient delegation with disclosure and the wait loop", () => {
  const delegation = read("skills/codex-delegation/SKILL.md");
  const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");

  assert.match(delegation, /^name: codex-delegation$/m);
  // The description must trigger on task shape, not on a command name.
  assert.match(delegation, /Use when a coding task would benefit from delegating work to Codex in the background/);
  assert.match(delegation, /without the user typing \/codex:\* commands/);
  assert.match(delegation, /task --background \[--write\] \[--profile <deep\|fast>\] \[--effort <tier>\] "<prompt>"/);
  assert.match(delegation, /`--profile <deep\|fast>` is accepted on `task` \(and its `rescue` forwarder\) only; `review` and `adversarial-review` reject it/i);
  assert.match(delegation, /started in the background as <jobId>/);
  assert.match(delegation, /status <jobId> --wait --timeout-ms 1800000 --json/);
  assert.match(delegation, /run_in_background:\s*true/);
  assert.match(delegation, /If `waitTimedOut` is true and the job is still active, re-issue the same wait/i);
  assert.match(delegation, /result <jobId> --json/);
  assert.match(delegation, /Announce every delegation in one short line/i);
  assert.match(delegation, /Never silently spawn CLI work/i);
  assert.match(delegation, /one delegated job of a class at a time/i);
  assert.match(delegation, /Never delegate when the user explicitly asked Claude to do the work personally/i);
  assert.match(delegation, /review findings are never auto-applied/i);
  assert.match(delegation, /Never substitute Claude-authored output as the delegate's/i);
  // Reviews have no companion-side enqueue (handleReviewCommand always runs
  // foreground) — the skill must teach the one-step background Bash flow, not
  // a jobId wait loop that only task enqueue provides.
  assert.match(delegation, /loop is for `task` only/);
  assert.match(delegation, /no companion-side enqueue/);
  assert.match(delegation, /always runs the review in the foreground/);
  assert.match(delegation, /the wake IS the collect step/);
  assert.doesNotMatch(delegation, /review --background/);
  assert.match(readme, /## Ambient delegation/);
  assert.match(readme, /`status --wait` issued as a background task closes the loop/);
});

test("hooks keep session-end cleanup and stop gating enabled", () => {
  const source = read("hooks/hooks.json");
  assert.match(source, /SessionStart/);
  assert.match(source, /SessionEnd/);
  assert.match(source, /stop-review-gate-hook\.mjs/);
  assert.match(source, /session-lifecycle-hook\.mjs/);
});

test("setup command can offer Codex install and still points users to codex login", () => {
  const setup = read("commands/setup.md");
  const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");

  assert.match(setup, /argument-hint:\s*'\[--enable-review-gate\|--disable-review-gate\]'/);
  assert.match(setup, /AskUserQuestion/);
  assert.match(setup, /npm install -g @openai\/codex/);
  assert.match(setup, /codex-companion\.mjs" setup --json \$ARGUMENTS/);
  assert.match(readme, /!codex login/);
  assert.match(readme, /offer to install Codex for you/i);
  assert.match(readme, /\/codex:setup --enable-review-gate/);
  assert.match(readme, /\/codex:setup --disable-review-gate/);
});

test("SECURITY.md cannot rot: every referenced path exists and the private reporting link is present", () => {
  const security = fs.readFileSync(path.join(ROOT, "SECURITY.md"), "utf8");
  assert.match(security, /github\.com\/zebbern\/agent-collab\/security\/advisories\/new/);

  // Every backtick-quoted repo path must resolve; `plugins/*/...` expands to
  // both plugins. This is the exact decay mode hygiene files die from.
  const references = [...security.matchAll(/`(plugins\/[^`]+\.mjs)`/g)].map((match) => match[1]);
  assert.ok(references.length >= 4, `expected several path references, got ${references.length}`);
  for (const reference of references) {
    const candidates = reference.includes("*")
      ? ["codex", "cursor"].map((plugin) => reference.replace("*", plugin))
      : [reference];
    for (const candidate of candidates) {
      assert.ok(fs.existsSync(path.join(ROOT, candidate)), `SECURITY.md references missing file: ${candidate}`);
    }
  }
});

test("the PR template checklist tracks the repo's real gates", () => {
  const template = fs.readFileSync(path.join(ROOT, ".github", "PULL_REQUEST_TEMPLATE.md"), "utf8");
  assert.match(template, /npm run verify/);
  assert.match(template, /no\s+`UNVERIFIED`\s+leg/i);
  assert.match(template, /byte-identical/);
  assert.ok(fs.existsSync(path.join(ROOT, "tests", "chassis-drift.test.mjs")));
  assert.match(template, /live-fired/);
  for (const form of ["bug.yml", "feature.yml"]) {
    assert.ok(fs.existsSync(path.join(ROOT, ".github", "ISSUE_TEMPLATE", form)), `missing issue form ${form}`);
  }
});
