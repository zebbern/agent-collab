// Structural pins for the cursor plugin's skills and rescue trio, mirroring
// the discipline the codex plugin's command tests apply: the rescue command
// must route through the Agent tool without Skill() recursion, the subagent
// must stay a thin forwarder, and the skills must keep their key contracts.
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const PLUGIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "plugins", "cursor");

function read(relative) {
  return fs.readFileSync(path.join(PLUGIN, relative), "utf8");
}

test("cursor rescue command routes through the Agent tool without Skill recursion", () => {
  const rescue = read("commands/rescue.md");
  assert.match(rescue, /subagent_type: "cursor:cursor-rescue"/);
  assert.match(rescue, /do not call `Skill\(cursor:cursor-rescue\)`/i);
  assert.doesNotMatch(rescue, /^context:\s*fork\b/m);
  assert.match(rescue, /allowed-tools:\s*Bash\(node:\*\),\s*AskUserQuestion,\s*Agent/);
  assert.match(rescue, /The final user-visible response must be Cursor's output verbatim/i);
  assert.match(rescue, /there is no resume-last shortcut/i);
});

test("cursor task and rescue argument hints advertise --profile", () => {
  const task = read("commands/task.md");
  const rescue = read("commands/rescue.md");
  assert.match(task, /argument-hint:.*--profile deep\|fast/);
  assert.match(rescue, /argument-hint:.*--profile deep\|fast/);
  assert.match(task, /An explicit `--model` overrides the profile's model/i);
  assert.match(task, /There is no `--effort` flag/);
});

test("cursor help advertises profiles on task only", () => {
  const companion = read("scripts/cursor-companion.mjs");
  const taskLine = companion.split("\n").find((line) => /companion\.mjs task \[/.test(line));
  assert.ok(taskLine, "expected a task usage line in printUsage()");
  assert.match(taskLine, /--profile <deep\|fast>/);

  const reviewLines = companion
    .split("\n")
    .filter((line) => /companion\.mjs (adversarial-)?review \[/.test(line));
  assert.ok(reviewLines.length >= 2, "expected review and adversarial-review usage lines");
  for (const line of reviewLines) {
    assert.doesNotMatch(line, /--profile/);
  }
});

test("cursor rescue agent is a thin forwarder with the right skills", () => {
  const agent = read("agents/cursor-rescue.md");
  assert.match(agent, /^name: cursor-rescue$/m);
  assert.match(agent, /^tools: Bash$/m);
  assert.match(agent, /cursor-cli-runtime/);
  assert.match(agent, /cursor-prompting/);
  assert.match(agent, /Return the stdout of the `cursor-companion` command exactly as-is/i);
  assert.doesNotMatch(agent, /--effort <|--resume-last/);
  // --profile is a runtime control, passed through and stripped from the
  // forwarded task text, mirroring the existing --model handling.
  assert.match(agent, /--profile <name>.*runtime controls|runtime controls[\s\S]*--profile <name>/);
  assert.match(agent, /pass \`--profile <name>\` through to \`task\` unchanged and strip it from the task text/i);
  assert.match(agent, /There is no `--effort` flag/);
});

test("cursor runtime skill keeps the forwarder contract", () => {
  const runtime = read("skills/cursor-cli-runtime/SKILL.md");
  assert.match(runtime, /^name: cursor-cli-runtime$/m);
  assert.match(runtime, /user-invocable: false/);
  assert.match(runtime, /cursor-companion\.mjs" task/);
  assert.match(runtime, /Do not call `setup`, `review`, `adversarial-review`, `status`, `result`, or `cancel`/);
  assert.match(runtime, /Return the stdout of the `task` command exactly as-is/i);
  assert.match(runtime, /There is no `--effort` flag/);
  // --profile is a runtime control passed through to `task` and stripped
  // from the task text, mirroring the existing --model handling.
  assert.match(runtime, /includes `--profile <deep\|fast>`, pass it through to `task` and strip it from the task text/i);
});

test("cursor result-handling skill forbids auto-applying review fixes", () => {
  const handling = read("skills/cursor-result-handling/SKILL.md");
  assert.match(handling, /^name: cursor-result-handling$/m);
  assert.match(handling, /user-invocable: false/);
  assert.match(handling, /CRITICAL: After presenting review findings, STOP/);
  assert.match(handling, /cursor-agent --resume <chat-id>/);
  assert.match(handling, /direct the user to `\/cursor:setup`/i);
});

test("cursor delegation skill drives ambient delegation with disclosure and the wait loop", () => {
  const delegation = read("skills/cursor-delegation/SKILL.md");
  assert.match(delegation, /^name: cursor-delegation$/m);
  // The description must trigger on task shape, not on a command name.
  assert.match(delegation, /Use when a coding task would benefit from delegating work to Cursor in the background/);
  assert.match(delegation, /without the user typing \/cursor:\* commands/);
  assert.match(delegation, /task --background \[--write\] \[--profile deep\|fast\] \[--model <model>\] "<prompt>"/);
  assert.match(delegation, /started in the background as <jobId>/);
  assert.match(delegation, /status <jobId> --wait --timeout-ms 1800000 --json/);
  assert.match(delegation, /run_in_background:\s*true/);
  assert.match(delegation, /If `waitTimedOut` is true and the job is still active, re-issue the same wait/i);
  assert.match(delegation, /Announce every delegation in one short line/i);
  assert.match(delegation, /Never silently spawn CLI work/i);
  assert.match(delegation, /one delegated job of a class at a time/i);
  assert.match(delegation, /review findings are never auto-applied/i);
  assert.match(delegation, /Never substitute Claude-authored output as the delegate's/i);
  // Cursor has no effort tiers — the skill must say so and never offer the flag.
  assert.match(delegation, /There is no `--effort` flag/);
  assert.doesNotMatch(delegation, /--effort </);
  // Reviews have no companion-side enqueue (handleReviewCommand always runs
  // foreground) — the skill must teach the one-step background Bash flow, not
  // a jobId wait loop that only task enqueue provides.
  assert.match(delegation, /loop is for `task` only/);
  assert.match(delegation, /no companion-side enqueue/);
  assert.match(delegation, /always runs the review in the foreground/);
  assert.match(delegation, /the wake IS the collect step/);
  assert.doesNotMatch(delegation, /review --background/);
});

test("cursor prompting skill grounds model selection in the live roster", () => {
  const prompting = read("skills/cursor-prompting/SKILL.md");
  assert.match(prompting, /^name: cursor-prompting$/m);
  assert.match(prompting, /user-invocable: false/);
  assert.match(prompting, /`auto`/);
  assert.match(prompting, /cursor-agent --list-models/);
  // The skill must not claim reviews are sandboxed — Cursor has no enforced
  // read-only mode under --trust; pin the honest wording so it cannot rot back.
  assert.match(prompting, /no enforced read-only sandbox/i);
  assert.doesNotMatch(prompting, /Reviews run read-only/i);
});
