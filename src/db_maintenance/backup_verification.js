/**
 * @file Decides whether a snapshot still is what the backup wrote: every
 * collection the manifest lists present on disk, the bytes hashing to the
 * `sha256` recorded for them, and the file holding the number of documents
 * the manifest claims.
 *
 * Pure and dependency-free. The reading, the hashing and the live
 * `countDocuments()` live in scripts/verify_backup.js, which passes in what
 * it observed and prints what comes back — the same split as backup_plan.js,
 * and what lets the rule run in the no-install suite
 * (./backup_verification.test.js).
 *
 * The `sha256` is the check worth having. A count matches a count whether the
 * file is the one the backup wrote or a re-serialisation of it, and a file on
 * a filesystem this repo already distrusts — see the root CLAUDE.md on Google
 * Drive — can lose bytes without losing its shape. Counts answer "is this the
 * right amount of data", the digest answers "is this the same data", and only
 * the second one catches a snapshot that was quietly truncated or edited.
 *
 * Live counts are drift, not damage: the database is expected to have moved
 * on since the snapshot, so they are reported and never counted as a problem.
 */

/**
 * What the caller observed about one collection's file. Every field is
 * optional because each says something different when it is missing:
 * `present: false` is a file that isn't there, an absent `sha256` is a file
 * that couldn't be hashed, and an absent `documents` is a file that wasn't
 * parsed — which is the cheap path backup_database.js takes when all it wants
 * to know is whether the bytes changed.
 *
 * @typedef {{
 *   present?: boolean,
 *   sha256?: string,
 *   documents?: number,
 *   bytes?: number,
 *   error?: string,
 * }} FileObservation
 *
 * @typedef {{
 *   name: string,
 *   file: string,
 *   manifestDocuments: number | undefined,
 *   fileDocuments: number | undefined,
 *   liveDocuments: number | undefined,
 *   drift: number | undefined,
 *   checksum: "ok" | "differs" | "unknown",
 *   problems: string[],
 * }} VerificationRow
 *
 * @typedef {{
 *   rows: VerificationRow[],
 *   problems: string[],
 *   warnings: string[],
 *   ok: boolean,
 *   hasLive: boolean,
 * }} Verification
 */

const MANIFEST_FILE = "manifest.json";

/**
 * @type {(input: {
 *   manifest?: any,
 *   files?: Record<string, FileObservation>,
 *   live?: Record<string, number>,
 *   unlisted?: string[],
 * }) => Verification}
 */
const checkSnapshot = ({ manifest, files = {}, live, unlisted = [] } = {}) => {
  const hasLive = live !== undefined;

  if (!manifest) {
    return failure([`${MANIFEST_FILE} is missing`], hasLive);
  }
  if (!Array.isArray(manifest.collections)) {
    return failure([`${MANIFEST_FILE} lists no collections`], hasLive);
  }

  const rows = manifest.collections.map((entry) =>
    rowFor(entry, files[entry.name], live)
  );

  const listed = new Set(rows.map(({ name }) => name));
  const warnings = [
    ...unlisted.map((file) => `${file} is in the snapshot but not in ${MANIFEST_FILE}`),
    ...Object.keys(live ?? {})
      .filter((name) => !listed.has(name))
      .sort()
      .map((name) => `${name} is in the database but not in this snapshot`),
  ];

  const problems = rows.flatMap(({ problems: theirs }) => theirs);

  return { rows, problems, warnings, ok: problems.length === 0, hasLive };
};

/**
 * The whole report as lines: the table, then a summary, then whatever is
 * wrong. Formatting lives here rather than in the script so that what a
 * reader is shown is covered by the same test as what is decided.
 * @type {(verification: Verification) => string[]}
 */
