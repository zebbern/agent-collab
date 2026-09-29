import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const JOURNAL = "ledger.jsonl.migration.json";
const SCRATCH = "ledger.jsonl.consolidating";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const isHash = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);

function refuse(reason) {
  throw new Error(`Cannot recover Goal ledger migration: ${reason}. Migration evidence has been preserved.`);
}

function exists(file) {
  try {
    fs.lstatSync(file);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function regularFileExists(file) {
  if (!exists(file)) return false;
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || !stat.isFile()) refuse(`expected a regular file at ${file}`);
  return true;
}

export function readLedgerSnapshot(file) {
  return regularFileExists(file) ? fs.readFileSync(file) : null;
}

function identity(file) {
  // Resolve existing parents too: an absent archive through a directory alias
  // must not collide with another source or with the canonical ledger.
  let resolved = path.resolve(file);
  try {
    resolved = fs.realpathSync.native(resolved);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    try {
      resolved = path.join(fs.realpathSync.native(path.dirname(resolved)), path.basename(resolved));
    } catch (parentError) {
      if (parentError?.code !== "ENOENT") throw parentError;
    }
  }
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function archiveFile(source) {
  return `${source.file}.migrated${source.archiveSuffix === 0 ? "" : `.${source.archiveSuffix}`}`;
}

function exactKeys(value, keys) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}

function validateRecord(directory, record) {
  if (!exactKeys(record, ["version", "directory", "beforeHash", "outputHash", "outputBase64", "sources"]) ||
      record.version !== 1 || record.directory !== path.resolve(directory) ||
      !(record.beforeHash === null || isHash(record.beforeHash)) || !isHash(record.outputHash) ||
      typeof record.outputBase64 !== "string" || !Array.isArray(record.sources) || record.sources.length === 0) {
    refuse("invalid recovery record");
  }
  const output = Buffer.from(record.outputBase64, "base64");
  if (output.toString("base64") !== record.outputBase64 || hash(output) !== record.outputHash) {
    refuse("recovery output does not match its recorded hash");
  }
  const paths = new Set(["ledger.jsonl", JOURNAL, `${JOURNAL}.tmp`, SCRATCH].map((name) => identity(path.join(directory, name))));
  for (const source of record.sources) {
    if (!exactKeys(source, ["file", "hash", "archiveSuffix"]) || typeof source.file !== "string" ||
        !path.isAbsolute(source.file) || path.resolve(source.file) !== source.file ||
        path.basename(source.file) !== "ledger.jsonl" || !/-[a-f0-9]{16}$/.test(path.basename(path.dirname(source.file))) ||
        !isHash(source.hash) || !Number.isSafeInteger(source.archiveSuffix) || source.archiveSuffix < 0) {
      refuse("invalid recovery source");
    }
    for (const file of [source.file, archiveFile(source)]) {
      const key = identity(file);
      if (paths.has(key)) refuse("recovery paths overlap");
      paths.add(key);
    }
  }
  return output;
}

function inspectRecord(directory, record) {
  const target = readLedgerSnapshot(path.join(directory, "ledger.jsonl"));
  const targetHash = target === null ? null : hash(target);
  const published = targetHash === record.outputHash;
  if (!published && targetHash !== record.beforeHash) refuse("canonical ledger changed during migration");
  const pending = [];
  for (const source of record.sources) {
    const original = readLedgerSnapshot(source.file);
    const archived = readLedgerSnapshot(archiveFile(source));
    if (original !== null && archived === null && hash(original) === source.hash) {
      pending.push(source);
    } else if (original === null && archived !== null && hash(archived) === source.hash && published) {
      // This rename already completed. Never import its bytes again.
    } else {
      refuse(`source or archive changed during migration: ${source.file}`);
    }
  }
  return { published, pending };
}

export function hasPendingLedgerMigration(directory) {
  try {
    return exists(path.join(directory, JOURNAL));
  } catch (error) {
    // A file in place of the state directory cannot contain a journal.
    // Let the caller's existing private-directory guard diagnose that case.
    if (error?.code === "ENOTDIR") return false;
    throw error;
  }
}

// Caller validates the private state directory before either entry point.
// The journal is authoritative only there. Paths and hashes also bind it to
// this project and to the exact source snapshots; they are not authorization.
export function recoverLedgerMigration(directory) {
  const journal = path.join(directory, JOURNAL);
  const raw = readLedgerSnapshot(journal);
  if (raw === null) return;
  let record;
  try {
    record = JSON.parse(raw.toString("utf8"));
  } catch {
    refuse("malformed recovery record");
  }
  const output = validateRecord(directory, record);
  const { published, pending } = inspectRecord(directory, record);
  const scratch = path.join(directory, SCRATCH);
  regularFileExists(scratch);
  if (!published) {
    fs.writeFileSync(scratch, output, { mode: 0o600 });
    fs.renameSync(scratch, path.join(directory, "ledger.jsonl"));
  }
  for (const source of pending) fs.renameSync(source.file, archiveFile(source));
  const final = inspectRecord(directory, record);
  if (!final.published || final.pending.length !== 0) refuse("migration did not reach its committed state");
  if (regularFileExists(scratch)) fs.unlinkSync(scratch);
  // A failed unlink leaves the complete record for the next read/append.
  fs.unlinkSync(journal);
}

export function commitLedgerMigration(directory, before, sources, output) {
  if (hasPendingLedgerMigration(directory)) refuse("a migration is already pending");
  const record = {
    version: 1,
    directory: path.resolve(directory),
    beforeHash: before === null ? null : hash(before),
    outputHash: hash(output),
    outputBase64: output.toString("base64"),
    sources: sources.map(({ file, contents }) => {
      const source = { file: path.resolve(file), hash: hash(contents), archiveSuffix: 0 };
      while (exists(archiveFile(source))) source.archiveSuffix += 1;
      return source;
    })
  };
  validateRecord(directory, record);
  inspectRecord(directory, record);
  const journal = path.join(directory, JOURNAL);
  const scratch = `${journal}.tmp`;
  regularFileExists(scratch);
  fs.writeFileSync(scratch, JSON.stringify(record), { mode: 0o600 });
  // The complete immutable plan is visible before any original is replaced.
  fs.renameSync(scratch, journal);
  recoverLedgerMigration(directory);
}
