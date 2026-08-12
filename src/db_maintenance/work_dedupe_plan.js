/**
 * @file Works out which duplicate works to collapse and into what.
 *
 * The work collections hold multiple documents describing the same work —
 * in some cases one per entry that referenced it.
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
 * The first prefix the work has a ref for, in `identityPrefixes` order.
 *
 * Only prefixes that actually establish identity count. An hltb id names a
 * HowLongToBeat page rather than the game, and 27 games carry the placeholder
 * `hltb__N/A`, so grouping on one would present unrelated games as copies of
 * one another. `parseApiRef` drops placeholder values, so a work whose only
 * ref is one of those is left ungrouped and untouched.
 */
const groupKey = (collection, work) => {
  const refs = (Array.isArray(work.apiRefs) ? work.apiRefs : [])
    .map(parseApiRef)
    .filter((ref) => ref);

  for (const prefix of collection.identityPrefixes) {
    const match = refs.find((ref) => ref.name === prefix);
    // Books are keyed on the bare identifier: ISBN__x and google__x are the
    // same book. Everything else keeps its prefix.
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
 * Groups whose members disagree about the title are NOT returned unless
 * `includeTitleMismatches` is set. Sharing an apiRef does not mean being the
 * same work: "Fargo - Season 1" and "Fargo - Season 2" sit under one show id,
 * five Haruhi Suzumiya volumes share one ISBN, and "Demons" is filed under
 * The Da Vinci Code's. Those are distinct works, so a title disagreement is a
 * stop sign.
 *
 * @type {(collection: any, works: any[], entries: any[], options?: { includeTitleMismatches?: boolean }) => Array<{
 *   key: string,
 *   survivorId: string,
 *   duplicateIds: string[],
 *   updates: object,
 *   entriesToRepoint: string[],
 *   titles: string[],
 *   titlesAgree: boolean,
 * }>}
 */
const planDedupe = (
  collection,
  works,
  entries,
  { includeTitleMismatches = false } = {}
) => {
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

    const titles = ranked.map(
      (w) => w.englishTranslatedTitle ?? w.originalTitle ?? "(untitled)"
    );
    const titlesAgree = new Set(titles.map(normalizeTitle)).size === 1;

    if (!titlesAgree && !includeTitleMismatches) continue;

    plans.push({
      key,
      survivorId: survivor._id,
      duplicateIds: duplicates.map((w) => w._id),
      updates: fillGapsFromDuplicates(collection, survivor, duplicates),
      entriesToRepoint: duplicates.flatMap((w) =>
        (entriesByWorkRef.get(w._id) ?? []).map((e) => e._id)
      ),
      titles,
      titlesAgree,
    });
  }

  return plans;
};

/** Punctuation and case vary between imports; a real difference doesn't. */
const normalizeTitle = (title) =>
  String(title)
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]/gu, "");

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
  normalizeTitle,
  groupKey,
  planDedupe,
  fillGapsFromDuplicates,
};

///////////////////////////////////////////////////////////////////////////////

const equal = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
