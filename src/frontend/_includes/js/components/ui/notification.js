const { html, css } = Utils
const { onClick, fadeIn } = Dom
const { initComponent, appendContent } = Components

const Notification = (message) => initComponent({
  content: ({ id }) => html`
    <div id="${id}" class="notification" style="display: none;">
      ${message}
    </div>
  `,
  initializer: ({ id }) => {
    onClick(`#${id}`, () => document.getElementById(id)?.remove())
  },
  style: () => css`
    /* The notification is hidden by the inline display:none in the markup
       above rather than by a rule here, so that fadeIn can take that one
       declaration off and let this block decide what the element is instead.
       A rule saying none is a rule nothing inline can undo without naming a
       display of its own. */
    .notification {
      cursor: pointer;
      position: fixed;
      top: 20px;
      left: 50%;
      background: white;
      border-radius: 5px;
      z-index: 9999999999999999999999999;
      transform: translateX(-50%);
      width: 90vw;
      max-width: 600px;
      padding: 15px 30px;
      box-shadow: 1px 1px 5px rgba(0,0,0,.4);
    }
  `
})

const showNotification = (message, style) => {
  const id = appendContent('body', Notification(message, style))
  const notif = document.getElementById(id)
  fadeIn(notif, 100)
  setTimeout(() => {
    notif?.remove()
  }, 5000)
}

Components.UI.showNotification = showNotification
