/**
 * @file Decides which cached works nothing can reach, and which review
 * documents hold nothing anybody could read.
 *
 * Two populations, two arguments, one module because they are the same shape
 * of claim: a document exists, and no code path the site has can put it in
 * front of a reader. #339.
 *
 * **A work is only ever reached through an entry's `workRef`.** That is the
 * whole of it — `findAllUserEntriesWithMetadata_` in
 * ../api/utils/db/queries.js joins `workRef` to `_id`, and
 * `/api/works/retrieve/:type/:ref` looks one up by apiRef and caches it under
 * the same key. So a work no entry names is not hidden data; it is data with
 * no door, exactly as ./orphan_review_plan.js says of a review whose entry is
 * gone. Most of the 184 are the residue of the hole #174 closed: `retrieve`
 * was unauthenticated and also *wrote*, so walking an API's ids anonymously
 * left a work document per id.
 *
 * **Reachability is asked of every entry collection, not the matching one.**
 * The audit asks only the matching one (`auditCollection` in
 * scripts/audit_database.js reads one triple at a time), which is right for a
 * count and wrong for a delete: nothing in the schema stops a `bookEntries`
 * row carrying the `_id` of a document in `films`, and "no entry of this type
 * points at it" is a weaker claim than the one a deletion needs.
 * `planUnreachableWorks` therefore takes every entry collection at once and
 * reports, in `crossCollection`, any work that only a foreign collection
 * reaches — a number worth printing whether it is zero or not, because zero is
 * the evidence that the wider question was asked.
 *
 * **An empty review is a different argument, and a narrower one.**
 * ./orphan_review_plan.js deletes notes no code path can reach. This deletes
 * notes a code path reaches and finds empty — `getReview` in
 * ../api/controllers/reviews.js answers with the document, the panel renders
 * `review?.data?.text || '*None yet...*'`, and an empty string draws exactly
 * what a missing document draws. They exist because `createEntry` writes a
 * review whenever `review !== undefined` and the form always sends the field.
 *
 * The thing that makes that safe is not that an empty string is meaningless —
 * it is deliberately a real value, and #213 is the bug that comes of confusing
 * it with an absent one. It is that `updateEntry_` in
 * ../api/controllers/entries.js writes
 * `existingReview ? updateByRef_(...) : create_(...)`, so the document comes
 * back on the next save whether or not it is there now, and every reader
 * treats the two states alike: `getReview` answers `{}` for a missing one,
 * `findReviews` in ../api/controllers/export.js already filters on
 * `review?.text` so an empty note is not exported either way, and
 * `changedFields` in ../api/utils/revision_history.js calls `''` and
 * `undefined` the same absence, so no version is recorded and no diff is drawn
 * that would not have been. The tests in
 * ../api/controllers/entries.test.js and ./unreachable_document_plan.test.js
 * pin that rather than trusting this paragraph.
 *
 * One asymmetry survives and is worth naming: `writeForm` in
 * ../frontend/_includes/js/utils/entry_form_io.js restores a snapshot's note
 * only `if (snapshot.review !== undefined)`, so a version recorded *after* a
 * prune omits the key and restoring it leaves whatever is in the textarea
 * instead of emptying it. It takes an entry whose note was empty at the
 * version being restored and is not empty now, and it is a restore rather than
 * a save. That is the whole of the behavioural difference, and it is why this
 * half is `--only=reviews` and a separate decision.
 *
 * **What is refused.** A work in a group two other checks have open questions
 * about is skipped rather than deleted, and printed. ./title_year_check.js
 * (#319, #322) reports works that agree on a title and a year under different
 * ids, and ./shared_ref_check.js reports works under one id whose titles
 * agree; several of those groups are a live document beside an unreachable
 * one, and the unreachable one is the evidence for a decision nobody has made.
 * A prune that took it would settle the question by destroying it.
 *
 * Reviews whose *entry* is gone are left alone too, and counted separately.
 * They are ./orphan_review_plan.js's population and its argument, and the
 * argument here — "a save recreates the document" — is not available for an
 * entry that no longer exists. One script per claim.
 *
 * Pure and dependency-free: scripts/prune_unreachable_documents.js deletes
 * documents based on what this returns, so the decision is unit tested
 * (./unreachable_document_plan.test.js) rather than discovered in production.
 */

