/**
 * @file Shared description of the work/entry collections, used by the
 * audit and backfill scripts. Keep this in sync with
 * ../api/utils/parsers/ and ../api/utils/external_api_adapters/.
 */

/**
 * `apiRefPrefixes` lists every prefix a cached work may legitimately carry.
 * `retrievePrefix` is the one the adapter's `retrieve(ref)` expects.
 * `stringArrayFields` / `numberFields` are the metadata fields we expect the
 * adapter to fill, and that the audit checks for corruption.
 */
const COLLECTIONS = [
  {
    type: "films",
    works: "films",
    entries: "filmEntries",
    entryType: "Film",
    adapterModule: "../api/utils/external_api_adapters/films/tmdb",
    apiRefPrefixes: ["tmdb"],
    identityPrefixes: ["tmdb"],
    retrievePrefix: "tmdb",
    stringArrayFields: ["genres", "directors", "actors"],
    numberFields: ["releaseYear", "duration"],
    defaultDelayMs: 300,
  },
  {
    type: "tv",
    works: "tvShows",
    entries: "tvShowEntries",
    entryType: "TVShow",
    adapterModule: "../api/utils/external_api_adapters/tv_shows/tmdb",
    apiRefPrefixes: ["tmdb"],
    identityPrefixes: ["tmdb"],
    retrievePrefix: "tmdb",
    stringArrayFields: ["genres", "directors", "actors"],
    numberFields: ["releaseYear", "duration", "episodes"],
    defaultDelayMs: 300,
  },
  {
    type: "games",
    works: "games",
    entries: "gameEntries",
    entryType: "Game",
    adapterModule: "../api/utils/external_api_adapters/games/igdb_and_hltb",
    // `hltb` is a secondary ref: it is added by the adapter alongside `igdb`,
    // but only `igdb` can be used to re-retrieve the work.
    apiRefPrefixes: ["igdb", "hltb"],
    // An hltb id identifies a HowLongToBeat page, not the game, and plenty of
    // games share the placeholder `hltb__N/A`. Only igdb establishes identity.
    identityPrefixes: ["igdb"],
    retrievePrefix: "igdb",
    stringArrayFields: ["genres", "platforms", "studios", "publishers"],
    numberFields: ["releaseYear", "duration"],
    // IGDB caps at 4 req/s and the HLTB lookup scrapes the site, so go slow.
    defaultDelayMs: 1500,
  },
  {
    type: "books",
    works: "books",
    entries: "bookEntries",
    entryType: "Book",
    adapterModule: "../api/utils/external_api_adapters/books/google",
    // The adapter caches books under `ISBN__`; some documents carry
    // `google__` instead, naming the same ISBN.
    apiRefPrefixes: ["ISBN", "google"],
    // Both name the same ISBN, so either establishes identity.
    identityPrefixes: ["ISBN", "google"],
    retrievePrefix: "ISBN",
    stringArrayFields: ["genres", "authors", "publishers"],
    numberFields: ["releaseYear", "duration"],
    // The unauthenticated Google Books API rate limits aggressively.
    defaultDelayMs: 1000,
  },
];

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

/** Empty means "there is nothing usable here", so it's safe to overwrite. */
const isEmptyValue = (value) =>
  value === undefined ||
  value === null ||
  value === "" ||
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
  isEmptyValue,
  isCorruptStringArray,
  isCorruptNumber,
  isCorruptExternalUrls,
  selectCollections,
  sleep,
  parseArgs,
};
