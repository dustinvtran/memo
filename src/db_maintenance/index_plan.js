/**
 * @file The indexes the database is supposed to have, and the comparison that
 * decides which of them are missing. Pure and dependency-free, so it can be
 * unit tested without a database — see index_plan.test.js.
 *
 * The I/O lives in scripts/ensure_indexes.js.
 *
 * Almost every query the site makes goes through `_findOneByField` /
 * `_findAllByField` in ../api/utils/db/unsafe_functions.js, which is an
 * equality `$match` on one field, so almost every index below is a single
 * ascending field named after the field one of those calls is given. `_id` is
 * already indexed by MongoDB itself.
 *
 * Two exceptions want a compound index. The entry list sorts as well as
 * matches, and a compound index lets the sort be *served* rather than
 * performed — see the `updatedDate` entry below. `findDraft` matches on three
 * fields rather than one, and a compound index takes it from a seek plus an
 * in-memory filter to a single seek — see the `entryRevisions` entries.
 *
 * The collection names come from ../api/utils/work_types.js, which is pure
 * too, so this file stays testable without an install.
 */

const { WORK_TYPES } = require("../api/utils/work_types");

/** The four of each, in the order the rest of the folder lists them. */
const ENTRY_COLLECTIONS = WORK_TYPES.map((workType) => workType.entries);
const REVIEW_COLLECTIONS = WORK_TYPES.map((workType) => workType.reviews);
const WORK_COLLECTIONS = WORK_TYPES.map((workType) => workType.works);

/**
 * @typedef {{
 *   collection: string,
 *   key: Record<string, 1 | -1>,
 *   options?: { unique?: boolean },
 *   why: string,
 * }} DesiredIndex
 *
 * `why` is printed by the dry run. An index nobody can name a query for is an
 * index to delete, so every one of these has to be able to say what it is for.
 * @type {DesiredIndex[]}
 */
