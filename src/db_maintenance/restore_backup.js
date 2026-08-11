#!/usr/bin/env node
/**
 * @file Restores the database from a snapshot taken by backup_database.js.
 *
 * It is a **dry run unless you pass `--apply`**, it verifies the snapshot
 * against its manifest before touching anything, and it takes a fresh
 * snapshot of the current database first — so a restore is itself
 * recoverable.
 *
 * Documents are restored by `_id`: a document in the snapshot is written over
 * whatever the database holds under that id, and a document the database has
 * but the snapshot doesn't is left alone unless you pass `--prune`. That
 * default is deliberate: the common case is recovering something that was
 * overwritten or deleted, not rewinding the whole database.
 *
 * Usage:
 *   node restore_backup.js                                  # dry run, latest snapshot
 *   node restore_backup.js --only=bookEntries,bookReviews
 *   node restore_backup.js --from=snapshot-2024-06-30T04-17-00-000Z --apply
 *
 * Flags:
 *   --dir=path          where snapshots live (default ./backups)
 *   --from=name|path    which snapshot to restore (default: the newest one)
 *   --only=a,b          only restore these collections
 *   --prune             also delete documents the snapshot doesn't have
 *   --apply             actually write (without it, nothing is written)
 *   --no-safety-backup  don't snapshot the current database first
 *   --skip-verify       restore even if the snapshot fails its checksums
 */
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { parseArgs } = require("./work_collections");
const {
  connect,
  writeSnapshot,
  listSnapshotDirs,
  readManifest,
  verifySnapshot,
} = require("./backup_database");

const BATCH_SIZE = 500;

const main = async () => {
  const args = parseArgs(process.argv);
  const options = {
    dir: String(args.dir ?? path.join(__dirname, "backups")),
    from: args.from === undefined || args.from === true ? undefined : String(args.from),
    only:
      args.only === undefined || args.only === true
        ? undefined
        : String(args.only).split(","),
    prune: args.prune === true,
    apply: args.apply === true,
    safetyBackup: args["no-safety-backup"] !== true,
    verify: args["skip-verify"] !== true,
  };

  const snapshotDir = resolveSnapshot(options);
  if (!snapshotDir) return;

  const manifest = readManifest(snapshotDir);
  console.log(
    `Restoring from ${snapshotDir}` +
      (manifest ? ` (taken ${manifest.createdAt})` : "") +
      (options.apply ? "" : " — DRY RUN, pass --apply to write")
  );

  const problems = verifySnapshot(snapshotDir);
  if (problems.length > 0) {
    problems.forEach((problem) => console.error(`  ${problem}`));
    if (options.verify) {
      console.error(
        "\nRefusing to restore a snapshot that doesn't match its manifest. " +
          "Pass --skip-verify if you are sure."
      );
      process.exitCode = 1;
      return;
    }
    console.warn("\n--skip-verify given, continuing anyway.\n");
  }

  const collections = (manifest?.collections ?? []).filter(({ name }) =>
    options.only ? options.only.includes(name) : true
  );

  if (collections.length === 0) {
    console.error("Nothing to restore: no collection matched.");
    process.exitCode = 1;
    return;
  }

  const client = await connect();
  try {
    const db = client.db("memo");

    if (options.apply && options.safetyBackup) {
      const safety = await writeSnapshot(db, options.dir, {
        only: collections.map(({ name }) => name),
        label: `taken before restoring ${path.basename(snapshotDir)}`,
      });
      console.log(`\nSafety snapshot of the current data: ${safety.dir}\n`);
    }

    for (const collection of collections) {
      await restoreCollection(db, snapshotDir, collection, options);
    }
  } finally {
    await client.close();
  }

  if (!options.apply) {
    console.log("\nDry run — nothing was written. Re-run with --apply.");
  }
};

const restoreCollection = async (db, snapshotDir, { name, file }, options) => {
  const documents = JSON.parse(
    fs.readFileSync(path.join(snapshotDir, file), "utf8")
  );
  const existing = await db.collection(name).find().toArray();
  const existingById = new Map(existing.map((doc) => [doc._id, doc]));

  const toInsert = documents.filter(({ _id }) => !existingById.has(_id));
  const toUpdate = documents.filter(
    ({ _id, ...rest }) =>
      existingById.has(_id) &&
      stableStringify({ ...rest, _id }) !==
        stableStringify(existingById.get(_id))
  );
  const snapshotIds = new Set(documents.map(({ _id }) => _id));
  const extra = existing.filter(({ _id }) => !snapshotIds.has(_id));

  console.log(
    `${name}: ${toInsert.length} to restore, ${toUpdate.length} to overwrite, ` +
      `${documents.length - toInsert.length - toUpdate.length} unchanged, ` +
      `${extra.length} in the database but not in the snapshot` +
      (extra.length > 0 && !options.prune ? " (left alone)" : "")
  );

  if (!options.apply) return;

  const writes = [
    ...[...toInsert, ...toUpdate].map((doc) => ({
      replaceOne: { filter: { _id: doc._id }, replacement: doc, upsert: true },
    })),
    ...(options.prune
      ? extra.map(({ _id }) => ({ deleteOne: { filter: { _id } } }))
      : []),
  ];

  for (let i = 0; i < writes.length; i += BATCH_SIZE) {
    await db.collection(name).bulkWrite(writes.slice(i, i + BATCH_SIZE));
  }

  console.log(
    `  wrote ${toInsert.length + toUpdate.length} documents` +
      (options.prune ? `, deleted ${extra.length}` : "")
  );
};

/** @type {(options: { dir: string, from?: string }) => string | undefined} */
const resolveSnapshot = ({ dir, from }) => {
  if (from && (from.includes("/") || from.includes("\\"))) {
    if (fs.existsSync(from)) return from;
    console.error(`No such snapshot: ${from}`);
    process.exitCode = 1;
    return undefined;
  }

  const names = listSnapshotDirs(dir);
  if (names.length === 0) {
    console.error(
      `No snapshots in ${dir}. Take one with: node backup_database.js`
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

/** Key order is not meaningful in a document, so it must not count as a diff. */
const stableStringify = (value) => {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
};

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
