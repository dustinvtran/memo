/**
 * @file This file exports simple Error constructors
 * to standardize projectwide error shapes.
 *
 * An error carries two things, written for two different readers. `detail` is
 * whatever we happen to have — a driver exception and its stack, a validation
 * dump — and it goes to the function log and nowhere else. `message` is the
 * one line the caller is told, and it only exists when there is something
 * worth telling them; `responses.fromError` supplies a stock one otherwise.
 *
 * `detail` comes first and `message` second so that the careless call —
 * `.mapErr(errors.db)`, `errors.internal(err)` — puts what it was handed in
 * the slot that never leaves the building. Publishing has to be deliberate.
 * See #105.
 */
/** @typedef {{ error: string, detail?: string, message?: string }} Error */
/** @typedef {(detail?: any, message?: string) => Error} ErrorCreator */

/**
 * An Error's stack rather than its `toString`, because the log is the only
 * place it is going and the log is where a stack earns its keep.
 * @type {(detail: any) => string | undefined}
 */
const toDetailText = (detail) =>
  detail === undefined ? undefined
    : detail instanceof Error ? (detail.stack ?? String(detail))
    : String(detail)

/** @type {(name: string) => ErrorCreator} */
const error = (name) => (detail, message) => ({
  error: name,
  detail: toDetailText(detail),
  message,
})

/** @type {Object.<string, ErrorCreator>} */
module.exports = {
  db: error('DBError'),
  req: error('RequestError'),
  unauthorized: error('UnauthorizedError'),
  notFound: error('NotFound'),
  internal: error('InternalError')
}
