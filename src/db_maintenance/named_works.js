/**
 * @file Reading the work ids `propose_work_refs.js --works=<file>` names, and
 * saying which of them named nothing.
 *
 * The flag exists so a worklist from another step can be handed over as it
 * stands (#448, #457), which makes the reading the risky part: a file of the
 * wrong shape used to turn into a set of `"undefined"`s, match no work, and
 * finish as a clean-looking run over zero targets. #468. So everything here
 * either reads an id it is sure of or refuses the file, and saying nothing is
 * never the answer to a row it does not understand.
 *
 * Two shapes are read:
 *
 *   - **A list.** Each row a bare id, or an object carrying `work` or `id` —
 *     which covers this script's own output (`{ kind: "work", work: … }`) and
 *     a section copied out of the audit (`describeWork` writes `id`). A row
 *     with neither is refused by position rather than skipped, and so is one
 *     of this script's own *entry* rows, since a `--works` run searches works
 *     and an entry id would silently match nothing.
 *   - **`audit_database.js --json`,** an object keyed by collection type. The
 *     works it names are the two title buckets whose ref may answer with a
 *     different work: `titleRefDifferent`, which is mostly #290's damage, and
 *     `titleRefContained`, which is mixed and is triage by design — see
 *     ./title_match_check.js. The others are left out on purpose: `spelling`
 *     and `alternate` are the same work under a name the API also holds, and
 *     searching them would propose the ref they already have.
 *
 * An audit written without `--verify-titles` has those buckets empty, which
 * is why an empty result is refused whatever the shape: nothing to search is
 * never what somebody passing `--works` meant.
 *
 * Pure and dependency-free, so ./named_works.test.js runs in the no-install
 * suite; the file read and the database are the script's.
 */

/** The audit sections a `--works` run takes from `audit_database.js --json`. */
const AUDIT_WORK_BUCKETS = ["titleRefDifferent", "titleRefContained"];

/** @type {(value: unknown) => string | undefined} */
const idOf = (value) => {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" || trimmed === "undefined" || trimmed === "null"
    ? undefined
    : trimmed;
};

/** A row's position and a short sight of it, for a refusal. */
const describeRow = (row, index) => {
  const shown = JSON.stringify(row);
  return `row ${index} (${shown && shown.length > 80 ? `${shown.slice(0, 77)}...` : shown})`;
};

/** @type {(rows: unknown[], where: string) => string[]} */
const idsFromRows = (rows, where) =>
  rows.map((row, index) => {
    const id =
      row !== null && typeof row === "object"
        ? idOf(row.work ?? row.id)
        : idOf(row);
    if (id !== undefined) return id;

    if (row !== null && typeof row === "object" && row.kind === "entry") {
      throw new Error(
        `${where}: ${describeRow(row, index)} is an entry, not a work. ` +
          "--works searches works; entries with no work are searched by a " +
          "run without it."
      );
    }
    throw new Error(
      `${where}: ${describeRow(row, index)} carries no work id. ` +
        "Each row must be an id, or an object with a `work` or `id` field."
    );
  });

/**
 * The ids a `--works` file names, deduplicated in the order first named.
 * Throws on anything it cannot read as an id rather than dropping it.
 *
 * @type {(parsed: unknown, source?: string) => string[]}
 */
const parseNamedWorks = (parsed, source = "--works") => {
  let ids;
  if (Array.isArray(parsed)) {
    ids = idsFromRows(parsed, source);
  } else if (parsed !== null && typeof parsed === "object") {
    const sections = Object.entries(parsed);
    const looksLikeAudit =
      sections.length > 0 &&
      sections.every(
        ([, section]) =>
          section !== null &&
          typeof section === "object" &&
          !Array.isArray(section) &&
          AUDIT_WORK_BUCKETS.every((key) => Array.isArray(section[key]))
      );
    if (!looksLikeAudit) {
      throw new Error(
        `${source} is an object but not an audit_database.js --json report ` +
          `(one section per collection, each with ${AUDIT_WORK_BUCKETS.join(" and ")}). ` +
          "Pass that report, or a list of ids or rows carrying `work` or `id`."
      );
    }
    ids = sections.flatMap(([type, section]) =>
      AUDIT_WORK_BUCKETS.flatMap((key) =>
        idsFromRows(section[key], `${source} ${type}.${key}`)
      )
    );
  } else {
    throw new Error(
      `${source} must hold a JSON list of work ids or rows, or an ` +
        "audit_database.js --json report."
    );
  }

  const unique = [...new Set(ids)];
  if (unique.length === 0) {
    throw new Error(
      `${source} names no works. An audit report only names them when it ` +
        "was written with --verify-titles."
    );
  }
  return unique;
};

/**
 * The named ids that matched no work in the collections searched, in the
 * order they were named. Every one of them is worth printing: a stale list
 * and a misshaped one look the same from the outside, which is a run that
 * searched less than was asked.
 *
 * @type {(named: Iterable<string>, matched: Iterable<string>) => string[]}
 */
const unmatchedNamed = (named, matched) => {
  const found = new Set(matched);
  return [...named].filter((id) => !found.has(id));
};

module.exports = { AUDIT_WORK_BUCKETS, parseNamedWorks, unmatchedNamed };
