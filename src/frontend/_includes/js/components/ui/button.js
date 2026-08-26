const { html, css } = Utils
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
    $(`#${id}`).off('click', '**')
    $(`#${id}`).click(() => {
      // Disable button for a second to prevent accidental multiclicks
      $(`#${id}`).prop('disabled',true)
        setTimeout(() => {
          $(`#${id}`).prop('disabled',false)
      }, 1000)

      // Run onSubmit callback with the input value(s) (if any)
      if (relatedInputIdOrIds) {
        const value = isArray(relatedInputIdOrIds)
          ? relatedInputIdOrIds.map(({ name, inputId }) => ({
            [name]: $(`#${inputId}`).val()
          }))
          : $(`#${relatedInputIdOrIds}`).val()
        onClick(value)
      } else {
        onClick()
      }
    })

    // Trigger onclick onenter too if a related input Id is provided
    if (relatedInputIdOrIds) {
      if (isArray(relatedInputIdOrIds)) {
        relatedInputIdOrIds.forEach(({ inputId }) => {
          $(`#${inputId}`).keypress(triggerClick(id))
        })
      } else {
        $(`#${relatedInputIdOrIds}`).keypress(triggerClick(id))
      }
    }
  }
})

Components.UI.Button = Button

///////////////////////////////////////////////////////////////////////////////

const ENTER_KEY_CODE = 13

const triggerClick = (btnId) => ({ which }) => {
  if (which == ENTER_KEY_CODE) {
    $(`#${btnId}`).trigger('click')
    return false
  }
}
