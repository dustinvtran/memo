#!/usr/bin/env node
/**
 * @file Takes a timestamped snapshot of the whole database and prunes old
 * snapshots according to a retention policy, so there is a *history* of
 * backups to go back to rather than a single overwritten dump.
 *
 * A snapshot is a directory of one JSON file per collection plus a
 * `manifest.json` holding the document counts and a SHA-256 of each file, so
 * restore_backup.js can tell a truncated or edited snapshot from a good one.
 *
 * Every collection in the database is dumped, discovered at runtime — a
 * collection added later is backed up without anyone remembering to add it
 * to a list here.
 *
 * Usage:
 *   node scripts/backup_database.js
 *   node scripts/backup_database.js --out=./backups --keep-days=30
 *   node scripts/backup_database.js --list
 *   node scripts/backup_database.js --prune-only
 *
 * Flags:
 *   --out=path          where snapshots live (default ../backups)
 *   --only=a,b          only these collections (default: all of them)
 *   --keep-days=N       keep every snapshot from the last N days (default 14)
 *   --keep-weeks=N      then the newest of each of the last N weeks (default 8)
 *   --keep-months=N     then the newest of each of the last N months (default 12)
 *   --no-prune          take the snapshot, delete nothing
 *   --prune-only        apply the retention policy without taking a snapshot
 *   --list              list the snapshots already taken and exit
 */
require("../env");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { MongoClient, ServerApiVersion } = require("mongodb");
const { parseArgs } = require("../work_collections");
const {
  DEFAULT_POLICY,
  snapshotDirName,
  parseSnapshotDate,
  planPruning,
} = require("../backup_plan");
const {
  MANIFEST_FILE,
  checkSnapshot,
} = require("../backup_verification");

const optionsFrom = (args) => ({
  outDir: String(args.out ?? path.join(__dirname, "..", "backups")),
  only:
    args.only === undefined || args.only === true
      ? undefined
      : String(args.only).split(","),
  policy: {
    days: numberOr(args["keep-days"], DEFAULT_POLICY.days),
    weeks: numberOr(args["keep-weeks"], DEFAULT_POLICY.weeks),
    months: numberOr(args["keep-months"], DEFAULT_POLICY.months),
  },
  prune: args["no-prune"] !== true,
});

const main = async () => {
  const args = parseArgs(process.argv);
  const options = optionsFrom(args);

  if (args.list === true) {
    listSnapshots(options.outDir);
    return;
  }

  if (args["prune-only"] === true) {
    prune(options.outDir, options.policy);
    return;
  }

  const client = await connect();
  try {
    const snapshot = await writeSnapshot(client.db("memo"), options.outDir, {
      only: options.only,
    });
    console.log(
      `\nSnapshot written to ${snapshot.dir} ` +
        `(${snapshot.manifest.collections.length} collections, ` +
        `${totalDocuments(snapshot.manifest)} documents).`
    );
  } finally {
    await client.close();
  }

  if (options.prune) prune(options.outDir, options.policy);
};

/**
 * Dumps every collection (or the ones named in `only`) into a new snapshot
 * directory and returns where it went, so callers such as the restore script
 * can point at the safety copy they just took.
 * @type {(db: import('mongodb').Db, outDir: string, opts?: { only?: string[], label?: string }) => Promise<{ dir: string, manifest: any }>}
 */
const writeSnapshot = async (db, outDir, { only, label } = {}) => {
  const dir = path.join(outDir, snapshotDirName(new Date()));
  fs.mkdirSync(dir, { recursive: true });

  const names = (await db.listCollections().toArray())
    .map(({ name }) => name)
    .filter((name) => (only ? only.includes(name) : true))
    .sort();

  if (only) {
    only
      .filter((name) => !names.includes(name))
      .forEach((name) =>
        console.warn(`Warning: --only names ${name}, which is not a collection.`)
      );
  }

  const collections = [];
  for (const name of names) {
    const documents = await db.collection(name).find().toArray();
    const file = `${name}.json`;
    const contents = JSON.stringify(documents);
    fs.writeFileSync(path.join(dir, file), contents);
    console.log(`${String(documents.length).padStart(6)}  ${name}`);
    collections.push({
      name,
      file,
      documents: documents.length,
      bytes: Buffer.byteLength(contents),
      sha256: sha256(contents),
    });
  }

  const manifest = {
    createdAt: new Date().toISOString(),
    database: db.databaseName,
    ...(label ? { label } : {}),
    collections,
  };
  fs.writeFileSync(
    path.join(dir, MANIFEST_FILE),
    JSON.stringify(manifest, null, 2)
  );

  return { dir, manifest };
};

