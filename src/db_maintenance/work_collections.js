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
 */
const SCRIPT_FIELDS = {
  films: {
    adapterModule: "../api/utils/external_api_adapters/films/tmdb",
    retrievePrefix: "tmdb",
    stringArrayFields: ["genres", "directors", "actors"],
    numberFields: ["releaseYear", "duration"],
    defaultDelayMs: 300,
  },
  tv: {
    adapterModule: "../api/utils/external_api_adapters/tv_shows/tmdb",
    retrievePrefix: "tmdb",
    stringArrayFields: ["genres", "directors", "actors"],
    numberFields: ["releaseYear", "duration", "episodes"],
    defaultDelayMs: 300,
  },
  games: {
    adapterModule: "../api/utils/external_api_adapters/games/igdb",
    retrievePrefix: "igdb",
    stringArrayFields: ["genres", "platforms", "studios", "publishers"],
    numberFields: ["releaseYear", "duration"],
    // IGDB caps at 4 requests a second, and a retrieve costs three of them.
    defaultDelayMs: 1000,
  },
  books: {
    adapterModule: "../api/utils/external_api_adapters/books/google",
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
