/**
 * @file General utility functions
 */

/** A tag`function` that does nothing, for syntax-highlighting purposes */
const noOpTagFunction = function (t) {
  for (var s = t[0], i = 1, l = arguments.length; i < l; i++)
    s += arguments[i] + t[i]
  return s
}

/**
 * The brand on markup, as opposed to text that happens to be in a string.
 *
 * A tagged template is handed its literal fragments and its interpolated
 * values separately, so it knows which half the developer wrote and which half
 * came from a database. That is the whole idea: `html` escapes the values and
 * leaves the literals alone, so a component author who thinks about none of
 * this still gets it right. What it costs is that the result can no longer be
 * a bare string — markup and text would be the same type otherwise, and
 * composing two templates would escape the inner one's tags.
 *
 * So `html` returns a branded object and passes branded values straight
 * through. Nested `${html`…`}` and `${include(…)}` are therefore trusted with
 * no annotation, which is what makes this survivable across forty components;
 * everything else is escaped whether or not anyone thought about it.
 *
 * A `Symbol` rather than a name a value could carry: everything interpolated
 * here has been through `JSON.parse`, and `{"__safe": true}` is a thing a
 * stored override can say.
 */
const SAFE_HTML = Symbol('safe html')

const markSafe = (markup) => ({
  [SAFE_HTML]: true,
  toString: () => markup,
})

const isSafeHtml = (value) =>
  typeof value === 'object' && value !== null && value[SAFE_HTML] === true

/**
 * What an interpolated value contributes.
 *
 * `null` and `undefined` are nothing rather than the words "null" and
 * "undefined": a template says `${data.progress}` about a field that is often
 * absent, and the old tag function wrote the word into the page.
 *
 * An array is each of its elements in turn, so `${rows.map(Row)}` composes
 * without a `.join('')` — and a `.join('')` left behind flattens branded
 * values into a plain string, which this would then escape. That is the loud
 * failure to look for after a refactor.
 */
const interpolate = (value) =>
  value === null || value === undefined ? ''
  : Array.isArray(value) ? value.map(interpolate).join('')
  : isSafeHtml(value) ? value.toString()
  : escapeHtml(value)

/**
 * Markup, with every interpolated value escaped unless it is markup itself.
 * @type {(strings: TemplateStringsArray, ...values: any[]) => object}
 */
const html = (strings, ...values) => {
  let markup = strings[0]
  for (let i = 0; i < values.length; i++) {
    markup += interpolate(values[i]) + strings[i + 1]
  }
  return markSafe(markup)
}

/**
 * Markup from somewhere else, vouched for by the caller.
 *
 * Three call sites, and they are the ones worth having: the two sanitised
 * markdown fields — a note and a biography, both out of `marked` and
 * `DOMPurify` — and `include` in `components/index.js`, which is handing back
 * markup an `html` template already produced. Anything else reaching for this
 * is a template that should have been an `html` one.
 * @type {(markup: any) => object}
 */
const raw = (markup) => markSafe(String(markup ?? ''))

/**
 * Still a no-op, and it has to stay one. A stylesheet is not markup, and `>`
 * is the child combinator: `main.css` writes `.table > thead > tr > th` and
 * two component styles write one of their own. Escaping those corrupts them.
 */
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
 *
 * `html` above is what calls this now. Still published, because escaping into
 * something that is not an `html` template — markdown source, on its way to
 * `marked` — is a different job that the tag function cannot do.
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
  raw,
  css,
  noOp,
  waitForEl,
  timeAgo,
  dateTime,
  dateOnly,
  escapeHtml,
  toSafeUrl,
}
