const { html, escapeHtml, toSafeUrl } = Utils

const initTable = (selector, data, settings) =>
  $(selector).bootstrapTable({ ...settings, data })

const profileColumns = (status) => [
  Columns.englishTitleAndLastUpdated(),
  Columns.profileScores(status),
  Columns.date('Year', 'commonMetadata.releaseYear')
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

Tables = {
  initTable,
  detailFormatter,
  profileColumns,
  statuses,
  filmStatuses,
  entryTypeToFullColumns,
}
