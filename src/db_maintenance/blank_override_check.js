/**
 * @file Decides which stored overrides are lists with nothing readable in
 * them, and which of those are hiding a value the work really has.
 *
 * An override wins over the work it overlays — `get` in
 * ../frontend/_includes/js/utils/columns.js merges the two with `??`, and
 * `[""]` is not nullish — so a list whose only member is an empty string is
 * not an empty cell, it is the work's own directors, actors or studios being
 * held off the page for ever. `Gilmore Girls: Season 1` has
 * `directors: ["Amy Sherman-Palladino"]` on its work document and renders an
 * anchor with no text and no destination. 272 rows were in that state on
 * 2026-09-21. #395.
 *
 * **The code that wrote them is already fixed.** `asOverride` in
 * ../frontend/_includes/js/utils/entry_form_io.js treats a list of blanks as
 * blank and stores a `null` or nothing at all, and its docstring names this
 * exact population — "which is what put `[""]` on the `directors` of 538 TV
 * shows". So this is a backlog rather than a live bug, and the only thing
 * that has reduced it is entries happening to be re-saved.
 *
 * **Nothing else here can see it**, which is why it wants its own module
 * rather than a loosened comparison somewhere. ./noop_override_plan.js
 * compares an override against the work byte for byte and keeps anything
 * different, and says at its `isSameStoredValue` that it is deliberately
 * stricter than the form: `[""]` against `["Amy Sherman-Palladino"]` is a
 * different value, so it is a real override to that script and always will
 * be. It is right — an empty override is not a no-op override, it is a wrong
 * one — and this is the question it does not ask.
 *
 * **The split is the finding.** Two counts, because only one of them is
 * something a reader can see:
 *
 * - **Hiding the work's value** is damage on the public site today. Removing
 *   the key puts the work's value back on the page.
 * - **Hiding nothing** is a tidy-up, and it is not harmless: the moment the
 *   scheduled refresh (#3, #333) fills the field on the work, the stored
 *   blank starts masking it without anything having written to the entry.
 *   The 141 books carrying `genres: [""]` hide nothing only because Google
 *   Books has told us no genres yet.
 *
 * An entry is counted once, in the first bucket it qualifies for: `272 rows`
 * is rows a reader sees, so an entry with one masking field and one harmless
 * one is one damaged row rather than two findings. The per-field breakdown
 * counts keys, since a field is a column and a column is where the key sits.
 *
 * **Three things are left alone, and two of them are the same two
 * ./noop_override_plan.js leaves alone.** A `null` is the form's deliberate
 * "this work's value is wrong and there is no replacement" and removing it
 * would un-clear a field somebody cleared. A list with any non-blank member
 * is what the feature is for, whatever else is in it: `["", "Christopher
 * Nolan"]` renders Nolan, and is ./unusable_field_plan.js's shape rather than
 * this one's. And an entry whose work cannot be read is reported undecided
 * instead of guessed at — for the hand-typed entries that point at no work,
 * `overrides` is not a layer over the metadata, it *is* the metadata.
 *
 * Two shapes deliberately outside this count, named so that neither reads as
 * an oversight later:
 *
 * - **An empty list, `[]`**, does the same damage by the same route, and is
 *   not reported. No current code path writes one — the form wrote `[""]`,
 *   which is the whole population — and unlike a blank member there is
 *   nothing in it to call blank, so whether it is a deliberate clear is a
 *   question `null` has already answered differently. If one ever appears it
 *   belongs on this line, decided rather than assumed.
 * - **A blank scalar, `""`**, likewise wins over the work. It is the same
 *   defect one type over and wants its own measurement; #395 counted lists,
 *   and a count that quietly mixes the two cannot be checked against it.
 *
 * Pure and dependency-free, so the decision is unit tested
 * (./blank_override_check.test.js) in the no-install suite rather than
 * discovered against production. scripts/audit_database.js does the reads.
 * It is read-only in the strongest sense: the audit never writes. The
 * `$unset` half of #395 is ./blank_override_plan.js and
 * scripts/clear_blank_overrides.js, which import `isBlankList` and
 * `hasRealValue` from here rather than defining "blank" a second time — so the
 * keys a run removes are the keys this reports, and
 * ./blank_override_plan.test.js asserts that rather than assuming it.
 */

