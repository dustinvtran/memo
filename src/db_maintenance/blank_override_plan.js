/**
 * @file Decides which override lists with nothing readable in them may be
 * removed, and what has to be left exactly where it is.
 *
 * The write half of #395. ./blank_override_check.js is the read half and
 * scripts/audit_database.js prints it: an override wins over the work it
 * overlays — `get` in ../frontend/_includes/js/utils/columns.js merges the two
 * with `??`, and `[""]` is not nullish — so a list whose members are all blank
 * is not an empty cell. It is the work's own directors, actors or studios held
 * off the page for ever, under an anchor with no text and no destination.
 *
 * **The question here is narrower than the check's, and this is the only
 * thing that separates the two modules.** The check asks what is wrong with
 * the database. This asks what may be unset, which is a question about
 * somebody's data, so the answer has to be conservative in a way a count does
 * not: `undecided` in the check is a line in a report, and here it is an entry
 * nothing writes to. Everything that is not, beyond doubt, a list of blanks
 * over a readable work is left alone and printed.
 *
 * **The argument for removing a key at all.** Removing it restores the work's
 * own value to the row, which is the outcome in every case — the merge falls
 * through to the work the moment the override stops being nullish. And it
 * destroys no user text, because there is none: a list whose every member is
 * empty or whitespace holds nothing a person can have typed, which is why
 * `asOverride` in ../frontend/_includes/js/utils/entry_form_io.js now refuses
 * to store one. The entries carrying these were saved before it did.
 *
 * **./noop_override_plan.js will not remove them, is deliberately stricter,
 * and is right to be.** Its `isSameStoredValue` says so at line 185: it
 * compares an override against the work byte for byte and keeps anything
 * different, and `[""]` against `["Amy Sherman-Palladino"]` is a different
 * value. An empty override is not a no-op override, it is a wrong one, and the
 * two want different arguments — so this is a separate module and a separate
 * script rather than a loosened comparison in that one. Loosening it would
 * also lose the line in its output that found this population in the first
 * place: 497 of the 907 survivors it printed on 2026-09-14 were `[""]`.
 *
 * Six things are left alone, and a run prints all six:
 *
 * - **A `null` is never touched.** It is the form's deliberate "the work's
 *   value is wrong and there is no replacement", so removing it would un-clear
 *   a field somebody cleared. This is the easiest thing here to get wrong and
 *   the only one that loses a decision silently.
 * - **A list with any non-blank member is never touched**, whatever else is in
 *   it: `["", "Christopher Nolan"]` renders Nolan, and a present-but-unusable
 *   value is ./unusable_field_plan.js's shape, decided on the work rather than
 *   on somebody's entry.
 * - **Any other value is never touched**, which covers the two shapes
 *   ./blank_override_check.js names as outside its count — an empty list `[]`
 *   and a blank scalar `""`. Both do the same damage by the same route and
 *   neither is measured yet, and a script that cleared what the audit does not
 *   report could not be checked against the audit. They are kept, counted and
 *   named in the output so that the omission reads as a decision.
 * - **An entry whose work cannot be read is skipped entirely**, both the
 *   hand-typed ones that point at no work and any dangling `workRef`. For
 *   those, `overrides` is not a layer over the metadata, it *is* the metadata,
 *   so there is nothing underneath for a removal to reveal.
 * - **A key whose own name cannot be addressed is never touched.** A field
 *   holding a `.`, or starting with a `$`, makes `overrides.<field>` name
 *   something other than that key, so there is no `$unset` that reaches it one
 *   key at a time. MongoDB has allowed both in a stored document since 5.0;
 *   nothing the site writes is one, and a refusal is what happens if
 *   something ever is.
 * - **`updatedDate` is not part of a removal.** Bumping it would reorder every
 *   list on the site, which is a visible change to data nobody asked to
 *   change. Nothing here emits a `$set` at all.
 *
 * `isBlankList` and `hasRealValue` come from ./blank_override_check.js rather
 * than being defined again, so there is exactly one definition of "blank" in
 * this folder and the script clears precisely the keys the audit reports.
 * ./blank_override_plan.test.js asserts that correspondence directly rather
 * than trusting the shared import to stay shared.
 *
 * Pure and dependency-free: scripts/clear_blank_overrides.js does the I/O and
 * this decides, so the decision is unit tested in the no-install suite rather
 * than discovered against production.
 */
const { isBlankList, hasRealValue } = require("./blank_override_check");

