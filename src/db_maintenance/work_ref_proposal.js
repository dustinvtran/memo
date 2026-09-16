/**
 * @file Ranking an API's search results against the work we are trying to name.
 *
 * 168 works carry no identity ref and 23 entries carry no work at all, and
 * every one needs a human to decide which id is right. Searching the stored
 * title turns that from "look up 191 things" into "confirm or correct 191
 * suggestions" — but only if the suggestion is usually right, and a raw search
 * is not: TMDB answers `Hero` with `THE RIBBON HERO` first and `Big Hero 6`
 * second, and IGDB leads with a DCS World campaign.
 *
 * So the results are scored rather than taken in order, and nothing here picks
 * one. #344 established that shape for books and the reason holds for all four
 * types: the first hit is wrong often enough that taking it would be #290
 * arriving by a new route, where an id typed in good faith names something
 * else and a backfill then copies that something else over the work.
 *
 * **What the score is for is ordering, not deciding.** The field that decides
 * is `titleAgrees`, which is the same `titlesAgree` the repair tool and the
 * refresh both use, and it answers the question a person actually needs: if
 * you take this candidate, will the write go through, or is this a case where
 * the stored title is your own naming and the work needs retitling too?
 *
 * Pure and dependency-free: the searching lives in
 * scripts/propose_work_refs.js and the ranking lives here.
 */
const { comparableTitle, titlesAgree } = require("./work_collections");

/** A strong enough match that searching further variations is wasted effort. */
const STRONG = 60;

/**
 * How well a candidate matches, from 0 to 100. Higher is better.
 *
 * Deliberately crude, because it only orders a list a person is going to read.
 * The parts, most decisive first:
 *
 *   - **The title, compared the way the rest of this folder compares titles.**
 *     `comparableTitle` already forgives a leading article, a trailing
 *     parenthetical, diacritics and a spelled-out number (#327), so `Truman
 *     Show` and `The Truman Show` score as equal rather than as near-misses.
 *   - **Containment**, which is worth something and is not a match: `Sigil`
 *     inside `Doom mod: Sigil` is the DLC case and usually right, while `Hero`
 *     inside `Big Hero 6` is the trap. Scored below an equal title so it can
 *     never outrank one.
 *   - **Overlapping words**, which is what catches a typo. `You Were Never
 *     Really There` and `You Were Never Really Here` share four words of five
 *     and no amount of containment or equality will see it.
 *   - **The year**, which separates a remake from its original — they share a
 *     title exactly and differ only here.
 *
 * @type {(work: any, candidate: any) => number}
 */
const scoreCandidate = (work, candidate) => {
  const wanted = titleOf(work);
  const got = candidate?.title;
  if (!wanted || !got) return 0;

  const wantedKey = comparableTitle(wanted);
  const gotKey = comparableTitle(got);
  if (!wantedKey || !gotKey) return 0;

  const title =
    wantedKey === gotKey
      ? 60
      : gotKey.includes(wantedKey) || wantedKey.includes(gotKey)
        ? 35
        : Math.round(sharedWords(wanted, got) * 45);

  const wantedYear = Number(work?.releaseYear ?? work?.overrides?.releaseYear);
  const gotYear = Number(candidate?.year);
  const year =
    !wantedYear || !gotYear
      ? 0
      : wantedYear === gotYear
        ? 40
        : Math.abs(wantedYear - gotYear) === 1
          ? 15
          : // Small, because a stored year is wrong about as often as a stored
            // title is. `You Were Never Really There` is stored as 2019 and is
            // the 2017 `You Were Never Really Here`; a penalty big enough to
            // zero the score hid the one candidate that was right about both.
            -5;

  return Math.max(0, Math.min(100, title + year));
};

/**
 * The candidates worth showing, best first.
 *
 * `titleAgrees` is the field to read. `true` means the repair tool will accept
 * this ref as it stands. `false` means it will refuse — which is right when
 * the candidate is wrong, and is also what happens when the candidate is
 * *correct* and the stored title is a personal naming: `Doom mod: Sigil`
 * against IGDB's `Sigil`, `The Elder Scrolls IV: Oblivion - Knights of the
 * Nine` against `The Elder Scrolls IV: Knights of the Nine`. The tool cannot
 * tell those two apart and should not try; a person can, and says so by
 * filling in `retitleWorkTo`.
 *
 * @type {(work: any, results: any[], limit?: number) => Array<{
 *   ref: string, title: string, year: string | number | null,
 *   score: number, titleAgrees: boolean | undefined,
 * }>}
 */
