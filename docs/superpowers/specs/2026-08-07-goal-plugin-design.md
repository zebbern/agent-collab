# goal@agent-collab — long-horizon project goals (v1 design)

- Status: Approved design, pre-implementation
- Date: 2026-08-07
- Decisions this spec encodes: `/goal` MVP + minimal ledger first; attended-only
  v1; third plugin in this marketplace; companion-backed architecture
  (Approach 2); first dogfood goal is the zclean backlog on this repo.

## Context

The marketplace's two plugins make delegation ambient: Claude reaches for
Codex/Cursor on task shape, fires background jobs, and collects results
(ADR 0006). The next capability is *length*: a goal set once in a project and
advanced increment by increment across sessions. A recursive
self-improvement ("bilevel") outer loop is a stated future direction; it
requires ground truth about outcomes, which nothing records today. This
design delivers the goal loop and the minimal outcome ledger that future
loop will feed on.

Division of labor, one line: **the companion owns everything that must be
true (state, selection, dispositions); Claude owns everything that needs
judgment (executing, routing, presenting).**

## Non-goals (v1)

- **Unattended operation.** The loop advances only in an open session
  (`/goal:step`, optionally driven by `/loop` while the user watches).
  Nothing in the formats may preclude a later cron trigger, but no
  scheduling surface ships. The trigger-level recipe (never-merge, wake
  reconciliation, `goal/<slug>/<itemId>` work branches) is now documented in
  step.md; scheduling remains the platform's job and PR-merge stays human.
- **Intra-step parallelism via file-claiming.** If a goal step ever warrants
  fan-out, it uses the harness's native subagents/workflows. A shared task
  list with read-modify-write "atomic" claiming (swarm-style) is rejected:
  the protocol is a TOCTOU race, and its timeout auto-release double-assigns
  work to slow-but-alive agents.
- **Standalone orchestrator daemon** (Approach 3). Only becomes relevant if
  Claude-free operation is ever wanted; nothing here builds toward it.
- **The bilevel outer loop itself.** Later phase: a retrospective that reads
  the ledger and proposes policy changes as reviewable PRs. This spec only
  guarantees the ledger it will need.

## Plugin layout

```
plugins/goal/
  .claude-plugin/plugin.json        (name "goal", version 0.1.0)
  commands/set.md  step.md  status.md  help.md
  skills/goal-runner/SKILL.md
  scripts/goal-companion.mjs
  scripts/lib/                      (minimal, self-contained; mirrors NOTHING)
  CHANGELOG.md  LICENSE
```

- Marketplace manifest gains a third entry. README gains a Goal plugin
  section (doc-pinned like the others).
- The plugin imports nothing from `plugins/codex` or `plugins/cursor` and
  needs none of the job-control/cancel/identity chassis: it never spawns
  workers. All delegation happens through Claude invoking the existing
  `codex-delegation` / `cursor-delegation` skills. Either delegate plugin
  is optional; if one is missing, Claude says so and works locally or
  records `blocked`.
- `goal` joins the `PLUGINS` list in `tests/import-closure.test.mjs`
  (self-containment enforced mechanically). The chassis drift guard is
  untouched — goal mirrors nothing.

## Goal file (git-tracked project content)

Location: `.claude/goals/<slug>.json`. Slug: `[a-z0-9-]+`, derived from
content on `set`. A goal is project content: it survives machines, and each
increment's PR shows the goal-state change beside the code change.

```json
{
  "schemaVersion": 1,
  "slug": "zclean-backlog",
  "statement": "Burn down the zclean comparison backlog",
  "acceptanceCriteria": [
    { "kind": "command", "run": "npm test", "expect": "exit0", "timeoutMs": 600000 },
    { "kind": "manual", "text": "Every backlog item merged or explicitly dropped with a reason" }
  ],
  "backlog": [
    {
      "id": "vacuous-lock-test",
      "title": "Replace the vacuous lock test with a real contention assertion",
      "detail": "…",
      "status": "todo",
      "disposition": null
    }
  ],
  "budget": { "perStepDelegations": 2 },
  "status": "active",
  "blockedReason": null,
  "createdAt": "…",
  "updatedAt": "…"
}
```

Semantics:

- **Backlog is ranked**; selection is deterministic (first `todo`). No model
  judgment decides *what's next* — only *how to do it*.
- Item statuses: `todo | in-progress | merged | discarded | dropped |
  blocked`. Terminal statuses double as the disposition record and carry
  `{ pr?, delegate?, notes?, recordedAt }`.
- Goal statuses: `active | blocked | done | abandoned`. `blocked` carries
  `blockedReason` and halts `next` until a human edits the file (item back
  to `todo`, or `dropped`) and re-runs `set`.
- `acceptanceCriteria.kind`: `command` (mechanically checkable, judged by
  exit code, per-criterion `timeoutMs`, default 600000) or `manual` (listed
  for the human).
- `budget.perStepDelegations` is **advisory in v1** (attended; Claude states
  when it would exceed it). It lives in the schema now so unattended can
  enforce it later without migration.

## The minimal ledger (two layers)

- **Dispositions in the goal file** (git-tracked): portable ground truth,
  reviewable in the PR that completes each item.
- **`ledger.jsonl`** in the plugin state dir (`goal-companion` under the
  same temp/plugin-data convention as the siblings — state dirs stay
  separate per the repo rule): append-only, machine-local telemetry. One
  line per event:

```json
{ "at": "…", "slug": "…", "itemId": "…", "event": "step-started" }
{ "at": "…", "slug": "…", "itemId": "…", "event": "disposition",
  "disposition": "merged", "delegate": "codex", "jobId": "…", "pr": 12,
  "durationMs": 480000, "notes": "…" }
```

