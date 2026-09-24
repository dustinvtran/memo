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
  displayTitle,
  titlesAgree,
  isEmptyValue,
  isCorruptStringArray,
  isCorruptNumber,
  isCorruptExternalUrls,
} = require("./work_collections");

/**
 * The two fields that carry a work's name. Both, because either one of them
 * matching either of the API's is what `titlesAgree` accepts, so either one
 * left writable would be enough to erase the disagreement the guard reads.
 */
const TITLE_FIELDS = ["englishTranslatedTitle", "originalTitle"];

/**
 * Fields a refresh fills when the work has none and never replaces. #333.
 *
 * This is the guard that only an overwriting run needs, and `--missing-only`
 * — every run applied so far — never did, because it writes nothing it would
 * have protected. Two separate reasons put fields here.
 *
 * **Both titles, for every type, because the title is the evidence.** The
 * refusal below compares `comparableTitle`, which since #327 forgives a
 * leading article, a trailing parenthetical, diacritics and a spelled-out
 * number — 357 works were otherwise unrefreshable. ../work_collections.js
 * documents that looseness as safe on the grounds that it compares one stored
 * work against the answer its own id gave, and it was, while the title was the
 * one field a `missingOnly` run could not write. `The Stranger (Animorphs,
 * #7)` filed under Camus' ISBN reduces to the same string as `The Stranger`;
 * a refresh allowed to write the title would leave the two indistinguishable,
 * which is #290's "unrecoverable except from a snapshot" exactly. Nothing is
 * lost: #333 is about release dates and playtimes, and a genuine retitling is
 * a human's call by the same reasoning as the refusal.
 *
 * **A book's `releaseYear` and `duration`, because an ISBN names an edition.**
 * Measured, not assumed. A 60-book dry run on 2026-09-14 proposed seven year
 * changes, six of which replaced a stored year, and all six moved a
 * public-domain work forward to a modern reprint: `Robinson Crusoe` 1719 to a
 * 2019 Flammarion, `The Autobiography of Benjamin Franklin` 1791 to 2019, `The
 * Complete Poems of Emily Dickinson` 1890 to 2018, `The Wonderful Wizard of
 * Oz` 1900 to 2000. Not one was a correction. Page counts go the same way for
 * the same reason — 272 to 205, 371 to 412, one edition's pagination replacing
 * another's. The stored values are the work's and Google Books is answering
 * about the printing, so the API is simply not the better authority here,
 * which is the test for this list.
 *
 * Fill-only and not read-only, so the seventh change still happens: a book
 * with no year at all gets the edition's, which is what `--missing-only` has
 * always done and is better than the dash it draws today. The exposure that
 * leaves is a reprint year on a book that had none, which is visible in the
 * audit as a year rather than invisible as an overwrite.
 *
 * `imageUrl`, `externalUrls` and `publishers` are deliberately *not* on the
 * list even for books. They describe the edition too, and a cover and a link
 * that resolve today are worth more than ones that resolved five years ago.
 *
 * A film's runtime, a show's episode count and a game's year carry no such
 * problem — a TMDB movie id is one cut of one film and an IGDB game id is one
 * game — so nothing is fill-only for those three beyond the titles.
 */
const fillOnlyFields = (collection) => [
  ...TITLE_FIELDS,
  ...(collection?.fillOnlyFields ?? []),
];

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
 * ../frontend/_includes/js/utils/columns.js, whose three cases are listed
 * here one for one rather than summarised, so that the next time the page
 * grows a case this comment disagrees with it in a diff:
 *
 *   1. `durationSource: "igdb"` links to the stored `igdb` externalUrl, and
 *      to nothing else. There is deliberately no fallback: igdb.com's urls
 *      are slugs rather than ids so the apiRef cannot build one, and a
 *      HowLongToBeat link the game may still carry is not where an IGDB
 *      number came from.
 *   2. Any other duration links to the stored `hltb` externalUrl, or to a
 *      page built from an `hltb__` apiRef — `findApiRef` here, a numeric
 *      test there, both rejecting the 27 `hltb__N/A` placeholders.
 *   3. Failing both, to a HowLongToBeat *search* for the title.
 *
 * Case 3 is why this is not simply "has no stored link": it was added by
 * #201, for the 210 games holding a HowLongToBeat playtime with no ref to
 * build a page url from, and until #293 this check still counted all 210 as
 * unlinked while the page linked every one of them. A HowLongToBeat playtime
 * is unlinked only when there is no title to search on either, which leaves
 * case 1 as the one that flags anything real: an adapter writing a duration
 * without the url it came from.
 *
 * Reported by the audit, but deliberately *not* part of `hasGaps`, which
 * decides what is worth an API call. A titleless HowLongToBeat playtime can
 * never gain a link — that API is gone (docs/API_choices.md) — and an IGDB
 * one missing its url is a bug to read about rather than a field to chase,
 * so neither is a reason to re-run the adapter.
 */
