const { html, css, dateOnly, dateTime, timeAgo } = Utils
const { el, on, delegateClick } = Dom
const { initComponent } = Components
const { showNotification } = Components.UI
const { isLoggedIn, getUserName, getApiTokens, createApiToken, revokeApiToken } = Netlify
const { errorMessage } = Http
const { LIFETIMES, lifetimeOf, whyNotATokenName, isExpired, forDisplay } = ApiTokens

/**
 * The owner's personal API tokens: each one's name and dates, a revoke button,
 * and a form that mints a new one. #502.
 *
 * Drawn only for the profile's owner, by the same test the biography's edit
 * pencil makes, and until that answers the section is an empty `hidden`
 * element — so a reader who is not the owner is never sent the markup, let
 * alone the list. Hiding it is not the boundary: every tokens route refuses
 * anything but the owner's own session.
 *
 * A new token is shown once, in a box under the form, and nowhere else. It is
 * never written to storage, the url or the list, and a reload loses it — which
 * is the point, and what the note beside it says. The list is refreshed in
 * place after a mint or a revoke rather than by `location.reload()`, which
 * would take the new token off the page before it could be copied.
 */
const ApiTokensSection = (userdata) => initComponent({
  content: () => html`
    <section id="api-tokens" aria-labelledby="api-tokens-heading" hidden></section>
  `,
  initializer: () => {
    // Asking who this is can only answer 401 without a session; #397.
    if (!isLoggedIn()) return

    getUserName()
      .map(({ username }) => {
        const section = el('#api-tokens')
        if (!section || username !== userdata.username) return
        section.innerHTML = String(Skeleton())
        section.hidden = false
        bindForm()
        bindRevoke()
        refreshList()
      })
  },
  style: () => css`
    #api-tokens table {
      width: 100%;
      border-collapse: collapse;
      margin-bottom: 20px;
    }
    #api-tokens th,
    #api-tokens td {
      text-align: left;
      padding: 6px 8px;
      border-bottom: 1px solid #ddd;
      vertical-align: middle;
    }
    #api-tokens .api-token-expired td {
      color: #888;
    }
    #api-tokens .api-token-expired-label {
      color: #b3261e;
      font-weight: bold;
    }
    #api-token-form label {
      display: inline-block;
      margin: 0 12px 8px 0;
    }
    #api-token-reveal {
      border: 2px solid #0E9CE0;
      border-radius: 7px;
      padding: 10px 15px;
      margin: 10px 0 20px;
    }
    #api-token-value {
      width: 100%;
      max-width: 520px;
      font-family: monospace;
    }
  `
})

Components.Profile.ApiTokensSection = ApiTokensSection

///////////////////////////////////////////////////////////////////////////////

const Skeleton = () => html`
  <hr>
  <h2 id="api-tokens-heading">API tokens</h2>
  <p>
    A token lets a script or an agent write to your lists as you, sent as
    <code>Authorization: Bearer memo_pat_…</code>. Only you can see this
    section. Tokens keep working after <em>Log out everywhere</em>; revoke one
    here to stop it.
  </p>
  <div id="api-tokens-list" aria-live="polite">Loading your tokens…</div>
  <form id="api-token-form">
    <h3>New token</h3>
    <label>Name <input id="api-token-name" type="text" autocomplete="off"></label>
    <label>Expires
      <select id="api-token-lifetime">
        ${LIFETIMES.map(({ value, label }) => html`<option value="${value}">${label}</option>`)}
      </select>
    </label>
    <button type="submit" id="api-token-create">Create token</button>
  </form>
  <div id="api-token-reveal" aria-live="polite" hidden></div>
`

const TokenList = (tokens, now) => tokens.length === 0
  ? html`<p>You have no API tokens.</p>`
  : html`
    <table>
      <thead>
        <tr><th>Name</th><th>Created</th><th>Expires</th><th>Last used</th><th></th></tr>
      </thead>
      <tbody>
        ${forDisplay(tokens, now).map((token) => TokenRow(token, now))}
      </tbody>
    </table>
  `

/**
 * `expiresAt` is `null` both for a token made to last and for one minted
 * before the field existed, and the API does not tell the two apart, so
 * neither does this. `lastUsedAt` is good to within an hour, which `timeAgo`
 * is coarser than anyway.
 */
