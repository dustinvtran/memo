/**
 * @file Decides which stored field values on a work document are unusable,
 * and so may be removed from it entirely.
 *
 * The audit already knows which ones they are: `corruptFieldsOf` in
 * ./work_metadata_merge.js asks `isCorruptStringArray`, `isCorruptNumber` and
 * `isCorruptExternalUrls` of ./work_collections.js, and those three are what
 * 609 of the 637 values in #291 are counted with. This module calls the same
 * predicates rather than restating them — a second copy of the rules is a
 * second thing to drift, and it would drift towards clearing things the audit
 * never complained about.
 *
 * Why there has to be a script at all. `mergeWork` only ever writes a field
 * the adapter returned a **non-empty** value for, and never clears one. That
 * rule is right — it is what stops a bad API day emptying the database — but
 * it means a corrupt value can be replaced and never removed, so the 78 books
 * Google Books has no publisher for keep their `{}` however many times the
 * backfill runs. Unsetting is what breaks that: a **missing** field is what
 * `isEmptyValue` recognises, so the next ordinary backfill treats the work as
 * having a gap and fills it if the API has anything to say.
 *
 * Two fields `corruptFieldsOf` reports are deliberately not clearable here:
 *
 * - **`apiRefs`** — the 28 the audit counts are *absent*, not malformed.
 *   There is nothing to unset, and a work with no usable ref belongs on the
 *   "cannot be refreshed" list rather than in a run of this.
 * - **`entryType`** — it is reported when it disagrees with the collection it
 *   is sitting in, and the answer to that is the right constant, which
 *   `mergeWork` already writes on every refresh. Unsetting it would take a
 *   wrong value to no value.
 *
 * Pure and dependency-free: scripts/clear_unusable_work_fields.js unsets what
 * this returns, so the decision is unit tested (./unusable_field_plan.test.js)
 * rather than discovered in production.
 */

const {
  isCorruptStringArray,
  isCorruptNumber,
  isCorruptExternalUrls,
} = require("./work_collections");

/** Fields this refuses to clear, and why, whatever `--fields` asks for. */
const NEVER_CLEARED = {
  apiRefs: "the ones the audit reports are absent, so there is nothing to unset",
  entryType:
    "a wrong entryType needs the right constant written over it, which the " +
    "backfill already does; unsetting would only lose more",
};

/**
 * Every field of a collection whose unusable value an unset can fix, in the
 * order a report should read them.
 *
 * @type {(collection: any) => string[]}
 */
const clearableFields = (collection) => [
  "externalUrls",
  ...(collection?.stringArrayFields ?? []),
  ...(collection?.numberFields ?? []),
];

/**
 * What to unset from the works of one collection, and what to leave alone.
 *
 * `blocked` means the same thing as in ./orphan_review_plan.js: a condition
 * under which planning at all would be a mistake, and the caller is expected
 * to stop.
 *
 * **A value that still holds something usable is reported, not unset.** Every
 * one of the 609 in production is unusable end to end — `{}`, `[[]]`, `[""]`
 * — but `["", "Christopher Nolan"]` is corrupt by the same predicate, and an
 * unset would take the director with it. Salvaging is a `$set`, which is a
 * different script and a different decision; this one prints those and moves
 * on. Which elements survive is asked of the same predicate, one element at a
 * time, so it cannot answer differently from the check that flagged the field.
 *
 * `fields` restricts the run. A name that is not clearable for *this*
 * collection is simply absent from its plan — `publishers` is a books and
 * games field and means nothing to films — so the caller is the one that has
 * to reject a name no selected collection knows. The two fields in
 * `NEVER_CLEARED` are refused outright instead, because that is a mistake
 * about what unsetting is for rather than about which collection is which.
 *
 * @typedef {{ field: string, value: unknown }} UnusableField
 * @typedef {{ _id: any, title: string, field: string, value: unknown,
 *   kept: unknown[] }} Partial
 * @type {(collection: any, works: any[], fields?: string[]) => {
 *   blocked: string | undefined,
 *   unset: { field: string, ids: any[] }[],
 *   documents: { _id: any, title: string, fields: UnusableField[] }[],
 *   partial: Partial[],
 *   totals: {
 *     works: number,
 *     documents: number,
 *     values: number,
 *     partial: number,
 *   },
 * }}
 */
