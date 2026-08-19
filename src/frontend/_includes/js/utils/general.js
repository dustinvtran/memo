/**
 * @file General utility functions
 */

/** A tag`function` that does nothing, for syntax-highlighting purposes */
const noOpTagFunction = function (t) {
  for (var s = t[0], i = 1, l = arguments.length; i < l; i++)
    s += arguments[i] + t[i]
  return s
}

/** A tag`function` that does nothing, for syntax-highlighting purposes */
const html = noOpTagFunction

const css = noOpTagFunction

const noOp = () => undefined

/**
 * Long enough for anything the page is already fetching to arrive, short
 * enough that a wait for something that is never coming ends.
 */
const WAIT_FOR_EL_TIMEOUT_MS = 10000

/**
 * The element once it is on the page, or `undefined` if it has not arrived
 * within `timeout`.
 *
 * The timeout is the point. Every caller here is waiting for something a
 * failed request, an empty list or a stale url can leave out of the page
 * entirely, and a wait that only ends on a match is a `querySelector` over
 * the whole document on every mutation for the life of the page — on a page
 * that redraws its tables on every column toggle, sort and search — plus a
 * promise that never settles and whatever the caller was holding for it.
 *
 * So callers have to handle `undefined`, and in exchange they never have to
 * bound the wait themselves.
 * @type {(selector: string, options?: { timeout?: number }) => Promise<Element | undefined>}
 */
const waitForEl = (selector, { timeout = WAIT_FOR_EL_TIMEOUT_MS } = {}) =>
  new Promise((resolve) => {
    const existing = document.querySelector(selector)
    if (existing) return resolve(existing)

    let timer
    const observer = new MutationObserver(() => {
      const el = document.querySelector(selector)
      if (el) settle(el)
    })
    const settle = (el) => {
      clearTimeout(timer)
      observer.disconnect()
      resolve(el)
    }

    timer = setTimeout(() => settle(undefined), timeout)
    observer.observe(document.body, { childList: true, subtree: true })
  })

/**
 * "3 hours ago" reads faster than a date when something just happened, which
 * is the case for everything a history or a draft has to show. The exact
 * moment goes in a `title` — see `dateTime` — for when it matters.
 * @type {(timestamp: number, now?: number) => string}
 */
const timeAgo = (timestamp, now = Date.now()) => {
  if (!timestamp) return 'at an unknown time'

  const seconds = Math.round((now - timestamp) / 1000)
  if (seconds < 0) return 'just now'

  // Each unit hands over before it would have to count past its own scale:
  // "60 minutes ago" and "36 hours ago" are things a clock says, not a person.
  const [amount, unit] =
    seconds < 45 ? [seconds, 'second'] :
    seconds < 3600 ? [Math.round(seconds / 60), 'minute'] :
    seconds < 79200 ? [Math.round(seconds / 3600), 'hour'] :
    seconds < 5184000 ? [Math.round(seconds / 86400), 'day'] :
    [Math.round(seconds / 2592000), 'month']

  return amount < 1
    ? 'just now'
    : `${amount} ${unit}${amount === 1 ? '' : 's'} ago`
}

/** The full moment, for the tooltip behind a `timeAgo`. */
/** @type {(timestamp: number) => string} */
const dateTime = (timestamp) =>
  timestamp
    ? new Date(timestamp).toLocaleString(undefined, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
    : 'unknown'

/** A date the user chose from a datepicker has no meaningful time of day. */
/** @type {(timestamp: number) => string} */
const dateOnly = (timestamp) =>
  timestamp
    ? new Date(timestamp).toLocaleDateString(undefined, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
      })
    : 'unknown'

/**
 * These strings are the user's own text, and they go into innerHTML.
 *
 * `'` is escaped as well as `"`. Nothing here currently interpolates into a
 * single-quoted attribute, so that is a guard against the next thing that
 * does rather than a fix for something live — but the whole value of an
 * escaper is that a caller does not have to know which quote its template
 * happened to use.
 */
/** @type {(text: any) => string} */
const escapeHtml = (text) =>
  String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')

/**
 * A url out of the metadata, if it is one we are willing to put in an `href`
 * or a `src`. Escaping does nothing about a scheme — `javascript:alert(1)`
 * comes through `escapeHtml` unchanged and still runs when clicked — so the
 * scheme has to be checked separately, and anything that is not http(s) is
 * dropped rather than rendered. Relative urls (`/img/mawaru.png`) resolve
 * against the base and are kept.
 */
/** @type {(url: any) => string | undefined} */
const toSafeUrl = (url) => {
  if (!url) return undefined
  try {
    const { protocol } = new URL(url, 'https://memo.invalid')
    return protocol === 'http:' || protocol === 'https:' ? String(url) : undefined
  } catch {
    return undefined
  }
}

Utils = {
  html,
  css,
  noOp,
  waitForEl,
  timeAgo,
  dateTime,
  dateOnly,
  escapeHtml,
  toSafeUrl,
}
