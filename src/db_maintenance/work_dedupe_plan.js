/**
 * @file Works out which duplicate works to collapse and into what.
 *
 * populate_work_collections.js created one work document per *entry*, so the
 * same film cached for two users became two documents. The books path made it
 * worse: the works controller looked books up as `google__<isbn>` while the
 * adapter cached them as `ISBN__<isbn>`, so every retrieve missed the cache
 * and created another copy.
 *
 * Pure and dependency-free: dedupe_works.js deletes documents based on what
 * this returns, so the decisions are unit tested
 * (./work_dedupe_plan.test.js) rather than discovered in production.
 */
const { parseApiRef, isEmptyValue } = require("./work_collections");
const {
  expectedFields,
  isCorruptField,
  mergeApiRefs,
  mergeExternalUrls,
  completeness,
} = require("./work_metadata_merge");

/**
 * Groups works by every apiRef they carry that the type can be retrieved by.
 * A work is only ever placed in one group, so two duplicates that overlap on
 * one ref but not another are still collapsed together.
 * @type {(collection: any, works: any[]) => Map<string, any[]>}
 */
const groupWorksByApiRef = (collection, works) => {
  const groups = new Map();
  for (const work of works) {
    const key = groupKey(collection, work);
    if (!key) continue;
    groups.set(key, [...(groups.get(key) ?? []), work]);
  }
  return groups;
};

/**
 * The first prefix the work has a ref for, in `apiRefPrefixes` order, so a
 * book stored as `ISBN__x` and a book stored as `google__x` land in the same
 * group when they share the identifier.
 */
const groupKey = (collection, work) => {
  const refs = (Array.isArray(work.apiRefs) ? work.apiRefs : [])
    .map(parseApiRef)
    .filter((ref) => ref);

  for (const prefix of collection.apiRefPrefixes) {
    const match = refs.find((ref) => ref.name === prefix);
    // Books are keyed on the bare identifier: ISBN__x and google__x are the
    // same book. Everything else keeps its prefix, since an igdb id and an
    // hltb id are different numbering schemes.
    if (match) {
      return collection.type === "books" ? match.ref : `${prefix}__${match.ref}`;
    }
  }
  return undefined;
};

/**
 * One plan per group that has more than one work in it.
 *
 * The survivor is the most complete document, tie-broken by how many entries
 * already point at it and then by id, so the plan is deterministic and
 * re-running after a partial failure converges.
 *
 * @type {(collection: any, works: any[], entries: any[]) => Array<{
 *   key: string,
 *   survivorId: string,
 *   duplicateIds: string[],
 *   updates: object,
 *   entriesToRepoint: string[],
 *   titles: string[],
 * }>}
 */
const planDedupe = (collection, works, entries) => {
  const entriesByWorkRef = new Map();
  for (const entry of entries) {
    if (!entry.workRef) continue;
    entriesByWorkRef.set(entry.workRef, [
      ...(entriesByWorkRef.get(entry.workRef) ?? []),
      entry,
    ]);
  }

  const entryCount = (work) => (entriesByWorkRef.get(work._id) ?? []).length;

  const plans = [];
  for (const [key, group] of groupWorksByApiRef(collection, works)) {
    if (group.length < 2) continue;

    const ranked = [...group].sort(
      (a, b) =>
        completeness(collection, b) - completeness(collection, a) ||
        entryCount(b) - entryCount(a) ||
        String(a._id).localeCompare(String(b._id))
    );

    const [survivor, ...duplicates] = ranked;

    plans.push({
      key,
      survivorId: survivor._id,
      duplicateIds: duplicates.map((w) => w._id),
      updates: fillGapsFromDuplicates(collection, survivor, duplicates),
      entriesToRepoint: duplicates.flatMap((w) =>
        (entriesByWorkRef.get(w._id) ?? []).map((e) => e._id)
      ),
      titles: ranked.map(
        (w) => w.englishTranslatedTitle ?? w.originalTitle ?? "(untitled)"
      ),
    });
  }

  return plans;
};

/**
 * Nothing a duplicate knows is thrown away: any field the survivor is missing
 * is taken from the first duplicate that has a usable value, and refs and
 * links from every copy are unioned in.
 */
const fillGapsFromDuplicates = (collection, survivor, duplicates) => {
  const updates = {};

  for (const field of expectedFields(collection)) {
    const usable = (work) =>
      !isEmptyValue(work[field]) &&
      !isCorruptField(collection, field, work[field]);
    if (usable(survivor)) continue;
    const donor = duplicates.find(usable);
    if (donor) updates[field] = donor[field];
  }

  // `missingOnly` so the survivor's own refs and links win; a duplicate can
  // only contribute a name the survivor doesn't already have.
  const keepExisting = { missingOnly: true };

  const apiRefs = duplicates.reduce(
    (merged, duplicate) =>
      mergeApiRefs(merged, duplicate.apiRefs ?? [], keepExisting),
    survivor.apiRefs ?? []
  );
  if (!equal(apiRefs, survivor.apiRefs)) updates.apiRefs = apiRefs;

  const externalUrls = duplicates.reduce(
    (merged, duplicate) =>
      mergeExternalUrls(merged, duplicate.externalUrls ?? [], keepExisting),
    survivor.externalUrls ?? []
  );
  if (!equal(externalUrls, survivor.externalUrls)) {
    updates.externalUrls = externalUrls;
  }

  return updates;
};

module.exports = {
  groupWorksByApiRef,
  groupKey,
  planDedupe,
  fillGapsFromDuplicates,
};

///////////////////////////////////////////////////////////////////////////////

const equal = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
