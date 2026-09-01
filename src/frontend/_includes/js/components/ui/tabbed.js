const { initComponent, setContent, Div } = Components
const { html, css } = Utils
const { els, onClick } = Dom

/**
 * pages = [
 *   { title: 'Tab title', component: MyComponent() },
 *   { title: 'Another tab title', component: SomethingElse() },
 * ]
 */
const Tabbed = (title, pages) => initComponent({
  content: ({ id, include }) => html`
    <div id="${id}">
      <div style="display: flex; flex-wrap: wrap; justify-content: space-between;">
        <h2 style="margin: unset;">${title}</h2>
        <div class="tab-titles">
          ${include(pages.map(Title))}
        </div>
      </div>
      <div class="tab-contents">
        ${include(pages.map(Content))}
      </div>
    </div>
  `,
  initializer: ({ id }) => {
    els(`#${id} .tab-title`).forEach((tab) => {
      // Looked up per click rather than once, which is what `$(selector)` in
      // the handler was doing and what keeps this working if a page ever
      // redraws its own tab bodies.
      onClick(tab, () => {
        els(`#${id} .tab-title`).forEach((other) => other.classList.remove('tab-active'))
        tab.classList.add('tab-active')

        const contents = els(`#${id} .tab-contents > *`)
        contents.forEach((content) => content.classList.add('tab-hidden'))
        // `dataset` is strings and this one indexes an array. jQuery's
        // `.data()` read `data-index="2"` back as the number 2 — the one
        // conversion of its that is missed here rather than gladly lost.
        contents[Number(tab.dataset.index)]?.classList.remove('tab-hidden')
      })
    })
  },
  style: () => css`
    .tab-title {
      cursor: pointer;
      padding: 8px 20px;
      font-size: 13px;
      background: #ddd;
      border-radius: 8px;
      display: inline-block;
      color: #aaa;
      font-weight: bold;
    }
    .tab-title.tab-active {
      color: white;
      background: #0E9CE0;
    }
    .tab-content * {
      position: relative;
      left: unset;
    }
    .tab-content.tab-hidden {
      display: none;
    }
  `
})

Components.UI.Tabbed = Tabbed

///////////////////////////////////////////////////////////////////////////////

const Title = ({ title }, index) => initComponent({
  content: () => html`
    <div
      class="tab-title ${index === 0 ? 'tab-active' : ''}"
      data-index="${index}"
    >
      ${title}
    </div>
  `
})

const Content = ({ component }, index) => initComponent({
  content: ({ include }) => html`
    <div
      class="tab-content ${index === 0 ? '' : 'tab-hidden'}"
      data-index="${index}"
    >
      ${include(component)}
    </div>
  `
})