const rankCandidates = (work, results, limit = 4) => {
  const seen = new Map();

  for (const candidate of Array.isArray(results) ? results : []) {
    const ref = String(candidate?.ref ?? "");
    // Only a missing id is dropped. A weak candidate is still worth showing: a
    // person dismisses a bad suggestion in a second and cannot conjure a
    // missing one at all. The score orders them; it does not judge them.
    if (!ref || seen.has(ref)) continue;

    seen.set(ref, {
      ref,
      title: candidate?.title ?? "",
      year: candidate?.year ?? null,
      score: scoreCandidate(work, candidate),
      // The same question the write will ask, asked now so the answer is in
      // front of whoever is reviewing rather than discovered on the apply.
      titleAgrees: titlesAgree(
        { englishTranslatedTitle: titleOf(work) },
        { englishTranslatedTitle: candidate?.title }
      ),
    });
  }

  return [...seen.values()]
    .sort((a, b) => b.score - a.score || String(a.title).length - String(b.title).length)
    .slice(0, limit);
};

/**
 * The searches to try for one work, in order, loosest last.
 *
 * A stored title is often not a search term. TMDB returns **nothing** for
 * `Intolerance: Love's Struggle Through the Ages` and twenty results for
 * `Intolerance`; nothing for `You Were Never Really There`, because the film is
 * `You Were Never Really Here`. Searching only the stored title reported
 * fifty-nine of the hundred and ninety-one as unfindable, and most of them
 * were one query away.
 *
 * Each variation drops something a search engine is strict about and a person
 * would not:
 *
 *   - **Either half of a separated title**, because which half names the work
 *     varies: `Red Cliff: Part One` is the first, `Doom mod: Sigil` the second.
 *   - **Punctuation and diacritics.**
 *   - **The last word, then the last two**, which is what rescues a typo —
 *     `You Were Never Really` finds the film that `…There` cannot.
 *
 * What this deliberately cannot rescue is a misspelling inside a word:
 * `The Villainness` against `The Villainess` is one letter, and inventing a
 * spelling is the business of the person reviewing rather than of a fallback.
 * A row with no candidates usually means the stored title is wrong, which is
 * worth knowing and is why those rows are reported rather than dropped.
 *
 * @type {(title: string) => string[]}
 */
const queriesFor = (title) => {
  const first = String(title ?? "").trim();
  if (!first) return [];

  const parts = first.split(/\s*[:–-]\s+/).map((part) => part.trim());
  const beforeSubtitle = parts[0];
  const afterSubtitle = parts.length > 1 ? parts[parts.length - 1] : "";

  const plain = first
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

  // Two words is the floor; below that the query stops being about this work.
  const words = plain.split(" ").filter(Boolean);
  const shortened = [1, 2]
    .map((drop) => words.slice(0, words.length - drop))
    .filter((rest) => rest.length >= 2)
    .map((rest) => rest.join(" "));

  return [
    ...new Set(
      [first, beforeSubtitle, afterSubtitle, plain, ...shortened].filter(
        (query) => query.length > 1
      )
    ),
  ];
};

module.exports = { rankCandidates, scoreCandidate, queriesFor, STRONG };

///////////////////////////////////////////////////////////////////////////////

/** A work's stored title, or, for an unlinked entry, the one that was typed. */
const titleOf = (work) =>
  work?.englishTranslatedTitle ??
  work?.title ??
  work?.overrides?.englishTranslatedTitle ??
  work?.overrides?.originalTitle;

/**
 * The fraction of the wanted title's words the candidate also has.
 *
 * Its own normalisation rather than `comparableTitle`, which strips spaces —
 * splitting that on a space yields one enormous word, every overlap scored
 * zero, and a typo'd title matched nothing at all.
 */
const wordsOf = (text) =>
  String(text ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);

const sharedWords = (wanted, got) => {
  const words = wordsOf(wanted);
  if (words.length === 0) return 0;
  const has = new Set(wordsOf(got));
  return words.filter((word) => has.has(word)).length / words.length;
};