This file is the raw feed for the future retrospective loop. Corrupt lines
are skipped and *counted*; `status` reports the count — never silently
absorbed.

v1 shipped the state dir with default permissions; the siblings' private-dir
hardening (0o700 root + non-recursive leaf creation, symlink/non-directory
refusal, off-win32 ownership and loose-mode checks) was built goal-locally in
`plugins/goal/scripts/lib/ledger.mjs` on 2026-08-07 — no longer a known
upgrade, it is in place.

## Companion command surface

Conventions shared with the siblings: every subcommand accepts `--cwd`
(alias `-C`) and `--json`; exit codes are honest; refusals state specifics.

| Command | Contract |
| --- | --- |
| `set --file <path>` | Schema-validate the given JSON and write it to `.claude/goals/<slug>.json` (slug from content). `--file` is required in v1 (no stdin). Refuses malformed input with specifics; never repairs silently. Also the re-validation step after hand-edits. |
| `status [<slug>]` | Goal, progress counts, in-progress item, ledger tail + corrupt-line count. Slug optional when exactly one goal exists. |
| `next [<slug>]` | Read-only. First `todo` item. Non-zero exit with the reason if the goal is not `active` or an item is already `in-progress`. |
| `start <slug> <itemId>` | Marks `in-progress`; refuses if any other item is `in-progress` (mechanical one-increment-at-a-time). Appends `step-started`. |
| `record <slug> <itemId> --disposition merged\|discarded\|dropped\|blocked [--pr N] [--delegate codex\|cursor\|none] [--notes …]` | Enforces the state machine: `todo → in-progress → terminal`; `dropped` additionally allowed from `todo` (grooming). Appends the disposition ledger line. `blocked` also sets the goal `blocked` with the reason. Refuses once the goal has left `active` — blocked/done/abandoned goals are frozen; a blocked goal resolves by editing the file and re-running `set`. |
| `check [<slug>]` | Runs each `command` criterion (via shell — see trust boundary), reports per-criterion pass/fail, lists `manual` criteria. Exit 0 only if all command criteria pass. |
| `close <slug> --done\|--abandoned` | `--done` refuses unless the goal is `active`, no `todo`/`in-progress`/`blocked` items remain, AND `check` passes. |
| `help` | Usage. |

Slug resolution: where `<slug>` is optional, it may be omitted only when
exactly one goal file exists; with zero or multiple goals the command
refuses and lists what exists.

Schema validation runs on **every read**: any command against a malformed
goal file refuses with specifics.

Writes are atomic (tmp + rename). The siblings' lock machinery is
deliberately **not** used: single-writer is a documented v1 assumption
(attended, one session); git catches the rest. The unattended upgrade path
is to adopt the sibling lock pattern — bounded, known change.

## `/goal:step` choreography

One increment per invocation; the command ends explicitly — repetition is
`/loop` with the user watching, or the user invoking again.

1. `next --json` — if refused, surface the reason and stop.
2. Announce the increment in one line (same disclosure rule as the
   delegation skills).
3. `start` it.
4. Execute with judgment: local for trivial work; otherwise delegate via the
   existing `codex-delegation` / `cursor-delegation` skills. **Analysis and
   implementation are separate delegations** when both are needed, within
   `budget.perStepDelegations`.
5. Verify through the project's own gates (this repo: `npm run verify`);
   land the change as a PR; the user merges (attended).
6. **Refine-and-redelegate-once**: if delegated work fails verification,
   refine the brief with the failure evidence and re-delegate once (counted
   against the step budget); still failing → `record --disposition blocked`
   with the evidence.
7. `record` the real disposition, `status` one-liner, stop.

`/goal:set` interviews briefly, drafts the JSON, runs `set`, shows `status`.
`/goal:status` is a thin wrapper. The `goal-runner` skill carries the policy
(one increment, disclosure, refine-once, separate analyze/implement, honest
failure) so it also triggers when the user asks in natural language.

## Trust boundary

`check` executes commands from the goal file — the same trust level as
`package.json` scripts. The command docs state: review goal files in
untrusted repos before running `/goal:*`. Goal files are ordinary reviewed
project content; this is documented, not mitigated further in v1.

## Testing

- **Companion** (node --test, temp dirs, Windows-safe, no POSIX-isms):
  validation refusals; deterministic `next`; `start` one-at-a-time
  enforcement; `record` state-machine refusals; `check` exit-code semantics
  against fake criterion commands (pass/fail/timeout); `close` guards;
  ledger append + corrupt-line tolerance; atomic-write basics.
- **Doc pins** (commands.test idiom): goal commands + `goal-runner` skill —
  one-increment rule, disclosure, refine-and-redelegate-once, separate
  analyze/implement delegations, blocked-is-a-full-stop.
- **Existing guards**: `goal` added to the import-closure `PLUGINS` list;
  README section pinned; marketplace manifest entry.

## Dogfood (acceptance test for the plugin itself)

Seed `zclean-backlog` on this repo. The **first groom re-verifies every
memory-backlog item against current main** — several already shipped
(locale-pin identity in codex 1.0.6+fork.4, WSL reap identity in cursor
0.4.0, doctor commands on 2026-08-07). Then run `/goal:step` live on the
first surviving item and observe the whole loop: next → start → delegate →
verify → PR → record. The plugin is not done until that live run has
happened and been reported with observed output.

## Roadmap after v1 (context, not commitment)

Ledger accumulates → scheduled retrospective proposes policy changes
(routing, skill wording, effort tiers) as reviewable PRs — self-improvement
targets policy artifacts, never ungated code. Unattended arrives as a
trigger change (cron/scheduled agents), not an architecture change.
