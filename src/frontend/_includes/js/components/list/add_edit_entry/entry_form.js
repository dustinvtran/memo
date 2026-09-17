/**
 * This file is fairly large, should probably be
 * refactored into multiple files?
 */
const { html, css, waitForEl } = Utils
const { els, on } = Dom
const { initComponent } = Components
const { SubmitButton, DeleteButton, ExternalFields, PersonalFields, CoverColumn, DraftNotice, EntryHistory, LinkToWork } = Components.List

const EntryForm = (type, data) => {
  const isEdit = data?.status ?? false
  // An entry being edited that points at no work. Not a fault: an entry is
  // written that way on purpose when the databases do not have the thing yet,
  // and this is the offer to attach it once they do. #343.
  const isUnlinked = isEdit && !data?.commonMetadata?.internalRef
  return initComponent({
    content: ({ include }) => html`
      ${isEdit ? include(DraftNotice(type, data)) : ''}
      ${isUnlinked ? include(LinkToWork(type, data)) : ''}
      <div id="submit-button-add-entry-wrapper">
        ${include(SubmitButton(type, data, isEdit))}
        ${isEdit ? include(DeleteButton(type, data)) : ''}
      </div>
      <div id="add-entry-fields">
        <div id="external-fields-slot">${include(ExternalFields(data ?? {}, type))}</div>
        ${include([
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
