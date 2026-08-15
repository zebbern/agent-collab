# Direct Codex Task Command Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `/codex:task --background` as the obvious way to start Codex work that survives the launching Claude session.

**Architecture:** Add one deterministic slash-command document that forwards raw arguments exactly once into the existing `codex-companion.mjs task` runtime. Change only command/docs contracts and release metadata; reuse the already-tested persistent worker path unchanged.

**Tech Stack:** Claude Code plugin Markdown, plain Node `.mjs` contract tests with `node:test`, existing version-bump script and npm verification gates.

## Global Constraints

- Work in branch `z/codex-task-command`; `main` remains protected.
- Do not change task runtime, lifecycle, cancellation, broker, state, Cursor, or Goal behavior.
- `/codex:rescue` remains unchanged.
- `--background` is passed to the companion, never translated into Claude-side background Bash.
- No new dependencies or chassis changes.
- Ship marketplace `1.3.2` and Codex `1.0.6+fork.9`; keep Cursor `0.5.3` and Goal `0.3.2`.
- Use Conventional Commits with no AI attribution.

---

### Task 1: Command and onboarding contract

**Files:**
- Create: `plugins/codex/commands/task.md`
- Modify: `README.md`
- Modify: `tests/commands.test.mjs`

**Interfaces:**
- Consumes: `node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" task "$ARGUMENTS"`.
- Produces: `/codex:task` with raw argument forwarding and companion-owned persistent background execution.

- [ ] **Step 1: Write the failing command contract tests**

Add `task.md` to the exact command inventory and add this test to `tests/commands.test.mjs`:

```js
test("task command forwards raw arguments once and leaves background execution to the companion", () => {
  const source = read("commands/task.md");

  assert.match(source, /disable-model-invocation:\s*true/);
  assert.match(source, /allowed-tools:\s*Bash\(node:\*\)/);
  assert.match(source, /argument-hint:.*\[--background\].*\[--write\].*--resume-last\|--resume\|--fresh/);
  const invocation = /node "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/codex-companion\.mjs" task "\$ARGUMENTS"/g;
  assert.equal(source.match(invocation)?.length, 1);
  assert.equal(source.match(/\$ARGUMENTS/g)?.length, 1);
  assert.match(source, /Present the command output to the user exactly as returned/i);
  assert.match(source, /Preserve the raw arguments unchanged/i);
  assert.match(source, /Do not remove `--background` or turn it into Claude-side background execution/i);
  assert.match(source, /companion enqueues the detached persistent worker and returns its job ID/i);
  assert.match(source, /slash command remains inline/i);
  assert.doesNotMatch(source, /run_in_background\s*:/);
  assert.doesNotMatch(source, /\bBash\s*\(\s*\{/);
  assert.doesNotMatch(source, /subagent_type\s*:/);
  assert.doesNotMatch(source, /task-resume-candidate/);
  assert.doesNotMatch(source, /allowed-tools:.*\bAgent\b/);
});
```

Add README assertions that pin `/codex:task` in the Codex highlights row,
command table, usage heading, and Quick Start. Pin the cross-session sequence:
`--background --fresh`, close Claude, reopen the same repository,
`/codex:status <job-id> --wait`, then `/codex:result <job-id>`.

- [ ] **Step 2: Run the focused test and observe the intended failure**

Run: `node --test tests/commands.test.mjs`

Expected: FAIL because `plugins/codex/commands/task.md` is missing and the
README still demonstrates a background review.

- [ ] **Step 3: Add the minimal task command**

Create `plugins/codex/commands/task.md`:

```markdown
---
description: Delegate investigation, a fix request, or follow-up work directly to the Codex CLI
argument-hint: '[--background] [--write] [--resume-last|--resume|--fresh] [--profile <deep|fast>] [--model <model|spark>] [--effort <none|minimal|low|medium|high|xhigh|max>] [prompt]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" task "$ARGUMENTS"`

Present the command output to the user exactly as returned. Do not paraphrase, summarize, rewrite, or add commentary before or after it.

Preserve the raw arguments unchanged. Do not remove `--background` or turn it into Claude-side background execution. When `--background` is present, the companion enqueues the detached persistent worker and returns its job ID; this slash command remains inline.

