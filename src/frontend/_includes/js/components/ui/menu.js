const { initComponent } = Components
const { html, css } = Utils
const { el } = Dom

const Menu = () => initComponent({
  content: ({ include }) => html`
    <div
      class="page-menu memo-menu"
      id="sidebar"
      role="navigation"
    >
      <div id="menu-logo">
        <img src="/img/memo_logo.png">
      </div>
      <hr>
      <ul class="memo-menu-links">
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

    /* Bootstrap's nav, nav-pills and nav-stacked drew these until #269 step
       6, and it is three rules rather than three class names: a list with no
       bullets, a link that fills its row, and a rounded grey highlight under
       the one the pointer is on. */
    .memo-menu-links {
      padding-left: 0;
      margin-bottom: 0;
      list-style: none;
    }

    .memo-menu-links > li + li {
      margin-top: 2px;
    }

    .memo-menu-links > li > a {
      display: block;
      padding: 10px 15px;
      border-radius: 4px;
    }

    .memo-menu-links > li > a:hover,
    .memo-menu-links > li > a:focus {
      text-decoration: none;
      background: #eee;
    }

    @media (max-width: 768px) {
      .memo-menu {
        margin-top: 20px;
      }
      .memo-menu-links {
        display: flex;
        justify-content: space-evenly;
      }
      .memo-menu-links > li + li {
        margin-top: 0;
      }
    }
  `
})

Components.UI.Menu = Menu