const formatVerification = ({ rows, problems, warnings, ok, hasLive }) => {
  const columns = [
    { header: "collection", align: "left", of: ({ name }) => name },
    { header: "manifest", align: "right", of: ({ manifestDocuments }) => count(manifestDocuments) },
    { header: "file", align: "right", of: ({ fileDocuments, checksum }) =>
        fileDocuments === undefined && checksum === "unknown" ? "—" : count(fileDocuments) },
    { header: "sha256", align: "left", of: ({ checksum }) => CHECKSUM_LABEL[checksum] },
    ...(hasLive
      ? [
          { header: "live now", align: "right", of: ({ liveDocuments }) => count(liveDocuments) },
          { header: "drift", align: "right", of: ({ drift }) => driftLabel(drift) },
        ]
      : []),
  ];

  const table = [
    columns.map(({ header }) => header),
    ...rows.map((row) => columns.map(({ of }) => of(row))),
  ];
  const widths = columns.map((_, index) =>
    Math.max(...table.map((cells) => cells[index].length))
  );

  const lines = table.map((cells) =>
    "  " +
    cells
      .map((cell, index) =>
        columns[index].align === "right"
          ? cell.padStart(widths[index])
          : cell.padEnd(widths[index])
      )
      .join("   ")
      .trimEnd()
  );

  return [
    ...lines,
    "",
    ok
      ? `${MANIFEST_FILE} and the files agree on every collection ` +
        `(${rows.length} collections, ${totalDocuments(rows)} documents).`
      : `${problems.length} problem(s) — this snapshot is not what the backup wrote:`,
    ...problems.map((problem) => `  ${problem}`),
    ...(warnings.length > 0 ? ["", "Worth knowing, not a failure:"] : []),
    ...warnings.map((warning) => `  ${warning}`),
  ];
};

module.exports = {
  MANIFEST_FILE,
  checkSnapshot,
  formatVerification,
};

///////////////////////////////////////////////////////////////////////////////

const CHECKSUM_LABEL = { ok: "ok", differs: "DIFFERS", unknown: "?" };

/** @type {(actual: string | undefined, expected: string | undefined) => "ok" | "differs" | "unknown"} */
const checksumStatus = (actual, expected) => {
  if (actual === undefined) return "unknown";
  return actual === expected ? "ok" : "differs";
};

/** @type {(entry: any, file: FileObservation | undefined, live?: Record<string, number>) => VerificationRow} */
const rowFor = ({ name, file, documents, sha256 }, observed, live) => {
  const liveDocuments = live?.[name];
  const row = {
    name,
    file,
    manifestDocuments: documents,
    fileDocuments: observed?.documents,
    liveDocuments,
    drift:
      liveDocuments === undefined || typeof documents !== "number"
        ? undefined
        : liveDocuments - documents,
    checksum: "unknown",
    problems: [],
  };

  if (!observed || observed.present === false) {
    // Same wording as backup_database.js used before this module existed, so
    // that a restore refusing to run still says what it always said.
    return { ...row, problems: [`${name}: ${file} is missing`] };
  }

  // A file the caller could hash but not parse — a truncated one — has a
  // digest worth showing even though the reason it is broken is the parse.
  // One problem per file, though: "it is cut short" and "its bytes changed"
  // are the same event said twice.
  const checksum = checksumStatus(observed.sha256, sha256);

  if (observed.error) {
    return {
      ...row,
      checksum,
      problems: [`${name}: ${file} could not be read (${observed.error})`],
    };
  }

  row.checksum = checksum;
  const problems = [];

  if (observed.sha256 === undefined) {
    problems.push(`${name}: ${file} could not be hashed`);
  } else if (checksum === "differs") {
    problems.push(`${name}: ${file} does not match its checksum`);
  }

  // An unparsed file is the cheap path, not a disagreement: only a count we
  // actually have can contradict the manifest.
  if (observed.documents !== undefined && observed.documents !== documents) {
    problems.push(
      `${name}: ${file} holds ${observed.documents} documents, ` +
        `${MANIFEST_FILE} says ${documents}`
    );
  }

  return { ...row, problems };
};

/** @type {(problems: string[], hasLive: boolean) => Verification} */
const failure = (problems, hasLive) => ({
  rows: [],
  problems,
  warnings: [],
  ok: false,
  hasLive,
});

const count = (value) => (typeof value === "number" ? String(value) : "?");

const driftLabel = (drift) => {
  if (drift === undefined) return "?";
  if (drift === 0) return "";
  return drift > 0 ? `+${drift}` : String(drift);
};

const totalDocuments = (rows) =>
  rows.reduce(
    (total, { manifestDocuments }) =>
      total + (typeof manifestDocuments === "number" ? manifestDocuments : 0),
    0
  );