/** @type {(outDir: string) => string[]} */
const directoryNames = (outDir) =>
  fs.existsSync(outDir)
    ? fs
        .readdirSync(outDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
    : [];

/** Snapshot names sort chronologically, so this is oldest first. */
/** @type {(outDir: string) => string[]} */
const listSnapshotDirs = (outDir) =>
  directoryNames(outDir).filter(parseSnapshotDate).sort();

/** @type {(dir: string) => any} */
const readManifest = (dir) => {
  const file = path.join(dir, MANIFEST_FILE);
  if (!fs.existsSync(file)) return undefined;
  return JSON.parse(fs.readFileSync(file, "utf8"));
};

/**
 * Reports which files of a snapshot don't match the manifest. An empty list
 * means the snapshot is exactly what the backup wrote.
 *
 * The checking is ../backup_verification.js's, so that what a restore refuses
 * and what scripts/verify_backup.js reports are the same rule rather than two
 * copies of it. This is the cheap half: the bytes are hashed, not parsed,
 * since all a restore needs to know before it writes is whether the files
 * changed under it.
 * @type {(dir: string) => string[]}
 */
const verifySnapshot = (dir) => {
  const manifest = readManifest(dir);
  const files = Object.fromEntries(
    (manifest?.collections ?? []).map(({ name, file }) => {
      const contents = path.join(dir, file);
      return [
        name,
        fs.existsSync(contents)
          ? { present: true, sha256: sha256(fs.readFileSync(contents)) }
          : { present: false },
      ];
    })
  );
  return checkSnapshot({ manifest, files }).problems;
};

/**
 * Which snapshot a `--from` names: a path if it looks like one, a name in
 * `dir` otherwise, the newest one if it names nothing. Prints why and sets a
 * failing exit code when it can't answer, so a caller can stop on undefined.
 *
 * Here rather than in the script that asked for it first, because
 * restore_backup.js and verify_backup.js have to resolve `--from` the same
 * way — a drill that verifies one snapshot and restores another would prove
 * nothing.
 * @type {(options: { dir: string, from?: string }) => string | undefined}
 */
const resolveSnapshotDir = ({ dir, from }) => {
  if (from && (from.includes("/") || from.includes("\\"))) {
    if (fs.existsSync(from)) return from;
    console.error(`No such snapshot: ${from}`);
    process.exitCode = 1;
    return undefined;
  }

  const names = listSnapshotDirs(dir);
  if (names.length === 0) {
    console.error(
      `No snapshots in ${dir}. Take one with: node scripts/backup_database.js`
    );
    process.exitCode = 1;
    return undefined;
  }

  // listSnapshotDirs sorts by name, which for snapshot names is chronological.
  const name = from ?? names[names.length - 1];
  if (!names.includes(name)) {
    console.error(`No such snapshot in ${dir}: ${name}`);
    console.error(`Available:\n  ${names.join("\n  ")}`);
    process.exitCode = 1;
    return undefined;
  }

  return path.join(dir, name);
};

const connect = async () => {
  if (!process.env.MONGODB_URL) {
    throw new Error("MONGODB_URL is not set. See the README in this folder.");
  }
  const client = new MongoClient(process.env.MONGODB_URL, {
    serverApi: ServerApiVersion.v1,
  });
  await client.connect();
  return client;
};

module.exports = {
  MANIFEST_FILE,
  writeSnapshot,
  listSnapshotDirs,
  readManifest,
  resolveSnapshotDir,
  verifySnapshot,
  connect,
};

///////////////////////////////////////////////////////////////////////////////

const sha256 = (contents) =>
  crypto.createHash("sha256").update(contents).digest("hex");

const numberOr = (value, fallback) => {
  const parsed = parseInt(String(value), 10);
  return Number.isNaN(parsed) ? fallback : parsed;
};

const totalDocuments = (manifest) =>
  manifest.collections.reduce((total, { documents }) => total + documents, 0);

const listSnapshots = (outDir) => {
  const names = listSnapshotDirs(outDir);
  if (names.length === 0) {
    console.log(`No snapshots in ${outDir}.`);
    return;
  }
  console.log(`Snapshots in ${outDir}:\n`);
  for (const name of names) {
    const manifest = readManifest(path.join(outDir, name));
    const summary = manifest
      ? `${manifest.collections.length} collections, ` +
        `${totalDocuments(manifest)} documents`
      : "no manifest — incomplete snapshot";
    console.log(`  ${name}  (${summary})`);
  }
};

const prune = (outDir, policy) => {
  // Every directory is handed to the planner, not just the ones that parse as
  // snapshots, so that "we never delete what we don't recognise" is something
  // the planner is told about rather than something this caller hides.
  const plan = planPruning(directoryNames(outDir), policy);

  if (plan.unrecognised.length > 0) {
    console.log(
      `\nIgnoring ${plan.unrecognised.length} ` +
        `director${plan.unrecognised.length === 1 ? "y" : "ies"} ` +
        `in ${outDir} that aren't snapshots.`
    );
  }

  if (plan.remove.length === 0) {
    console.log(
      `\nRetention policy (${policy.days}d / ${policy.weeks}w / ` +
        `${policy.months}m) keeps all ${plan.keep.length} snapshots.`
    );
    return;
  }

  console.log(
    `\nRetention policy (${policy.days}d / ${policy.weeks}w / ` +
      `${policy.months}m) keeps ${plan.keep.length} snapshots and removes ` +
      `${plan.remove.length}:`
  );
  for (const name of plan.remove) {
    fs.rmSync(path.join(outDir, name), { recursive: true, force: true });
    console.log(`  removed ${name}`);
  }
};

// Last, so that everything main() reaches is initialised by the time it runs.
if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
