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
 * A worklist row may offer more than one id, and `refCandidates` and
 * `chooseRef` are the order they are tried in — see #388 and the two of them
 * below. Nothing about the guard is softened by that: each id in the queue is
 * asked the same question, and the one thing that does not travel down the
 * queue is the one piece of evidence that is about a single id.
 *
 * Pure and dependency-free: the retrieve lives in scripts/set_work_ref.js and
 * the verdict lives here, so the decision is covered by the no-install suite.
 */
const { parseApiRef, findApiRef, titlesAgree, displayTitle } = require("./work_collections");

/** A worklist field that was left blank is absent, not an empty claim. */
const filledIn = (value) =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

/**
 * The ids to try for one worklist row, in the order they are to be tried.
 *
 * **Why a row carries more than one id.** scripts/propose_work_refs.js ranks
 * several candidates per work and its own header says the score is for
 * ordering rather than deciding — TMDB answers `Hero` with `THE RIBBON HERO`
 * first and `Big Hero 6` second, IGDB leads with a DCS World campaign. So the
 * first choice being refused while a later one is right is the expected case,
 * and until #388 the refusal skipped the work and the second-ranked id sat in
 * the file untried while a person looked it up by hand. An `alternates` list
 * is that second id, and `chooseRef` walks the queue.
 *
 * **What is inherited down the queue and what is not, which is the whole of
 * #388's second invariant.** `replacesRef` is inherited: it names the wrong
 * ref coming *off* the work, which is the same ref whichever candidate goes
 * on, so it is evidence about something that does not change between them —
 * and without it every alternate of a #378 repoint would refuse with "already
 * has". `retitleWorkTo` is not inherited under any circumstances: it says a
 * person read *that* id's answer and confirmed it is this work under their own
 * name, and handing that confirmation to an id nobody looked at is #290
 * arriving by a new route. An alternate that needs one carries its own, as an
 * object rather than a bare string.
 *
 * **A row's `candidates` array is not a source of ids**, which is why nothing
 * here reads it. That array is what the search found; `ref` and `alternates`
 * are what a person chose from it. A proposal row that has not been filled in
 * yields an empty queue and is passed over, which is what lets the proposal
 * file be handed to `--from` unedited without a search's first hit ever being
 * written.
 *
 * @type {(pair: any) => { ref: string, retitleWorkTo?: string, replacesRef?: string }[]}
 */
const refCandidates = (pair) => {
  if (!pair || typeof pair !== "object") return [];
  const inherited = filledIn(pair.replacesRef);
  const first = filledIn(pair.ref);
  const alternates = Array.isArray(pair.alternates) ? pair.alternates : [];

  return [
    ...(first
      ? [{ ref: first, retitleWorkTo: filledIn(pair.retitleWorkTo), replacesRef: inherited }]
      : []),
    ...alternates.map((alternate) =>
      typeof alternate === "string"
        ? { ref: filledIn(alternate), retitleWorkTo: undefined, replacesRef: inherited }
        : {
            ref: filledIn(alternate?.ref),
            retitleWorkTo: filledIn(alternate?.retitleWorkTo),
            replacesRef: filledIn(alternate?.replacesRef) ?? inherited,
          }
    ),
  ].filter((candidate) => candidate.ref !== undefined);
};

/**
 * The first candidate `check` allows, and why each earlier one was refused.
 *
 * **Every candidate gets the full guard**, which is #388's first invariant:
 * this is a queue of ids each of which is asked the same question, not a
 * relaxation of the question. `check` is the caller's whole verdict —
 * scripts/set_work_ref.js passes one that retrieves the id and runs
 * `refusalReason` against the answer — so an alternate that fails the title
 * comparison fails exactly as a first choice does.
 *
 * **It stops at the first id that passes rather than scoring them**, because
 * `check` costs an API retrieve: a row of three alternates is up to three
 * calls, and the one that is accepted is the last one made.
 *
 * @type {<T>(pair: any, check: (candidate: any) => Promise<{ reason?: string, retrieved?: T }>)
 *   => Promise<{ taken?: object, retrieved?: T, refused: { ref: string, reason: string }[] }>}
 */
