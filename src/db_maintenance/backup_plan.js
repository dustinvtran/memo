/**
 * @file The rules that decide how snapshots are named and which of them a
 * retention policy keeps. Pure and dependency-free, so it can be unit tested
 * without a database or a filesystem — see backup_plan.test.js.
 *
 * The I/O lives in backup_database.js and restore_backup.js.
 */

/** Snapshot directories are named so that a lexical sort is a chronological
 * sort, and so that the name is legal on Windows (no colons). */
const SNAPSHOT_PREFIX = "snapshot-";

/** @type {(date: Date) => string} */
const snapshotDirName = (date) =>
  `${SNAPSHOT_PREFIX}${date.toISOString().replace(/[:.]/g, "-")}`;

/**
 * The inverse of snapshotDirName. Returns undefined for anything that isn't
 * one of our snapshot directories, which is what keeps the pruner from ever
 * deleting a directory it doesn't recognise.
 * @type {(name: string) => Date | undefined}
 */
const parseSnapshotDate = (name) => {
  if (!name.startsWith(SNAPSHOT_PREFIX)) return undefined;
  const stamp = name.slice(SNAPSHOT_PREFIX.length);
  const iso = stamp.replace(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/,
    "$1-$2-$3T$4:$5:$6.$7Z"
  );
  if (iso === stamp) return undefined;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? undefined : date;
};

/**
 * Grandfather-father-son retention: every snapshot from the last `days`, then
 * the newest snapshot of each of the `weeks` most recent weeks that have one,
 * and of the `months` most recent months that have one.
 *
 * The budgets count weeks and months that actually contain a snapshot, not
 * calendar time, so a gap in the history doesn't shorten how far back the
 * policy reaches — what is bounded is the number of snapshots kept, not their
 * age. The newest snapshot is always kept whatever the policy says, so a run
 * can never leave us with nothing.
 */
const DEFAULT_POLICY = { days: 14, weeks: 8, months: 12 };

/**
 * @typedef {{ days: number, weeks: number, months: number }} RetentionPolicy
 * @typedef {{ keep: string[], remove: string[], unrecognised: string[] }} PruningPlan
 * @type {(names: string[], policy?: Partial<RetentionPolicy>, now?: Date) => PruningPlan}
 */
const planPruning = (names, policy = {}, now = new Date()) => {
  const { days, weeks, months } = { ...DEFAULT_POLICY, ...policy };

  const unrecognised = names.filter((name) => !parseSnapshotDate(name));
  const snapshots = names
    .map((name) => ({ name, date: parseSnapshotDate(name) }))
    .filter((snapshot) => snapshot.date)
    // Newest first: every rule below keeps the first snapshot it sees.
    .sort((a, b) => b.date.getTime() - a.date.getTime());

  const kept = new Set();

  if (snapshots[0]) kept.add(snapshots[0].name);

  const cutoff = now.getTime() - days * DAY_MS;
  snapshots
    .filter(({ date }) => date.getTime() >= cutoff)
    .forEach(({ name }) => kept.add(name));

  newestPerBucket(snapshots, weekKey, weeks).forEach((name) => kept.add(name));
  newestPerBucket(snapshots, monthKey, months).forEach((name) => kept.add(name));

  return {
    keep: snapshots.filter(({ name }) => kept.has(name)).map(({ name }) => name),
    remove: snapshots
      .filter(({ name }) => !kept.has(name))
      .map(({ name }) => name),
    unrecognised,
  };
};

module.exports = {
  SNAPSHOT_PREFIX,
  DEFAULT_POLICY,
  snapshotDirName,
  parseSnapshotDate,
  planPruning,
};

///////////////////////////////////////////////////////////////////////////////

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Walks the (newest first) snapshots, keeping the first one of each bucket
 * until `limit` buckets have been seen. Buckets with no snapshot in them
 * simply don't count towards the limit, so a gap in the history doesn't
 * shorten how far back the policy reaches.
 * @type {(snapshots: {name: string, date: Date}[], keyOf: (d: Date) => string, limit: number) => string[]}
 */
const newestPerBucket = (snapshots, keyOf, limit) => {
  const seen = new Map();
  for (const { name, date } of snapshots) {
    const key = keyOf(date);
    if (!seen.has(key)) {
      if (seen.size >= limit) break;
      seen.set(key, name);
    }
  }
  return [...seen.values()];
};

/** The Monday-based week the date falls in, as `YYYY-MM-DD` of that Monday. */
const weekKey = (date) => {
  const monday = new Date(date.getTime());
  monday.setUTCHours(0, 0, 0, 0);
  // getUTCDay() is 0 on Sunday, which belongs to the week that started 6 days
  // earlier rather than to the one starting the next day.
  const daysSinceMonday = (monday.getUTCDay() + 6) % 7;
  monday.setUTCDate(monday.getUTCDate() - daysSinceMonday);
  return monday.toISOString().slice(0, 10);
};

const monthKey = (date) => date.toISOString().slice(0, 7);
