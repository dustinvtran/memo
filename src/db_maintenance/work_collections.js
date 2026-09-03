/**
 * @file Shared description of the work/entry collections, used by the
 * audit and backfill scripts.
 *
 * The collection names, the entry types and the apiRef prefixes come from
 * ../api/utils/work_types.js, which the API itself reads — so there is now
 * something to import rather than something to keep in sync. What is added
 * here is what only these scripts need. Keep the adapter modules in step with
 * ../api/utils/external_api_adapters/.
 */

const { WORK_TYPES } = require("../api/utils/work_types");

/**
 * The script-only half of a descriptor, by type.
 *
 * `retrievePrefix` is the apiRef prefix the adapter's `retrieve(ref)` expects
 * — always one of the shared row's `identityPrefixes`.
 * `stringArrayFields` / `numberFields` are the metadata fields we expect the
 * adapter to fill, and that the audit checks for corruption.
 *
 * `adapterModule` is resolved here, with `require.resolve`, rather than stored
 * as a relative specifier: the descriptors are read from `scripts/` as well as
 * from this directory, and a relative specifier resolves against whichever
 * module calls `require`, not against this file. `scripts/` is one level down,
 * so every path missed by exactly one `..` and the backfill silently skipped
 * every collection. Resolving means the path is fixed at the only place it can
 * be read correctly, and a typo throws here, at load, instead of arriving in
 * the consumer's catch looking like a missing API key.
 *
 * `require.resolve` finds the file without executing it, so the adapters stay
 * unloaded — see `loadAdapter` in scripts/backfill_work_metadata.js for why
 * that matters.
 */
const SCRIPT_FIELDS = {
  films: {
    adapterModule: require.resolve(
      "../api/utils/external_api_adapters/films/tmdb"
    ),
    retrievePrefix: "tmdb",
    stringArrayFields: ["genres", "directors", "actors"],
    numberFields: ["releaseYear", "duration"],
    defaultDelayMs: 300,
  },
  tv: {
    adapterModule: require.resolve(
      "../api/utils/external_api_adapters/tv_shows/tmdb"
    ),
    retrievePrefix: "tmdb",
    stringArrayFields: ["genres", "directors", "actors"],
    numberFields: ["releaseYear", "duration", "episodes"],
    defaultDelayMs: 300,
  },
  games: {
    adapterModule: require.resolve(
      "../api/utils/external_api_adapters/games/igdb"
    ),
    retrievePrefix: "igdb",
    stringArrayFields: ["genres", "platforms", "studios", "publishers"],
    numberFields: ["releaseYear", "duration"],
    // IGDB caps at 4 requests a second, and a retrieve costs three of them.
    defaultDelayMs: 1000,
  },
  books: {
    adapterModule: require.resolve(
      "../api/utils/external_api_adapters/books/google"
    ),
    retrievePrefix: "ISBN",
    stringArrayFields: ["genres", "authors", "publishers"],
    numberFields: ["releaseYear", "duration"],
    // The unauthenticated Google Books API rate limits aggressively.
    defaultDelayMs: 1000,
  },
};

/**
 * The shared rows with the script-only fields over them, in the shared order.
 * Carries `reviews` too, so nothing here has to derive a review collection
 * from an entry one by hand.
 */
const COLLECTIONS = WORK_TYPES.map((workType) => ({
  ...workType,
  ...SCRIPT_FIELDS[workType.type],
}));

/** Fields every work is expected to carry, whatever its type. */
const COMMON_FIELDS = [
  "englishTranslatedTitle",
  "imageUrl",
  "releaseYear",
  "duration",
  "genres",
];

/**
 * Values that were stored where an identifier should have been. The database
 * really contains 27 games with `hltb__N/A` and 14 films with
 * `undefined__undefined`; treating those as identifiers would make every one
 * of them look like the same work.
 */
const PLACEHOLDER_REF_VALUES = new Set([
  "",
  "0",
  "n/a",
  "na",
  "null",
  "undefined",
  "nan",
  "none",
  "false",
]);