const { hasText, toRefKey } = require("./orphan_review_plan");

/** Why a work this found is being deleted, or is being left where it is. */
const WORK_REASONS = {
  unreachable: "no entry in any collection points at it",
  titleYearGroup:
    "in an open title-and-year group (#319, #322) — deleting it would " +
    "destroy the evidence for a decision nobody has made",
  sharedIdentityRef:
    "in an open shared-id group — the same unresolved decision, found from " +
    "the other side",
};

/** The same, for reviews. */
const REVIEW_REASONS = {
  empty: "empty note; the entry is there, and a save writes the document again",
  withText: "holds a note somebody wrote",
  orphaned: "its entry is gone — prune_orphan_reviews.js's population, not this one",
};

/**
 * The works of one collection that no entry anywhere names, split into the
 * ones this may delete and the ones it refuses to.
 *
 * `entriesByCollection` is every entry collection in the database, keyed by
 * name — not the matching one. See the header.
 *
 * `protectedWorkIds` is the ids the collision checks have an open question
 * about, as `[{ id, reason }]`, so the skip line can say which check objected.
 *
 * `blocked` is the return value to read first, and it means the same thing it
 * means in ./orphan_review_plan.js: what was handed over is what a failed
 * collection read looks like, and planning from it would delete the database.
 * Two shapes are refused, both categorical rather than thresholded:
 *
 *   - **An entry collection came back empty.** All four hold entries in
 *     production and have since there was anything to hold, so an empty one is
 *     a read that returned nothing and did not throw. Every work of every type
 *     would then look unreachable through it.
 *   - **Not one work in the collection is reachable.** Even with all four
 *     entry lists non-empty, a `workRef` field read under the wrong name, or a
 *     collection paired with the wrong entries, produces exactly that and
 *     nothing else does: the real figure is 3% to 7%.
 *
 * @type {(input: {
 *   works: any[],
 *   entriesByCollection: Record<string, any[]>,
 *   ownEntryCollection?: string,
 *   protectedWorkIds?: Array<{ id: unknown, reason: string }>,
 * }) => {
 *   blocked: string | undefined,
 *   works: number,
 *   reachable: number,
 *   unreachable: any[],
 *   deletable: any[],
 *   skipped: Array<{ work: any, reason: string }>,
 *   crossCollection: any[],
 * }}
 */
