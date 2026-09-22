/**
 * @file How close an export response is to the ceiling the endpoint enforces
 * on itself, and whether that is worth saying out loud. #422.
 *
 * `/api/export/:username?limit=N` assembles four lists into one body and
 * refuses to send one over `MAX_BODY_BYTES` — the constant in
 * ../api/controllers/export.js, which is where the ceiling this module is
 * handed comes from. The owner's four lists came to 4,741,315 bytes on
 * 2026-09-21 and nothing anywhere watched that number, so the first sign of
 * the line being crossed would have been a reader getting a `413` where a
 * person got a `200`.
 *
 * The refusal is graceful and names the smaller urls to fetch instead, which
 * is why #422 is a monitoring gap rather than a bug, and why what it wants is
 * a report rather than a gate. `scripts/check_export_size.js` does the
 * measuring — it asks the route for each body and weighs the string the route
 * would have sent — and everything here is the arithmetic on top of that, so
 * the threshold and the wording are unit tested rather than discovered
 * against production.
 *
 * **Dividing it here rather than writing the answer down is the point.** #422
 * reads those same 4,741,315 bytes as 94.8% of the budget with 258 KB to
 * spare, which is the body against five million bytes; the constant is five
 * *mebi*bytes, so the same body is 90.4% with 501,565 bytes to spare. Both
 * are a division somebody did once by hand, and only one of them is of the
 * number the endpoint actually enforces.
 *
 * **A body that was refused is a measurement this module does not have.** The
 * route answers a `413` with a few hundred bytes of advice instead of the
 * body, so past the ceiling there is nothing left to weigh: the report says
 * the line has been crossed and stops claiming a percentage. That is the one
 * state this whole file exists to arrive at before anybody else does, so it
 * is worth saying plainly rather than estimating around.
 *
 * Pure and dependency-free, so it is covered by `node --test` without an
 * install — ./export_budget.test.js.
 */

/**
 * The share of the ceiling at which a body stops being unremarkable.
 *
 * 80% is #422's own suggestion, and it is a reporting threshold rather than a
 * budget: the body it was chosen for is already past it, which is the finding
 * and not a reason to move the line. What it buys is that the run *after* a
 * list grows past it reads differently from the run before.
 */
const WARN_FRACTION = 0.8;

/** What the route answers with when it will not send a body. */
const REFUSED_STATUS = 413;

/**
 * Every measured body against the ceiling, worst first.
 *
 * A measurement is `{ username, url, format, entries, status, bytes }` as the
 * script took it: `bytes` is the length of the string the route returned,
 * counted the way the route's own budget check counts it, and is absent for
 * any response that carried no body to weigh.
 *
 * `blocked` means here what it means in ./blank_override_check.js and
 * ./orphan_review_plan.js — a state in which answering at all would be a
 * mistake, for the caller to print instead of the zeroes.
 *
 * @typedef {{ username?: string, url?: string, format?: string,
 *   entries?: number, status?: number, bytes?: number }} Measurement
 * @typedef {Measurement & { percent?: number, headroomBytes?: number,
 *   bytesPerEntry?: number, entriesOfHeadroom?: number, refused: boolean,
 *   level: string }} Row
 * @type {(args: { ceiling: number, measurements: Measurement[],
 *   warnFraction?: number }) => {
 *   blocked: string | undefined,
 *   ceiling: number,
 *   warnFraction: number,
 *   rows: Row[],
 *   worst: Row | undefined,
 *   level: string,
 *   counts: { total: number, ok: number, approaching: number, over: number,
 *     unknown: number },
 * }}
 */
