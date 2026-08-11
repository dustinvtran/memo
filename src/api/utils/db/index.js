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
 * Basics to make MongoDB queries:
 * https://www.mongodb.com/docs/drivers/node/current/usage-examples/
 *
 */
/** @typedef {import('zod').ZodType} ZodType */
/** @typedef {import('../responses').Response} Response */
/** @typedef {import('../parsers').ValidCollection} ValidCollection */
/** @typedef {import('../errors').Error} Error */
const { ResultAsync } = require('neverthrow')
const { _findOneByField, _findOneByRef, _findAllByField, _findAllInCollection, _updateOneByRef, _create, _deleteOneByRef, _deleteAllByField, _findAllUserEntriesWithMetadata } = require('./unsafe_functions')
const { compose } = require('ramda')
const { toResponse, toResult } = require('./into_safe_values')

/** @type {(collection: ValidCollection, ref: string) => Promise<Response>} */
const findOneByRef = compose(toResponse, _findOneByRef)

/** @type {(collection: ValidCollection, ref: string) => ResultAsync<any, Error>} */
const findOneByRef_ = compose(toResult, _findOneByRef)

/** @type {(collection: ValidCollection, field: string, value: any) => Promise<Response>} */
const findOneByField = compose(toResponse, _findOneByField)

/** @type {(collection: ValidCollection, field: string, value: any) => ResultAsync<any, Error>} */
const findOneByField_ = compose(toResult, _findOneByField)

/** @type {(collection: ValidCollection, field: string, value: any, limit?: number) => Promise<Response>} */
const findAllByField = compose(toResponse, _findAllByField)

/** @type {(collection: ValidCollection, field: string, value: any, limit?: number) => ResultAsync<any, Error>} */
const findAllByField_ = compose(toResult, _findAllByField)

/** @type {(collection: ValidCollection, userId: string, limit?: number) => ResultAsync<any, Error>} */
const findAllUserEntriesWithMetadata_ = compose(toResult, _findAllUserEntriesWithMetadata)

/** @type {(collection: ValidCollection) => Promise<Response>} */
const findAll = compose(toResponse, _findAllInCollection)

/** @type {(collection: ValidCollection, ref: string, update: any) => Promise<Response>} */
const updateByRef = compose(toResponse, _updateOneByRef)

/** @type {(collection: ValidCollection, ref: string, update: any) => ResultAsync<any, Error>} */
const updateByRef_ = compose(toResult, _updateOneByRef)

/** @type {(collection: ValidCollection, ref: string) => Promise<Response>} */
const deleteByRef = compose(toResponse, _deleteOneByRef)

/** @type {(collection: ValidCollection, ref: string) => ResultAsync<any, Error>} */
const deleteByRef_ = compose(toResult, _deleteOneByRef)

/** @type {(collection: ValidCollection, field: string, value: any) => ResultAsync<any, Error>} */
const deleteAllByField_ = compose(toResult, _deleteAllByField)

/** @type {(collection: ValidCollection, data: ExprArg) => Promise<Response>} */
const create = compose(toResponse, _create)

/** @type {(collection: ValidCollection, data: ExprArg) => ResultAsync<any, Error>} */
const create_ = compose(toResult, _create)

module.exports = {
  findOneByRef,
  findOneByRef_,
  findAll,
  findAllByField,
  findAllByField_,
  findOneByField,
  findOneByField_,
  findAllUserEntriesWithMetadata_,
  updateByRef,
  updateByRef_,
  create,
  create_,
  deleteByRef,
  deleteByRef_,
  deleteAllByField_,
}