const isPlaceholder = (value) =>
  PLACEHOLDER_REF_VALUES.has(String(value).trim().toLowerCase());

/**
 * apiRefs are flat strings (`igdb__1234`) since
 * flatten_api_refs_in_work_collections.js ran, but a few documents may still
 * hold the original `{ name, ref }` objects.
 *
 * Returns undefined for anything that isn't a usable identifier, so a
 * placeholder can never be mistaken for one.
 * @type {(apiRef: unknown) => { name: string, ref: string, flat: boolean } | undefined}
 */
const parseApiRef = (apiRef) => {
  const parsed = parseApiRefShape(apiRef);
  if (!parsed) return undefined;
  if (isPlaceholder(parsed.name) || isPlaceholder(parsed.ref)) return undefined;
  return parsed;
};

const parseApiRefShape = (apiRef) => {
  if (typeof apiRef === "string") {
    const separatorAt = apiRef.indexOf("__");
    if (separatorAt <= 0) return undefined;
    return {
      name: apiRef.slice(0, separatorAt),
      ref: apiRef.slice(separatorAt + 2),
      flat: true,
    };
  }
  if (apiRef && typeof apiRef === "object" && apiRef.name && apiRef.ref) {
    return { name: String(apiRef.name), ref: String(apiRef.ref), flat: false };
  }
  return undefined;
};

/** @type {(apiRefs: unknown, name: string) => string | undefined} */
const findApiRef = (apiRefs, name) => {
  if (!Array.isArray(apiRefs)) return undefined;
  return apiRefs
    .map(parseApiRef)
    .find((parsed) => parsed?.name === name)?.ref;
};

/**
 * A title reduced to what a comparison should care about. Case and
 * punctuation vary between one API's spelling of a work and another's — WALL·E
 * against Wall-E — and a real difference does not.
 */
const normalizeTitle = (title) =>
  String(title ?? "")
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]/gu, "");

/**
 * The same title reduced further, for deciding whether two documents are the
 * same work rather than for keying them.
 *
 * `normalizeTitle` above answers a different question and keeps its own
 * answer: it is the key ./title_year_check.js groups on and the one
 * ./work_dedupe_plan.js decides a merge by. **This one must not become
 * either.** It is deliberately loose enough that two unrelated books collide
 * under it — `The Stranger (Animorphs, #7)` and Camus' `The Stranger` reduce
 * to the same string — and that is harmless only because what it compares is
 * one stored work against the answer its own id gave, never one stored work
 * against another. A second function rather than an edit to the first is what
 * keeps those two uses apart.
 *
 * The four things it forgives, all of them ways one catalogue spells what
 * another spells differently, none of them a way one work is mistaken for
 * another (#327):
 *
 *   - **Diacritics**, via NFD — the marks fall out as their own codepoints and
 *     the final strip takes them with the punctuation. `Salò` and `Salo` are
 *     the same film. Letters that carry their difference in the letter rather
 *     than in a mark — `ø`, `ł`, `ß` — do not decompose and are not forgiven.
 *   - **A trailing parenthetical.** 177 of the 696 books carry a series suffix
 *     a bookseller added and the ISBN names the book without — `Hatchet
 *     (Brian's Saga, #1)`, `涼宮ハルヒの暴走 (Suzumiya Haruhi, #5)`. Trailing
 *     only, because a parenthetical anywhere else is part of the name:
 *     `Kizumonogatari (傷物語) (Monogatari, #3)` has one of each. A title that
 *     is *nothing but* a parenthetical keeps it — `[REC]` and `(Poetry)` are
 *     both real films here, and the alternative is no title at all.
 *   - **A leading English article.** This is #327's headline: 69 works are
 *     stored as `Truman Show` under the id for `The Truman Show` and have been
 *     unrefreshable ever since. Only `the`, `a` and `an`, and only with
 *     something left after them.
 *   - **A spelled-out number below twenty**, so `The Trial of the Chicago
 *     Seven` and `The Trial of the Chicago 7` are one film. Twenty is where it
 *     stops because `one hundred` is two words and mapping each in turn would
 *     make it `1100`.
 *
 * What it deliberately does not forgive is one title *containing* the other.
 * That is the shape a search-result mistake takes — somebody typed `Ex
 * Machina` and picked `Digitaria Ex Machina` — so it stays a disagreement and
 * is reported as one by ./title_match_check.js.
 */
