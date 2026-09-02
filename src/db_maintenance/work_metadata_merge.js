/**
 * @file The rules for deciding what a cached work is missing and how fresh
 * API data should be folded into it.
 *
 * Pure and dependency-free on purpose: this is the part of the backfill that
 * can silently corrupt the database, so it is unit tested
 * (./work_metadata_merge.test.js) without needing a DB or API keys.
 */
const {
  COMMON_FIELDS,
  parseApiRef,
  findApiRef,
  displayTitle,
  titlesAgree,
  isEmptyValue,
  isCorruptStringArray,
  isCorruptNumber,
  isCorruptExternalUrls,
} = require("./work_collections");

/** The metadata fields we expect an adapter to fill for a given type. */
const expectedFields = (collection) => [
  ...COMMON_FIELDS,
  ...collection.stringArrayFields.filter((f) => !COMMON_FIELDS.includes(f)),
];

const isCorruptField = (collection, field, value) => {
  if (collection.stringArrayFields.includes(field)) {
    return isCorruptStringArray(value);
  }
  if (collection.numberFields.includes(field)) return isCorruptNumber(value);
  return false;
};

/** Every field of a work whose stored value is unusable. */
const corruptFieldsOf = (collection, work) => {
  const corrupt = [];
  if (!Array.isArray(work.apiRefs)) corrupt.push("apiRefs");
  if (isCorruptExternalUrls(work.externalUrls)) corrupt.push("externalUrls");
  if (work.entryType !== collection.entryType) corrupt.push("entryType");
  for (const field of collection.stringArrayFields) {
    if (isCorruptStringArray(work[field])) corrupt.push(field);
  }
  for (const field of collection.numberFields) {
    if (isCorruptNumber(work[field])) corrupt.push(field);
  }
  return corrupt;
};

/**
 * A game whose playtime column has a number to show and nothing to link it
 * to. This mirrors `toPlaytimeUrl` in
 * ../frontend/_includes/js/utils/columns.js: an IGDB-sourced duration links
 * to the IGDB page it came from, anything else links to HowLongToBeat.
 *
 * Reported by the audit, but deliberately *not* part of `hasGaps` — no API
 * can fix it any more. HowLongToBeat's is gone, so a game whose duration
 * predates IGDB will never gain a link, and re-running the adapter at it
 * forever would only waste the call.
 */
const isMissingPlaytimeLink = (collection, work) => {
  if (collection.type !== "games" || isEmptyValue(work.duration)) return false;
  const source = work.durationSource === "igdb" ? "igdb" : "hltb";
  const hasUrl = (Array.isArray(work.externalUrls) ? work.externalUrls : []).some(
    (url) => url?.name === source
  );
  return source === "igdb"
    ? !hasUrl
    : !hasUrl && !findApiRef(work.apiRefs, "hltb");
};

/** True when a work is worth spending an API call on. */
const hasGaps = (collection, work) =>
  expectedFields(collection).some((field) => isEmptyValue(work[field])) ||
  corruptFieldsOf(collection, work).length > 0 ||
  (Array.isArray(work.apiRefs) &&
    work.apiRefs.some((ref) => parseApiRef(ref)?.flat === false));

/**
 * Builds the `$set` payload for one work. Rules:
 *   - a work whose title the API disagrees with is refused outright
 *   - a field the API has nothing to say about is never cleared
 *   - apiRefs and externalUrls are unioned, so a ref we already know about
 *     survives even when the API stops returning it
 *   - with `missingOnly`, usable existing values are left alone
 *   - a stored duration is only ever refreshed by the source that wrote it
 *   - `durationSource` only travels with a `duration`
 *
 * `refused` is set instead of `updates` when the first rule fires, so that a
 * caller reports the skip rather than filing it under "already current" —
 * which is what an empty `updates` means everywhere else.
 *
 * @type {(collection: any, work: any, fresh: any, options?: { missingOnly?: boolean }) => { updates: any, notes: string[], refused?: string }}
 */
