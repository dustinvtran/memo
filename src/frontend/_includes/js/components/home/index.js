const { html, escapeHtml } = Utils
const { isLoggedIn, getUserName } = Netlify
const { ProfileLists } = Components.Profile
const { initComponent, WithRemoteData, Redirect } = Components
const { Base } = Components.UI
const { UsernameSetter } = Components.Home

const HomePage = () => initComponent({
  content: ({ include }) => include(
    Base("Homepage", isLoggedIn()
      ? WithRemoteData({
        remoteData: getUserName(),
        component: ProfileListsOrUsernameSetter
      })
      : UnauthenticatedWelcome()
    )
  )
})

Components.Home.HomePage = HomePage

///////////////////////////////////////////////////////////////////////////////

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
    <div id="authenticated-home-page" class="row">
      Hi ${escapeHtml(username)}! Not much here yet. Why not visit <a href="/profile/${escapeHtml(encodeURIComponent(username))}">your profile</a>?
    </div>

    <div class="row">
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
    <div class="row">Welcome to memo. Log in to start listing.</div>
  `
})
