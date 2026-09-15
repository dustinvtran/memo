/**
 * @file Decides which stored overrides are copies of the work they override,
 * and which are decisions a person made and must be left alone.
 *
 * An override on an entry document shadows the work's own metadata in the two
 * places the merge happens — the row builder in
 * ../frontend/_includes/js/components/list/list.js and `withOverrides` in
 * ../api/utils/export_view.js — so a value stored here wins over the works
 * collection for ever. Until #321, `readForm` compared the form against
 * `data.apiData`, a name nothing set, so every comparison was against
 * `undefined` and every save wrote the whole form back as the user's
 * overrides. 5982 of the 8511 override keys in production on 2026-09-14 are a
 * byte-identical copy of the value they override. #317.
 *
 * **An identical copy is not a user decision.** It is the artefact of that
 * comparison, and removing it changes nothing a reader sees: the merge puts
 * the work's value on the row whether the copy is there or not. What it does
 * change is the future — a correction to the work reaches the page instead of
 * losing to a stale copy of the value it corrected. That matters now rather
 * than in principle, because #336 has put the metadata refresh on a schedule
 * and a backfill applied 398 corrections on 2026-09-14, 341 of them TV shows
 * that gained a director, none of which can reach an entry pinned this way.
 *
 * Three things are therefore left alone, and the script prints all three:
 *
 * - **A different value is a real override.** It is what the user typed, and
 *   the whole feature.
 * - **A `null` is a real override too**, and the easiest one to get wrong. It
 *   is the form's way of saying "the work's value is wrong and there is no
 *   replacement" — see `asOverride` in
 *   ../frontend/_includes/js/utils/entry_form_io.js. Removing it would
 *   un-clear a field the user deliberately cleared, which is a visible change
 *   to somebody's list.
 * - **An entry with no work is left entirely alone.** For the 23 hand-typed
 *   entries that point at no work, `overrides` is not a layer over the
 *   metadata, it *is* the metadata: there is nothing to compare against and
 *   nothing that could replace it. A dangling `workRef` is reported the same
 *   way, because a work we cannot read is not one to decide against.
 *
 * **The comparison is against the work document, never against the entry's
 * `commonMetadata`.** Both the row builder and `getUserEntries` hand out a
 * `commonMetadata` that already has the overrides folded into it, so
 * comparing against that would find every override identical to itself and
 * propose deleting the lot, the real ones included. The stale
 * `commonMetadata` still stored on some entry documents is no better: #176
 * measured it as a pre-migration snapshot that disagrees with the works
 * collection it mirrors. `planNoopOverrideRemoval` takes the works and joins
 * them itself so there is no call site left that could pass the wrong thing.
 *
 * Pure and dependency-free: scripts/clear_noop_overrides.js does the I/O and
 * this decides, so the decision is unit tested (./noop_override_plan.test.js)
 * in the no-install suite rather than discovered in production.
 */

/**
 * Which overrides may go, from which entries, and what is being left behind.
 *
 * `blocked` means the same thing here as in ./orphan_review_plan.js:
 * a collection read that quietly came back empty.
 * Entries that point at works beside a works collection of zero documents
 * would make every one of those entries look like a dangling ref — safe,
 * since an entry with no work is skipped, but safe by accident, and it reads
 * in the output as a database that has lost its works. The combination is
 * never legitimate, so it is refused by name.
 *
 * @typedef {{ _id: any, field: string, stored: unknown, workValue: unknown }} Kept
 * @typedef {{ _id: any, workRef: any, reason: string, fields: string[] }} Skipped
 * @typedef {{ _id: any, workRef: any, fields: string[], dropsObject: boolean, jsonChars: number }} Removal
 * @type {(entries: any[], works: any[]) => {
 *   blocked: string | undefined,
 *   removals: Removal[],
 *   kept: { real: Kept[], skipped: Skipped[] },
 *   byField: Record<string, { removed: number, real: number, cleared: number }>,
 *   totals: {
 *     entries: number,
 *     withOverrides: number,
 *     keys: number,
 *     removed: number,
 *     real: number,
 *     cleared: number,
 *     skippedEntries: number,
 *     skippedKeys: number,
 *     entriesTouched: number,
 *     objectsDropped: number,
 *     jsonChars: number,
 *   },
 * }}
 */
