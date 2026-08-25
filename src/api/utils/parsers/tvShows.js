/** @typedef {import('./works').Work} Work */
/**
 * @template T
 * @typedef {import('./utils').Validator<T>} Validator
 */
import { workParser } from './works.js'
import { validate } from './utils.js'
import { z } from 'zod'
import { entryParser, entryUpdateParser } from './entries.js'
const tvShowParser = workParser.extend({
  entryType: z.literal('TVShow'),
  directors: z.array(z.string()).nullable().optional(),
  actors: z.array(z.string()).nullable().optional(),
  episodes: z.number().nullable().optional(),
})

/** @typedef {z.infer<typeof tvShowParser>} TVShow */

const tvShowEntryParser = entryParser(tvShowParser)

/** @typedef {z.infer<typeof tvShowEntryParser>} TVShowEntry */

/** @type Validator<TVShowEntry> */
const tvShowEntries = (x) => validate(tvShowEntryParser, x)

const tvShowEntryUpdateParser = entryUpdateParser(tvShowParser)

/** The fields a PATCH may set; see `entryUpdateParser`. */
/** @type Validator<Partial<TVShowEntry>> */
const tvShowEntryUpdates = (x) => validate(tvShowEntryUpdateParser, x)

/** @type Validator<TVShow> */
const tvShows = (x) => validate(tvShowParser, x)

export {
  tvShowEntries,
  tvShowEntryUpdates,
  tvShows
}