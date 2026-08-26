const { html, escapeHtml, toSafeUrl } = Utils

const initTable = (selector, data, settings) =>
  $(selector).bootstrapTable({ ...settings, data })

const profileColumns = (status) => [
  Columns.englishTitleAndLastUpdated(),
  Columns.profileScores(status),
  Columns.year()
]

const entryTypeToFullColumns = (entryType, status) => ({
  films: [
    Columns.index(),
    Columns.title(),
    Columns.score(status),
    Columns.year(),
    Columns.duration(),
    Columns.directors(),
    Columns.actors(),
    Columns.date('Completed Date', 'completedDate'),
  ],
  tv: [
    Columns.index(),
    Columns.title(),
    Columns.score(status),
    Columns.year(),
    Columns.progress(),
    Columns.duration(),
    Columns.directors(),
    Columns.actors(),
    Columns.date('Started Date', 'startedDate'),
    Columns.date('Completed Date', 'completedDate'),
  ],
  games: [
    Columns.index(),
    Columns.title(),
    Columns.score(status),
    Columns.year(),
    Columns.playtime(status),
    Columns.platforms(),
    Columns.studios(),
    Columns.publishers(),
    Columns.date('Started Date', 'startedDate'),
    Columns.date('Completed Date', 'completedDate'),
  ],
  books: [
    Columns.index(),
    Columns.title(),
    Columns.score(status),
    Columns.year(),
    Columns.pages(),
    Columns.authors(),
    Columns.publishers(),
    Columns.date('Started Date', 'startedDate'),
    Columns.date('Completed Date', 'completedDate'),
  ],
}[entryType])

window.includeReview = (type, entryId) => {
  Components.setContent(`#review-${entryId}`, Components.WithRemoteData({
    remoteData: Netlify.getReview(type, entryId),
    component: (review) => Components.Markdown(review?.data?.text || '*None yet...*'),
  }))
}

const detailFormatter = (_, row) => {
  const anchorId = `entry-${row.dbRef}`
  // Same treatment as the cover in `titleFormatter`: the url is metadata, so
  // its scheme is checked before it is allowed near a `src` and it is escaped
  // before it is allowed near an attribute.
  const coverUrl = toSafeUrl(row.commonMetadata.imageUrl)
  const cover =
    coverUrl
      ? `<img src="${escapeHtml(coverUrl)}" class="review-cover" style="float:right;">`
      : ''

  const type = Conversions.apiTypeToType[row.commonMetadata.entryType]

  const scriptTag = (content) => '<scr' + 'ipt>' + content + '</scr'+'ipt>'

  // The review text is included by mutation observer in `js/components/list/list.js`
  return html`
    <div class="review">
      <p>
        <b><a href="#${escapeHtml(anchorId)}"><i class="fas fa-link"></i></a> Comments:</b>
          ${cover}
          <div id="review-${escapeHtml(row.dbRef)}">
          </div>
          ${scriptTag(`includeReview(${JSON.stringify(String(type))}, ${JSON.stringify(String(row.dbRef))})`)}
        </p>
    </div>
  `
}

const statuses = ['InProgress', 'Completed', 'Dropped', 'Planned']

const filmStatuses = ['Completed', 'Planned']

/**
 * bootstrap-table 1.12's `customSearch` is the *name of a global function*
 * rather than a function — it calls `window[options.customSearch]` — so this
 * has to be on `window` and its name has to be worth having there.
 *
 * It is called with the table as `this`, once per keystroke and again whenever
 * a column is shown or hidden, and leaves the surviving rows in `this.data`
 * the way the search it replaces does.
 */
const CUSTOM_SEARCH = 'searchListRows'

/**
 * The settings that put `utils/entry_search.js` in charge of a table's search
 * box, for a table that wants one. The placeholder is where the field syntax
 * is advertised: a query language nothing mentions is a query language nobody
 * types.
 */
const searchSettings = () => {
  // The search and the empty-list message happen at different moments, so the
  // one hands the other a box rather than a value. bootstrap-table copies its
  // options shallowly, which is what makes `this.options.searchState` below
  // this same object.
  const searchState = { abandoned: false }
  return {
    search: true,
    customSearch: CUSTOM_SEARCH,
    formatSearch: () => 'Search, e.g. director:nolan',
    searchState,
    formatNoMatches: () =>
      searchState.abandoned
        ? 'That search was too slow to finish, so it was stopped'
        : 'No matching records found',
  }
}

window[CUSTOM_SEARCH] = function (searchText) {
  const rows = EntrySearch.filterEntries(
    this.options.data,
    searchText,
    freeTextFields(this.columns)
  )
  // A pattern that backtracks is abandoned rather than run to the end, and an
  // empty list nobody explains looks exactly like a search that found nothing
  // (#228).
  if (this.options.searchState) {
    this.options.searchState.abandoned = EntrySearch.wasAbandoned(rows)
  }
  this.data = rows
}

/**
 * A bare term is tried against the columns the table is showing. Hidden ones
 * are what made `nolan` return films no Nolan worked on — the cast column is
 * hidden by default — and a row that matches on something the reader cannot
 * see is indistinguishable from a bug. The column dropdown can bring one back,
 * and bootstrap-table re-runs the search when it does.
 */
const freeTextFields = (columns) =>
  columns
    .filter((column) => column.visible && column.searchable !== false)
    .map((column) => EntrySearch.fieldFor(column.field))
    .filter((field) => field !== undefined)

Tables = {
  initTable,
  detailFormatter,
  profileColumns,
  statuses,
  filmStatuses,
  entryTypeToFullColumns,
  searchSettings,
}
