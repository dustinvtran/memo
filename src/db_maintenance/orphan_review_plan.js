/**
 * @file Decides which reviews are unreachable and may be removed.
 *
 * A review is only ever found by `entryRef` — `getReview` in
 * ../api/controllers/reviews.js looks it up by that and nothing else — so a
 * review whose entry is gone cannot be read, edited or deleted by any code
 * path the site has. It is not hidden data; it is data with no door.
 *
 * These accumulated because until `fix: delete an entry's review along with
 * the entry` (#117, 2026-08-12) deleting an entry removed the entry and left
 * the review behind. The population is that bug's backlog: every one was
 * written against an entry that existed at the time.
 *
 * Pure and dependency-free: scripts/prune_orphan_reviews.js deletes documents
 * based on what this returns, so the decision is unit tested
 * (./orphan_review_plan.test.js) rather than discovered in production.
 */

/**
 * The reviews in `reviews` whose `entryRef` names no document in `entries`.
 *
 * `blocked` is the important return value. Planning from an empty entry list
 * would mark *every* review orphaned, which is exactly what a failed or
 * mis-typed collection read looks like from here — the query returns `[]` and
 * nothing throws. Since the entry collections are never legitimately empty
 * while reviews exist, that combination is treated as a broken read and
 * refused rather than planned, and the caller is expected to stop.
 *
 * @type {(entries: any[], reviews: any[]) => {
 *   blocked: string | undefined,
 *   orphans: any[],
 *   withText: any[],
 *   empty: any[],
 *   keptCount: number,
 * }}
 */
const planOrphanReviewRemoval = (entries, reviews) => {
  const empty = { blocked: undefined, orphans: [], withText: [], empty: [], keptCount: 0 };

  if (!Array.isArray(entries) || !Array.isArray(reviews)) {
    return { ...empty, blocked: "entries and reviews must both be arrays" };
  }
  if (reviews.length === 0) return { ...empty };
  if (entries.length === 0) {
    return {
      ...empty,
      blocked:
        `${reviews.length} review(s) but no entries at all — refusing to treat ` +
        `every review as orphaned. This is what a failed collection read looks like.`,
    };
  }

  const entryIds = new Set(entries.map((entry) => String(entry._id)));
  const orphans = reviews.filter((review) => {
    const ref = toRefKey(review?.entryRef);
    return ref === undefined || !entryIds.has(ref);
  });

  return {
    blocked: undefined,
    orphans,
    withText: orphans.filter(hasText),
    empty: orphans.filter((review) => !hasText(review)),
    keptCount: reviews.length - orphans.length,
  };
};

/**
 * A review document is written for every entry whether or not a note was
 * typed — see `createEntry` in ../api/controllers/entries.js — so most of
 * these hold nothing at all. Worth counting separately: an empty one is
 * bookkeeping, and a full one is somebody's writing.
 */
const hasText = (review) =>
  typeof review?.text === "string" && review.text.length > 0;

/**
 * `undefined` and `null` are not ids. Without this a review carrying no
 * `entryRef` would be compared as the string "undefined", and would be
 * spared by an entry that happened to have that id.
 */
const toRefKey = (entryRef) =>
  entryRef === undefined || entryRef === null ? undefined : String(entryRef);

module.exports = {
  planOrphanReviewRemoval,
  hasText,
  toRefKey,
};
