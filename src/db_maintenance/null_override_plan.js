/**
 * @file Finds the linked entries whose overrides object holds nothing but
 * `null`s, and — separately — the ones whose `overrides.releaseYear` is a
 * `null` over a work that has a year. #478.
 *
 * **Why the year, of all the fields.** A `null` override means "the work's
 * value is wrong and there is no replacement" — see `asOverride` in
 * ../frontend/_includes/js/utils/entry_form_io.js — but only one reader
 * honours it. `withOverrides` in ../api/utils/export_view.js drops a null so
 * the work's value comes through, and every list column but one merges with
 * `??`, which does the same. The Year column is the exception:
 * `getOverrideOrMetadataPreserveNull('releaseYear')` in
 * ../frontend/_includes/js/utils/columns.js keeps the null and draws a dash
 * where the work's year would be. So a stored null on any other field is
 * invisible today, and a stored null year is the one that shows.
 *
 * **Why the all-null objects are the suspicious half.** #317's bug stored the
 * whole add/edit form as overrides on every save, and a form whose fields
 * were blank stored a null for each. An entry where every key is null is that
 * shape exactly — eight or nine fields cleared in one save — rather than a
 * person clearing one field they disagreed with. #317's cleanup,
 * ./noop_override_plan.js, kept every null on principle, which is right for a
 * single cleared field and doubtful for this.
 *
 * **Doubtful is not decided.** A null is a legitimate way to hide a year, and
 * this module cannot tell a deliberate one from the bug's. It reports; the
 * owner decides. What it would remove, if told to, is only the all-null
 * objects on linked entries: unsetting one of those changes exactly one thing
 * a reader can see, the Year cell, and only where the work has a year. The
 * mixed entries — a null year beside a real override — are listed and never
 * proposed, because a real value beside the null is evidence someone was
 * choosing field by field.
 *
 * Left alone entirely:
 *
 * - **An entry with no work, or a dangling `workRef`.** For those, `overrides`
 *   *is* the metadata, not a layer over it, so there is nothing underneath
 *   for a removal to reveal. Counted, not listed.
 * - **An empty overrides object `{}`.** It has no keys to be null, and is
 *   ./unreachable_document_plan.js's kind of nothing, not this one's.
 *
 * Pure and dependency-free: scripts/report_null_overrides.js does the I/O and
 * this decides, so the decision is unit tested
 * (./null_override_plan.test.js) in the no-install suite.
 */

const { isEmptyValue } = require("./work_collections");

/**
 * What an entry looks like in the report.
 *
 * `hides` is the subset of `fields` for which the work has a value, which is
 * what a reader would see come back if the object went — the Year column
 * today, the rest only if another column is ever taught to keep a null.
 *
 * @typedef {{
 *   _id: any,
 *   userId: any,
 *   updatedDate: any,
 *   workRef: any,
 *   fields: string[],
 *   nullFields: string[],
 *   hides: string[],
 *   allNull: boolean,
 *   workYear: unknown,
 * }} Reported
 *
 * `blocked` means what it does in ./noop_override_plan.js: entries pointing
 * at works beside a works collection of zero documents is what a failed read
 * looks like, and is refused by name rather than reported as every entry
 * being unlinked.
 *
 * @type {(entries: any[], works: any[]) => {
 *   blocked: string | undefined,
 *   allNull: Reported[],
 *   releaseYearNull: Reported[],
 *   removals: { _id: any, overrides: object }[],
 *   totals: {
 *     entries: number,
 *     withOverrides: number,
 *     linkedWithOverrides: number,
 *     unlinkedWithOverrides: number,
 *     allNull: number,
 *     allNullHidingYear: number,
 *     releaseYearNull: number,
 *     releaseYearNullMixed: number,
 *   },
 *   byUser: Record<string, { allNull: number, releaseYearNull: number }>,
 *   byUpdatedYear: Record<string, { allNull: number, releaseYearNull: number }>,
 * }}
 */
