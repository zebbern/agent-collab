// Doc and manifest pins for the goal plugin, mirroring the discipline of
// tests/cursor-skills.test.mjs: the manifests, commands, and skill carry
// contracts that must not drift silently.
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN = path.join(ROOT, "plugins", "goal");

function read(relative) {
  return fs.readFileSync(path.join(PLUGIN, relative), "utf8");
}

test("goal plugin manifest and marketplace entry agree", () => {
  const plugin = JSON.parse(read(path.join(".claude-plugin", "plugin.json")));
  assert.equal(plugin.name, "goal");
  assert.equal(plugin.version, "0.1.0");
  assert.match(plugin.description, /long-horizon/i);

  const marketplace = JSON.parse(
    fs.readFileSync(path.join(ROOT, ".claude-plugin", "marketplace.json"), "utf8")
  );
  const entry = marketplace.plugins.find((candidate) => candidate.name === "goal");
  assert.ok(entry, "marketplace.json has no goal entry");
  assert.equal(entry.version, "0.1.0");
  assert.equal(entry.source, "./plugins/goal");
});

test("goal plugin ships license and changelog", () => {
  assert.match(read("LICENSE"), /Apache License/);
  assert.match(read("CHANGELOG.md"), /## 0\.1\.0/);
});
