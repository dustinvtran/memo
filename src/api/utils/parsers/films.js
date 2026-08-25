/** @typedef {import('./works').Work} Work */
/**
 * @template T
 * @typedef {import('./utils').Validator<T>} Validator
 */
const { workParser } = require('./works')
const { validate } = require('./utils')
const { z } = require('zod')
const { entryParser, entryUpdateParser } = require('./entries')

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

module.exports = {
  filmEntries,
  filmEntryUpdates,
  films,
}
