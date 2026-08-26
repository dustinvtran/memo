const { escapeHtml } = Utils
const { initComponent } = Components
const { InputWithAction, showNotification } = Components.UI

/**
 * The rule, restated. `usernameParser` in `src/api/utils/parsers/users.js` is
 * where it is enforced, and `MIN_USERNAME_LENGTH` / `MAX_USERNAME_LENGTH` are
 * exported from there for this — but the bundle is concatenated globals with
 * no module system (#221), so the frontend cannot import them and copies them
 * instead. That file is the source of truth; change it and change these.
 *
 * Checking here is not a security boundary: the server parses whatever
 * arrives whether or not this ran. It is so that the mistake almost every new
 * account makes costs no round trip, and so the rule is on the page before it
 * is broken rather than only after.
 */
const MIN_USERNAME_LENGTH = 2
const MAX_USERNAME_LENGTH = 16
const ALPHANUMERIC = /^[a-zA-Z0-9]+$/

const USERNAME_RULE =
  `${MIN_USERNAME_LENGTH} to ${MAX_USERNAME_LENGTH} letters and numbers, nothing else`

const UsernameSetter = () => initComponent({
  content: ({ include }) => include(InputWithAction({
    label: `Pick a username to start using Memo — ${USERNAME_RULE}.`,
    btnLabel: "Submit",
    onSubmit: (newName) => {
      const problem = whyNotAUsername(newName)
      if (problem) {
        showNotification(problem)
        return
      }

      Netlify.setName(newName)
        .map((resp) => {
          /* `NameTaken` comes back as a 200 carrying a `FrontendError`, so it
             arrives here rather than in `mapErr`. Branched on by name rather
             than on `resp.error` being truthy: every `FrontendError` is
             truthy, so a second one added to `api/utils/frontend_errors.js`
             would have been reported as this one. Its `context` is the same
             sentence with the name in it, which is the reason it is built. */
          if (resp.error === 'NameTaken') {
            showNotification(resp.context ?? `${escapeHtml(newName)} is already taken.`)
          } else if (resp.error) {
            showNotification(resp.context ?? COULD_NOT_SET)
          } else {
            showNotification('Successfully picked new name. You will be redirected in 5 seconds.')

            setTimeout(() => { window.location.href = `/profile/${newName}` }, 5000)
          }
        })
        .mapErr((err) => showNotification(requestFailed(err)))
    }
  }))
})

Components.Home.UsernameSetter = UsernameSetter

///////////////////////////////////////////////////////////////////////////////

/**
 * Why the name cannot be sent, or nothing if it can. One sentence per way of
 * getting it wrong, each of them carrying the whole rule: the point is that
 * the next attempt succeeds, not that this one is diagnosed.
 *
 * The name is never interpolated into these — `Utils.html` does not escape,
 * and the value here is by definition one that failed the alphanumeric check.
 * @type {(name: string) => string | undefined}
 */
const whyNotAUsername = (name) => {
  if (!name) {
    return `Please pick a username: ${USERNAME_RULE}.`
  }
  if (name.length < MIN_USERNAME_LENGTH) {
    return `That username is too short. It has to be ${USERNAME_RULE}.`
  }
  if (name.length > MAX_USERNAME_LENGTH) {
    return `That username is too long. It has to be ${USERNAME_RULE}.`
  }
  if (!ALPHANUMERIC.test(name)) {
    return `A username is ${USERNAME_RULE} — no spaces, punctuation or accents.`
  }
  return undefined
}

/**
 * What a refused request can say. Before #217 there was no `mapErr` at all, so
 * every non-2xx skipped the handler entirely and the button simply did not
 * appear to work.
 *
 * There is not much to say yet: `Http.makeRequest` reduces a failure to a bare
 * status code (#222), so `err` is a number carrying no message. Read one when
 * there is one, so this gets better on its own the day that changes, and
 * otherwise repeat the rule — with the check above in place, a rejection from
 * the parser means the two copies of it have drifted apart, and "try again" on
 * its own would be an invitation to a loop.
 *
 * The parser's own reasons are not what would show up here even then, and
 * should not start to: see #105.
 * @type {(err: any) => string}
 */
const requestFailed = (err) => {
  const detail = typeof err === 'string' ? err : err?.message
  return typeof detail === 'string' && detail
    ? `Could not set your username: ${escapeHtml(detail)}`
    : COULD_NOT_SET
}

const COULD_NOT_SET =
  `Could not set your username. It has to be ${USERNAME_RULE} — if it is, ` +
  `something went wrong at our end, so please try again in a moment.`
