/**
 * @template T
 * @typedef {import('./utils').Validator<T>} Validator
 */
import { z } from 'zod'
import validator from 'validator'
const { isAlphanumeric } = validator.default
import { validate } from './utils.js'
const scoreTallyParser = z.object({
  [1]: z.number(),
  [2]: z.number(),
  [3]: z.number(),
  [4]: z.number(),
  [5]: z.number(),
  [6]: z.number(),
  [7]: z.number(),
  [8]: z.number(),
  [9]: z.number(),
  [10]: z.number(),
  unrated: z.number(),
})

/**
 * The bounds, named and exported for the reason `MAX_BIOGRAPHY_LENGTH` below
 * is: the username setter has to state the rule before a name is submitted,
 * and a rule written down in two places drifts apart. Nothing imports these
 * yet — the frontend bundle has no module system, which is #221 — so
 * `components/home/username_setter.js` restates them with a comment pointing
 * back here. The export is what that comment will eventually be able to mean.
 */
const MIN_USERNAME_LENGTH = 2
const MAX_USERNAME_LENGTH = 16

/**
 * A username, defined once and used twice.
 *
 * `_create` parses the whole user document and `_updateOneByRef` parses
 * nothing, so this rule applied to an account claiming its first name and to
 * no rename after it: `assignName` branches to `create_` or `updateByRef_`,
 * and only the first of those went through a parser. A rename could therefore
 * be any length, any type, or markup — and `username` is interpolated into the
 * profile page. `setOwnName` runs this by hand for that reason. See #172.
 */
const usernameParser = z.string()
  .max(MAX_USERNAME_LENGTH)
  .min(MIN_USERNAME_LENGTH)
  .refine((val) => isAlphanumeric(val))

/**
 * A biography is markdown, rendered through `marked` and `DOMPurify` on the
 * profile. It had no bound at all on the way in, for the same reason: `setBio`
 * reaches `updateByRef_` directly. The limit is generous rather than tight —
 * the longest one in production is 2356 characters — because the point is to
 * stop an unbounded write, not to ration what anyone can say.
 */
const MAX_BIOGRAPHY_LENGTH = 20000

const biographyParser = z.string().max(MAX_BIOGRAPHY_LENGTH).nullable()

const userParser = z.object({
  userId: z.string(),
  username: usernameParser,
  stats: z.object({
    updatedDate: z.number(),
    scores: z.object({
      films: scoreTallyParser,
      books: scoreTallyParser,
      tv: scoreTallyParser,
      games: scoreTallyParser,
    })
  }).nullable().optional(),
  biography: biographyParser.optional(),
})

/** @typedef {z.infer<typeof userParser>} User

/** @type Validator<User> */
const users = (x) => validate(userParser, x)

/** @type Validator<string> */
const username = (x) => validate(usernameParser, x)

/** @type Validator<string | null> */
const biography = (x) => validate(biographyParser, x)

export {
  users,
  username,
  biography,
  MIN_USERNAME_LENGTH,
  MAX_USERNAME_LENGTH,
  MAX_BIOGRAPHY_LENGTH,
}