const planUnreachableWorks = ({
  works,
  entriesByCollection,
  ownEntryCollection,
  protectedWorkIds = [],
}) => {
  const nothing = {
    blocked: undefined,
    works: 0,
    reachable: 0,
    unreachable: [],
    deletable: [],
    skipped: [],
    crossCollection: [],
  };

  if (!Array.isArray(works)) {
    return { ...nothing, blocked: "works must be an array" };
  }

  const collections = Object.entries(entriesByCollection ?? {});
  if (collections.length === 0) {
    return {
      ...nothing,
      blocked:
        "no entry collections were handed over — reachability cannot be " +
        "decided from the works alone",
    };
  }
  if (collections.some(([, entries]) => !Array.isArray(entries))) {
    return { ...nothing, blocked: "every entry collection must be an array" };
  }

  if (works.length === 0) return { ...nothing };

  const empty = collections
    .filter(([, entries]) => entries.length === 0)
    .map(([name]) => name);
  if (empty.length > 0) {
    return {
      ...nothing,
      works: works.length,
      blocked:
        `${empty.join(", ")} came back empty. Every collection holds entries ` +
        `in production, so this is what a failed read looks like, and every ` +
        `work would be unreachable through it.`,
    };
  }

  const refsByCollection = new Map(
    collections.map(([name, entries]) => [name, workRefsOf(entries)])
  );
  const anyReference = (key) =>
    [...refsByCollection.values()].some((refs) => refs.has(key));

  const unreachable = [];
  const crossCollection = [];
  for (const work of works) {
    const key = toRefKey(work?._id);
    if (key !== undefined && anyReference(key)) {
      if (!refsByCollection.get(ownEntryCollection)?.has(key)) {
        crossCollection.push(work);
      }
      continue;
    }
    unreachable.push(work);
  }

  const reachable = works.length - unreachable.length;
  if (reachable === 0) {
    return {
      ...nothing,
      works: works.length,
      blocked:
        `all ${works.length} work(s) look unreachable — refusing to treat a ` +
        `whole collection as residue. This is what a workRef read under the ` +
        `wrong name, or a collection paired with the wrong entries, looks like.`,
    };
  }

  const protectedById = new Map(
    protectedWorkIds
      .map(({ id, reason }) => [toRefKey(id), reason])
      .filter(([id]) => id !== undefined)
  );

  const deletable = [];
  const skipped = [];
  for (const work of unreachable) {
    const reason = protectedById.get(toRefKey(work?._id));
    if (reason === undefined) deletable.push(work);
    else skipped.push({ work, reason });
  }

  return {
    blocked: undefined,
    works: works.length,
    reachable,
    unreachable,
    deletable,
    skipped,
    crossCollection,
  };
};

/**
 * The reviews of one collection that hold no text and whose entry is still
 * there, with the two populations this deliberately does not touch counted
 * beside them.
 *
 * `blocked` is ./orphan_review_plan.js's guard and is here for the same
 * reason: with no entries at all, every review looks orphaned, and this would
 * quietly report the whole collection as somebody else's problem rather than
 * noticing the read had failed.
 *
 * @type {(entries: any[], reviews: any[]) => {
 *   blocked: string | undefined,
 *   deletable: any[],
 *   withText: any[],
 *   orphaned: any[],
 *   reviews: number,
 * }}
 */
const planEmptyReviewRemoval = (entries, reviews) => {
  const nothing = {
    blocked: undefined,
    deletable: [],
    withText: [],
    orphaned: [],
    reviews: 0,
  };

  if (!Array.isArray(entries) || !Array.isArray(reviews)) {
    return { ...nothing, blocked: "entries and reviews must both be arrays" };
  }
  if (reviews.length === 0) return { ...nothing };
  if (entries.length === 0) {
    return {
      ...nothing,
      reviews: reviews.length,
      blocked:
        `${reviews.length} review(s) but no entries at all — refusing to ` +
        `decide what is reachable. This is what a failed collection read ` +
        `looks like.`,
    };
  }

  const entryIds = new Set(
    entries.map((entry) => toRefKey(entry?._id)).filter((id) => id !== undefined)
  );

  const deletable = [];
  const withText = [];
  const orphaned = [];
  for (const review of reviews) {
    const ref = toRefKey(review?.entryRef);
    if (ref === undefined || !entryIds.has(ref)) orphaned.push(review);
    else if (hasText(review)) withText.push(review);
    else deletable.push(review);
  }

  return {
    blocked: undefined,
    deletable,
    withText,
    orphaned,
    reviews: reviews.length,
  };
};

module.exports = {
  WORK_REASONS,
  REVIEW_REASONS,
  planUnreachableWorks,
  planEmptyReviewRemoval,
};

///////////////////////////////////////////////////////////////////////////////

/**
 * The `workRef`s of one entry collection, as comparison keys.
 *
 * `toRefKey` and not the raw value, so an entry carrying `null` cannot spare a
 * work whose `_id` stringifies to "null" — the same accident
 * ./orphan_review_plan.js guards against from the other end. 23 entries in
 * production carry no `workRef` at all: they are user-authored and expected,
 * and they reference nothing.
 */
const workRefsOf = (entries) =>
  new Set(
    entries
      .map((entry) => toRefKey(entry?.workRef))
      .filter((ref) => ref !== undefined)
  );
