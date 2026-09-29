/**
 * @file Functions to make safe network requests
 * using neverthrow for functional error handling
 * neverthrow API: https://github.com/supermacro/neverthrow
 */

const get = (url) => makeRequest('get', url)

const post = (url, data) => makeRequest('post', url, data)

const patch = (url, data) => makeRequest('patch', url, data)

const put = (url, data) => makeRequest('put', url, data)

const del = (url) => makeRequest('delete', url)

/**
 * Whether someone is signed in, as far as the page can tell. The session
 * cookie itself is `httpOnly` and invisible from here (#501), so this is the
 * hint the server sets beside it — see `sessionExpiry`. It says nothing about
 * whether the session still verifies; the API is the judge of that.
 */
const hasSession = () => sessionExpiry() !== undefined

/**
 * The one line to show someone about a failed request, and only that line:
 * the `error` class name is ours to publish but it is not English.
 *
 * The fallback is for the failures that never got as far as the API writing a
 * message — a dropped connection, a timeout, a proxy's own error page — and
 * for the plain `Error`s `WithRemoteData` also accepts, whose `message` this
 * reads just as happily.
 *
 * A message can carry text out of the request (`no such user: <name>`). It is
 * text wherever it is interpolated, and `Utils.html` is what sees to that —
 * the callers used to wrap each one in `escapeHtml` by hand.
 */
const errorMessage = (err) => err?.message ?? 'something went wrong'

const getNameFromUrl = () => {
  const urlParams = new URLSearchParams(window.location.search)
  return urlParams.get('user') ?? getLastPathnameSegment()
}

const getEntryTypeFromUrl = () => {
  const urlParams = new URLSearchParams(window.location.search)
  return urlParams.get('type') ?? getFirstPathnameSegment()
}

/** The list page's search query. See `utils/entry_search.js` for its syntax. */
const getSearchFromUrl = () =>
  new URLSearchParams(window.location.search).get(SEARCH_PARAM) ?? ''

/**
 * Puts the query in the url, so that a search can be linked to, bookmarked and
 * come back on a reload. `replaceState` rather than `pushState`: the search
 * fires as it is typed, and a history entry per keystroke would make the back
 * button spell `director:nolan` backwards one letter at a time.
 * @type {(text: string) => void}
 */
const setSearchInUrl = (text) => {
  const params = new URLSearchParams(window.location.search)
  if (text) {
    params.set(SEARCH_PARAM, text)
  } else {
    params.delete(SEARCH_PARAM)
  }
  const query = params.toString()
  const url = window.location.pathname +
    (query ? `?${query}` : '') +
    window.location.hash
  window.history.replaceState(null, '', url)
}

Http = {
  get,
  post,
  patch,
  put,
  del,
  hasSession,
  errorMessage,
  getNameFromUrl,
  getEntryTypeFromUrl,
  getSearchFromUrl,
  setSearchInUrl,
}

///////////////////////////////////////////////////////////////////////////////

/** Short, because it is the parameter a shared list url is mostly made of. */
const SEARCH_PARAM = 'q'

/**
 * What a failed request leaves the caller to work with. The whole body is
 * kept: `message` is the one line the API writes for the person who made the
 * request — `responses.fromError` fills in a stock sentence for every error
 * class, so an answer from our own API always carries one — and the status is
 * kept because a 401 is the case where the answer is "log in again" rather
 * than "try again" (#216).
 *
 * It reads an error carrying a `response`, which is the shape `request` below
 * throws and the shape axios used to. The mapper also has to answer for the
 * failures that never reached the API at all — a dropped connection arrives
 * as a plain `Error` with no `response` on it — and that is what the 500
 * fallback is for, rather than a case that no longer happens.
 */
const toRequestError = (error) => ({
  status: error.response?.status ?? 500,
  error: error.response?.data?.error,
  message: error.response?.data?.message,
})

/**
 * No `Authorization` header: the browser sends the session cookie on its own,
 * and the page could not repeat it if it wanted to.
 */
const makeRequest = (method, url, data) => (
  NT.ResultAsync.fromPromise(
    refreshSessionIfNecessary().then(() => request(method, url, data)),
    toRequestError
  )
)

/**
 * Sent on every request, so that a write signed in by the session cookie is
 * accepted. A page on another site cannot add a custom header to a request
 * to this one without a CORS preflight the API never answers, and that is the
 * whole of the defence; `CSRF_HEADER` in `session_token.js` says the rest.
 */
const CSRF_HEADERS = { 'X-Requested-With': 'memo' }

/**
 * One request, as a promise that resolves with the body or rejects the way
 * `toRequestError` reads.
 *
 * The rejecting is the part to keep hold of. `fetch` resolves for a 404 and a
 * 500 alike — the status is on `ok` and nothing is thrown — where axios
 * rejected, and everything downstream of here is built on the rejection: the
 * `mapErr` of every `ResultAsync`, every failure message `WithRemoteData`
 * draws, and the fallback in `renewToken`. So a failed status is turned back
 * into a throw here, and the whole of the difference between the two clients
 * lives in these four lines.
 */