const DESIRED_INDEXES = [
  {
    collection: "users",
    key: { username: 1 },
    // Unique closes the check-then-write race in the rename path: assignName
    // reads the name and writes it in two round trips, so two people claiming
    // one name at the same moment both pass the read. See #98 and name.js.
    options: { unique: true },
    why: "findIdOfName, getUserStats, getUserFromName, setOwnName — almost every request",
  },
  {
    collection: "users",
    key: { userId: 1 },
    why: "findOwnName, setBio, assignName",
  },
  // Kept, though the compound index below begins with `userId` and a compound
  // index serves its own prefix — so anything this one can answer, that one can
  // answer too. It stays for two reasons. Dropping an index is a human's call
  // (CLAUDE.md), and nothing here drops one anyway: taking an entry out of this
  // list does not remove it from the database, it only leaves it live and no
  // longer declared, which is the one state worse than either. And it is the
  // narrower index — `toScoreTallyPipeline`'s four `$group`s match on `userId`
  // and read no dates, so they walk fewer bytes through it.
  ...ENTRY_COLLECTIONS.map((collection) => ({
    collection,
    key: { userId: 1 },
    why: "the $match in toScoreTallyPipeline, /api/export, refreshStats",
  })),
  // The list query, `toUserEntriesPipeline` in ../api/utils/db/queries.js, is
  // `$match: { userId }` then `$sort: { updatedDate: -1, _id: 1 }` then
  // `$limit`. Matching on the `userId` index alone leaves the sort a *blocking*
  // one: every one of the user's entries has to be read and ordered before the
  // limit can take five, and a blocking sort gives up at 100 MB rather than
  // spilling. Walking a compound index in order instead means the limit stops
  // the scan after five documents.
  //
  // `_id` is in the key because the sort names it. An index serves a sort only
  // when the sort is a prefix of what the index has left after the equality
  // match, so `{ userId: 1, updatedDate: -1 }` on its own serves
  // `{ updatedDate: -1 }` but not `{ updatedDate: -1, _id: 1 }` — the planner
  // would add the blocking sort back to break the ties. Which would matter:
  // the ties are the reason `_id` is in the sort at all, a bulk import stamping
  // a whole list with one millisecond.
  //
  // Directions have to line up too, and here they do: the index is read
  // forwards for `{ updatedDate: -1, _id: 1 }`.
  ...ENTRY_COLLECTIONS.map((collection) => ({
    collection,
    key: { userId: 1, updatedDate: -1, _id: 1 },
    why: "the sort and limit in toUserEntriesPipeline — every list load and every profile load",
  })),
  // These four are declared without a query behind them, which is the opposite
  // of what this file asks for, so here is the whole of it.
  //
  // They were justified by "the local side of the $lookup in
  // _findAllUserEntriesWithMetadata", and a `$lookup` uses an index on the
  // *foreign* side: `toUserEntriesPipeline` joins `localField: 'workRef'` to
  // `foreignField: '_id'` on the works collection, so the index that serves it
  // is `works._id`, which MongoDB maintains itself. The local field is read off
  // documents the `$match` and the `$sort` have already chosen; there is
  // nothing left for an index on it to do.
  //
  // Nor does anything else ask for one. `workRef` appears in exactly three
  // places outside the pipeline, and none of them is a filter on it:
  // dedupe_works.js repoints entries at a survivor with
  // `updateMany({ _id: { $in: ids } }, ...)`, having grouped them by `workRef`
  // in Node from a full `find()` (see work_dedupe_plan.js); audit_database.js
  // and backfill_game_playtimes.js do the same reading in memory.
  //
  // So the trade as it stands is four indexes maintained on every entry write,
  // and nothing reads them. That is an index to drop by the rule at the top of
  // this file — but dropping one is a human's call (CLAUDE.md) and nothing here
  // drops anything anyway: deleting the entry would only leave the indexes live
  // and no longer declared, which is worse than either. So they stay declared,
  // honestly, until someone decides. See #180.
  ...ENTRY_COLLECTIONS.map((collection) => ({
    collection,
    key: { workRef: 1 },
    why: "no query — the $lookup that named these joins on works._id, and dedupe_works.js repoints by _id; see the comment above and #180",
  })),
  ...REVIEW_COLLECTIONS.map((collection) => ({
    collection,
    key: { entryRef: 1 },
    why: "getReview on every expanded row, findReviews in the export",
  })),
  // Kept beside the compound index below for the reason the plain `userId` one
  // is kept beside its compound: the compound serves this index's prefix, so
  // this answers nothing that one cannot, but undeclaring it would leave it
  // live in the database and no longer explained. It is also the narrower
  // index, and discardHistory's delete on `entryRef` alone reads no other
  // field, so it walks fewer bytes through this one.
  {
    collection: "entryRevisions",
    key: { entryRef: 1 },
    why: "every history read, every draft read, every save, and discardHistory when an entry is deleted",
  },
  // `findDraft` asks `{ entryRef, kind: 'draft', userId }` and is the hottest
  // read in this collection — once every 2.5 seconds per open edit form. On the
  // single-field index above, the seek lands on the entry and the server then
  // filters the rest in memory: up to MAX_REVISIONS_PER_ENTRY (50) documents
  // read to keep one, each carrying a whole snapshot including the note. With
  // all three fields in the index it is one seek to the one document.
  //
  // `findRevisions` matches `{ entryRef, kind: 'revision' }`, which is this
  // index's prefix, so it is served by the same index — and `kind` being second
  // rather than last is what makes that true. `userId` is last because it is
  // the field only findDraft adds.
  {
    collection: "entryRevisions",
    key: { entryRef: 1, kind: 1, userId: 1 },
    why: "findDraft on every autosave, once every 2.5s while an edit form is open; findRevisions on every history read is served by its prefix",
  },
  // `apiRefs` is an array, so this is a **multikey** index — one index entry
  // per element. That is correct and is not something to "fix": findCachedWork
  // asks `{ apiRefs: "igdb__1234" }`, an equality match against one element,
  // which is exactly what multikey serves.
  ...WORK_COLLECTIONS.map((collection) => ({
    collection,
    key: { apiRefs: 1 },
    why: "findCachedWork, on every works/retrieve",
  })),
];

/**
 * MongoDB's own default name for a key, `field_1` joined with `_`. Naming
 * these explicitly rather than letting the server name them means a hand-made
 * `db.entryRevisions.createIndex({ entryRef: 1 })` — the thing the README used
 * to ask for — is recognised as the same index rather than collided with.
 * @type {(key: Record<string, number>) => string}
 */
