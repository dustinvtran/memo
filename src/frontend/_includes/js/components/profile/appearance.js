const { html, css } = Utils
const { el, on } = Dom
const { initComponent } = Components
const { isLoggedIn, getUserName } = Netlify
const { CHOICES, read, choose } = Theme

/**
 * The owner's choice of colour scheme: System, Light or Dark. #523.
 *
 * It sits with the API tokens because that is where a person's own settings
 * are, and like them it is drawn only for the profile's owner, by the same
 * test. The reason is not secrecy — nothing here is anyone else's business to
 * see or change — but that a radio group on somebody else's profile reads as
 * a setting of theirs.
 *
 * What it changes is this browser, not the account; `js/theme.js` says why.
 * It applies as soon as a choice is clicked, without a save button and
 * without a reload: the choice is one attribute on <html> and every colour
 * on the page follows it.
 */
const AppearanceSection = (userdata) => initComponent({
  content: () => html`
    <section id="appearance" aria-labelledby="appearance-heading" hidden></section>
  `,
  initializer: () => {
    // Asking who this is can only answer 401 without a session; #397.
    if (!isLoggedIn()) return

    getUserName()
      .map(({ username }) => {
        const section = el('#appearance')
        if (!section || username !== userdata.username) return
        section.innerHTML = String(Settings(read()))
        section.hidden = false
        on('#appearance-theme', 'change', (event) => {
          if (event.target.name === 'appearance-theme') choose(event.target.value)
        })
      })
  },
  style: () => css`
    #appearance-theme {
      border: 0;
      margin: 0 0 10px;
      padding: 0;
    }
    #appearance-theme legend {
      font-weight: 700;
      margin-bottom: 5px;
      padding: 0;
    }
    #appearance-theme label {
      font-weight: normal;
      margin-right: 16px;
      cursor: pointer;
    }
    #appearance-theme input {
      margin: 0 5px 0 0;
      vertical-align: -2px;
      box-shadow: none;
    }
  `
})

Components.Profile.AppearanceSection = AppearanceSection

///////////////////////////////////////////////////////////////////////////////

const Settings = (current) => html`
  <hr>
  <h2 id="appearance-heading">Appearance</h2>
  <fieldset id="appearance-theme">
    <legend>Theme</legend>
    ${CHOICES.map(({ value, label }) => html`
      <label>
        <input type="radio" name="appearance-theme" value="${value}" ${value === current ? 'checked' : ''}>${label}
      </label>
    `)}
  </fieldset>
  <p>
    System follows your device's light or dark setting. The choice is kept by
    this browser rather than your account, so another device keeps its own.
  </p>
`
