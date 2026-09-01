/**
 * @file The only part of a list table that touches an element: it draws what
 * `utils/table_model.js` decides, and hands the reader's clicks back to it.
 *
 * There is deliberately no state here. Every event does the same three things —
 * ask the model for the next state, redraw from it, and tell the caller — so
 * that the interesting half stays testable without a DOM and would survive a
 * framework being adopted. See the file comment in `table_model.js`.
 *
 * `Utils.html` escapes every interpolated value and passes markup through
 * untouched (#272), which is what lets a cell formatter's output be
 * interpolated straight into a row: the ones that build markup return an `html`
 * template and are trusted, and the ones that hand back a stored number or a
 * user's override return the value itself and are escaped. Nothing here needs
 * `escapeHtml`, and nothing here may `.join('')` an array of templates.
 */

const { html } = Utils
const { icon } = Icons

/**
 * Draws a table into the element `selector` names, and answers with the handle
 * `components/list/list.js` uses to keep the sublists' search boxes in step.
 *
 * The settings are the ones the two callers pass, and they are a small subset
 * of what bootstrap-table took: `columns`, `sortName` / `sortOrder`,
 * `showHeader`, `showColumns`, `search` / `searchText` / `onSearch`, and
 * `detailView` / `detailFormatter` / `onExpandRow`.
 * @type {(selector: string, rows: object[], settings: object) => object}
 */
const initTable = (selector, rows, settings) => {
  const root = document.querySelector(selector)
  if (!root) return NO_TABLE

  const options = { showHeader: true, ...settings }
  let state = TableModel.table({
    columns: options.columns,
    rows,
    searchText: options.searchText ?? '',
    sortField: options.sortName,
    sortOrder: options.sortOrder ?? 'asc',
  })

  root.classList.add('entry-table')
  root.innerHTML = String(chrome(state, options))

  const grid = root.querySelector('table')
  const searchBox = root.querySelector('.entry-table-search')

  // The checkboxes are drawn once and then left to the browser, so `checked` is
  // set here rather than written into the markup — an attribute is checked by
  // being present at all, and `checked="${false}"` is still checked.
  root.querySelectorAll('.entry-table-columns input').forEach((box) => {
    box.checked = fieldIsVisible(state, box.dataset.field)
  })

  const draw = () => {
    const { rows: visible, abandoned } = TableModel.visibleRows(state)
    grid.innerHTML = String(html`
      ${header(state, options)}${body(state, options, visible, abandoned)}
    `)
  }

  /**
   * Opens or closes one row's comment panel.
   *
   * The panel is filled after the redraw rather than by the formatter, because
   * what goes in it comes from the network: `detailFormatter` writes a panel
   * naming its entry in `data-` attributes and `onExpandRow` — `includeReviewIn`
   * in `utils/tables.js` — reads them back and fetches the note. That split is
   * #219: the panel used to carry an inline `<script>` that jQuery ran through
   * `eval`, which `script-src` in `_headers` refuses as surely as it refuses
   * `'unsafe-inline'`.
   */
  const toggleDetail = (dbRef) => {
    const opening = !TableModel.isExpanded(state, dbRef)
    state = TableModel.withExpanded(state, dbRef, opening)
    draw()
    if (!opening) return
    const panel = grid.querySelector(
      `tr.detail-view[data-ref="${CSS.escape(dbRef)}"] > td`
    )
    if (panel) options.onExpandRow?.(panel)
  }

  const applySearch = (text) => {
    if (text === state.searchText) return
    state = TableModel.withSearch(state, text)
    draw()
  }

  // One listener on the table's own container, rather than one per row: the
  // rows are rebuilt on every search, sort and column toggle, and a handler
  // bound to a row would go with them. It is `addEventListener` on an element
  // this file created rather than an `onclick` in the markup for the same
  // reason as the panel above — see #219 — and it is scoped to this table so
  // that a page of four sublists ends up with four listeners rather than four
  // copies of one on `document`.
  root.addEventListener('click', (event) => {
    const caret = event.target.closest?.('a.detail-icon')
    if (caret) {
      event.preventDefault()
      toggleDetail(caret.dataset.ref)
      return
    }

    const heading = event.target.closest?.('th.sortable')
    if (heading) {
      state = TableModel.withSortOn(state, heading.dataset.field)
      draw()
    }
  })

  root.addEventListener('change', (event) => {
    const box = event.target.closest?.('.entry-table-columns input')
    if (!box) return
    // The search runs against the columns the reader can see, so unhiding
    // Actors has to make `pacino` match — which it does, because the redraw
    // below asks the model for the rows again rather than reusing them.
    state = TableModel.withColumn(state, box.dataset.field, box.checked)
    draw()
  })

  let searchTimer
  searchBox?.addEventListener('input', () => {
    clearTimeout(searchTimer)
    searchTimer = setTimeout(() => {
      applySearch(searchBox.value)
      options.onSearch?.(searchBox.value)
    }, SEARCH_DEBOUNCE_MS)
  })

  closeMenusOnOutsideClick()
  draw()

  return {
    /**
     * The same search, arrived at from somewhere else — the sibling sublists,
     * which are one list cut up by status and have to agree. It deliberately
     * does not call `onSearch` back, which is what stops four tables telling
     * each other about the same keystroke for ever.
     */
    setSearch: (text) => {
      if (searchBox) searchBox.value = text
      applySearch(text)
    },
  }
}