const summarizeExportSizes = ({
  ceiling,
  measurements = [],
  warnFraction = WARN_FRACTION,
}) => {
  if (!Number.isFinite(ceiling) || ceiling <= 0) {
    return {
      ...emptyReport(),
      blocked: "the ceiling must be a positive number of bytes",
    };
  }

  if (!Array.isArray(measurements)) {
    return {
      ...emptyReport(),
      ceiling,
      warnFraction,
      blocked: "measurements must be an array",
    };
  }

  const rows = measurements
    .map((measurement) => describeOne(measurement, ceiling, warnFraction))
    .sort(bySeverityThenSize);

  const counts = {
    total: rows.length,
    ok: rows.filter((row) => row.level === "ok").length,
    approaching: rows.filter((row) => row.level === "approaching").length,
    over: rows.filter((row) => row.level === "over").length,
    unknown: rows.filter((row) => row.level === "unknown").length,
  };

  return {
    blocked: undefined,
    ceiling,
    warnFraction,
    rows,
    // The heaviest body, which is the one the next run is about. An unknown
    // is not a candidate: it is a measurement that did not happen, and the
    // headline reports those separately rather than ranking them.
    worst: rows.find((row) => row.level !== "unknown"),
    level:
      counts.over > 0 ? "over" : counts.approaching > 0 ? "approaching" : "ok",
    counts,
  };
};

/**
 * The sentence worth reading in a job summary, before any table.
 * @type {(report: object) => string}
 */
const describeReport = (report) => {
  if (report.blocked) return `Nothing measured: ${report.blocked}`;
  if (report.counts.total === 0) return "No export bodies were measured.";

  const { counts, worst, ceiling, warnFraction } = report;
  const share = formatPercent(warnFraction * 100);
  const measured = counts.total - counts.unknown;

  const headline =
    counts.over > 0
      ? `${counts.over} of ${counts.total} export ${bodies(counts.total)} `
        + `${is(counts.over)} over the ${withThousands(ceiling)}-byte ceiling, `
        + "and the endpoint is refusing to send " + them(counts.over) + "."
      : counts.approaching > 0
        ? `${counts.approaching} of ${counts.total} export `
          + `${bodies(counts.total)} ${is(counts.approaching)} at or `
          + `past ${share} of the ${withThousands(ceiling)}-byte ceiling.`
        : measured === 0
          ? "No export body could be measured."
          : measured === 1
            ? `The one export body measured is inside ${share} of the `
              + `${withThousands(ceiling)}-byte ceiling.`
            : `All ${measured} export bodies are inside ${share} of the `
              + `${withThousands(ceiling)}-byte ceiling.`;

  return [headline, describeWorst(worst, ceiling), describeUnknown(counts)]
    .filter(Boolean)
    .join(" ");
};

/**
 * The headline and a row per body, for a log and a job summary.
 * @type {(report: object) => string}
 */
const toSummary = (report) => {
  const headline = describeReport(report);
  if (report.blocked || report.counts.total === 0) return headline;

  const table = toTable(
    ["level", "share", "bytes", "entries", "headroom", "more", "format", "url"],
    report.rows.map((row) => [
      row.level === "ok" ? "ok" : row.level.toUpperCase(),
      row.percent === undefined ? "—" : formatPercent(row.percent),
      row.bytes === undefined ? "—" : withThousands(row.bytes),
      row.entries === undefined ? "—" : withThousands(row.entries),
      row.headroomBytes === undefined ? "—" : withThousands(row.headroomBytes),
      row.entriesOfHeadroom === undefined
        ? "—"
        : withThousands(row.entriesOfHeadroom),
      row.format ?? "—",
      row.url ?? "—",
    ]),
    // Everything a reader compares down a column is a number, and the two
    // that are not are names.
    ["left", "right", "right", "right", "right", "right", "left", "left"]
  );

  return [headline, "", ...table].join("\n");
};

module.exports = {
  WARN_FRACTION,
  REFUSED_STATUS,
  summarizeExportSizes,
  describeReport,
  toSummary,
  withThousands,
  formatPercent,
};

///////////////////////////////////////////////////////////////////////////////

/**
 * One measurement with the arithmetic done on it.
 *
 * `headroomBytes` and the entries that would fit in it are deliberately
 * absent for a body that was refused rather than negative: past the ceiling
 * the route sent advice instead of the body, so there is no length to
 * subtract from anything.
 */
