/** @typedef {import('@netlify/functions').HandlerEvent} Event */
/** @typedef {import('../utils/responses').Response} Response */
/** @typedef {import('../utils/external_api_adapters/types').Adapter} Adapter */
/** @typedef {import('../utils/errors').Error} Error */
const { toPromise } = require('../utils/general')
const { getUrlSegments } = require('./utils')
const { Result, ok, err, ResultAsync, okAsync } = require('neverthrow')
const errors = require('../utils/errors')
const responses = require('../utils/responses')
const adapters = require('../utils/external_api_adapters')
const db = require('../utils/db')
const workTypes = require('../utils/work_types')

/** @type {(event: Event) => Promise<Response>} */
const searchForWork = (event) =>
  withAdapter('search', event)

/** @type {(event: Event) => Promise<Response>} */
const retrieveWork = (event) => {
  const type = getUrlSegments(event)[1]
  const apiRefId = getUrlSegments(event)[2]

  // Every prefix that names this work, tried in turn — not every prefix it
  // may carry, since the id in the url belongs to one API. The Google Books
  // adapter caches books under `ISBN__`; `google__` is also accepted because
  // some book documents are stored under that name, and both mean the ISBN.
  const apiNames = workTypes.byType(type)?.identityPrefixes

  if (!apiNames) return Promise.resolve(responses.notFound())

  return toPromise(
    findCachedWork(typeToCollection(type), apiNames.map((name) => `${name}__${apiRefId}`))
      .andThen(({ data, ref }) => data
        ? okAsync(({
          ...data,
          internalRef: ref.id
        }))
        : createWork(event)
      )
      .map(responses.ok)
      .mapErr(responses.fromError)
  )
}

module.exports = {
  searchForWork,
  retrieveWork,
}

///////////////////////////////////////////////////////////////////////////////

/** @type {(type: string) => string | undefined} */
const typeToCollection = (type) => workTypes.byType(type)?.works

/**
 * Tries each apiRef in turn and stops at the first cached work.
 * @type {(collection: any, apiRefs: string[]) => ResultAsync<any, Error>}
 */
const findCachedWork = (collection, apiRefs) =>
  apiRefs.reduce(
    (found, apiRef) => found.andThen((result) =>
      result?.data
        ? okAsync(result)
        : db.findOneByField_(collection, 'apiRefs', apiRef)
    ),
    okAsync({})
  )


/** @type {(action: keyof Adapter, event: Event) => Promise<Response>} */
const withAdapter = (action, event) => toPromise(
  withAdapter_(action, event)
    .map(responses.ok)
    .mapErr(responses.fromError)
)

/** @type {(action: keyof Adapter, event: Event) => ResultAsync<any, any>} */
const withAdapter_ = (action, event) =>
  getAdapter(event)
    // TODO: make typechecker happy
    .asyncAndThen((adapter) => adapter[action](decodeURI(getUrlSegments(event)[2])))

const createWork = (event) =>
  withAdapter_('retrieve', event)
    .andThen((data) =>
      db.create_(typeToCollection(getUrlSegments(event)[1]), data)
    )
    .map(({ data, ref }) => ({
      ...data,
      internalRef: ref.id,
    }))


/**
 * The adapters are keyed by `:type` segment, so a known type has one.
 * @type {(event: Event) => Result<Adapter, Error>}
 */
const getAdapter = (event) => {
  const type = getUrlSegments(event)[1]
  return workTypes.byType(type) ? ok(adapters[type]) : err(errors.notFound())
}