const comparableTitle = (title) => {
  const withoutMarks = String(title ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Mark}/gu, "");

  return withoutNumberWords(
    withoutTrailingParentheticals(withoutMarks).replace(LEADING_ARTICLE, "")
  ).replace(/[^\p{Letter}\p{Number}]/gu, "");
};

/**
 * The articles dropped, and the lookahead that keeps `The` from becoming the
 * empty string. English only: these are the ones the stored titles actually
 * lose, and `Le`, `El` and `Der` are words that begin real titles in the
 * originalTitle field.
 */
const LEADING_ARTICLE = /^(?:the|a|an)\s+(?=\S)/;

/**
 * One trailing `(...)` or `[...]` at a time, so `Title (Series, #1) (1996)`
 * loses both. The original is kept rather than returning nothing when the
 * title is a parenthetical and nothing else.
 */
const withoutTrailingParentheticals = (text) => {
  let title = text.trim();
  for (;;) {
    const shorter = title.replace(/[([][^()[\]]*[)\]]\s*$/, "").trim();
    if (shorter === title) return title;
    if (shorter === "") return title;
    title = shorter;
  }
};

/** Words for the numbers a sequel or a headline count is spelled with. */
const NUMBER_WORDS = new Map(
  [
    "zero", "one", "two", "three", "four", "five", "six", "seven", "eight",
    "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen",
    "sixteen", "seventeen", "eighteen", "nineteen", "twenty",
  ].map((word, value) => [word, String(value)])
);

const withoutNumberWords = (text) =>
  text.replace(/\p{Letter}+/gu, (word) => NUMBER_WORDS.get(word) ?? word);

/** The title to show a reader for a work, or for an adapter's response. */
const displayTitle = (work) =>
  work?.englishTranslatedTitle ?? work?.originalTitle ?? "(untitled)";

/** Every title a document carries, normalised, with the blanks dropped. */
const titlesOf = (work) =>
  [work?.englishTranslatedTitle, work?.originalTitle]
    .map(normalizeTitle)
    .filter((title) => title !== "");

/** The same titles, reduced the way a comparison wants them. */
const comparableTitlesOf = (work) =>
  [work?.englishTranslatedTitle, work?.originalTitle]
    .map(comparableTitle)
    .filter((title) => title !== "");

/**
 * Whether two documents claim to be the same work — a stored work and a fresh
 * API response, most often. Either title of one matching either title of the
 * other is enough: the two APIs disagree about which spelling is the original
 * often enough that insisting on the same *field* would report a difference
 * where there is none.
 *
 * `comparableTitle` and not `normalizeTitle`, since #327: the strict spelling
 * refused 357 works — 23% of the library — from a `--missing-only` backfill,
 * and 69 of those differed by a leading article and nothing else. Equality
 * after that reduction, though, and never containment: the containment bucket
 * is where the real misfilings live.
 *
 * `undefined`, and not `false`, when either side carries no title at all.
 * Nothing was compared, so there is nothing to conclude, and a caller that
 * treats "don't know" as "they differ" would refuse to fill in the title of
 * every work that is missing one.
 * @type {(a: unknown, b: unknown) => boolean | undefined}
 */
const titlesAgree = (a, b) => {
  const ours = comparableTitlesOf(a);
  const theirs = comparableTitlesOf(b);
  if (ours.length === 0 || theirs.length === 0) return undefined;
  return ours.some((title) => theirs.includes(title));
};