TableView = {
  initTable,
}

///////////////////////////////////////////////////////////////////////////////

/**
 * How long after the last keystroke the search runs. bootstrap-table waited
 * half a second, which on a list of a few hundred rows is a pause you can feel;
 * the filter itself is budgeted at 250ms in `utils/entry_search.js`, so this
 * only has to be long enough that a word is not searched for letter by letter.
 */
const SEARCH_DEBOUNCE_MS = 200

/** The carets the caret column draws, which is what it used to reach for
 *  through `window.icons` and bootstrap-table's `icons` option. */
const CARET_CLOSED = 'caret-down'
const CARET_OPEN = 'caret-up'

/** What `initTable` answers when the element it was pointed at is not there. */
const NO_TABLE = { setSearch: () => undefined }

/** The parts that are drawn once: the toolbar, and the table to redraw into. */
const chrome = (state, options) => html`
  ${options.search || options.showColumns ? toolbar(state, options) : ''}
  <div class="entry-table-scroll">
    <table></table>
  </div>
`

const toolbar = (state, options) => html`
  <div class="entry-table-toolbar">
    ${options.showColumns ? columnsMenu(state) : ''}
    ${options.search ? searchInput(state) : ''}
  </div>
`

/**
 * A `<details>`, so the menu opens and closes with no script at all.
 *
 * This was the last consumer of Bootstrap's dropdown JS — the only thing on the
 * site that ever called into `bootstrap.min.js`, and only because
 * bootstrap-table built its Columns button out of it.
 */
const columnsMenu = (state) => html`
  <details class="entry-table-columns">
    <summary>Columns ${icon('caret-down')}</summary>
    <div class="entry-table-columns-menu">
      ${TableModel.switchableColumns(state).map((column) => html`
        <label>
          <input type="checkbox" data-field="${column.field}"> <span>${column.title}</span>
        </label>
      `)}
    </div>
  </details>
`

const searchInput = (state) => html`
  <input
    class="entry-table-search"
    type="search"
    value="${state.searchText}"
    placeholder="${TableModel.SEARCH_PLACEHOLDER}"
    aria-label="${TableModel.SEARCH_PLACEHOLDER}"
    autocomplete="off">
`

const header = (state, options) =>
  options.showHeader
    ? html`
      <thead>
        <tr>
          ${options.detailView ? html`<th class="entry-table-caret"></th>` : ''}
          ${TableModel.visibleColumns(state).map((column) => headerCell(column, state))}
        </tr>
      </thead>
    `
    : ''

