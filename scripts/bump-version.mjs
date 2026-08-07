#!/usr/bin/env node
// Per-target version bumper. This repo ships three independently-versioned
// plugins (codex, cursor, goal) plus a marketplace repo version of its own —
// there is no longer a single version that applies everywhere, so every
// operation below is scoped to one "target": a plugin name, or the special
// target "repo" for the marketplace repo's own version metadata.
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

const PLUGINS_DIR = "plugins";
const MARKETPLACE_FILE = path.join(".claude-plugin", "marketplace.json");
const REPO_TARGET = "repo";

function usage() {
  return [
    "Usage:",
    "  node scripts/bump-version.mjs <target> <version>",
    "  node scripts/bump-version.mjs --check [<target>]",
    "",
    "<target> is a plugin directory name under plugins/ (e.g. codex, cursor,",
    "goal) or the special target \"repo\", which is this marketplace repo's",
    "own version (package.json + package-lock.json), kept in lockstep with",
    ".claude-plugin/marketplace.json's metadata.version. The marketplace",
    "version is intentionally decoupled from any single plugin's version.",
    "",
    "Options:",
    "  --check         Verify version metadata is internally consistent.",
    "                  With no target, checks every plugin and the repo.",
    "                  With a target, checks only that target.",
    "  --root <dir>    Run against a different repository root.",
    "  --help          Print this help."
  ].join("\n");
}

function parseArgs(argv) {
  const options = {
    check: false,
    root: process.cwd(),
    help: false,
    positionals: []
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === "--check") {
      options.check = true;
    } else if (arg === "--root") {
      const root = argv[i + 1];
      if (!root) {
        throw new Error("--root requires a directory.");
      }
      options.root = root;
      i += 1;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`);
    } else {
      options.positionals.push(arg);
    }
  }

  options.root = path.resolve(options.root);

  if (options.check) {
    if (options.positionals.length > 1) {
      throw new Error(`Unexpected extra argument: ${options.positionals[1]}`);
    }
    options.target = options.positionals[0] ?? null;
    options.version = null;
  } else {
    if (options.positionals.length > 2) {
      throw new Error(`Unexpected extra argument: ${options.positionals[2]}`);
    }
    options.target = options.positionals[0] ?? null;
    options.version = options.positionals[1] ?? null;
  }

  return options;
}

function validateVersion(version) {
  if (!VERSION_PATTERN.test(version)) {
    throw new Error(`Expected a semver-like version such as 1.0.3, got: ${version}`);
  }
}

function requireObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Expected ${label} to be an object.`);
  }
}

function readJson(root, file) {
  const filePath = path.join(root, file);
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(root, file, json) {
  const filePath = path.join(root, file);
  fs.writeFileSync(filePath, `${JSON.stringify(json, null, 2)}\n`);
}

function getMarketplacePluginVersion(json, pluginName) {
  return json.plugins?.find((entry) => entry?.name === pluginName)?.version;
}

function setMarketplacePluginVersion(json, pluginName, version) {
  const plugin = json.plugins?.find((entry) => entry?.name === pluginName);
  requireObject(plugin, `.claude-plugin/marketplace.json plugins[${pluginName}]`);
  plugin.version = version;
}

// A plugin target ties together exactly two sites: the plugin's own
// plugin.json and its entry in the shared marketplace.json. Both must carry
// the same version.
function pluginTarget(pluginName) {
  return {
    name: pluginName,
    files: [
      {
        file: path.join(PLUGINS_DIR, pluginName, ".claude-plugin", "plugin.json"),
        values: [
          {
            label: "version",
            get: (json) => json.version,
            set: (json, version) => {
              json.version = version;
            }
          }
        ]
      },
      {
        file: MARKETPLACE_FILE,
        values: [
          {
            label: `plugins[${pluginName}].version`,
            get: (json) => getMarketplacePluginVersion(json, pluginName),
            set: (json, version) => setMarketplacePluginVersion(json, pluginName, version)
          }
        ]
      }
    ]
  };
}

// The "repo" target is this marketplace repo's own version: package.json and
// package-lock.json (both version sites) are the source of truth, and
// marketplace.json's metadata.version — the MARKETPLACE's version, not any
// plugin's — is kept in lockstep with them here rather than tied to the
// codex plugin's version as it was before this rework.
function repoTarget() {
  return {
    name: REPO_TARGET,
    files: [
      {
        file: "package.json",
        values: [
          {
            label: "version",
            get: (json) => json.version,
            set: (json, version) => {
              json.version = version;
            }
          }
        ]
      },
      {
        file: "package-lock.json",
        values: [
          {
            label: "version",
            get: (json) => json.version,
            set: (json, version) => {
              json.version = version;
            }
          },
          {
            label: "packages[\"\"].version",
            get: (json) => json.packages?.[""]?.version,
            set: (json, version) => {
              requireObject(json.packages?.[""], "package-lock.json packages[\"\"]");
              json.packages[""].version = version;
            }
          }
        ]
      },
      {
        file: MARKETPLACE_FILE,
        values: [
          {
            label: "metadata.version",
            get: (json) => json.metadata?.version,
            set: (json, version) => {
              requireObject(json.metadata, ".claude-plugin/marketplace.json metadata");
              json.metadata.version = version;
            }
          }
        ]
      }
    ]
  };
}

function discoverPluginNames(root) {
  const pluginsDir = path.join(root, PLUGINS_DIR);
  let entries;
  try {
    entries = fs.readdirSync(pluginsDir, { withFileTypes: true });
  } catch {
    return [];
  }

  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => fs.existsSync(path.join(pluginsDir, name, ".claude-plugin", "plugin.json")))
    .sort();
}

