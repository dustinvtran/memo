/**
 * @file This file exports helpers which relate to
 * no specific domain. They fill general holes
 * in JavaScript stdlib.
 */
import { Result, ResultAsync, err, ok, okAsync } from 'neverthrow'
import { identity, isNil } from 'ramda'
/** @type {<T>(x: T) => T} */
const log = (x) => (console.log(x), x)

/** @type {<T>(x: T) => T} */
const warn = (x) => (console.warn(x), x)

/** @type {(val: any) => Result<string, string>} */
const safeJSONStringify = Result.fromThrowable(JSON.stringify, String)

/** @type {<T,U>(x: [T, U]) => x} */
const pair = (x) => x

/** @type {<T,U,V>(x: [T, U, V]) => x} */
const triplet = (x) => x

/** @type {<T,U,V,W>(x: [T, U, V,W]) => x} */
const quad = (x) => x

/** @type {(err: any) => never} */
const throwIt = (err) => { throw err }

/** @type {<T>(ra: ResultAsync<T, T>) => Promise<T>} */
const toPromise = (ra) =>
  ra.match(identity, identity)

/** @type {<T>(x: T | undefined | null) => Result<T, undefined>} */
const validateExists = (x) =>
  isNil(x) ? err(undefined) : ok(x)

/** @type {<T,E>(r: Result<T,E>) => ResultAsync<T,E>} */
const toAsync = (result) =>
  result.asyncAndThen(okAsync)

export {
  toAsync,
  log,
  warn,
  safeJSONStringify,
  pair,
  triplet,
  quad,
  throwIt,
  toPromise,
  validateExists
}