const isMissingPlaytimeLink = (collection, work) => {
  if (collection.type !== "games" || isEmptyValue(work.duration)) return false;
  const source = work.durationSource === "igdb" ? "igdb" : "hltb";
  const hasUrl = (Array.isArray(work.externalUrls) ? work.externalUrls : []).some(
    (url) => url?.name === source
  );
  if (source === "igdb") return !hasUrl;
  if (hasUrl || findApiRef(work.apiRefs, "hltb")) return false;
  // The search the page falls back to needs a title and nothing else, read
  // the same way the column reads it.
  return isEmptyValue(work.englishTranslatedTitle ?? work.originalTitle);
};

/** True when a work is worth spending an API call on. */
const hasGaps = (collection, work) =>
  expectedFields(collection).some((field) => isEmptyValue(work[field])) ||
  corruptFieldsOf(collection, work).length > 0 ||
  (Array.isArray(work.apiRefs) &&
    work.apiRefs.some((ref) => parseApiRef(ref)?.flat === false));

/**
 * Builds the `$set` payload for one work. Rules:
 *   - a work whose title the API disagrees with is refused outright
 *   - a `fillOnlyFields` field is written when absent and never replaced
 *   - a field the API has nothing to say about is never cleared
 *   - apiRefs and externalUrls are unioned, so a ref we already know about
 *     survives even when the API stops returning it
 *   - with `missingOnly`, usable existing values are left alone
 *   - a stored duration is only ever refreshed by the source that wrote it
 *   - `durationSource` only travels with a `duration`
 *
 * `refused` is set instead of `updates` when the first rule fires, so that a
 * caller reports the skip rather than filing it under "already current" —
 * which is what an empty `updates` means everywhere else.
 *
 * @type {(collection: any, work: any, fresh: any, options?: { missingOnly?: boolean }) => { updates: any, notes: string[], refused?: string }}
 */
const mergeWork = (collection, work, fresh, { missingOnly = false } = {}) => {
  const refused = titleConflict(work, fresh);
  if (refused) return { updates: {}, notes: [refused], refused };

  const updates = {};
  const notes = [];
  const fillOnly = fillOnlyFields(collection);

  for (const [field, freshValue] of Object.entries(fresh)) {
    if (field === "entryType") continue;
    // Handled after the loop, where it can be tied to the duration it
    // describes without depending on which key the adapter listed first.
    if (field === "durationSource") continue;
    if (isEmptyValue(freshValue)) continue;

    const currentValue = work[field];

    // Filled when absent, never replaced. The list and its reasons are at
    // `fillOnlyFields` above; this is the one line that enforces it, and it
    // sits ahead of everything else because a fill-only field is not a
    // question about what the API said.
    if (fillOnly.includes(field) && !isEmptyValue(currentValue)) continue;

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

  // Two different books can share a title, and when they do the title guard
  // agrees and the author is the only field that disagrees. Reported rather
  // than refused: see `authorsAgree` for why the first pass only watches.
  if ("authors" in updates && authorsAgree(work.authors, updates.authors) === false) {
    notes.push(
      `authors replaced with no name in common: ${describeAuthors(work.authors)}` +
        ` -> ${describeAuthors(updates.authors)}`
    );
  }

  return { updates, notes };
};

/**
 * Whether two author lists name anybody in common, by surname.
 *
 * The title guard is the only thing between a wrong ISBN and a work, and two
 * real books can share a name — Hatcher's `Algebraic Topology` and Fulton's,
 * Niven's `An Introduction to the Theory of Numbers` and Hardy & Wright's.
 * The guard agrees on those, the refresh writes, and nothing reports it
 * because `authors` is a replace field and the author is the only thing that
 * differs. A `--force` dry run over 199 of the 648 books proposed 138 author
 * replacements, of which ten were a different book's authors entirely (#439).
 *
 * Surnames and not whole names, because 118 of those 138 were one person
 * spelled two ways — an initial expanded, a middle name added, a comma moved.
 * The surname is what survives that, and a shared one is enough: an API that
 * lists three authors where we hold one is the ordinary case.
 *
 * `undefined` where the two lists are in different scripts, which is the
 * comparison no string test bridges — `村上春樹` against `Haruki Murakami` is
 * the same person and seven of the twenty non-sharing pairs were that shape.
 * Abstaining is not a gap to close later; it is the answer.
 *
 * Reported and not refused on this pass, deliberately. The false positives
 * above are knowable but the script cases are not, and #327 is the standing
 * lesson about enforcing a guard whose population has not been counted. When
 * the reports have been read and the rate is known, this becomes a refusal.
 * @type {(stored: unknown, fresh: unknown) => boolean | undefined}
 */
const authorsAgree = (stored, fresh) => {
  const ours = surnamesOf(stored);
  const theirs = surnamesOf(fresh);
  if (ours.length === 0 || theirs.length === 0) return undefined;
  if (isLatin(ours) !== isLatin(theirs)) return undefined;
  return ours.some((name) => theirs.includes(name));
};

/**
 * The surname out of each name, folded the way `comparableTitle` folds a
 * title: lowercased, diacritics decomposed away, punctuation dropped. So
 * `Jürgen Neukirch` and `Jurgen Neukirch` are one name, and a name written in
 * one script keeps its own characters and simply fails to match one written
 * in another — which is what `isLatin` notices before that counts as a
 * finding.
 *
 * Three things decide which word the surname is, because a catalogue writes a
 * name either way round and does not always write the same parts of it. A
 * comma means the inverted listing, so the surname is what precedes it:
 * `Hardy, G. H.` is Hardy. Otherwise it is the last word, skipping initials
 * and a generational suffix, so `G. H. Hardy` and `John L. Parker Jr.` are
 * Hardy and Parker. The suffix is not pedantry: one catalogue listing `John
 * L. Parker Jr.` against another's `John L. Parker` was reported as two
 * different people until it was dropped.
 */
const surnamesOf = (value) =>
  (Array.isArray(value) ? value : [])
    .map((name) => {
      const folded = String(name ?? "")
        .toLowerCase()
        .normalize("NFD")
        .replace(/\p{Mark}/gu, "");
      const [beforeComma] = folded.split(",");
      const words = beforeComma
        .replace(/[^\p{Letter}\p{Number}\s]/gu, " ")
        .trim()
        .split(/\s+/)
        .filter((word) => word);
      const named = words.filter(
        (word) => word.length > 1 && !NAME_SUFFIXES.has(word)
      );
      return (named.length ? named : words).pop() ?? "";
    })
    .filter((name) => name);

/** Generational suffixes, which are part of a listing rather than of a name. */
const NAME_SUFFIXES = new Set(["jr", "jnr", "sr", "snr", "ii", "iii", "iv"]);

/** Whether every surname in a list is written in Latin script. */
const isLatin = (surnames) => surnames.every((name) => /^[\p{Script=Latin}\d]+$/u.test(name));

/** An author list as a reader should see it in a note. */
const describeAuthors = (value) =>
  (Array.isArray(value) ? value : []).join(", ") || "(none)";

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
  TITLE_FIELDS,
  fillOnlyFields,
  expectedFields,
  isCorruptField,
  corruptFieldsOf,
  isMissingPlaytimeLink,
  hasGaps,
  mergeWork,
  authorsAgree,
  mergeApiRefs,
  mergeExternalUrls,
  completeness,
};

