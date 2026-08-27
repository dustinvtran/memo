const { initComponent } = Components
const { html, css } = Utils

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
    // `String` on both of these: jQuery's `.after()` takes a string of markup
    // or a node, and markup is neither of those until it is asked for.
    const menuAuthLink = isLoggedIn
      ? html`<a href="/.netlify/functions/auth/logout">Log out</a>`
      : html`<a href="/.netlify/functions/auth/login">Log in</a>`
    $('#home-menu-item').after(String(html`<li>${menuAuthLink}</li>`))

    Netlify.getUserName()
      .map(({ username }) => {
        if (username) {
          $('#home-menu-item').after(String(html`
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
