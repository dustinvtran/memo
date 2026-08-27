const { html, css, toSafeUrl } = Utils
const { initComponent, setContent, WithRemoteData } = Components
const { retrieveWork } = Netlify
const { EntryForm } = Components.List

const SearchResults = (type, results) => initComponent({
  content: ({ include }) => html`
    <div id="search-results">
      ${results.length > 0
        ? include(results.map((r) => Result(type, r)))
        : html`<i>No results found for this query...</i>`
      }
    </div>
  `
})

Components.List.SearchResults = SearchResults

///////////////////////////////////////////////////////////////////////////////

const Result = (type, { title, year, imageUrl, ref }) => initComponent({
  content: ({ id }) => html`
    <div id="${id}" class="search-result">
      <div class="search-result-img"><img src="${toSafeUrl(imageUrl) || '/img/mawaru.png'}"></div>
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
    $(`#${id}`).click(() => {
      setContent('#search-results', WithRemoteData({
        remoteData: retrieveWork(type, ref),
        component: (data) => EntryForm(type, { commonMetadata: data })
      }))
    })
  }
})
