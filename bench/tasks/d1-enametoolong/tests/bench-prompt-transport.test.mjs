// Bench ground truth for D1 (enametoolong). Behavior-level: any transport
// that keeps the prompt off argv (stdin, a prompt-file handoff, etc.) passes.
//
// Archaeology (read at the parent, 8a6ea75): runCursorTurn builds
// `agentArgs = ["-p", prompt, "--output-format", "stream-json"]` -- the
// prompt rides as ONE argv token -- and spawns
// `spawn(line.file, line.args, { shell: false, ... })` directly (native
// transport, since CURSOR_COMPANION_TEST_BINARY forces transport="native"
// even on win32). `child.stdin.end()` is called with no argument, so stdin
// carries nothing. On Windows, node/libuv's CreateProcess command-line
// assembly fails with ENAMETOOLONG once the joined argv exceeds the ~32K
// character limit -- this reproduces the exact symptom, independent of WSL.
//
// RED at the parent, on both platforms:
//   - Windows: the 64KB prompt-as-argv-token blows the OS command-line
//     limit, spawn fails, and the outer cursor-companion.mjs process exits
//     nonzero -- `assert.equal(result.status, 0)` fails outright.
//   - Linux (no OS argv-length problem at this size): the fixture's channel
//     (a) finds stdin empty (nothing was written to it), channel (b) finds
//     no argv token that is an existing marker-bearing file (the prompt
//     text itself isn't a file), so it falls through to channel (c) -- the
//     parent-era positional recovery -- which DOES successfully recover the
//     prompt (the integrity assertions on length/marker-count would pass).
//     But the "no raw argv token contains the marker" assertion still fails,
//     because that recovered token *is* the raw prompt text carrying the
//     marker. Red either way, for different reasons.
//
// GREEN at the fix (9619ebe): agentArgs drops the prompt token entirely and
// `child.stdin.end(prompt)` carries it instead -- channel (a) recovers it,
// argv never carries the marker.
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { initGitRepo, makeTempDir, run } from "./helpers.mjs";
import { buildBenchCursorEnv, installBenchCursorAgent, BENCH_ENAMETOOLONG_MARKER } from "./fake-cursor-agent-bench-fixture.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "plugins", "cursor", "scripts", "cursor-companion.mjs");

process.env.CLAUDE_PLUGIN_DATA = makeTempDir("codex-plugin-bench-d1-");
for (const name of [
  "CODEX_COMPANION_SESSION_ID",
  "CURSOR_COMPANION_SESSION_ID",
  "CODEX_COMPANION_TRANSCRIPT_PATH",
  "CURSOR_COMPANION_TRANSCRIPT_PATH"
]) {
  delete process.env[name];
}

test("a large task prompt survives the prompt-file transport without leaking into argv", () => {
  const repo = makeTempDir("codex-plugin-bench-d1-repo-");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const binDir = makeTempDir("codex-plugin-bench-d1-bin-");
  installBenchCursorAgent(binDir);

  // 64KB body, bracketed by the marker on both ends -- comfortably past any
  // OS argv limit and easy to spot inside recorded argv tokens.
  const body = "x".repeat(64 * 1024);
  const prompt = `${BENCH_ENAMETOOLONG_MARKER}\n${body}\n${BENCH_ENAMETOOLONG_MARKER}`;

  const promptDir = makeTempDir("codex-plugin-bench-d1-prompt-");
  const promptFile = path.join(promptDir, "prompt.txt");
  fs.writeFileSync(promptFile, prompt, "utf8");

  const env = {
    ...buildBenchCursorEnv(binDir),
    CURSOR_COMPANION_TEST_BINARY: path.join(binDir, "cursor-agent.mjs")
  };

  const result = run("node", [SCRIPT, "task", "--prompt-file", promptFile], {
    cwd: repo,
    env
  });

  assert.equal(result.status, 0, result.stderr);

  const statePath = path.join(binDir, "fake-cursor-bench-state.json");
  const fakeState = JSON.parse(fs.readFileSync(statePath, "utf8"));

  assert.equal(fakeState.lastPrompt.length, prompt.length);
  const markerCount = (fakeState.lastPrompt.match(new RegExp(BENCH_ENAMETOOLONG_MARKER, "g")) || []).length;
  assert.equal(markerCount, 2);

  for (const token of fakeState.lastArgs) {
    assert.doesNotMatch(String(token), new RegExp(BENCH_ENAMETOOLONG_MARKER));
  }
});
