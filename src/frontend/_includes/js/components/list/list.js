const { html, css, escapeHtml } = Utils
const { col, initTable, detailFormatter, allColumns, statuses, entryTypeToFullColumns, editColumn, filmStatuses } = Tables
const { typeToTitle, statusToTitle } = Conversions
const { initComponent, WithRemoteData, appendContent, Nothing } = Components
const { Modal_ } = Components.UI
const { AddEntryButton } = Components.List
const { EntryForm } = Components.List

/** `entries` and `isOwner` are already in flight; see `list/index.js`. */
const List = ({ username, entryType, entries, isOwner }) => initComponent({
  content: ({ include }) => html`
    <div class="container">
      <div class="row" style="padding:20px">
        <div id="list-header">
          ${include(
            ListPageHeader(typeToTitle[entryType], username)
          )}
        </div>
          ${include(WithRemoteData({
            remoteData: isOwner,
            component: (isOwner) =>
              isOwner ? AddEntryButton(entryType) : Nothing()
          }))}
          ${include(WithRemoteData({
            remoteData: entries,
            component: (entries) => SubLists(
              entryType,
              isOwner,
              entries
                .map((entry) => ({
                  ...entry,
                  originalData: entry.commonMetadata,
                  commonMetadata: {
                    ...entry.commonMetadata,
                    ...Object.fromEntries(
                      Object.entries(entry.overrides ?? {})
                        .filter(([_k, v]) => v !== null)
                    ),
                  },
                }))
                .sort(byEnglishTitle)
            )}))}
      </div>
    </div>
  `,
  initializer: () => {
    // Show helpful image next to the first open-review-icon
    // in the DOM
    
    if (Netlify.isLoggedIn()) {
      return
    }

    const observer = new MutationObserver((mutations, obs) => {
      const el = document.querySelector('a.detail-icon')
      const helperImg = document.querySelector('#click-to-see-comments')
      if (el && !helperImg) {
        obs.disconnect()
        setTimeout(() => {
          $(el)
            .parent()
            .parent()
            .parent()
            .parent()
            .parent()
            .parent()
            .parent()
            .before(html`
              <div id="click-to-see-comments">Click here to<br>read comments! <i class="fas fa-location-arrow" style="opacity:.7;"></i></div>
            `)
        }, 200)
        return
      }
    })

    observer.observe(document, {
      childList: true,
      subtree: true
    })
  },
  style: () => css`
    #sublist-wrapper {
      position: relative;
    }
    #click-to-see-comments {
      font-size: 10px;
      opacity: .7;
      position: absolute;
      top: 126px;
      left: -62px;
      z-index: 2;
      pointer-events: none;
    }
    #click-to-see-comments img {
      height: 80px;
    }
    @media (max-width: 992px) {
      #click-to-see-comments {
        top: 110px;
      }
    }
    @media (max-width: 860px) {
      #click-to-see-comments {
        display: none;
      }
    }
  `
})

Components.List.List = List

///////////////////////////////////////////////////////////////////////////////

const ListPageHeader = (title, username) => initComponent({
  content: () => html`
    <div class="row">
      <h1><a href="/profile/${escapeHtml(encodeURIComponent(username))}"><i class="fa fa-home"></i></a> ${escapeHtml(title)}</h1>
    </div>
    <hr>
  `
})

const SubLists = (entryType, isOwner, data) => initComponent({
  content: ({ include }) => html`
    ${(entryType === 'films' ? filmStatuses : statuses)
      .map((status) => include(SubList(status, entryType, isOwner, data)))
      .join('')
    }
    <div id="global-stats">
      <hr>
      ${toStats(data.filter((e) => e.status !== 'Planned'), entryType)}
    </div>
  `,
  style: () => `
    #global-stats {
      text-align: center;
      margin-top: 60px;
    }
    #global-stats i {
      margin: 0 10px;
      opacity: 0.7;
    }
  `
})

