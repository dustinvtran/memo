/**
 * @file Decides which `null` override keys go — all of them — and reports the
 * two populations #478 asked about on the way: the linked entries whose
 * overrides object holds nothing but nulls, and the ones whose
 * `overrides.releaseYear` is a null over a work that has a year.
 *
 * **An override is a value, never a null, and the owner decided that the
 * nulls already stored are all mistakes** (2026-09-29, on #478). The evidence
 * that decided it: every one traced back to #317's whole-form saves, where a
 * blank box was sent as a null; only the Year column ever honoured one, and
 * drew a dash where the work's year was; and the edit form showed the work's
 * value in place of a null, so the next save dropped it anyway. The form now
 * refuses to submit an emptied field and the API refuses a null override, so
 * this is the backlog and nothing refills it.
 *
 * **Removing one changes only the Year column.** `withOverrides` in
 * ../api/utils/export_view.js and every list column already read a null as
 * absent, and since #478 the Year column does too — so on the page the
 * removal is already done, and this makes the stored data agree.
 *
 * Entries with no work are included. For those the overrides are the only
 * metadata, which is why ./noop_override_plan.js skips them — but a null is
 * not metadata, it is a field with no value, which an absent key says as
 * well. An empty overrides object `{}` has no keys to be null and is left
 * alone.
 *
 * Pure and dependency-free: scripts/clear_null_overrides.js does the I/O and
 * this decides, so the decision is unit tested
 * (./null_override_plan.test.js) in the no-install suite.
 */

const { isEmptyValue } = require("./work_collections");

/**
 * What an entry looks like in the report.
 *
 * `hides` is the subset of `nullFields` for which the work has a value: what
 * the null was standing in front of. Since #478 nothing on the page honours
 * it, so this is a record of what the null meant, not of what removing it
 * changes.
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
 *   removals: {
 *     _id: any, overrides: object, fields: string[],
 *     dropsObject: boolean, linked: boolean,
 *   }[],
 *   unaddressable: { _id: any, field: string }[],
 *   totals: {
 *     nullKeys: number,
 *     unlinkedNullKeys: number,
 *     entriesTouched: number,
 *     objectsDropped: number,
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

    const nullFields = fields.filter((field) => isCleared(entry.overrides[field]));
    const work = worksById.get(toRefKey(entry.workRef));
    if (nullFields.length > 0) addRemoval(plan, entry, fields, nullFields, work);

    if (work === undefined) {
      plan.totals.unlinkedWithOverrides += 1;
      continue;
    }
    plan.totals.linkedWithOverrides += 1;

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

/**
 * Every null key on the entry goes, linked or not, and the object with them
 * when nothing else is in it. On an entry with no work a null is not metadata
 * either: it is a field with no value, which is what leaving it out says.
 *
 * A key whose name holds a `.` or starts with a `$` cannot be addressed as
 * `overrides.<field>` — the path would name something else — so it is kept
 * and reported, unless the whole object is going and no path is needed.
 */
const addRemoval = (plan, entry, fields, nullFields, work) => {
  const dropsObject = nullFields.length === fields.length;
  const addressable = dropsObject
    ? nullFields
    : nullFields.filter((field) => !field.includes(".") && !field.startsWith("$"));
  for (const field of nullFields) {
    if (!addressable.includes(field)) plan.unaddressable.push({ _id: entry._id, field });
  }
  if (addressable.length === 0) return;

  plan.removals.push({
    _id: entry._id,
    overrides: entry.overrides,
    fields: addressable,
    dropsObject,
    linked: work !== undefined,
  });
  plan.totals.nullKeys += addressable.length;
  plan.totals.entriesTouched += 1;
  if (dropsObject) plan.totals.objectsDropped += 1;
  if (work === undefined) plan.totals.unlinkedNullKeys += addressable.length;
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
  unaddressable: [],
  totals: {
    nullKeys: 0,
    unlinkedNullKeys: 0,
    entriesTouched: 0,
    objectsDropped: 0,
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
