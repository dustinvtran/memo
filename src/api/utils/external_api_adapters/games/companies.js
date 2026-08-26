/**
 * @file Reading studios and publishers out of an IGDB game.
 *
 * Pure and dependency-free for the same reason ./release_dates.js and
 * ./time_to_beat.js are: igdb.js cannot be reached from the test suite
 * without Twitch credentials, so shaping that lives inline in `retrieve` is
 * shaping nothing can check. That is how #214 got in — a name the
 * `/companies` response did not carry was kept as an `undefined` hole in a
 * list `gameParser` declares as `z.array(z.string())`, so one unresolvable
 * company id failed the whole work.
 *
 * A game arrives from `/games` with `involved_companies` holding company
 * *ids* and role flags, and the names come back from a second `/companies`
 * request. Everything between those two responses is here.
 */

/**
 * IGDB will not return more than this many rows for one query, the same cap
 * ./time_to_beat.js works within.
 *
 * It is a ceiling rather than the limit we ask for: the query names the ids
 * it wants, so the number to ask for is however many of them there are. The
 * `limit 50` this replaced was a fixed number applied to both roles at once,
 * which left every game with 51 or more involved companies — anything with a
 * long tail of regional publishers — partly unresolved by construction. A
 * game with more than 500 of them would still truncate, and `companyNames`
 * drops what it cannot name rather than storing a hole either way.
 */
const MAX_COMPANIES_PER_QUERY = 500

/** @type {(id: any) => boolean} */
const isCompanyId = (id) => Number.isFinite(Number(id)) && Number(id) > 0

/**
 * The company ids IGDB lists under one role: `developer` for a studio,
 * `publisher` for a publisher. A company can hold both, and plenty do.
 *
 * IGDB omits `involved_companies` outright for a game it knows nobody behind,
 * so the key needs guarding as much as its contents do. An id has to be a
 * positive number to be one: `Number(null)` is 0, and a 0 would go into the
 * `where` clause looking like an id nobody can answer for.
 * @type {(involvedCompanies: any, role: string) => number[]}
 */
const involvedCompanyIds = (involvedCompanies, role) =>
  (Array.isArray(involvedCompanies) ? involvedCompanies : [])
    .filter((involved) => involved?.[role])
    .map((involved) => Number(involved.company))
    .filter(isCompanyId)

/**
 * The ids to ask `/companies` about, without duplicates — a company that both
 * developed and published a game is one row, and asking for it twice spends
 * the query's limit on a name we already have.
 * @type {(...idLists: number[][]) => number[]}
 */
const companyIdsToLookUp = (...idLists) => [...new Set(idLists.flat())]

/**
 * How many rows that query should ask for: one per id, within IGDB's cap.
 *
 * Never zero — IGDB rejects `limit 0` — though `retrieve` doesn't make the
 * request at all when there is nothing to look up.
 * @type {(ids: number[]) => number}
 */
const companyQueryLimit = (ids) =>
  Math.min(Math.max(ids.length, 1), MAX_COMPANIES_PER_QUERY)

/**
 * Names keyed by the company id they belong to, ids as numbers: IGDB answers
 * with numeric `id`s, and `involved_companies` refers to them the same way.
 * @type {(companies: any) => Map<number, string>}
 */
const indexCompanyNamesById = (companies) =>
  new Map(
    (Array.isArray(companies) ? companies : [])
      .filter((company) => isCompanyId(company?.id) && typeof company?.name === 'string')
      .map((company) => [Number(company.id), company.name])
  )

/**
 * The names for `ids`, in the order they were asked for, dropping any the
 * response did not carry.
 *
 * Dropping rather than keeping a hole is the whole point, and matches what
 * ../tmdb_mapping.js does in `genreNames`, `directorNames` and
 * `notableActors`. An id can go unanswered because the response was truncated
 * or because IGDB holds no row for it at all — a company record since merged
 * or deleted — and neither is a reason to reject a game we can otherwise
 * describe. A work with one unnameable publisher is worth caching with the
 * publishers we could name.
 * @type {(ids: number[], companies: any) => string[]}
 */
const companyNames = (ids, companies) => {
  const namesById = indexCompanyNamesById(companies)
  return (Array.isArray(ids) ? ids : [])
    .map((id) => namesById.get(Number(id)))
    .filter((name) => typeof name === 'string')
}

export {
  MAX_COMPANIES_PER_QUERY,
  involvedCompanyIds,
  companyIdsToLookUp,
  companyQueryLimit,
  indexCompanyNamesById,
  companyNames,
}
