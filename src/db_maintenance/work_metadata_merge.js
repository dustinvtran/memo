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
 *   - a field the API has nothing to say about is never cleared
 *   - apiRefs and externalUrls are unioned, so a ref we already know about
 *     survives even when the API stops returning it
 *   - with `missingOnly`, usable existing values are left alone
 *   - a stored duration is only ever refreshed by the source that wrote it
 *   - `durationSource` only travels with a `duration`
 *
 * @type {(collection: any, work: any, fresh: any, options?: { missingOnly?: boolean }) => { updates: any, notes: string[] }}
 */
const mergeWork = (collection, work, fresh, { missingOnly = false } = {}) => {
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

    if (field === "englishTranslatedTitle" && usable) {
      notes.push(
        `title changes from "${currentValue}" to "${freshValue}" — check the apiRef points at the right work`
      );
    }

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

const toParsedRefs = (value) =>
  (Array.isArray(value) ? value : []).map(parseApiRef).filter((ref) => ref);

const toValidUrls = (value) =>
  (Array.isArray(value) ? value : []).filter(
    (url) => url && typeof url.name === "string" && typeof url.url === "string"
  );

const equal = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