const planNoopOverrideRemoval = (entries, works) => {
  if (!Array.isArray(entries) || !Array.isArray(works)) {
    return {
      ...emptyPlan(),
      blocked: "entries and works must both be arrays",
    };
  }

  const pointing = entries.filter((entry) => toRefKey(entry?.workRef));
  if (pointing.length > 0 && works.length === 0) {
    return {
      ...emptyPlan(),
      blocked:
        `${pointing.length} entry(s) point at a work but the works ` +
        `collection came back empty — refusing to call every one of them a ` +
        `dangling ref. This is what a failed collection read looks like.`,
    };
  }

  const worksById = toWorksById(works);
  const plan = emptyPlan();
  plan.totals.entries = entries.length;

  for (const entry of entries) {
    const fields = overrideFields(entry);
    if (fields.length === 0) continue;
    plan.totals.withOverrides += 1;
    plan.totals.keys += fields.length;

    const skipped = toSkipped(entry, worksById, fields);
    if (skipped) {
      plan.kept.skipped.push(skipped);
      plan.totals.skippedEntries += 1;
      plan.totals.skippedKeys += fields.length;
      continue;
    }

    const work = worksById.get(toRefKey(entry.workRef));
    const removable = [];
    let jsonChars = 0;

    for (const field of fields) {
      const stored = entry.overrides[field];
      const counts = (plan.byField[field] ??= emptyFieldCounts());

      if (isCleared(stored)) {
        counts.cleared += 1;
        plan.totals.cleared += 1;
        continue;
      }
      if (!isSameStoredValue(work?.[field], stored)) {
        counts.real += 1;
        plan.totals.real += 1;
        plan.kept.real.push({
          _id: entry._id,
          field,
          stored,
          workValue: work?.[field],
        });
        continue;
      }

      counts.removed += 1;
      plan.totals.removed += 1;
      removable.push(field);
      jsonChars += keyChars(field, stored);
    }

    if (removable.length === 0) continue;

    const dropsObject = removable.length === fields.length;
    plan.removals.push({
      _id: entry._id,
      workRef: entry.workRef,
      fields: removable,
      dropsObject,
      jsonChars,
    });
    plan.totals.entriesTouched += 1;
    if (dropsObject) plan.totals.objectsDropped += 1;
    plan.totals.jsonChars += jsonChars;
  }

  return plan;
};

module.exports = {
  planNoopOverrideRemoval,
  isSameStoredValue,
};

///////////////////////////////////////////////////////////////////////////////

/**
 * Whether the stored override is the work's own value written out again.
 *
 * **Strict, and deliberately stricter than the form's own `isSameValue`.**
 * That one forgives blanks inside a list, so it calls `[""]` and `[]` the
 * same thing — which is the right answer for the question it asks (did the
 * user type something new) and the wrong one for this one (would removing
 * this change what the page draws). `directors: [""]` over a work with no
 * directors renders an empty list where the work renders nothing, and #292
 * has a render crash from a field of that shape, so it is not this script's
 * to tidy: ./unusable_field_plan.js is where a present-but-unusable value is
 * decided, and it decides it on the work rather than on somebody's entry.
 *
 * Arrays compare element by element, in order, because order is what a list
 * column prints. Recursion into plain objects covers `externalUrls`-shaped
 * values; anything else — a Date, an ObjectId, a class instance — falls
 * through to `===` and so is kept unless it is literally the same reference.
 * Keeping something that could have gone is a run that removes less than it
 * might; the other mistake is somebody's data.
 *
 * @type {(workValue: unknown, stored: unknown) => boolean}
 */
function isSameStoredValue(workValue, stored) {
  if (workValue === stored) return true;

  if (Array.isArray(workValue) || Array.isArray(stored)) {
    return (
      Array.isArray(workValue) &&
      Array.isArray(stored) &&
      workValue.length === stored.length &&
      workValue.every((item, at) => isSameStoredValue(item, stored[at]))
    );
  }

  if (!isPlainObject(workValue) || !isPlainObject(stored)) return false;

  const keys = Object.keys(workValue);
  return (
    keys.length === Object.keys(stored).length &&
    keys.every(
      (key) => key in stored && isSameStoredValue(workValue[key], stored[key])
    )
  );
}

/**
 * A `null` or a missing value is the form's "cleared", and the one thing here
 * that must never be removed. `undefined` counts because the driver maps
 * BSON's deprecated undefined onto it, and a snapshot read back off disk can
 * carry either.
 */
const isCleared = (value) => value === null || value === undefined;

/** Why this entry cannot be decided, or `undefined` if it can. */
const toSkipped = (entry, worksById, fields) => {
  const key = toRefKey(entry.workRef);
  if (key === undefined) {
    return {
      _id: entry._id,
      workRef: entry.workRef,
      reason: "entry points at no work",
      fields,
    };
  }
  if (!worksById.has(key)) {
    return {
      _id: entry._id,
      workRef: entry.workRef,
      reason: "workRef points at a work that is gone",
      fields,
    };
  }
  return undefined;
};

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

/**
 * What the key costs to store, near enough to size a run by: the field name,
 * the value, and the two bytes of punctuation that join them.
 */
const keyChars = (field, value) =>
  JSON.stringify(field).length + (JSON.stringify(value) ?? "").length + 2;

const emptyFieldCounts = () => ({ removed: 0, real: 0, cleared: 0 });

const emptyPlan = () => ({
  blocked: undefined,
  removals: [],
  kept: { real: [], skipped: [] },
  byField: {},
  totals: {
    entries: 0,
    withOverrides: 0,
    keys: 0,
    removed: 0,
    real: 0,
    cleared: 0,
    skippedEntries: 0,
    skippedKeys: 0,
    entriesTouched: 0,
    objectsDropped: 0,
    jsonChars: 0,
  },
});
