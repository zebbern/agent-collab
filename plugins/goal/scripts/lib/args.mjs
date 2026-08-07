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
    if (token === "--") {
      positionals.push(token);
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
    // Any remaining "-"-prefixed token (a short flag other than -C, e.g. a
    // typo like -x) is refused rather than silently absorbed as positional
    // data. Safe to do unconditionally: no goal-companion argument is ever a
    // negative number, so this can never misclassify real positional input.
    if (token.startsWith("-")) {
      throw new Error(`Unknown option: ${token}`);
    }
    positionals.push(token);
  }
  return { options, positionals };
}

export function resolveCommandCwd(options) {
  return path.resolve(options.cwd ?? process.cwd());
}
