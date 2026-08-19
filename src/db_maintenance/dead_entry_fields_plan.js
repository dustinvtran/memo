/**
 * @file Decides which entry documents may have their dead fields removed, and
 * which must be left alone.
 *
 * Two fields on an entry document are read by nothing:
 *
 * - **`review`** — the note's home is the `*Reviews` collections, which is
 *   where `getReview`, the export and the history all read it from. The copy
 *   on the entry is written by the update path and served to no one:
 *   `toUserEntriesPipeline` in ../api/utils/db/queries.js projects it away
 *   specifically so it cannot reach a response.
 * - **`commonMetadata`** — a pre-migration snapshot of the work document the
 *   entry points at. `getUserEntries` in ../api/controllers/entries.js sets
 *   `commonMetadata: work.data` from the `$lookup` *after* spreading the
 *   entry, so the stored value is overwritten on every read whether or not
 *   the entry has a `workRef` at all. The 23 hand-typed entries that point at
 *   no work are no exception: they render from `overrides` over the empty
 *   stand-in, which is what they already do today.
 *
 * So `commonMetadata` may go on sight. `review` may not — not because
 * anything reads it, but because dropping 1034 notes on the *assumption* that
 * the other copy is there is not the same as knowing it is. This module's
 * real job is that check, and its answer for an entry it cannot verify is to
 * leave the whole document alone.
 *
 * There is one place `entry.review` is still read: `toSnapshot` in
 * ../api/utils/revision_history.js takes `reviewText ?? entryData.review`, so
 * a revision falls back to the entry's copy when the review document has no
 * text. Verbatim equality is exactly the condition under which that fallback
 * cannot change its answer — which is the other reason the check is equality
 * and not merely existence.
 *
 * Pure and dependency-free: scripts/strip_dead_entry_fields.js unsets fields
 * based on what this returns, so the decision is unit tested
 * (./dead_entry_fields_plan.test.js) rather than discovered in production.
 */

/** The fields on an entry document that no reader uses. */
const DEAD_FIELDS = ["review", "commonMetadata"];

/**
 * Which entries may have which of `fields` unset, and which may not.
 *
 * `blocked` is the important return value, and it means the same thing here
 * as in ./orphan_review_plan.js: a collection read that quietly came back
 * empty. Planning `review` removals against no reviews at all would call
 * every entry a mismatch — which is safe, since a mismatch is refused, but it
 * is safe by accident and reads in the output as a database full of divergent
 * notes. The combination is never legitimate, so it is refused by name and
 * the caller is expected to stop.
 *
 * An entry whose stored note cannot be matched, verbatim, to a review
 * document is skipped **entirely** — `commonMetadata` included. The two
 * fields are unrelated, but the reason to skip is not: a document we do not
 * understand is not one to write to.
 *
 * @typedef {{ _id: any, reason: string, entryChars: number, storedChars: number | undefined }} Mismatch
 * @type {(entries: any[], reviews: any[], fields?: string[]) => {
 *   blocked: string | undefined,
 *   review: { ids: any[], jsonChars: number },
 *   commonMetadata: { ids: any[], nulls: number, objects: number, jsonChars: number },
 *   mismatches: Mismatch[],
 *   totals: {
 *     entries: number,
 *     carryingReview: number,
 *     carryingCommonMetadata: number,
 *     skipped: number,
 *   },
 * }}
 */
