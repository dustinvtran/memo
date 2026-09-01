const { html } = Utils
const { initComponent } = Components
const { Menu } = Components.UI

const Base = (title, content) => initComponent({
  content: ({ include }) => html`
    <div class="page">
      <div class="page-body page-columns">
        ${include(Menu())}
        <div class="page-main">
          <div class="full-bleed"> <h1>${title}</h1> </div>
          <hr>
          <div id="content">
            ${include(content)}
          </div>
          <hr>
        </div>
      </div>
    </div>
  `
})

Components.UI.Base = Base
