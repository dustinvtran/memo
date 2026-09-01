const { html } = Utils
const { isLoggedIn, getUserName } = Netlify
const { ProfileLists } = Components.Profile
const { initComponent, WithRemoteData, Redirect, RemoteFailure } = Components
const { Base } = Components.UI
const { UsernameSetter } = Components.Home

const HomePage = () => initComponent({
  content: ({ include }) => include(
    Base("Homepage", isLoggedIn()
      ? WithRemoteData({
        remoteData: getUserName(),
        component: ProfileListsOrUsernameSetter,
        errorComponent: NameRequestFailed
      })
      : UnauthenticatedWelcome()
    )
  )
})

Components.Home.HomePage = HomePage

///////////////////////////////////////////////////////////////////////////////

/**
 * What the page draws when `GET /api/name` does not answer, which it now says
 * rather than swallowing: the endpoint used to report every failure as
 * `200 {}`, and `{}` destructures to no error and no username, so the branch
 * below drew `AuthenticatedHomePage(undefined)` — "Hi undefined!", linking to
 * `/profile/undefined`. See #216.
 *
 * The 401 is the case worth naming, and the status is there to name it with
 * as of #234. `isLoggedIn` is the presence of the `nf_jwt` cookie and nothing
 * about whether it still verifies, so this page is where a session that ended
 * while nobody was looking is found out, and the answer to that is to log in
 * again rather than to try again — the same reading `sessionOver()` takes on
 * the renewal path. Every other failure gets what it would have got anyway,
 * from the one place that decides what a failure looks like.
 *
 * A link rather than `Redirect`: a token that verifies nowhere would bounce
 * the browser between here and Auth0 with nothing on screen to stop it.
 * @type {(err: { status: number, message?: string }) => object}
 */
const NameRequestFailed = (err) => err?.status === 401
  ? SessionEnded()
  : RemoteFailure(err)

const SessionEnded = () => initComponent({
  content: () => html`
    <div class="full-bleed">
      Your session has ended. <a href="${LOGIN_URL}">Log in</a> to pick up where you left off.
    </div>
  `
})

const ProfileListsOrUsernameSetter = ({ error, username }) => initComponent({
  content: ({ include }) => html`
    <div>
      ${error === 'NoUsernameSet'   ? include(UsernameSetter())
        : typeof error === 'string' ? `${error}`
                 /* if no error */  : include(AuthenticatedHomePage(username))
      }
    </div>
  `
})

const AuthenticatedHomePage = (username) => initComponent({
  content: () => html`
    <div id="authenticated-home-page" class="full-bleed">
      Hi ${username}! Not much here yet. Why not visit <a href="/profile/${encodeURIComponent(username)}">your profile</a>?
    </div>

    <div class="full-bleed">
      <h2>Tips</h2>
        <ul>
          <li>
          If you write comments often, browser extensions like
          <a href="https://chrome.google.com/webstore/detail/typio-form-recovery/djkbihbnjhkjahbhjaadbepppbpoedaa?hl=en">Typio Form
    Recovery</a>
          will back up text in case you accidentally exit the Edit window popup
          without saving your edits.
          </li>
      </ul>
    </div>
  `,
})

const UnauthenticatedWelcome = () => initComponent({
  content: () => html`
    <div class="full-bleed">Welcome to memo. Log in to start listing.</div>
  `
})

/* Where the menu's "Log in" goes. The route sends the browser back to
   whichever page it started from, so from here that is this one. */
const LOGIN_URL = '/.netlify/functions/auth/login'
