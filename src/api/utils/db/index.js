/**
 * @file This file exports SAFE functions that take DB query parameters,
 * perform the query and return a Netlify HTTP response or a ResultAsync.
 *
 * Functions SUFFIXED with `_` should return a ResultAsync<obj, Error>.
 * Other functions should return a Promise<Response>
 *
 * Functions PREFIXED with `_` are unsafe (may throw) and should
 * be considered private to this module.
 *
 * `withTransaction` groups writes so that either all of them land or none
 * do. A write takes the session it hands out as an optional last argument, a
 * read takes it in its `QueryOptions`, and a query given neither runs on its
 * own — outside any transaction in progress, and blind to it.
 *
 * Basics to make MongoDB queries:
 * https://www.mongodb.com/docs/drivers/node/current/usage-examples/
 *
 */
/** @typedef {import('zod').ZodType} ZodType */
/** @typedef {import('../responses').Response} Response */
/** @typedef {import('../parsers').ValidCollection} ValidCollection */
/** @typedef {import('../errors').Error} Error */
import { ResultAsync, okAsync, errAsync } from 'neverthrow'
import { _findOne, _findMany, _countScoresByValue, _findOneByField, _findOneByRef, _findAllByFieldIn, _updateOneByRef, _create, _deleteOneByRef, _deleteAllByField, _findAllUserEntriesWithMetadata } from './unsafe_functions.js'
import { compose } from 'ramda'
import { withTransaction } from './db.js'
import { toResponse, toResult } from './into_safe_values.js'
import * as errors from '../errors.js'
/** @typedef {import('./queries').QueryOptions} QueryOptions */
/** @typedef {import('mongodb').ClientSession} ClientSession */

/** @type {(collection: ValidCollection, ref: string) => ResultAsync<any | null, Error>} */
const findOneByRef_ = compose(toResult, _findOneByRef)

/** @type {(collection: ValidCollection, field: string, value: any) => ResultAsync<any | null, Error>} */
const findOneByField_ = compose(toResult, _findOneByField)

/**
 * The same read, for a caller that cannot carry on without the document.
 *
 * `findOneByField_` answers a miss with `null`, which the callers that treat
 * absence as a normal answer test for. Absence becomes an err here instead,
 * so the rest of the chain simply does not run and the `mapErr` every
 * controller already ends with turns it into a 404. Two endpoints answered
 * 502 for want of this; see #139.
 *
 * The err carries no `detail`. A name nobody has taken is a normal answer to a
 * public, unauthenticated route rather than a fault, and `responses.fromError`
 * logs every `detail` it is given — which would let anyone write to the
 * function log by asking for profiles at random.
 * @type {(collection: ValidCollection, field: string, value: any) => ResultAsync<any, Error>}
 */
const findOneByFieldOrFail_ = (collection, field, value) =>
  findOneByField_(collection, field, value)
    .andThen((document) => document ? okAsync(document) : errAsync(errors.notFound()))

/**
 * The general form of the two above: a filter of as many fields as the caller
 * needs, and `{ projection, sort, limit }` for the parts of the work the
 * database can do and the caller shouldn't.
 * @type {(collection: ValidCollection, filter: object, options?: QueryOptions) => ResultAsync<any | null, Error>}
 */
const findOne_ = compose(toResult, _findOne)

/** @type {(collection: ValidCollection, filter: object, options?: QueryOptions) => ResultAsync<any[], Error>} */
const findMany_ = compose(toResult, _findMany)

/**
 * A count per distinct score, rather than the documents to count. Rows of
 * `{ _id, count }` and not documents, so `_id` here is a score rather than
 * the id of anything.
 * @type {(collection: ValidCollection, userId: string) => ResultAsync<{ _id: any, count: number }[], Error>}
 */
const countScoresByValue_ = compose(toResult, _countScoresByValue)

/** @type {(collection: ValidCollection, field: string, values: any[], options?: QueryOptions) => ResultAsync<any[], Error>} */
const findAllByFieldIn_ = compose(toResult, _findAllByFieldIn)

/** @type {(collection: ValidCollection, userId: string, limit?: number) => ResultAsync<{ entry: any, work: any }[], Error>} */
const findAllUserEntriesWithMetadata_ = compose(toResult, _findAllUserEntriesWithMetadata)

/** @type {(collection: ValidCollection, ref: string, update: any, session?: ClientSession) => Promise<Response>} */
const updateByRef = compose(toResponse, _updateOneByRef)

/** @type {(collection: ValidCollection, ref: string, update: any, session?: ClientSession) => ResultAsync<any, Error>} */
const updateByRef_ = compose(toResult, _updateOneByRef)

/** @type {(collection: ValidCollection, ref: string, session?: ClientSession) => Promise<Response>} */
const deleteByRef = compose(toResponse, _deleteOneByRef)

/** @type {(collection: ValidCollection, ref: string, session?: ClientSession) => ResultAsync<any, Error>} */
const deleteByRef_ = compose(toResult, _deleteOneByRef)

/** @type {(collection: ValidCollection, field: string, value: any, session?: ClientSession) => ResultAsync<any, Error>} */
const deleteAllByField_ = compose(toResult, _deleteAllByField)

/** @type {(collection: ValidCollection, data: ExprArg, session?: ClientSession) => Promise<Response>} */
const create = compose(toResponse, _create)

/** @type {(collection: ValidCollection, data: ExprArg, session?: ClientSession) => ResultAsync<any, Error>} */
const create_ = compose(toResult, _create)

export {
  withTransaction,
  findOneByRef_,
  findOne_,
  findMany_,
  countScoresByValue_,
  findAllByFieldIn_,
  findOneByField_,
  findOneByFieldOrFail_,
  findAllUserEntriesWithMetadata_,
  updateByRef,
  updateByRef_,
  create,
  create_,
  deleteByRef,
  deleteByRef_,
  deleteAllByField_,
}