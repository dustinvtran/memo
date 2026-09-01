const { getUserName, setBio } = Netlify
const { html, css, raw, escapeHtml } = Utils
const { icon } = Icons
const { el, onClick } = Dom
const { initComponent, setContent } = Components
const { Button, showNotification } = Components.UI
const { errorMessage } = Http

const Biography = (userdata) => initComponent({
  content: ({ include }) => html`
    <h2 id="biography-heading">About ${userdata.username}</h2>
    <div id="biography-content">
      ${/* Markdown, and `raw` is what says so: the sanitiser is the boundary
            here, not the tag function, which cannot tell a heading the author
            wrote from one they were sent. The `escapeHtml` inside it stays —
            that one escapes into markdown *source*, before `marked` reads it,
            which is a different job. */
        raw(DOMPurify.sanitize(
          marked.parse(
            userdata.biography ?? `*${escapeHtml(userdata.username)} has not written anything yet!*`
          )
        ))}
    </div>
    <hr>
  `,
  initializer: () => {
    getUserName()
      .map(({ username }) => {
        if (username === userdata.username) {
          el('#biography-heading')?.insertAdjacentHTML(
            'beforeend',
            String(html` ${icon('edit', { id: 'biography-edit' })}`)
          )
          onClick('#biography-edit', () => {
            setContent('#biography-content', BiographyInput(userdata.biography))
          })
        }
      })
  },
  style: () => css`
    #biography-edit {
      font-size: 14px;
      vertical-align: middle;
      color: #0EA8EB;
      cursor: pointer;
    }
  `
})

Components.Profile.Biography = Biography

///////////////////////////////////////////////////////////////////////////////

const BiographyInput = (currentBio) => initComponent({
  content: ({ include }) => html`
    <textarea id="biography-input">${currentBio ?? ''}</textarea><br>
    ${include(Button({
      label: "Save",
      // TODO: the style is duplicated with add entry button, deduplicate
      className: "td-save-biography-button",
      style: () => css`
        .td-save-biography-button {
          margin: auto;
          margin-top: 10px;
          cursor: pointer;
          padding: 10px 30px;
          background: #0E9CE0;
          border-radius: 7px;
          color: white;
          border: 0;
          font-weight: bold;
          font-size: 17px;
          margin-bottom: 10px;
          display: inline-block;
        }
      `,
      onClick: () => setBio(el('#biography-input').value)
        .map(() => location.reload())
        .mapErr((err) =>
          showNotification(`Error saving biography: ${errorMessage(err)}`)
        )
    }))}
  `,
  style: () => css`
    #biography-input {
      width: 100%;
      min-height: 300px;
    }
  `
})