const headerCell = (column, state) => html`
  <th
    class="${headerClasses(column, state)}"
    style="${alignStyle(column)}"
    data-field="${column.field}">${column.title}</th>
`

const headerClasses = (column, state) =>
  [
    column.sortable ? 'sortable' : '',
    column.sortable && state.sortField === column.field ? state.sortOrder : '',
  ]
    .filter(Boolean)
    .join(' ')

const body = (state, options, rows, abandoned) => html`
  <tbody>
    ${rows.length === 0
      ? emptyRow(state, options, abandoned)
      : rows.map((row, index) => rowPair(row, index, state, options))}
  </tbody>
`

const emptyRow = (state, options, abandoned) => html`
  <tr class="no-records-found">
    <td colspan="${columnCount(state, options)}">${TableModel.noMatchesText(abandoned)}</td>
  </tr>
`

/** A row, and the comment panel under it when it is open. */
const rowPair = (row, index, state, options) => html`
  ${dataRow(row, index, state, options)}
  ${TableModel.isExpanded(state, row.dbRef) ? detailRow(row, index, state, options) : ''}
`

const dataRow = (row, index, state, options) => html`
  <tr data-index="${index}">
    ${options.detailView ? caretCell(row, state) : ''}
    ${TableModel.visibleColumns(state).map((column) => cell(column, row, index))}
  </tr>
`

/**
 * The caret names its row in a `data-` attribute, the way the edit button in
 * `utils/columns.js` does, so that the handler above has an id rather than a
 * position — a sort moves the rows and does not move the ids.
 */
const caretCell = (row, state) => html`
  <td class="entry-table-caret">
    <a class="detail-icon" href="#" aria-label="Comments" data-ref="${row.dbRef}">
      ${icon(TableModel.isExpanded(state, row.dbRef) ? CARET_OPEN : CARET_CLOSED)}
    </a>
  </td>
`

const detailRow = (row, index, state, options) => html`
  <tr class="detail-view" data-ref="${row.dbRef}">
    <td colspan="${columnCount(state, options)}">${options.detailFormatter?.(index, row)}</td>
  </tr>
`

const cell = (column, row, index) => html`
  <td style="${cellStyle(column, row, index)}">${cellContent(column, row, index)}</td>
`

/**
 * A column with no formatter draws the value it names, and a formatter that
 * answers with nothing draws a dash — which is bootstrap-table's `undefinedText`
 * and what a book with no page count has always shown.
 */
const cellContent = (column, row, index) => {
  const value = TableModel.valueAt(row, column.field)
  const content = column.formatter
    ? column.formatter(value, row, index, column.field)
    : value
  return content === null || content === undefined ? TableModel.EMPTY_CELL : content
}

const cellStyle = (column, row, index) =>
  [
    alignStyle(column),
    ...Object.entries(column.cellStyle?.(
      TableModel.valueAt(row, column.field), row, index, column.field
    )?.css ?? {}).map(([property, value]) => `${property}: ${value}`),
  ]
    .filter(Boolean)
    .join('; ')

const alignStyle = (column) => (column.align ? `text-align: ${column.align}` : '')

const columnCount = (state, options) =>
  TableModel.visibleColumns(state).length + (options.detailView ? 1 : 0)

const fieldIsVisible = (state, field) =>
  state.columns.some((column) => column.field === field && column.visible)

/**
 * A `<details>` stays open until it is clicked again, where Bootstrap's
 * dropdown closed on a click anywhere else. One handler for the page restores
 * that; installed on first use rather than at load, so a page with no table on
 * it never adds it.
 */
let menuCloserInstalled = false

const closeMenusOnOutsideClick = () => {
  if (menuCloserInstalled) return
  menuCloserInstalled = true

  document.addEventListener('click', (event) => {
    document.querySelectorAll('details.entry-table-columns[open]').forEach((menu) => {
      if (!menu.contains(event.target)) menu.open = false
    })
  })
}
