/**
 * @file De-duplicating the list fields an adapter maps.
 *
 * The APIs can list one company or person more than once for a work — IGDB
 * one row per involved company per role, TMDB one credit per character. Mapped
 * straight across, that stored `studios: ["Valve", "Valve"]` on 18 games, 3
 * films and 2 shows, and since every list column draws each member as a link,
 * the repeat was drawn too. #481.
 *
 * Every list field a work carries goes through here on its way out of an
 * adapter, so the next refresh of a work stored with a repeat corrects it.
 */

/**
 * The strings in `values` with each repeat after the first dropped, in the
 * order they first appeared — the order is the API's billing or listing, and
 * is part of what the column means.
 *
 * Matching is exact. Two spellings of one company are two names as far as
 * this can tell, and folding case or whitespace would be deciding which of
 * the API's spellings is the real one.
 * @type {(values: string[]) => string[]}
 */
const unique = (values) => [...new Set(values)]

export {
  unique,
}
