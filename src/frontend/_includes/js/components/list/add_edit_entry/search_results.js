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
 *
 * `listing` is what `/api/works/search` answers with: `{ results }`, and from a
 * books search a `discarded` count beside them. A search for an older book can
 * find several editions and offer none of them, because a book is filed under
 * its ISBN and Google holds plenty of volumes without one — anything printed
 * before about 1970, and anything scanned rather than supplied by a publisher.
 * Those rows are still not shown, since there is no ref to fetch them by; what
 * is shown is that they were there, so that a search answering with four
 * editions is not mistaken for a search that found four. #387.
 * @type {(type: string, listing: any, onPick?: (result: any) => void) => object}
 */
const SearchResults = (type, listing, onPick) => initComponent({
  content: ({ include }) => {
    const results = listing?.results ?? []
    const noRef = listing?.discarded?.noRef ?? 0

    return html`
      <div id="search-results">
        ${results.length > 0
          ? include(results.map((r) => Result(type, r, onPick)))
          : noRef > 0 ? '' : html`<i>No results found for this query...</i>`
        }
        ${noRef > 0
          ? html`<p class="search-results-discarded">${discardedNote(noRef, results.length)}</p>`
          : ''
        }
      </div>
    `
  },
  style: () => css`
    .search-results-discarded {
      font-size: 12px;
      color: #666;
      margin: 8px 0 0;
    }
  `
})

Components.List.SearchResults = SearchResults

///////////////////////////////////////////////////////////////////////////////

/**
 * What the count says, which depends on whether anything was offered at all:
 * "three more" under a list of four reads as a list that is short, and the
 * same sentence under nothing at all has to say why there is nothing rather
 * than leave "no results found" standing — the search did find them.
 * @type {(count: number, shown: number) => string}
 */
const discardedNote = (count, shown) => {
  const noId = `no id to look ${count === 1 ? 'it' : 'them'} up by (for a book, no ISBN)`

  return shown > 0
    ? `${count} more ${count === 1 ? 'was' : 'were'} found with ${noId}, so ${
        count === 1 ? 'it is' : 'they are'} not shown.`
    : `Nothing here can be added: the search found ${count} ${
        count === 1 ? 'edition' : 'editions'} with ${noId}.`
}

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