/**
 * Every entry carrying an override list with nothing readable in it, split by
 * whether the work underneath has something to show.
 *
 * `blocked` means what it means in ./noop_override_plan.js and
 * ./orphan_review_plan.js: a condition under which answering at all would be
 * a mistake, and the caller is expected to print it rather than the zeroes.
 * Entries that point at works beside a works collection of zero documents is
 * what a failed collection read looks like, and it would report every masked
 * row as undecided — a quiet zero in the one count that matters.
 *
 * @typedef {{ field: string, stored: unknown, workValue?: unknown,
 *   masks: boolean }} BlankField
 * @typedef {{ id: any, userId: any, workRef: any, fields: BlankField[] }} Found
 * @type {(entries: any[], works: any[]) => {
 *   blocked: string | undefined,
 *   masking: Found[],
 *   harmless: Found[],
 *   undecided: Array<Found & { reason: string }>,
 *   byField: Record<string, {
 *     masking: number, harmless: number, undecided: number,
 *   }>,
 *   totals: {
 *     entries: number,
 *     withOverrides: number,
 *     keys: number,
 *     blankKeys: number,
 *     maskingKeys: number,
 *     entriesAffected: number,
 *   },
 * }}
 */
const classifyBlankOverrides = (entries, works) => {
  if (!Array.isArray(entries) || !Array.isArray(works)) {
    return {
      ...emptyReport(),
      blocked: "entries and works must both be arrays",
    };
  }

  const pointing = entries.filter((entry) => toRefKey(entry?.workRef));
  if (pointing.length > 0 && works.length === 0) {
    return {
      ...emptyReport(),
      blocked:
        `${pointing.length} entry(s) point at a work but the works ` +
        `collection came back empty — refusing to report every masked row ` +
        `as undecided. This is what a failed collection read looks like.`,
    };
  }

  const worksById = toWorksById(works);
  const report = emptyReport();
  report.totals.entries = entries.length;

  for (const entry of entries) {
    const fields = overrideFields(entry);
    if (fields.length === 0) continue;
    report.totals.withOverrides += 1;
    report.totals.keys += fields.length;

    const blank = fields.filter((field) => isBlankList(entry.overrides[field]));
    if (blank.length === 0) continue;
    report.totals.blankKeys += blank.length;
    report.totals.entriesAffected += 1;

    const reason = undecidedReason(entry, worksById);
    if (reason !== undefined) {
      report.undecided.push({
        ...describeEntry(entry),
        reason,
        fields: blank.map((field) => ({
          field,
          stored: entry.overrides[field],
          masks: false,
        })),
      });
      for (const field of blank) countOf(report, field).undecided += 1;
      continue;
    }

    const work = worksById.get(toRefKey(entry.workRef));
    const found = {
      ...describeEntry(entry),
      fields: blank.map((field) => ({
        field,
        stored: entry.overrides[field],
        workValue: work[field],
        masks: hasRealValue(work[field]),
      })),
    };

    for (const { field, masks } of found.fields) {
      countOf(report, field)[masks ? "masking" : "harmless"] += 1;
      if (masks) report.totals.maskingKeys += 1;
    }

    // One row per entry, in the first bucket it qualifies for: what the site
    // shows a reader is a row with an empty cell in it, and an entry with one
    // masking field and one harmless one is one such row.
    if (found.fields.some((f) => f.masks)) report.masking.push(found);
    else report.harmless.push(found);
  }

  return report;
};

module.exports = {
  classifyBlankOverrides,
  isBlankList,
  hasRealValue,
};