const mergeWork = (collection, work, fresh, { missingOnly = false } = {}) => {
  const refused = titleConflict(work, fresh);
  if (refused) return { updates: {}, notes: [refused], refused };

  const updates = {};
  const notes = [];

  for (const [field, freshValue] of Object.entries(fresh)) {
    if (field === "entryType") continue;
    // Handled after the loop, where it can be tied to the duration it
    // describes without depending on which key the adapter listed first.
    if (field === "durationSource") continue;
    if (isEmptyValue(freshValue)) continue;

    const currentValue = work[field];

    if (field === "apiRefs") {
      const merged = mergeApiRefs(currentValue, freshValue, { missingOnly });
      if (!equal(currentValue, merged)) updates.apiRefs = merged;
      continue;
    }

    if (field === "externalUrls") {
      const merged = mergeExternalUrls(currentValue, freshValue, { missingOnly });
      if (!equal(currentValue, merged)) updates.externalUrls = merged;
      continue;
    }

    // A playtime already on the site is left where it is unless the source
    // offering a new one is the source that put it there. IGDB's times come
    // from a median of three submissions and HowLongToBeat's from far more,
    // so replacing one with the other would move numbers people already read,
    // for the worse. Types whose duration never carried a source (a film's
    // runtime, a book's page count) compare undefined to undefined and
    // refresh as they always did.
    if (
      field === "duration" &&
      !isEmptyValue(currentValue) &&
      work.durationSource !== fresh.durationSource
    ) {
      if (!missingOnly) {
        notes.push(
          `kept the stored duration ${currentValue} (${
            work.durationSource ?? "source unrecorded"
          }); ${fresh.durationSource ?? "the API"} offered ${freshValue}`
        );
      }
      continue;
    }

    const usable =
      !isEmptyValue(currentValue) &&
      !isCorruptField(collection, field, currentValue);
    if (missingOnly && usable) continue;
    if (equal(currentValue, freshValue)) continue;

    updates[field] = freshValue;
  }

  // Provenance describes the duration stored beside it, so it is written with
  // one and never on its own. Alone it would claim a playtime that came from
  // HowLongToBeat years ago was measured by whoever the adapter asks today —
  // exactly the confusion recording provenance is meant to end.
  if ("duration" in updates && !isEmptyValue(fresh.durationSource)) {
    updates.durationSource = fresh.durationSource;
  }

  if (work.entryType !== collection.entryType) {
    updates.entryType = collection.entryType;
  }

  return { updates, notes };
};

/**
 * Existing refs are kept. A ref the API now reports under a name we already
 * hold replaces the old one, unless `missingOnly` asked us not to touch what
 * is already there.
 */
const mergeApiRefs = (currentValue, freshValue, { missingOnly = false } = {}) => {
  const byName = new Map(
    toParsedRefs(currentValue).map(({ name, ref }) => [name, ref])
  );

  for (const { name, ref } of toParsedRefs(freshValue)) {
    if (missingOnly && byName.has(name)) continue;
    byName.set(name, ref);
  }

  return [...byName.entries()].map(([name, ref]) => `${name}__${ref}`);
};

const mergeExternalUrls = (
  currentValue,
  freshValue,
  { missingOnly = false } = {}
) => {
  const byName = new Map(toValidUrls(currentValue).map((u) => [u.name, u.url]));

  for (const { name, url } of toValidUrls(freshValue)) {
    if (missingOnly && byName.has(name)) continue;
    byName.set(name, url);
  }

  return [...byName.entries()].map(([name, url]) => ({ name, url }));
};

/** How many of the expected fields a work actually has. Used to pick a
 * survivor when the same work was cached more than once. */
const completeness = (collection, work) =>
  expectedFields(collection).filter(
    (field) =>
      !isEmptyValue(work[field]) && !isCorruptField(collection, field, work[field])
  ).length;

module.exports = {
  expectedFields,
  isCorruptField,
  corruptFieldsOf,
  isMissingPlaytimeLink,
  hasGaps,
  mergeWork,
  mergeApiRefs,
  mergeExternalUrls,
  completeness,
};

///////////////////////////////////////////////////////////////////////////////

/**
 * Why this response must not be merged into this work, or undefined when it
 * may be.
 *
 * The apiRef is the only thing tying the two together, and it is not always
 * telling the truth. Twenty-five groups of works in the database carry an id
 * that belongs to a *different* work — `Among Us` under The Wolf Among Us's
 * IGDB id, Dostoevsky's `Demons` under The Da Vinci Code's ISBN — and every
 * one of them was filled in by a `--missing-only` backfill that took the ref
 * at its word. Their titles survived only because a title was never the
 * missing field. A run without `--missing-only` overwrites those too, and at
 * that point the pair is indistinguishable and the damage is unrecoverable
 * except from a snapshot. #290.
 *
 * So a title disagreement stops the merge dead. It used to be written and
 * annotated, which put the one signal that the ref is wrong in a note beneath
 * the write it should have prevented.
 *
 * **Nothing at all is written, the `entryType` repair included.** If the ref
 * names another work then this call was about another work, and the safe
 * amount to take from it is none of it. The audit reports a wrong `entryType`
 * separately, and the next run makes it once the ref is right.
 *
 * A genuine retitling — TMDB correcting a name — lands here too, and is meant
 * to: it is a human's call which of the two names the work, and correcting the
 * stored title by hand lets the next run through. `titlesAgree` answers
 * `undefined` rather than `false` when either side has no title, so a work
 * that is missing one is filled in as it always was.
 * @type {(work: any, fresh: any) => string | undefined}
 */
const titleConflict = (work, fresh) =>
  titlesAgree(work, fresh) === false
    ? `refused: stored title "${displayTitle(work)}" but the apiRef names ` +
      `"${displayTitle(fresh)}" — one of them is filed under the other's id`
    : undefined;

const toParsedRefs = (value) =>
  (Array.isArray(value) ? value : []).map(parseApiRef).filter((ref) => ref);

const toValidUrls = (value) =>
  (Array.isArray(value) ? value : []).filter(
    (url) => url && typeof url.name === "string" && typeof url.url === "string"
  );

const equal = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
