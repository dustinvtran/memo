/** @typedef {import('zod').ZodType} ZodType */
/** @typedef {import('../errors').Error} Error */
/**
 * @template T
 * @typedef {(x: any) => Result<T, Error>} Validator
 */
import { Result } from 'neverthrow'
import * as errors from '../errors.js'
/**
 * Zod's account of what was wrong goes to the log rather than to the caller.
 * It names our own field layout issue by issue, and the same `validate` runs
 * over documents read back out of the database as over request bodies — so
 * what it has to say is not always about anything the caller sent. #105.
 * @type {<T>(parser: ZodType, x: T) => Result<T, Error>}
 */
const validate = (parser, x) =>
  Result.fromThrowable(
    parser.parse,
    (e) => errors.req(e, 'the request body is not valid'),
  )(x)

export {
  validate
}