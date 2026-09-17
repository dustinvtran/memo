const { html, css } = Utils
const { initComponent } = Components
const { Button } = Components.UI

/**
 * `defaultValue` is for a search whose query is already known — linking an
 * entry to a work starts from the title on the entry, so typing it again is
 * work the form can do. The add flow passes nothing and starts empty, which
 * is right there: nothing has been named yet.
 */
const InputWithAction = ({ label, btnLabel, onSubmit, style, defaultValue }) => initComponent({
  content: ({ id, include }) => html`
    <label for="${id}-input">${label ?? ""}</label><br>
    <input type="text" id="${id}-input" value="${defaultValue ?? ''}">
    ${include(Button({
      relatedInputIdOrIds: `${id}-input`,
      label: btnLabel,
      onClick: onSubmit
    }))}
  `,
  style: () => css`
    ${style ?? ''}
  `
})

const TextInput = ({ label, id, defaultValue, type }) => initComponent({
  content: () => html`
    <div>
      <label for="${id}">${label}</label><br>
      <input type="${type ?? 'text'}" id="${id}" value="${defaultValue ?? ''}">
    </div>
  `
})

Components.UI.InputWithAction = InputWithAction
Components.UI.TextInput = TextInput
