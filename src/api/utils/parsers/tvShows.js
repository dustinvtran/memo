/** @typedef {import('./works').Work} Work */
/**
 * @template T
 * @typedef {import('./utils').Validator<T>} Validator
 */
const { workParser } = require('./works')
const { validate } = require('./utils')
const { z } = require('zod')
const { entryParser, entryUpdateParser } = require('./entries')


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

module.exports = {
  tvShowEntries,
  tvShowEntryUpdates,
  tvShows
}
