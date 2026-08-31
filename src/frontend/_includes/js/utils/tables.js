const { html, toSafeUrl } = Utils

const profileColumns = (status) => [
  Columns.englishTitleAndLastUpdated(),
  Columns.profileScores(status),
  Columns.year()
]

/**
 * The columns a full list table shows, or undefined for a type there is no
 * such table for — which is what the caller in `components/list/list.js` has
 * always been handed for an unknown type. The lists themselves live in
 * `utils/conversions.js` now, with the rest of what the frontend knows about a
 * work type. See #221.
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
 * `utils/table_view.js` calls this from the handler on the table's container
 * once the panel is in the DOM.
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
  // its scheme is checked before it is allowed near a `src`. The escaping is
  // the tag function's now, here and on every attribute below.
  const coverUrl = toSafeUrl(row.commonMetadata.imageUrl)
  const cover =
    coverUrl
      ? html`<img src="${coverUrl}" class="review-cover" style="float:right;">`
      : ''

  const type = Conversions.apiTypeToType[row.commonMetadata.entryType]

  // The panel names the entry rather than carrying a script that fetches it;
  // `includeReviewIn` above is what reads these back, off the expand.
  //
  // Markup rather than a string: `utils/table_view.js` interpolates this into
  // the detail row's `html` template, which escapes anything that is not
  // already markup.
  return html`
    <div class="review">
      <p>
        <b><a href="#${anchorId}"><i class="fas fa-link"></i></a> Comments:</b>
          ${cover}
          <div id="review-${row.dbRef}" data-review-type="${type}" data-review-ref="${row.dbRef}">
          </div>
        </p>
    </div>
  `
}

const statuses = ['InProgress', 'Completed', 'Dropped', 'Planned']

const filmStatuses = ['Completed', 'Planned']

/**
 * The settings that put `utils/entry_search.js` in charge of a table's search
 * box, for a table that wants one.
 *
 * There is nothing left to wire: `utils/table_model.js` runs the filter itself,
 * over the fields of the columns the table is showing, and tells the renderer
 * whether the pass was abandoned (#228). What is left here is the two lines a
 * caller has to opt into.
 */
const searchSettings = () => ({
  search: true,
  // Every sublist opens on whatever the url asked for, which is what makes a
  // searched list a thing you can link someone.
  searchText: Http.getSearchFromUrl(),
})

Tables = {
  detailFormatter,
  includeReviewIn,
  profileColumns,
  statuses,
  filmStatuses,
  entryTypeToFullColumns,
  searchSettings,
}
