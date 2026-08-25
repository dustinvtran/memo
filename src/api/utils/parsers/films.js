/** @typedef {import('./works').Work} Work */
/**
 * @template T
 * @typedef {import('./utils').Validator<T>} Validator
 */
import { workParser } from './works.js'
import { validate } from './utils.js'
import { z } from 'zod'
import { entryParser, entryUpdateParser } from './entries.js'
const filmParser = workParser.extend({
  entryType: z.literal('Film'),
  directors: z.array(z.string()).nullable().optional(),
  actors: z.array(z.string()).nullable().optional(),
})

/** @typedef {z.infer<typeof filmParser>} Film */

const filmEntryParser = entryParser(filmParser)

/** @typedef {z.infer<typeof filmEntryParser>} FilmEntry */

/** @type Validator<FilmEntry> */
const filmEntries = (x) => validate(filmEntryParser, x)

const filmEntryUpdateParser = entryUpdateParser(filmParser)

/** The fields a PATCH may set; see `entryUpdateParser`. */
/** @type Validator<Partial<FilmEntry>> */
const filmEntryUpdates = (x) => validate(filmEntryUpdateParser, x)

/** @type Validator<Film> */
const films = (x) => validate(filmParser, x)

export {
  filmEntries,
  filmEntryUpdates,
  films,
}