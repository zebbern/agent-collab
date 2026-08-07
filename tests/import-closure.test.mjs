// Import-closure guard for the plugin script trees. Plugin directories must be
// self-contained (each plugin installs alone, so nothing may import across
// plugins/*), the plugins have zero runtime dependencies (node: builtins
// only), and the mirrored chassis must not accumulate dead modules that the
// drift guard would keep pinning forever.
//
// Mechanism: for each plugin, BFS the static-import closure from every
// top-level script in plugins/<p>/scripts/ (the entrypoints Claude Code and
// hooks.json actually invoke). Along the way, flag bare package specifiers,
// relative imports that escape the plugin directory or point at nothing, lib
// modules the closure never reaches, and hook commands whose script is gone.
//
// When this fails:
//   1. A bare specifier means a runtime dependency crept in — inline it or
//      use a node: builtin instead.
//   2. An escaping import means one plugin reached into the other — copy the
//      module into this plugin's lib (the chassis is mirrored, not shared).
//   3. An unreachable lib module is dead chassis — delete it from BOTH
//      plugins (and its PINNED_DIVERGENCE row) or wire it back in; do not
//      exempt it here.
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGINS = ["codex", "cursor", "goal"];

// Extract import specifiers from ESM source without executing it. Comments
// are dropped line by line first: JSDoc type references like
// `@typedef {import("./app-server-protocol")}` are comments, not imports, and
// must not register (their extensionless .d.ts specifiers resolve to no
// file). Covers `import ... from "spec"`, `export ... from "spec"`, bare
// `import "spec"`, and literal dynamic `import("spec")`; dynamic imports of
// computed expressions have no literal specifier and are out of scope.
function extractImportSpecifiers(source) {
  const specifiers = [];
  let inBlockComment = false;
  for (let line of source.split("\n")) {
    if (inBlockComment) {
      const close = line.indexOf("*/");
      if (close === -1) continue;
      line = line.slice(close + 2);
      inBlockComment = false;
    }
    // Strip `//` line comments before looking for `/*`: a comment such as
    // "strands every jobs/*.json" must not open a phantom block comment.
    const lineComment = line.indexOf("//");
    if (lineComment !== -1) line = line.slice(0, lineComment);
    let blockOpen;
    while ((blockOpen = line.indexOf("/*")) !== -1) {
      const close = line.indexOf("*/", blockOpen + 2);
      if (close === -1) {
        line = line.slice(0, blockOpen);
        inBlockComment = true;
        break;
      }
      line = line.slice(0, blockOpen) + line.slice(close + 2);
    }
    // `from "spec"` covers import/export statements including multi-line
    // forms, whose closing `} from "./x.mjs";` lands on its own line.
    for (const match of line.matchAll(/\bfrom\s+["']([^"']+)["']/g)) {
      specifiers.push(match[1]);
    }
    const bare = line.match(/^\s*import\s+["']([^"']+)["']/);
    if (bare) specifiers.push(bare[1]);
    for (const match of line.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g)) {
      specifiers.push(match[1]);
    }
  }
  return specifiers;
}

function repoLabel(file) {
  return path.relative(ROOT, file).replaceAll(path.sep, "/");
}

// Same escape check as the session-transfer containment guard: a resolved
// path is inside the plugin iff its relative form neither climbs out nor
// lands on another root.
function escapesDirectory(dir, resolved) {
  const relative = path.relative(dir, resolved);
  return relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
}