const chooseRef = async (pair, check) => {
  const refused = [];
  for (const candidate of refCandidates(pair)) {
    const { reason, retrieved } = (await check(candidate)) ?? {};
    if (!reason) return { taken: candidate, retrieved, refused };
    refused.push({ ref: candidate.ref, reason });
  }
  return { refused };
};

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

/**
 * Why this work's identity ref cannot be taken off, or `undefined` if it can.
 *
 * The third thing that can be wrong with a ref, after missing and wrong: the
 * id was real and the API has since dropped it. #378 unlinked eight, and they
 * were only believed after being asked twice — #375 is why, an empty answer
 * there turned out to be a bad minute rather than a missing book.
 *
 * **The guard is the inverse of the one above: a ref that still answers is not
 * dead, and stripping it loses a working link.** So a live ref is refused, and
 * the refusal says which of the other two repairs it wanted. That covers the
 * mistake this operation actually invites, which is unlinking the wrong row of
 * a worklist and quietly cutting a good work loose.
 *
 * `becauseItNames` is the way past it, for the one case that is neither: a ref
 * that answers, names something else, and has no replacement to point at. It
 * is evidence in the same sense as `retitleWorkTo` — the API's own title for
 * the thing it is not, which you can only write having read it.
 *
 * @type {(args: {
 *   collection: any, work: any, unlinkRef: string, becauseItNames?: string,
 *   retrieved?: any, retrieveError?: string,
 * }) => string | undefined}
 */
const unlinkRefusalReason = ({ collection, work, unlinkRef, becauseItNames, retrieved, retrieveError }) => {
  if (!work) return "no work with that id";

  const parsed = parseApiRef(unlinkRef);
  if (!parsed) {
    return `"${unlinkRef}" is not a usable ref — it must read <prefix>__<id>`;
  }
  if (parsed.name !== collection.retrievePrefix) {
    // Deliberately narrow. A work's `hltb__` and legacy refs are a record of
    // where it has been and identify nothing that could go stale; this is for
    // the one ref the collection retrieves by.
    return `this takes off the ${collection.retrievePrefix}__ ref a ${collection.type} work is retrieved by, not ${parsed.name}__`;
  }
  if (!(Array.isArray(work.apiRefs) ? work.apiRefs : []).includes(unlinkRef)) {
    return `this work does not carry ${unlinkRef}`;
  }

  // The dead case, and the only one that needs no argument: nothing answered.
  if (retrieveError) return undefined;
  if (!retrieved) return undefined;

  if (titlesAgree(work, retrieved) !== false) {
    return `${unlinkRef} still answers, and names "${displayTitle(retrieved)}" — that is this work, and unlinking it would throw away a working id`;
  }
  if (!becauseItNames) {
    return (
      `${unlinkRef} still answers, with "${displayTitle(retrieved)}" rather than "${displayTitle(work)}" — ` +
      `that is a wrong id, not a dead one, so give the right one with replacesRef, or name what it answers with to strip it anyway`
    );
  }
  if (titlesAgree({ englishTranslatedTitle: becauseItNames }, retrieved) === false) {
    return `becauseItNames "${becauseItNames}" is not what ${unlinkRef} answers with ("${displayTitle(retrieved)}") — give the API's own title, which is how this says you read it`;
  }
  return undefined;
};

/**
 * What to write, once `unlinkRefusalReason` has said nothing.
 *
 * `metadataUpdatedDate` is left exactly as it is, which is the opposite of
 * `refUpdate` and for the same reason: it is dropped there so the next refresh
 * fills what the new ref can answer, and there is nothing here for a refresh
 * to ask. Clearing it would only make the backfill pick the work up and put it
 * down again every time it runs.
 * @type {(work: any, unlinkRef: string) => { set: object }}
 */
const unlinkUpdate = (work, unlinkRef) => ({
  set: { apiRefs: (Array.isArray(work.apiRefs) ? work.apiRefs : []).filter((r) => r !== unlinkRef) },
});

module.exports = {
  refCandidates,
  chooseRef,
  refusalReason,
  refUpdate,
  unlinkRefusalReason,
  unlinkUpdate,
};
