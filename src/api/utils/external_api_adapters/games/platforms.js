/**
 * @file Naming the platforms of an IGDB game.
 *
 * Pure and dependency-free for the reason ./companies.js gives: igdb.js
 * cannot be reached from the suite without Twitch credentials.
 *
 * IGDB gives most platforms an `abbreviation` — `PC`, `SNES`, `PS4` — and
 * that is what a work stores. Some it gives none, and those used to be stored
 * as the literal `"?"` — 31 of them across 21 games — and since the Platforms
 * column draws every value as a Wikipedia link, each one drew as a link to a
 * search for "?". #480.
 */
import { unique } from '../unique.js'

/** @type {(value: any) => boolean} */
const isName = (value) => typeof value === 'string' && value.trim() !== ''

/**
 * What to call one platform: its abbreviation, or its full name when it has
 * none, or nothing at all. Needs `platforms.name` in the request's fields as
 * well as `platforms.abbreviation`, or the fallback has nothing to read.
 * @type {(platform: any) => string | undefined}
 */
const platformName = (platform) =>
  [platform?.abbreviation, platform?.name].find(isName)

/**
 * Every platform a game is on, named, in IGDB's order, without repeats and
 * without holes — a platform IGDB names neither way is dropped rather than
 * stored as a placeholder.
 * @type {(platforms: any) => string[]}
 */
const platformNames = (platforms) =>
  unique(
    (Array.isArray(platforms) ? platforms : [])
      .map(platformName)
      .filter(isName)
  )

/**
 * A search result's title: the game's name with its platforms in brackets,
 * so that two games of one name can be told apart. A game with no nameable
 * platform gets its name alone rather than `[?]`.
 * @type {(name: string, platforms: any) => string}
 */
const searchTitle = (name, platforms) => {
  const names = platformNames(platforms)
  return names.length ? `${name} [${names.join(', ')}]` : name
}

export {
  platformName,
  platformNames,
  searchTitle,
}
