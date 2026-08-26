const { html, escapeHtml, toSafeUrl } = Utils

const initTable = (selector, data, settings) =>
  $(selector).bootstrapTable({ ...settings, data })

const profileColumns = (status) => [
  Columns.englishTitleAndLastUpdated(),
  Columns.profileScores(status),
  Columns.year()
]

/**
 * The columns a full list table shows, or undefined for a type there is no
 * such table for — which is what the caller in `components/list/list.js` has
 * always been handed for an unknown type, and bootstrap-table has always
 * thrown on. The lists themselves live in `utils/conversions.js` now, with the
 * rest of what the frontend knows about a work type. See #221.
 */
const entryTypeToFullColumns = (entryType, status) =>
  Conversions.byType(entryType)?.columns(status)

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
const searchSettings = () => ({
  search: true,
  customSearch: CUSTOM_SEARCH,
  formatSearch: () => 'Search, e.g. director:nolan',
})

window[CUSTOM_SEARCH] = function (searchText) {
  this.data = EntrySearch.filterEntries(
    this.options.data,
    searchText,
    freeTextFields(this.columns)
  )
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
