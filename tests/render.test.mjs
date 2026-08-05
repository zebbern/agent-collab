import test from "node:test";
import assert from "node:assert/strict";

import {
  renderJobStatusReport,
  renderNativeReviewResult,
  renderReviewResult,
  renderSetupReport,
  renderStatusReport,
  renderStoredJobResult,
  renderTaskResult
} from "../plugins/codex/scripts/lib/render.mjs";

test("renderReviewResult degrades gracefully when JSON is missing required review fields", () => {
  const output = renderReviewResult(
    {
      parsed: {
        verdict: "approve",
        summary: "Looks fine."
      },
      rawOutput: JSON.stringify({
        verdict: "approve",
        summary: "Looks fine."
      }),
      parseError: null
    },
    {
      reviewLabel: "Adversarial Review",
      targetLabel: "working tree diff"
    }
  );

  assert.match(output, /Codex returned JSON with an unexpected review shape\./);
  assert.match(output, /Missing array `findings`\./);
  assert.match(output, /Raw final message:/);
});

test("renderTaskResult appends the Codex session footer when a thread id is available", () => {
  const output = renderTaskResult(
    { rawOutput: "Handled the requested task.", failureMessage: "" },
    { title: "Codex Task", jobId: "task-1", write: true, threadId: "thr_task" }
  );

  assert.match(output, /^Handled the requested task\.\n/);
  assert.match(output, /Codex session ID: thr_task/);
  assert.match(output, /Resume in Codex: codex resume thr_task/);
});

test("renderTaskResult omits the footer when no thread id is available", () => {
  const output = renderTaskResult(
    { rawOutput: "Handled the requested task.", failureMessage: "" },
    { title: "Codex Task", jobId: "task-1", write: true }
  );

  assert.equal(output, "Handled the requested task.\n");
});

test("renderNativeReviewResult appends the Codex session footer only when a thread id is available", () => {
  const withFooter = renderNativeReviewResult(
    { status: 0, stdout: "No material issues found.", stderr: "" },
    { reviewLabel: "Review", targetLabel: "working tree diff", threadId: "thr_review" }
  );

  assert.match(withFooter, /Codex session ID: thr_review/);
  assert.match(withFooter, /Resume in Codex: codex resume thr_review/);

  const withoutFooter = renderNativeReviewResult(
    { status: 0, stdout: "No material issues found.", stderr: "" },
    { reviewLabel: "Review", targetLabel: "working tree diff" }
  );

  assert.doesNotMatch(withoutFooter, /Codex session ID/);
  assert.doesNotMatch(withoutFooter, /Resume in Codex/);
});

test("renderReviewResult appends the Codex session footer when a thread id is available", () => {
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
      threadId: "thr_adv"
    }
  );

  assert.match(output, /Codex session ID: thr_adv/);
  assert.match(output, /Resume in Codex: codex resume thr_adv/);
});

