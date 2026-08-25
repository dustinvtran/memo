/** @typedef {import('./works').Work} Work */
/**
 * @template T
 * @typedef {import('./utils').Validator<T>} Validator
 */
import { workParser } from './works.js'
import { validate } from './utils.js'
import { z } from 'zod'
import { entryParser, entryUpdateParser } from './entries.js'
const bookParser = workParser.extend({
  entryType: z.literal('Book'),
  authors: z.array(z.string()).nullable().optional(),
  publishers: z.array(z.string()).nullable().optional(),
})

/** @typedef {z.infer<typeof bookParser>} Book */

const bookEntryParser = entryParser(bookParser)

/** @typedef {z.infer<typeof bookEntryParser>} BookEntry */

/** @type Validator<BookEntry> */
const bookEntries = (x) => validate(bookEntryParser, x)

const bookEntryUpdateParser = entryUpdateParser(bookParser)

/** The fields a PATCH may set; see `entryUpdateParser`. */
/** @type Validator<Partial<BookEntry>> */
const bookEntryUpdates = (x) => validate(bookEntryUpdateParser, x)

/** @type Validator<Book> */
const books = (x) => validate(bookParser, x)

export {
  bookEntries,
  bookEntryUpdates,
  books,
}