Do not invoke any other helper, a Claude background task, or a subagent.
```

- [ ] **Step 4: Update benefit-led documentation**

In `README.md`:

- add `/codex:task` to the Codex highlights row and command table;
- replace the review Quick Start with a read-only repository-mapping task;
- tell the user to close Claude and reopen the same repository before status/result;
- add a `/codex:task` usage section explaining foreground versus persistent
  `--background`, `--write`, resume/fresh, and profile/model/effort flags; and
- retain every existing review and rescue claim unchanged.

- [ ] **Step 5: Run the focused contract tests**

Run: `node --test tests/commands.test.mjs`

Expected: PASS.

- [ ] **Step 6: Commit the product wiring**

```powershell
git add -- plugins/codex/commands/task.md README.md tests/commands.test.mjs
git commit -m "feat(codex): expose persistent task command"
```

---

### Task 2: Release metadata

**Files:**
- Modify: `plugins/codex/CHANGELOG.md`
- Modify: `plugins/codex/.claude-plugin/plugin.json`
- Modify: `.claude-plugin/marketplace.json`
- Modify: `package.json`
- Modify: `package-lock.json`

**Interfaces:**
- Consumes: the shipped command/docs contract from Task 1.
- Produces: installable marketplace `1.3.2` with Codex `1.0.6+fork.9`.

- [ ] **Step 1: Add the changelog entry**

Add above `1.0.6+fork.8`:

```markdown
## 1.0.6+fork.9

- New `/codex:task --background` command directly starts Codex work that
  survives the launching Claude session. The Quick Start now demonstrates
  closing Claude, reopening the repository, and collecting the stored result.
```

- [ ] **Step 2: Bump only the intended version targets**

Run:

```powershell
npm run bump-version -- repo 1.3.2
npm run bump-version -- codex 1.0.6+fork.9
```

Expected changed metadata: root package and lock versions, marketplace
metadata/Codex entry, and Codex plugin manifest only.

- [ ] **Step 3: Verify version consistency**

Run: `npm run check-version`

Expected: exit 0 and all targets consistent.

- [ ] **Step 4: Commit the release metadata**

```powershell
git add -- plugins/codex/CHANGELOG.md plugins/codex/.claude-plugin/plugin.json .claude-plugin/marketplace.json package.json package-lock.json
git commit -m "chore(release): prepare v1.3.2"
```

---

### Task 3: Verification, review, and publication

**Files:**
- No new source files; verification may reveal corrections within Task 1/2 files only.

**Interfaces:**
- Consumes: Tasks 1 and 2.
- Produces: merged PR, green protected `main`, annotated `v1.3.2` tag, and GitHub release.

- [ ] **Step 1: Run narrow checks**

Run:

```powershell
node --test tests/commands.test.mjs tests/bump-version.test.mjs
npm run check-version
npm run build
git diff --check origin/main...HEAD
```

Expected: every command exits 0.

- [ ] **Step 2: Run the full local gate**

Run: `npm run verify`

Expected: exit 0 with every native and Linux leg verified.

- [ ] **Step 3: Review the branch diff**

Confirm every changed line maps to command exposure, onboarding, release
metadata, or the required spec/plan. Confirm no runtime/chassis files changed.

- [ ] **Step 4: Push and open the PR**

Push `z/codex-task-command`, open a PR explaining the user benefit and narrow
scope, enable squash auto-merge, and watch the exact head-SHA Actions run with
`gh run watch --exit-status <run-id>`.

- [ ] **Step 5: Verify protected main**

After merge, watch the post-merge `Required CI` run for the merge SHA and
require exit 0 before publishing.

- [ ] **Step 6: Run the installed-marketplace smoke**

Update/install `codex@agent-collab`, launch the documented read-only task with
`--background --fresh`, capture its job id, end the Claude session, reopen the
same repository, wait with `/codex:status <job-id> --wait`, retrieve with
`/codex:result <job-id>`, and confirm the result is substantive and `git status`
is unchanged.

- [ ] **Step 7: Tag and publish**

Create annotated tag `v1.3.2` at the green merge commit, push it, and create a
GitHub release whose notes lead with direct cross-session Codex tasks.

---

## Self-Review (completed)

- **Spec coverage:** Task 1 covers the command, raw forwarding, onboarding,
  discoverability, and contract tests. Task 2 covers the exact version tuple
  and changelog. Task 3 covers local gates, protected CI, installed-user
  acceptance, and publication.
- **Placeholder scan:** no deferred or vague implementation steps remain.
- **Interface consistency:** command name, companion invocation, flags, version
  values, and live smoke sequence match the approved design.