const indexName = (key) =>
  Object.entries(key)
    .map(([field, direction]) => `${field}_${direction}`)
    .join("_");

/**
 * The only option any index here sets. Comparing a normalised pair of these
 * rather than the whole option object keeps a server-supplied default (`v`,
 * `ns`) from reading as a difference.
 * @type {(options?: { unique?: boolean }) => { unique: boolean }}
 */
const comparableOptions = (options) => ({ unique: options?.unique === true });

const sameKey = (a, b) =>
  JSON.stringify(Object.entries(a ?? {})) ===
  JSON.stringify(Object.entries(b ?? {}));

const sameOptions = (a, b) =>
  JSON.stringify(comparableOptions(a)) === JSON.stringify(comparableOptions(b));

/**
 * Sorts each desired index into one of three buckets against what the database
 * already has. `createIndexes` is idempotent for an identical spec, so
 * `satisfied` is what makes a re-run a no-op.
 *
 * `conflicting` is the case that would otherwise surface as a driver error:
 * MongoDB refuses to build an index whose name or key collides with an
 * existing one that isn't identical — the same key under a different name, or
 * the same name with different options (a non-unique `username_1` where we
 * want a unique one). Neither can be fixed by creating anything, so they are
 * reported for a human to drop by hand rather than thrown.
 *
 * @typedef {{ name: string, key: Record<string, number>, unique?: boolean }} ExistingIndex
 * @typedef {{ create: DesiredIndex[], satisfied: DesiredIndex[], conflicting: (DesiredIndex & { existing: ExistingIndex, reason: string })[] }} IndexPlan
 * @type {(desired: DesiredIndex[], existingByCollection: Record<string, ExistingIndex[]>) => IndexPlan}
 */
const planIndexes = (desired, existingByCollection) => {
  const plan = { create: [], satisfied: [], conflicting: [] };

  for (const index of desired) {
    const name = indexName(index.key);
    const existing = existingByCollection[index.collection] ?? [];

    const byName = existing.find((e) => e.name === name);
    const byKey = existing.find((e) => sameKey(e.key, index.key));
    const match = byName ?? byKey;

    if (!match) {
      plan.create.push(index);
    } else if (
      match.name === name &&
      sameKey(match.key, index.key) &&
      sameOptions(match, index.options)
    ) {
      plan.satisfied.push(index);
    } else {
      plan.conflicting.push({ ...index, existing: match, reason: reasonFor(index, match, name) });
    }
  }

  return plan;
};

/**
 * Groups documents by the value of `field`, keeping only the values more than
 * one document carries. A unique index cannot be built over one of these, so
 * this is what the script checks before asking for one.
 *
 * A missing field is grouped under `null`, because that is how MongoDB indexes
 * it: two users with no username at all collide on a unique index exactly as
 * two users named "nil" do.
 *
 * @type {(documents: object[], field: string) => { value: unknown, ids: unknown[] }[]}
 */
const duplicateValues = (documents, field) => {
  const groups = new Map();
  for (const document of documents) {
    const raw = document?.[field];
    const value = raw === undefined ? null : raw;
    const key = JSON.stringify(value);
    if (!groups.has(key)) groups.set(key, { value, ids: [] });
    groups.get(key).ids.push(document?._id);
  }
  return [...groups.values()].filter(({ ids }) => ids.length > 1);
};

/** The indexes whose creation a duplicate check has to clear first. */
/** @type {(desired: DesiredIndex[]) => DesiredIndex[]} */
const uniqueIndexes = (desired) =>
  desired.filter(({ options }) => options?.unique === true);

module.exports = {
  ENTRY_COLLECTIONS,
  REVIEW_COLLECTIONS,
  WORK_COLLECTIONS,
  DESIRED_INDEXES,
  indexName,
  planIndexes,
  duplicateValues,
  uniqueIndexes,
};

///////////////////////////////////////////////////////////////////////////////

const reasonFor = (index, match, name) => {
  if (match.name !== name) {
    return `${match.name} already indexes the same key under a different name`;
  }
  if (!sameKey(match.key, index.key)) {
    return `${name} exists over a different key, ${JSON.stringify(match.key)}`;
  }
  return (
    `${name} exists with ${match.unique === true ? "" : "no "}unique option, ` +
    `but ${index.options?.unique === true ? "" : "no "}unique is wanted`
  );
};
