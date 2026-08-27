const { initComponent } = Components
const { html, raw } = Utils

const Error404 = () => initComponent({
  content: () => html`Page not found`
})

const Redirect = (url) => initComponent({
  content: () => html``,
  initializer: () => {
    window.location.href = url
  }
})

const Nothing = () => initComponent({ content: () => html`` })

/**
 * A component wrapping something already drawn — or, far more often, a line of
 * text. `html` rather than the value itself, so that the text is text: every
 * caller today is `RemoteFailure`, handing over whatever the API said went
 * wrong.
 */
const Div = (content) => initComponent({ content: () => html`${content}` })

/**
 * One of the three places markup legitimately comes from somewhere other than
 * a template here, and the one that matters: this is another user's note, and
 * `DOMPurify` is the only thing between it and the reader's session. `raw`
 * says that out loud rather than leaving it to a tag function that cannot
 * tell the difference.
 */
const Markdown = (mdText) => initComponent({
  content: () => raw(DOMPurify.sanitize(marked.parse(mdText)))
})


Components.Error404 = Error404
Components.Redirect = Redirect
Components.Nothing = Nothing
Components.Div = Div
Components.Markdown = Markdown
