/** @typedef {import('zod').ZodObject} ZodObject */
const { z } = require('zod')
const statusParser = z.enum(['InProgress', 'Completed', 'Dropped', 'Planned'])

const scoreParser = z.union([
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4),
  z.literal(5),
  z.literal(6),
  z.literal(7),
  z.literal(8),
  z.literal(9),
  z.literal(10)
])

/** @param {ZodObject} specificWorkParser */
const entryParser = (specificWorkParser) => z.object({
  // commonMetadata: specificWorkParser,
  workRef: z.string().nullable().optional(),
  overrides: specificWorkParser.partial().optional(),
  userId: z.string(),
  status: statusParser,
  score: scoreParser.nullable().optional(),
  startedDate: z.number().nullable().optional(),
  completedDate: z.number().nullable().optional(),
  review: z.string().optional(),
  progress: z.number().nullable().optional(),
  updatedDate: z.number().optional(),
})

/**
 * What a client may set on an entry it already owns.
 *
 * `_create` parses what it is given and `_updateOneByRef` does not, so a PATCH
 * body used to be `$set` onto the document exactly as it arrived. Three things
 * came through that gap, and this closes all of them by construction — zod
 * drops every key it was not told about:
 *
 * - **`userId`**, which is the field every ownership check reads. A request
 *   that set it moved the entry into another account's list, where its owner
 *   could no longer see it. Omitted here, so the value written stays whatever
 *   the entry was created with.
 * - **`review`**, whose home is the `*Reviews` collection. `updateEntry_`
 *   writes it there and used to write a second copy onto the entry as well:
 *   1.9 MB of duplicated note across production, which the list pipeline
 *   carries a `$project` specifically to hide again.
 * - **`commonMetadata`** and anything else the caller invented. The form sends
 *   `commonMetadata: null` on every save; the work is joined on `workRef` and
 *   the field has no business on the entry at all.
 *
 * Partial, because an update is a partial document — a caller changing a score
 * sends a score. Otherwise it is `entryParser` exactly, so anything the create
 * path accepts this accepts too.
 *
 * @param {ZodObject} specificWorkParser
 */
const entryUpdateParser = (specificWorkParser) =>
  entryParser(specificWorkParser)
    .omit({ userId: true, review: true })
    .partial()

module.exports = {
  entryParser,
  entryUpdateParser,
}
