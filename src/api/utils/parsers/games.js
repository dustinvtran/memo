/** @typedef {import('./works').Work} Work */
/**
 * @template T
 * @typedef {import('./utils').Validator<T>} Validator
 */
import { workParser } from './works.js'
import { validate } from './utils.js'
import { z } from 'zod'
import { entryParser, entryUpdateParser } from './entries.js'
const gameParser = workParser.extend({
  entryType: z.literal('Game'),
  platforms: z.array(z.string()).nullable().optional(),
  studios: z.array(z.string()).nullable().optional(),
  publishers: z.array(z.string()).nullable().optional(),
})

/** @typedef {z.infer<typeof gameParser>} Game */

const gameEntryParser = entryParser(gameParser)

/** @typedef {z.infer<typeof gameEntryParser>} GameEntry */

/** @type Validator<GameEntry> */
const gameEntries = (x) => validate(gameEntryParser, x)

const gameEntryUpdateParser = entryUpdateParser(gameParser)

/** The fields a PATCH may set; see `entryUpdateParser`. */
/** @type Validator<Partial<GameEntry>> */
const gameEntryUpdates = (x) => validate(gameEntryUpdateParser, x)

/** @type Validator<Game> */
const games = (x) => validate(gameParser, x)

export {
  gameEntries,
  gameEntryUpdates,
  games,
}