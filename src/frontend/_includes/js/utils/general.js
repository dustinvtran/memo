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

const waitForEl = (selector) => new Promise((resolve) => {
  if (document.querySelector(selector)) {
    return resolve(document.querySelector(selector))
  }

  const observer = new MutationObserver((mutations) => {
    if (document.querySelector(selector)) {
      resolve(document.querySelector(selector))
      observer.disconnect()
    }
  })

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

/** These strings are the user's own text, and they go into innerHTML. */
/** @type {(text: any) => string} */
const escapeHtml = (text) =>
  String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')

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
