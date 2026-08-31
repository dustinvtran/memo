const { html, css, waitForEl } = Utils
const { detailFormatter, includeReviewIn, statuses, entryTypeToFullColumns, filmStatuses, searchSettings } = Tables
const { initTable } = TableView
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
    // Emptied here, before the tables below fill it, so that what a render
    // leaves behind is its own rows rather than those plus every row of every
    // list drawn before it.
    Rows.byRef = {}

    // And for the same reason: the handles a render registers belong to that
    // render's tables, so a second render would search the first one's.
    searchedTables.length = 0

    // One handler for the page rather than one per sublist: the button hands
    // over a `dbRef` and the registry it is looked up in is shared, so what
    // each table used to install was this same closure, and only the last of
    // them survived.
    const editEntry = (dbRef) => {
      appendContent('body', Modal_({
        title: "Edit an entry",
        content: EntryForm(entryType, Rows.byRef[dbRef]),
        showCloseConfirmationDialog: () => window.hasUnsavedChange === true
      }))
    }

    // This hangs off `document` rather than off the button, which is what lets
    // `script-src` in `_headers` keep refusing `'unsafe-inline'` and
    // `'unsafe-eval'` (#219): the edit icon used to carry an `onclick`.
    // Delegation is also the answer to what the inline handler was for — a
    // row's node is destroyed and rebuilt on every search, sort and column
    // toggle, and a handler on `document` never notices that.
    //
    // The comment panel is the other half of #219 and is no longer bound here.
    // It used to listen for `expand-row.bs.table` rather than for a click on
    // `.detail-icon`, because bootstrap-table's own handler on that icon ended
    // in `return false` — `stopPropagation` too, in jQuery — so the click never
    // reached `document`. `utils/table_view.js` owns the caret now and calls
    // `includeReviewIn` itself once the panel is in the DOM, which also covers
    // a row opened by the url anchor in `list/index.js` rather than by hand.
    //
    // `off` first because this initializer runs per render, and a second copy
    // of the edit handler would open two modals on one click.
    $(document)
      .off('click.entryRows')
      .on('click.entryRows', '.edit-button', (e) => editEntry(e.currentTarget.dataset.ref))

    // Show helpful image next to the first open-review-icon in the DOM. A
    // list with no rows in it never grows one, which is what the wait gives
    // up on: a hint nobody can be shown is not worth watching the document
    // for as long as the page is open.
    if (Netlify.isLoggedIn()) {
      return
    }

    waitForEl('a.detail-icon').then((el) => {
      if (!el || document.querySelector('#click-to-see-comments')) return

      setTimeout(() => {
        // The table's own container, rather than the seven `.parent()` hops it
        // took to climb out of bootstrap-table's wrappers. It sits directly
        // under the sublist's heading, which is where the hint goes and what
        // the collapse handler below expects to find there.
        el.closest('.entry-table')?.insertAdjacentHTML('beforebegin', String(html`
          <div id="click-to-see-comments">Click here to<br>read comments! <i class="fas fa-location-arrow" style="opacity:.7;"></i></div>
        `))
      }, 200)
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
      <h1><a href="/profile/${encodeURIComponent(username)}"><i class="fa fa-home"></i></a> ${title}</h1>
    </div>
    <hr>
  `
})

const SubLists = (entryType, isOwner, data) => initComponent({
  content: ({ include }) => html`
    ${include(
      (entryType === 'films' ? filmStatuses : statuses)
        .map((status) => SubList(status, entryType, isOwner, data))
    )}
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
        <div id="${id}-list"></div>
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

    /* A full list is wider than a phone, so it scrolls sideways inside the
       sublist rather than stretching the page. The generic half of that —
       the scrolling container itself — is in main.css; the width below is what
       makes a narrow screen scroll at all, and it belongs to a list table
       rather than to the profile's three-column summaries. */
    .sublist-wrapper .entry-table table {
      min-width: 550px;
    }

    @media (min-width: 615px) {
      .sublist-wrapper .entry-table-scroll:hover {
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
  // one registry serves every table on it, and `List` empties it per render.
  data.forEach((row) => { Rows.byRef[row.dbRef] = row })

  const table = initTable(selector, data, {
    detailView: true,
    detailFormatter,
    onExpandRow: includeReviewIn,
    ...searchSettings(),
    onSearch: (text) => onSearched(table, text),
    showColumns: true,
    sortName: 'score',
    sortOrder: 'desc',
    columns: [
      ...entryTypeToFullColumns(entryType, status),
      ...(isOwner ? [Columns.edit()] : []),
    ]
  })

  searchedTables.push(table)
}

/** Every table on the page, in the order they were built. */
const searchedTables = []

/**
 * The sublists are one list cut up by status, and each of them draws a search
 * box of its own. Searching one and not the others leaves the page in a state
 * no single url can describe — and the url is where the query now lives — so
 * a search in any box is a search in all of them.
 *
 * `setSearch` deliberately does not report the search back out, which is what
 * stops four tables telling each other about the same keystroke for ever.
 * @type {(table: object, text: string) => void}
 */
const onSearched = (table, text) => {
  Http.setSearchInUrl(text)
  searchedTables
    .filter((other) => other !== table)
    .forEach((other) => other.setSearch(text))
}

const toStats = (entries, entryType) => {
  // Markup, so it is written as an `html` literal rather than a string: the
  // two templates below interpolate it, and an interpolated string is text.
  const icon = html` <i class="fas fa-wave-square"></i> `
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

  return html`Total entries: ${entries.length}${entryType === 'tv' ? html` ${icon} Episodes seen: ${totalEpsSeen}` : ''} ${icon} Days spent: ${days.toFixed(2)} ${icon} Mean score: ${meanScore.toFixed(2)}`
}

/**
 * Alphabetical by title, matching `byStatusThenScoreThenTitle` in
 * `api/utils/export_view.js`. Each sublist is re-sorted on score and that sort
 * is stable, so this decides the order within a score — which in the Planned
 * sublist is the whole of it, since the score column there is a preference
 * almost nothing carries. It runs after the overrides are merged so that it
 * sorts on the title the Title column actually shows.
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
