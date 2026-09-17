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
 *   replacesRef?: string, retrieved?: any, retrieveError?: string,
 *   otherHolders?: any[],
 * }) => string | undefined}
 */
const refusalReason = ({ collection, work, ref, retitleWorkTo, replacesRef, retrieved, retrieveError, otherHolders }) => {
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

  // A work that already answers is not the population this fills, and
  // overwriting one silently is how a good ref becomes a bad one with no
  // record that it changed. `replacesRef` is the way past that, and it is the
  // same kind of evidence as `retitleWorkTo` below rather than a `--force`:
  // naming the id you are taking off is something you can only do having read
  // it, so a typo, a stale worklist or the wrong row refuses instead of
  // writing. #378 is the population it exists for — works whose stored id
  // retrieves cleanly and names something else entirely, where there is no
  // missing ref to fill and the only repair is to take the wrong one off.
  const existing = findApiRef(work.apiRefs, collection.retrievePrefix);
  const held = existing ? `${collection.retrievePrefix}__${existing}` : undefined;
  if (existing && !replacesRef) {
    return `already has ${held}; this fills a work that has none, or replaces the ref you name with replacesRef`;
  }
  if (replacesRef && !existing) {
    return `replacesRef "${replacesRef}" but this work carries no ${collection.retrievePrefix}__ ref to replace`;
  }
  if (replacesRef && replacesRef !== held) {
    return `replacesRef "${replacesRef}" is not the ref this work carries (${held}) — name the one you are taking off`;
  }
  if (replacesRef && replacesRef === ref) return `${ref} is already this work's ref; there is nothing to replace`;

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
 *
 * **A `replacesRef` is the exception, and it is dropped rather than kept.** A
 * placeholder identifies nothing and is harmless beside a real id; a wrong id
 * is a working id for another work, and `findApiRef` takes the first of its
 * prefix it finds. Leaving it in would let the next refresh retrieve the thing
 * this repair exists to stop pointing at.
 * @type {(work: any, ref: string, retitleTo?: string, replacesRef?: string) => { set: object, unset: object }}
 */
const refUpdate = (work, ref, retitleTo, replacesRef) => ({
  set: {
    apiRefs: [
      ...(Array.isArray(work.apiRefs) ? work.apiRefs : []).filter((r) => r !== replacesRef),
      ref,
    ],
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
