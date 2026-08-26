const { html, css } = Utils
const { initComponent, appendContent } = Components

const Modal = ({ title, content, openButtonHtml, showCloseConfirmationDialog }) => initComponent({
  content: ({ id, include }) => html`
    <div id="${id}">${openButtonHtml({ include, id })}</div>
  `,
  initializer: ({ id }) => {
    $(`#${id}`).click(() => {
      appendContent('body', Modal_({ title, content, showCloseConfirmationDialog }))
    })
  }
})

const log = x => (console.log(x), x)

const Modal_ = ({ title, content, showCloseConfirmationDialog }) => initComponent({
  content: ({ id, include }) => html`
    <div id=${id}>
      ${include(Overlay(id, showCloseConfirmationDialog))}
      <div id="td-modal-window-${id}" class="td-modal-window">
        ${include(ModalHeader(title, id, showCloseConfirmationDialog))}
        <div id="td-modal-content-wrapper-${id}" class="td-modal-content-wrapper">
          <div class="td-modal-content">
            ${include(content)}
          </div>
        </div>
      </div>
    </div>
  `,
  style: () => css`
    .td-modal-window {
      //display: none;
      position: fixed;
      box-shadow: 1px 1px 10px rgba(0,0,0,.4);
      top: 50%;
      left: 50%;
      z-index: 99;
      padding: 50px;
      transform: translate(-50%, -50%);
      overflow: hidden;
      background: #fff;
      border-radius: 5px;
      width: min(90%, 1100px);
      height:min(90%, 900px);
    }
    .td-modal-content-wrapper {
      margin-top: 30px;
      height: calc(100% - 60px);
      overflow: auto;
    }
    .td-modal-content {
      width: calc(100% - 30px);
      position: relative;
      left: 15px;
    }
    .td-modal-content-wrapper::-webkit-scrollbar-track
    {
      background-color: white;
    }
    .td-modal-content-wrapper::-webkit-scrollbar
    {
      width: 7px;
      background-color: #F5F5F5;
    }
    .td-modal-content-wrapper::-webkit-scrollbar-thumb
    {
      background-color: #E5E5E5;
      border-radius: 3px;
    }
  `,
})

Components.UI.Modal = Modal
Components.UI.Modal_ = Modal_

////////////////////////////////////////////////////////////////////////////////

const ModalHeader = (title, parentId, showCloseConfirmationDialog) => initComponent({
  content: ({ include }) => html`
    <div class="td-modal-header modal-header">
      <div class="td-modal-title">${title}</div>
      ${include(CloseButton(parentId, showCloseConfirmationDialog))}
    </div>
  `,
  style: () => css`
    .td-modal-title {
      position: absolute;
      top: 27px;
      left: 60px;
      font-size: 27px;
    }
  `
})

// The rule names the class and the element keeps the id: the id is how the
// click handler and `closeModal` find this overlay, but nothing about the rule
// is per-instance, and scoping it by id meant every modal opened appended a
// block that no later modal could match and `closeModal` did not remove.
const Overlay = (parentId, showCloseConfirmationDialog) => initComponent({
  content: () => html`
    <div id="overlay-${parentId}" class="td-modal-overlay"></div>
  `,
  style: () => css`
    .td-modal-overlay {
      //display: none;
      position: fixed;
      top: 0;
      left: 0;
      background: black;
      opacity: .2;
      z-index: 98;
      width: 100vw;
      height: 100vh;
    }
  `,
  initializer: () => {
    $(`#overlay-${parentId}`).click(() => {
      closeModal(parentId, showCloseConfirmationDialog)
    })
  }
})

const CloseButton = (parentId, showCloseConfirmationDialog) => initComponent({
  content: () => html`
    <div id="cancel-button-${parentId}" class="cancel-button"><i class="fas fa-window-close"></i></div>
  `,
  style: () => `
    .cancel-button {
      cursor: pointer;
      color: #0E9CE0;
      font-weight: bold;
      font-size: 40px;
      position: absolute;
      top: 18px;
      right: 60px;
      
    }
  `,
  initializer: () => {
    $(`#cancel-button-${parentId}`).click(() => {
      closeModal(parentId, showCloseConfirmationDialog)
    })
  }
})

const closeModal = (parentId, showCloseConfirmationDialog) => {
  if (
    (!showCloseConfirmationDialog?.() ?? true) ||
    (confirm('Are you sure you want to close me? Your changes will not be saved.') == true)
  ) {
    $(`#td-modal-window-${parentId}`).fadeOut(200)
    $(`#overlay-${parentId}`).hide()
    $(`#${parentId}`).remove()
  }
}
