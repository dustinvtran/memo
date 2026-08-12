/**
 * This file is fairly large, should probably be
 * refactored into multiple files?
 */
const { html, css, waitForEl } = Utils
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
      $(`#add-entry-fields input`).on('input', markUnsavedChange)
      $(`#add-entry-fields select`).on('change', markUnsavedChange)
      waitForEl(`#add-entry-fields textarea`).then(() => {
        $(`#add-entry-fields textarea`).on('input', markUnsavedChange)
      })
    }
  })
}

Components.List.EntryForm = EntryForm