const describeOne = (measurement, ceiling, warnFraction) => {
  const { entries, status } = measurement ?? {};
  const refused = status === REFUSED_STATUS;
  const bytes = isCount(measurement?.bytes) ? measurement.bytes : undefined;

  if (bytes === undefined) {
    return {
      ...measurement,
      bytes: undefined,
      percent: undefined,
      headroomBytes: undefined,
      bytesPerEntry: undefined,
      entriesOfHeadroom: undefined,
      refused,
      // A refusal is the finding; anything else that carried no body is a
      // measurement that failed, and saying so beats reporting a zero.
      level: refused ? "over" : "unknown",
    };
  }

  const headroomBytes = ceiling - bytes;
  const bytesPerEntry =
    isCount(entries) && entries > 0 ? bytes / entries : undefined;

  return {
    ...measurement,
    bytes,
    percent: (bytes / ceiling) * 100,
    headroomBytes,
    bytesPerEntry,
    entriesOfHeadroom:
      bytesPerEntry === undefined || headroomBytes < 0
        ? undefined
        : Math.floor(headroomBytes / bytesPerEntry),
    refused,
    // The route sends a body of exactly the ceiling — its check is `<=` — so
    // the ceiling itself is the last size that still works, and reported as
    // approaching rather than as over.
    level:
      bytes > ceiling
        ? "over"
        : bytes >= ceiling * warnFraction
          ? "approaching"
          : "ok",
  };
};

/** Refusals, then the heaviest measured body, then the ones that failed. */
const bySeverityThenSize = (a, b) =>
  rank(a) - rank(b) || (b.percent ?? -1) - (a.percent ?? -1);

const rank = (row) =>
  row.level === "over" && row.bytes === undefined
    ? 0
    : row.level === "unknown"
      ? 2
      : 1;

const describeWorst = (worst, ceiling) => {
  if (!worst) return "";

  const where = `${worst.url ?? "an export"}${
    worst.format ? ` (${worst.format})` : ""
  }`;

  if (worst.bytes === undefined) {
    return `${where} is the one being refused; there is no body to weigh.`;
  }

  const size =
    `The largest is ${where} at ${formatPercent(worst.percent)} — `
    + `${withThousands(worst.bytes)} of ${withThousands(ceiling)} bytes, `
    + `${withThousands(worst.headroomBytes)} to spare`;

  return worst.entriesOfHeadroom === undefined
    ? `${size}.`
    : `${size}, about ${withThousands(worst.entriesOfHeadroom)} more entries `
      + `at the ${withThousands(Math.round(worst.bytesPerEntry))} bytes each `
      + "it averages.";
};

const describeUnknown = ({ unknown }) =>
  unknown === 0
    ? ""
    : `${unknown} ${bodies(unknown)} could not be measured at all.`;

const bodies = (n) => (n === 1 ? "body" : "bodies");
const is = (n) => (n === 1 ? "is" : "are");
const them = (n) => (n === 1 ? "it" : "them");

/** A finite, non-negative count. A `-1` byte length is not a measurement. */
const isCount = (value) => Number.isFinite(value) && value >= 0;

/**
 * Right-aligned where the column is numbers, left where it is names, and
 * every column as wide as the widest thing in it — including its own heading,
 * which is what stops a heading running into the next column.
 */
const toTable = (headers, rows, aligns) => {
  const widths = headers.map((heading, column) =>
    Math.max(
      heading.length,
      ...rows.map((row) => String(row[column] ?? "").length)
    )
  );

  const line = (cells) =>
    "  "
    + cells
      .map((cell, column) =>
        aligns[column] === "right"
          ? String(cell).padStart(widths[column])
          : String(cell).padEnd(widths[column])
      )
      .join("  ")
      .trimEnd();

  return [line(headers), ...rows.map(line)];
};

/**
 * `4741315` as `4,741,315`. Written out rather than left to
 * `toLocaleString`, whose answer depends on the locale the run happens to
 * have and so cannot be asserted.
 */
function withThousands(value) {
  if (!Number.isFinite(value)) return String(value);
  const rounded = Math.trunc(value);
  return String(rounded).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** One decimal place, which is the resolution a growing list moves at. */
function formatPercent(percent) {
  return Number.isFinite(percent) ? `${percent.toFixed(1)}%` : "—";
}

const emptyReport = () => ({
  blocked: undefined,
  ceiling: 0,
  warnFraction: WARN_FRACTION,
  rows: [],
  worst: undefined,
  level: "ok",
  counts: { total: 0, ok: 0, approaching: 0, over: 0, unknown: 0 },
});