test("renderStoredJobResult prefers rendered output for structured review jobs", () => {
  const output = renderStoredJobResult(
    {
      id: "review-123",
      status: "completed",
      title: "Codex Adversarial Review",
      jobClass: "review",
      threadId: "thr_123"
    },
    {
      threadId: "thr_123",
      rendered: "# Codex Adversarial Review\n\nTarget: working tree diff\nVerdict: needs-attention\n",
      result: {
        result: {
          verdict: "needs-attention",
          summary: "One issue.",
          findings: [],
          next_steps: []
        },
        rawOutput:
          '{"verdict":"needs-attention","summary":"One issue.","findings":[],"next_steps":[]}'
      }
    }
  );

  assert.match(output, /^# Codex Adversarial Review/);
  assert.doesNotMatch(output, /^\{/);
  assert.match(output, /Codex session ID: thr_123/);
  assert.match(output, /Resume in Codex: codex resume thr_123/);
  assert.match(output, /Next: \/codex:status review-123 for job details, or \/codex:review --wait to review the changes\./);
});

test("renderStoredJobResult shows the model line only when the stored result carries it", () => {
  const explicit = renderStoredJobResult(
    { id: "task-90", status: "completed", title: "Codex Task", jobClass: "task", threadId: "thr_m1" },
    {
      threadId: "thr_m1",
      result: { rawOutput: "Task done.", model: "gpt-5.4-codex", effort: "high" }
    }
  );
  assert.match(explicit, /Model: gpt-5\.4-codex \(effort: high\)/);

  const configDefault = renderStoredJobResult(
    { id: "task-91", status: "completed", title: "Codex Task", jobClass: "task", threadId: "thr_m2" },
    {
      threadId: "thr_m2",
      result: { rawOutput: "Task done.", model: null, effort: null }
    }
  );
  assert.match(configDefault, /Model: default \(Codex config\)/);
  assert.doesNotMatch(configDefault, /effort:/);

  const legacy = renderStoredJobResult(
    { id: "task-92", status: "completed", title: "Codex Task", jobClass: "task", threadId: "thr_m3" },
    {
      threadId: "thr_m3",
      result: { rawOutput: "Task done." }
    }
  );
  assert.doesNotMatch(legacy, /Model:/);
});

test("renderStoredJobResult shows stored files, reasoning, and follow-up hints for task jobs", () => {
  const output = renderStoredJobResult(
    {
      id: "task-9",
      status: "completed",
      title: "Codex Task",
      jobClass: "task",
      threadId: "thr_task9"
    },
    {
      threadId: "thr_task9",
      result: {
        status: 0,
        threadId: "thr_task9",
        rawOutput: "Done.",
        touchedFiles: ["src/a.mjs", "src/b.mjs"],
        reasoningSummary: ["Inspected the failing test", "Patched the parser"]
      }
    }
  );

  assert.match(output, /^Done\.\n/);
  assert.match(output, /Files changed:\n- src\/a\.mjs\n- src\/b\.mjs/);
  assert.match(output, /Reasoning:\n- Inspected the failing test\n- Patched the parser/);
  assert.match(output, /Codex session ID: thr_task9/);
  assert.match(output, /Next: \/codex:status task-9 .*\/codex:review --wait/);
});

test("renderStoredJobResult caps the files changed list and notes the overflow", () => {
  const touchedFiles = Array.from({ length: 25 }, (_, index) => `src/file-${index + 1}.mjs`);
  const output = renderStoredJobResult(
    {
      id: "task-10",
      status: "completed",
      title: "Codex Task",
      jobClass: "task"
    },
    {
      result: {
        status: 0,
        rawOutput: "Done.",
        touchedFiles
      }
    }
  );

  assert.match(output, /- src\/file-20\.mjs/);
  assert.doesNotMatch(output, /- src\/file-21\.mjs/);
  assert.match(output, /- \.\.\. and 5 more/);
});

test("renderStoredJobResult skips absent extra sections gracefully", () => {
  const output = renderStoredJobResult(
    {
      id: "review-1",
      status: "completed",
      title: "Codex Review",
      jobClass: "review"
    },
    {
      result: {
        codex: {
          stdout: "No material issues found."
        }
      }
    }
  );

  assert.match(output, /^No material issues found\.\n/);
  assert.doesNotMatch(output, /Files changed:/);
  assert.doesNotMatch(output, /Reasoning:/);
  assert.doesNotMatch(output, /Codex session ID/);
  assert.match(output, /Next: \/codex:status review-1/);
});

test("renderJobStatusReport shows progress signals and the liveness marker when present", () => {
  const output = renderJobStatusReport({
    id: "task-77",
    status: "running",
    kindLabel: "rescue",
    title: "Codex Task",
    phase: "verifying",
    liveness: "likely dead",
    progressSignals: ["files changed: 2", "commands: 14 run (9 distinct, possible loop: npm test x4)"]
  });

  assert.match(output, /task-77 \| running \(likely dead\)/);
  assert.match(output, /Progress signals:/);
  assert.match(output, /files changed: 2/);
  assert.match(output, /possible loop: npm test x4/);
});

test("renderJobStatusReport omits progress signals and the liveness marker when absent", () => {
  const output = renderJobStatusReport({
    id: "task-78",
    status: "completed",
    kindLabel: "rescue",
    title: "Codex Task",
    progressSignals: []
  });

  assert.doesNotMatch(output, /Progress signals:/);
  assert.doesNotMatch(output, /likely dead/);
});

test("renderJobStatusReport shows the transport line only when the job record carries it", () => {
  const fallback = renderJobStatusReport({
    id: "task-79",
    status: "completed",
    kindLabel: "rescue",
    title: "Codex Task",
    transport: "direct",
    transportReason: "broker busy"
  });
  assert.match(fallback, /Transport: private Codex process \(broker busy\)/);

  const shared = renderJobStatusReport({
    id: "task-80",
    status: "completed",
    kindLabel: "rescue",
    title: "Codex Task",
    transport: "broker"
  });
  assert.match(shared, /Transport: shared Codex runtime/);
  assert.doesNotMatch(shared, /shared Codex runtime \(/);

  const legacy = renderJobStatusReport({
    id: "task-81",
    status: "completed",
    kindLabel: "rescue",
    title: "Codex Task"
  });
  assert.doesNotMatch(legacy, /Transport:/);
});

test("renderJobStatusReport shows the model line only when the job record carries it", () => {
  const explicit = renderJobStatusReport({
    id: "task-82",
    status: "completed",
    kindLabel: "rescue",
    title: "Codex Task",
    model: "gpt-5.4-codex",
    modelRecorded: true
  });
  assert.match(explicit, /Model: gpt-5\.4-codex/);

  const configDefault = renderJobStatusReport({
    id: "task-83",
    status: "completed",
    kindLabel: "rescue",
    title: "Codex Task",
    model: null,
    modelRecorded: true
  });
  assert.match(configDefault, /Model: default \(Codex config\)/);
  assert.doesNotMatch(configDefault, /effort:/);

  const withEffort = renderJobStatusReport({
    id: "task-85",
    status: "completed",
    kindLabel: "rescue",
    title: "Codex Task",
    model: "gpt-5.3-codex-spark",
    modelRecorded: true,
    effort: "high"
  });
  assert.match(withEffort, /Model: gpt-5\.3-codex-spark \(effort: high\)/);

  const legacy = renderJobStatusReport({
    id: "task-84",
    status: "completed",
    kindLabel: "rescue",
    title: "Codex Task"
  });
  assert.doesNotMatch(legacy, /Model:/);
});

function buildSetupReportFixture(overrides = {}) {
  return {
    ready: true,
    node: { detail: "v22.0.0" },
    npm: { detail: "10.0.0" },
    codex: { detail: "codex-cli test (advanced runtime available)" },
    auth: { detail: "Logged in with ChatGPT (test@example.com)" },
    sessionRuntime: { label: "direct startup" },
    reviewGateEnabled: false,
    platform: "linux",
    actionsTaken: [],
    nextSteps: [],
    ...overrides
  };
}

test("renderSetupReport warns that an enabled review gate is interruptive", () => {
  const output = renderSetupReport(buildSetupReportFixture({ reviewGateEnabled: true }));

  assert.match(output, /- review gate: enabled \(interruptive: runs a Codex review before every session stop and can add minutes/);
  assert.match(output, /disable with `\/codex:setup --disable-review-gate`\)/);
});

test("renderSetupReport stays quiet about the review gate when it is disabled", () => {
  const output = renderSetupReport(buildSetupReportFixture());

  assert.match(output, /- review gate: disabled/);
  assert.doesNotMatch(output, /interruptive/);
  assert.doesNotMatch(output, /--disable-review-gate/);
});

test("renderSetupReport surfaces reduced Windows cleanup safety only on win32", () => {
  const windows = renderSetupReport(buildSetupReportFixture({ platform: "win32" }));
  assert.match(windows, /- process cleanup: reduced safety on Windows \(taskkill-based; no identity-verified tree kills\)/);

  const linux = renderSetupReport(buildSetupReportFixture({ platform: "linux" }));
  assert.doesNotMatch(linux, /process cleanup: reduced safety/);

  const unknown = renderSetupReport(buildSetupReportFixture({ platform: undefined }));
  assert.doesNotMatch(unknown, /process cleanup: reduced safety/);
});

test("renderStatusReport keeps live details previews alongside progress signals", () => {
  const output = renderStatusReport({
    sessionRuntime: { label: "direct startup" },
    config: { stopReviewGate: false },
    running: [
      {
        id: "task-90",
        status: "running",
        kindLabel: "rescue",
        title: "Codex Task",
        phase: "running",
        elapsed: "5s",
        progressSignals: ["last activity: 2s ago"],
        progressPreview: ["Running command: npm test"]
      }
    ],
    latestFinished: null,
    recent: [],
    needsReview: false
  });

  assert.match(output, /Live details:/);
  assert.match(output, /Progress signals:/);
  assert.match(output, /last activity: 2s ago/);
  assert.match(output, /Progress:/);
  assert.match(output, /Running command: npm test/);
});

test("renderStatusReport marks the active-jobs table status when a job is likely dead", () => {
  const output = renderStatusReport({
    sessionRuntime: { label: "direct startup" },
    config: { stopReviewGate: false },
    running: [
      {
        id: "task-91",
        status: "running",
        kindLabel: "rescue",
        title: "Codex Task",
        liveness: "likely dead"
      },
      {
        id: "task-92",
        status: "running",
        kindLabel: "rescue",
        title: "Codex Task"
      }
    ],
    latestFinished: null,
    recent: [],
    needsReview: false
  });

  assert.match(output, /\| task-91 \| rescue \| running \(likely dead\) \|/);
  assert.match(output, /\| task-92 \| rescue \| running \|/);
});
