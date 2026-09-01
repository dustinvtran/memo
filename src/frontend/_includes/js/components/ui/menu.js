const { initComponent } = Components
const { html, css } = Utils
const { el } = Dom

const Menu = () => initComponent({
  content: ({ include }) => html`
    <div
      class="col-sm-3 col-md-2 memo-menu"
      id="sidebar"
      role="navigation"
    >
      <div id="menu-logo">
        <img src="/img/memo_logo.png">
      </div>
      <hr>
      <ul class="nav nav-pills nav-stacked">
        <li id="home-menu-item"><a href="/">Home</a></li>
      </ul>
    </div>
  `,
  initializer: () => {
    const isLoggedIn = Netlify.getToken()
    // `String` on both of these: `insertAdjacentHTML` takes a string of
    // markup, and markup is not a string until it is asked for.
    const menuAuthLink = isLoggedIn
      ? html`<a href="/.netlify/functions/auth/logout">Log out</a>`
      : html`<a href="/.netlify/functions/auth/login">Log in</a>`
    // `afterend`, which is what `.after()` was. Both of these go directly after
    // the Home item, so the Profile link inserted below — later, when the
    // request answers — lands above the Log out link rather than after it.
    el('#home-menu-item')?.insertAdjacentHTML(
      'afterend',
      String(html`<li>${menuAuthLink}</li>`)
    )

    Netlify.getUserName()
      .map(({ username }) => {
        if (username) {
          el('#home-menu-item')?.insertAdjacentHTML('afterend', String(html`
            <li id="home-menu-item"><a href="/profile/${encodeURIComponent(username)}">Profile</a></li>
          `))
        }
      })
      .mapErr(console.log)
  },
  style: () => css`
    #menu-logo {
      text-align: center;
      margin: 10px 0;
    }

    #menu-logo img {
      width: 60px;
    }

    @media (max-width: 768px) {
      .memo-menu {
        margin-top: 20px;
      }
      .memo-menu ul {
        display: flex;
        justify-content: space-evenly;
      }
      .nav-stacked > li + li {
        margin-top: 0px;
        margin-left: 0;
      }
    }
  `
})

Components.UI.Menu = Menu
