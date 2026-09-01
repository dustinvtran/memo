const { html, css } = Utils
// `on` rather than `Dom.onClick`, which would shadow this component's own
// `onClick` prop.
const { on } = Dom
const { initComponent } = Components
const { isArray } = Array

/**
 * You can pass a single input ID or an array of { name, inputId }
 *
 * A caller that wants the button styled passes a `className` to hang the rule
 * on and a `style` that names it. It used to pass a `style` taking the
 * instance `id`, which gave every button its own copy of a rule the next
 * button could not reuse — appended again per construction, and buttons are
 * constructed on every render of a form.
 */
const Button = ({ className, style, label, relatedInputIdOrIds, onClick }) => initComponent({
  content: ({ id }) => html`
    <button id="${id}" class="${className ?? ''}">${label ?? "Submit"}</button>
  `,
  style,
  initializer: ({ id }) => {
    // The `.off('click', '**')` that used to open this went with jQuery, and
    // nothing replaces it: it removed *delegated* handlers, of which a button
    // has none, and the button is a new element under a new instance id on
    // every render anyway.
    const button = document.getElementById(id)

    on(button, 'click', () => {
      // Disable button for a second to prevent accidental multiclicks
      button.disabled = true
      setTimeout(() => {
        button.disabled = false
      }, 1000)

      // Run onSubmit callback with the input value(s) (if any)
      if (relatedInputIdOrIds) {
        const value = isArray(relatedInputIdOrIds)
          ? relatedInputIdOrIds.map(({ name, inputId }) => ({
            [name]: valueOf(inputId)
          }))
          : valueOf(relatedInputIdOrIds)
        onClick(value)
      } else {
        onClick()
      }
    })

    // Trigger onclick onenter too if a related input Id is provided
    if (relatedInputIdOrIds) {
      const inputIds = isArray(relatedInputIdOrIds)
        ? relatedInputIdOrIds.map(({ inputId }) => inputId)
        : [relatedInputIdOrIds]

      inputIds.forEach((inputId) => {
        on(document.getElementById(inputId), 'keydown', clickOnEnter(id))
      })
    }
  }
})

Components.UI.Button = Button

///////////////////////////////////////////////////////////////////////////////

const valueOf = (inputId) => document.getElementById(inputId)?.value

/**
 * `keydown` and `event.key`, where this was `keypress` and `which`: the event
 * has been deprecated for years and the property with it, and Enter is one of
 * the few keys both still reported. `preventDefault` is the half of jQuery's
 * `return false` that did anything here — there is no form around these inputs
 * for the keypress to submit, but a caller adding one should not find that out
 * as a page reload.
 */
const clickOnEnter = (btnId) => (event) => {
  if (event.key !== 'Enter') return
  event.preventDefault()
  document.getElementById(btnId)?.click()
}