function buildTargets(root) {
  const targets = new Map();
  targets.set(REPO_TARGET, repoTarget());
  for (const name of discoverPluginNames(root)) {
    targets.set(name, pluginTarget(name));
  }
  return targets;
}

function resolveTarget(targets, name) {
  const target = targets.get(name);
  if (!target) {
    const known = [...targets.keys()].sort().join(", ");
    throw new Error(`Unknown target: ${name}. Known targets: ${known}.`);
  }
  return target;
}

// A target is internally consistent when every (file, label) site it owns
// reports the same version string, and that string is a valid version.
function checkTarget(root, target) {
  const readings = target.files.flatMap((fileSpec) => {
    const json = readJson(root, fileSpec.file);
    return fileSpec.values.map((value) => ({
      file: fileSpec.file,
      label: value.label,
      value: value.get(json)
    }));
  });

  const distinctValues = new Set(readings.map((reading) => reading.value));
  if (distinctValues.size > 1) {
    const detail = readings.map((reading) => `${reading.file} ${reading.label}=${reading.value ?? "<missing>"}`).join(", ");
    return [`${target.name}: version metadata disagrees: ${detail}`];
  }

  const [value] = distinctValues;
  if (typeof value !== "string" || !VERSION_PATTERN.test(value)) {
    const [reading] = readings;
    return [`${reading.file} ${reading.label}: expected a valid version, found ${value ?? "<missing>"}`];
  }

  return [];
}

function bumpTarget(root, target, version) {
  const changedFiles = [];

  for (const fileSpec of target.files) {
    const json = readJson(root, fileSpec.file);
    const before = JSON.stringify(json);

    for (const value of fileSpec.values) {
      value.set(json, version);
    }

    if (JSON.stringify(json) !== before) {
      writeJson(root, fileSpec.file, json);
      if (!changedFiles.includes(fileSpec.file)) {
        changedFiles.push(fileSpec.file);
      }
    }
  }

  return changedFiles;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }

  const targets = buildTargets(options.root);

  if (options.check) {
    const selected = options.target ? [resolveTarget(targets, options.target)] : [...targets.values()];
    const mismatches = selected.flatMap((target) => checkTarget(options.root, target));
    if (mismatches.length > 0) {
      throw new Error(`Version metadata is out of sync:\n${mismatches.join("\n")}`);
    }
    const label = options.target ? `target "${options.target}"` : "all targets";
    console.log(`Version metadata is consistent for ${label}.`);
    return;
  }

  if (!options.target || !options.version) {
    throw new Error(`Missing target and/or version.\n\n${usage()}`);
  }
  validateVersion(options.version);
  const target = resolveTarget(targets, options.target);

  const changedFiles = bumpTarget(options.root, target, options.version);
  const touched = changedFiles.length > 0 ? changedFiles.join(", ") : "no files changed";
  console.log(`Set ${options.target} version metadata to ${options.version}: ${touched}.`);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
