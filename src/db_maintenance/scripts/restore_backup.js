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
 * Two things it will not do without being told (#465, #466, and the rules
 * themselves are in ../restore_plan.js):
 *
 * - **It skips `apiTokens`** unless `--only` names it. A revoked token is a
 *   document that is missing, so restoring it puts back a credential, not
 *   data.
 * - **It connects only to the host `--target` names**, and that must be the
 *   host `MONGODB_URL` points at. The production host — the one in the `.env`
 *   that ../env.js loads, read from the file so an inline override cannot
 *   hide it — is refused unless `--production` is also passed. Dry runs
 *   included, so a dry run fails exactly where the real run would.
 *
 * Usage:
 *   MONGODB_URL=<scratch> node scripts/restore_backup.js --target=<scratch host>
 *   node scripts/restore_backup.js --target=<host> --production --only=bookEntries,bookReviews
 *   node scripts/restore_backup.js --target=<host> --production  *     --from=snapshot-2024-06-30T04-17-00-000Z --apply
 *
 * Flags:
 *   --target=host       required: the host MONGODB_URL points at, as printed
 *   --production        required as well when that host is production's
 *   --dir=path          where snapshots live (default ../backups)
 *   --from=name|path    which snapshot to restore (default: the newest one)
 *   --only=a,b          only restore these collections (the only way to
 *                       restore apiTokens)
 *   --prune             also delete documents the snapshot doesn't have
 *   --apply             actually write (without it, nothing is written)
 *   --no-safety-backup  don't snapshot the current database first
 *   --skip-verify       restore even if the snapshot fails its checksums
 */
const { envFile } = require("../env");
const fs = require("fs");
const path = require("path");
const dotenv = require("dotenv");
const { parseArgs } = require("../work_collections");
const { planCollections, checkTarget } = require("../restore_plan");
const {
  connect,
  writeSnapshot,
  readManifest,
  resolveSnapshotDir,
  verifySnapshot,
} = require("./backup_database");

const BATCH_SIZE = 500;

const main = async () => {
  const args = parseArgs(process.argv);
  const options = {
    dir: String(args.dir ?? path.join(__dirname, "..", "backups")),
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

  const target = checkTarget({
    target: args.target,
    connectionUrl: process.env.MONGODB_URL,
    productionUrl: productionUrl(),
    envFile,
    production: args.production === true,
  });
  if (target.refusal) {
    console.error(target.refusal);
    process.exitCode = 1;
    return;
  }
  console.log(
    `Target: ${target.host}` + (target.isProduction ? " — PRODUCTION" : "")
  );

  const snapshotDir = resolveSnapshotDir(options);
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

  const { restore: collections, skipped } = planCollections({
    collections: manifest?.collections ?? [],
    only: options.only,
  });
  skipped.forEach(({ name, reason }) =>
    console.log(`${name}: skipped — ${reason}`)
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

/**
 * The MONGODB_URL written in the .env that env.js loads, read from the file
 * itself: dotenv never overwrites a variable already set, so process.env
 * holds an inline override instead and cannot say which host is production.
 */
const productionUrl = () =>
  fs.existsSync(envFile)
    ? dotenv.parse(fs.readFileSync(envFile)).MONGODB_URL
    : undefined;

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
