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

/**
 * Fills in the comment panel of a row that has just been expanded, from the
 * ids the panel itself carries.
 *
 * This used to be an inline `<script>` that `detailFormatter` returned inside
 * the row's markup: jQuery sees `<script` on the way in and runs the text
 * through `eval` rather than parsing it as markup, so what the policy in
 * `_headers` refuses it for is `'unsafe-eval'`, which it grants no more than
 * `'unsafe-inline'`. Enforced, that is an `EvalError` and an empty panel on
 * every row of every list, for every visitor (#219).
 * `components/list/list.js` calls this from one handler bound to `document`
 * instead.
 *
 * The element rather than a `#review-${dbRef}` selector: the handler has it in
 * hand, and an id built out of stored data is a thing that would have to be
 * escaped again on its way into a selector.
 */
const includeReviewIn = (detail) => {
  const panel = $(detail).find('[data-review-ref]')[0]
  if (!panel) return

  // `dataset` rather than jQuery's `.data()`, which is not a plain attribute
  // read: it converts anything shaped like a number, `true`, `null` or JSON
  // into that value, and these two are ids to be handed back verbatim.
  const { reviewType, reviewRef } = panel.dataset

  Components.setContent(panel, Components.WithRemoteData({
    remoteData: Netlify.getReview(reviewType, reviewRef),
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

  // The panel names the entry rather than carrying a script that fetches it;
  // `includeReviewIn` above is what reads these back, off the expand event.
  return html`
    <div class="review">
      <p>
        <b><a href="#${escapeHtml(anchorId)}"><i class="fas fa-link"></i></a> Comments:</b>
          ${cover}
          <div id="review-${escapeHtml(row.dbRef)}" data-review-type="${escapeHtml(type)}" data-review-ref="${escapeHtml(row.dbRef)}">
          </div>
        </p>
    </div>
  `
}

const statuses = ['InProgress', 'Completed', 'Dropped', 'Planned']

const filmStatuses = ['Completed', 'Planned']

/**
 * The search itself, called once per keystroke and again whenever a column is
 * shown or hidden.
 *
 * bootstrap-table 1.12 took `customSearch` as the *name of a global function*
 * and called `window[options.customSearch]` with the table as `this` and the
 * search text as its one argument, expecting the surviving rows to be left in
 * `this.data`. 1.21 takes the function itself, calls it with
 * `(data, searchText, filterColumns)` and `this` set to the *options* object,
 * and assigns `this.data` from the return value. All three moved at once, so
 * the old shape does not degrade into a worse search — it hands `searchText`
 * an array of rows and then blanks the table by returning `undefined`.
 *
 * `this.columns` on the options is the nested `[[column, ...]]` that
 * `initColumns` rewrites it into, one inner array per header row, rather than
 * the flat list of the same objects the table itself keeps. The objects are
 * shared, so `visible` is still live as the column dropdown toggles it; only
 * the shape needs flattening.
 */
const searchListRows = function (data, searchText) {
  const rows = EntrySearch.filterEntries(
    data,
    searchText,
    freeTextFields(this.columns.flat())
  )
  // A pattern that backtracks is abandoned rather than run to the end, and an
  // empty list nobody explains looks exactly like a search that found nothing
  // (#228).
  if (this.searchState) {
    this.searchState.abandoned = EntrySearch.wasAbandoned(rows)
  }
  return rows
}

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
    customSearch: searchListRows,
    formatSearch: () => 'Search, e.g. director:nolan',
    searchState,
    formatNoMatches: () =>
      searchState.abandoned
        ? 'That search was too slow to finish, so it was stopped'
        : 'No matching records found',
  }
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
  includeReviewIn,
  profileColumns,
  statuses,
  filmStatuses,
  entryTypeToFullColumns,
  searchSettings,
}
