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

/** Returns the Netlify token or undefined if not logged in */
const getToken = () => cookies().nf_jwt

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
  getToken,
  getNameFromUrl,
  getEntryTypeFromUrl,
  getSearchFromUrl,
  setSearchInUrl,
}

///////////////////////////////////////////////////////////////////////////////

/** Short, because it is the parameter a shared list url is mostly made of. */
const SEARCH_PARAM = 'q'

const getErrorStatusCode = (error) => error.response?.status ?? 500

const toAuthHeader = (token) => ({ Authorization: `Bearer ${token}` })

const makeRequest = (method, url, data) => (
  NT.ResultAsync.fromPromise(
    refreshTokenIfNecessary().then((jwt) =>
      axios({ method, url, data, ...tokenIfLoggedIn(jwt) })
        .then(({ data }) => data),
    ),
    getErrorStatusCode
  )
)

const tokenIfLoggedIn = (jwt) => ({
  headers: Nullable.map(jwt ?? getToken(), toAuthHeader) ?? {}
})

const getLastPathnameSegment = () => {
  const segments = window.location.pathname?.split?.('/').filter(s => s)
  return segments?.[segments?.length - 1]
}

const getFirstPathnameSegment = () => {
  const segments = window.location.pathname?.split?.('/').filter(s => s)
  return segments?.[0]
}

const cookies = () =>
  Object.fromEntries(
    document
      .cookie
      .split('; ')
      .map((cookieString) => cookieString.split('='))
  )


/* The nf_jwt cookie is minted with a fixed lifetime, so without renewal it just
   expires and silently logs the user out. Renewing once it is past halfway
   through that lifetime keeps an active session sliding forward. */
const RENEWAL_THRESHOLD_SECONDS = 7 * 24 * 3600
const RENEWAL_URL = '/.netlify/functions/auth/renew'

let pendingRenewal = null

const base64UrlDecode = (segment) => {
  const base64 = segment.replace(/-/g, '+').replace(/_/g, '/')
  const padding = (4 - base64.length % 4) % 4
  return atob(base64.padEnd(base64.length + padding, '='))
}

const secondsUntilExpiry = (jwt) => {
  try {
    const { exp } = JSON.parse(base64UrlDecode(jwt.split('.')[1]))
    return exp - Math.floor(Date.now() / 1000)
  } catch (e) {
    return undefined
  }
}

/* Falls back to the current token: it is still valid for a while, so a failed
   renewal should not break the request that triggered it. */
const renewToken = (token) =>
  axios.get(RENEWAL_URL, { headers: toAuthHeader(token) })
    .then(({ data }) => data.token)
    .catch(() => token)
    .finally(() => { pendingRenewal = null })

const refreshTokenIfNecessary = async () => {
  const token = cookies().nf_jwt
  if (!token) {
    return undefined
  }
  const remaining = secondsUntilExpiry(token)
  if (remaining > RENEWAL_THRESHOLD_SECONDS) {
    return token
  }
  // in-flight renewal is shared so concurrent requests only renew once
  pendingRenewal = pendingRenewal ?? renewToken(token)
  return pendingRenewal
}