/**
 * Which override keys may go, from which entries, and everything being left
 * behind with the reason it is being left.
 *
 * `blocked` means what it means in ./noop_override_plan.js and
 * ./blank_override_check.js: a collection read that quietly came back empty.
 * Entries that point at works beside a works collection of zero documents is
 * what a failed read looks like, and here it is worse than a misleading
 * report — every entry would look like a dangling ref, so the run would be
 * safe by accident rather than by decision. It is refused by name.
 *
 * `maskingOnly` narrows a run to the keys hiding a value the work really has,
 * which is the population a reader can see. It can only ever remove less, and
 * it exists because the two halves may reasonably be authorised separately:
 * the masking keys are damage on the public site today, and the rest are a
 * tidy-up that becomes damage the moment a refresh fills the field on the
 * work. Nothing about the argument for a removal differs between them.
 *
 * @typedef {{ field: string, stored: unknown, workValue: unknown,
 *   masks: boolean }} RemovedField
 * @typedef {{ _id: any, userId: any, workRef: any, fields: RemovedField[],
 *   dropsObject: boolean }} Removal
 * @typedef {{ _id: any, field: string, stored: unknown, workValue: unknown,
 *   reason: string }} Kept
 * @typedef {{ _id: any, workRef: any, reason: string, fields: string[],
 *   blankFields: string[] }} Skipped
 * @type {(entries: any[], works: any[],
 *   options?: { maskingOnly?: boolean }) => {
 *   blocked: string | undefined,
 *   removals: Removal[],
 *   kept: { real: Kept[], heldBack: Kept[], unaddressable: Kept[],
 *     skipped: Skipped[] },
 *   byField: Record<string, {
 *     masking: number, harmless: number, removed: number,
 *     real: number, cleared: number, undecided: number,
 *     unaddressable: number,
 *   }>,
 *   totals: {
 *     entries: number,
 *     withOverrides: number,
 *     keys: number,
 *     blankKeys: number,
 *     maskingKeys: number,
 *     harmlessKeys: number,
 *     removed: number,
 *     heldBack: number,
 *     real: number,
 *     cleared: number,
 *     unaddressable: number,
 *     skippedEntries: number,
 *     skippedKeys: number,
 *     skippedBlankKeys: number,
 *     entriesTouched: number,
 *     maskedRows: number,
 *     objectsDropped: number,
 *   },
 * }}
 */
const planBlankOverrideRemoval = (entries, works, options = {}) => {
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
        `collection came back empty — refusing to decide anything against a ` +
        `works collection that is not there. This is what a failed ` +
        `collection read looks like.`,
    };
  }

  const maskingOnly = options.maskingOnly === true;
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
      // The blank keys are still counted, even though none of them is going,
      // and only the blank ones: `byField.undecided` is the audit's own
      // `undecided`, so a field's row adds up to the key count the audit
      // prints for it. The real overrides and nulls on a skipped entry are
      // classified nowhere, because refusing to look is the point — they are
      // in the skipped entry's own line instead.
      skipped.blankFields = fields.filter((field) =>
        isBlankList(entry.overrides[field])
      );
      plan.kept.skipped.push(skipped);
      plan.totals.skippedEntries += 1;
      plan.totals.skippedKeys += fields.length;
      plan.totals.blankKeys += skipped.blankFields.length;
      plan.totals.skippedBlankKeys += skipped.blankFields.length;
      for (const field of skipped.blankFields) countOf(plan, field).undecided += 1;
      continue;
    }

    const work = worksById.get(toRefKey(entry.workRef));
    const removable = [];
    let masked = false;

    for (const field of fields) {
      const stored = entry.overrides[field];
      const counts = countOf(plan, field);

      // The name before the value. `overrides.<field>` is a path, so a key
      // holding a `.` would name something nested and a key starting with `$`
      // would be read as an operator — either way the `$unset` would not be
      // the one this decided on. MongoDB has allowed both in a stored
      // document since 5.0, so this is refusable rather than impossible, and
      // a refusal is the only safe answer: there is no path spelling that
      // reaches such a key one key at a time.
      if (!isAddressable(field)) {
        counts.unaddressable += 1;
        plan.totals.unaddressable += 1;
        plan.kept.unaddressable.push({
          _id: entry._id,
          field,
          stored,
          workValue: work[field],
          reason:
            "the key's own name is not addressable as an overrides.<field> " +
            "path, so no $unset could name just this key",
        });
        continue;
      }

      // A `null` next, and before anything else asks a question about the
      // value: it is the one stored value here that means something on its
      // own, and `isBlankList` would not call it a list anyway.
      if (isCleared(stored)) {
        counts.cleared += 1;
        plan.totals.cleared += 1;
        continue;
      }

      if (!isBlankList(stored)) {
        counts.real += 1;
        plan.totals.real += 1;
        plan.kept.real.push({
          _id: entry._id,
          field,
          stored,
          workValue: work[field],
          reason: keptReason(stored),
        });
        continue;
      }

      const masks = hasRealValue(work[field]);
      plan.totals.blankKeys += 1;
      if (masks) {
        counts.masking += 1;
        plan.totals.maskingKeys += 1;
        masked = true;
      } else {
        counts.harmless += 1;
        plan.totals.harmlessKeys += 1;
      }

      if (maskingOnly && !masks) {
        plan.totals.heldBack += 1;
        plan.kept.heldBack.push({
          _id: entry._id,
          field,
          stored,
          workValue: work[field],
          reason: "--masking-only, and this one hides nothing yet",
        });
        continue;
      }

      counts.removed += 1;
      plan.totals.removed += 1;
      removable.push({ field, stored, workValue: work[field], masks });
    }

    if (removable.length === 0) continue;

    const dropsObject = removable.length === fields.length;
    plan.removals.push({
      _id: entry._id,
      userId: entry.userId,
      workRef: entry.workRef,
      fields: removable,
      dropsObject,
    });
    plan.totals.entriesTouched += 1;
    if (masked) plan.totals.maskedRows += 1;
    if (dropsObject) plan.totals.objectsDropped += 1;
  }

  return plan;
};