const SubList = (status, entryType, isOwner, data) => initComponent({
  content: ({ id }) => html`
    <div class="row">
      <div class="col-md-10 col-md-offset-1 sublist-wrapper">
        <h2 id="${id}-title" class="collapsible sublist-title">${statusToTitle(entryType, status)}</h2>
        <table id="${id}-list"></table>
      </div>
    </div>
    <div class="summary-stats">
      ${toStats(data.filter((e) => e.status === status), entryType)}
    </div>
  `,
  initializer: ({ id }) => {
    $(`#${id}-title`).click(() => {
      const nextEl = $(`#${id}-title`).next()
      const elsToHide =
        nextEl.attr('id') === 'click-to-see-comments'
          ? [nextEl, nextEl.next(), nextEl.parent().parent().next()]
          : [nextEl, nextEl.parent().parent().next()]

      elsToHide.forEach(el => {
        el.toggle(200)
        el.toggleClass('is-collapsed')
      })
    })

    // Settled long before the entries arrive, so this is a microtask rather
    // than the round trip per table it used to be.
    isOwner.then((isOwner) => {
      initFullTable(`#${id}-list`, data.filter((e) => e.status === status), entryType, isOwner, status)
    })
  },
  style: () => css`
    .sublist-wrapper {
      margin-top: 50px
    }

    .sublist-title {
      margin-bottom: -30px
    }
    @media (max-width: 475px) {
      .sublist-wrapper {
        margin-top: 0
      }

      .sublist-title {
        margin-bottom: 0
      }
    }

    .fixed-table-container {
      overflow-x: auto;
    }

    .fixed-table-header, .fixed-table-body {
      min-width: 550px;
    }

    @media (min-width: 615px) {
      div.fixed-table-body:hover {
        overflow-y: visible;
        overflow-x: visible;
      }

      div.fixed-table-container:hover {
        overflow-x: visible;
        overflow-y: visible;
      }
    }

    .summary-stats {
      text-align: center;
      font-size: 11px;
      margin-top: 11px;
    }

    .summary-stats i {
      margin: 0 10px;
      opacity: 0.7;
    }
  `
})

const initFullTable = (selector, data, entryType, isOwner, status) => {
  // The edit button names its row rather than carrying a copy of it, so
  // rows are kept here for it to name. `dbRef` is unique across the page, so
  // one registry serves every table on it.
  data.forEach((row) => { Rows.byRef[row.dbRef] = row })

  initTable(selector, data, {
    detailView: true,
    detailFormatter,
    icons: 'icons',
    iconsPrefix: 'fa',
    search: true,
    showColumns: true,
    sortName: 'score',
    sortOrder: 'desc',
    columns: [
      ...entryTypeToFullColumns(entryType, status),
      ...(isOwner ? [Columns.edit()] : []),
    ]
  })
  window.editEntry = (dbRef) => {
    appendContent('body', Modal_({
      title: "Edit an entry",
      content: EntryForm(entryType, Rows.byRef[dbRef]),
      showCloseConfirmationDialog: () => window.hasUnsavedChange === true
    }))
  }
}

const toStats = (entries, entryType) => {
  const icon = ' <i class="fas fa-wave-square"></i> '
  const totalEpsSeen = entries
    .map(e => e.progress ?? 0)
    .reduce((a,b) => a + b, 0)
  const scores = entries.filter(e => e.score).map(e => e.score)
  const meanScore = scores.reduce((a,b) => a+b, 0) / (scores.length || 1)
  const entriesNoDropped = entries.filter((e) => e.status !== 'Dropped')
  const days =
    entryType === 'tv'
      ? (entriesNoDropped
        .reduce((mins, e) => mins + ((get(e, 'duration') ?? 0) * (get(e, 'episodes') ?? 0)), 0)
      ) / 60 / 24
      : entryType === 'films'
      ? (entriesNoDropped
        .reduce((mins, e) => mins + (get(e, 'duration') ?? 0), 0)
      ) / 60 / 24
      : entryType === 'books'
      ? (entriesNoDropped
        .reduce((hours, e) => hours + ((get(e, 'duration') ?? 0) / 50), 0)
      ) / 24
      : /* games */ (entriesNoDropped
        .reduce((mins, e) => mins + (get(e, 'duration') ?? 0), 0)
      ) / 60 / 24

  return `Total entries: ${entries.length}${entryType === 'tv' ? ` ${icon} Episodes seen: ${totalEpsSeen}` : ''} ${icon} Days spent: ${days.toFixed(2)} ${icon} Mean score: ${meanScore.toFixed(2)}`
}

/**
 * Alphabetical by title, matching `byStatusThenScoreThenTitle` in
 * `api/utils/export_view.js`. bootstrap-table re-sorts each sublist on score
 * and its sort is stable, so this decides the order within a score — which in
 * the Planned sublist is the whole of it, since the score column there is a
 * preference almost nothing carries. It runs after the overrides are merged so
 * that it sorts on the title the Title column actually shows.
 *
 * Subtracting one title from another, as this used to, is `NaN` for every
 * pair; `sort` reads that as "these two are fine as they are" and leaves the
 * array in the order the API returned it, i.e. most recently edited first.
 * @type {(a: object, b: object) => number}
 */
const byEnglishTitle = (a, b) =>
  // An entry can have no work, and a work can have no title.
  String(get(a, 'englishTranslatedTitle') ?? '')
    .localeCompare(String(get(b, 'englishTranslatedTitle') ?? ''))

const get = (entry, prop) =>
  entry.commonMetadata?.[prop]
