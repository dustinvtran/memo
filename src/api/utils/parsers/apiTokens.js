/**
 * @template T
 * @typedef {import('./utils').Validator<T>} Validator
 */
import { z } from 'zod'
import { validate } from './utils.js'
import { MAX_API_TOKEN_NAME_LENGTH } from '../api_token.js'

/* Trimmed before it is measured, so a name of spaces is no name. */
const apiTokenNameParser = z.string().trim().min(1).max(MAX_API_TOKEN_NAME_LENGTH)

/**
 * The stored half of a token. There is no field for the token itself: a
 * document that could carry one would be one `...body` away from doing so.
 * `strict` so that an extra field is a refusal rather than a quiet write.
 */
const apiTokenParser = z.object({
  userId: z.string().min(1),
  name: apiTokenNameParser,
  tokenHash: z.string().regex(/^[0-9a-f]{64}$/),
  createdAt: z.number(),
}).strict()

/** @type Validator<z.infer<typeof apiTokenParser>> */
const apiTokens = (x) => validate(apiTokenParser, x)

/** @type Validator<string> */
const apiTokenName = (x) => validate(apiTokenNameParser, x)

export {
  apiTokens,
  apiTokenName,
}