const planUnusableFieldClearing = (collection, works, fields = undefined) => {
  if (
    !Array.isArray(collection?.stringArrayFields) ||
    !Array.isArray(collection?.numberFields)
  ) {
    return {
      ...emptyPlan(),
      blocked:
        "the collection descriptor must carry stringArrayFields and " +
        "numberFields — they are what says which check a field answers to",
    };
  }
  const clearable = clearableFields(collection);

  if (!Array.isArray(works)) {
    return { ...emptyPlan(), blocked: "works must be an array" };
  }

  const refused = (fields ?? []).filter((field) => field in NEVER_CLEARED);
  if (refused.length > 0) {
    return {
      ...emptyPlan(),
      blocked: refused
        .map((field) => `${field} is never cleared: ${NEVER_CLEARED[field]}`)
        .join("; "),
    };
  }

  const wanted = clearable.filter(
    (field) => fields === undefined || fields.includes(field)
  );

  const plan = emptyPlan();
  plan.totals.works = works.length;

  const idsByField = new Map(wanted.map((field) => [field, []]));

  for (const work of works) {
    if (work === null || typeof work !== "object") continue;

    const unusable = [];
    for (const field of wanted) {
      const value = work[field];
      if (!isUnusable(collection, field, value)) continue;

      const kept = salvageable(collection, field, value);
      if (kept.length > 0) {
        plan.partial.push({
          _id: work._id,
          title: titleOf(work),
          field,
          value,
          kept,
        });
        plan.totals.partial += 1;
        continue;
      }

      unusable.push({ field, value });
      idsByField.get(field).push(work._id);
    }

    if (unusable.length === 0) continue;
    plan.documents.push({
      _id: work._id,
      title: titleOf(work),
      fields: unusable,
    });
    plan.totals.documents += 1;
    plan.totals.values += unusable.length;
  }

  // One group per field, in the report's order, and only the ones with
  // something in them: this is what the script turns into an `updateMany`
  // apiece rather than a write per document.
  plan.unset = wanted
    .map((field) => ({ field, ids: idsByField.get(field) }))
    .filter((group) => group.ids.length > 0);

  return plan;
};

module.exports = {
  NEVER_CLEARED,
  clearableFields,
  planUnusableFieldClearing,
};

///////////////////////////////////////////////////////////////////////////////

/**
 * The audit's own question, asked field by field. `externalUrls` is checked
 * for every type; the rest is which list of the collection descriptor the
 * field is named in, which is the same lookup `isCorruptField` does.
 */
const isUnusable = (collection, field, value) => {
  if (field === "externalUrls") return isCorruptExternalUrls(value);
  if (collection.stringArrayFields.includes(field)) {
    return isCorruptStringArray(value);
  }
  if (collection.numberFields.includes(field)) return isCorruptNumber(value);
  return false;
};

/**
 * The elements of an unusable value that are usable on their own — what an
 * unset would throw away over and above the corruption.
 *
 * Each element is put back through the predicate that flagged the field, as a
 * one-element value, so "which parts are bad" is answered by the definition of
 * bad rather than by a paraphrase of it. A number field has no parts: a
 * `duration` of `"120"` is one wrong value, and there is nothing inside it to
 * keep.
 */
const salvageable = (collection, field, value) => {
  if (!Array.isArray(value)) return [];
  if (field === "externalUrls") {
    return value.filter((item) => !isCorruptExternalUrls([item]));
  }
  if (collection.stringArrayFields.includes(field)) {
    return value.filter((item) => !isCorruptStringArray([item]));
  }
  return [];
};

/** What the audit calls a work, so the two reports name it the same way. */
const titleOf = (work) =>
  work.englishTranslatedTitle ?? work.originalTitle ?? "(untitled)";

const emptyPlan = () => ({
  blocked: undefined,
  unset: [],
  documents: [],
  partial: [],
  totals: {
    works: 0,
    documents: 0,
    values: 0,
    partial: 0,
  },
});