///////////////////////////////////////////////////////////////////////////////

/**
 * Why this response must not be merged into this work, or undefined when it
 * may be.
 *
 * The apiRef is the only thing tying the two together, and it is not always
 * telling the truth. Twenty-five groups of works in the database carry an id
 * that belongs to a *different* work — `Among Us` under The Wolf Among Us's
 * IGDB id, Dostoevsky's `Demons` under The Da Vinci Code's ISBN — and every
 * one of them was filled in by a `--missing-only` backfill that took the ref
 * at its word. Their titles survived only because a title was never the
 * missing field. A run without `--missing-only` overwrites those too, and at
 * that point the pair is indistinguishable and the damage is unrecoverable
 * except from a snapshot. #290.
 *
 * So a title disagreement stops the merge dead. It used to be written and
 * annotated, which put the one signal that the ref is wrong in a note beneath
 * the write it should have prevented.
 *
 * **Nothing at all is written, the `entryType` repair included.** If the ref
 * names another work then this call was about another work, and the safe
 * amount to take from it is none of it. The audit reports a wrong `entryType`
 * separately, and the next run makes it once the ref is right.
 *
 * A genuine retitling — TMDB correcting a name — lands here too, and is meant
 * to: it is a human's call which of the two names the work, and correcting the
 * stored title by hand lets the next run through. `titlesAgree` answers
 * `undefined` rather than `false` when either side has no title, so a work
 * that is missing one is filled in as it always was.
 * @type {(work: any, fresh: any) => string | undefined}
 */
const titleConflict = (work, fresh) =>
  titlesAgree(work, fresh) === false
    ? `refused: stored title "${displayTitle(work)}" but the apiRef names ` +
      `"${displayTitle(fresh)}" — one of them is filed under the other's id`
    : undefined;

const toParsedRefs = (value) =>
  (Array.isArray(value) ? value : []).map(parseApiRef).filter((ref) => ref);

const toValidUrls = (value) =>
  (Array.isArray(value) ? value : []).filter(
    (url) => url && typeof url.name === "string" && typeof url.url === "string"
  );

const equal = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