///////////////////////////////////////////////////////////////////////////////

/**
 * A stored list with at least one member and nothing readable in any of them.
 *
 * Whitespace counts as blank because it renders as blank: `[" "]` produces
 * the same anchor with no text that `[""]` does. A non-string member is not
 * blank — a number or an object is something this module has no business
 * calling empty, and a list holding one is left to ./unusable_field_plan.js,
 * which decides unusable values on the work rather than on somebody's entry.
 *
 * `[]` is not this shape; see the file header for why it is left out.
 */
function isBlankList(value) {
  return (
    Array.isArray(value) && value.length > 0 && value.every(isBlankMember)
  );
}

/** Nothing a reader could see: no member, an empty one, or one that is space. */
const isBlankMember = (member) =>
  member === undefined ||
  member === null ||
  (typeof member === "string" && member.trim() === "");

/**
 * Whether the work has something the override is keeping off the page.
 *
 * Deliberately not ../work_collections.js's `isEmptyValue`, which answers a
 * different question — it is about whether a *work* has a gap a refresh could
 * fill, and it calls `[""]` non-empty, which is the very value this module
 * exists to find. What is asked here is whether removing the override would
 * put anything on the row.
 *
 * `0` is blank, as it is everywhere else in this folder: every numeric field
 * is a duration, a releaseYear or an episode count and none of them has a
 * meaningful zero — see CLAUDE.md. An object counts by whether it has any
 * keys at all, which is what makes the `{}` publishers of #291 read as the
 * nothing they render as, without this module having an opinion on whether a
 * populated one is well formed. `corruptFields` in the audit is where that is
 * decided.
 */
function hasRealValue(value) {
  if (Array.isArray(value)) return value.some((member) => !isBlankMember(member));
  if (typeof value === "number") return Number.isFinite(value) && value !== 0;
  if (isPlainObject(value)) return Object.keys(value).length > 0;
  return !isBlankMember(value);
}

/** Why this entry cannot be decided, or `undefined` if it can. */
const undecidedReason = (entry, worksById) => {
  const key = toRefKey(entry.workRef);
  if (key === undefined) return "entry points at no work";
  if (!worksById.has(key)) return "workRef points at a work that is gone";
  return undefined;
};

/**
 * What the report says about an entry. Ids and a workRef, as the audit's two
 * existing entry-side findings print, and no user text — which costs nothing
 * here, since every value this module reports is blank by definition.
 */
const describeEntry = (entry) => ({
  id: entry._id,
  userId: entry.userId,
  workRef: entry.workRef ?? null,
});

const countOf = (report, field) =>
  (report.byField[field] ??= { masking: 0, harmless: 0, undecided: 0 });

/** The keys of an entry's overrides object, or none if it has no usable one. */
const overrideFields = (entry) => {
  const overrides = entry?.overrides;
  return isPlainObject(overrides) ? Object.keys(overrides) : [];
};

/** The works keyed the way an `_id` compares — an ObjectId is not a string. */
const toWorksById = (works) =>
  works.reduce((byId, work) => {
    const key = toRefKey(work?._id);
    return key === undefined ? byId : byId.set(key, work);
  }, new Map());

/** `undefined` and `null` are not ids, and must not compare equal as strings. */
const toRefKey = (id) =>
  id === undefined || id === null || id === "" ? undefined : String(id);

const isPlainObject = (value) =>
  value !== null &&
  typeof value === "object" &&
  (Object.getPrototypeOf(value) === Object.prototype ||
    Object.getPrototypeOf(value) === null);

const emptyReport = () => ({
  blocked: undefined,
  masking: [],
  harmless: [],
  undecided: [],
  byField: {},
  totals: {
    entries: 0,
    withOverrides: 0,
    keys: 0,
    blankKeys: 0,
    maskingKeys: 0,
    entriesAffected: 0,
  },
});
