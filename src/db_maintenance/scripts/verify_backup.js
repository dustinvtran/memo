#!/usr/bin/env node
/**
 * @file Read-only check that a snapshot is still what backup_database.js
 * wrote: every collection the manifest lists present on disk, hashing to the
 * `sha256` recorded for it, and holding the number of documents claimed.
 *
 * There is no `--apply` to have. It never writes, never deletes and never
 * restores anything — it reads a directory, and with `--live` it counts
 * documents. CLAUDE.md asks for a snapshot to be verified before every
 * `--apply`; this is that check, so it stops being retyped by hand each time.
 *
 * Exits non-zero if the manifest and the files disagree, so it can gate a
 * scheduled backup or a restore drill.
 *
 * Usage:
 *   node scripts/verify_backup.js                       # the newest snapshot
 *   node scripts/verify_backup.js --from=snapshot-2026-08-26T07-27-44-541Z
 *   node scripts/verify_backup.js --live                # also count the database
 *
 * Flags:
 *   --dir=path     where snapshots live (default ../backups)
 *   --from=name    which snapshot to check (default: the newest one)
 *   --live         also report countDocuments() beside each, so drift since
 *                  the snapshot is visible. Needs MONGODB_URL; the rest of
 *                  this script needs nothing but the files.
 */
require("../env");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { parseArgs } = require("../work_collections");
const { checkSnapshot, formatVerification } = require("../backup_verification");
const {
  MANIFEST_FILE,
  readManifest,
  resolveSnapshotDir,
  connect,
} = require("./backup_database");

const DATABASE = "memo";

const main = async () => {
  const args = parseArgs(process.argv);
  const options = {
    dir: String(args.dir ?? path.join(__dirname, "..", "backups")),
    from: args.from === undefined || args.from === true ? undefined : String(args.from),
    live: args.live === true,
  };

  const snapshotDir = resolveSnapshotDir(options);
  if (!snapshotDir) return;

  const manifest = readManifest(snapshotDir);

  console.log(
    `Verifying ${snapshotDir}` +
      (manifest?.createdAt ? `\ntaken ${manifest.createdAt}` : "") +
      (manifest?.label ? ` (${manifest.label})` : "") +
      " — read-only, nothing is written.\n"
  );

  const verification = checkSnapshot({
    manifest,
    files: observeFiles(snapshotDir, manifest),
    unlisted: unlistedFiles(snapshotDir, manifest),
    live: options.live ? await liveCounts() : undefined,
  });

  console.log(formatVerification(verification).join("\n"));

  if (!options.live) {
    console.log(
      "\nCounted the files only. Pass --live to count the database too, " +
        "which needs MONGODB_URL."
    );
  }

  if (!verification.ok) process.exitCode = 1;
};

/**
 * What is actually on disk for each collection the manifest lists. Reading
 * and hashing happen here; whether any of it is *wrong* is decided by
 * ../backup_verification.js, which a test can reach without a filesystem.
 * @type {(dir: string, manifest: any) => Record<string, any>}
 */
const observeFiles = (dir, manifest) =>
  Object.fromEntries(
    (manifest?.collections ?? []).map(({ name, file }) => [
      name,
      observe(path.join(dir, file)),
    ])
  );

const observe = (file) => {
  if (!fs.existsSync(file)) return { present: false };
  let contents;
  try {
    contents = fs.readFileSync(file);
  } catch (error) {
    return { present: true, error: error.message };
  }

  // Hashed before it is parsed, and over the bytes rather than over anything
  // re-serialised: the digest has to answer "are these the same bytes the
  // backup wrote", which a round trip through JSON would stop answering.
  const sha256 = crypto.createHash("sha256").update(contents).digest("hex");

  let documents;
  try {
    documents = JSON.parse(contents);
  } catch (error) {
    return { present: true, sha256, error: error.message };
  }
  if (!Array.isArray(documents)) {
    return { present: true, sha256, error: "not a list of documents" };
  }

  return {
    present: true,
    sha256,
    documents: documents.length,
    bytes: contents.length,
  };
};

/**
 * Files sitting in the snapshot directory that the manifest doesn't account
 * for. Not a failure — the manifest is what a restore reads, so a stray file
 * changes nothing — but a snapshot that grew a file is worth seeing.
 * @type {(dir: string, manifest: any) => string[]}
 */
const unlistedFiles = (dir, manifest) => {
  const listed = new Set([
    MANIFEST_FILE,
    ...(manifest?.collections ?? []).map(({ file }) => file),
  ]);
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && !listed.has(entry.name))
    .map((entry) => entry.name)
    .sort();
};

/** @type {() => Promise<Record<string, number>>} */
const liveCounts = async () => {
  const client = await connect();
  try {
    const db = client.db(DATABASE);
    const names = (await db.listCollections().toArray()).map(({ name }) => name);
    const counts = {};
    for (const name of names) {
      counts[name] = await db.collection(name).countDocuments();
    }
    return counts;
  } finally {
    await client.close();
  }
};

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
