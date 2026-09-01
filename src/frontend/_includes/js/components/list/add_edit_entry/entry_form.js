/**
 * This file is fairly large, should probably be
 * refactored into multiple files?
 */
const { html, css, waitForEl } = Utils
const { els, on } = Dom
const { initComponent } = Components
const { SubmitButton, DeleteButton, ExternalFields, PersonalFields, CoverColumn, DraftNotice, EntryHistory } = Components.List

const EntryForm = (type, data) => {
  const isEdit = data?.status ?? false
  return initComponent({
    content: ({ include }) => html`
      ${isEdit ? include(DraftNotice(type, data)) : ''}
      <div id="submit-button-add-entry-wrapper">
        ${include(SubmitButton(type, data, isEdit))}
        ${isEdit ? include(DeleteButton(type, data)) : ''}
      </div>
      <div id="add-entry-fields">
        ${include([
          ExternalFields(data ?? {}, type),
          PersonalFields(data ?? {}, type),
          CoverColumn(data),
        ])}
      </div>
      ${isEdit ? include(EntryHistory(type, data)) : ''}
    `,
    style: () => css`
      #add-entry-fields {
        display: flex;
        flex-wrap: wrap;
        justify-content: space-between;
      }
      #submit-button-add-entry-wrapper {
        text-align: center;
      }
    `,
    initializer: () => {
      window.hasUnsavedChange = false
      const markUnsavedChange = () => {
        window.hasUnsavedChange = true
      }
      els('#add-entry-fields input').forEach((input) =>
        on(input, 'input', markUnsavedChange)
      )
      els('#add-entry-fields select').forEach((select) =>
        on(select, 'change', markUnsavedChange)
      )
      // The comments field arrives with a request of its own, so it is not
      // there when the rest of the form is.
      waitForEl('#add-entry-fields textarea').then(() => {
        els('#add-entry-fields textarea').forEach((area) =>
          on(area, 'input', markUnsavedChange)
        )
      })
    }
  })
}

Components.List.EntryForm = EntryForm