const TokenRow = ({ id, name, createdAt, expiresAt, lastUsedAt }, now) => {
  const expired = isExpired({ expiresAt }, now)
  return html`
    <tr class="${expired ? 'api-token-expired' : ''}">
      <td>${name}</td>
      <td title="${dateTime(createdAt)}">${dateOnly(createdAt)}</td>
      <td>${
        expiresAt === null ? 'Never'
        : expired ? html`<span class="api-token-expired-label">Expired</span> ${dateOnly(expiresAt)}`
        : dateOnly(expiresAt)
      }</td>
      ${lastUsedAt === null
        ? html`<td>Never</td>`
        : html`<td title="${dateTime(lastUsedAt)}">${timeAgo(lastUsedAt, now)}</td>`}
      <td>
        <button type="button" class="api-token-revoke" data-token-id="${id}" data-token-name="${name}">Revoke</button>
      </td>
    </tr>
  `
}

const Reveal = ({ name, token }) => html`
  <p>
    <strong>Your new token, ${name}.</strong> Copy it now: this is the only
    time it will be shown, and it cannot be shown again — only a hash of it is
    kept. If you lose it, revoke it and create another.
  </p>
  <p>
    <input id="api-token-value" type="text" readonly value="${token}" aria-label="Your new API token">
    <button type="button" id="api-token-copy">Copy</button>
  </p>
  <button type="button" id="api-token-dismiss">I have copied it</button>
`

const refreshList = () =>
  getApiTokens()
    .map((tokens) => {
      const list = el('#api-tokens-list')
      if (list) list.innerHTML = String(TokenList(tokens, Date.now()))
    })
    .mapErr((err) => {
      const list = el('#api-tokens-list')
      if (list) list.innerHTML = String(html`<p>Could not load your tokens: ${errorMessage(err)}</p>`)
    })

const bindForm = () => {
  on('#api-token-form', 'submit', (event) => {
    event.preventDefault()
    const name = el('#api-token-name')?.value ?? ''
    const problem = whyNotATokenName(name)
    if (problem) {
      showNotification(problem)
      return
    }

    // Held down until the answer is in, so a double click does not mint two.
    const button = el('#api-token-create')
    if (button) button.disabled = true
    createApiToken(name.trim(), lifetimeOf(el('#api-token-lifetime')?.value))
      .map((created) => {
        el('#api-token-form')?.reset()
        showReveal(created)
        refreshList()
      })
      .mapErr((err) => showNotification(`Could not create the token: ${errorMessage(err)}`))
      .then(() => { if (button) button.disabled = false })
  })
}

const showReveal = (created) => {
  const reveal = el('#api-token-reveal')
  if (!reveal) return
  reveal.innerHTML = String(Reveal(created))
  reveal.hidden = false
  el('#api-token-value')?.select()

  on('#api-token-copy', 'click', () => {
    const value = el('#api-token-value')?.value ?? ''
    // The clipboard needs a secure context, which localhost is; where it is
    // missing the box is selected and the reader copies it by hand.
    Promise.resolve(navigator.clipboard?.writeText(value))
      .then(() => showNotification('Copied.'))
      .catch(() => {
        el('#api-token-value')?.select()
        showNotification('Could not copy — select the token and copy it yourself.')
      })
  })

  // Emptied rather than hidden, so the token does not sit in the document for
  // the rest of the page view.
  on('#api-token-dismiss', 'click', () => {
    reveal.innerHTML = ''
    reveal.hidden = true
  })
}

/* Delegated, because the rows are redrawn after every change and a listener
   bound to one would be lost with it. Named, so a second profile render on
   the same document replaces this one rather than adding to it. */
const bindRevoke = () => {
  delegateClick('api-token-revoke', '.api-token-revoke', (button) => {
    const { tokenId, tokenName } = button.dataset
    if (!window.confirm(`Revoke ${tokenName}? Anything using it stops working at once, and it cannot be undone.`)) return
    button.disabled = true
    revokeApiToken(tokenId)
      .map(() => {
        showNotification(`Revoked ${tokenName}.`)
        refreshList()
      })
      .mapErr((err) => {
        button.disabled = false
        showNotification(`Could not revoke ${tokenName}: ${errorMessage(err)}`)
      })
  })
}
