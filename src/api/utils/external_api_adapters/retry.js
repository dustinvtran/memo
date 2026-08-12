/**
 * @file Retrying the external metadata APIs when they blink.
 *
 * Google Books answers something like one search in eight with a 503, and
 * TMDB and IGDB have the same habit. Every one of those blips reached the
 * user as a bare 500 from `/works/search` — a search that works when you run
 * it again is issue #80.
 *
 * The retry lives here rather than in each adapter: it is dependency-free and
 * takes its clock as an argument, so it is testable without a network or a
 * wait, and the adapters keep nothing but their own mapping code.
 */

/**
 * Statuses worth a second attempt. Anything outside this set is either a real
 * answer or our own mistake, and retrying it only makes the user wait longer
 * for the same failure.
 */
const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504])

/**
 * Network failures that say nothing about the request itself — a connection
 * that died, a DNS lookup that didn't come back.
 */
const RETRYABLE_CODES = new Set([
  'EAI_AGAIN',
  'ECONNABORTED',
  'ECONNRESET',
  'EPIPE',
  'ETIMEDOUT',
  'ERR_NETWORK',
])

/** Attempts in total, not retries after the first. */
const ATTEMPTS = 3

const BASE_DELAY_MS = 200
const MAX_DELAY_MS = 2000

/**
 * The three clients here report a status in three different places: axios on
 * `response.status`, `got` — which node-themoviedb throws straight through
 * for anything it has no class for — on `response.statusCode`, and
 * node-themoviedb's own error classes on `errorCode`.
 * @type {(err: any) => number | undefined}
 */
const statusOf = (err) =>
  err?.response?.status
  ?? err?.response?.statusCode
  ?? err?.errorCode
  ?? err?.status

/** @type {(err: any) => boolean} */
const isTransient = (err) =>
  RETRYABLE_STATUSES.has(/** @type any */ (statusOf(err)))
  || RETRYABLE_CODES.has(err?.code)

/**
 * Exponential, capped so three attempts stay well inside a function's
 * ten seconds.
 * @type {(attempt: number) => number}
 */
const backoffMs = (attempt) =>
  Math.min(BASE_DELAY_MS * 2 ** (attempt - 1), MAX_DELAY_MS)

/**
 * What went wrong, in the few words worth putting in a log line or a 500
 * body. `JSON.stringify` of an Error is `{}`, which is how these failures
 * came to be indistinguishable from one another.
 * @type {(err: any) => string}
 */
const describeFailure = (err) => {
  const status = statusOf(err)

  return [
    status === undefined ? undefined : `HTTP ${status}`,
    typeof err?.code === 'string' ? err.code : undefined,
    err?.message,
  ]
    .filter((part) => part)
    .join(' ')
    || String(err)
}

/**
 * Calls `attempt` until it succeeds, until a failure looks permanent, or
 * until the attempts run out — whichever comes first, rethrowing the last
 * failure. `attempt` is a thunk and not a promise so that each try is a fresh
 * request.
 *
 * @template T
 * @type {(
 *   attempt: () => Promise<T>,
 *   options?: { attempts?: number, sleep?: (ms: number) => Promise<void> },
 * ) => Promise<T>}
 */
const retrying = async (attempt, { attempts = ATTEMPTS, sleep = wait } = {}) => {
  for (let n = 1; ; n++) {
    try {
      return await attempt()
    } catch (err) {
      if (n >= attempts || !isTransient(err)) throw err

      console.warn(
        `Retrying after attempt ${n} of ${attempts}: ${describeFailure(err)}`
      )
      await sleep(backoffMs(n))
    }
  }
}

module.exports = {
  ATTEMPTS,
  BASE_DELAY_MS,
  MAX_DELAY_MS,
  RETRYABLE_CODES,
  RETRYABLE_STATUSES,
  backoffMs,
  describeFailure,
  isTransient,
  retrying,
  statusOf,
}

///////////////////////////////////////////////////////////////////////////////

/** @type {(ms: number) => Promise<void>} */
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