const request = async (method, url, data) => {
  const response = await fetch(url, {
    method: method.toUpperCase(),
    credentials: 'same-origin',
    headers: {
      ...CSRF_HEADERS,
      ...(data === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  })

  const body = await readBody(response)
  if (!response.ok) throw toResponseError(response, body)
  return body
}

/**
 * A failed status, as an error carrying what came back with it.
 *
 * `toRequestError` reads `error.response.status` and `error.response.data`, so
 * that is what this fills in. Keeping the shape rather than rewriting the
 * mapper is the smaller change of the two, and it leaves the mapper's other
 * case — a plain `Error` from a request that got no answer at all — reading
 * exactly as it did.
 */
const toResponseError = (response, body) =>
  Object.assign(new Error(`${response.status} ${response.statusText}`.trim()), {
    response: { status: response.status, data: body },
  })

/**
 * The body, parsed if it is JSON. Three answers have to come out of here: our
 * own API's `{ error, message }` and its data; an empty 200, which `del` gets
 * and which `response.json()` throws on rather than answering `undefined`;
 * and whatever a proxy or a CDN writes its own error page in, which is html
 * and must reach the 500 fallback rather than throwing on the way to it.
 */
const readBody = async (response) => {
  const text = await response.text()
  if (!text) return undefined
  try {
    return JSON.parse(text)
  } catch (e) {
    return text
  }
}

const getLastPathnameSegment = () => {
  const segments = window.location.pathname?.split?.('/').filter(s => s)
  return segments?.[segments?.length - 1]
}

const getFirstPathnameSegment = () => {
  const segments = window.location.pathname?.split?.('/').filter(s => s)
  return segments?.[0]
}

/**
 * Only the first `=` separates a cookie's name from its value — the value may
 * contain more of them — and the value is percent-encoded by whoever set it.
 * A JWT is unpadded base64url, so it survives being split on every `=` and
 * read raw, which is precisely what makes that worth not relying on.
 */
const cookies = () =>
  Object.fromEntries(
    document
      .cookie
      .split(';')
      .map((cookieString) => cookieString.trim())
      .filter((cookieString) => cookieString)
      .map((cookieString) => {
        const separator = cookieString.indexOf('=')
        return separator === -1
          ? [cookieString, '']
          : [
            cookieString.slice(0, separator),
            decodeCookieValue(cookieString.slice(separator + 1)),
          ]
      })
  )

/* A cookie some other service set can be encoded badly enough that decoding
   it throws, and a throw here would take the token down with it. */
const decodeCookieValue = (value) => {
  try {
    return decodeURIComponent(value)
  } catch (e) {
    return value
  }
}


/* The session is minted with a fixed lifetime — 400 days, as
   `SESSION_LIFETIME_SECONDS` in `session_token.js` — so without renewal it
   just expires and silently logs the user out. Renewing once it is past
   halfway through that lifetime keeps an active session sliding forward, so
   anyone who visits at least every 200 days stays signed in. */
const RENEWAL_THRESHOLD_SECONDS = 200 * 24 * 3600
const RENEWAL_URL = '/.netlify/functions/auth/renew'

/* Written by the server beside the session cookie; `SESSION_HINT_COOKIE_NAME`
   in `session_token.js`. */
const SESSION_HINT_COOKIE = 'memo_session'

/* The session cookie as it was before #501 made it `httpOnly`. A browser
   that signed in before then still holds a readable one and no hint, and
   would otherwise look signed out until it lapsed. It is read only for its
   expiry, and the first request renews it, which replaces it with the
   `httpOnly` cookie and the hint. Nothing can still hold one fourteen days
   after that deploy, and this can go then. */
const LEGACY_SESSION_COOKIE = 'nf_jwt'

let pendingRenewal = null

const base64UrlDecode = (segment) => {
  const base64 = segment.replace(/-/g, '+').replace(/_/g, '/')
  const padding = (4 - base64.length % 4) % 4
  return atob(base64.padEnd(base64.length + padding, '='))
}

const expOfJwt = (jwt) => {
  try {
    const { exp } = JSON.parse(base64UrlDecode(jwt.split('.')[1]))
    return Number.isFinite(exp) ? exp : undefined
  } catch (e) {
    return undefined
  }
}

/** The session's `exp`, in seconds, or undefined when there is none. */
const sessionExpiry = () => {
  const jar = cookies()
  const hinted = Number(jar[SESSION_HINT_COOKIE])
  if (jar[SESSION_HINT_COOKIE] && Number.isFinite(hinted)) return hinted
  return jar[LEGACY_SESSION_COOKIE] ? expOfJwt(jar[LEGACY_SESSION_COOKIE]) : undefined
}

/* A renewal that fails is not a failure of the request it held up: that goes
   out on the cookie the browser already has, which is still good for a while,
   and if it is not, the request's own 401 is the answer the page acts on. A
   renewal the server refused has cleared the hint, which is what stops the
   page asking again. */
const renewSession = () =>
  request('get', RENEWAL_URL)
    .catch(() => undefined)
    .finally(() => { pendingRenewal = null })

const refreshSessionIfNecessary = async () => {
  const exp = sessionExpiry()
  if (exp === undefined) {
    return
  }
  const legacy = !cookies()[SESSION_HINT_COOKIE]
  if (!legacy && exp - Math.floor(Date.now() / 1000) > RENEWAL_THRESHOLD_SECONDS) {
    return
  }
  // in-flight renewal is shared so concurrent requests only renew once
  pendingRenewal = pendingRenewal ?? renewSession()
  return pendingRenewal
}
