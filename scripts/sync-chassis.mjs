#!/usr/bin/env node
// Mechanizes the chassis mirror: copies the shared lib modules from one
// plugin into the other, applying the per-plugin literal swaps, then runs the
// drift guard as an independent check.
//
// This is an AUTHOR-TIME tool you invoke deliberately after editing a chassis
// module — it is intentionally NOT wired into the test pipeline. A test-time
// auto-sync would turn the drift guard's loud tripwire into silent
// working-tree mutation and could revert an edit made to the non-canonical
// copy while the suite goes green.
//
// Usage:
//   npm run sync-chassis            # codex -> cursor (default)
//   npm run sync-chassis -- --from cursor
//
// Modules with genuine per-plugin divergence (different code, not just a
// renamed literal) are refused: mirror those by hand, looking at both copies,
// and update the PINNED_DIVERGENCE digest in tests/chassis-drift.test.mjs in
// the same commit.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Byte-identical between plugins: copy verbatim.
const IDENTICAL_MODULES = ["args.mjs", "prompts.mjs", "workspace.mjs", "process.mjs", "git.mjs", "doctor.mjs"];

// Identical except for plugin-name literals: copy with substitution. Every
// listed literal must occur in the source module, or the pair table is stale
// and the run fails rather than silently under-swapping.
const LITERAL_SWAP_MODULES = new Map([
  [
    "state.mjs",
    [
      ["codex-companion", "cursor-companion"],
      ["CODEX_COMPANION_STATE_ROOT", "CURSOR_COMPANION_STATE_ROOT"],
      // The metrics plugin stamp drives legacy-shard row attribution and the
      // per-plugin .migrated marker suffix.
      ['METRICS_PLUGIN = "codex"', 'METRICS_PLUGIN = "cursor"']
    ]
  ],
  [
    "tracked-jobs.mjs",
    [
      ["CODEX_COMPANION_SESSION_ID", "CURSOR_COMPANION_SESSION_ID"],
      // The stderr progress prefix names the plugin; without this pair the
      // mirror faithfully copied "[codex]" into cursor (observed live).
      ["[codex] ", "[cursor] "]
    ]
  ]
]);

// Genuinely divergent code (provider wording, platform caveats, provider
// branches): never blind-copy these.
const HAND_MIRROR_MODULES = ["fs.mjs", "job-control.mjs", "render.mjs"];

function libPath(plugin, module) {
  return path.join(ROOT, "plugins", plugin, "scripts", "lib", module);
}

function parseArgs(argv) {
  const fromIndex = argv.indexOf("--from");
  const from = fromIndex === -1 ? "codex" : argv[fromIndex + 1];
  if (from !== "codex" && from !== "cursor") {
    console.error(`Unknown --from "${from}"; use codex or cursor.`);
    process.exit(1);
  }
  return { from, to: from === "codex" ? "cursor" : "codex" };
}

function syncModule(module, from, to, substitutions) {
  const sourcePath = libPath(from, module);
  const targetPath = libPath(to, module);
  let content = fs.readFileSync(sourcePath, "utf8");
  for (const [codexLiteral, cursorLiteral] of substitutions) {
    const [own, other] = from === "codex" ? [codexLiteral, cursorLiteral] : [cursorLiteral, codexLiteral];
    if (!content.includes(own)) {
      console.error(`${module}: expected literal "${own}" not found in ${from} copy — the swap table is stale; fix scripts/sync-chassis.mjs first.`);
      process.exit(1);
    }
    content = content.split(own).join(other);
  }
  const existing = fs.readFileSync(targetPath, "utf8");
  if (existing === content) {
    return "in-sync";
  }
  fs.writeFileSync(targetPath, content);
  return "synced";
}

const { from, to } = parseArgs(process.argv.slice(2));
console.log(`Syncing chassis ${from} -> ${to}`);
let changed = 0;
for (const module of IDENTICAL_MODULES) {
  const outcome = syncModule(module, from, to, []);
  changed += outcome === "synced" ? 1 : 0;
  console.log(`  ${outcome === "synced" ? "SYNCED " : "in-sync"}  lib/${module}`);
}
for (const [module, substitutions] of LITERAL_SWAP_MODULES) {
  const outcome = syncModule(module, from, to, substitutions);
  changed += outcome === "synced" ? 1 : 0;
  console.log(`  ${outcome === "synced" ? "SYNCED " : "in-sync"}  lib/${module} (literal swap)`);
}
for (const module of HAND_MIRROR_MODULES) {
  console.log(`  MANUAL   lib/${module} — genuinely divergent; mirror by hand if you changed it`);
}

console.log(changed > 0 ? `\n${changed} module(s) updated; verifying with the drift guard...` : "\nNothing to update; verifying with the drift guard...");
// Pipe + re-emit rather than stdio:"inherit": when this tool is itself run
// under a capturing spawn (e.g. its own test), an inherited grandchild's
// output and exit status do not propagate reliably. Capturing keeps the
// verdict correct in every context.
//
// NODE_TEST_CONTEXT is the test runner's IPC handle: if this tool runs inside
// `node --test` (its own suite) and we let the nested `node --test` inherit
// it, the grandchild tries to speak the parent's reporter protocol instead of
// running, emitting nothing and exiting 0. Strip it so the drift guard runs
// standalone whether or not a test runner is our ancestor.
const driftEnv = { ...process.env };
delete driftEnv.NODE_TEST_CONTEXT;
const drift = spawnSync(process.execPath, ["--test", path.join(ROOT, "tests", "chassis-drift.test.mjs")], {
  cwd: ROOT,
  encoding: "utf8",
  env: driftEnv
});
if (drift.stdout) {
  process.stdout.write(drift.stdout);
}
if (drift.stderr) {
  process.stderr.write(drift.stderr);
}
if (drift.error) {
  console.error(`Could not run the drift guard: ${drift.error.message}`);
  process.exit(1);
}
process.exit(drift.status ?? 1);
