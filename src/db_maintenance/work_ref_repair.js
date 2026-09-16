/**
 * @file Whether a work may be given an identity ref, and what that write is.
 *
 * 168 works carry no ref their type can be retrieved by, and every one of them
 * is on somebody's list — the ones nobody had were pruned. They arrived by
 * four routes: stripped by #290's repair because they wore another work's id,
 * carrying a placeholder that never identified anything, pointing at an id the
 * API has since dropped, or simply predating all of it. Nothing here could put
 * one right, because every script in this folder operates on a population and
 * this repair is inherently per-work: a human looks the id up.
 *
 * **The rule this module exists to enforce is that a human looking an id up is
 * exactly where #290 happened.** `Kingdom Hearts` under Kingdom Hearts III's
 * id, `Demons` under a French *Angels & Demons* ISBN — ids that were typed in
 * good faith and named something else. So the id is retrieved and the title it
 * answers with is compared against the stored one before anything is written,
 * using the same `titlesAgree` the backfill guard uses, and a disagreement is
 * refused rather than warned about.
 *
 * Pure and dependency-free: the retrieve lives in scripts/set_work_ref.js and
 * the verdict lives here, so the decision is covered by the no-install suite.
 */
const { parseApiRef, findApiRef, titlesAgree, displayTitle } = require("./work_collections");

/**
 * Why this work cannot be given this ref, or `undefined` if it can.
 *
 * Checked in this order because each answer is cheaper and more certain than
 * the next, and because the last one costs an API call that the first three
 * make unnecessary.
 *
 * @type {(args: {
 *   collection: any, work: any, ref: string, retitleWorkTo?: string,
 *   retrieved?: any, retrieveError?: string, otherHolders?: any[],
 * }) => string | undefined}
 */
const refusalReason = ({ collection, work, ref, retitleWorkTo, retrieved, retrieveError, otherHolders }) => {
  if (!work) return "no work with that id";

  const parsed = parseApiRef(ref);
  if (!parsed) {
    return `"${ref}" is not a usable ref — it must read <prefix>__<id>, and a placeholder is not an id`;
  }
  if (parsed.name !== collection.retrievePrefix) {
    return `a ${collection.type} work is retrieved by ${collection.retrievePrefix}__, not ${parsed.name}__`;
  }

  // Not a merge tool. Two works under one id is the defect #290 and #340 are
  // about, and handing one out a second time would be creating it deliberately.
  if (otherHolders?.length) {
    return `${ref} already names ${otherHolders.map(displayTitle).join(", ")} — give that work the entries instead, or pick a different id`;
  }

  // Refusing rather than replacing: a work that already answers is not the
  // population this is for, and overwriting one is how a good ref becomes a
  // bad one with no record that it changed.
  const existing = findApiRef(work.apiRefs, collection.retrievePrefix);
  if (existing) return `already has ${collection.retrievePrefix}__${existing}; this only fills a work that has none`;

  if (retrieveError) return `the API would not answer for ${ref}: ${retrieveError}`;
  if (!retrieved) return `${ref} names nothing`;

  // The whole point. #290 is a human typing an id in good faith that named
  // something else, and this is the one check that would have caught it.
  //
  // `retitleWorkTo` is the way past it, and it is deliberately not a `--force`.
  // The guard cannot tell a wrong id from a right id under a name of your own
  // — `Doom mod: Sigil` against IGDB's `Sigil`, `Portal 2: Coop` against
  // `Portal 2` — so it refuses both, and this is how a person says which one
  // they are looking at. What makes it evidence rather than a switch is that
  // it is checked against the answer the API just gave: naming the API's own
  // title is something you can only do having read it, and a guess is refused
  // exactly as a wrong id is.
  if (titlesAgree(work, retrieved) === false) {
    if (!retitleWorkTo) {
      return `stored title "${displayTitle(work)}" but ${ref} names "${displayTitle(retrieved)}" — one of them is not this work`;
    }
    if (titlesAgree({ englishTranslatedTitle: retitleWorkTo }, retrieved) === false) {
      return `retitleWorkTo "${retitleWorkTo}" is not what ${ref} names ("${displayTitle(retrieved)}") — give the API's own title, which is how this says you read it`;
    }
  }
  return undefined;
};

/**
 * What to write, once `refusalReason` has said nothing.
 *
 * `metadataUpdatedDate` is dropped so the next refresh treats the work as
 * never checked and fills everything the missing ref has been keeping empty —
 * which is the entire reason for giving it one. The ref is appended rather
 * than replacing `apiRefs`, because the placeholders and legacy ids a work
 * carries are a record of where it has been and cost nothing to keep.
 * @type {(work: any, ref: string, retitleTo?: string) => { set: object, unset: object }}
 */
const refUpdate = (work, ref, retitleTo) => ({
  set: {
    apiRefs: [...(Array.isArray(work.apiRefs) ? work.apiRefs : []), ref],
    // Only when `refusalReason` has passed a `retitleWorkTo`, and set to what
    // the API answered rather than to what was typed: the two agree by then,
    // and the API's spelling is the one every later refresh will compare
    // against. `originalTitle` is left alone on purpose - it is fill-only for
    // the same reason, and overwriting a work's Japanese title with a romaji
    // one to get a playtime is a trade this folder has already made once.
    ...(retitleTo ? { englishTranslatedTitle: retitleTo } : {}),
  },
  unset: { metadataUpdatedDate: "" },
});

module.exports = { refusalReason, refUpdate };
