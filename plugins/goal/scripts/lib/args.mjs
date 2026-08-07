import path from "node:path";

/**
 * Minimal argv parser shared by every goal-companion subcommand. Unknown
 * options are refused loudly rather than ignored: a typo like --dispositon
 * must never silently drop a disposition.
 */
export function parseCommandInput(argv, { valueOptions = [], booleanOptions = [] } = {}) {
  const options = {};
  const positionals = [];
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "-C") {
      const value = argv[i + 1];
      if (value === undefined) {
        throw new Error("-C requires a value");
      }
      options.cwd = value;
      i += 1;
      continue;
    }
    if (token.startsWith("--")) {
      const name = token.slice(2);
      if (booleanOptions.includes(name)) {
        options[name] = true;
        continue;
      }
      if (valueOptions.includes(name)) {
        const value = argv[i + 1];
        if (value === undefined) {
          throw new Error(`--${name} requires a value`);
        }
        options[name] = value;
        i += 1;
        continue;
      }
      throw new Error(`Unknown option: ${token}`);
    }
    positionals.push(token);
  }
  return { options, positionals };
}

export function resolveCommandCwd(options) {
  return path.resolve(options.cwd ?? process.cwd());
}