/**
 * Empty means "there is nothing usable here", so it's safe to overwrite.
 *
 * **A stored `0` is empty**, and this is the only place that can say so. #318:
 * 49 works hold `duration: 0` — 14 films, 16 games, 19 books — and until this
 * line they were unreachable by every mechanism the repo has. `0` is not
 * `undefined`, so the audit did not report the field missing, `hasGaps` did
 * not pick the work up and `mergeWork` in `missingOnly` mode left the value
 * alone as a usable one; `0` is a number, so `isCorruptNumber` did not call it
 * damage and scripts/clear_unusable_work_fields.js would not clear it either.
 * The API has the runtime, the page draws a `-`, and nothing was ever going to
 * ask.
 *
 * Deciding it here rather than in the clear script is the difference between a
 * rule and a one-off repair. A zero is not damage to be removed, it is an
 * absence stored badly, and one line reaches the audit, `hasGaps`, `mergeWork`
 * and `completeness` at once with no write to production at all — clearing the
 * 49 would have been a production write whose whole result was the gaps this
 * produces for free. It also ends a disagreement rather than starting one:
 * `hasStoredPlaytime` in ./game_playtime_plan.js and `implausibleDuration` in
 * ./duration_plausibility.js each already say a `duration` of `0` is not a
 * duration, in their own words, because this function would not say it for
 * them.
 *
 * **`0` is named, not `!value`.** A falsiness test would be shorter and would
 * also swallow `false`, and it would hand the same rule to the string-array
 * fields this predicate is equally asked about, so a field for which zero is a
 * real answer would become a permanent gap the day someone added it. There is
 * no such field today: every entry in a `numberFields` list is a `duration`, a
 * `releaseYear` or an `episodes` count, and a work released in year 0, a film
 * 0 minutes long and a show with 0 episodes all mean "nobody knows" rather
 * than a measurement. Saying that here is what makes the next one a decision
 * instead of an accident.
 */
const isEmptyValue = (value) =>
  value === undefined ||
  value === null ||
  value === "" ||
  value === 0 ||
  (Array.isArray(value) && value.length === 0);

/**
 * mongodb_add_missing_book_publishers.js stored an unawaited Promise, which
 * lands in Mongo as `{}`. More generally, anything that isn't an array of
 * non-empty strings is unusable for a string array field.
 */
const isCorruptStringArray = (value) =>
  !isEmptyValue(value) &&
  (!Array.isArray(value) ||
    value.some((item) => typeof item !== "string" || item === ""));

const isCorruptNumber = (value) =>
  !isEmptyValue(value) && (typeof value !== "number" || Number.isNaN(value));

const isCorruptExternalUrls = (value) =>
  !isEmptyValue(value) &&
  (!Array.isArray(value) ||
    value.some(
      (url) =>
        !url ||
        typeof url !== "object" ||
        typeof url.name !== "string" ||
        typeof url.url !== "string"
    ));

/** Resolves a `--only=games,books` value to collection descriptors. */
const selectCollections = (only) =>
  only === undefined || only === true
    ? COLLECTIONS
    : COLLECTIONS.filter((c) => String(only).split(",").includes(c.type));

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

/** Minimal `--flag` / `--flag=value` parser for these scripts. */
const parseArgs = (argv) =>
  argv.slice(2).reduce((args, arg) => {
    if (!arg.startsWith("--")) return args;
    const [name, ...rest] = arg.slice(2).split("=");
    return { ...args, [name]: rest.length === 0 ? true : rest.join("=") };
  }, {});

module.exports = {
  COLLECTIONS,
  COMMON_FIELDS,
  PLACEHOLDER_REF_VALUES,
  isPlaceholder,
  parseApiRef,
  findApiRef,
  normalizeTitle,
  comparableTitle,
  displayTitle,
  titlesOf,
  comparableTitlesOf,
  titlesAgree,
  isEmptyValue,
  isCorruptStringArray,
  isCorruptNumber,
  isCorruptExternalUrls,
  selectCollections,
  sleep,
  parseArgs,
};