const planNullOverrideReport = (entries, works) => {
  if (!Array.isArray(entries) || !Array.isArray(works)) {
    return { ...emptyPlan(), blocked: "entries and works must both be arrays" };
  }

  const pointing = entries.filter((entry) => toRefKey(entry?.workRef));
  if (pointing.length > 0 && works.length === 0) {
    return {
      ...emptyPlan(),
      blocked:
        `${pointing.length} entry(s) point at a work but the works ` +
        `collection came back empty — refusing to call every one of them ` +
        `unlinked. This is what a failed collection read looks like.`,
    };
  }

  const worksById = works.reduce((byId, work) => {
    const key = toRefKey(work?._id);
    return key === undefined ? byId : byId.set(key, work);
  }, new Map());

  const plan = emptyPlan();
  plan.totals.entries = entries.length;

  for (const entry of entries) {
    const fields = overrideFields(entry);
    if (fields.length === 0) continue;
    plan.totals.withOverrides += 1;

    const work = worksById.get(toRefKey(entry.workRef));
    if (work === undefined) {
      plan.totals.unlinkedWithOverrides += 1;
      continue;
    }
    plan.totals.linkedWithOverrides += 1;

    const nullFields = fields.filter((field) => isCleared(entry.overrides[field]));
    const allNull = nullFields.length === fields.length;
    const yearHidden =
      "releaseYear" in entry.overrides &&
      isCleared(entry.overrides.releaseYear) &&
      !isEmptyValue(work.releaseYear);

    if (!allNull && !yearHidden) continue;

    const reported = {
      _id: entry._id,
      userId: entry.userId,
      updatedDate: entry.updatedDate,
      workRef: entry.workRef,
      fields,
      nullFields,
      hides: nullFields.filter((field) => !isEmptyValue(work[field])),
      allNull,
      workYear: work.releaseYear,
    };
    const user = (plan.byUser[String(entry.userId)] ??= emptyCounts());
    const year = (plan.byUpdatedYear[updatedYear(entry.updatedDate)] ??=
      emptyCounts());

    if (allNull) {
      plan.allNull.push(reported);
      plan.removals.push({ _id: entry._id, overrides: entry.overrides });
      plan.totals.allNull += 1;
      if (yearHidden) plan.totals.allNullHidingYear += 1;
      user.allNull += 1;
      year.allNull += 1;
    }
    if (yearHidden) {
      plan.releaseYearNull.push(reported);
      plan.totals.releaseYearNull += 1;
      if (!allNull) plan.totals.releaseYearNullMixed += 1;
      user.releaseYearNull += 1;
      year.releaseYearNull += 1;
    }
  }

  return plan;
};

/**
 * The calendar year an `updatedDate` falls in, UTC, or `"unknown"`.
 *
 * The API stamps `Date.now()`, a number; older documents and a snapshot read
 * back off disk can carry a Date or an ISO string instead, so all three are
 * read and anything else is reported rather than guessed at.
 */
const updatedYear = (value) => {
  const date =
    value instanceof Date
      ? value
      : typeof value === "number" || typeof value === "string"
      ? new Date(value)
      : undefined;
  return date === undefined || Number.isNaN(date.getTime())
    ? "unknown"
    : String(date.getUTCFullYear());
};

module.exports = {
  planNullOverrideReport,
  updatedYear,
};

///////////////////////////////////////////////////////////////////////////////

/**
 * `undefined` counts with `null` for the same reason it does in
 * ./noop_override_plan.js: the driver maps BSON's deprecated undefined onto
 * it, and a snapshot read back off disk can carry either.
 */
const isCleared = (value) => value === null || value === undefined;

const overrideFields = (entry) => {
  const overrides = entry?.overrides;
  return isPlainObject(overrides) ? Object.keys(overrides) : [];
};

/** `undefined` and `null` are not ids, and must not compare equal as strings. */
const toRefKey = (id) =>
  id === undefined || id === null || id === "" ? undefined : String(id);

const isPlainObject = (value) =>
  value !== null &&
  typeof value === "object" &&
  (Object.getPrototypeOf(value) === Object.prototype ||
    Object.getPrototypeOf(value) === null);

const emptyCounts = () => ({ allNull: 0, releaseYearNull: 0 });

const emptyPlan = () => ({
  blocked: undefined,
  allNull: [],
  releaseYearNull: [],
  removals: [],
  totals: {
    entries: 0,
    withOverrides: 0,
    linkedWithOverrides: 0,
    unlinkedWithOverrides: 0,
    allNull: 0,
    allNullHidingYear: 0,
    releaseYearNull: 0,
    releaseYearNullMixed: 0,
  },
  byUser: {},
  byUpdatedYear: {},
});
