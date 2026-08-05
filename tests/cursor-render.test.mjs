// Unit tests for the cursor-specific render differences: native/wsl transport
// labels, the `cursor-agent --resume` handoff, and model-only recording
// (cursor-agent has no reasoning-effort knob, so no effort suffix ever).
import test from "node:test";
import assert from "node:assert/strict";

import {
  renderJobStatusReport,
  renderReviewResult,
  renderSetupReport,
  renderStatusReport,
  renderStoredJobResult,
  renderTaskResult
} from "../plugins/cursor/scripts/lib/render.mjs";
import { parseStructuredOutput } from "../plugins/cursor/scripts/lib/cursor.mjs";

test("parseStructuredOutput recovers JSON embedded in model narration", () => {
  // Condensed from a real live review: the model narrated (including braces
  // inside string values) before emitting the JSON object.
  const narrated =
    "I'll inspect the diff against `12b9ac8` and dig into the high-risk paths." +
    "Shell was blocked; retrying with a narrower read-only git inspection." +
    '{"verdict":"needs-attention","summary":"Do not ship: unlocked {state.json} RMW.",' +
    '"findings":[{"severity":"high","title":"Race","body":"a } inside \\"quotes\\" stays balanced.",' +
    '"file":"plugins/cursor/scripts/lib/state.mjs","line_start":174,"line_end":178}],"next_steps":["Add a failing test."]}';
  const parsed = parseStructuredOutput(narrated);
  assert.equal(parsed.parseError, null);
  assert.equal(parsed.parsed.verdict, "needs-attention");
  assert.equal(parsed.parsed.findings.length, 1);

  const clean = parseStructuredOutput('{"verdict":"approve","summary":"ok","findings":[],"next_steps":[]}');
  assert.equal(clean.parseError, null);
  assert.equal(clean.parsed.verdict, "approve");

  const hopeless = parseStructuredOutput("no json here at all");
  assert.equal(hopeless.parsed, null);
  assert.ok(hopeless.parseError);
});

test("renderSetupReport labels the WSL transport with its reason", () => {
  const output = renderSetupReport({
    ready: true,
    node: { available: true, detail: "v22.0.0" },
    cursor: {
      available: true,
      detail: "2026.07.23 (via WSL at /home/user/.local/bin/cursor-agent)",
      transport: "wsl",
      transportReason: "no native Windows build; using WSL"
    },
    auth: { available: true, loggedIn: true, detail: "Logged in as user@example.com" },
    platform: "win32",
    actionsTaken: [],
    nextSteps: []
  });

  assert.match(output, /- transport: cursor-agent via WSL \(no native Windows build; using WSL\)/);
  assert.match(output, /- process cleanup: reduced safety on Windows/);
});

test("renderSetupReport labels the native transport without a reason", () => {
  const output = renderSetupReport({
    ready: true,
    node: { available: true, detail: "v22.0.0" },
    cursor: {
      available: true,
      detail: "2026.07.23",
      transport: "native",
      transportReason: null
    },
    auth: { available: true, loggedIn: true, detail: "Logged in as user@example.com" },
    platform: "linux",
    actionsTaken: [],
    nextSteps: []
  });

  assert.match(output, /- transport: cursor-agent \(native\)\n/);
  assert.doesNotMatch(output, /via WSL/);
  assert.doesNotMatch(output, /process cleanup/);
});

test("renderTaskResult appends the Cursor session footer when a chat id is available", () => {
  const output = renderTaskResult(
    { rawOutput: "Handled the requested task.", failureMessage: "" },
    { title: "Cursor Task", jobId: "task-1", write: true, threadId: "sess-task" }
  );

  assert.match(output, /^Handled the requested task\.\n/);
  assert.match(output, /Cursor session ID: sess-task/);
  assert.match(output, /Resume in Cursor: cursor-agent --resume sess-task/);
});

test("renderTaskResult omits the footer when no chat id is available", () => {
  const output = renderTaskResult(
    { rawOutput: "Handled the requested task.", failureMessage: "" },
    { title: "Cursor Task", jobId: "task-1", write: true }
  );

  assert.equal(output, "Handled the requested task.\n");
});

test("renderReviewResult appends the Cursor session footer when a chat id is available", () => {
  const output = renderReviewResult(
    {
      parsed: {
        verdict: "approve",
        summary: "Looks fine.",
        findings: [],
        next_steps: []
      },
      rawOutput: '{"verdict":"approve","summary":"Looks fine.","findings":[],"next_steps":[]}',
      parseError: null
    },
    {
      reviewLabel: "Adversarial Review",
      targetLabel: "working tree diff",
      threadId: "sess-adv"
    }
  );

  assert.match(output, /Cursor session ID: sess-adv/);
  assert.match(output, /Resume in Cursor: cursor-agent --resume sess-adv/);
});

test("renderJobStatusReport shows the transport label, model, and resume handoff", () => {
  const output = renderJobStatusReport({
    id: "task-7",
    status: "completed",
    title: "Cursor Task",
    jobClass: "task",
    kindLabel: "task",
    summary: "Investigate the flaky test",
    threadId: "sess-42",
    transport: "wsl",
    transportReason: "no native Windows build; using WSL",
    model: null,
    modelRecorded: true,
    duration: "1m 5s",
    write: false
  });

  assert.match(output, /# Cursor Job Status/);
  assert.match(output, /Transport: cursor-agent via WSL \(no native Windows build; using WSL\)/);
  assert.match(output, /Model: default \(Cursor config\)/);
  assert.match(output, /Cursor session ID: sess-42/);
  assert.match(output, /Resume in Cursor: cursor-agent --resume sess-42/);
  assert.match(output, /Result: \/cursor:result task-7/);
});

test("renderStoredJobResult shows the model line only when the stored result carries it", () => {
  const explicit = renderStoredJobResult(
    { id: "task-90", status: "completed", title: "Cursor Task", jobClass: "task", threadId: "sess-m1" },
    {
      threadId: "sess-m1",
      result: { rawOutput: "Task done.", model: "composer-1" }
    }
  );
  assert.match(explicit, /Model: composer-1/);
  assert.doesNotMatch(explicit, /effort/i);

  const configDefault = renderStoredJobResult(
    { id: "task-91", status: "completed", title: "Cursor Task", jobClass: "task", threadId: "sess-m2" },
    {
      threadId: "sess-m2",
      result: { rawOutput: "Task done.", model: null }
    }
  );
  assert.match(configDefault, /Model: default \(Cursor config\)/);

  const legacy = renderStoredJobResult(
    { id: "task-92", status: "completed", title: "Cursor Task", jobClass: "task", threadId: "sess-m3" },
    {
      threadId: "sess-m3",
      result: { rawOutput: "Task done." }
    }
  );
  assert.doesNotMatch(legacy, /Model:/);
});

test("renderStatusReport uses the Cursor session column and /cursor: actions", () => {
  const output = renderStatusReport({
    running: [
      {
        id: "task-live",
        kindLabel: "task",
        status: "running",
        phase: "starting",
        elapsed: "5s",
        threadId: "sess-live",
        summary: "Do the thing",
        liveness: null
      }
    ],
    latestFinished: null,
    recent: []
  });

  assert.match(output, /# Cursor Status/);
  assert.match(output, /\| Job \| Kind \| Status \| Phase \| Elapsed \| Cursor Session ID \| Summary \| Actions \|/);
  assert.match(output, /`\/cursor:status task-live`<br>`\/cursor:cancel task-live`/);
  assert.match(output, /Cursor session ID: sess-live/);
  assert.match(output, /Resume in Cursor: cursor-agent --resume sess-live/);
});