const planDeadFieldRemoval = (entries, reviews, fields = DEAD_FIELDS) => {
  if (!Array.isArray(entries) || !Array.isArray(reviews)) {
    return {
      ...emptyPlan(),
      blocked: "entries and reviews must both be arrays",
    };
  }

  const wanted = new Set(fields);
  const unknown = [...wanted].filter((field) => !DEAD_FIELDS.includes(field));
  if (unknown.length > 0) {
    return { ...emptyPlan(), blocked: `not a dead field: ${unknown.join(", ")}` };
  }

  const carryingReview = entries.filter(carriesReview);

  if (carryingReview.length > 0 && reviews.length === 0) {
    return {
      ...emptyPlan(),
      blocked:
        `${carryingReview.length} entry(s) carry a note but the reviews ` +
        `collection came back empty — refusing to call every one of them a ` +
        `mismatch. This is what a failed collection read looks like.`,
    };
  }

  const storedTexts = toTextsByEntry(reviews);
  const plan = emptyPlan();
  plan.totals.entries = entries.length;
  plan.totals.carryingReview = carryingReview.length;
  plan.totals.carryingCommonMetadata =
    entries.filter(carriesCommonMetadata).length;

  for (const entry of entries) {
    if (carriesReview(entry)) {
      const mismatch = toMismatch(entry, storedTexts.get(toRefKey(entry._id)));
      if (mismatch) {
        plan.mismatches.push(mismatch);
        plan.totals.skipped += 1;
        continue;
      }
      if (wanted.has("review")) {
        plan.review.ids.push(entry._id);
        plan.review.jsonChars += jsonChars(entry.review);
      }
    }

    if (carriesCommonMetadata(entry) && wanted.has("commonMetadata")) {
      plan.commonMetadata.ids.push(entry._id);
      plan.commonMetadata.jsonChars += jsonChars(entry.commonMetadata);
      if (entry.commonMetadata === null) plan.commonMetadata.nulls += 1;
      else plan.commonMetadata.objects += 1;
    }
  }

  return plan;
};

module.exports = {
  DEAD_FIELDS,
  planDeadFieldRemoval,
};

///////////////////////////////////////////////////////////////////////////////

/**
 * Why this entry's note cannot be dropped, or `undefined` if it can.
 *
 * The test is that some review document filed under this entry holds the
 * *same value*, not merely that one exists. An empty note counts: an entry
 * storing `""` beside a review document storing `""` is verified, and one
 * storing `""` beside a review document with no `text` field at all is not.
 * `undefined` and `""` read the same on a page and differently in
 * `toSnapshot`, which drops an undefined field from a revision instead of
 * recording it as empty.
 *
 * @type {(entry: any, storedTexts: unknown[] | undefined) => Mismatch | undefined}
 */
const toMismatch = (entry, storedTexts) => {
  const texts = storedTexts ?? [];
  if (texts.length === 0) {
    return {
      _id: entry._id,
      reason: "no review document",
      entryChars: textLength(entry.review),
      storedChars: undefined,
    };
  }
  if (texts.some((text) => text === entry.review)) return undefined;

  return {
    _id: entry._id,
    reason: "review document holds different text",
    entryChars: textLength(entry.review),
    // The longest of them: what getting a mismatch wrong costs is the text
    // that would go, so the number worth printing is the most there is on the
    // other side.
    storedChars: Math.max(...texts.map(textLength)),
  };
};

/**
 * The notes filed under each entry, keyed the way an `_id` compares. An entry
 * has one review document in practice, but nothing in the schema says so, and
 * a plan that assumed it would silently compare against whichever of a pair
 * the driver happened to return first.
 */
const toTextsByEntry = (reviews) =>
  reviews.reduce((byEntry, review) => {
    const key = toRefKey(review?.entryRef);
    if (key === undefined) return byEntry;
    return byEntry.set(key, [...(byEntry.get(key) ?? []), review?.text]);
  }, new Map());

/**
 * Presence, not truthiness. A field holding `null` or `""` is still a field
 * being stored, read out of Atlas and sent, and is exactly as dead as one
 * holding a kilobyte — 762 of the stored `commonMetadata` are literally
 * `null`.
 */
const carriesReview = (entry) =>
  entry !== null && typeof entry === "object" && "review" in entry;

const carriesCommonMetadata = (entry) =>
  entry !== null && typeof entry === "object" && "commonMetadata" in entry;

/** `undefined` and `null` are not ids, and must not compare equal as strings. */
const toRefKey = (id) =>
  id === undefined || id === null ? undefined : String(id);

/** What the field costs to store, near enough to size a run by. */
const jsonChars = (value) => (JSON.stringify(value) ?? "").length;

const textLength = (text) => (typeof text === "string" ? text.length : 0);

const emptyPlan = () => ({
  blocked: undefined,
  review: { ids: [], jsonChars: 0 },
  commonMetadata: { ids: [], nulls: 0, objects: 0, jsonChars: 0 },
  mismatches: [],
  totals: {
    entries: 0,
    carryingReview: 0,
    carryingCommonMetadata: 0,
    skipped: 0,
  },
});
