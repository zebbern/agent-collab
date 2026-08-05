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

test("cursor rescue agent is a thin forwarder with the right skills", () => {
  const agent = read("agents/cursor-rescue.md");
  assert.match(agent, /^name: cursor-rescue$/m);
  assert.match(agent, /^tools: Bash$/m);
  assert.match(agent, /cursor-cli-runtime/);
  assert.match(agent, /cursor-prompting/);
  assert.match(agent, /Return the stdout of the `cursor-companion` command exactly as-is/i);
  assert.doesNotMatch(agent, /--effort <|--resume-last/);
});

test("cursor runtime skill keeps the forwarder contract", () => {
  const runtime = read("skills/cursor-cli-runtime/SKILL.md");
  assert.match(runtime, /^name: cursor-cli-runtime$/m);
  assert.match(runtime, /user-invocable: false/);
  assert.match(runtime, /cursor-companion\.mjs" task/);
  assert.match(runtime, /Do not call `setup`, `review`, `adversarial-review`, `status`, `result`, or `cancel`/);
  assert.match(runtime, /Return the stdout of the `task` command exactly as-is/i);
  assert.match(runtime, /There is no `--effort` flag/);
});

test("cursor result-handling skill forbids auto-applying review fixes", () => {
  const handling = read("skills/cursor-result-handling/SKILL.md");
  assert.match(handling, /^name: cursor-result-handling$/m);
  assert.match(handling, /user-invocable: false/);
  assert.match(handling, /CRITICAL: After presenting review findings, STOP/);
  assert.match(handling, /cursor-agent --resume <chat-id>/);
  assert.match(handling, /direct the user to `\/cursor:setup`/i);
});

test("cursor prompting skill grounds model selection in the live roster", () => {
  const prompting = read("skills/cursor-prompting/SKILL.md");
  assert.match(prompting, /^name: cursor-prompting$/m);
  assert.match(prompting, /user-invocable: false/);
  assert.match(prompting, /`auto`/);
  assert.match(prompting, /cursor-agent --list-models/);
  assert.match(prompting, /Reviews run read-only/i);
});
