const { z } = require('zod')
const { validate } = require('./utils')

const reviewParser = z.object({
  text: z.string(),
  // `.optional()` says what `z.any()` alone used to: under zod 3 a key whose
  // schema accepted `undefined` could also be left out, and `z.any()` accepts
  // everything. Zod 4 asks the two questions separately. Every review written
  // by this code names its entry, so the spelling is what changed here and
  // not the rule — but `validate` also runs over documents read back out of
  // the database, and one written before this field was is not worth a 400.
  entryRef: z.any().optional(),
})

/** @typedef {z.infer<typeof reviewParser>} Review */

/** @type Validator<Review> */
const reviews = (x) => validate(reviewParser, x)

module.exports = {
  reviews
}