/**
 * The `$unset` this removal is, as the field paths it names.
 *
 * Kept here rather than in the script so that what gets written is decided in
 * the tested module: the whole bound on this script is *which* keys it names,
 * and `$unset` of `overrides` when the removal accounted for every key in the
 * object is the one place that shape widens. It never returns a `$set`, and
 * every path it returns is under `overrides` — so `status`, `score`, the
 * dates, `workRef` and the note are unreachable from here, and an `$unset`
 * can neither create, delete nor repoint a document.
 *
 * @type {(removal: { fields: { field: string }[], dropsObject: boolean }) =>
 *   Record<string, "">}
 */
const unsetPaths = (removal) =>
  removal.dropsObject
    ? { overrides: "" }
    : Object.fromEntries(
        removal.fields.map(({ field }) => [`overrides.${field}`, ""])
      );

module.exports = {
  planBlankOverrideRemoval,
  unsetPaths,
};

///////////////////////////////////////////////////////////////////////////////

/**
 * Why a value that is not a list of blanks is being kept, in the words the
 * output needs.
 *
 * The two named shapes are the ones ./blank_override_check.js deliberately
 * does not count, and they are named here for the same reason: a reader
 * looking for why a row they can see is still empty after a run should find
 * the answer in the run's own output rather than in a file header.
 */
const keptReason = (stored) => {
  if (Array.isArray(stored) && stored.length === 0) {
    return "an empty list, which #395 did not measure and this does not clear";
  }
  if (typeof stored === "string" && stored.trim() === "") {
    return "a blank scalar, which #395 did not measure and this does not clear";
  }
  return "a real override";
};

/**
 * Whether `overrides.<field>` names this key and only this key.
 *
 * Every field the site writes is a plain identifier, so in practice this
 * refuses nothing — the point is that it refuses rather than mis-addresses if
 * one ever is not.
 */
const isAddressable = (field) =>
  typeof field === "string" &&
  field.length > 0 &&
  !field.includes(".") &&
  !field.startsWith("$");

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

const countOf = (plan, field) =>
  (plan.byField[field] ??= {
    masking: 0,
    harmless: 0,
    removed: 0,
    real: 0,
    cleared: 0,
    undecided: 0,
    unaddressable: 0,
  });

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

const emptyPlan = () => ({
  blocked: undefined,
  removals: [],
  kept: { real: [], heldBack: [], unaddressable: [], skipped: [] },
  byField: {},
  totals: {
    entries: 0,
    withOverrides: 0,
    keys: 0,
    blankKeys: 0,
    maskingKeys: 0,
    harmlessKeys: 0,
    removed: 0,
    heldBack: 0,
    real: 0,
    cleared: 0,
    unaddressable: 0,
    skippedEntries: 0,
    skippedKeys: 0,
    skippedBlankKeys: 0,
    entriesTouched: 0,
    maskedRows: 0,
    objectsDropped: 0,
  },
});
