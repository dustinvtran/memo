const { html, css, toSafeUrl } = Utils
const { onClick } = Dom
const { initComponent, setContent, WithRemoteData } = Components
const { retrieveWork } = Netlify
const { EntryForm } = Components.List

/**
 * `onPick` is what a result does when it is clicked, and it has two callers.
 * The add flow leaves it out and gets the original behaviour: replace the
 * results with a form for the work just chosen. The link flow (#343) passes
 * its own, because there is already a form on screen with a half-filled entry
 * in it and the work is being attached to that rather than starting a new one.
 * @type {(type: string, results: any[], onPick?: (result: any) => void) => object}
 */
const SearchResults = (type, results, onPick) => initComponent({
  content: ({ include }) => html`
    <div id="search-results">
      ${results.length > 0
        ? include(results.map((r) => Result(type, r, onPick)))
        : html`<i>No results found for this query...</i>`
      }
    </div>
  `
})

Components.List.SearchResults = SearchResults

///////////////////////////////////////////////////////////////////////////////

/**
 * One candidate from the API's search.
 *
 * The cover's `alt` is empty for the same reason as the list row's in
 * `utils/columns.js` (#399): the title and year sit next to it, so a
 * described cover would be read out twice, and an undescribed one is read
 * out as its url.
 */
const Result = (type, { title, year, imageUrl, ref }, onPick) => initComponent({
  content: ({ id }) => html`
    <div id="${id}" class="search-result">
      <div class="search-result-img"><img src="${toSafeUrl(imageUrl) || '/img/mawaru.png'}" alt=""></div>
      <div class="search-result-title">${title}${year ? ' (' + year + ')' : ''}</div>
    </div>
  `,
  style: () => css`
    .search-result {
      cursor: pointer;
      display: flex;
      align-items: center;
      margin: 4px 0;
      padding: 4px;
    }
    .search-result-img {
      width: 25px;
      height: 35px;
    }
    .search-result-img img {
      object-fit: cover;
      width: 25px;
      height: 35px;
      border-radius: 5px;
    }
    .search-result-title {
      margin-left: 7px;
    }
    .search-result:nth-child(odd) {
      background: #efefef;
      border-radius: 5px;
    }
  `,
  initializer: ({ id }) => {
    onClick(`#${id}`, () => {
      if (onPick) return onPick({ title, year, imageUrl, ref })

      setContent('#search-results', WithRemoteData({
        remoteData: retrieveWork(type, ref),
        component: (data) => EntryForm(type, { commonMetadata: data })
      }))
    })
  }
})