function scanPlugin(plugin) {
  const pluginRoot = path.join(ROOT, "plugins", plugin);
  const scriptsDir = path.join(pluginRoot, "scripts");
  const entrypoints = fs
    .readdirSync(scriptsDir)
    .filter((entry) => entry.endsWith(".mjs") && fs.statSync(path.join(scriptsDir, entry)).isFile())
    .map((entry) => path.join(scriptsDir, entry));
  assert.notEqual(entrypoints.length, 0, `no entrypoint scripts found in plugins/${plugin}/scripts`);

  const bareSpecifiers = [];
  const brokenRelative = [];
  const reachable = new Set();
  const queue = [...entrypoints];
  while (queue.length > 0) {
    const file = queue.shift();
    if (reachable.has(file)) continue;
    reachable.add(file);
    const label = repoLabel(file);
    for (const specifier of extractImportSpecifiers(fs.readFileSync(file, "utf8"))) {
      if (!specifier.startsWith("./") && !specifier.startsWith("../")) {
        if (!specifier.startsWith("node:")) {
          bareSpecifiers.push(`  ${label} imports "${specifier}"`);
        }
        continue;
      }
      const resolved = path.resolve(path.dirname(file), specifier);
      if (escapesDirectory(pluginRoot, resolved)) {
        brokenRelative.push(`  ${label} imports "${specifier}" — resolves outside plugins/${plugin}`);
        continue;
      }
      if (!fs.existsSync(resolved)) {
        brokenRelative.push(`  ${label} imports "${specifier}" — no such file`);
        continue;
      }
      if (resolved.endsWith(".mjs")) queue.push(resolved);
    }
  }

  const libDir = path.join(scriptsDir, "lib");
  const unreachableLib = fs
    .readdirSync(libDir)
    .filter((entry) => entry.endsWith(".mjs"))
    .map((entry) => path.join(libDir, entry))
    .filter((file) => !reachable.has(file))
    .map((file) => `  ${repoLabel(file)}`);

  return { bareSpecifiers, brokenRelative, unreachableLib };
}

const scans = new Map();
function scanFor(plugin) {
  if (!scans.has(plugin)) scans.set(plugin, scanPlugin(plugin));
  return scans.get(plugin);
}

test("plugin scripts import only node: builtins — no bare package specifiers", () => {
  const problems = PLUGINS.flatMap((plugin) => scanFor(plugin).bareSpecifiers);
  assert.equal(
    problems.length,
    0,
    `Bare import specifiers in plugin scripts:\n${problems.join("\n")}\n` +
      "The plugins have zero runtime dependencies — use a node: builtin or inline the code."
  );
});

test("every relative import resolves to a file inside its own plugin", () => {
  const problems = PLUGINS.flatMap((plugin) => scanFor(plugin).brokenRelative);
  assert.equal(
    problems.length,
    0,
    `Relative imports that escape their plugin or resolve to nothing:\n${problems.join("\n")}\n` +
      "Plugin directories are self-contained — copy the module into this plugin's lib instead of importing across plugins/*."
  );
});

test("every chassis lib module is reachable from the plugin entrypoints", () => {
  const problems = PLUGINS.flatMap((plugin) => scanFor(plugin).unreachableLib);
  assert.equal(
    problems.length,
    0,
    `Dead chassis modules (no import path from any top-level script):\n${problems.join("\n")}\n` +
      "Wire the module back in, or delete it from BOTH plugins along with its PINNED_DIVERGENCE row in tests/chassis-drift.test.mjs."
  );
});

test("hook commands point at scripts that exist inside the plugin", () => {
  const problems = [];
  for (const plugin of PLUGINS) {
    const pluginRoot = path.join(ROOT, "plugins", plugin);
    const hooksFile = path.join(pluginRoot, "hooks", "hooks.json");
    if (!fs.existsSync(hooksFile)) continue; // cursor ships no hooks.json
    const commands = [];
    (function collect(node) {
      if (Array.isArray(node)) {
        for (const item of node) collect(item);
        return;
      }
      if (node && typeof node === "object") {
        if (typeof node.command === "string") commands.push(node.command);
        for (const value of Object.values(node)) collect(value);
      }
    })(JSON.parse(fs.readFileSync(hooksFile, "utf8")));
    assert.notEqual(commands.length, 0, `plugins/${plugin}/hooks/hooks.json declares no commands`);
    for (const command of commands) {
      const references = [...command.matchAll(/\$\{CLAUDE_PLUGIN_ROOT\}([^"']+)/g)];
      if (references.length === 0) {
        problems.push(`  plugins/${plugin} hook command has no \${CLAUDE_PLUGIN_ROOT} script path: ${command}`);
        continue;
      }
      for (const [, scriptPath] of references) {
        const resolved = path.join(pluginRoot, ...scriptPath.split("/"));
        if (escapesDirectory(pluginRoot, resolved)) {
          problems.push(`  plugins/${plugin} hook command escapes the plugin root: ${command}`);
        } else if (!fs.existsSync(resolved)) {
          problems.push(`  plugins/${plugin} hook command points at a missing script: ${command}`);
        }
      }
    }
  }
  assert.equal(
    problems.length,
    0,
    `Hook commands with broken script paths:\n${problems.join("\n")}\n` +
      "Hooks run from the installed plugin root — every referenced script must exist under it."
  );
});
