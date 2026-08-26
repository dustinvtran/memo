/**
 * @file This module exports converters which take
 * an unsafe Promise of a DB response which may throw,
 * and return either safe Promises of a HTTP response
 * or safe ResultAsyncs of the DB-returned object.
 */
/** @typedef {import('../responses').Response} Response */
/** @typedef {import('../errors').Error} Error */
import * as responses from '../responses.js'
import { match } from 'ts-pattern'
import { fromPromise, ResultAsync } from 'neverthrow'
import * as errors from '../errors.js'
/** @type {(returnedDocument: Promise<any>) => Promise<Response>} */
const toResponse = (returnedDocument) =>
  returnedDocument.then(responses.ok).catch((err) => responses.fromError(toError(err)))

/** @type {(returnedDocument: Promise<any>) => ResultAsync<object, Error> } */
const toResult = (returnedDocument) =>
  fromPromise(returnedDocument, toError)

export {
  toResponse,
  toResult,
}
///////////////////////////////////////////////////////////////////////////////

/**
 * What a rejection out of the unsafe layer is told to the rest of the app.
 *
 * Most of them are the driver's, and the driver's error becomes the error's
 * `detail`, which `fromError` logs and does not send: a failed topology
 * description names every host in the replica set, and reads here are
 * unauthenticated. #105.
 *
 * Some of them are already ours. `_create` rejects with what the collection's
 * parser said, which is an `errors.req` — a 400 naming the request, with a
 * `detail` that has been through `toDetailText` once already. Both converters
 * used to wrap it again regardless: a `name` neither `errors.db` nor an error
 * of ours carries meant every one of them came out as "the database did not
 * answer" — a 500 about a database that was never asked, and `[object Object]`
 * in the log where zod's account of the document should be. So an error of
 * ours passes through as it stands. `typeof err?.error === 'string'` is the
 * same test `failed` in controllers/entries.js makes, for the same reason.
 * #213.
 * @type {(err: any) => Error}
 */
const toError = (err) =>
  typeof err?.error === 'string'
    ? err
    : match(err?.name)
      .with('BadRequest', () => errors.req(err))
      .with('NotFound', () => errors.notFound(err))
      .otherwise(() => errors.db(err))
